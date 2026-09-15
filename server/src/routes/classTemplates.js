// 周课模板：模板维护 + 选连续几周批量生成 + 批次撤回
import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { checkClassFeasible, cancelClassWithRefunds } from '../classLogic.js';

const router = Router();
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const APP_TZ = process.env.APP_TZ || 'Asia/Shanghai';

// 按业务时区取当天 YYYY-MM-DD（业务日期一律按墙上日历，避免 UTC 服务器跨天）
function todayInTz() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
// date 字段在不同驱动下可能是 Date / 字符串，统一成 YYYY-MM-DD
function dayText(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

// 模板公共校验
function validateTemplate(body) {
  const title = (body.title || '').trim();
  const weekday = Number(body.weekday);
  const start_time = body.start_time || '';
  const duration_minutes = Number(body.duration_minutes) || 60;
  const capacity = Number(body.capacity);
  const cost_sessions = Number(body.cost_sessions) || 1;
  const coach_id = body.coach_id ? Number(body.coach_id) : null;
  const venue_id = body.venue_id ? Number(body.venue_id) : null;

  if (!title) return { error: '课程名称必填' };
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { error: '星期取值为 0~6（0=周日）' };
  if (!TIME_RE.test(start_time)) return { error: '开课时间格式应为 HH:MM' };
  if (!Number.isInteger(duration_minutes) || duration_minutes < 15 || duration_minutes > 600) {
    return { error: '时长需在 15~600 分钟之间' };
  }
  if (!Number.isInteger(capacity) || capacity <= 0) return { error: '容量必须为正整数' };
  if (![1, 2, 3, 4, 5].includes(cost_sessions)) return { error: '消耗课次需在 1~5 之间' };
  return { value: { title, weekday, start_time, duration_minutes, capacity, cost_sessions, coach_id, venue_id } };
}

// 模板列表（?status=active 可只看启用中的）
router.get('/', async (req, res, next) => {
  try {
    const where = req.query.status ? `WHERE t.status=$1` : '';
    const params = req.query.status ? [req.query.status] : [];
    const r = await query(`
      SELECT t.*, co.name AS coach_name, v.name AS venue_name,
        (SELECT count(*) FROM classes c WHERE c.template_id=t.id AND c.status <> 'canceled') AS generated_count
      FROM class_templates t
      LEFT JOIN coaches co ON co.id=t.coach_id
      LEFT JOIN venues v ON v.id=t.venue_id
      ${where}
      ORDER BY t.weekday, t.start_time, t.id`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const v = validateTemplate(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const { title, weekday, start_time, duration_minutes, capacity, cost_sessions, coach_id, venue_id } = v.value;
    if (venue_id) {
      const venue = (await query(`SELECT capacity FROM venues WHERE id=$1`, [venue_id])).rows[0];
      if (!venue) return res.status(404).json({ error: '场地不存在' });
      if (capacity > venue.capacity) return res.status(409).json({ error: `容量超过该场地上限 ${venue.capacity} 人` });
    }
    if (coach_id) {
      const coach = await query(`SELECT 1 FROM coaches WHERE id=$1`, [coach_id]);
      if (coach.rows.length === 0) return res.status(404).json({ error: '教练不存在' });
    }
    const r = await query(
      `INSERT INTO class_templates(title, weekday, start_time, duration_minutes, coach_id, venue_id, capacity, cost_sessions)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [title, weekday, start_time, duration_minutes, coach_id, venue_id, capacity, cost_sessions]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const exists = await query(`SELECT id FROM class_templates WHERE id=$1`, [req.params.id]);
    if (exists.rows.length === 0) return res.status(404).json({ error: '模板不存在' });
    const v = validateTemplate(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const { title, weekday, start_time, duration_minutes, capacity, cost_sessions, coach_id, venue_id } = v.value;
    const status = ['active', 'inactive'].includes(req.body.status) ? req.body.status : 'active';
    if (venue_id) {
      const venue = (await query(`SELECT capacity FROM venues WHERE id=$1`, [venue_id])).rows[0];
      if (!venue) return res.status(404).json({ error: '场地不存在' });
      if (capacity > venue.capacity) return res.status(409).json({ error: `容量超过该场地上限 ${venue.capacity} 人` });
    }
    const r = await query(
      `UPDATE class_templates SET title=$1, weekday=$2, start_time=$3, duration_minutes=$4,
         coach_id=$5, venue_id=$6, capacity=$7, cost_sessions=$8, status=$9
       WHERE id=$10 RETURNING *`,
      [title, weekday, start_time, duration_minutes, coach_id, venue_id, capacity, cost_sessions, status, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// 删除模板：若仍有由它生成且未取消的课，先停用模板而不是删除，避免课失去来源
router.delete('/:id', async (req, res, next) => {
  try {
    const t = await query(`SELECT * FROM class_templates WHERE id=$1`, [req.params.id]);
    if (t.rows.length === 0) return res.status(404).json({ error: '模板不存在' });
    const used = await query(
      `SELECT 1 FROM classes WHERE template_id=$1 AND status <> 'canceled' LIMIT 1`,
      [req.params.id]
    );
    if (used.rows.length > 0) {
      await query(`UPDATE class_templates SET status='inactive' WHERE id=$1`, [req.params.id]);
      return res.status(409).json({
        error: '该模板已有生成的课程，不能直接删除，已将其停用；如需删除请先撤回相关课程',
        deactivated: true,
      });
    }
    await query(`DELETE FROM class_templates WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 批量生成：POST /generate { week_start?, weeks, template_ids? }
// - week_start 为该周任意日期，自动归一到周一；默认本周
// - 同一模板同一周重复生成：已有课只报告“已存在”，仅补排缺失的课
// - 教练冲突 / 场地冲突 / 场地全天关闭 / 场地不可用时段 / 容量超限 / 已过期 一律跳过并记录原因
router.post('/generate', async (req, res, next) => {
  try {
    const weeks = Number(req.body.weeks);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) {
      return res.status(400).json({ error: '生成周数需在 1~12 之间' });
    }
    const anchorDate = req.body.week_start || todayInTz();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) return res.status(400).json({ error: 'week_start 需为 YYYY-MM-DD' });

    const now = new Date();
    const result = await withTransaction(async (tx) => {
      // 归一到周一（PG date_trunc('week')）
      const norm = await tx.query(`SELECT date_trunc('week', $1::date)::date AS ws`, [anchorDate]);
      const weekStart = norm.rows[0].ws; // date 类型，参数化后形如 YYYY-MM-DD
      const weekEnd = (await tx.query(`SELECT ($1::date + interval '6 days')::date AS we`, [weekStart])).rows[0].we;

      let templates;
      if (Array.isArray(req.body.template_ids) && req.body.template_ids.length > 0) {
        const ids = [...new Set(req.body.template_ids.map(Number).filter(Number.isInteger))];
        const r = await tx.query(`SELECT * FROM class_templates WHERE id = ANY($1::int[]) ORDER BY weekday, start_time`, [ids]);
        if (r.rows.length !== ids.length) throw Object.assign(new Error('部分模板不存在'), { status: 404 });
        templates = r.rows;
      } else {
        templates = (await tx.query(`SELECT * FROM class_templates WHERE status='active' ORDER BY weekday, start_time`)).rows;
      }
      if (templates.length === 0) throw Object.assign(new Error('没有可用于生成的周课模板'), { status: 400 });

      const created = [];
      const existing = [];
      const skipped = [];

      // 先登记批次，生成的课要关联到它
      const batchIns = await tx.query(
        `INSERT INTO class_generation_batches(week_start, week_end, weeks)
         VALUES($1,$2,$3) RETURNING *`,
        [weekStart, weekEnd, weeks]
      );
      const batchId = batchIns.rows[0].id;

      for (let w = 0; w < weeks; w++) {
        for (const tpl of templates) {
          const dayOffset = w * 7 + ((Number(tpl.weekday) + 6) % 7); // 周一=0 ... 周日=6
          // 所有时间按数据库会话业务时区的墙上时钟计算（本地 19:00 就是 19:00）
          const ts = await tx.query(
            `SELECT
               ($1::date + make_interval(days => $2))::date::text AS class_date,
               ($1::date + make_interval(days => $2) + $3::time) AT TIME ZONE current_setting('TimeZone') AS start_at,
               ($1::date + make_interval(days => $2) + $3::time + make_interval(mins => $4)) AT TIME ZONE current_setting('TimeZone') AS end_at`,
            [weekStart, dayOffset, tpl.start_time, tpl.duration_minutes]
          );
          const { class_date, start_at, end_at } = ts.rows[0];
          const base = {
            template_id: tpl.id, template_title: tpl.title,
            weekday: WEEKDAY_CN[tpl.weekday], date: class_date, time: tpl.start_time,
          };

          // 幂等：同模板同一时刻已有未取消的课 → 不排第二套，只报告已存在
          const dup = await tx.query(
            `SELECT id FROM classes
             WHERE template_id=$1 AND start_at=$2 AND status <> 'canceled' LIMIT 1`,
            [tpl.id, start_at]
          );
          if (dup.rows.length > 0) {
            existing.push({ ...base, class_id: dup.rows[0].id });
            continue;
          }

          // 已过去的时段不再补排
          if (new Date(start_at) < now) {
            skipped.push({ ...base, code: 'past', reason: `${class_date} ${WEEKDAY_CN[tpl.weekday]} ${tpl.start_time} 已过期，不再补排` });
            continue;
          }

          const check = await checkClassFeasible({
            coach_id: tpl.coach_id, venue_id: tpl.venue_id,
            capacity: tpl.capacity, start_at, end_at,
          }, tx);
          if (!check.ok) {
            skipped.push({ ...base, code: check.code, reason: `「${tpl.title}」${class_date} ${WEEKDAY_CN[tpl.weekday]} ${tpl.start_time}：${check.reason}` });
            continue;
          }

          let cls;
          try {
            cls = (await tx.query(
              `INSERT INTO classes(title, coach_id, venue_id, start_at, end_at, capacity,
                 cost_sessions, template_id, generation_batch_id)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
              [tpl.title, tpl.coach_id, tpl.venue_id, start_at, end_at,
                tpl.capacity, tpl.cost_sessions, tpl.id, batchId]
            )).rows[0];
          } catch (e) {
            // 数据库级幂等索引兜底（并发/同刻重复）
            if (e.code === '23505') {
              existing.push(base);
              continue;
            }
            throw e;
          }
          created.push({ ...base, class_id: cls.id });
        }
      }

      const summary = { created: created.length, existing: existing.length, skipped: skipped.length };
      await tx.query(
        `UPDATE class_generation_batches
         SET created_count=$2, existing_count=$3, skipped_count=$4, result_json=$5::jsonb
         WHERE id=$1`,
        [batchId, summary.created, summary.existing, summary.skipped,
          JSON.stringify({ created, existing, skipped })]
      );

      return {
        batch_id: batchId, week_start: dayText(weekStart), week_end: dayText(weekEnd), weeks,
        ...summary, created, existing, skipped,
      };
    });
    res.status(201).json(result);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// 批次列表（含批次下仍有效的课程数）
router.get('/batches', async (req, res, next) => {
  try {
    const r = await query(`
      SELECT b.id, to_char(b.week_start,'YYYY-MM-DD') AS week_start,
        to_char(b.week_end,'YYYY-MM-DD') AS week_end, b.weeks,
        b.created_count, b.existing_count, b.skipped_count, b.result_json,
        b.status, b.created_at, b.revoked_at,
        (SELECT count(*) FROM classes c
           WHERE c.generation_batch_id=b.id AND c.status <> 'canceled') AS active_classes
      FROM class_generation_batches b
      ORDER BY b.id DESC LIMIT 100`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 批次明细：批次信息 + 本批生成的课
router.get('/batches/:id', async (req, res, next) => {
  try {
    const batch = (await query(
      `SELECT id, to_char(week_start,'YYYY-MM-DD') AS week_start,
         to_char(week_end,'YYYY-MM-DD') AS week_end, weeks,
         created_count, existing_count, skipped_count, result_json,
         status, created_at, revoked_at
       FROM class_generation_batches WHERE id=$1`, [req.params.id]
    )).rows[0];
    if (!batch) return res.status(404).json({ error: '批次不存在' });
    const classes = await query(`
      SELECT c.id, c.title, c.start_at, c.end_at, c.status, c.capacity, c.cost_sessions,
             co.name AS coach_name, v.name AS venue_name,
             (SELECT count(*) FROM bookings bk WHERE bk.class_id=c.id
               AND bk.status IN ('booked','checked')) AS booked_count
      FROM classes c
      LEFT JOIN coaches co ON co.id=c.coach_id
      LEFT JOIN venues v ON v.id=c.venue_id
      WHERE c.generation_batch_id=$1
      ORDER BY c.start_at`, [req.params.id]);
    res.json({ ...batch, classes: classes.rows });
  } catch (e) { next(e); }
});

// 整批撤回：把本批生成的、尚未开始的课全部取消，已预约学员一并取消并退次；
// 已开始/已结束的课不能撤，列入 skipped 说明
router.post('/batches/:id/revoke', async (req, res, next) => {
  try {
    const reason = req.body.reason || '周课模板批次撤回';
    const result = await withTransaction(async (tx) => {
      const batch = (await tx.query(`SELECT * FROM class_generation_batches WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!batch) throw Object.assign(new Error('批次不存在'), { status: 404 });
      if (batch.status === 'revoked') throw Object.assign(new Error('该批次已撤回，请勿重复操作'), { status: 409 });

      const classRows = (await tx.query(
        `SELECT id, title, start_at FROM classes
         WHERE generation_batch_id=$1 AND status <> 'canceled'
         ORDER BY start_at FOR UPDATE`,
        [req.params.id]
      )).rows;

      const now = new Date();
      const canceled = [];
      const skipped = [];
      let affectedBookings = 0;
      let refundedSessions = 0;

      for (const c of classRows) {
        if (new Date(c.start_at) < now) {
          skipped.push({ class_id: c.id, title: c.title, start_at: c.start_at, reason: '课程已开始或已结束，不能撤回' });
          continue;
        }
        await tx.query(`UPDATE classes SET status='canceled' WHERE id=$1`, [c.id]);
        const r = await cancelClassWithRefunds(tx, c.id, `${reason}（批次 #${batch.id}）`);
        affectedBookings += r.affected;
        refundedSessions += r.refunded_sessions;
        canceled.push({ class_id: c.id, title: c.title, start_at: c.start_at, ...r });
      }

      if (canceled.length === 0) {
        throw Object.assign(new Error('批次内没有可撤回的未来课程（可能已开始或已取消）'), { status: 400 });
      }

      await tx.query(`UPDATE class_generation_batches SET status='revoked', revoked_at=now() WHERE id=$1`, [batch.id]);
      return {
        batch_id: batch.id,
        canceled_count: canceled.length,
        affected_bookings: affectedBookings,
        refunded_sessions: refundedSessions,
        canceled,
        skipped,
      };
    });
    res.json(result);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

export default router;
