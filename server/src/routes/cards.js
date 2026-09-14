import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { refreshCardStatuses, regenerateReminders } from '../reminderLogic.js';

const router = Router();

// 会员卡列表，支持状态筛选
router.get('/', async (req, res, next) => {
  try {
    await refreshCardStatuses();
    const { status, keyword } = req.query;
    const conds = [];
    const params = [];
    if (status && status !== 'all') { params.push(status); conds.push(`c.status=$${params.length}`); }
    if (keyword) {
      params.push(`%${keyword}%`);
      conds.push(`(m.name ILIKE $${params.length} OR c.card_no ILIKE $${params.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await query(`
      SELECT c.*, m.name AS member_name, m.phone
      FROM membership_cards c JOIN members m ON m.id=c.member_id
      ${where}
      ORDER BY c.end_date NULLS LAST, c.id DESC`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 开卡
router.post('/', async (req, res, next) => {
  try {
    const { member_id, plan_name, card_type, price, start_date, end_date, total_sessions } = req.body;
    if (!member_id || !plan_name || !card_type || !start_date) {
      return res.status(400).json({ error: '会员、卡种、类型、开始日期必填' });
    }
    const cardNo = await withTransaction(async (tx) => {
      const n = await tx.query(`SELECT count(*)::int AS n FROM membership_cards`);
      const no = `VIP${new Date().getFullYear()}${String(n.rows[0].n + 1).padStart(3, '0')}`;
      await tx.query(
        `INSERT INTO membership_cards
         (member_id, card_no, plan_name, card_type, price, start_date, end_date, total_sessions, remaining, status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')`,
        [member_id, no, plan_name, card_type, price || 0, start_date,
          end_date || null, total_sessions || null, total_sessions || null]
      );
      return no;
    });
    res.status(201).json({ card_no: cardNo });
  } catch (e) { next(e); }
});

// 续费：期限卡延长 end_date；次卡增加 total_sessions/remaining
router.post('/:id/renew', async (req, res, next) => {
  try {
    const { amount, extend_days, add_sessions, operator } = req.body;
    const cardRes = await query(`SELECT * FROM membership_cards WHERE id=$1`, [req.params.id]);
    if (cardRes.rows.length === 0) return res.status(404).json({ error: '卡不存在' });
    const card = cardRes.rows[0];
    let newEnd = card.end_date;
    let newTotal = card.total_sessions;

    await withTransaction(async (tx) => {
      if (card.card_type === 'period' && extend_days > 0) {
        // 若已过期，从今天开始顺延；否则从原到期日顺延
        newEnd = await tx.query(
          `UPDATE membership_cards SET
             end_date = GREATEST(COALESCE(end_date, CURRENT_DATE), CURRENT_DATE) + ($2 * INTERVAL '1 day'),
             status = 'active'
           WHERE id=$1 RETURNING end_date`,
          [card.id, extend_days]
        );
        newEnd = newEnd.rows[0].end_date;
      } else if (card.card_type === 'count' && add_sessions > 0) {
        const r = await tx.query(
          `UPDATE membership_cards SET
             total_sessions = COALESCE(total_sessions,0) + $2,
             remaining = COALESCE(remaining,0) + $2,
             status = 'active'
           WHERE id=$1 RETURNING total_sessions`,
          [card.id, add_sessions]
        );
        newTotal = r.rows[0].total_sessions;
      }
      await tx.query(
        `INSERT INTO renewals(card_id, member_id, amount, new_end_date, added_sessions, operator)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [card.id, card.member_id, amount || 0,
          card.card_type === 'period' ? newEnd : null,
          card.card_type === 'count' ? add_sessions : null,
          operator || '前台']
      );
      // 续费后该卡的待处理提醒标记为已通知（会员已知晓）
      await tx.query(
        `UPDATE reminders SET status='notified' WHERE card_id=$1 AND status='pending'`,
        [card.id]
      );
    });
    await regenerateReminders();
    res.json({ ok: true, new_end_date: newEnd, new_total_sessions: newTotal });
  } catch (e) { next(e); }
});

// 冻结 / 解冻
router.post('/:id/freeze', async (req, res, next) => {
  try {
    await query(
      `UPDATE membership_cards SET status = CASE WHEN status='frozen' THEN 'active' ELSE 'frozen' END
       WHERE id=$1`, [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 续费记录
router.get('/renewals/list', async (req, res, next) => {
  try {
    const r = await query(`
      SELECT r.*, m.name AS member_name, c.plan_name
      FROM renewals r
      JOIN members m ON m.id=r.member_id
      LEFT JOIN membership_cards c ON c.id=r.card_id
      ORDER BY r.renewed_at DESC LIMIT 100`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

export default router;
