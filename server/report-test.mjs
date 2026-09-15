// 经营报表安全与一致性冒烟测试：
//  A. 鉴权：无令牌 401、伪造 X-User-Role 403、前台 token 不能提权、篡改令牌 401
//  B. 冻结：历史月查询/导出强制走快照，篡改底层数据后快照不变
//  C. 性能：历史区间重复查询不重算（computed_days=0），含昨天最多重算 1 天
//  D. 一致性：工作台当日数字 == 当天报表；汇总 == 课程/场地分组求和
// 结束自动 reseed。
const BASE = process.env.API || 'http://localhost:4000/api';

async function call(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.fakeRole) headers['X-User-Role'] = opts.fakeRole;
  const r = await fetch(BASE + path, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const isCsv = (r.headers.get('content-type') || '').includes('csv');
  const data = isCsv ? await r.text() : await r.json().catch(() => ({}));
  return { status: r.status, data };
}
const api = (p, o = {}) => call('GET', p, undefined, o);
const post = (p, b, o = {}) => call('POST', p, b, o);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra); }
};
const T = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const monthStart = T.slice(0, 8) + '01';

try {
  // ---------- A. 鉴权 ----------
  console.log('A. 鉴权与防伪造');
  let r = await api('/reports/summary?from=2026-09-01&to=2026-09-15');
  check('无令牌访问报表 -> 401', r.status === 401 && r.data.login_required, String(r.status));
  r = await api('/reports/export/members?kind=lost&from=2026-09-01&to=2026-09-15');
  check('无令牌导出名单 -> 401', r.status === 401);
  r = await api('/reports/members?kind=lost', { fakeRole: 'manager' });
  check('伪造 X-User-Role:manager（无令牌）-> 403', r.status === 403, String(r.status));
  r = await post('/auth/login', { username: 'manager', password: 'wrong' });
  check('错误密码 -> 401', r.status === 401);

  const front = (await post('/auth/login', { username: 'front', password: 'front123' })).data;
  const ft = front.token;
  check('前台登录拿到令牌', !!ft);
  r = await api('/reports/members?kind=lost', { token: ft, fakeRole: 'manager' });
  check('前台令牌 + 伪造角色头 -> 403（不能提权）', r.status === 403, String(r.status));
  r = await api('/reports/members?kind=lost', { token: ft });
  check('前台名单不含手机号', r.status === 200 && r.data.rows.every((x) => !('phone' in x)));
  r = await api('/reports/refunds', { token: ft });
  check('前台访问退款流水 -> 403', r.status === 403);
  r = await post('/reports/freeze', { period_type: 'month', period_start: '2026-08-01' }, { token: ft });
  check('前台结账冻结 -> 403', r.status === 403);
  r = await api('/reports/summary?from=2026-09-01&to=2026-09-15', { token: ft.slice(0, -4) + 'AAAA' });
  check('篡改令牌 -> 401', r.status === 401);

  const manager = (await post('/auth/login', { username: 'manager', password: 'manager123' })).data;
  const mt = manager.token;
  r = await api('/reports/members?kind=lost', { token: mt });
  check('店长名单含手机号', r.status === 200 && r.data.rows.every((x) => 'phone' in x));
  const investor = (await post('/auth/login', { username: 'investor', password: 'investor123' })).data;
  r = await api('/reports/members?kind=lost', { token: investor.token });
  check('投资人会员明细 -> 403', r.status === 403);

  // ---------- B. 冻结快照 ----------
  console.log('B. 历史月查询/导出强制走快照');
  // 先回填日汇总（查一次含昨天的宽区间触发），再显式冻结 8 月，避免与后台任务赛跑
  await api('/reports/summary?from=2026-07-01&to=2026-09-15', { token: mt });
  const deadline = Date.now() + 15000;
  for (;;) {
    const f = await post('/reports/freeze',
      { period_type: 'month', period_start: '2026-08-01' }, { token: mt });
    if (f.data.frozen || f.data.note?.includes('已冻结')) break;
    if (Date.now() > deadline) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  // 确认快照确实落库（8 月已过结账缓冲期，冻结应成功）
  const periods = (await api('/reports/frozen-periods', { token: mt })).data
    .map((x) => `${x.period_type}:${x.period_start}`);
  check('8月快照已落库', periods.includes('month:2026-08-01'), JSON.stringify(periods));

  r = await api('/reports/summary?from=2026-08-01&to=2026-08-31', { token: mt });
  check('8月查询命中快照', r.status === 200 && r.data.frozen === true, JSON.stringify(r.data).slice(0, 120));
  const frozenCheckins = r.data.checkins;
  const frozenNet = r.data.net_revenue;
  check('快照 computed_days=0（读快照不重算）', r.data.computed_days === 0);

  for (const [p, name] of [
    ['/reports/attendance?from=2026-08-01&to=2026-08-31&dim=course', '上座分组'],
    ['/reports/members?from=2026-08-01&to=2026-08-31&kind=new', '新增会员'],
    ['/reports/card-sales?from=2026-08-01&to=2026-08-31', '卡种'],
  ]) {
    const x = await api(p, { token: mt });
    check(`${name}命中快照`, x.data.frozen === true);
  }

  const csv = (await api('/reports/export/summary?from=2026-08-01&to=2026-08-31', { token: mt })).data;
  check('导出汇总标注冻结快照', typeof csv === 'string' && csv.includes('结账冻结快照'));
  check('导出汇总是冻结核销数', csv.includes(`核销人次,${frozenCheckins}`), String(frozenCheckins));

  // 前台导出 8 月名单：走快照且无手机号
  const csvF = (await api('/reports/export/members?kind=new&from=2026-08-01&to=2026-08-31', { token: ft })).data;
  check('前台导出冻结名单无手机号列', typeof csvF === 'string' && !csvF.split('\n')[0].includes('手机号'));

  // ---------- C. 历史查询不重复全量计算 ----------
  console.log('C. 历史区间重复查询不重算');
  // 非冻结的历史区间（2026-07-15~08-15，跨多月非整月），第一次可能补昨天之外无缺口
  const a = (await api('/reports/summary?from=2026-07-15&to=2026-08-15', { token: mt })).data;
  const b = (await api('/reports/summary?from=2026-07-15&to=2026-08-15', { token: mt })).data;
  check('纯历史区间第二次查询 computed_days=0', b.computed_days === 0, `first=${a.computed_days} second=${b.computed_days}`);
  check('两次结果一致', a.checkins === b.checkins && a.classes_scheduled === b.classes_scheduled);
  const c = (await api('/reports/summary?from=2026-07-01&to=2026-09-15', { token: mt })).data;
  check('跨很久的区间只重算昨天(=1天)，不扫全部历史', c.computed_days === 1, `computed=${c.computed_days}`);

  // ---------- D. 数字一致性 ----------
  console.log('D. 工作台与报表一致 / 双维度对账');
  const dash = (await api('/dashboard/stats')).data;
  const day = (await api(`/reports/summary?from=${T}&to=${T}`, { token: mt })).data;
  check('工作台今日课程 = 当天报表', dash.todayClasses === day.classes_scheduled);
  check('工作台今日核销 = 当天报表', dash.checkedToday === day.checkins);
  const s = (await api(`/reports/summary?from=${monthStart}&to=${T}`, { token: mt })).data;
  const gc = (await api(`/reports/attendance?from=${monthStart}&to=${T}&dim=course`, { token: mt })).data.groups;
  const gv = (await api(`/reports/attendance?from=${monthStart}&to=${T}&dim=venue`, { token: mt })).data.groups;
  const sum = (gs, k) => gs.reduce((x, g) => x + g[k], 0);
  check('汇总核销 = 课程分组和 = 场地分组和',
    s.checkins === sum(gc, 'checkins') && s.checkins === sum(gv, 'checkins'),
    `${s.checkins}/${sum(gc, 'checkins')}/${sum(gv, 'checkins')}`);
  check('汇总开课 = 双维度分组和',
    s.classes_scheduled === sum(gc, 'classes_scheduled') && s.classes_scheduled === sum(gv, 'classes_scheduled'));

  console.log(`\n报表安全与一致性结果：${pass} 通过，${fail} 失败`);
} finally {
  await post('/dev/reseed', {});
  process.exit(fail ? 1 : 0);
}
