// 周课模板端到端冒烟测试：
// 模板维护 -> 批量生成（跳过冲突/闭馆/不可用/过期）-> 重复生成幂等补缺 -> 批次撤回退次
const BASE = process.env.API || 'http://localhost:4000/api';

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra); }
}

// 干净起点
await api('/dev/reseed', { method: 'POST' });
console.log('— 周课模板全流程 —');

// 1. 模板参数校验
let r = await api('/class-templates', { method: 'POST', body: { title: '坏模板', weekday: 9, start_time: '10:00', duration_minutes: 60, capacity: 10 } });
check('非法星期被拒 (400)', r.status === 400, JSON.stringify(r.data));

r = await api('/class-templates', { method: 'POST', body: { title: '超容量', weekday: 1, start_time: '10:00', duration_minutes: 60, capacity: 999, venue_id: 2 } });
check('容量超场地上限被拒 (409)', r.status === 409, JSON.stringify(r.data));

// 2. 取一个未来周一，避免“过期”干扰：取今天起 14 天后所在周的周一
function isoDay(d) { return new Date(d - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
const future = new Date(Date.now() + 14 * 86400e3);
const dow = (future.getDay() + 6) % 7;
future.setDate(future.getDate() - dow);
const monday = isoDay(future);
const tuesday = isoDay(new Date(future.getTime() + 86400e3));
const wednesday = isoDay(new Date(future.getTime() + 2 * 86400e3));
const friday = isoDay(new Date(future.getTime() + 4 * 86400e3));
console.log(`  ℹ️  测试周：周一起 ${monday}`);

// 3. 建一个专属模板（周一 09:00，教练1/场地4，1小时，容量6，消耗2）
r = await api('/class-templates', { method: 'POST', body: {
  title: '模板冒烟-高阶塑形', weekday: 1, start_time: '09:00', duration_minutes: 60,
  coach_id: 1, venue_id: 4, capacity: 6, cost_sessions: 2,
} });
check('创建模板成功', r.status === 201, JSON.stringify(r.data));
const TPL = r.data.id;

// 4. 制造场地冲突：在同一时段（该周一 09:00 = UTC 01:00）手工占一节别的课
const occ = await api('/classes', { method: 'POST', body: {
  title: '占位课', coach_id: 2, venue_id: 4,
  start_at: `${monday}T01:00:00Z`, end_at: `${monday}T02:00:00Z`, capacity: 6,
} });
check('占位课创建成功', occ.status === 201, JSON.stringify(occ.data));

// 5. 登记场地当天闭馆（周三，场地4）
const blk = await api('/venues/unavailable', { method: 'POST', body: {
  venue_id: 4, start_date: wednesday, end_date: wednesday,
  start_time: '00:00', end_time: '23:59', reason: '冒烟测试-闭馆',
} });
check('登记全天闭馆成功', blk.status === 201, JSON.stringify(blk.data));

// 6. 登记场地部分时段不可用：给场地2（瑜伽室）周二 08:00-10:00，
//    再建一个周二 09:00 用场地2 的模板，应命中 venue_unavailable
const tpl2 = await api('/class-templates', { method: 'POST', body: {
  title: '模板冒烟-瑜伽', weekday: 2, start_time: '09:00', duration_minutes: 60,
  coach_id: 2, venue_id: 2, capacity: 10, cost_sessions: 1,
} });
check('创建周二瑜伽模板成功', tpl2.status === 201, JSON.stringify(tpl2.data));
const blk2 = await api('/venues/unavailable', { method: 'POST', body: {
  venue_id: 2, start_date: tuesday, end_date: tuesday,
  start_time: '08:00', end_time: '10:00', reason: '冒烟测试-地面保养',
} });
check('登记部分时段不可用成功', blk2.status === 201, JSON.stringify(blk2.data));

// 周三 09:00 用场地4 的模板：命中“场地当天整体关闭”
const tplWed = await api('/class-templates', { method: 'POST', body: {
  title: '模板冒烟-周三单车', weekday: 3, start_time: '09:00', duration_minutes: 60,
  coach_id: 3, venue_id: 4, capacity: 10, cost_sessions: 1,
} });
check('创建周三闭馆模板成功', tplWed.status === 201, JSON.stringify(tplWed.data));

// 7. 教练冲突模板：周五 09:00 教练1 场地5；同周先用 教练1 在该时段场地4 占位
const coachOcc = await api('/classes', { method: 'POST', body: {
  title: '教练占位', coach_id: 1, venue_id: 4,
  start_at: `${friday}T01:00:00Z`, end_at: `${friday}T02:00:00Z`, capacity: 6,
} });
check('教练占位课创建成功', coachOcc.status === 201, JSON.stringify(coachOcc.data));
const tpl3 = await api('/class-templates', { method: 'POST', body: {
  title: '模板冒烟-私教', weekday: 5, start_time: '09:00', duration_minutes: 60,
  coach_id: 1, venue_id: 5, capacity: 6, cost_sessions: 1,
} });
check('创建周五教练冲突模板成功', tpl3.status === 201, JSON.stringify(tpl3.data));

// 8. 只针对这四个模板生成 1 周
r = await api('/class-templates/generate', { method: 'POST', body: {
  week_start: monday, weeks: 1, template_ids: [TPL, tpl2.data.id, tplWed.data.id, tpl3.data.id],
} });
check('生成请求成功', r.status === 201, JSON.stringify(r.data));
const gen = r.data;
const skipCodes = gen.skipped.map((s) => s.code);
check('四节课全部被跳过（冲突/闭馆/不可用/教练冲突）', gen.created.length === 0, JSON.stringify({ c: gen.created.length, s: skipCodes }));
check('跳过原因含 venue_conflict（场地冲突）', skipCodes.includes('venue_conflict'), skipCodes.join(','));
check('跳过原因含 venue_day_closed（全天闭馆）', skipCodes.includes('venue_day_closed'), skipCodes.join(','));
check('跳过原因含 venue_unavailable（部分时段不可用）', skipCodes.includes('venue_unavailable'), skipCodes.join(','));
check('跳过原因含 coach_conflict（教练冲突）', skipCodes.includes('coach_conflict'), skipCodes.join(','));
const BATCH = gen.batch_id;
check('每条跳过都带中文原因', gen.skipped.every((s) => s.reason && s.reason.length > 6), JSON.stringify(gen.skipped));

// 9. 移除场地占位课，重新生成 -> 应只补一节（周一塑形），其余仍跳过
await api(`/classes/${occ.data.id}/cancel`, { method: 'POST', body: { reason: '腾位' } });
r = await api('/class-templates/generate', { method: 'POST', body: {
  week_start: monday, weeks: 1, template_ids: [TPL, tpl2.data.id, tplWed.data.id, tpl3.data.id],
} });
check('撤掉占位后补排 1 节', r.data.created.length === 1 && r.data.created[0].template_id === TPL,
  JSON.stringify(r.data.created.map((x) => x.template_id)));
const newClassId = r.data.created[0].class_id;
check('其余 3 节仍跳过（闭馆/不可用/教练冲突）', r.data.skipped.length === 3, String(r.data.skipped.length));

// 10. 再次生成：幂等，不应再新增，塑形计入已存在
r = await api('/class-templates/generate', { method: 'POST', body: {
  week_start: monday, weeks: 1, template_ids: [TPL, tpl2.data.id, tplWed.data.id, tpl3.data.id],
} });
check('第三次生成零新增（幂等）', r.data.created.length === 0, JSON.stringify(r.data.created));
check('塑形课计入已存在 1 节', r.data.existing.length === 1 && r.data.existing[0].class_id === newClassId,
  JSON.stringify(r.data.existing));

// 11. 课程可反查模板来源
r = await api(`/classes?from=${monday}T00:00:00Z&to=${monday}T23:59:59Z`);
const genCls = r.data.find((c) => c.id === newClassId);
check('课程带 template_title 来源', genCls && genCls.template_title === '模板冒烟-高阶塑形', JSON.stringify(genCls));
check('课程带 generation_batch_id', genCls && !!genCls.generation_batch_id);

// 12. 批次撤回（含退次）：先给补排课约一位次卡学员
const cards = (await api('/cards?status=active')).data;
const cc = cards.find((x) => x.card_type === 'count' && x.remaining >= 2) || cards.find((x) => x.card_type === 'count' && x.remaining >= 1);
check('找到可用次卡会员', !!cc, JSON.stringify(cards?.length));
const memberId = cc.member_id;
const before = (await api(`/members/${memberId}`)).data.cards.find((x) => x.id === cc.id).remaining;
const book = await api('/bookings', { method: 'POST', body: { class_id: newClassId, member_id: memberId } });
check('约课成功', book.status === 201, JSON.stringify(book.data));
const afterBook = (await api(`/members/${memberId}`)).data.cards.find((x) => x.id === cc.id).remaining;
const cost = genCls.cost_sessions;
check(`预约按消耗课次扣 ${cost} 次`, afterBook === before - cost, `${afterBook} vs ${before - cost}`);

// 撤回第一次生成批次（全是跳过，created=0，应提示无可撤回课程）
r = await api(`/class-templates/batches/${BATCH}/revoke`, { method: 'POST', body: {} });
check('无有效课的批次撤回被拒 (400)', r.status === 400, JSON.stringify(r.data));

// 撤回真正含课的批次
const realBatch = (await api('/class-templates/batches')).data.find((b) => b.active_classes > 0);
check('找到含有效课的批次', !!realBatch, JSON.stringify((await api('/class-templates/batches')).data.length));
r = await api(`/class-templates/batches/${realBatch.id}/revoke`, { method: 'POST', body: { reason: '冒烟撤回' } });
check('整批撤回成功', r.status === 200, JSON.stringify(r.data));
check('撤回取消了含预约的课且退次', r.data.refunded_sessions >= cost && r.data.affected_bookings >= 1,
  JSON.stringify({ refund: r.data.refunded_sessions, bookings: r.data.affected_bookings }));
const afterRevoke = (await api(`/members/${memberId}`)).data.cards.find((x) => x.id === cc.id).remaining;
check('撤回后次数恢复', afterRevoke === before, `${afterRevoke} vs ${before}`);

// 重复撤回
r = await api(`/class-templates/batches/${realBatch.id}/revoke`, { method: 'POST', body: {} });
check('重复撤回被拒 (409)', r.status === 409, JSON.stringify(r.data));

// 13. 撤回后该周重新生成可把课补回
r = await api('/class-templates/generate', { method: 'POST', body: {
  week_start: monday, weeks: 1, template_ids: [TPL],
} });
check('撤回后可重新补排该模板课', r.data.created.length === 1, JSON.stringify(r.data.created));

// 14. 删除“仍被引用”的模板应转停用
r = await api(`/class-templates/${TPL}`, { method: 'DELETE' });
check('被引用模板删除返回 409 并停用', r.status === 409 && r.data.deactivated === true, JSON.stringify(r.data));
const tplRow = (await api('/class-templates')).data.find((x) => x.id === TPL);
check('模板状态变为 inactive', tplRow.status === 'inactive', tplRow.status);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
