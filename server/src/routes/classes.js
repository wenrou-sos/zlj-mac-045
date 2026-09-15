import { Router } from 'express';
import { query } from '../db.js';
import { checkClassFeasible, cancelSingleClass } from '../classLogic.js';

const router = Router();

// 课表列表：?from=ISO&to=ISO（带出模板来源，便于反查）
router.get('/', async (req, res, next) => {
  try {
    const from = req.query.from || new Date(Date.now() - 7 * 86400e3).toISOString();
    const to = req.query.to || new Date(Date.now() + 14 * 86400e3).toISOString();
    const r = await query(`
      SELECT cl.*, co.name AS coach_name, v.name AS venue_name,
        ct.title AS template_title,
        (SELECT count(*) FROM bookings b WHERE b.class_id=cl.id
          AND b.status IN ('booked','checked')) AS booked_count,
        (SELECT count(*) FROM bookings b WHERE b.class_id=cl.id AND b.status='checked') AS checked_count
      FROM classes cl
      LEFT JOIN coaches co ON co.id=cl.coach_id
      LEFT JOIN venues v ON v.id=cl.venue_id
      LEFT JOIN class_templates ct ON ct.id=cl.template_id
      WHERE cl.start_at >= $1 AND cl.start_at <= $2
      ORDER BY cl.start_at`, [from, to]);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 排课：校验场地关闭 / 场地不可用时段 / 场地时间冲突 / 教练冲突 / 容量上限
router.post('/', async (req, res, next) => {
  try {
    const { title, start_at, end_at } = req.body;
    const coach_id = req.body.coach_id ? Number(req.body.coach_id) : null;
    const venue_id = req.body.venue_id ? Number(req.body.venue_id) : null;
    const capacity = Number(req.body.capacity) || 10;
    const cost_sessions = Number(req.body.cost_sessions) || 1;
    if (!title || !start_at || !end_at) return res.status(400).json({ error: '课程名和时间必填' });

    const check = await checkClassFeasible({ coach_id, venue_id, capacity, start_at, end_at });
    if (!check.ok) return res.status(409).json({ error: check.reason, code: check.code });

    const r = await query(
      `INSERT INTO classes(title, coach_id, venue_id, start_at, end_at, capacity, cost_sessions)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title, coach_id, venue_id, start_at, end_at, capacity, cost_sessions]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

// 取消课程（已预约学员一并取消并按课程消耗课次退次）
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const result = await cancelSingleClass(req.params.id, req.body.reason || '课程取消');
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

export default router;
