import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { refreshCardStatuses } from '../reminderLogic.js';
import { venueAvailabilityBlock } from '../venueAvailability.js';
import { promoteWaitlist } from '../waitlistLogic.js';

const router = Router();

// 候补列表：?class_id= &member_id=
router.get('/', async (req, res, next) => {
  try {
    const { class_id, member_id } = req.query;
    const conds = [];
    const params = [];
    if (class_id) { params.push(class_id); conds.push(`w.class_id=$${params.length}`); }
    if (member_id) { params.push(member_id); conds.push(`w.member_id=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await query(`
      SELECT w.*, m.name AS member_name, m.phone,
        cl.title, cl.start_at, cl.capacity, v.name AS venue_name
      FROM waitlists w
      JOIN members m ON m.id=w.member_id
      JOIN classes cl ON cl.id=w.class_id
      LEFT JOIN venues v ON v.id=cl.venue_id
      ${where}
      ORDER BY w.status='waiting' DESC, w.created_at`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 加入候补（仅满员课程；场地已不可用的课程不允许排队）
router.post('/', async (req, res, next) => {
  try {
    const { class_id, member_id } = req.body;
    if (!class_id || !member_id) return res.status(400).json({ error: '课程和会员必填' });

    await refreshCardStatuses();

    const result = await withTransaction(async (tx) => {
      const tq = (text, params) => tx.query(text, params);
      const cls = (await tx.query(`SELECT * FROM classes WHERE id=$1 FOR UPDATE`, [class_id])).rows[0];
      if (!cls) throw Object.assign(new Error('课程不存在'), { status: 404 });
      if (cls.status !== 'open') throw Object.assign(new Error('该课程未开放'), { status: 409 });
      if (new Date(cls.start_at) < new Date()) throw Object.assign(new Error('课程已开始，无法候补'), { status: 409 });

      const dup = await tx.query(
        `SELECT 1 FROM bookings WHERE class_id=$1 AND member_id=$2 AND status IN ('booked','checked')`,
        [class_id, member_id]
      );
      if (dup.rows.length > 0) throw Object.assign(new Error('已预约该课程，无需候补'), { status: 409 });

      const booked = (await tx.query(
        `SELECT count(*)::int n FROM bookings WHERE class_id=$1 AND status IN ('booked','checked')`,
        [class_id]
      )).rows[0].n;
      if (booked < cls.capacity) throw Object.assign(new Error('课程未满员，可直接预约'), { status: 409 });

      // 场地已不可用的课程排了也补不上，直接拦截并说明原因
      if (cls.venue_id) {
        const block = await venueAvailabilityBlock(cls.venue_id, cls.start_at, cls.end_at, tq);
        if (block) throw Object.assign(new Error(`该时段场地不可用：${block.reason}，暂不能候补`), { status: 409 });
      }

      const ins = await tx.query(
        `INSERT INTO waitlists(class_id, member_id) VALUES($1,$2) RETURNING *`,
        [class_id, member_id]
      );
      return ins.rows[0];
    });
    res.status(201).json(result);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '已在该课程的候补队列中' });
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// 手动触发递补（有空位但尚未自动补上时使用，例如场地恢复开放后）
router.post('/promote', async (req, res, next) => {
  try {
    const { class_id } = req.body;
    if (!class_id) return res.status(400).json({ error: '课程必填' });
    await refreshCardStatuses();
    const promotion = await withTransaction((tx) =>
      promoteWaitlist((text, params) => tx.query(text, params), Number(class_id))
    );
    if (!promotion) return res.json({ ok: true, promoted: null, note: '当前没有可递补的空位' });
    res.json({ ok: true, ...promotion });
  } catch (e) { next(e); }
});

// 取消候补（仅排队中的可取消）
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const r = await query(
      `UPDATE waitlists SET status='canceled', resolved_at=now(), note='会员取消候补'
       WHERE id=$1 AND status='waiting' RETURNING id`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(409).json({ error: '该候补不在排队状态，无法取消' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
