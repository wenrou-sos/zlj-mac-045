import { Router } from 'express';
import { query } from '../db.js';
import { venueAvailabilityBlock } from '../venueAvailability.js';
import { cancelClassWithRefunds, moveClass } from '../classOps.js';

const router = Router();

// 课表列表：?from=ISO&to=ISO
router.get('/', async (req, res, next) => {
  try {
    const from = req.query.from || new Date(Date.now() - 7 * 86400e3).toISOString();
    const to = req.query.to || new Date(Date.now() + 14 * 86400e3).toISOString();
    const r = await query(`
      SELECT cl.*, co.name AS coach_name, v.name AS venue_name,
        (SELECT count(*) FROM bookings b WHERE b.class_id=cl.id
          AND b.status IN ('booked','checked')) AS booked_count,
        (SELECT count(*) FROM bookings b WHERE b.class_id=cl.id AND b.status='checked') AS checked_count,
        (SELECT count(*) FROM waitlists w WHERE w.class_id=cl.id AND w.status='waiting') AS waitlist_count
      FROM classes cl
      LEFT JOIN coaches co ON co.id=cl.coach_id
      LEFT JOIN venues v ON v.id=cl.venue_id
      WHERE cl.start_at >= $1 AND cl.start_at <= $2
      ORDER BY cl.start_at`, [from, to]);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 单个槽位的排课前校验；通过返回 null，否则返回可直接展示的原因
async function slotBlockReason({ venue, venue_id, coach_id, capacity, start_at, end_at }) {
  if (venue_id) {
    if (venue.status === 'closed') return `场地「${venue.name}」已停用`;
    if (capacity > venue.capacity) return `容量超过该场地上限 ${venue.capacity} 人`;
    const block = await venueAvailabilityBlock(venue_id, start_at, end_at);
    if (block) return block.reason;
    const vc = await query(`
      SELECT 1 FROM classes WHERE venue_id=$1 AND status='open'
        AND start_at < $3 AND end_at > $2`, [venue_id, start_at, end_at]);
    if (vc.rows.length > 0) return '该场地此时段已有课程';
  }
  if (coach_id) {
    const cc = await query(`
      SELECT 1 FROM classes WHERE coach_id=$1 AND status='open'
        AND start_at < $3 AND end_at > $2`, [coach_id, start_at, end_at]);
    if (cc.rows.length > 0) return '该教练此时段已有其他课程';
  }
  return null;
}

// 排课：校验场地时间冲突、教练课程冲突、容量上限、场地可用性（停用/一次性闭馆/每周闭馆）
router.post('/', async (req, res, next) => {
  try {
    const { title, start_at, end_at } = req.body;
    const coach_id = req.body.coach_id ? Number(req.body.coach_id) : null;
    const venue_id = req.body.venue_id ? Number(req.body.venue_id) : null;
    const capacity = Number(req.body.capacity) || 10;
    const cost_sessions = Number(req.body.cost_sessions) || 1;
    if (!title || !start_at || !end_at) return res.status(400).json({ error: '课程名和时间必填' });
    if (new Date(end_at) <= new Date(start_at)) return res.status(400).json({ error: '结束时间必须晚于开始时间' });

    let venue = null;
    if (venue_id) {
      const vr = await query(`SELECT name, capacity, status FROM venues WHERE id=$1`, [venue_id]);
      if (vr.rows.length === 0) return res.status(404).json({ error: '场地不存在' });
      venue = vr.rows[0];
    }
    const reason = await slotBlockReason({ venue, venue_id, coach_id, capacity, start_at, end_at });
    if (reason) return res.status(409).json({ error: `该时段不可排课：${reason}` });

    const r = await query(
      `INSERT INTO classes(title, coach_id, venue_id, start_at, end_at, capacity, cost_sessions)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title, coach_id, venue_id, start_at, end_at, capacity, cost_sessions]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

// 批量生成课表：按「每周哪几天 + 开始时间 + 日期区间」展开，逐槽位校验，
// 能排的排、不能排的跳过并给出原因（场地不可用 / 冲突等）
router.post('/batch', async (req, res, next) => {
  try {
    const { title, start_time, from, to } = req.body;
    const duration = Number(req.body.duration_hours) || 1;
    const coach_id = req.body.coach_id ? Number(req.body.coach_id) : null;
    const venue_id = req.body.venue_id ? Number(req.body.venue_id) : null;
    const capacity = Number(req.body.capacity) || 10;
    const cost_sessions = Number(req.body.cost_sessions) || 1;
    const weekdays = [...new Set((req.body.weekdays || []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (!title || !start_time || !from || !to || weekdays.length === 0) {
      return res.status(400).json({ error: '课程名、日期区间、每周星期和开始时间必填' });
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start_time)) return res.status(400).json({ error: '开始时间格式应为 HH:MM' });
    if (duration <= 0 || duration > 6) return res.status(400).json({ error: '时长应在 0.5~6 小时之间' });
    if (to < from) return res.status(400).json({ error: '结束日期不能早于开始日期' });
    if ((new Date(to) - new Date(from)) / 86400e3 > 62) return res.status(400).json({ error: '单次最多生成 62 天，请分批操作' });

    let venue = null;
    if (venue_id) {
      const vr = await query(`SELECT name, capacity, status FROM venues WHERE id=$1`, [venue_id]);
      if (vr.rows.length === 0) return res.status(404).json({ error: '场地不存在' });
      venue = vr.rows[0];
    }

    // 按业务时区展开槽位（date + time 按会话时区解释为本地墙上时间）
    const wdPlaceholders = weekdays.map((_, i) => `$${5 + i}`).join(',');
    const slots = await query(`
      SELECT (d.day::date + $3::time)::timestamptz AS start_at,
             (d.day::date + $3::time)::timestamptz + ($4::double precision * interval '1 hour') AS end_at
      FROM generate_series($1::date, $2::date, interval '1 day') d(day)
      WHERE EXTRACT(DOW FROM d.day)::int IN (${wdPlaceholders})
      ORDER BY 1`, [from, to, start_time, duration, ...weekdays]);

    const items = [];
    for (const s of slots.rows) {
      const reason = await slotBlockReason({
        venue, venue_id, coach_id, capacity,
        start_at: s.start_at, end_at: s.end_at,
      });
      if (reason) {
        items.push({ start_at: s.start_at, end_at: s.end_at, status: 'skipped', reason });
        continue;
      }
      const ins = await query(
        `INSERT INTO classes(title, coach_id, venue_id, start_at, end_at, capacity, cost_sessions)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [title, coach_id, venue_id, s.start_at, s.end_at, capacity, cost_sessions]
      );
      items.push({ start_at: s.start_at, end_at: s.end_at, status: 'created', class_id: ins.rows[0].id });
    }
    res.json({
      ok: true,
      created: items.filter((i) => i.status === 'created').length,
      skipped: items.filter((i) => i.status === 'skipped').length,
      items,
    });
  } catch (e) { next(e); }
});

// 课程改期（校验场地/教练冲突与场地可用性）
router.post('/:id/move', async (req, res, next) => {
  try {
    await moveClass(query, Number(req.params.id), req.body.start_at, req.body.end_at);
    const r = await query(`SELECT * FROM classes WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, class: r.rows[0] });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// 取消课程（已有的未来预约一并取消并退次，候补队列关闭）
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const cls = await query(`SELECT * FROM classes WHERE id=$1`, [req.params.id]);
    if (cls.rows.length === 0) return res.status(404).json({ error: '课程不存在' });
    if (new Date(cls.rows[0].start_at) < new Date()) {
      return res.status(400).json({ error: '已开始的课程不能取消' });
    }
    const affected = await cancelClassWithRefunds(query, req.params.id, req.body.reason || '课程取消');
    res.json({ ok: true, affected });
  } catch (e) { next(e); }
});

export default router;
