import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// 课表列表：?from=ISO&to=ISO
router.get('/', async (req, res, next) => {
  try {
    const from = req.query.from || new Date(Date.now() - 7 * 86400e3).toISOString();
    const to = req.query.to || new Date(Date.now() + 14 * 86400e3).toISOString();
    const r = await query(`
      SELECT cl.*, co.name AS coach_name, v.name AS venue_name,
        eq.name AS required_equipment_name,
        (SELECT count(*) FROM bookings b WHERE b.class_id=cl.id
          AND b.status IN ('booked','checked')) AS booked_count,
        (SELECT count(*) FROM bookings b WHERE b.class_id=cl.id AND b.status='checked') AS checked_count
      FROM classes cl
      LEFT JOIN coaches co ON co.id=cl.coach_id
      LEFT JOIN venues v ON v.id=cl.venue_id
      LEFT JOIN equipment eq ON eq.id=cl.required_equipment_id
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
    const required_equipment_id = req.body.required_equipment_id ? Number(req.body.required_equipment_id) : null;
    const required_quantity = Number(req.body.required_quantity) || 0;
    if (!title || !start_at || !end_at) return res.status(400).json({ error: '课程名和时间必填' });
    if (new Date(end_at) <= new Date(start_at)) return res.status(400).json({ error: '结束时间必须晚于开始时间' });

    // 所需器械必须属于该场地，且场地当前「可用（正常）」数量要够（维修中/报废的不可用）
    if (required_equipment_id && required_quantity > 0) {
      if (!venue_id) return res.status(400).json({ error: '指定所需器械时必须先选择场地' });
      const eq = await query(
        `SELECT name, venue_id, quantity, status FROM equipment WHERE id=$1`,
        [required_equipment_id]
      );
      if (eq.rows.length === 0) return res.status(404).json({ error: '所需器械不存在' });
      if (eq.rows[0].venue_id !== venue_id) {
        return res.status(409).json({ error: `「${eq.rows[0].name}」不属于所选场地，无法用于本节课` });
      }
      if (eq.rows[0].status !== 'normal') {
        return res.status(409).json({ error: `「${eq.rows[0].name}」当前为维修中/已报废，暂不可用于排课` });
      }
      if (eq.rows[0].quantity < required_quantity) {
        return res.status(409).json({
          error: `该场地当前可用「${eq.rows[0].name}」仅 ${eq.rows[0].quantity} 台，不足课程所需 ${required_quantity} 台`,
        });
      }
    }

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
      `INSERT INTO classes(title, coach_id, venue_id, start_at, end_at, capacity, cost_sessions,
         required_equipment_id, required_quantity)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [title, coach_id, venue_id, start_at, end_at, capacity, cost_sessions,
       required_equipment_id, required_equipment_id ? required_quantity : 0]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

// 取消课程（已有的未来预约一并取消）
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const cls = await query(`SELECT * FROM classes WHERE id=$1`, [req.params.id]);
    if (cls.rows.length === 0) return res.status(404).json({ error: '课程不存在' });
    if (new Date(cls.rows[0].start_at) < new Date()) {
      return res.status(400).json({ error: '已开始的课程不能取消' });
    }
    await query(`UPDATE classes SET status='canceled' WHERE id=$1`, [req.params.id]);
    // 取消全部未核销预约，并按该课程实际消耗课次退还（多课次课程不能只退 1）
    const bookings = await query(
      `SELECT b.id, b.card_id, cl.cost_sessions
       FROM bookings b JOIN classes cl ON cl.id = b.class_id
       WHERE b.class_id=$1 AND b.status IN ('booked','checked')`,
      [req.params.id]
    );
    for (const b of bookings.rows) {
      await query(
        `UPDATE bookings SET status='canceled', canceled_at=now(), cancel_reason=$2 WHERE id=$1`,
        [b.id, req.body.reason || '课程取消']
      );
      if (b.card_id) {
        await query(
          `UPDATE membership_cards SET remaining = LEAST(COALESCE(remaining,0) + $2, total_sessions)
           WHERE id=$1 AND remaining IS NOT NULL`,
          [b.card_id, b.cost_sessions]
        );
      }
    }
    res.json({ ok: true, affected: bookings.rows.length });
  } catch (e) { next(e); }
});

export default router;
