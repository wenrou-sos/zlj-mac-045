import { Router } from 'express';
import { query } from '../db.js';
import { requireManager, roleOf } from '../rbac.js';

const router = Router();

// 会员列表（支持姓名/手机号搜索、标签筛选）
router.get('/', async (req, res, next) => {
  try {
    const kw = req.query.keyword ? `%${req.query.keyword}%` : '%';
    const params = [kw];
    let tagJoin = '';
    let tagWhere = '';
    if (req.query.tag_id) {
      params.push(Number(req.query.tag_id));
      tagJoin = `JOIN member_tags qmt ON qmt.member_id=m.id AND qmt.tag_id=$${params.length}`;
    }
    if (req.query.no_card === '1') {
      tagWhere += ` AND NOT EXISTS (SELECT 1 FROM membership_cards c WHERE c.member_id=m.id)`;
    }
    const r = await query(`
      SELECT m.*,
        (SELECT count(*) FROM membership_cards c WHERE c.member_id=m.id) AS card_count,
        (SELECT string_agg(c.card_no, ', ') FROM membership_cards c WHERE c.member_id=m.id) AS card_nos,
        COALESCE((
          SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.id)
          FILTER (WHERE t.id IS NOT NULL)
          FROM member_tags mt JOIN tags t ON t.id=mt.tag_id
          WHERE mt.member_id=m.id
        ), '[]'::json) AS tags
      FROM members m
      ${tagJoin}
      WHERE (m.name ILIKE $1 OR m.phone ILIKE $1)${tagWhere}
      ORDER BY m.id DESC`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 会员详情：含会员卡、最近预约、标签、历次跟进
router.get('/:id', async (req, res, next) => {
  try {
    const m = await query(`SELECT * FROM members WHERE id=$1`, [req.params.id]);
    if (m.rows.length === 0) return res.status(404).json({ error: '会员不存在' });
    const cards = await query(
      `SELECT * FROM membership_cards WHERE member_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    const bookings = await query(`
      SELECT b.*, c.title, c.start_at, c.end_at, v.name AS venue_name
      FROM bookings b
      JOIN classes c ON c.id=b.class_id
      LEFT JOIN venues v ON v.id=c.venue_id
      WHERE b.member_id=$1
      ORDER BY c.start_at DESC
      LIMIT 20`, [req.params.id]);
    const tags = await query(`
      SELECT t.* FROM tags t
      JOIN member_tags mt ON mt.tag_id=t.id
      WHERE mt.member_id=$1 ORDER BY t.id`, [req.params.id]);
    const followUps = await query(`
      SELECT f.*, s.name AS segment_name
      FROM follow_ups f
      LEFT JOIN segments s ON s.id=f.segment_id
      WHERE f.member_id=$1
      ORDER BY f.created_at DESC LIMIT 50`, [req.params.id]);
    res.json({
      ...m.rows[0],
      cards: cards.rows,
      recentBookings: bookings.rows,
      tags: tags.rows,
      followUps: followUps.rows,
    });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, phone, gender, note, tag_ids } = req.body;
    if (!name || !phone) return res.status(400).json({ error: '姓名和手机号必填' });
    const memberId = await query(
      `INSERT INTO members(name, phone, gender, note) VALUES($1,$2,$3,$4) RETURNING id`,
      [name, phone, gender || '未知', note || null]
    ).then((r) => r.rows[0].id);
    if (Array.isArray(tag_ids) && roleOf(req) === 'manager') {
      for (const tid of tag_ids) {
        await query(`INSERT INTO member_tags(member_id, tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
          [memberId, Number(tid)]);
      }
    }
    const r = await query(`SELECT * FROM members WHERE id=$1`, [memberId]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '手机号已存在' });
    next(e);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { name, phone, gender, note } = req.body;
    const r = await query(
      `UPDATE members SET name=$1, phone=$2, gender=$3, note=$4 WHERE id=$5 RETURNING *`,
      [name, phone, gender, note, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// 会员打标签（全量覆盖，仅店长）
router.put('/:id/tags', requireManager, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.tag_ids)
      ? [...new Set(req.body.tag_ids.map(Number).filter(Number.isInteger))]
      : [];
    await query(`DELETE FROM member_tags WHERE member_id=$1`, [req.params.id]);
    for (const tid of ids) {
      await query(
        `INSERT INTO member_tags(member_id, tag_id) VALUES($1,$2)
         ON CONFLICT DO NOTHING`,
        [req.params.id, tid]
      );
    }
    const r = await query(`
      SELECT t.* FROM tags t
      JOIN member_tags mt ON mt.tag_id=t.id
      WHERE mt.member_id=$1 ORDER BY t.id`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 给单个会员手工创建跟进（仅店长）
router.post('/:id/follow-ups', requireManager, async (req, res, next) => {
  try {
    const { title, content, due_date, assignee } = req.body;
    if (!title || !String(title).trim()) return res.status(400).json({ error: '跟进标题必填' });
    const exists = await query(
      `SELECT 1 FROM members WHERE id=$1`, [req.params.id]
    );
    if (exists.rows.length === 0) return res.status(404).json({ error: '会员不存在' });
    try {
      const r = await query(`
        INSERT INTO follow_ups(member_id, title, content, due_date, assignee, creator)
        VALUES($1,$2,$3,$4,$5,'店长') RETURNING *`,
        [req.params.id, String(title).trim().slice(0, 100), content || null,
         due_date || null, assignee || '前台']);
      res.status(201).json(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: '该会员已有未结束的跟进，请先处理现有事项' });
      throw e;
    }
  } catch (e) { next(e); }
});

export default router;
