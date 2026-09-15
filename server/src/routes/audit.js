import { Router } from 'express';
import { query } from '../db.js';
import { authenticate, requirePerm, writeAudit, AUDIT_ACTIONS, ROLE_TEXT } from '../auth.js';

const router = Router();
router.use(authenticate);

// 审计日志查询：按操作员 / 动作类型 / 日期区间 / 卡号或会员名检索（仅店长）
router.get('/logs', requirePerm('audit_view'), async (req, res, next) => {
  try {
    const { actor_id, action, date, from, to, keyword } = req.query;
    const conds = [];
    const params = [];
    if (actor_id) { params.push(Number(actor_id)); conds.push(`a.actor_id=$${params.length}`); }
    if (action) { params.push(action); conds.push(`a.action=$${params.length}`); }
    if (date) { params.push(date); conds.push(`a.created_at::date = $${params.length}::date`); }
    if (from) { params.push(from); conds.push(`a.created_at::date >= $${params.length}::date`); }
    if (to) { params.push(to); conds.push(`a.created_at::date <= $${params.length}::date`); }
    if (keyword) {
      params.push(`%${keyword}%`);
      conds.push(`(a.card_no ILIKE $${params.length} OR m.name ILIKE $${params.length}
                  OR a.target_id::text ILIKE $${params.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await query(`
      SELECT a.*, u.username AS actor_username, m.name AS member_name, m.phone AS member_phone
      FROM audit_logs a
      LEFT JOIN users u ON u.id=a.actor_id
      LEFT JOIN members m ON m.id=a.member_id
      ${where}
      ORDER BY a.id DESC LIMIT 500`, params);
    res.json(r.rows.map((row) => ({ ...row, action_text: AUDIT_ACTIONS[row.action] || row.action })));
  } catch (e) { next(e); }
});

// 操作员列表（筛选下拉用，复用 audit_view 权限）
router.get('/actors', requirePerm('audit_view'), async (req, res, next) => {
  try {
    const r = await query(`
      SELECT DISTINCT u.id, u.display_name, u.username, u.role
      FROM audit_logs a JOIN users u ON u.id=a.actor_id
      ORDER BY u.id`);
    res.json(r.rows.map((u) => ({ ...u, role_text: ROLE_TEXT[u.role] })));
  } catch (e) { next(e); }
});

// 按业务单据反查：给定 target_type+target_id 或卡号，返回该对象的全部审计轨迹
router.get('/trace', requirePerm('audit_view'), async (req, res, next) => {
  try {
    const { target_type, target_id, card_no } = req.query;
    const conds = [];
    const params = [];
    if (target_type && target_id) {
      params.push(target_type, target_id);
      conds.push(`((a.target_type=$${params.length - 1} AND a.target_id=$${params.length})
                  OR a.card_no IN (SELECT card_no FROM audit_logs
                    WHERE target_type=$${params.length - 1} AND target_id=$${params.length} AND card_no IS NOT NULL))`);
    }
    if (card_no) { params.push(card_no); conds.push(`a.card_no=$${params.length}`); }
    if (conds.length === 0) return res.status(400).json({ error: '请提供业务单据或卡号' });
    const r = await query(`
      SELECT a.*, u.username AS actor_username, m.name AS member_name
      FROM audit_logs a
      LEFT JOIN users u ON u.id=a.actor_id
      LEFT JOIN members m ON m.id=a.member_id
      WHERE ${conds.join(' OR ')}
      ORDER BY a.id`, params);
    res.json(r.rows.map((row) => ({ ...row, action_text: AUDIT_ACTIONS[row.action] || row.action })));
  } catch (e) { next(e); }
});

// 对账汇总（仅店长）：区间内开卡/续费收款、退款、核销、退次汇总
router.get('/report', requirePerm('reports_view'), async (req, res, next) => {
  try {
    const from = req.query.from;
    const to = req.query.to;
    if (!from || !to) return res.status(400).json({ error: '请选择起止日期' });
    const r = await query(`
      SELECT a.action,
             count(*)::int AS cnt,
             COALESCE(sum(a.amount),0)::float AS amount,
             u.display_name AS operator_name, u.id AS operator_id
      FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
      WHERE a.created_at::date BETWEEN $1::date AND $2::date
        AND a.action IN ('card_open','card_renew','refund')
      GROUP BY a.action, u.display_name, u.id
      ORDER BY u.id NULLS LAST, a.action`, [from, to]);

    const opStats = await query(`
      SELECT u.id, u.display_name,
             count(*) FILTER (WHERE a.action='checkin')::int AS checkins,
             count(*) FILTER (WHERE a.action='session_refund')::int AS session_refunds,
             count(*) FILTER (WHERE a.action='class_cancel')::int AS class_cancels,
             count(*) FILTER (WHERE a.action='card_open')::int AS card_opens,
             count(*) FILTER (WHERE a.action='card_renew')::int AS card_renews
      FROM users u LEFT JOIN audit_logs a
        ON a.actor_id=u.id AND a.created_at::date BETWEEN $1::date AND $2::date
      GROUP BY u.id, u.display_name ORDER BY u.id`, [from, to]);

    const income = r.rows.filter((x) => x.action !== 'refund').reduce((s, x) => s + Number(x.amount), 0);
    const refunded = r.rows.filter((x) => x.action === 'refund').reduce((s, x) => s + Number(x.amount), 0);
    res.json({ from, to, income, refunded, net: income - refunded, byAction: r.rows, byOperator: opStats.rows });
  } catch (e) { next(e); }
});

// 导出对账单 CSV（仅店长，且导出动作本身写审计）
router.get('/report/export', requirePerm('reports_export'), async (req, res, next) => {
  try {
    const from = req.query.from;
    const to = req.query.to;
    if (!from || !to) return res.status(400).json({ error: '请选择起止日期' });
    const r = await query(`
      SELECT a.id, to_char(a.created_at,'YYYY-MM-DD HH24:MI:SS') AS at,
             a.action, a.actor_name, a.card_no, m.name AS member_name,
             COALESCE(a.amount,0)::float AS amount, a.target_type, a.target_id,
             a.detail
      FROM audit_logs a LEFT JOIN members m ON m.id=a.member_id
      WHERE a.created_at::date BETWEEN $1::date AND $2::date
        AND a.action IN ('card_open','card_renew','refund','session_refund',
                         'class_cancel','card_price_change','checkin')
      ORDER BY a.id`, [from, to]);

    const rows = r.rows;
    const header = ['ID', '时间', '动作', '操作员', '卡号', '会员', '金额(元)', '单据类型', '单据ID', '关键信息'];
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    for (const x of rows) {
      let note = '';
      try {
        const d = typeof x.detail === 'string' ? JSON.parse(x.detail) : x.detail;
        note = d?.reason || d?.sessions != null ? `退/加次:${d.sessions ?? ''} ${d.reason || ''}`.trim() : '';
      } catch { note = ''; }
      lines.push([
        x.id, x.at, AUDIT_ACTIONS[x.action] || x.action, x.actor_name,
        x.card_no || '', x.member_name || '', x.amount,
        x.target_type || '', x.target_id || '', note,
      ].map(esc).join(','));
    }
    // 加 UTF-8 BOM，Excel 打开中文不乱码
    const csv = '﻿' + lines.join('\r\n');

    await writeAudit(query, {
      user: req.user, action: 'report_export', targetType: 'report',
      targetId: `${from}_${to}`, amount: null,
      detail: { from, to, rows: rows.length }, req,
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="reconciliation_${from}_${to}.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
});

export default router;
