// 候补队列端到端冒烟测试：
// 满员候补 -> 取消自动递补（顺序+卡校验跳过）-> 确认 -> 逾期自动放弃并继续递补 -> 主动放弃 -> 整课取消关闭
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
const pad = (n) => String(n).padStart(2, '0');

// 创建一节测试课，自动尝试多个冷门时段，避开随机种子课的教练/场地冲突
async function createClass({ title, coach_id, venue_id, day, hhUTC, capacity, cost }) {
  const slots = [];
  for (const dayOff of [day, day + 1]) {
    const dd = new Date(Date.now() + dayOff * 86400e3);
    const ds = `${dd.getUTCFullYear()}-${pad(dd.getUTCMonth() + 1)}-${pad(dd.getUTCDate())}`;
    for (const [h, m] of [[hhUTC, 0], [hhUTC, 30], [hhUTC + 2, 15]]) slots.push([ds, h, m]);
  }
  let last;
  for (const [ds, h, m] of slots) {
    const s = `${ds}T${pad(h)}:${pad(m)}:00Z`;
    const e = `${ds}T${pad(h + 1)}:${pad(m)}:00Z`;
    const r = await api('/classes', { method: 'POST', body: {
      title, coach_id, venue_id, start_at: s, end_at: e, capacity, cost_sessions: cost,
    } });
    if (r.status === 201) return r.data;
    last = r;
  }
  throw new Error('测试课创建失败：' + JSON.stringify(last?.data));
}

console.log('— 场景 1：满员 2 人的课，队首次数不足被跳过，第二位自动递补 —');

// 找一张次数充足的次卡会员做预约人；member16(剩1次) 做"次数不足"队首；再找一个有效卡会员排队尾
const { data: cards } = await api('/cards?status=active');
const rich = cards.find((c) => c.card_type === 'count' && c.remaining >= 3);
check('找到次数充足的次卡会员', !!rich);
// 第二个占坑会员用期限卡会员
const periodMembers = cards.filter((c) => c.card_type === 'period').map((c) => c.member_id)
  .filter((m) => ![16, rich.member_id].includes(m));
const holder2 = periodMembers[0];
const tail = periodMembers[1]; // 应被递补
check('测试会员不重复', holder2 !== tail && tail !== 16 && tail !== rich.member_id,
  JSON.stringify({ rich: rich.member_id, holder2, tail }));

let r = { status: 201, data: await createClass({
  title: '候补测试课', coach_id: 1, venue_id: 4, day: 5, hhUTC: 2, capacity: 2, cost: 2,
}) };
check('创建容量 2、消耗 2 次的课成功', r.status === 201, JSON.stringify(r.data));
const cid = r.data.id;

r = await api('/bookings', { method: 'POST', body: { class_id: cid, member_id: rich.member_id } });
check('会员A 预约成功', r.status === 201, JSON.stringify(r.data));
const bookingA = r.data.id;
r = await api('/bookings', { method: 'POST', body: { class_id: cid, member_id: holder2 } });
check('会员B 预约成功（满员）', r.status === 201, JSON.stringify(r.data));

r = await api('/bookings', { method: 'POST', body: { class_id: cid, member_id: 16 } });
check('满员后直接约课被拒绝并提示候补', r.status === 409 && /候补/.test(r.data.error), JSON.stringify(r.data));

r = await api('/waitlists', { method: 'POST', body: { class_id: cid, member_id: 16 } });
check('剩 1 次的会员 16 加入候补第 1 位', r.status === 201 && r.data.queue_position === 1, JSON.stringify(r.data));
const w16 = r.data.id;

r = await api('/waitlists', { method: 'POST', body: { class_id: cid, member_id: tail } });
check('会员 C 加入候补第 2 位', r.status === 201 && r.data.queue_position === 2, JSON.stringify(r.data));
const wTail = r.data.id;

r = await api('/waitlists', { method: 'POST', body: { class_id: cid, member_id: 16 } });
check('重复加入候补被拒绝', r.status === 409, JSON.stringify(r.data));

// 会员A取消 -> 空 1 个名额 -> 会员16次数不足被跳过，tail 被递补
r = await api(`/bookings/${bookingA}/cancel`, { method: 'POST', body: {} });
check('取消释放名额，自动递补 1 人', r.status === 200 && r.data.waitlist_promoted === 1, JSON.stringify(r.data));

r = await api('/waitlists?class_id=' + cid);
const waits = r.data;
const w16Now = waits.find((x) => x.id === w16);
const wTailNow = waits.find((x) => x.id === wTail);
check('次数不足的队首仍排队中且记录跳过原因',
  w16Now.status === 'waiting' && /次数不足/.test(w16Now.skip_reason || ''), JSON.stringify(w16Now));
check('第二位会员自动转正待确认', wTailNow.status === 'promoted' && !!wTailNow.booking_id && !!wTailNow.confirm_deadline,
  JSON.stringify(wTailNow));

// 候补列表里看到排队顺序
check('跳过者仍显示第 1 位', w16Now.queue_position === 1, String(w16Now.queue_position));

console.log('— 场景 2：确认转正 —');
r = await api(`/waitlists/${wTail}/confirm`, { method: 'POST', body: {} });
check('确认转正成功并返回核销码', r.status === 200 && !!r.data.verify_code, JSON.stringify(r.data));
r = await api(`/waitlists/${wTail}/confirm`, { method: 'POST', body: {} });
check('重复确认被拒绝', r.status === 409, JSON.stringify(r.data));

// 预约记录带来源标记
r = await api(`/bookings?class_id=${cid}`);
const promotedBooking = r.data.find((b) => b.id === wTailNow.booking_id);
check('转正预约 source=waitlist', promotedBooking?.source === 'waitlist', JSON.stringify(promotedBooking?.source));

console.log('— 场景 3：主动放弃排队（不涉及预扣）—');
r = await api(`/waitlists/${w16}/abandon`, { method: 'POST', body: {} });
check('排队中会员主动放弃成功', r.status === 200, JSON.stringify(r.data));
r = await api(`/waitlists/${w16}/abandon`, { method: 'POST', body: {} });
check('已放弃的不能再放弃', r.status === 409, JSON.stringify(r.data));

console.log('— 场景 4：候补转正后逾期未确认 -> 自动放弃退次并继续递补下一位 —');

// 新建容量 1 的课：1 个占坑 + 次卡会员排第 1 + 期限卡会员排第 2
const rich2 = cards.find((c) => c.card_type === 'count' && c.member_id !== rich.member_id && c.remaining >= 1);
if (rich2) {
  const holder = cards.find((c) => c.card_type === 'period' && ![tail, 16, rich2.member_id].includes(c.member_id));
  const second = cards.find((c) => c.card_type === 'period' && ![tail, 16, rich2.member_id, holder.member_id].includes(c.member_id));
  r = { status: 201, data: await createClass({
    title: '候补逾期测试课', coach_id: 2, venue_id: 2, day: 6, hhUTC: 6, capacity: 1, cost: 1,
  }) };
  const class2 = r.data.id;
  check('创建容量 1 的课成功', r.status === 201, JSON.stringify(r.data));
  r = await api('/bookings', { method: 'POST', body: { class_id: class2, member_id: holder.member_id } });
  const holdId = r.data.id;
  check('占坑会员预约成功', r.status === 201, JSON.stringify(r.data));

  const before = rich2.remaining;
  r = await api('/waitlists', { method: 'POST', body: { class_id: class2, member_id: rich2.member_id } });
  check('次卡会员排候补第 1 位', r.status === 201 && r.data.queue_position === 1, JSON.stringify(r.data));
  const wRich = r.data.id;
  r = await api('/waitlists', { method: 'POST', body: { class_id: class2, member_id: second.member_id } });
  check('期限卡会员排候补第 2 位', r.status === 201 && r.data.queue_position === 2, JSON.stringify(r.data));
  const wSecond = r.data.id;

  r = await api(`/bookings/${holdId}/cancel`, { method: 'POST', body: {} });
  check('取消后自动递补队首 1 人', r.data.waitlist_promoted === 1, JSON.stringify(r.data));

  r = await api(`/members/${rich2.member_id}`);
  let card = r.data.cards.find((x) => x.id === rich2.id);
  check('转正时已预扣 1 次', card.remaining === before - 1, `${card.remaining} vs ${before - 1}`);

  // 模拟逾期未确认：立即触发超时 -> 自动放弃退次，并级联递补给第 2 位
  r = await api(`/waitlists/${wRich}/dev-expire`, { method: 'POST', body: {} });
  check('逾期扫描执行', r.status === 200, JSON.stringify(r.data));

  r = await api(`/waitlists?class_id=${class2}`);
  const richRow = r.data.find((x) => x.id === wRich);
  const secondRow = r.data.find((x) => x.id === wSecond);
  check('队首逾期后状态为 expired', richRow.status === 'expired', JSON.stringify(richRow));
  check('名额自动级联递补给第 2 位（promoted）', secondRow.status === 'promoted' && !!secondRow.booking_id,
    JSON.stringify(secondRow));

  r = await api(`/members/${rich2.member_id}`);
  card = r.data.cards.find((x) => x.id === rich2.id);
  check('逾期放弃后退还预扣次数', card.remaining === before, `${card.remaining} vs ${before}`);

  r = await api(`/waitlists/${wSecond}/confirm`, { method: 'POST', body: {} });
  check('第二位在截止时间内确认成功', r.status === 200, JSON.stringify(r.data));
}

console.log('— 场景 5：整课取消关闭候补队列 —');
{
  const from = new Date(Date.now() + 4 * 86400e3).toISOString();
  const to = new Date(Date.now() + 12 * 86400e3).toISOString();
  const cls = (await api(`/classes?from=${from}&to=${to}`)).data.find((x) => x.id === cid);
  check('课表查询返回候补人数', typeof cls.waiting_count === 'number' && typeof cls.promoted_count === 'number',
    JSON.stringify(cls && { w: cls.waiting_count, p: cls.promoted_count }));
  r = await api(`/classes/${cid}/cancel`, { method: 'POST', body: {} });
  check('整课取消返回候补处理数', r.status === 200 && r.data.waitlists >= 0, JSON.stringify(r.data));
  r = await api(`/waitlists?class_id=${cid}`);
  const open = r.data.filter((x) => ['waiting', 'promoted'].includes(x.status));
  check('整课取消后无进行中候补', open.length === 0, JSON.stringify(open.map((x) => x.status)));

  // 新建一节「满员+排队候补」的课再整课取消，验证排队中的候补被关闭并留痕
  // 自动选冷门时段，避免教练/场地冲突
  r = { status: 201, data: await createClass({
    title: '整课取消测试', coach_id: 3, venue_id: 3, day: 7, hhUTC: 9, capacity: 1, cost: 1,
  }) };
  const cidX = r.data.id;
  const h = cards.find((c) => c.card_type === 'period' && c.member_id !== tail);
  r = await api('/bookings', { method: 'POST', body: { class_id: cidX, member_id: h.member_id } });
  check('占坑预约成功', r.status === 201, JSON.stringify(r.data));
  const q = cards.find((c) => c.card_type === 'period' && c.member_id !== h.member_id && c.member_id !== tail);
  r = await api('/waitlists', { method: 'POST', body: { class_id: cidX, member_id: q.member_id } });
  check('满员后加入排队', r.status === 201, JSON.stringify(r.data));
  const wQ = r.data.id;

  r = await api(`/classes/${cidX}/cancel`, { method: 'POST', body: {} });
  check('整课取消含 1 条候补', r.status === 200 && r.data.waitlists === 1, JSON.stringify(r.data));
  r = await api(`/waitlists?class_id=${cidX}`);
  const qRow = r.data.find((x) => x.id === wQ);
  check('排队中候补被置为 closed 且保留可查', qRow.status === 'closed' && /整课取消/.test(qRow.result_note),
    JSON.stringify(qRow && { status: qRow.status, note: qRow.result_note }));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
