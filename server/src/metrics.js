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

// 巡检节流：结束的日子不可变，没必要每个请求都全表 UPDATE；
// 进程内 60 秒最多跑一次，并发请求共用同一个在途 Promise。
let lastMaintenanceAt = 0;
let maintenanceInflight = null;
const MAINTENANCE_TTL_MS = 60_000;

export function runMaintenance(force = false) {
  const now = Date.now();
  const doRun = async () => {
    await closePastClasses();
    await refreshMemberLifecycle();
    lastMaintenanceAt = Date.now();
  };
  if (force) return doRun();
  if (maintenanceInflight) return maintenanceInflight;
  if (now - lastMaintenanceAt < MAINTENANCE_TTL_MS) return Promise.resolve();
  maintenanceInflight = doRun().finally(() => { maintenanceInflight = null; });
  return maintenanceInflight;
}

// 启动/对账用：强制立刻跑一次
export async function runMaintenanceNow() {
  await runMaintenance(true);
}

// ---- 课程/预约维度的公共聚合（按课粒度，再上卷）----
// 有效预约：已核销 + 未到店（已结束课）+ 已预约（当天尚未结束的课，预约本身占座，
// 结束后 booked 会被 closePastClasses 自动转成 no_show/checked，历史日因此不含 booked）。
// dayExpr/paramPh：限定「开课日 ∈ 参数给出的日期集合」，物化时一次只算缺口日，不重扫全部历史。
function classPerCTE(dayExpr = 'c.start_at::date', paramPh = '$1', isArray = false) {
  const inFilter = isArray ? `${dayExpr} = ANY(${paramPh})` : `${dayExpr} >= ${paramPh} AND ${dayExpr} <= $2`;
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
      WHERE ${inFilter}
      GROUP BY c.id, v.name
    )`;
}

async function getMaterializedDays() {
  const r = await query(`SELECT day::text AS day FROM rollup_state`);
  return new Set(r.rows.map((x) => x.day));
}

// 增量刷新日级汇总：只计算「缺口日 + 昨天」（昨天重算以接纳当日补录的核销/退款），
// 更早的日期已结账不可变，永不重算 → 历史周/月查询成本与总数据量无关。
// 返回本次实际计算的日期数。
export async function refreshDailyRollups(from, to) {
  if (!from || !to || from > to) return 0;
  const today = await currentDate();
  const histLast = addDaysISO(today, -1);
  if (from > histLast) return 0; // 区间全部落在今天/未来
  const rangeEnd = to < histLast ? to : histLast;

  const materialized = await getMaterializedDays();
  const yesterday = histLast;
  const missing = [];
  for (let d = from; d <= rangeEnd; d = addDaysISO(d, 1)) {
    if (d !== yesterday && materialized.has(d)) continue; // 已物化且非昨天：直接跳过
    missing.push(d);
  }
  if (missing.length === 0) return 0;

  // 整段 SQL 只传一个日期数组参数 $1（date[]），占位符统一为 $1
  const ARRAY_PH = '$1::date[]';
  await query(`
    WITH ${classPerCTE(undefined, ARRAY_PH, true)},
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
      FROM membership_cards WHERE created_at::date = ANY(${ARRAY_PH}) GROUP BY 1
    ),
    ren AS (
      SELECT renewed_at::date AS day, count(*) AS n, COALESCE(sum(amount),0) AS amt
      FROM renewals WHERE renewed_at::date = ANY(${ARRAY_PH}) GROUP BY 1
    ),
    ref AS (
      SELECT refunded_at::date AS day,
        count(*) FILTER (WHERE source_type='card')    AS cn,
        COALESCE(sum(amount) FILTER (WHERE source_type='card'),0)    AS ca,
        count(*) FILTER (WHERE source_type='renewal') AS rn,
        COALESCE(sum(amount) FILTER (WHERE source_type='renewal'),0) AS ra
      FROM refunds WHERE refunded_at::date = ANY(${ARRAY_PH}) GROUP BY 1
    ),
    nm AS (SELECT joined_at AS day, count(*) n FROM members
      WHERE joined_at = ANY(${ARRAY_PH}) GROUP BY 1),
    lm AS (SELECT lost_at AS day, count(*) n FROM members
      WHERE lost_at = ANY(${ARRAY_PH}) GROUP BY 1)
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
    FROM unnest(${ARRAY_PH}) AS g(day)
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
    [missing]);

  // 日 × 课程 / 日 × 场地（只针对本次缺口日，先删后插，保证取消/改名不留残行）
  for (const [dim, keyExpr, nameExpr] of [
    ['course', 'p.title', 'p.title'],
    ['venue', `'venue:'||COALESCE(p.venue_id,0)`, 'p.venue_name'],
  ]) {
    await query(`DELETE FROM daily_group_metrics WHERE day = ANY($1::date[]) AND dim=$2`, [missing, dim]);
    await query(`
      WITH ${classPerCTE(undefined, '$1::date[]', true)}
      INSERT INTO daily_group_metrics
        (day, dim, dim_key, dim_name, classes_scheduled, classes_canceled,
         seats_total, seats_effective, checkins, no_shows, canceled_bookings, full_classes)
      SELECT p.day, $2::varchar, ${keyExpr}, ${nameExpr},
        count(*) FILTER (WHERE p.status <> 'canceled'),
        count(*) FILTER (WHERE p.status = 'canceled'),
        COALESCE(sum(p.capacity) FILTER (WHERE p.status <> 'canceled'), 0),
        COALESCE(sum(p.eff), 0), COALESCE(sum(p.ck), 0),
        COALESCE(sum(p.ns), 0), COALESCE(sum(p.cb), 0),
        count(*) FILTER (WHERE p.status <> 'canceled' AND p.eff >= p.capacity)
      FROM per_class p
      GROUP BY p.day, ${keyExpr}, ${nameExpr}`,
      [missing, dim]);
  }

  // 这些日期从此结账（昨天每次重算都会刷新 computed_at）
  await query(`
    INSERT INTO rollup_state(day) SELECT unnest($1::date[])
    ON CONFLICT (day) DO UPDATE SET computed_at=now()`, [missing]);
  return missing.length;
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

// 区间经营总览：已结束日走汇总表（只物化缺口日），今天实时算，未来日不参与。
// 返回 computed_days：本次实际新算/重算的历史日数（用于回归「历史查询不重复全量计算」）。
export async function getSummary(from, to) {
  await runMaintenance();
  const today = await currentDate();
  const histEnd = addDaysISO(today, -1);
  const histTo = to < histEnd ? to : histEnd;

  const totals = EMPTY_TOTALS();
  let computedDays = 0;
  if (from <= histTo) {
    computedDays = await refreshDailyRollups(from, histTo);
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
  totals.computed_days = computedDays;
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

// 周/月的标准闭区间 [start, end]
export function periodBounds(periodType, anyDate) {
  const start = periodType === 'week' ? isoWeekStart(anyDate) : anyDate.slice(0, 8) + '01';
  const end = periodType === 'week'
    ? addDaysISO(start, 6)
    : addDaysISO(addDaysISO(start.slice(0, 8) + '01', 31).slice(0, 8) + '01', -1);
  return { start, end };
}

// 判断查询区间 [from,to] 是否恰好等于某个已冻结的周/月；命中返回快照元信息
// （页面重查/导出整月时必须走快照，而不是实时重算）
export async function findFrozenPeriod(from, to) {
  const candidates = [
    { type: 'month', key: 'month' },
    { type: 'week', key: 'week' },
  ];
  for (const { type } of candidates) {
    const { start, end } = periodBounds(type, from);
    if (start === from && end === to) {
      const r = await query(`
        SELECT period_type, period_start::text AS period_start, caliber_version, generated_at::text AS generated_at
        FROM report_snapshots
        WHERE period_type=$1 AND period_start=$2 AND report_key='summary'
        ORDER BY caliber_version DESC LIMIT 1`, [type, start]);
      if (r.rows[0]) {
        return { period_type: type, period_start: start, period_end: end,
          caliber_version: r.rows[0].caliber_version, generated_at: r.rows[0].generated_at };
      }
    }
  }
  return null;
}

// 冻结一个已结束 ≥3 天的周/月（幂等）。返回是否实际生成。
export async function freezePeriod(periodType, periodStart) {
  const start = periodType === 'week' ? isoWeekStart(periodStart) : periodStart.slice(0, 8) + '01';
  const end = periodType === 'week'
    ? addDaysISO(start, 6)
    : addDaysISO(addDaysISO(start.slice(0, 8) + '01', 31).slice(0, 8) + '01', -1);
  const today = await currentDate();
  if (addDaysISO(end, 3) > today) return false; // 结账缓冲期未满，不冻结

  // 先查快照存在性（便宜），命中直接返回，不为已冻结期间重复全量计算
  const exists = await query(
    `SELECT 1 FROM report_snapshots WHERE period_type=$1 AND period_start=$2 AND caliber_version=$3`,
    [periodType, start, CALIBER_VERSION]);
  if (exists.rows.length) return false;

  await runMaintenance(true);
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

// 启动时补冻结：只处理「有开课但缺当前口径快照」的历史月（便宜的反连接，不重算已有月份）
export async function freezeDuePeriods() {
  const months = (await query(`
    SELECT DISTINCT date_trunc('month', c.start_at)::date::text AS m
    FROM classes c
    WHERE c.start_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '24 months'
      AND c.start_at::date < CURRENT_DATE - INTERVAL '3 days'
      AND NOT EXISTS (
        SELECT 1 FROM report_snapshots s
        WHERE s.period_type='month'
          AND s.period_start = date_trunc('month', c.start_at)::date
          AND s.report_key='summary' AND s.caliber_version=$1)
    ORDER BY m`, [CALIBER_VERSION])).rows;
  for (const { m } of months) {
    const ms = String(m).slice(0, 10);
    try { await freezePeriod('month', ms); } catch (e) { console.error('月快照失败', ms, e.message); }
  }
}

// 启动时一次性回填日汇总缺口（后台非阻塞），后续历史查询即纯读汇总
export async function backfillRollups() {
  const edge = (await query(`
    SELECT min(start_at)::date::text AS mn,
           (CURRENT_DATE - 1)::text AS mx FROM classes`)).rows[0];
  if (!edge.mn) return;
  await refreshDailyRollups(edge.mn, edge.mx);
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
