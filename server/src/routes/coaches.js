import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const r = await query(`
      SELECT co.*,
        (SELECT count(*) FROM coach_schedules s WHERE s.coach_id=co.id
          AND s.work_date >= CURRENT_DATE) AS upcoming_shifts
      FROM coaches co ORDER BY co.id`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, phone, specialty, hourly_rate } = req.body;
    if (!name) return res.status(400).json({ error: '教练姓名必填' });
    const r = await query(
      `INSERT INTO coaches(name, phone, specialty, hourly_rate) VALUES($1,$2,$3,$4) RETURNING *`,
      [name, phone || null, specialty || null, hourly_rate || 0]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { name, phone, specialty, hourly_rate, status } = req.body;
    const r = await query(
      `UPDATE coaches SET name=$1, phone=$2, specialty=$3, hourly_rate=$4, status=$5
       WHERE id=$6 RETURNING *`,
      [name, phone, specialty, hourly_rate, status, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

export default router;
