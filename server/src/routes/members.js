import { Router } from 'express';
import { query } from '../db.js';
import { requirePerm } from '../auth.js';

const router = Router();

// 会员列表（支持姓名/手机号搜索）—— 店长/前台
router.get('/', requirePerm('members_view'), async (req, res, next) => {
  try {
    const kw = req.query.keyword ? `%${req.query.keyword}%` : '%';
    const r = await query(`
      SELECT m.*,
        (SELECT count(*) FROM membership_cards c WHERE c.member_id=m.id) AS card_count,
        (SELECT string_agg(c.card_no, ', ') FROM membership_cards c WHERE c.member_id=m.id) AS card_nos
      FROM members m
      WHERE m.name ILIKE $1 OR m.phone ILIKE $1
      ORDER BY m.id DESC`, [kw]);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 会员详情：含会员卡
router.get('/:id', requirePerm('members_view'), async (req, res, next) => {
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
    res.json({ ...m.rows[0], cards: cards.rows, recentBookings: bookings.rows });
  } catch (e) { next(e); }
});

router.post('/', requirePerm('members_write'), async (req, res, next) => {
  try {
    const { name, phone, gender, note } = req.body;
    if (!name || !phone) return res.status(400).json({ error: '姓名和手机号必填' });
    const r = await query(
      `INSERT INTO members(name, phone, gender, note) VALUES($1,$2,$3,$4) RETURNING *`,
      [name, phone, gender || '未知', note || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '手机号已存在' });
    next(e);
  }
});

router.put('/:id', requirePerm('members_write'), async (req, res, next) => {
  try {
    const { name, phone, gender, note } = req.body;
    const r = await query(
      `UPDATE members SET name=$1, phone=$2, gender=$3, note=$4 WHERE id=$5 RETURNING *`,
      [name, phone, gender, note, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

export default router;
