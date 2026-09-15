import { Router } from 'express';
import { query } from '../db.js';
import { requirePerm } from '../auth.js';

const router = Router();

// 教练档案：店长 / 前台（教练角色不需要看教练管理页）
router.get('/', requirePerm('coaches_view'), async (req, res, next) => {
  try {
    const r = await query(`
      SELECT co.*,
        (SELECT count(*) FROM coach_schedules s WHERE s.coach_id=co.id
          AND s.work_date >= CURRENT_DATE) AS upcoming_shifts
      FROM coaches co ORDER BY co.id`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 新增教练：仅店长
router.post('/', requirePerm('coaches_write'), async (req, res, next) => {
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

// 编辑 / 停用：仅店长
router.put('/:id', requirePerm('coaches_write'), async (req, res, next) => {
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
