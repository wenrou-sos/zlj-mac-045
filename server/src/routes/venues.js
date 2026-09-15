import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// 场地 + 各场地器械数
router.get('/', async (req, res, next) => {
  try {
    const r = await query(`
      SELECT v.*,
        (SELECT count(*) FROM equipment e WHERE e.venue_id=v.id) AS equipment_count,
        (SELECT count(*) FROM equipment e WHERE e.venue_id=v.id AND e.status='normal') AS normal_count
      FROM venues v ORDER BY v.id`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, capacity, location } = req.body;
    const r = await query(
      `INSERT INTO venues(name, capacity, location) VALUES($1,$2,$3) RETURNING *`,
      [name, capacity || 10, location || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { name, capacity, location, status } = req.body;
    const r = await query(
      `UPDATE venues SET name=$1, capacity=$2, location=$3, status=$4 WHERE id=$5 RETURNING *`,
      [name, capacity, location, status, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// 未来 7 天场地视图：每块场地每天的课程占用与不可用时段（前端按天裁剪渲染）
router.get('/week', async (req, res, next) => {
  try {
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '') ? req.query.start : null;
    const dayRows = (await query(`
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
             COALESCE($1::date, CURRENT_DATE)::text AS start
      FROM generate_series(COALESCE($1::date, CURRENT_DATE), COALESCE($1::date, CURRENT_DATE) + 6, interval '1 day') d(day)
      ORDER BY 1`, [start])).rows;
    const days = dayRows.map((r) => r.day);
    const s = dayRows[0].start;

    const [venues, classes, weekly, once] = await Promise.all([
      query(`SELECT * FROM venues ORDER BY id`),
      query(`
        SELECT cl.id, cl.venue_id, cl.title, cl.start_at, cl.end_at, cl.capacity,
          co.name AS coach_name,
          (SELECT count(*) FROM bookings b WHERE b.class_id=cl.id AND b.status IN ('booked','checked')) AS booked_count
        FROM classes cl LEFT JOIN coaches co ON co.id=cl.coach_id
        WHERE cl.status='open'
          AND cl.start_at < ($1::date + 7)::timestamptz AND cl.end_at > $1::date::timestamptz
        ORDER BY cl.start_at`, [s]),
      // 每周固定闭馆展开成 7 天内的具体段
      query(`
        SELECT u.venue_id, u.id, u.reason, u.weekday, u.start_time, u.end_time,
          (d.day::date + u.start_time)::timestamptz AS start_at,
          (d.day::date + u.end_time)::timestamptz AS end_at
        FROM venue_blocks u
        JOIN generate_series($1::date, ($1::date + 6)::date, interval '1 day') d(day)
          ON EXTRACT(DOW FROM d.day)::int = u.weekday
        WHERE u.kind='weekly'`, [s]),
      // 一次性区间裁剪到本周范围
      query(`
        SELECT venue_id, id, reason,
          GREATEST(start_at, $1::date::timestamptz) AS start_at,
          LEAST(end_at, ($1::date + 7)::timestamptz) AS end_at
        FROM venue_blocks
        WHERE kind='once'
          AND start_at < ($1::date + 7)::timestamptz AND end_at > $1::date::timestamptz`, [s]),
    ]);

    res.json({
      start: s,
      days,
      venues: venues.rows.map((v) => ({
        ...v,
        classes: classes.rows.filter((c) => c.venue_id === v.id),
        blocks: [
          ...weekly.rows.filter((b) => b.venue_id === v.id).map((b) => ({ ...b, kind: 'weekly' })),
          ...once.rows.filter((b) => b.venue_id === v.id).map((b) => ({ ...b, kind: 'once' })),
        ],
      })),
    });
  } catch (e) { next(e); }
});

// 器械列表（?venue_id= &status=）
router.get('/equipment/all', async (req, res, next) => {
  try {
    const { venue_id, status } = req.query;
    const conds = [];
    const params = [];
    if (venue_id) { params.push(venue_id); conds.push(`e.venue_id=$${params.length}`); }
    if (status) { params.push(status); conds.push(`e.status=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await query(`
      SELECT e.*, v.name AS venue_name
      FROM equipment e LEFT JOIN venues v ON v.id=e.venue_id
      ${where} ORDER BY e.id`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

router.post('/equipment', async (req, res, next) => {
  try {
    const { venue_id, name, asset_no, quantity, status, purchased_at, note } = req.body;
    const r = await query(
      `INSERT INTO equipment(venue_id, name, asset_no, quantity, status, purchased_at, note)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [venue_id || null, name, asset_no || null, quantity || 1, status || 'normal', purchased_at || null, note || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '资产编号已存在' });
    next(e);
  }
});

// 更新器械（主要用于状态变更：正常 / 维修中 / 报废）
router.put('/equipment/:id', async (req, res, next) => {
  try {
    const { venue_id, name, quantity, status, note } = req.body;
    const r = await query(
      `UPDATE equipment SET venue_id=$1, name=$2, quantity=$3, status=$4, note=$5
       WHERE id=$6 RETURNING *`,
      [venue_id, name, quantity, status, note, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

export default router;
