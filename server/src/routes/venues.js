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

// ---- 场地不可用时段（全天闭馆 / 部分时段维护，排课时自动跳过）----
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// 列表：?venue_id= （默认返回全部）
router.get('/unavailable/all', async (req, res, next) => {
  try {
    const { venue_id } = req.query;
    const r = await query(`
      SELECT u.id, u.venue_id, v.name AS venue_name,
        to_char(u.start_date,'YYYY-MM-DD') AS start_date,
        to_char(u.end_date,'YYYY-MM-DD') AS end_date,
        u.start_time, u.end_time, u.reason, u.created_at
      FROM venue_unavailable u JOIN venues v ON v.id=u.venue_id
      ${venue_id ? 'WHERE u.venue_id=$1' : ''}
      ORDER BY u.start_date DESC, u.start_time DESC`, venue_id ? [venue_id] : []);
    res.json(r.rows);
  } catch (e) { next(e); }
});

router.post('/unavailable', async (req, res, next) => {
  try {
    const venue_id = Number(req.body.venue_id);
    const { start_date, end_date, reason } = req.body;
    const start_time = req.body.start_time || '00:00';
    const end_time = req.body.end_time || '23:59';
    if (!venue_id || !start_date || !end_date) {
      return res.status(400).json({ error: '场地和起止日期必填' });
    }
    if (!DATE_RE.test(start_date) || !DATE_RE.test(end_date) || end_date < start_date) {
      return res.status(400).json({ error: '日期不合法或结束日期早于开始日期' });
    }
    if (!TIME_RE.test(start_time) || !TIME_RE.test(end_time)) {
      return res.status(400).json({ error: '时间格式应为 HH:MM' });
    }
    if (start_date === end_date && start_time >= end_time) {
      return res.status(400).json({ error: '结束时间必须晚于开始时间' });
    }
    const r = await query(
      `INSERT INTO venue_unavailable(venue_id, start_date, end_date, start_time, end_time, reason)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [venue_id, start_date, end_date, start_time, end_time, reason || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

router.put('/unavailable/:id', async (req, res, next) => {
  try {
    const { venue_id, start_date, end_date, start_time, end_time, reason } = req.body;
    if (start_date === end_date && start_time >= end_time) {
      return res.status(400).json({ error: '结束时间必须晚于开始时间' });
    }
    const r = await query(
      `UPDATE venue_unavailable SET venue_id=$1, start_date=$2, end_date=$3, start_time=$4,
         end_time=$5, reason=$6 WHERE id=$7 RETURNING *`,
      [venue_id, start_date, end_date, start_time || '00:00', end_time || '23:59', reason || null, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

router.delete('/unavailable/:id', async (req, res, next) => {
  try {
    await query(`DELETE FROM venue_unavailable WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
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
