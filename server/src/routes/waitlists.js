import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { fillWaitlist, expireWaitlists } from '../waitlistLogic.js';

const router = Router();

// 候补列表（支持课程 / 会员 / 状态过滤；排队中条目实时计算队首顺序）
router.get('/', async (req, res, next) => {
  try {
    await expireWaitlists();
    const { status, class_id, member_id } = req.query;
    const conds = [];
    const params = [];
    if (status) { params.push(status); conds.push(`w.status=$${params.length}`); }
    if (class_id) { params.push(class_id); conds.push(`w.class_id=$${params.length}`); }
    if (member_id) { params.push(member_id); conds.push(`w.member_id=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await query(`
      SELECT w.*, m.name AS member_name, m.phone,
        cl.title, cl.start_at, cl.end_at, cl.capacity, cl.cost_sessions, cl.status AS class_status,
        v.name AS venue_name, co.name AS coach_name,
        c.card_no, c.plan_name,
        b.verify_code,
        CASE WHEN w.status='waiting' THEN
          ROW_NUMBER() OVER (PARTITION BY w.class_id,
            CASE WHEN w.status='waiting' THEN 0 ELSE 1 END
            ORDER BY CASE WHEN w.status='waiting' THEN w.joined_at END)
        ELSE NULL END AS queue_position,
        (SELECT count(*) FROM waitlists q WHERE q.class_id=w.class_id AND q.status='waiting') AS waiting_count
      FROM waitlists w
      JOIN members m ON m.id=w.member_id
      JOIN classes cl ON cl.id=w.class_id
      LEFT JOIN venues v ON v.id=cl.venue_id
      LEFT JOIN coaches co ON co.id=cl.coach_id
      LEFT JOIN membership_cards c ON c.id=w.card_id
      LEFT JOIN bookings b ON b.id=w.booking_id
      ${where}
      ORDER BY cl.start_at DESC, w.joined_at, w.id DESC
      LIMIT 500`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 加入候补队列（仅满员课程可加入；开课 15 分钟后不再接受候补）
router.post('/', async (req, res, next) => {
  try {
    const { class_id, member_id } = req.body;
    if (!class_id || !member_id) return res.status(400).json({ error: '课程和会员必填' });

    const result = await withTransaction(async (tx) => {
      const cls = (await tx.query(`SELECT * FROM classes WHERE id=$1 FOR UPDATE`, [class_id])).rows[0];
      if (!cls) throw Object.assign(new Error('课程不存在'), { status: 404 });
      if (cls.status !== 'open') throw Object.assign(new Error('该课程未开放预约'), { status: 409 });
      if (new Date(cls.start_at) <= new Date()) throw Object.assign(new Error('课程已开始，无法候补'), { status: 409 });

      // 已有有效预约
      const dup = await tx.query(
        `SELECT 1 FROM bookings WHERE class_id=$1 AND member_id=$2 AND status IN ('booked','checked')`,
        [class_id, member_id]
      );
      if (dup.rows.length > 0) throw Object.assign(new Error('您已预约该课程，无需候补'), { status: 409 });

      // 已有进行中候补（排队中 / 已递补待确认）
      const dupWait = await tx.query(
        `SELECT 1 FROM waitlists WHERE class_id=$1 AND member_id=$2 AND status IN ('waiting','promoted')`,
        [class_id, member_id]
      );
      if (dupWait.rows.length > 0) throw Object.assign(new Error('您已在该课程候补队列中'), { status: 409 });

      const booked = (await tx.query(
        `SELECT count(*)::int n FROM bookings WHERE class_id=$1 AND status IN ('booked','checked')`,
        [class_id]
      )).rows[0].n;
      if (booked < cls.capacity) throw Object.assign(new Error('课程仍有名额，请直接预约'), { status: 409 });

      const position = (await tx.query(
        `SELECT count(*)::int n FROM waitlists WHERE class_id=$1 AND status='waiting'`,
        [class_id]
      )).rows[0].n + 1;

      const ins = await tx.query(
        `INSERT INTO waitlists(class_id, member_id) VALUES($1,$2) RETURNING *`,
        [class_id, member_id]
      );
      return { ...ins.rows[0], queue_position: position };
    });
    res.status(201).json(result);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (e.code === '23505') return res.status(409).json({ error: '您已在该课程候补队列中' });
    next(e);
  }
});

// 会员确认候补转正结果（在截止时间前确认）
router.post('/:id/confirm', async (req, res, next) => {
  try {
    const result = await withTransaction(async (tx) => {
      const w = (await tx.query(`SELECT * FROM waitlists WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!w) throw Object.assign(new Error('候补记录不存在'), { status: 404 });
      if (w.status === 'confirmed') throw Object.assign(new Error('已确认，无需重复操作'), { status: 409 });
      if (w.status !== 'promoted') throw Object.assign(new Error('当前状态不可确认'), { status: 409 });
      if (new Date(w.confirm_deadline) <= new Date()) {
        throw Object.assign(new Error('已超过确认截止时间'), { status: 409 });
      }

      // 确认时二次校验预约与会员卡仍有效（防止确认期间卡被冻结等）
      const b = (await tx.query(`
        SELECT b.*, c.status AS card_status, c.end_date, c.remaining, c.card_type
        FROM bookings b LEFT JOIN membership_cards c ON c.id=b.card_id
        WHERE b.id=$1`, [w.booking_id])).rows[0];
      if (!b || b.status !== 'booked') throw Object.assign(new Error('预约状态异常，请联系前台'), { status: 409 });
      if (!b.card_id || b.card_status !== 'active') {
        throw Object.assign(new Error('会员卡状态异常，请联系前台处理'), { status: 409 });
      }

      await tx.query(
        `UPDATE waitlists SET status='confirmed', confirmed_at=now(),
         result_note='已确认候补转正预约' WHERE id=$1`,
        [w.id]
      );
      return { booking_id: b.id, verify_code: b.verify_code, deadline: w.confirm_deadline };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// 会员主动放弃候补（排队中可直接退出；已递补待确认则取消预约并退次，名额继续递补下一位）
router.post('/:id/abandon', async (req, res, next) => {
  try {
    let refilledClass = null;
    const result = await withTransaction(async (tx) => {
      const w = (await tx.query(`
        SELECT w.*, cl.cost_sessions, cl.start_at
        FROM waitlists w JOIN classes cl ON cl.id=w.class_id
        WHERE w.id=$1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!w) throw Object.assign(new Error('候补记录不存在'), { status: 404 });
      const wasPromoted = w.status === 'promoted';
      if (!['waiting', 'promoted'].includes(w.status)) {
        throw Object.assign(new Error('候补已结束，无法放弃'), { status: 409 });
      }

      let refund = 0;
      if (wasPromoted && w.booking_id) {
        const b = (await tx.query(`SELECT * FROM bookings WHERE id=$1 FOR UPDATE`, [w.booking_id])).rows[0];
        if (b && b.status === 'booked') {
          await tx.query(
            `UPDATE bookings SET status='canceled', canceled_at=now(),
             cancel_reason=$2 WHERE id=$1`,
            [b.id, req.body.reason || '会员放弃候补转正名额']
          );
          if (b.card_id) {
            await tx.query(
              `UPDATE membership_cards SET remaining = LEAST(COALESCE(remaining,0) + $2, total_sessions)
               WHERE id=$1 AND remaining IS NOT NULL`,
              [b.card_id, w.cost_sessions]
            );
            refund = w.cost_sessions;
          }
        }
        refilledClass = w.class_id;
      }

      await tx.query(
        `UPDATE waitlists SET status='abandoned', closed_at=now(), abandon_reason=$2,
         result_note=$3 WHERE id=$1`,
        [w.id, req.body.reason || '会员主动放弃',
         wasPromoted ? `放弃转正名额（已退还 ${refund} 次）` : '主动退出候补队列']
      );

      // 放弃的是已转正名额：同事务内把空名额继续递补给队列下一位
      if (refilledClass) await fillWaitlist(tx, refilledClass);
      return { refund_sessions: refund };
    });

    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// 立即执行一次过期扫描（运维/测试用）
router.post('/sweep', async (req, res, next) => {
  try {
    const r = await expireWaitlists();
    res.json({ ok: true, ...r });
  } catch (e) { next(e); }
});

// 测试专用：把一条「待确认」候补的截止时间立即拨到过去，用于验证逾期自动放弃
if (process.env.NODE_ENV !== 'production') {
  router.post('/:id/dev-expire', async (req, res, next) => {
    try {
      await query(`UPDATE waitlists SET confirm_deadline = now() - INTERVAL '1 minute'
                   WHERE id=$1 AND status='promoted'`, [req.params.id]);
      const r = await expireWaitlists();
      res.json({ ok: true, ...r });
    } catch (e) { next(e); }
  });
}

export default router;
