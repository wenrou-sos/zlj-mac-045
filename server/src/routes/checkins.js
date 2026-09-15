import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { refreshCardStatuses, regenerateReminders } from '../reminderLogic.js';

const router = Router();

// 今日待核销列表
router.get('/today', async (req, res, next) => {
  try {
    const r = await query(`
      SELECT b.id, b.verify_code, b.status, b.booked_at, b.checked_at,
        m.name AS member_name, m.phone,
        cl.title, cl.start_at, cl.end_at, v.name AS venue_name,
        c.card_no, c.plan_name
      FROM bookings b
      JOIN members m ON m.id=b.member_id
      JOIN classes cl ON cl.id=b.class_id
      LEFT JOIN venues v ON v.id=cl.venue_id
      LEFT JOIN membership_cards c ON c.id=b.card_id
      WHERE cl.start_at >= date_trunc('day', now()) - INTERVAL '2 hours'
        AND cl.start_at < date_trunc('day', now()) + INTERVAL '1 day'
      ORDER BY cl.start_at`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 到店核销：核销码
router.post('/verify', async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: '请输入核销码' });

    // 事务外先刷新卡状态
    await refreshCardStatuses();

    const result = await withTransaction(async (tx) => {
      const list = await tx.query(`
        SELECT b.*, m.name AS member_name, m.phone,
          cl.title, cl.start_at, cl.end_at, cl.status AS class_status,
          v.name AS venue_name,
          c.plan_name, c.status AS card_status, c.end_date, c.remaining, c.card_type
        FROM bookings b
        JOIN members m ON m.id=b.member_id
        JOIN classes cl ON cl.id=b.class_id
        LEFT JOIN venues v ON v.id=cl.venue_id
        LEFT JOIN membership_cards c ON c.id=b.card_id
        WHERE b.verify_code=$1`, [String(code).trim()]);
      const b = list.rows[0];
      if (!b) throw Object.assign(new Error('核销码无效'), { status: 404 });
      if (b.status === 'checked') throw Object.assign(new Error('该预约已核销，请勿重复核销'), { status: 409 });
      if (b.status === 'canceled') throw Object.assign(new Error('该预约已取消'), { status: 409 });
      if (b.class_status === 'canceled') throw Object.assign(new Error('课程已取消'), { status: 409 });

      // 卡有效性二次校验
      if (!b.card_id || !['active'].includes(b.card_status)) {
        throw Object.assign(new Error('会员卡状态异常，请前台处理'), { status: 409 });
      }
      if (b.card_type === 'period' && b.end_date && new Date(b.end_date) < new Date(Date.now() - 86400e3)) {
        throw Object.assign(new Error('会员卡已过期'), { status: 409 });
      }

      const diffH = Math.abs(new Date(b.start_at) - Date.now()) / 3600e3;
      if (diffH > 2) throw Object.assign(new Error('未到核销时间（开课前 2 小时内可核销）'), { status: 409 });

      await tx.query(`UPDATE bookings SET status='checked', checked_at=now() WHERE id=$1`, [b.id]);
      // 候补转正者核销即视为已确认，候补记录闭环（防止逾期扫描重复处理）
      await tx.query(
        `UPDATE waitlists SET status='confirmed', confirmed_at=now(),
         result_note='到店核销，自动确认候补转正'
         WHERE booking_id=$1 AND status='promoted'`,
        [b.id]
      );
      return {
        booking_id: b.id,
        member_name: b.member_name,
        title: b.title,
        venue_name: b.venue_name,
        start_at: b.start_at,
        plan_name: b.plan_name,
      };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// 手动核销（管理端按预约 id）
router.post('/:id/check', async (req, res, next) => {
  try {
    await withTransaction(async (tx) => {
      const b = (await tx.query(`SELECT * FROM bookings WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!b) throw Object.assign(new Error('预约不存在'), { status: 404 });
      if (b.status === 'checked') throw Object.assign(new Error('已核销'), { status: 409 });
      if (b.status === 'canceled') throw Object.assign(new Error('已取消'), { status: 409 });
      await tx.query(`UPDATE bookings SET status='checked', checked_at=now() WHERE id=$1`, [b.id]);
      // 候补转正者核销即视为已确认，候补记录闭环（防止逾期扫描重复处理）
      await tx.query(
        `UPDATE waitlists SET status='confirmed', confirmed_at=now(),
         result_note='到店核销，自动确认候补转正'
         WHERE booking_id=$1 AND status='promoted'`,
        [b.id]
      );
    });
    await regenerateReminders();
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

export default router;
