import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { refreshCardStatuses } from '../reminderLogic.js';
import { venueAvailabilityBlock } from '../venueAvailability.js';
import { pickUsableCard, genUniqueVerifyCode, promoteWaitlist } from '../waitlistLogic.js';

const router = Router();

// 预约列表（支持课程 / 会员 / 状态过滤）
router.get('/', async (req, res, next) => {
  try {
    const { status, class_id, member_id } = req.query;
    const conds = [];
    const params = [];
    if (status) { params.push(status); conds.push(`b.status=$${params.length}`); }
    if (class_id) { params.push(class_id); conds.push(`b.class_id=$${params.length}`); }
    if (member_id) { params.push(member_id); conds.push(`b.member_id=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await query(`
      SELECT b.*, m.name AS member_name, m.phone,
        cl.title, cl.start_at, cl.end_at, v.name AS venue_name,
        co.name AS coach_name
      FROM bookings b
      JOIN members m ON m.id=b.member_id
      JOIN classes cl ON cl.id=b.class_id
      LEFT JOIN venues v ON v.id=cl.venue_id
      LEFT JOIN coaches co ON co.id=cl.coach_id
      ${where}
      ORDER BY cl.start_at DESC, b.id DESC
      LIMIT 300`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 会员约课
router.post('/', async (req, res, next) => {
  try {
    const { class_id, member_id } = req.body;
    if (!class_id || !member_id) return res.status(400).json({ error: '课程和会员必填' });

    // 事务外先刷新卡状态（PGlite 事务期间不允许并发查询）
    await refreshCardStatuses();

    const result = await withTransaction(async (tx) => {
      const tq = (text, params) => tx.query(text, params);
      const cls = (await tx.query(`SELECT * FROM classes WHERE id=$1 FOR UPDATE`, [class_id])).rows[0];
      if (!cls) throw Object.assign(new Error('课程不存在'), { status: 404 });
      if (cls.status !== 'open') throw Object.assign(new Error('该课程未开放预约'), { status: 409 });
      if (new Date(cls.start_at) < new Date()) throw Object.assign(new Error('课程已开始，无法预约'), { status: 409 });

      // 按生效后的场地可用性拦截（整停 / 一次性闭馆 / 每周固定闭馆）
      if (cls.venue_id) {
        const block = await venueAvailabilityBlock(cls.venue_id, cls.start_at, cls.end_at, tq);
        if (block) throw Object.assign(new Error(`该时段场地不可用：${block.reason}`), { status: 409 });
      }

      const dup = await tx.query(
        `SELECT 1 FROM bookings WHERE class_id=$1 AND member_id=$2 AND status IN ('booked','checked')`,
        [class_id, member_id]
      );
      if (dup.rows.length > 0) throw Object.assign(new Error('您已预约该课程'), { status: 409 });

      const booked = (await tx.query(
        `SELECT count(*)::int n FROM bookings WHERE class_id=$1 AND status IN ('booked','checked')`,
        [class_id]
      )).rows[0].n;
      if (booked >= cls.capacity) throw Object.assign(new Error('该课程已满员，可加入候补排队'), { status: 409 });

      // 选一张可用卡（优先到期早的期限卡，其次到期早的次卡）
      const card = await pickUsableCard(tq, member_id, cls.cost_sessions);
      if (!card) throw Object.assign(new Error('没有可用的会员卡（已过期或次数不足）'), { status: 409 });

      // 次卡预扣次数
      if (card.card_type === 'count') {
        await tx.query(`UPDATE membership_cards SET remaining = remaining - $2 WHERE id=$1`,
          [card.id, cls.cost_sessions]);
      }

      const code = await genUniqueVerifyCode(tq);
      const ins = await tx.query(
        `INSERT INTO bookings(class_id, member_id, card_id, verify_code)
         VALUES($1,$2,$3,$4) RETURNING *`,
        [class_id, member_id, card.id, code]
      );
      return ins.rows[0];
    });
    res.status(201).json(result);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// 取消预约：开课前 2 小时外免费取消并退次；2 小时内允许取消但不退次。
// 释放出的名额在同一事务内按候补队列递补（递补前重新校验场地可用性）。
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const result = await withTransaction(async (tx) => {
      const tq = (text, params) => tx.query(text, params);
      const b = (await tx.query(`
        SELECT b.*, cl.start_at, cl.cost_sessions FROM bookings b JOIN classes cl ON cl.id=b.class_id
        WHERE b.id=$1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!b) throw Object.assign(new Error('预约不存在'), { status: 404 });
      if (b.status !== 'booked') throw Object.assign(new Error('当前状态不可取消'), { status: 409 });

      const hours = (new Date(b.start_at) - Date.now()) / 3600e3;
      if (hours < 0) throw Object.assign(new Error('课程已开始'), { status: 409 });

      const refund = hours >= 2;
      if (refund && b.card_id) {
        await tx.query(
          `UPDATE membership_cards SET remaining = LEAST(COALESCE(remaining,0) + $2, total_sessions)
           WHERE id=$1 AND remaining IS NOT NULL`, [b.card_id, b.cost_sessions]
        );
      }
      await tx.query(
        `UPDATE bookings SET status='canceled', canceled_at=now(), cancel_reason=$2 WHERE id=$1`,
        [b.id, req.body.reason || (refund ? `会员取消（退还 ${b.cost_sessions} 次）` : `临期取消（不足2小时，不退 ${b.cost_sessions} 次）`)]
      );

      // 名额空出，尝试候补递补（场地已不可用时不会递补并说明原因）
      const promotion = await promoteWaitlist(tq, b.class_id);
      return { refund, refund_sessions: refund ? b.cost_sessions : 0, promotion };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

export default router;
