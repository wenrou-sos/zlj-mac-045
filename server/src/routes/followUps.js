import { Router } from 'express';
import { query } from '../db.js';
import { roleOf } from '../rbac.js';

const router = Router();

const OPEN = ['pending', 'contacted'];
const CLOSED = ['renewed', 'invalid'];
const ALL = [...OPEN, ...CLOSED];

// 跟进列表：默认只看待跟进；可按状态、会员筛选
router.get('/', async (req, res, next) => {
  try {
    const { status = 'pending', member_id, assignee } = req.query;
    const conds = [];
    const params = [];
    if (status && status !== 'all') {
      const list = status === 'open' ? OPEN : [status];
      if (!list.every((s) => ALL.includes(s))) return res.status(400).json({ error: '非法状态' });
      params.push(list);
      conds.push(`f.status = ANY($${params.length}::varchar[])`);
    }
    if (member_id) { params.push(Number(member_id)); conds.push(`f.member_id=$${params.length}`); }
    if (assignee) { params.push(assignee); conds.push(`f.assignee=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await query(`
      SELECT f.*, m.name AS member_name, m.phone, s.name AS segment_name
      FROM follow_ups f
      JOIN members m ON m.id=f.member_id
      LEFT JOIN segments s ON s.id=f.segment_id
      ${where}
      ORDER BY
        CASE f.status WHEN 'pending' THEN 0 WHEN 'contacted' THEN 1 ELSE 2 END,
        f.due_date NULLS LAST, f.id DESC
      LIMIT 500`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 待跟进数量（侧栏角标）
router.get('/counts', async (req, res, next) => {
  try {
    const r = await query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status='pending')::int AS pending,
        count(*) FILTER (WHERE status='contacted')::int AS contacted,
        count(*) FILTER (WHERE status='renewed')::int AS renewed,
        count(*) FILTER (WHERE status='invalid')::int AS invalid
      FROM follow_ups`);
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// 更新跟进状态（前台可标记已联系/已续费/无效；重新打开仅限店长）
router.post('/:id/status', async (req, res, next) => {
  try {
    const { status, result_note } = req.body;
    if (!ALL.includes(status)) return res.status(400).json({ error: '非法状态' });
    const role = roleOf(req);
    const cur = await query(`SELECT * FROM follow_ups WHERE id=$1`, [req.params.id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: '跟进事项不存在' });
    const wasClosed = CLOSED.includes(cur.rows[0].status);
    // 从已结束状态重新打开，仅店长可操作；前台正常推进（待跟进→已联系/已续费/无效）不受限
    if (OPEN.includes(status) && wasClosed && role !== 'manager') {
      return res.status(403).json({ error: '仅店长可重新打开已结束的跟进事项' });
    }
    const handler = req.body.handler || (role === 'manager' ? '店长' : '前台');
    await query(`
      UPDATE follow_ups SET
        status=$2::varchar,
        result_note=COALESCE($3::varchar, result_note),
        handler=$4::varchar,
        contacted_at=CASE WHEN $2='contacted' THEN COALESCE(contacted_at, now()) ELSE contacted_at END,
        closed_at=CASE WHEN $2 IN ('renewed','invalid') THEN COALESCE(closed_at, now())
                       WHEN $2 IN ('pending','contacted') THEN NULL ELSE closed_at END,
        auto_closed=CASE WHEN $2 IN ('pending','contacted') THEN false ELSE auto_closed END,
        closed_reason=CASE WHEN $2 IN ('pending','contacted') THEN NULL ELSE closed_reason END
      WHERE id=$1`,
      [req.params.id, status, result_note || null, handler]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '该会员已有其他未结束的跟进' });
    next(e);
  }
});

export default router;
