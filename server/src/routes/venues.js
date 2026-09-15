import { Router } from 'express';
import { query } from '../db.js';
import { requirePerm } from '../auth.js';

const router = Router();

// 场地 + 各场地器械数（店长/前台）
router.get('/', requirePerm('venues_view'), async (req, res, next) => {
  try {
    const r = await query(`
      SELECT v.*,
        (SELECT count(*) FROM equipment e WHERE e.venue_id=v.id) AS equipment_count,
        (SELECT count(*) FROM equipment e WHERE e.venue_id=v.id AND e.status='normal') AS normal_count
      FROM venues v ORDER BY v.id`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

router.post('/', requirePerm('venues_write'), async (req, res, next) => {
  try {
    const { name, capacity, location } = req.body;
    const r = await query(
      `INSERT INTO venues(name, capacity, location) VALUES($1,$2,$3) RETURNING *`,
      [name, capacity || 10, location || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

router.put('/:id', requirePerm('venues_write'), async (req, res, next) => {
  try {
    const { name, capacity, location, status } = req.body;
    const r = await query(
      `UPDATE venues SET name=$1, capacity=$2, location=$3, status=$4 WHERE id=$5 RETURNING *`,
      [name, capacity, location, status, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// 器械列表（?venue_id= &status=）
router.get('/equipment/all', requirePerm('venues_view'), async (req, res, next) => {
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

router.post('/equipment', requirePerm('venues_write'), async (req, res, next) => {
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
router.put('/equipment/:id', requirePerm('venues_write'), async (req, res, next) => {
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
