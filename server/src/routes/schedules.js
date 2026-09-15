import { Router } from 'express';
import { query } from '../db.js';
import { requirePerm } from '../auth.js';

const router = Router();

// 排班列表：?start=YYYY-MM-DD&end=YYYY-MM-DD
// 教练角色只能看到自己的排班（SQL 层过滤）
router.get('/', requirePerm('schedules_view'), async (req, res, next) => {
  try {
    const start = req.query.start;
    const end = req.query.end;
    const coachScope = req.user.role === 'coach' ? 'AND s.coach_id=$3' : '';
    const params = [start || null, end || null];
    if (req.user.role === 'coach') {
      if (!req.user.coach_id) return res.json([]);
      params.push(req.user.coach_id);
    }
    const r = await query(`
      SELECT s.*, c.name AS coach_name, c.specialty
      FROM coach_schedules s JOIN coaches c ON c.id=s.coach_id
      WHERE ($1::date IS NULL OR s.work_date >= $1)
        AND ($2::date IS NULL OR s.work_date <= $2)
        ${coachScope}
      ORDER BY s.work_date, s.start_time`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 新增排班（仅店长）：校验时间合法、与已有排班不重叠
router.post('/', requirePerm('schedules_write'), async (req, res, next) => {
  try {
    const { coach_id, work_date, start_time, end_time, shift_type } = req.body;
    if (!coach_id || !work_date || !start_time || !end_time) {
      return res.status(400).json({ error: '教练、日期、起止时间必填' });
    }
    if (end_time <= start_time) return res.status(400).json({ error: '结束时间必须晚于开始时间' });

    const conflict = await query(`
      SELECT 1 FROM coach_schedules
      WHERE coach_id=$1 AND work_date=$2 AND start_time < $4 AND end_time > $3`,
      [coach_id, work_date, start_time, end_time]);
    if (conflict.rows.length > 0) {
      return res.status(409).json({ error: '与该教练当天已有排班时间冲突' });
    }
    const r = await query(
      `INSERT INTO coach_schedules(coach_id, work_date, start_time, end_time, shift_type)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [coach_id, work_date, start_time, end_time, shift_type || 'normal']
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '该时段排班已存在' });
    next(e);
  }
});

// 删除排班（仅店长）
router.delete('/:id', requirePerm('schedules_write'), async (req, res, next) => {
  try {
    await query(`DELETE FROM coach_schedules WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
