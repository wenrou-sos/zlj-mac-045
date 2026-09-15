// 统一经营指标层（Single Source of Truth）
// 工作台 /dashboard 与经营报表 /reports 都只能通过本模块取数，保证同一时间段数字一致。
//
// 统计口径 v1（页面「统计口径」面板与本文件一一对应，改动规则必须在 caliber_versions 发新版本）：
//  1. 上座率 = 核销人次 / 有效预约人次；有效预约 = 已核销 + 未到店（两种都真实占座）。
//  2. 满员率 = 满员课节数 / 实际开课课节数；满员课 = 有效预约人次 ≥ 课程容量。
//  3. 座位利用率 = 有效预约人次 / 开课座位总数（开课座位 = 实际开课课节 × 各课容量）。
//  4. 整课取消：不计入开课、不进分母，单列「取消课节」；其下预约一律不算有效预约（系统已退次）。
//  5. 会员取消预约（含临期不退次）：不占座、不算上座率，单列「取消预约」。
//  6. 未到店：占座、计入有效预约（分母），但不计核销（分子），单列为失约。
//  7. 新增会员：joined_at 落在区间内；流失会员：当日首次满足「无任何有效卡
//     且最近一次到店/开卡/续费 ≥ 30 天」，续费或重开卡自动取消流失标记（lost_at 置空）。
//  8. 卡销量：按开卡 created_at 统计新办卡张数与金额（price）；续费金额按 renewals.renewed_at。
//  9. 退款：独立退款流水，按 refunded_at 统计；净收入 = 新开卡金额 + 续费金额 − 退款金额。
// 10. 时间归属一律按业务时区（APP_TZ，默认 Asia/Shanghai）的日历日；当天数据实时算，
//     已结束日期走日级汇总表；结束超过 3 天的历史周/月由结账快照冻结，口径升级不改旧数。
import { query } from './db.js';

export const CALIBER_VERSION = 1;
export const CHURN_DAYS = 30;

// 初次启动登记 v1 口径（TRUNCATE 只清业务表，不清口径表）
export async function ensureCaliber() {
  const r = await query(`SELECT count(*)::int n FROM caliber_versions`);
  if (r.rows[0].n === 0) {
    await query(`INSERT INTO caliber_versions(version, note) VALUES ($1, $2)`, [
      CALIBER_VERSION,
      '上座率=核销/(核销+未到店)；满员率=满员课/实际开课；取消课不进分母；未到店占座；'
      + `流失=无有效卡且 ${CHURN_DAYS} 天无活动；净收入=新开卡+续费−退款（按业务时区日历日）`,
    ]);
  }
}

// 结束后自动完结：过去的开放课 -> finished；过去未核销/未取消的预约 -> no_show
// 这样「未到店」有唯一、确定的来源，不依赖人工清点
export async function closePastClasses() {
  await query(`
    UPDATE classes SET status='finished'
    WHERE status='open' AND end_at < now()`);
  await query(`
    UPDATE bookings b SET status='no_show'
    FROM classes c
    WHERE b.class_id = c.id
      AND b.status = 'booked'
      AND c.end_at < now()`);
}

// 会员生命周期巡检：last_active_at = 最近(到店核销, 开卡, 续费)；
// 满足流失条件首次落戳 lost_at；一旦有新卡/续费/核销立即回流（lost_at=NULL）
export async function refreshMemberLifecycle() {
  await query(`
    UPDATE members m SET last_active_at = GREATEST(
      COALESCE(m.joined_at, CURRENT_DATE),
      (SELECT max(checked_at)::date FROM bookings b
        JOIN classes c ON c.id=b.class_id WHERE b.member_id=m.id AND b.status='checked'),
      (SELECT max(created_at)::date FROM membership_cards WHERE member_id=m.id),
      (SELECT max(renewed_at)::date FROM renewals WHERE member_id=m.id)
    )`);

  // 有任何有效卡，或最近 CHURN_DAYS 天内有活动 → 在册（非流失）
  await query(`
    UPDATE members m SET lost_at = NULL
    WHERE m.lost_at IS NOT NULL
      AND (
        EXISTS (SELECT 1 FROM membership_cards c
                 WHERE c.member_id=m.id AND c.status='active'
                   AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE))
        OR m.last_active_at >= CURRENT_DATE - $1 * INTERVAL '1 day'
      )`, [CHURN_DAYS]);

  // 无有效卡且长期无活动 → 首次进入流失（以今天为流失日；回算时只可能是今天，保证不被反复改写）
  await query(`
    UPDATE members m SET lost_at = CURRENT_DATE
    WHERE m.lost_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM membership_cards c
                       WHERE c.member_id=m.id AND c.status='active'
                         AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE))
      AND m.last_active_at < CURRENT_DATE - $1 * INTERVAL '1 day'`, [CHURN_DAYS]);
}

export async function runMaintenance() {
  await closePastClasses();
  await refreshMemberLifecycle();
}

// ---- 课程/预约维度的公共聚合（按课粒度，再上卷），range 均为闭区间日期 ----
// 有效预约：已核销 + 未到店（已结束课）+ 已预约（当天尚未结束的课，预约本身占座，
// 结束后 booked 会被 closePastClasses 自动转成 no_show/checked，历史日因此不含 booked）
// startPh/endPh 为日期下界/上界在整条参数化 SQL 中的占位符名（$1、$2 …）
function classPerCTE(startPh = '$1', endPh = '$2') {
  return `
    per_class AS (
      SELECT c.id, c.start_at::date AS day, c.status, c.title,
             c.venue_id, COALESCE(v.name, '未分配场地') AS venue_name,
             c.capacity,
             count(b.id) FILTER (WHERE b.status IN ('booked','checked','no_show')) AS eff,
             count(b.id) FILTER (WHERE b.status='checked')                        AS ck,
             count(b.id) FILTER (WHERE b.status='no_show')                        AS ns,
             count(b.id) FILTER (WHERE b.status='canceled' AND c.status<>'canceled') AS cb
      FROM classes c
      LEFT JOIN bookings b ON b.class_id = c.id
      LEFT JOIN venues v ON v.id = c.venue_id
      WHERE c.start_at::date >= ${startPh} AND c.start_at::date <= ${endPh}
      GROUP BY c.id, v.name
    )`;
}

// 增量刷新日级汇总（只刷已结束日期），周/月查询只扫汇总表，不随数据量线性变慢
export async function refreshDailyRollups(from, to) {
  if (!from || !to || from > to) return;
  const today = await currentDate();
  const histLast = addDaysISO(today, -1);
  if (from > histLast) return; // 区间全部落在今天/未来，没有可结账的日期
  const rangeEnd = to < histLast ? to : histLast;

  await query(`
    WITH ${classPerCTE()},
    cls AS (
      SELECT day,
        count(*) FILTER (WHERE status <> 'canceled') AS classes_scheduled,
        count(*) FILTER (WHERE status = 'canceled')  AS classes_canceled,
        COALESCE(sum(capacity) FILTER (WHERE status <> 'canceled'), 0) AS seats_total,
        COALESCE(sum(eff), 0) AS seats_effective,
        COALESCE(sum(ck), 0)  AS checkins,
        COALESCE(sum(ns), 0)  AS no_shows,
        COALESCE(sum(cb), 0)  AS canceled_bookings,
        count(*) FILTER (WHERE status <> 'canceled' AND eff >= capacity) AS full_classes
      FROM per_class GROUP BY day
    ),
    sales AS (
      SELECT created_at::date AS day, count(*) AS n, COALESCE(sum(price),0) AS amt
      FROM membership_cards
      WHERE created_at::date >= $1 AND created_at::date <= $2 GROUP BY 1
    ),
    ren AS (
      SELECT renewed_at::date AS day, count(*) AS n, COALESCE(sum(amount),0) AS amt
      FROM renewals
      WHERE renewed_at::date >= $1 AND renewed_at::date <= $2 GROUP BY 1
    ),
    ref AS (
      SELECT refunded_at::date AS day,
        count(*) FILTER (WHERE source_type='card')    AS cn,
        COALESCE(sum(amount) FILTER (WHERE source_type='card'),0)    AS ca,
        count(*) FILTER (WHERE source_type='renewal') AS rn,
        COALESCE(sum(amount) FILTER (WHERE source_type='renewal'),0) AS ra
      FROM refunds
      WHERE refunded_at::date >= $1 AND refunded_at::date <= $2 GROUP BY 1
    ),
    nm AS (SELECT joined_at AS day, count(*) n FROM members
      WHERE joined_at >= $1 AND joined_at <= $2 GROUP BY 1),
    lm AS (SELECT lost_at AS day, count(*) n FROM members
      WHERE lost_at >= $1 AND lost_at <= $2 GROUP BY 1)
    INSERT INTO daily_metrics AS d (
      day, classes_scheduled, classes_canceled, seats_total, seats_effective,
      checkins, no_shows, canceled_bookings, full_classes,
      new_members, lost_members,
      card_sales_count, card_sales_amount, card_refund_count, card_refund_amount,
      renewal_count, renewal_amount, renewal_refund_count, renewal_refund_amount)
    SELECT g.day,
      COALESCE(cls.classes_scheduled,0), COALESCE(cls.classes_canceled,0),
      COALESCE(cls.seats_total,0), COALESCE(cls.seats_effective,0),
      COALESCE(cls.checkins,0), COALESCE(cls.no_shows,0), COALESCE(cls.canceled_bookings,0),
      COALESCE(cls.full_classes,0),
      COALESCE(nm.n,0), COALESCE(lm.n,0),
      COALESCE(sales.n,0), COALESCE(sales.amt,0), COALESCE(ref.cn,0), COALESCE(ref.ca,0),
      COALESCE(ren.n,0), COALESCE(ren.amt,0), COALESCE(ref.rn,0), COALESCE(ref.ra,0)
    FROM generate_series($1::date, $3::date, INTERVAL '1 day') g(day)
    LEFT JOIN cls ON cls.day = g.day
    LEFT JOIN sales ON sales.day = g.day
    LEFT JOIN ren ON ren.day = g.day
    LEFT JOIN ref ON ref.day = g.day
    LEFT JOIN nm ON nm.day = g.day
    LEFT JOIN lm ON lm.day = g.day
    ON CONFLICT (day) DO UPDATE SET
      classes_scheduled=EXCLUDED.classes_scheduled, classes_canceled=EXCLUDED.classes_canceled,
      seats_total=EXCLUDED.seats_total, seats_effective=EXCLUDED.seats_effective,
      checkins=EXCLUDED.checkins, no_shows=EXCLUDED.no_shows,
      canceled_bookings=EXCLUDED.canceled_bookings, full_classes=EXCLUDED.full_classes,
      new_members=EXCLUDED.new_members, lost_members=EXCLUDED.lost_members,
      card_sales_count=EXCLUDED.card_sales_count, card_sales_amount=EXCLUDED.card_sales_amount,
      card_refund_count=EXCLUDED.card_refund_count, card_refund_amount=EXCLUDED.card_refund_amount,
      renewal_count=EXCLUDED.renewal_count, renewal_amount=EXCLUDED.renewal_amount,
      renewal_refund_count=EXCLUDED.renewal_refund_count,
      renewal_refund_amount=EXCLUDED.renewal_refund_amount`,
    [from, to, rangeEnd]);

  // 日 × 课程 / 日 × 场地（同一条课粒度 CTE 上卷两遍）。
  // 每天每个出现过的分组 upsert 一行；分组若当天彻底消失（如整段无课），残留旧行需清除。
  for (const [dim, keyExpr, nameExpr] of [
    ['course', 'p.title', 'p.title'],
    ['venue', `'venue:'||COALESCE(p.venue_id,0)`, 'p.venue_name'],
  ]) {
    await query(`
      WITH ${classPerCTE('$1', '$2')}
      INSERT INTO daily_group_metrics
        (day, dim, dim_key, dim_name, classes_scheduled, classes_canceled,
         seats_total, seats_effective, checkins, no_shows, canceled_bookings, full_classes)
      SELECT p.day, '${dim}'::varchar, ${keyExpr}, ${nameExpr},
        count(*) FILTER (WHERE p.status <> 'canceled'),
        count(*) FILTER (WHERE p.status = 'canceled'),
        COALESCE(sum(p.capacity) FILTER (WHERE p.status <> 'canceled'), 0),
        COALESCE(sum(p.eff), 0), COALESCE(sum(p.ck), 0),
        COALESCE(sum(p.ns), 0), COALESCE(sum(p.cb), 0),
        count(*) FILTER (WHERE p.status <> 'canceled' AND p.eff >= p.capacity)
      FROM per_class p
      WHERE p.day < CURRENT_DATE
      GROUP BY p.day, ${keyExpr}, ${nameExpr}
      ON CONFLICT (day, dim, dim_key) DO UPDATE SET
        dim_name=EXCLUDED.dim_name,
        classes_scheduled=EXCLUDED.classes_scheduled, classes_canceled=EXCLUDED.classes_canceled,
        seats_total=EXCLUDED.seats_total, seats_effective=EXCLUDED.seats_effective,
        checkins=EXCLUDED.checkins, no_shows=EXCLUDED.no_shows,
        canceled_bookings=EXCLUDED.canceled_bookings, full_classes=EXCLUDED.full_classes`,
      [from, to]);
  }

  // 清理：区间内某天某分组已经没有任何课（重排/取消导致），删掉残留行，避免汇总虚高
  await query(`
    DELETE FROM daily_group_metrics g
    WHERE g.day BETWEEN $1 AND LEAST($2, CURRENT_DATE - 1)
      AND g.dim IN ('course','venue')
      AND NOT EXISTS (
        SELECT 1 FROM classes c
        LEFT JOIN venues v ON v.id = c.venue_id
        WHERE c.start_at::date = g.day
          AND (
            (g.dim='course' AND c.title = g.dim_key)
            OR (g.dim='venue' AND g.dim_key = 'venue:'||COALESCE(c.venue_id,0))
          ))`,
    [from, to]);
}

// 汇总行求和的统一字段
const SUM_FIELDS = [
  'classes_scheduled','classes_canceled','seats_total','seats_effective',
  'checkins','no_shows','canceled_bookings','full_classes',
  'new_members','lost_members',
  'card_sales_count','card_sales_amount','card_refund_count','card_refund_amount',
  'renewal_count','renewal_amount','renewal_refund_count','renewal_refund_amount',
];
const MONEY_FIELDS = ['card_sales_amount','card_refund_amount','renewal_amount','renewal_refund_amount'];
const EMPTY_TOTALS = () => Object.fromEntries([
  ...SUM_FIELDS.map((f) => [f, 0]),
]);

function addTotals(acc, row) {
  for (const f of SUM_FIELDS) acc[f] += Number(row[f] || 0);
}

async function currentDate() {
  return (await query(`SELECT CURRENT_DATE::text d`)).rows[0].d;
}
function addDaysISO(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 当天（尚未结账日）实时聚合，结构对齐 daily_metrics，保证「日汇总 + 今天」拼起来无偏
async function liveTodayTotals() {
  const today = await currentDate();
  const totals = EMPTY_TOTALS();
  const cls = (await query(`
    WITH ${classPerCTE()}
    SELECT
      count(*) FILTER (WHERE status <> 'canceled') AS classes_scheduled,
      count(*) FILTER (WHERE status = 'canceled')  AS classes_canceled,
      COALESCE(sum(capacity) FILTER (WHERE status <> 'canceled'), 0) AS seats_total,
      COALESCE(sum(eff),0) AS seats_effective,
      COALESCE(sum(ck),0)  AS checkins,
      COALESCE(sum(ns),0)  AS no_shows,
      COALESCE(sum(cb),0)  AS canceled_bookings,
      count(*) FILTER (WHERE status <> 'canceled' AND eff >= capacity) AS full_classes
    FROM per_class`, [today, today])).rows[0];
  Object.assign(totals, Object.fromEntries(
    ['classes_scheduled','classes_canceled','seats_total','seats_effective',
     'checkins','no_shows','canceled_bookings','full_classes']
      .map((f) => [f, Number(cls[f] || 0)])));

  const sales = (await query(
    `SELECT count(*) n, COALESCE(sum(price),0) amt FROM membership_cards
     WHERE created_at::date = CURRENT_DATE`)).rows[0];
  totals.card_sales_count = Number(sales.n); totals.card_sales_amount = Number(sales.amt);
  const ren = (await query(
    `SELECT count(*) n, COALESCE(sum(amount),0) amt FROM renewals
     WHERE renewed_at::date = CURRENT_DATE`)).rows[0];
  totals.renewal_count = Number(ren.n); totals.renewal_amount = Number(ren.amt);
  const ref = (await query(
    `SELECT source_type, count(*) n, COALESCE(sum(amount),0) amt FROM refunds
     WHERE refunded_at::date = CURRENT_DATE GROUP BY source_type`)).rows;
  for (const r of ref) {
    if (r.source_type === 'card') { totals.card_refund_count = Number(r.n); totals.card_refund_amount = Number(r.amt); }
    else { totals.renewal_refund_count = Number(r.n); totals.renewal_refund_amount = Number(r.amt); }
  }
  totals.new_members = (await query(
    `SELECT count(*)::int n FROM members WHERE joined_at = CURRENT_DATE`)).rows[0].n;
  totals.lost_members = (await query(
    `SELECT count(*)::int n FROM members WHERE lost_at = CURRENT_DATE`)).rows[0].n;
  return totals;
}

// 把数据库行（SUM 大整数/numeric）规整成数字并派生比率
export function applyRates(t) {
  const n = Number;
  t.attendance_rate = t.seats_effective ? n(t.checkins) / n(t.seats_effective) : null;
  t.full_rate = t.classes_scheduled ? n(t.full_classes) / n(t.classes_scheduled) : null;
  t.utilization_rate = t.seats_total ? n(t.seats_effective) / n(t.seats_total) : null;
  t.net_revenue = n(t.card_sales_amount) + n(t.renewal_amount)
    - n(t.card_refund_amount) - n(t.renewal_refund_amount);
  t.net_member_growth = n(t.new_members) - n(t.lost_members);
  return t;
}

// 区间经营总览：已结束日走汇总表（先增量补齐），今天实时算，未来日不参与
export async function getSummary(from, to) {
  await runMaintenance();
  const today = await currentDate();
  const histEnd = addDaysISO(today, -1);
  const histTo = to < histEnd ? to : histEnd;

  const totals = EMPTY_TOTALS();
  if (from <= histTo) {
    await refreshDailyRollups(from, histTo);
    const r = await query(
      `SELECT ${SUM_FIELDS.map((f) => `COALESCE(sum(${f}),0) AS ${f}`).join(',')}
       FROM daily_metrics WHERE day BETWEEN $1 AND $2`,
      [from, histTo]);
    if (r.rows[0]) addTotals(totals, r.rows[0]);
  }
  if (from <= today && to >= today) {
    addTotals(totals, await liveTodayTotals());
  }
  applyRates(totals);
  totals.from = from; totals.to = to;
  return totals;
}


// 按课程 / 场地分组（下钻第一层），同样「历史汇总 + 今天实时」
export async function getAttendanceGroups(from, to, dim = 'course') {
  await runMaintenance();
  const today = await currentDate();
  const histEnd = addDaysISO(today, -1);
  const histTo = to < histEnd ? to : histEnd;

  const map = new Map();
  const merge = (row) => {
    const key = row.dim_key;
    if (!map.has(key)) map.set(key, {
      dim_key: key, dim_name: row.dim_name || key,
      classes_scheduled: 0, classes_canceled: 0, seats_total: 0, seats_effective: 0,
      checkins: 0, no_shows: 0, canceled_bookings: 0, full_classes: 0,
    });
    const g = map.get(key);
    for (const f of ['classes_scheduled','classes_canceled','seats_total','seats_effective',
      'checkins','no_shows','canceled_bookings','full_classes']) g[f] += Number(row[f] || 0);
  };

  if (from <= histTo) {
    await refreshDailyRollups(from, histTo);
    const r = await query(`
      SELECT dim_key, MAX(dim_name) AS dim_name,
        sum(classes_scheduled) classes_scheduled, sum(classes_canceled) classes_canceled,
        sum(seats_total) seats_total, sum(seats_effective) seats_effective,
        sum(checkins) checkins, sum(no_shows) no_shows,
        sum(canceled_bookings) canceled_bookings, sum(full_classes) full_classes
      FROM daily_group_metrics
      WHERE dim=$3 AND day BETWEEN $1 AND $2
      GROUP BY dim_key`, [from, histTo, dim]);
    r.rows.forEach(merge);
  }

  if (from <= today && to >= today) {
    // 当天实时部分复用同一套课粒度 CTE，按所选维度再上卷
    const keyExpr = dim === 'course' ? 'p.title' : `'venue:'||COALESCE(p.venue_id,0)`;
    const nameExpr = dim === 'course' ? 'p.title' : 'p.venue_name';
    const r = await query(`
      WITH ${classPerCTE()}
      SELECT ${keyExpr} AS dim_key, ${nameExpr} AS dim_name,
        count(*) FILTER (WHERE p.status <> 'canceled') AS classes_scheduled,
        count(*) FILTER (WHERE p.status = 'canceled')  AS classes_canceled,
        COALESCE(sum(p.capacity) FILTER (WHERE p.status <> 'canceled'), 0) AS seats_total,
        COALESCE(sum(p.eff), 0) AS seats_effective,
        COALESCE(sum(p.ck), 0)  AS checkins,
        COALESCE(sum(p.ns), 0)  AS no_shows,
        COALESCE(sum(p.cb), 0)  AS canceled_bookings,
        count(*) FILTER (WHERE p.status <> 'canceled' AND p.eff >= p.capacity) AS full_classes
      FROM per_class p
      GROUP BY ${keyExpr}, ${nameExpr}`, [today, today]);
    r.rows.forEach(merge);
  }

  return [...map.values()]
    .map((g) => {
      g.attendance_rate = g.seats_effective ? g.checkins / g.seats_effective : null;
      g.full_rate = g.classes_scheduled ? g.full_classes / g.classes_scheduled : null;
      g.utilization_rate = g.seats_total ? g.seats_effective / g.seats_total : null;
      return g;
    })
    .sort((a, b) => b.seats_effective - a.seats_effective);
}

// 课程/场地 → 课节明细（下钻第二层），区间有界，直接查明细表
export async function getAttendanceDetails(from, to, dim, dimKey) {
  const params = [from, to];
  let cond = '';
  if (dim === 'course') { params.push(dimKey); cond = `AND c.title = $3`; }
  else if (dim === 'venue') {
    if (dimKey === 'venue:0') cond = `AND c.venue_id IS NULL`;
    else { params.push(Number(String(dimKey).replace('venue:', ''))); cond = `AND c.venue_id = $3`; }
  }
  const r = await query(`
    SELECT c.id, c.title, c.start_at, c.end_at, c.status, c.capacity,
      co.name AS coach_name, COALESCE(v.name,'未分配场地') AS venue_name,
      count(b.id) FILTER (WHERE b.status IN ('checked','no_show')) AS seats_effective,
      count(b.id) FILTER (WHERE b.status='checked') AS checkins,
      count(b.id) FILTER (WHERE b.status='no_show') AS no_shows,
      count(b.id) FILTER (WHERE b.status='canceled' AND c.status<>'canceled') AS canceled_bookings
    FROM classes c
    LEFT JOIN bookings b ON b.class_id=c.id
    LEFT JOIN venues v ON v.id=c.venue_id
    LEFT JOIN coaches co ON co.id=c.coach_id
    WHERE c.start_at::date BETWEEN $1 AND $2 ${cond}
    GROUP BY c.id, co.name, v.name
    ORDER BY c.start_at DESC`, params);
  return r.rows.map((c) => ({
    ...c,
    attendance_rate: Number(c.seats_effective) ? Number(c.checkins) / Number(c.seats_effective) : null,
    is_full: c.status !== 'canceled' && Number(c.seats_effective) >= c.capacity,
  }));
}

// 单节课的预约名单（导出/查看明细用，手机号按角色在路由层决定是否返回）
export async function getClassRoster(classId, includePhone) {
  const cols = includePhone ? 'm.phone' : 'NULL::text AS phone';
  return (await query(`
    SELECT b.id, b.status, b.verify_code, b.booked_at, b.checked_at, b.canceled_at,
           b.cancel_reason, m.id AS member_id, m.name AS member_name, ${cols},
           c2.plan_name AS card_plan
    FROM bookings b
    JOIN members m ON m.id=b.member_id
    LEFT JOIN membership_cards c2 ON c2.id=b.card_id
    WHERE b.class_id=$1
    ORDER BY
      CASE b.status WHEN 'checked' THEN 0 WHEN 'booked' THEN 1 WHEN 'no_show' THEN 2 ELSE 3 END,
      m.name`, [classId])).rows;
}

// 会员新增/流失明细
export async function getMemberFlow(from, to, kind) {
  const where = kind === 'lost' ? 'm.lost_at BETWEEN $1 AND $2' : 'm.joined_at BETWEEN $1 AND $2';
  const dateCol = kind === 'lost' ? 'm.lost_at' : 'm.joined_at';
  return (await query(`
    SELECT m.id, m.name, m.gender, m.phone, m.joined_at, m.lost_at, m.last_active_at,
      ${dateCol}::text AS event_date,
      (SELECT max(plan_name) FROM membership_cards WHERE member_id=m.id) AS last_plan
    FROM members m
    WHERE ${where}
    ORDER BY event_date DESC, m.id`, [from, to])).rows;
}

// 卡种销量与续费：新办卡按 plan_name；续费按所续卡种
export async function getCardSales(from, to) {
  const sales = (await query(`
    SELECT c.plan_name, c.card_type,
      count(*) AS sales_count, COALESCE(sum(c.price),0) AS sales_amount
    FROM membership_cards c
    WHERE c.created_at::date BETWEEN $1 AND $2
    GROUP BY c.plan_name, c.card_type`, [from, to])).rows;
  const renewals = (await query(`
    SELECT c.plan_name, c.card_type,
      count(*) AS renewal_count, COALESCE(sum(r.amount),0) AS renewal_amount
    FROM renewals r LEFT JOIN membership_cards c ON c.id=r.card_id
    WHERE r.renewed_at::date BETWEEN $1 AND $2
    GROUP BY c.plan_name, c.card_type`, [from, to])).rows;
  const refunds = (await query(`
    SELECT c.plan_name,
      count(*) AS refund_count, COALESCE(sum(rf.amount),0) AS refund_amount
    FROM refunds rf LEFT JOIN membership_cards c ON c.id=rf.card_id
    WHERE rf.refunded_at::date BETWEEN $1 AND $2
    GROUP BY c.plan_name`, [from, to])).rows;

  const map = new Map();
  const ensure = (plan) => {
    if (!map.has(plan)) map.set(plan, {
      plan_name: plan, card_type: null,
      sales_count: 0, sales_amount: 0, renewal_count: 0, renewal_amount: 0,
      refund_count: 0, refund_amount: 0,
    });
    return map.get(plan);
  };
  for (const r of sales) { const g = ensure(r.plan_name); Object.assign(g, {
    card_type: r.card_type, sales_count: Number(r.sales_count), sales_amount: Number(r.sales_amount) }); }
  for (const r of renewals) { const g = ensure(r.plan_name || '已删卡种');
    g.card_type = g.card_type || r.card_type;
    g.renewal_count = Number(r.renewal_count); g.renewal_amount = Number(r.renewal_amount); }
  for (const r of refunds) { const g = ensure(r.plan_name || '已删卡种');
    g.refund_count = Number(r.refund_count); g.refund_amount = Number(r.refund_amount); }
  return [...map.values()].map((g) => ({
    ...g,
    net_amount: g.sales_amount + g.renewal_amount - g.refund_amount,
  })).sort((a, b) => b.net_amount - a.net_amount);
}

// ---------- 历史期间结账快照（周/月冻结，口径版本随快照固化） ----------

function isoWeekStart(d) {
  const dt = new Date(`${d}T00:00:00Z`);
  const day = (dt.getUTCDay() + 6) % 7; // 周一=0
  dt.setUTCDate(dt.getUTCDate() - day);
  return dt.toISOString().slice(0, 10);
}

// 冻结一个已结束 ≥3 天的周/月（幂等）。返回是否实际生成。
export async function freezePeriod(periodType, periodStart) {
  await runMaintenance();
  const start = periodType === 'week' ? isoWeekStart(periodStart) : periodStart.slice(0, 8) + '01';
  const end = periodType === 'week'
    ? addDaysISO(start, 6)
    : addDaysISO(addDaysISO(start.slice(0, 8) + '01', 31).slice(0, 8) + '01', -1);
  const today = (await query(`SELECT CURRENT_DATE::text d`)).rows[0].d;
  if (addDaysISO(end, 3) > today) return false; // 结账缓冲期未满，不冻结

  const exists = await query(
    `SELECT 1 FROM report_snapshots WHERE period_type=$1 AND period_start=$2 AND caliber_version=$3`,
    [periodType, start, CALIBER_VERSION]);
  if (exists.rows.length) return false;

  const [summary, attendance, members, cardSales] = await Promise.all([
    getSummary(start, end),
    (async () => ({
      course: await getAttendanceGroups(start, end, 'course'),
      venue: await getAttendanceGroups(start, end, 'venue'),
    }))(),
    (async () => ({
      new: await getMemberFlow(start, end, 'new'),
      lost: await getMemberFlow(start, end, 'lost'),
    }))(),
    getCardSales(start, end),
  ]);

  await query(
    `INSERT INTO report_snapshots(period_type, period_start, report_key, payload, caliber_version)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT DO NOTHING`,
    [periodType, start, 'summary', JSON.stringify(summary), CALIBER_VERSION]);
  await query(
    `INSERT INTO report_snapshots(period_type, period_start, report_key, payload, caliber_version)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT DO NOTHING`,
    [periodType, start, 'attendance', JSON.stringify(attendance), CALIBER_VERSION]);
  await query(
    `INSERT INTO report_snapshots(period_type, period_start, report_key, payload, caliber_version)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT DO NOTHING`,
    [periodType, start, 'members', JSON.stringify(members), CALIBER_VERSION]);
  await query(
    `INSERT INTO report_snapshots(period_type, period_start, report_key, payload, caliber_version)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT DO NOTHING`,
    [periodType, start, 'card_sales', JSON.stringify(cardSales), CALIBER_VERSION]);
  return true;
}

// 启动时补冻结：扫描历史周/月（近 24 个月、有开课记录的），缺快照的冻结
export async function freezeDuePeriods() {
  const months = (await query(`
    SELECT DISTINCT date_trunc('month', start_at)::date::text AS m
    FROM classes
    WHERE start_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '24 months'
    ORDER BY m`)).rows;
  for (const { m } of months) {
    const ms = String(m).slice(0, 10);
    try { await freezePeriod('month', ms); } catch (e) { console.error('月快照失败', ms, e.message); }
  }
}

// 工作台近 7 天趋势：历史日取日汇总，今天实时算（与报表同一数据通路）
export async function getTrend(days = 7) {
  await runMaintenance();
  const today = await currentDate();
  const start = addDaysISO(today, -(days - 1));
  await refreshDailyRollups(start, addDaysISO(today, -1));
  const hist = (await query(
    `SELECT day::text AS day, classes_scheduled AS classes, checkins AS checked
     FROM daily_metrics WHERE day BETWEEN $1 AND $2 ORDER BY day`,
    [start, addDaysISO(today, -1)]
  )).rows;
  const live = await liveTodayTotals();
  const map = new Map(hist.map((r) => [r.day, { day: r.day, classes: Number(r.classes), checked: Number(r.checked) }]));
  map.set(today, { day: today, classes: live.classes_scheduled, checked: live.checkins });

  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDaysISO(start, i);
    out.push(map.get(d) || { day: d, classes: 0, checked: 0 });
  }
  return out;
}

// 当天总览（工作台复用，保证与区间报表口径一致）
export async function getTodaySummary() {
  const today = await currentDate();
  return getSummary(today, today);
}

// 取冻结报表（命中则返回 {frozen:true, caliber_version, generated_at, data}）
export async function getFrozenReport(periodType, periodStart, reportKey) {
  const start = periodType === 'week' ? isoWeekStart(periodStart) : periodStart.slice(0, 8) + '01';
  const r = await query(`
    SELECT payload, caliber_version, generated_at
    FROM report_snapshots
    WHERE period_type=$1 AND period_start=$2 AND report_key=$3
    ORDER BY caliber_version DESC LIMIT 1`,
    [periodType, start, reportKey]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    frozen: true,
    period_start: start,
    caliber_version: row.caliber_version,
    generated_at: row.generated_at,
    data: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  };
}
