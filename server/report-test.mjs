// 经营报表一致性冒烟测试：
//  1. 工作台当日数字 == 当天区间报表 == 近7天趋势末日
//  2. 区间汇总 == 按课程分组求和 == 按场地分组求和
//  3. 分组行 == 下钻课节明细求和
//  4. 角色矩阵：前台名单无手机号 / 投资人会员明细 403 / 前台无金额
//  5. 取消课：今天取消一节课后，开课 -1、取消课节 +1、核销不变
//  6. 退款：登记后净收入等额下降
// 注意：本测试会改动数据，结束后自动 reseed。
const BASE = process.env.API || 'http://localhost:4000/api';

async function api(path, opts = {}, role) {
  const r = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(role ? { 'X-User-Role': role } : {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra); }
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const T = today();

try {
  // 1. 工作台 vs 当天报表
  const { data: dash } = await api('/dashboard/stats');
  const { data: day } = await api(`/reports/summary?from=${T}&to=${T}`);
  check('工作台今日课程 = 当天报表', dash.todayClasses === day.classes_scheduled,
    `${dash.todayClasses} vs ${day.classes_scheduled}`);
  check('工作台今日核销 = 当天报表', dash.checkedToday === day.checkins);
  check('工作台今日预约 = 当天报表有效预约', dash.todayBookings === day.seats_effective);
  const { data: trend } = await api('/dashboard/trend');
  const last = trend[trend.length - 1];
  check('趋势末日 = 当天开课/核销', last.day === T && last.classes === day.classes_scheduled
    && last.checked === day.checkins);

  // 2. 汇总 vs 双维度分组
  const monthStart = T.slice(0, 8) + '01';
  const { data: s } = await api(`/reports/summary?from=${monthStart}&to=${T}`);
  const { data: gc } = await api(`/reports/attendance?from=${monthStart}&to=${T}&dim=course`);
  const { data: gv } = await api(`/reports/attendance?from=${monthStart}&to=${T}&dim=venue`);
  const sum = (gs, k) => gs.reduce((a, x) => a + x[k], 0);
  for (const k of ['classes_scheduled', 'classes_canceled', 'seats_total', 'seats_effective',
    'checkins', 'no_shows', 'canceled_bookings', 'full_classes']) {
    check(`汇总[${k}] = 课程分组和`, s[k] === sum(gc.groups, k), `${s[k]} vs ${sum(gc.groups, k)}`);
    check(`汇总[${k}] = 场地分组和`, s[k] === sum(gv.groups, k));
  }

  // 3. 下钻明细求和
  const g0 = gc.groups[0];
  const { data: det } = await api(
    `/reports/attendance/details?from=${monthStart}&to=${T}&dim=course&key=${encodeURIComponent(g0.dim_key)}`);
  check('下钻课节核销和 = 分组行',
    det.reduce((a, x) => a + x.checkins, 0) === g0.checkins);

  // 4. 角色矩阵
  const { data: fd } = await api('/reports/members?kind=lost', {}, 'front_desk');
  check('前台流失名单不含手机号', fd.rows.every((r) => !('phone' in r)));
  const inv = await api('/reports/members?kind=lost', {}, 'investor');
  check('投资人访问会员明细 = 403', inv.status === 403);
  const { data: fcs } = await api('/reports/card-sales', {}, 'front_desk');
  check('前台卡种报表不含金额', fcs.rows.every((r) => !('sales_amount' in r)));
  const frf = await api('/reports/refunds', {}, 'front_desk');
  check('前台访问退款流水 = 403', frf.status === 403);

  // 5. 取消今天一节未开始的课
  const { data: todayClasses } = await api(
    `/classes?from=${T}T00:00:00%2B08:00&to=${T}T23:59:59%2B08:00`);
  const before = (await api(`/reports/summary?from=${T}&to=${T}`)).data;
  const candidate = todayClasses.find((c) => c.status === 'open'
    && new Date(c.start_at) > new Date(Date.now() + 3600e3));
  if (candidate) {
    const { status, data } = await api(`/classes/${candidate.id}/cancel`,
      { method: 'POST', body: { reason: '对账测试取消' } });
    check('取消课程成功', status === 200, JSON.stringify(data));
    const after = (await api(`/reports/summary?from=${T}&to=${T}`)).data;
    check('取消后开课 -1', before.classes_scheduled - after.classes_scheduled === 1);
    check('取消后取消课节 +1', after.classes_canceled - before.classes_canceled === 1);
    check('取消课不改变已核销数', before.checkins === after.checkins);
  } else {
    console.log('  ℹ️  今天无较晚未开始课程，跳过取消课用例');
  }

  // 6. 退款影响净收入
  const beforeNet = (await api(`/reports/summary?from=${monthStart}&to=${T}`)).data.net_revenue;
  const refund = await api('/reports/refunds',
    { method: 'POST', body: { source_type: 'card', source_id: 1, card_id: 1, member_id: 1, amount: 50, reason: '对账测试' } },
    'manager');
  check('店长登记退款成功', refund.status === 201);
  const afterNet = (await api(`/reports/summary?from=${monthStart}&to=${T}`)).data.net_revenue;
  check('退款后净收入减少 50', Math.round(beforeNet - afterNet) === 50, `${beforeNet} -> ${afterNet}`);

  // 7. 冻结快照带口径版本（上月，若已过结账缓冲期）
  const first = await api('/reports/freeze',
    { method: 'POST', body: { period_type: 'month', period_start: '2026-08-01' } }, 'manager');
  check('上月冻结接口可用', first.status === 200 && first.data.ok);
  const snap = await api('/reports/frozen/month/summary?period_start=2026-08-01', {}, 'manager');
  if (snap.status === 200) check('冻结快照携带口径版本 v1', snap.data.caliber_version === 1 && snap.data.frozen);
} finally {
  console.log(`\n报表对账结果：${pass} 通过，${fail} 失败`);
  //恢复样例数据
  await api('/dev/reseed', { method: 'POST' });
  process.exit(fail ? 1 : 0);
}
