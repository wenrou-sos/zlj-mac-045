import { Router } from 'express';
import { query } from '../db.js';
import { requireManager } from '../rbac.js';

const router = Router();

// 标签列表（附使用人数，所有人可用）
router.get('/', async (req, res, next) => {
  try {
    const r = await query(`
      SELECT t.*, count(mt.member_id)::int AS member_count
      FROM tags t
      LEFT JOIN member_tags mt ON mt.tag_id=t.id
      GROUP BY t.id
      ORDER BY t.id`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 新建标签（店长）
router.post('/', requireManager, async (req, res, next) => {
  try {
    const { name, color } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: '标签名称必填' });
    const r = await query(
      `INSERT INTO tags(name, color) VALUES($1,$2) RETURNING *`,
      [String(name).trim().slice(0, 30), color || '#4ea8fc']
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '标签已存在' });
    next(e);
  }
});

// 重命名 / 改色（店长）
router.put('/:id', requireManager, async (req, res, next) => {
  try {
    const { name, color } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: '标签名称必填' });
    const r = await query(
      `UPDATE tags SET name=$1, color=$2 WHERE id=$3 RETURNING *`,
      [String(name).trim().slice(0, 30), color || '#4ea8fc', req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: '标签不存在' });
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '标签已存在' });
    next(e);
  }
});

// 删除标签（店长，会员绑定随之解除）
router.delete('/:id', requireManager, async (req, res, next) => {
  try {
    const r = await query(`DELETE FROM tags WHERE id=$1`, [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: '标签不存在' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
