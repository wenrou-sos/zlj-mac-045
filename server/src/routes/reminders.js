import { Router } from 'express';
import { query } from '../db.js';
import { refreshCardStatuses, regenerateReminders } from '../reminderLogic.js';

const router = Router();

// 提醒列表
router.get('/', async (req, res, next) => {
  try {
    await refreshCardStatuses();
    await regenerateReminders();
    const { status = 'pending', type } = req.query;
    const conds = [];
    const params = [];
    if (status !== 'all') { params.push(status); conds.push(`r.status=$${params.length}`); }
    if (type) { params.push(type); conds.push(`r.type=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await query(`
      SELECT r.*, m.name AS member_name, m.phone, c.card_no, c.plan_name,
        c.end_date, c.remaining, c.card_type
      FROM reminders r
      JOIN members m ON m.id=r.member_id
      LEFT JOIN membership_cards c ON c.id=r.card_id
      ${where}
      ORDER BY
        CASE r.type WHEN 'expired' THEN 0 WHEN 'low_sessions' THEN 1 ELSE 2 END,
        r.created_at DESC`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 标记已通知 / 忽略
router.post('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['pending', 'notified', 'ignored'].includes(status)) {
      return res.status(400).json({ error: '非法状态' });
    }
    await query(`UPDATE reminders SET status=$2 WHERE id=$1`, [req.params.id, status]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
