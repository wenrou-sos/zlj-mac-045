import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// 改派记录：哪节课、原教练 -> 现教练、关联请假单、时间
router.get('/', async (req, res, next) => {
  try {
    const r = await query(`
      SELECT ra.*, cl.title, cl.start_at, cl.end_at,
        fc.name AS from_coach_name, tc.name AS to_coach_name,
        l.reason AS leave_reason
      FROM class_reassignments ra
      JOIN classes cl ON cl.id = ra.class_id
      LEFT JOIN coaches fc ON fc.id = ra.from_coach_id
      JOIN coaches tc ON tc.id = ra.to_coach_id
      LEFT JOIN coach_leaves l ON l.id = ra.leave_id
      ORDER BY ra.created_at DESC
      LIMIT 200`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

export default router;
