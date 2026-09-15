import { Router } from 'express';
import { query, withTransaction } from '../db.js';

const router = Router();

// 课程分类口径：
//  canceled        整节课取消               -> 不计费
//  leave_excluded  授课教练在请假时段内的课  -> 不计入该教练收入
//  no_show         课已结束但无会员核销到店  -> 不计费
//  substitute      已上且教练被改派过        -> 计入代课教练收入（按代课人费率）
//  normal          已上且由原教练授课        -> 计入正常授课收入
function classify(cls, leaves) {
  if (cls.status === 'canceled') return 'canceled';
  const onLeave = leaves.some((l) =>
    l.coach_id === cls.coach_id &&
    new Date(l.start_at) < new Date(cls.end_at) &&
    new Date(l.end_at) > new Date(cls.start_at));
  if (onLeave) return 'leave_excluded';
  if (Number(cls.checked_count) > 0) {
    return cls.original_coach_id && cls.original_coach_id !== cls.coach_id ? 'substitute' : 'normal';
  }
  return 'no_show';
}

// 结算批次列表
router.get('/', async (req, res, next) => {
  try {
    const r = await query(`
      SELECT b.*,
        (SELECT count(DISTINCT i.coach_id) FROM settlement_items i WHERE i.batch_id=b.id) AS coach_count
      FROM settlement_batches b ORDER BY b.period DESC`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 调整记录列表（注意：必须注册在 /:period 之前）
router.get('/adjustments/list', async (req, res, next) => {
  try {
    const r = await query(`
      SELECT a.*, c.name AS coach_name, cl.title AS class_title, cl.start_at AS class_start_at
      FROM settlement_adjustments a
      JOIN coaches c ON c.id = a.coach_id
      LEFT JOIN classes cl ON cl.id = a.class_id
      ORDER BY a.created_at DESC`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 新建调整记录：对锁定账期的更正，金额正=补发 / 负=扣减
// source_period 记录被更正的账期：它只会被更晚账期的结算单吸收（冲抵到下一期），不会被补出的历史账期吞掉
router.post('/adjustments', async (req, res, next) => {
  try {
    const { coach_id, reason } = req.body;
    const amount = Number(req.body.amount);
    const classId = req.body.class_id ? Number(req.body.class_id) : null;
    if (!coach_id) return res.status(400).json({ error: '请选择教练' });
    if (!amount) return res.status(400).json({ error: '调整金额不能为 0' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: '请填写调整原因' });
    let sourcePeriod = null;
    if (classId) {
      const cls = await query(`SELECT locked_period FROM classes WHERE id=$1`, [classId]);
      if (cls.rows.length === 0) return res.status(404).json({ error: '关联课程不存在' });
      if (!cls.rows[0].locked_period) {
        return res.status(409).json({ error: '该课程尚未结算锁定，可直接改派/取消，无需调整记录' });
      }
      sourcePeriod = cls.rows[0].locked_period;
    } else {
      // 不关联课程：归属当前最新已出账期（即冲抵到下一期）；还没有任何账单则可被首期吸收
      const latest = await query(`SELECT max(period) AS p FROM settlement_batches`);
      sourcePeriod = latest.rows[0].p || null;
    }
    const r = await query(
      `INSERT INTO settlement_adjustments(coach_id, class_id, amount, reason, source_period)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [coach_id, classId, amount, reason.trim(), sourcePeriod]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

// 某期结算单详情：批次 + 明细 + 按教练汇总
router.get('/:period', async (req, res, next) => {
  try {
    const batch = (await query(`SELECT * FROM settlement_batches WHERE period=$1`, [req.params.period])).rows[0];
    if (!batch) return res.status(404).json({ error: '该账期尚未生成结算单' });
    const items = (await query(`
      SELECT i.*, c.name AS coach_name, co.hourly_rate,
        cl.title, cl.start_at, cl.end_at, oc.name AS original_coach_name
      FROM settlement_items i
      LEFT JOIN coaches c ON c.id = i.coach_id
      LEFT JOIN classes cl ON cl.id = i.class_id
      LEFT JOIN coaches co ON co.id = i.coach_id
      LEFT JOIN coaches oc ON oc.id = cl.original_coach_id
      WHERE i.batch_id=$1
      ORDER BY i.coach_id NULLS LAST, cl.start_at NULLS LAST, i.id`, [batch.id])).rows;

    // 按教练汇总：正常/代课/取消/未到店/请假排除/调整 分开统计
    const summaryMap = new Map();
    for (const it of items) {
      const key = it.coach_id || 0;
      if (!summaryMap.has(key)) {
        summaryMap.set(key, {
          coach_id: it.coach_id, coach_name: it.coach_name || '未指派教练',
          normal: { count: 0, hours: 0, amount: 0 },
          substitute: { count: 0, hours: 0, amount: 0 },
          canceled: { count: 0 }, no_show: { count: 0 }, leave_excluded: { count: 0 },
          adjustment: 0, total: 0,
        });
      }
      const s = summaryMap.get(key);
      const hours = Number(it.hours), amount = Number(it.amount);
      if (it.category === 'normal' || it.category === 'substitute') {
        s[it.category].count += 1; s[it.category].hours += hours; s[it.category].amount += amount;
      } else if (it.category === 'adjustment') {
        s.adjustment += amount;
      } else {
        s[it.category].count += 1;
      }
      s.total += amount;
    }
    res.json({ batch, items, summary: [...summaryMap.values()] });
  } catch (e) { next(e); }
});

// 生成某月结算单：只把本账期内的课程入账并锁定（早期月份漏出的课请补出对应月份的账单）
router.post('/', async (req, res, next) => {
  try {
    const { period, operator } = req.body;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '')) {
      return res.status(400).json({ error: '账期格式应为 YYYY-MM' });
    }
    const [y, m] = period.split('-').map(Number);
    const startDate = `${period}-01`;
    const endDate = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

    // 只允许结算已完整结束的月份（次月 1 号到来之后才出单）
    const ended = await query(`SELECT ($1::date <= CURRENT_DATE) AS ok`, [endDate]);
    if (!ended.rows[0].ok) return res.status(400).json({ error: `${period} 尚未结束，不能生成结算单` });

    const dup = await query(`SELECT 1 FROM settlement_batches WHERE period=$1`, [period]);
    if (dup.rows.length > 0) return res.status(409).json({ error: `${period} 期结算单已生成，不能重复出单` });

    const result = await withTransaction(async (tx) => {
      const batch = (await tx.query(
        `INSERT INTO settlement_batches(period, start_date, end_date, operator) VALUES($1,$2,$3,$4) RETURNING *`,
        [period, startDate, endDate, operator || '前台']
      )).rows[0];

      // 结算范围：仅限本账期 [start_date, end_date) 内未锁定的课
      // （不吞其他月份的课——历史月份漏结算的，补出对应月份的账单即可，各期互不串账）
      const classes = (await tx.query(`
        SELECT cl.id, cl.title, cl.coach_id, cl.original_coach_id, cl.start_at, cl.end_at, cl.status,
          co.hourly_rate,
          (SELECT count(*) FROM bookings b WHERE b.class_id=cl.id AND b.status='checked') AS checked_count
        FROM classes cl
        LEFT JOIN coaches co ON co.id = cl.coach_id
        WHERE cl.locked_period IS NULL AND cl.start_at >= $1 AND cl.start_at < $2
        ORDER BY cl.start_at`, [startDate, endDate])).rows;

      const leaves = (await tx.query(
        `SELECT coach_id, start_at, end_at FROM coach_leaves WHERE status='active'`)).rows;

      let total = 0;
      for (const cls of classes) {
        const category = classify(cls, leaves);
        const hours = Math.round((new Date(cls.end_at) - new Date(cls.start_at)) / 36000) / 100;
        const billable = category === 'normal' || category === 'substitute';
        const amount = billable ? Math.round(hours * Number(cls.hourly_rate || 0) * 100) / 100 : 0;
        const note = {
          normal: `正常授课 · 费率 ¥${cls.hourly_rate}/h`,
          substitute: `代课 · 费率 ¥${cls.hourly_rate}/h`,
          canceled: '课程取消，不计费',
          no_show: '无会员核销到店，不计费',
          leave_excluded: '落在请假时段内，不计入该教练收入',
        }[category];
        await tx.query(
          `INSERT INTO settlement_items(batch_id, coach_id, class_id, category, hours, amount, note)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [batch.id, cls.coach_id, cls.id, category, hours, amount, note]
        );
        total += amount;
      }
      // 锁定本期课程（仅本账期，不影响其他月份）
      await tx.query(
        `UPDATE classes SET locked_period=$1 WHERE locked_period IS NULL AND start_at >= $2 AND start_at < $3`,
        [period, startDate, endDate]
      );

      // 并入待冲抵调整：只吸收「被更正账期早于本账期」的记录
      // （8 月的扣款只能进 9 月及以后的账单，不会被补出的 6/7 月账单吞掉）
      const adjustments = (await tx.query(
        `SELECT * FROM settlement_adjustments
         WHERE status='pending' AND (source_period IS NULL OR source_period < $1)
         ORDER BY id`, [period])).rows;
      for (const adj of adjustments) {
        await tx.query(
          `INSERT INTO settlement_items(batch_id, coach_id, class_id, category, hours, amount, note)
           VALUES($1,$2,$3,'adjustment',0,$4,$5)`,
          [batch.id, adj.coach_id, adj.class_id, adj.amount, `调整冲抵：${adj.reason}`]
        );
        await tx.query(
          `UPDATE settlement_adjustments SET status='applied', applied_period=$1 WHERE id=$2`,
          [period, adj.id]
        );
        total += Number(adj.amount);
      }

      const updated = (await tx.query(
        `UPDATE settlement_batches SET class_count=$2, total_amount=$3 WHERE id=$1 RETURNING *`,
        [batch.id, classes.length, Math.round(total * 100) / 100]
      )).rows[0];
      return { batch: updated, adjustments_applied: adjustments.length };
    });

    res.status(201).json(result);
  } catch (e) { next(e); }
});

export default router;
