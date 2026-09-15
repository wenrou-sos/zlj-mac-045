import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// 场地 + 各场地器械数（按台数 quantity 汇总：维修/报废会减少可用数量）
router.get('/', async (req, res, next) => {
  try {
    const r = await query(`
      SELECT v.*,
        COALESCE((SELECT sum(e.quantity) FROM equipment e WHERE e.venue_id=v.id), 0) AS equipment_count,
        COALESCE((SELECT sum(e.quantity) FROM equipment e WHERE e.venue_id=v.id AND e.status='normal'), 0) AS normal_count
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
      SELECT e.*, v.name AS venue_name,
        (e.maintain_interval_days IS NOT NULL
          AND (COALESCE(e.last_maintained_at, e.purchased_at, CURRENT_DATE)
               + (e.maintain_interval_days || ' days')::interval)::date <= CURRENT_DATE
        ) AS maintain_due,
        EXISTS(SELECT 1 FROM repair_orders o
               WHERE o.equipment_id=e.id AND o.status IN ('pending','processing')) AS has_open_order
      FROM equipment e LEFT JOIN venues v ON v.id=e.venue_id
      ${where} ORDER BY e.id`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

router.post('/equipment', async (req, res, next) => {
  try {
    const { venue_id, name, asset_no, quantity, status, purchased_at, note,
      maintain_interval_days, last_maintained_at } = req.body;
    const r = await query(
      `INSERT INTO equipment(venue_id, name, asset_no, quantity, status, purchased_at, note,
         maintain_interval_days, last_maintained_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [venue_id || null, name, asset_no || null, quantity || 1, status || 'normal',
       purchased_at || null, note || null,
       maintain_interval_days ? Number(maintain_interval_days) : null,
       last_maintained_at || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '资产编号已存在' });
    next(e);
  }
});

// 更新器械档案（状态不在此直接改：维修/报废一律走维修工单，保证有记录可查）
router.put('/equipment/:id', async (req, res, next) => {
  try {
    const { venue_id, name, quantity, note, maintain_interval_days, last_maintained_at } = req.body;
    const r = await query(
      `UPDATE equipment SET venue_id=$1, name=$2, quantity=$3, note=$4,
         maintain_interval_days=$5, last_maintained_at=$6
       WHERE id=$7 RETURNING *`,
      [venue_id || null, name, quantity, note,
       maintain_interval_days ? Number(maintain_interval_days) : null,
       last_maintained_at || null, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// 登记一次保养：更新上次保养日期，并关闭该器械的待处理保养提醒
router.post('/equipment/:id/maintain', async (req, res, next) => {
  try {
    const maintained_at = req.body.maintained_at || null;
    const r = await query(
      `UPDATE equipment SET last_maintained_at=COALESCE($2, CURRENT_DATE)
       WHERE id=$1 RETURNING *`,
      [req.params.id, maintained_at]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: '器械不存在' });
    await query(
      `UPDATE reminders SET status='notified'
       WHERE equipment_id=$1 AND type='equipment_maintain' AND status IN ('pending','ignored')`,
      [req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

export default router;
