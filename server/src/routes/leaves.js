import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { reassignClass } from '../reassign.js';

const router = Router();

// 请假列表（含受影响课程数：请假时段内该教练仍未改派出去的未取消课程）
router.get('/', async (req, res, next) => {
  try {
    const r = await query(`
      SELECT l.*, c.name AS coach_name,
        (SELECT count(*) FROM classes cl
          WHERE cl.coach_id=l.coach_id AND cl.status='open'
            AND cl.start_at < l.end_at AND cl.end_at > l.start_at) AS affected_count
      FROM coach_leaves l JOIN coaches c ON c.id=l.coach_id
      ORDER BY l.start_at DESC`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 登记请假：返回请假单与受影响课程（该教练在请假时段内的未取消课程）
router.post('/', async (req, res, next) => {
  try {
    const { coach_id, start_at, end_at, reason } = req.body;
    if (!coach_id || !start_at || !end_at) return res.status(400).json({ error: '教练和请假起止时间必填' });
    if (new Date(end_at) <= new Date(start_at)) return res.status(400).json({ error: '结束时间必须晚于开始时间' });

    const coach = await query(`SELECT id, status FROM coaches WHERE id=$1`, [coach_id]);
    if (coach.rows.length === 0) return res.status(404).json({ error: '教练不存在' });

    const overlap = await query(
      `SELECT 1 FROM coach_leaves WHERE coach_id=$1 AND status='active' AND start_at < $3 AND end_at > $2`,
      [coach_id, start_at, end_at]
    );
    if (overlap.rows.length > 0) return res.status(409).json({ error: '与该教练已有的请假时段重叠' });

    const r = await query(
      `INSERT INTO coach_leaves(coach_id, start_at, end_at, reason) VALUES($1,$2,$3,$4) RETURNING *`,
      [coach_id, start_at, end_at, reason || null]
    );
    const affected = await affectedClasses(coach_id, start_at, end_at);
    res.status(201).json({ leave: r.rows[0], affected });
  } catch (e) { next(e); }
});

// 某张请假单的受影响课程（该教练请假时段内未取消、未锁定的课）
router.get('/:id/affected', async (req, res, next) => {
  try {
    const leave = (await query(`SELECT * FROM coach_leaves WHERE id=$1`, [req.params.id])).rows[0];
    if (!leave) return res.status(404).json({ error: '请假记录不存在' });
    res.json(await affectedClasses(leave.coach_id, leave.start_at, leave.end_at));
  } catch (e) { next(e); }
});

// 销假（已改派出去的课程不回滚，改派记录保留）
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const r = await query(
      `UPDATE coach_leaves SET status='canceled' WHERE id=$1 AND status='active' RETURNING *`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(409).json({ error: '请假记录不存在或已销假' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 批量改派：把请假时段内的课程一次改派给代课教练
// body: { assignments: [{ class_id, to_coach_id }], note }
// 任一课程校验失败则整体回滚，并返回具体是哪节课、什么原因
router.post('/:id/reassign', async (req, res, next) => {
  try {
    const leave = (await query(`SELECT * FROM coach_leaves WHERE id=$1`, [req.params.id])).rows[0];
    if (!leave) return res.status(404).json({ error: '请假记录不存在' });
    const assignments = Array.isArray(req.body.assignments) ? req.body.assignments : [];
    if (assignments.length === 0) return res.status(400).json({ error: '没有需要改派的课程' });

    const results = await withTransaction(async (tx) => {
      const out = [];
      for (const a of assignments) {
        out.push(await reassignClass(
          tx, Number(a.class_id), Number(a.to_coach_id), leave.id,
          req.body.note || `请假改派（请假单 #${leave.id}）`
        ));
      }
      return out;
    });
    res.json({ ok: true, count: results.length });
  } catch (e) { next(e); }
});

async function affectedClasses(coachId, startAt, endAt) {
  const r = await query(
    `SELECT cl.id, cl.title, cl.start_at, cl.end_at, cl.coach_id, cl.locked_period, cl.status,
       (SELECT count(*) FROM bookings b WHERE b.class_id=cl.id AND b.status IN ('booked','checked')) AS booked_count
     FROM classes cl
     WHERE cl.coach_id=$1 AND cl.status='open'
       AND cl.start_at < $3 AND cl.end_at > $2
     ORDER BY cl.start_at`,
    [coachId, startAt, endAt]
  );
  return r.rows;
}

export default router;
