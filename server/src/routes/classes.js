import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requirePerm, writeAudit } from '../auth.js';

const router = Router();

// 课表列表：?from=&to=
// 教练角色只能看到自己带的课（数据在 SQL 层隔离，绕过前端直接请求同样受限）
router.get('/', requirePerm('classes_view'), async (req, res, next) => {
  try {
    const from = req.query.from || new Date(Date.now() - 7 * 86400e3).toISOString();
    const to = req.query.to || new Date(Date.now() + 14 * 86400e3).toISOString();
    const coachScope = req.user.role === 'coach' ? `AND cl.coach_id=$3` : '';
    const params = [from, to];
    if (req.user.role === 'coach') {
      if (!req.user.coach_id) return res.json([]);
      params.push(req.user.coach_id);
    }
    const r = await query(`
      SELECT cl.*, co.name AS coach_name, v.name AS venue_name,
        (SELECT count(*) FROM bookings b WHERE b.class_id=cl.id
          AND b.status IN ('booked','checked')) AS booked_count,
        (SELECT count(*) FROM bookings b WHERE b.class_id=cl.id AND b.status='checked') AS checked_count
      FROM classes cl
      LEFT JOIN coaches co ON co.id=cl.coach_id
      LEFT JOIN venues v ON v.id=cl.venue_id
      WHERE cl.start_at >= $1 AND cl.start_at <= $2 ${coachScope}
      ORDER BY cl.start_at`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 排课（仅店长）：校验场地时间冲突、教练排班/课程冲突、容量不超过场地容量
router.post('/', requirePerm('classes_write'), async (req, res, next) => {
  try {
    const { title, start_at, end_at } = req.body;
    const coach_id = req.body.coach_id ? Number(req.body.coach_id) : null;
    const venue_id = req.body.venue_id ? Number(req.body.venue_id) : null;
    const capacity = Number(req.body.capacity) || 10;
    const cost_sessions = Number(req.body.cost_sessions) || 1;
    if (!title || !start_at || !end_at) return res.status(400).json({ error: '课程名和时间必填' });
    if (new Date(end_at) <= new Date(start_at)) return res.status(400).json({ error: '结束时间必须晚于开始时间' });

    if (venue_id) {
      const venue = await query(`SELECT capacity, status FROM venues WHERE id=$1`, [venue_id]);
      if (venue.rows.length === 0) return res.status(404).json({ error: '场地不存在' });
      if (venue.rows[0].status === 'closed') return res.status(409).json({ error: '场地已关闭，无法排课' });
      if (capacity > venue.rows[0].capacity) {
        return res.status(409).json({ error: `容量超过该场地上限 ${venue.rows[0].capacity} 人` });
      }
      const vc = await query(`
        SELECT 1 FROM classes WHERE venue_id=$1 AND status='open'
          AND start_at < $3 AND end_at > $2`, [venue_id, start_at, end_at]);
      if (vc.rows.length > 0) return res.status(409).json({ error: '该场地此时段已有课程' });
    }
    if (coach_id) {
      const cc = await query(`
        SELECT 1 FROM classes WHERE coach_id=$1 AND status='open'
          AND start_at < $3 AND end_at > $2`, [coach_id, start_at, end_at]);
      if (cc.rows.length > 0) return res.status(409).json({ error: '该教练此时段已有其他课程' });
    }
    const r = await query(
      `INSERT INTO classes(title, coach_id, venue_id, start_at, end_at, capacity, cost_sessions)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title, coach_id, venue_id, start_at, end_at, capacity, cost_sessions]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

// 取消课程（仅店长）：已有的未来预约一并取消退次；整课取消必须入审计
router.post('/:id/cancel', requirePerm('class_cancel'), async (req, res, next) => {
  try {
    const cls = await query(`
      SELECT cl.*, co.name AS coach_name FROM classes cl
      LEFT JOIN coaches co ON co.id=cl.coach_id WHERE cl.id=$1`, [req.params.id]);
    if (cls.rows.length === 0) return res.status(404).json({ error: '课程不存在' });
    const c = cls.rows[0];
    if (new Date(c.start_at) < new Date()) {
      return res.status(400).json({ error: '已开始的课程不能取消' });
    }
    const reason = req.body.reason || '整课取消';

    const affected = await withTransaction(async (tx) => {
      await tx.query(`UPDATE classes SET status='canceled' WHERE id=$1`, [req.params.id]);
      // 取消全部未核销预约，并按该课程实际消耗课次退还（多课次课程不能只退 1）
      const bookings = await tx.query(
        `SELECT b.id, b.card_id, b.member_id, m.name AS member_name,
                cc.card_no, cl.cost_sessions
         FROM bookings b
         JOIN classes cl ON cl.id = b.class_id
         JOIN members m ON m.id = b.member_id
         LEFT JOIN membership_cards cc ON cc.id = b.card_id
         WHERE b.class_id=$1 AND b.status IN ('booked','checked')`,
        [req.params.id]
      );
      const details = [];
      for (const b of bookings.rows) {
        await tx.query(
          `UPDATE bookings SET status='canceled', canceled_at=now(), cancel_reason=$2 WHERE id=$1`,
          [b.id, reason]
        );
        if (b.card_id) {
          await tx.query(
            `UPDATE membership_cards SET remaining = LEAST(COALESCE(remaining,0) + $2, total_sessions)
             WHERE id=$1 AND remaining IS NOT NULL`,
            [b.card_id, b.cost_sessions]
          );
        }
        details.push({
          booking_id: b.id, member: b.member_name, card_no: b.card_no,
          refund_sessions: b.card_id ? b.cost_sessions : 0,
        });
      }
      await writeAudit(tx, {
        user: req.user, action: 'class_cancel', targetType: 'class', targetId: c.id,
        detail: {
          title: c.title, coach_name: c.coach_name, start_at: c.start_at,
          reason, affected_bookings: bookings.rows.length, refunds: details,
        },
        req,
      });
      return bookings.rows.length;
    });
    res.json({ ok: true, affected });
  } catch (e) { next(e); }
});

export default router;
