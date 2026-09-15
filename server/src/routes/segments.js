import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { requireManager } from '../rbac.js';
import { refreshCardStatuses } from '../reminderLogic.js';
import {
  normalizeConditions, findMembers, countMembers,
} from '../segmentLogic.js';

const router = Router();

// 分群列表（含当前命中人数，双方可用）
router.get('/', async (req, res, next) => {
  try {
    await refreshCardStatuses();
    const r = await query(`SELECT * FROM segments ORDER BY id`);
    const list = [];
    for (const s of r.rows) {
      const count = await countMembers(s.conditions);
      list.push({ ...s, member_count: count });
    }
    res.json(list);
  } catch (e) { next(e); }
});

// 临时条件预览（不落库，仅店长用于建分群时调试）
router.post('/preview', requireManager, async (req, res, next) => {
  try {
    await refreshCardStatuses();
    const conditions = await normalizeConditions(req.body.conditions);
    const members = await findMembers(conditions, 500);
    res.json({ conditions, count: members.length, members });
  } catch (e) {
    if (/天数|次数|条件|标签/.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// 已保存分群的命中名单（前台可用）
router.get('/:id/members', async (req, res, next) => {
  try {
    await refreshCardStatuses();
    const s = await query(`SELECT * FROM segments WHERE id=$1`, [req.params.id]);
    if (s.rows.length === 0) return res.status(404).json({ error: '分群不存在' });
    const members = await findMembers(s.rows[0].conditions, 1000);
    res.json({ segment: s.rows[0], count: members.length, members });
  } catch (e) { next(e); }
});

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}
function fmtLastVisit(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('zh-CN');
}

// 导出命中名单 CSV（前台可导出名单用于电话回访）
router.get('/:id/export', async (req, res, next) => {
  try {
    await refreshCardStatuses();
    const s = await query(`SELECT * FROM segments WHERE id=$1`, [req.params.id]);
    if (s.rows.length === 0) return res.status(404).json({ error: '分群不存在' });
    const members = await findMembers(s.rows[0].conditions, 5000);
    const header = ['会员ID', '姓名', '性别', '手机号', '标签', '代表卡', '最近到店', '入会日期', '备注'];
    const lines = [header.map(csvCell).join(',')];
    for (const m of members) {
      const tags = (m.tags || []).map((t) => t.name).join('、');
      lines.push([
        m.id, m.name, m.gender, m.phone, tags,
        m.card_summary || '', fmtLastVisit(m.last_visit_at),
        m.joined_at ? new Date(m.joined_at).toLocaleDateString('zh-CN') : '',
        m.note || '',
      ].map(csvCell).join(','));
    }
    // BOM 让 Excel 正确识别 UTF-8 中文
    const csv = '﻿' + lines.join('\r\n');
    const filename = encodeURIComponent(`${s.rows[0].name}_会员名单.csv`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(csv);
  } catch (e) { next(e); }
});

router.post('/', requireManager, async (req, res, next) => {
  try {
    const { name, description, conditions } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: '分群名称必填' });
    const norm = await normalizeConditions(conditions);
    const r = await query(
      `INSERT INTO segments(name, description, conditions, created_by)
       VALUES($1,$2,$3,'店长') RETURNING *`,
      [String(name).trim().slice(0, 50), description || null, JSON.stringify(norm)]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '分群名称已存在' });
    if (/天数|次数|条件|标签/.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.put('/:id', requireManager, async (req, res, next) => {
  try {
    const { name, description, conditions } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: '分群名称必填' });
    const norm = await normalizeConditions(conditions);
    const r = await query(
      `UPDATE segments SET name=$1, description=$2, conditions=$3, updated_at=now()
       WHERE id=$4 RETURNING *`,
      [String(name).trim().slice(0, 50), description || null, JSON.stringify(norm), req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: '分群不存在' });
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '分群名称已存在' });
    if (/天数|次数|条件|标签/.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.delete('/:id', requireManager, async (req, res, next) => {
  try {
    const r = await query(`DELETE FROM segments WHERE id=$1`, [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: '分群不存在' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 一键把分群名单生成待跟进事项（仅店长；已有未结束跟进的会员自动跳过）
router.post('/:id/generate-followups', requireManager, async (req, res, next) => {
  try {
    await refreshCardStatuses();
    const s = await query(`SELECT * FROM segments WHERE id=$1`, [req.params.id]);
    if (s.rows.length === 0) return res.status(404).json({ error: '分群不存在' });
    const segment = s.rows[0];
    const { title, content, due_date, assignee } = req.body;
    const members = await findMembers(segment.conditions, 5000);

    const result = await withTransaction(async (tx) => {
      let created = 0;
      let skipped = 0;
      for (const m of members) {
        // 命中部分唯一索引（已有 pending/contacted 跟进）时 DO NOTHING，避免事务中断
        const ins = await tx.query(
          `INSERT INTO follow_ups(member_id, segment_id, title, content, due_date, assignee, creator)
           VALUES($1,$2,$3,$4,$5,$6,'店长')
           ON CONFLICT (member_id) WHERE status IN ('pending','contacted') DO NOTHING`,
          [m.id, segment.id,
           title || `【${segment.name}】回访跟进`,
           content || segment.description || null,
           due_date || null, assignee || '前台']
        );
        if (ins.rowCount > 0) created++;
        else skipped++;
      }
      return { created, skipped };
    });
    res.status(201).json({ ok: true, matched: members.length, ...result });
  } catch (e) { next(e); }
});

export default router;
