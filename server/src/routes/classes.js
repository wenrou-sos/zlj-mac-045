import { Router } from 'express';
import { query, withTransaction } from '../db.js';

const router = Router();

// 课表列表：?from=ISO&to=ISO
router.get('/', async (req, res, next) => {
  try {
    const from = req.query.from || new Date(Date.now() - 7 * 86400e3).toISOString();
    const to = req.query.to || new Date(Date.now() + 14 * 86400e3).toISOString();
    const r = await query(`
      SELECT cl.*, co.name AS coach_name, v.name AS venue_name,
        (SELECT count(*) FROM bookings b WHERE b.class_id=cl.id
          AND b.status IN ('booked','checked')) AS booked_count,
        (SELECT count(*) FROM bookings b WHERE b.class_id=cl.id AND b.status='checked') AS checked_count,
        (SELECT count(*) FROM waitlists w WHERE w.class_id=cl.id AND w.status='waiting') AS waiting_count,
        (SELECT count(*) FROM waitlists w WHERE w.class_id=cl.id AND w.status='promoted') AS promoted_count
      FROM classes cl
      LEFT JOIN coaches co ON co.id=cl.coach_id
      LEFT JOIN venues v ON v.id=cl.venue_id
      WHERE cl.start_at >= $1 AND cl.start_at <= $2
      ORDER BY cl.start_at`, [from, to]);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 排课：校验场地时间冲突、教练排班/课程冲突、容量不超过场地容量
router.post('/', async (req, res, next) => {
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

// 取消课程（已有的未来预约一并取消退次；候补队列整体关闭，已转正未确认的同样退次）
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const reason = req.body.reason || '课程取消';
    const result = await withTransaction(async (tx) => {
      const cls = (await tx.query(`SELECT * FROM classes WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!cls) throw Object.assign(new Error('课程不存在'), { status: 404 });
      if (new Date(cls.start_at) < new Date()) throw Object.assign(new Error('已开始的课程不能取消'), { status: 400 });
      await tx.query(`UPDATE classes SET status='canceled' WHERE id=$1`, [cls.id]);

      // 取消全部未核销预约，并按该课程实际消耗课次退还（多课次课程不能只退 1）
      const bookings = await tx.query(
        `SELECT id, card_id FROM bookings
         WHERE class_id=$1 AND status IN ('booked','checked') FOR UPDATE`,
        [cls.id]
      );
      for (const b of bookings.rows) {
        await tx.query(
          `UPDATE bookings SET status='canceled', canceled_at=now(), cancel_reason=$2 WHERE id=$1`,
          [b.id, reason]
        );
        if (b.card_id) {
          await tx.query(
            `UPDATE membership_cards SET remaining = LEAST(COALESCE(remaining,0) + $2, total_sessions)
             WHERE id=$1 AND remaining IS NOT NULL`,
            [b.card_id, cls.cost_sessions]
          );
        }
      }

      // 关闭候补队列：排队中的直接关闭（未预扣，无需退次）；
      // 已递补待确认的预约随上面的批量取消已退次，候补记录标记关闭
      const waits = await tx.query(
        `SELECT id, booking_id FROM waitlists
         WHERE class_id=$1 AND status IN ('waiting','promoted') FOR UPDATE`,
        [cls.id]
      );
      for (const w of waits.rows) {
        await tx.query(
          `UPDATE waitlists SET status='closed', closed_at=now(),
           result_note=$2 WHERE id=$1`,
          [w.id, `整课取消：${reason}`]
        );
      }
      return { affected: bookings.rows.length, waitlists: waits.rows.length };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

export default router;
