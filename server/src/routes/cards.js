import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { refreshCardStatuses, regenerateReminders } from '../reminderLogic.js';
import { requirePerm, writeAudit } from '../auth.js';

const router = Router();

// 会员卡列表，支持状态筛选（教练角色无 cards_view 权限，直接 403）
router.get('/', requirePerm('cards_view'), async (req, res, next) => {
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

// 开卡（前台/店长）。业务写入与审计在同一事务：开卡失败则审计也不落地
router.post('/', requirePerm('cards_open'), async (req, res, next) => {
  try {
    const { member_id, plan_name, card_type, price, start_date, end_date, total_sessions } = req.body;
    if (!member_id || !plan_name || !card_type || !start_date) {
      return res.status(400).json({ error: '会员、卡种、类型、开始日期必填' });
    }
    const member = await query(`SELECT name FROM members WHERE id=$1`, [member_id]);
    if (member.rows.length === 0) return res.status(404).json({ error: '会员不存在' });

    const result = await withTransaction(async (tx) => {
      const n = await tx.query(`SELECT count(*)::int AS n FROM membership_cards`);
      const no = `VIP${new Date().getFullYear()}${String(n.rows[0].n + 1).padStart(3, '0')}`;
      const ins = await tx.query(
        `INSERT INTO membership_cards
         (member_id, card_no, plan_name, card_type, price, start_date, end_date, total_sessions, remaining, status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'active') RETURNING id`,
        [member_id, no, plan_name, card_type, price || 0, start_date,
          end_date || null, total_sessions || null, total_sessions || null]
      );
      await writeAudit(tx, {
        user: req.user, action: 'card_open', targetType: 'card', targetId: ins.rows[0].id,
        cardNo: no, memberId: member_id, amount: price || 0,
        detail: {
          member_name: member.rows[0].name, plan_name, card_type,
          price: Number(price) || 0, start_date, end_date: end_date || null,
          total_sessions: total_sessions || null,
        },
        req,
      });
      return { id: ins.rows[0].id, card_no: no };
    });
    await regenerateReminders().catch(() => {});
    res.status(201).json(result);
  } catch (e) { next(e); }
});

// 续费：期限卡延长 end_date；次卡增加 total_sessions/remaining（前台/店长）
router.post('/:id/renew', requirePerm('cards_renew'), async (req, res, next) => {
  try {
    const { amount, extend_days, add_sessions } = req.body;
    const cardRes = await query(`SELECT * FROM membership_cards WHERE id=$1`, [req.params.id]);
    if (cardRes.rows.length === 0) return res.status(404).json({ error: '卡不存在' });
    const card = cardRes.rows[0];
    let newEnd = card.end_date;
    let newTotal = card.total_sessions;
    let renewalId = null;

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
      } else {
        throw Object.assign(new Error('请填写有效的延长天数或增加次数'), { status: 400 });
      }
      const renewal = await tx.query(
        `INSERT INTO renewals(card_id, member_id, amount, new_end_date, added_sessions, operator, operator_id)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [card.id, card.member_id, amount || 0,
          card.card_type === 'period' ? newEnd : null,
          card.card_type === 'count' ? add_sessions : null,
          req.user.display_name, req.user.id]
      );
      renewalId = renewal.rows[0].id;
      // 续费后该卡的待处理提醒标记为已通知（会员已知晓）
      await tx.query(
        `UPDATE reminders SET status='notified' WHERE card_id=$1 AND status='pending'`,
        [card.id]
      );
      await writeAudit(tx, {
        user: req.user, action: 'card_renew', targetType: 'renewal', targetId: renewalId,
        cardNo: card.card_no, memberId: card.member_id, amount: amount || 0,
        detail: {
          card_id: card.id, plan_name: card.plan_name, amount: Number(amount) || 0,
          extend_days: card.card_type === 'period' ? Number(extend_days) : null,
          add_sessions: card.card_type === 'count' ? Number(add_sessions) : null,
          before: card.card_type === 'period'
            ? { end_date: card.end_date }
            : { total_sessions: card.total_sessions, remaining: card.remaining },
          after: card.card_type === 'period'
            ? { end_date: newEnd ? new Date(newEnd).toISOString().slice(0, 10) : null }
            : { total_sessions: newTotal, remaining: newTotal - (card.total_sessions - card.remaining) },
        },
        req,
      });
    });
    await regenerateReminders().catch(() => {});
    res.json({ ok: true, new_end_date: newEnd, new_total_sessions: newTotal });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// 改价（仅店长）：记录改动前后金额
router.put('/:id/price', requirePerm('cards_price'), async (req, res, next) => {
  try {
    const { price, reason } = req.body;
    const newPrice = Number(price);
    if (!(newPrice >= 0)) return res.status(400).json({ error: '请输入合法价格' });
    const cardRes = await query(`SELECT * FROM membership_cards WHERE id=$1`, [req.params.id]);
    if (cardRes.rows.length === 0) return res.status(404).json({ error: '卡不存在' });
    const card = cardRes.rows[0];
    if (Number(card.price) === newPrice) return res.status(400).json({ error: '新价格与原价相同' });

    await withTransaction(async (tx) => {
      await tx.query(`UPDATE membership_cards SET price=$2 WHERE id=$1`, [card.id, newPrice]);
      await writeAudit(tx, {
        user: req.user, action: 'card_price_change', targetType: 'card', targetId: card.id,
        cardNo: card.card_no, memberId: card.member_id, amount: newPrice,
        detail: {
          plan_name: card.plan_name,
          before: { price: Number(card.price) },
          after: { price: newPrice },
          reason: reason || null,
        },
        req,
      });
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 退款（仅店长）：支持金额退款，必要时可同时退还次卡次数（退次）
// 生成 refunds 业务单据并写审计；争议时可凭审计记录反查本单据
router.post('/:id/refund', requirePerm('refund'), async (req, res, next) => {
  try {
    const { amount, reason, sessions, booking_id } = req.body;
    const refundAmount = Number(amount) || 0;
    const refundSessions = Number(sessions) || 0;
    if (refundAmount < 0 || refundSessions < 0) return res.status(400).json({ error: '金额/次数不能为负' });
    if (refundAmount === 0 && refundSessions === 0) return res.status(400).json({ error: '退款金额和退还次数不能同时为 0' });
    if (!reason) return res.status(400).json({ error: '请填写退款/退次原因（纠纷留痕）' });

    const cardRes = await query(`SELECT * FROM membership_cards WHERE id=$1`, [req.params.id]);
    if (cardRes.rows.length === 0) return res.status(404).json({ error: '卡不存在' });
    const card = cardRes.rows[0];

    const result = await withTransaction(async (tx) => {
      let afterRemaining = card.remaining;
      if (refundSessions > 0) {
        if (card.card_type !== 'count' || card.total_sessions == null) {
          throw Object.assign(new Error('该卡不是次卡，无法退还次数'), { status: 400 });
        }
        const u = await tx.query(
          `UPDATE membership_cards
             SET remaining = LEAST(total_sessions, COALESCE(remaining,0) + $2),
                 status = CASE WHEN status IN ('used_up','expired') THEN 'active' ELSE status END
           WHERE id=$1 RETURNING remaining`,
          [card.id, refundSessions]
        );
        afterRemaining = u.rows[0].remaining;
      }
      const ins = await tx.query(
        `INSERT INTO refunds(card_id, member_id, booking_id, amount, reason, operator_id, operator_name)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id, refunded_at`,
        [card.id, card.member_id, booking_id || null, refundAmount, reason, req.user.id, req.user.display_name]
      );
      const baseDetail = {
        refund_id: ins.rows[0].id, card_id: card.id, plan_name: card.plan_name,
        reason, booking_id: booking_id || null,
      };
      if (refundAmount > 0) {
        await writeAudit(tx, {
          user: req.user, action: 'refund', targetType: 'refund', targetId: ins.rows[0].id,
          cardNo: card.card_no, memberId: card.member_id, amount: refundAmount,
          detail: baseDetail, req,
        });
      }
      if (refundSessions > 0) {
        await writeAudit(tx, {
          user: req.user, action: 'session_refund', targetType: 'refund', targetId: ins.rows[0].id,
          cardNo: card.card_no, memberId: card.member_id, amount: refundAmount || null,
          detail: {
            ...baseDetail,
            sessions: refundSessions,
            before: { remaining: card.remaining },
            after: { remaining: afterRemaining },
          },
          req,
        });
      }
      return { id: ins.rows[0].id, refunded_at: ins.rows[0].refunded_at, remaining: afterRemaining };
    });
    res.status(201).json({ ok: true, ...result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// 冻结 / 解冻（前台/店长）
router.post('/:id/freeze', requirePerm('cards_freeze'), async (req, res, next) => {
  try {
    const cardRes = await query(`SELECT * FROM membership_cards WHERE id=$1`, [req.params.id]);
    if (cardRes.rows.length === 0) return res.status(404).json({ error: '卡不存在' });
    const card = cardRes.rows[0];
    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE membership_cards SET status = CASE WHEN status='frozen' THEN 'active' ELSE 'frozen' END
         WHERE id=$1`, [req.params.id]
      );
      await writeAudit(tx, {
        user: req.user, action: 'card_freeze', targetType: 'card', targetId: card.id,
        cardNo: card.card_no, memberId: card.member_id,
        detail: {
          op: card.status === 'frozen' ? 'unfreeze' : 'freeze',
          before: { status: card.status },
          after: { status: card.status === 'frozen' ? 'active' : 'frozen' },
        },
        req,
      });
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 续费记录（前台/店长；operator_id 关联到账号）
router.get('/renewals/list', requirePerm('cards_view'), async (req, res, next) => {
  try {
    const r = await query(`
      SELECT r.*, m.name AS member_name, c.plan_name,
             u.display_name AS operator_account, u.role AS operator_role
      FROM renewals r
      JOIN members m ON m.id=r.member_id
      LEFT JOIN membership_cards c ON c.id=r.card_id
      LEFT JOIN users u ON u.id=r.operator_id
      ORDER BY r.renewed_at DESC LIMIT 100`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

export default router;
