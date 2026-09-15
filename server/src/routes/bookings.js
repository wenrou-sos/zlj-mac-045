import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { refreshCardStatuses } from '../reminderLogic.js';
import { requirePerm, writeAudit } from '../auth.js';

const router = Router();
const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

// 预约列表（支持课程 / 会员 / 状态过滤）
// 教练角色只能看到自己所带课程的预约名单
router.get('/', requirePerm('bookings_view'), async (req, res, next) => {
  try {
    const { status, class_id, member_id } = req.query;
    const conds = [];
    const params = [];
    if (status) { params.push(status); conds.push(`b.status=$${params.length}`); }
    if (class_id) { params.push(class_id); conds.push(`b.class_id=$${params.length}`); }
    if (member_id) { params.push(member_id); conds.push(`b.member_id=$${params.length}`); }
    if (req.user.role === 'coach') {
      if (!req.user.coach_id) return res.json([]);
      params.push(req.user.coach_id);
      conds.push(`cl.coach_id=$${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await query(`
      SELECT b.*, m.name AS member_name, m.phone,
        cl.title, cl.start_at, cl.end_at, cl.cost_sessions, v.name AS venue_name,
        co.name AS coach_name, cc.card_no
      FROM bookings b
      JOIN members m ON m.id=b.member_id
      JOIN classes cl ON cl.id=b.class_id
      LEFT JOIN venues v ON v.id=cl.venue_id
      LEFT JOIN coaches co ON co.id=cl.coach_id
      LEFT JOIN membership_cards cc ON cc.id=b.card_id
      ${where}
      ORDER BY cl.start_at DESC, b.id DESC
      LIMIT 300`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 代客约课（前台/店长）
router.post('/', requirePerm('booking_create'), async (req, res, next) => {
  try {
    const { class_id, member_id } = req.body;
    if (!class_id || !member_id) return res.status(400).json({ error: '课程和会员必填' });

    // 事务外先刷新卡状态（PGlite 事务期间不允许并发查询）
    await refreshCardStatuses();

    const result = await withTransaction(async (tx) => {
      const cls = (await tx.query(`SELECT * FROM classes WHERE id=$1 FOR UPDATE`, [class_id])).rows[0];
      if (!cls) throw Object.assign(new Error('课程不存在'), { status: 404 });
      if (cls.status !== 'open') throw Object.assign(new Error('该课程未开放预约'), { status: 409 });
      if (new Date(cls.start_at) < new Date()) throw Object.assign(new Error('课程已开始，无法预约'), { status: 409 });

      const dup = await tx.query(
        `SELECT 1 FROM bookings WHERE class_id=$1 AND member_id=$2 AND status IN ('booked','checked')`,
        [class_id, member_id]
      );
      if (dup.rows.length > 0) throw Object.assign(new Error('您已预约该课程'), { status: 409 });

      const booked = (await tx.query(
        `SELECT count(*)::int n FROM bookings WHERE class_id=$1 AND status IN ('booked','checked')`,
        [class_id]
      )).rows[0].n;
      if (booked >= cls.capacity) throw Object.assign(new Error('该课程已满员'), { status: 409 });

      // 选一张可用卡（优先到期早的期限卡，其次次数最多的次卡）
      const card = (await tx.query(`
        SELECT * FROM membership_cards
        WHERE member_id=$1 AND status='active'
          AND (end_date IS NULL OR end_date >= CURRENT_DATE)
          AND (remaining IS NULL OR remaining >= $2)
        ORDER BY
          CASE WHEN card_type='period' THEN 0 ELSE 1 END,
          end_date ASC NULLS LAST
        LIMIT 1`, [member_id, cls.cost_sessions])).rows[0];
      if (!card) throw Object.assign(new Error('没有可用的会员卡（已过期或次数不足）'), { status: 409 });

      // 次卡预扣次数
      if (card.card_type === 'count') {
        await tx.query(`UPDATE membership_cards SET remaining = remaining - $2 WHERE id=$1`,
          [card.id, cls.cost_sessions]);
      }

      let code;
      for (let i = 0; i < 10; i++) {
        code = genCode();
        const exists = await tx.query(`SELECT 1 FROM bookings WHERE verify_code=$1`, [code]);
        if (exists.rows.length === 0) break;
      }
      const ins = await tx.query(
        `INSERT INTO bookings(class_id, member_id, card_id, verify_code)
         VALUES($1,$2,$3,$4) RETURNING *`,
        [class_id, member_id, card.id, code]
      );
      const member = (await tx.query(`SELECT name FROM members WHERE id=$1`, [member_id])).rows[0];
      await writeAudit(tx, {
        user: req.user, action: 'booking_create', targetType: 'booking', targetId: ins.rows[0].id,
        cardNo: card.card_no, memberId: member_id,
        detail: {
          class_id, title: cls.title, start_at: cls.start_at,
          verify_code: code, cost_sessions: cls.cost_sessions,
          member_name: member?.name,
          card_remaining: card.card_type === 'count'
            ? { before: card.remaining, after: card.remaining - cls.cost_sessions }
            : null,
        },
        req,
      });
      return ins.rows[0];
    });
    res.status(201).json(result);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// 取消预约（前台/店长）：开课前 2 小时外免费取消并退次；不足 2 小时不退次
router.post('/:id/cancel', requirePerm('booking_cancel'), async (req, res, next) => {
  try {
    const result = await withTransaction(async (tx) => {
      const b = (await tx.query(`
        SELECT b.*, cl.title, cl.start_at, cl.cost_sessions,
               cc.card_no, m.name AS member_name
        FROM bookings b
        JOIN classes cl ON cl.id=b.class_id
        JOIN members m ON m.id=b.member_id
        LEFT JOIN membership_cards cc ON cc.id=b.card_id
        WHERE b.id=$1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!b) throw Object.assign(new Error('预约不存在'), { status: 404 });
      if (b.status !== 'booked') throw Object.assign(new Error('当前状态不可取消'), { status: 409 });

      const hours = (new Date(b.start_at) - Date.now()) / 3600e3;
      if (hours < 0) throw Object.assign(new Error('课程已开始'), { status: 409 });

      const reason = req.body.reason || null;
      const refund = hours >= 2;
      let afterRemaining = null;
      if (refund && b.card_id) {
        const u = await tx.query(
          `UPDATE membership_cards SET remaining = LEAST(COALESCE(remaining,0) + $2, total_sessions)
           WHERE id=$1 AND remaining IS NOT NULL RETURNING remaining`, [b.card_id, b.cost_sessions]
        );
        afterRemaining = u.rows[0]?.remaining ?? null;
      }
      const cancelReason = reason || (refund
        ? `会员取消（退还 ${b.cost_sessions} 次）`
        : `临期取消（不足2小时，不退 ${b.cost_sessions} 次）`);
      await tx.query(
        `UPDATE bookings SET status='canceled', canceled_at=now(), cancel_reason=$2 WHERE id=$1`,
        [b.id, cancelReason]
      );
      await writeAudit(tx, {
        user: req.user, action: 'booking_cancel', targetType: 'booking', targetId: b.id,
        cardNo: b.card_no, memberId: b.member_id,
        detail: {
          title: b.title, start_at: b.start_at, member_name: b.member_name,
          reason: cancelReason, refund_sessions: refund ? b.cost_sessions : 0,
        },
        req,
      });
      // 实际退还课次（退次）单独留一条审计，方便按动作类型直接筛出所有退次
      if (refund && b.card_id) {
        await writeAudit(tx, {
          user: req.user, action: 'session_refund', targetType: 'booking', targetId: b.id,
          cardNo: b.card_no, memberId: b.member_id,
          detail: {
            source: 'booking_cancel', title: b.title,
            sessions: b.cost_sessions, reason: cancelReason,
            after_remaining: afterRemaining,
          },
          req,
        });
      }
      return { refund, refund_sessions: refund ? b.cost_sessions : 0 };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

export default router;
