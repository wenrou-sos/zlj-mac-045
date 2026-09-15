// 端到端业务流冒烟测试：约课 -> 取消 -> 再约 -> 核销 -> 续费
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

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra); }
}

// 找一张剩余次数 >= 5 的有效次卡会员
const { data: allCards } = await api(`/cards?status=active`);
const usableCountCard = allCards.find(
  (c) => c.card_type === 'count' && c.remaining >= 5
);
check('找到次数充足的次卡会员', !!usableCountCard, JSON.stringify(allCards?.length));
const MEMBER = usableCountCard.member_id;
const cardId = usableCountCard.id;
const remainingBefore = usableCountCard.remaining;
console.log(`  ℹ️  会员${MEMBER} 次卡 id=${cardId} 课前剩余=${remainingBefore}`);

// 取明天起的课（距离 >2 小时，方便测取消退次），遍历直到约课成功
const tomorrow = new Date(Date.now() + 26 * 3600e3).toISOString();
const in10d = new Date(Date.now() + 10 * 86400e3).toISOString();
const { data: classes } = await api(`/classes?from=${tomorrow}&to=${in10d}`);

let target;
let bookingId;
let code;
const openClasses = classes.filter((x) => x.status === 'open' && x.booked_count < x.capacity);
for (const c of openClasses) {
  const r = await api('/bookings', { method: 'POST', body: { class_id: c.id, member_id: MEMBER } });
  if (r.status === 201) { target = c; bookingId = r.data.id; code = r.data.verify_code; break; }
}
check('约课成功返回核销码', !!code, '所有课程均不可约');
const cost = target.cost_sessions || 1;
console.log(`  ℹ️  课程「${target.title}」消耗 ${cost} 次`);

// 2. 重复约课应被拒
let r = await api('/bookings', { method: 'POST', body: { class_id: target.id, member_id: MEMBER } });
check('重复约课被拒绝 (409)', r.status === 409, JSON.stringify(r.data));

// 3. 次卡按课程消耗课次预扣
r = await api(`/members/${MEMBER}`);
let card = r.data.cards.find((c) => c.id === cardId);
check(`次卡预扣 ${cost} 次`, card.remaining === remainingBefore - cost, `${card.remaining} vs ${remainingBefore - cost}`);

// 4. 取消预约（>2h，应退次）
r = await api(`/bookings/${bookingId}/cancel`, { method: 'POST', body: { reason: '临时有事' } });
check('取消成功且退次', r.status === 200 && r.data.refund === true && r.data.refund_sessions === cost, JSON.stringify(r.data));
r = await api(`/members/${MEMBER}`);
card = r.data.cards.find((c) => c.id === cardId);
check('取消后次数全额返还', card.remaining === remainingBefore, `${card.remaining} vs ${remainingBefore}`);

// 5. 已取消的预约不能再取消
r = await api(`/bookings/${bookingId}/cancel`, { method: 'POST' });
check('重复取消被拒绝', r.status === 409, JSON.stringify(r.data));

// 6. 再次约课
r = await api('/bookings', { method: 'POST', body: { class_id: target.id, member_id: MEMBER } });
check('取消后可重新约课', r.status === 201, JSON.stringify(r.data));
bookingId = r.data.id;
const newCode = r.data.verify_code;

// 7. 核销：课不在 2 小时窗口内，应失败
r = await api('/checkins/verify', { method: 'POST', body: { code: newCode } });
check('未到核销时间被拦截', r.status === 409, JSON.stringify(r.data));

// 8. 错误核销码
r = await api('/checkins/verify', { method: 'POST', body: { code: '000000' } });
check('无效核销码被拦截', r.status === 404, JSON.stringify(r.data));

// 9. 管理端手动核销
r = await api(`/checkins/${bookingId}/check`, { method: 'POST' });
check('管理端手动核销成功', r.status === 200, JSON.stringify(r.data));
r = await api('/checkins/verify', { method: 'POST', body: { code: newCode } });
check('重复核销被拦截', r.status === 409, JSON.stringify(r.data));

// 10. 续费：给这张次卡加 10 次
r = await api(`/cards/${cardId}/renew`, {
  method: 'POST',
  body: { amount: 299, add_sessions: 10, operator: '测试员' },
});
check('次卡续费 +10 次成功', r.status === 200, JSON.stringify(r.data));
r = await api(`/members/${MEMBER}`);
card = r.data.cards.find((c) => c.id === cardId);
check('续费后总次数增加 10', card.total_sessions === usableCountCard.total_sessions + 10,
  `${card.total_sessions} vs ${usableCountCard.total_sessions + 10}`);

// 11. 期限卡续费：会员9（即将到期月卡）
const { data: d9 } = await api('/members/9');
const periodCard = d9.cards.find((c) => c.card_type === 'period');
r = await api(`/cards/${periodCard.id}/renew`, {
  method: 'POST',
  body: { amount: 268, extend_days: 30 },
});
check('期限卡续费延长 30 天', r.status === 200 && !!r.data.new_end_date, JSON.stringify(r.data));

// 12. 多课次课程：新建一节 cost=2 的课，约课 -> 整课取消，应退 2 次（不能只退 1）
{
  // 用 13:00（东八区）这个种子数据不会使用的整点，避免与随机样例课程冲突
  const futureDate = new Date(Date.now() + 4 * 86400e3);
  const pad = (n) => String(n).padStart(2, '0');
  const startIso = `${futureDate.getUTCFullYear()}-${pad(futureDate.getUTCMonth() + 1)}-${pad(futureDate.getUTCDate())}T05:00:00Z`;
  const endIso = `${futureDate.getUTCFullYear()}-${pad(futureDate.getUTCMonth() + 1)}-${pad(futureDate.getUTCDate())}T06:00:00Z`;
  const { data: newClass } = await api('/classes', {
    method: 'POST',
    body: { title: '私教小班(2课次)', coach_id: 1, venue_id: 4, start_at: startIso, end_at: endIso, capacity: 6, cost_sessions: 2 },
  });
  check('创建 cost=2 课程成功', !!newClass?.id, JSON.stringify(newClass));
  const { data: freshCards } = await api('/cards?status=active');
  const mc = freshCards.find((x) => x.card_type === 'count' && x.remaining >= 6);
  if (newClass?.id && mc) {
    const before = mc.remaining;
    let rr = await api('/bookings', { method: 'POST', body: { class_id: newClass.id, member_id: mc.member_id } });
    check('多课次约课成功', rr.status === 201, JSON.stringify(rr.data));
    let dd = (await api(`/members/${mc.member_id}`)).data.cards.find((x) => x.id === mc.id);
    check('多课次预约扣 2 次', dd.remaining === before - 2, `${dd.remaining} vs ${before - 2}`);
    rr = await api(`/classes/${newClass.id}/cancel`, { method: 'POST', body: {} });
    check('多课次整课取消成功', rr.status === 200, JSON.stringify(rr.data));
    dd = (await api(`/members/${mc.member_id}`)).data.cards.find((x) => x.id === mc.id);
    check('多课次取消后退回 2 次（次数没被吞）', dd.remaining === before, `${dd.remaining} vs ${before}`);
  }
}

// 13. 仪表盘统计
const { status: st, data: stats } = await api('/dashboard/stats');
check('仪表盘统计可访问', st === 200 && stats.members >= 20, JSON.stringify(stats));

// ---------- 场地不可用时段 / 批量排课 / 候补递补 ----------
// 东八区日期工具（与业务时区一致）
function shDate(offsetDays) {
  const sh = new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3);
  return sh.toISOString().slice(0, 10);
}
function nextWeekdayDate(dow) {
  const sh = new Date(Date.now() + 8 * 3600e3);
  const today = new Date(Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate()));
  let delta = (dow - today.getUTCDay() + 7) % 7;
  if (delta === 0) delta = 7;
  return new Date(today.getTime() + delta * 86400e3).toISOString().slice(0, 10);
}
const shTs = (dateStr, hh) => `${dateStr}T${String(hh).padStart(2, '0')}:00:00+08:00`;

// 14. 每周固定闭馆：场地4 每周三 12:00-14:00
const wed = nextWeekdayDate(3);
r = await api('/venues/blocks', {
  method: 'POST',
  body: { venue_id: 4, kind: 'weekly', weekday: 3, start_time: '12:00', end_time: '14:00', reason: '周三例行维护' },
});
check('登记每周固定闭馆时段', r.status === 201 && !!r.data.block?.id, JSON.stringify(r.data));
const weeklyBlockId = r.data.block?.id;

r = await api('/classes', {
  method: 'POST',
  body: { title: '闭馆时段测试课', coach_id: 6, venue_id: 4, start_at: shTs(wed, 13), end_at: shTs(wed, 14), capacity: 10, cost_sessions: 1 },
});
check('每周闭馆时段内排课被拦截并说明原因', r.status === 409 && /每周固定闭馆/.test(r.data.error || ''), JSON.stringify(r.data));

r = await api('/classes', {
  method: 'POST',
  body: { title: '闭馆外测试课', coach_id: 6, venue_id: 4, start_at: shTs(wed, 15), end_at: shTs(wed, 16), capacity: 10, cost_sessions: 1 },
});
check('闭馆时段外排课不受影响', r.status === 201, JSON.stringify(r.data));

// 15. 批量生成课表：落在闭馆时段的槽位被跳过并给出原因
r = await api('/classes/batch', {
  method: 'POST',
  body: { title: '批量拦截课', coach_id: 6, venue_id: 4, weekdays: [3], start_time: '13:00', duration_hours: 1, from: wed, to: shDate(14), capacity: 10, cost_sessions: 1 },
});
check('批量排课跳过闭馆槽位并说明原因',
  r.status === 200 && r.data.created === 0 && r.data.skipped === 2 && r.data.items.every((i) => /每周固定闭馆/.test(i.reason || '')),
  JSON.stringify(r.data));

r = await api('/classes/batch', {
  method: 'POST',
  body: { title: '批量正常课', coach_id: 6, venue_id: 4, weekdays: [3], start_time: '15:00', duration_hours: 1, from: shDate(15), to: shDate(28), capacity: 10, cost_sessions: 1 },
});
check('批量排课正常槽位全部生成', r.status === 200 && r.data.created === 2 && r.data.skipped === 0, JSON.stringify(r.data));

// 16. 一次性闭馆区间撞上已排课程：必须先处理（取消退次 / 改期）
const { data: futureClasses } = await api(`/classes?from=${new Date(Date.now() + 24 * 3600e3).toISOString()}&to=${new Date(Date.now() + 10 * 86400e3).toISOString()}`);
const cand = futureClasses.filter((c) => c.status === 'open' && c.venue_id && new Date(c.start_at) > new Date(Date.now() + 24 * 3600e3));
const C1 = cand[0];
check('找到可用于冲突测试的未来课程', !!C1, '没有未来课程');
const c1Start = new Date(new Date(C1.start_at).getTime() - 30 * 60000).toISOString();
const c1End = new Date(new Date(C1.end_at).getTime() + 30 * 60000).toISOString();
const blockBody = { venue_id: C1.venue_id, kind: 'once', start_at: c1Start, end_at: c1End, reason: '测试装修' };

r = await api('/venues/blocks/preview', { method: 'POST', body: blockBody });
check('预检列出时段内的已排课程', r.status === 200 && r.data.conflicts.some((c) => c.id === C1.id), JSON.stringify(r.data));
const conflicts1 = r.data.conflicts;
const expectRefund = conflicts1.reduce((s, c) => s + Number(c.booked_count), 0);

r = await api('/venues/blocks', { method: 'POST', body: blockBody });
check('未处理冲突课程时登记被拒并返回课程列表', r.status === 409 && Array.isArray(r.data.conflicts), JSON.stringify(r.data));

r = await api('/venues/blocks', {
  method: 'POST',
  body: { ...blockBody, resolutions: conflicts1.map((c) => ({ class_id: c.id, action: 'cancel' })) },
});
check('登记时段并取消冲突课程（退次）',
  r.status === 201 && r.data.canceled === conflicts1.length && r.data.refunded === expectRefund,
  JSON.stringify(r.data));
const { data: afterCancel } = await api(`/classes?from=${c1Start}&to=${c1End}`);
check('冲突课程已被取消', afterCancel.filter((c) => conflicts1.some((x) => x.id === c.id)).every((c) => c.status === 'canceled'), JSON.stringify(afterCancel.map((c) => [c.id, c.status])));

// 改期：另找一节课，登记时段时选择改期到次日凌晨 5 点（必为空档）
const C2 = cand.find((c) => !conflicts1.some((x) => x.id === c.id));
if (C2) {
  const c2Body = {
    venue_id: C2.venue_id, kind: 'once',
    start_at: new Date(new Date(C2.start_at).getTime() - 30 * 60000).toISOString(),
    end_at: new Date(new Date(C2.end_at).getTime() + 30 * 60000).toISOString(),
    reason: '测试改期',
  };
  const pv = await api('/venues/blocks/preview', { method: 'POST', body: c2Body });
  const conflicts2 = pv.data.conflicts || [];
  const moveDate = shDate(11); // 课程在未来 10 天内，+11 天凌晨必为空档
  r = await api('/venues/blocks', {
    method: 'POST',
    body: {
      ...c2Body,
      resolutions: conflicts2.map((c) => c.id === C2.id
        ? { class_id: c.id, action: 'move', start_at: shTs(moveDate, 5), end_at: shTs(moveDate, 6) }
        : { class_id: c.id, action: 'cancel' }),
    },
  });
  check('登记时段并改期冲突课程', r.status === 201 && r.data.moved === 1, JSON.stringify(r.data));
  const { data: afterMove } = await api(`/classes?from=${encodeURIComponent(shTs(moveDate, 0))}&to=${encodeURIComponent(shTs(moveDate, 23))}`);
  const moved = afterMove.find((c) => c.id === C2.id);
  check('改期后的课程时间已生效',
    !!moved && new Date(moved.start_at).getTime() === new Date(shTs(moveDate, 5)).getTime(),
    JSON.stringify(moved || {}));
} else {
  check('改期测试：找到第二节冲突课程', false, '课程不足');
}

// 17. 候补递补：满员课 -> 候补 -> 取消后自动递补
const { data: activeCards } = await api('/cards?status=active');
const cardB = activeCards.find((c) => c.card_type === 'count' && c.member_id !== MEMBER);
check('找到候补测试用的第二位会员', !!cardB, '卡不足');
// 先给这张卡续 10 次，避免种子数据随机扣次影响候补测试
await api(`/cards/${cardB.id}/renew`, { method: 'POST', body: { amount: 100, add_sessions: 10, operator: '测试员' } });
const cardBBefore = (await api(`/members/${cardB.member_id}`)).data.cards.find((c) => c.id === cardB.id).remaining;
const day14 = shDate(14);
const day15 = shDate(15);

let w1;
r = await api('/classes', {
  method: 'POST',
  body: { title: '候补测试课1', coach_id: 6, venue_id: 4, start_at: shTs(day14, 17), end_at: shTs(day14, 18), capacity: 1, cost_sessions: 1 },
});
check('创建 1 人容量测试课', r.status === 201, JSON.stringify(r.data));
w1 = r.data.id;

r = await api('/bookings', { method: 'POST', body: { class_id: w1, member_id: MEMBER } });
check('首位会员约满课程', r.status === 201, JSON.stringify(r.data));
const w1Booking = r.data.id;

r = await api('/bookings', { method: 'POST', body: { class_id: w1, member_id: cardB.member_id } });
check('满员后预约被拦截', r.status === 409, JSON.stringify(r.data));

r = await api('/waitlists', { method: 'POST', body: { class_id: w1, member_id: cardB.member_id } });
check('满员课加入候补', r.status === 201 && r.data.status === 'waiting', JSON.stringify(r.data));
r = await api('/waitlists', { method: 'POST', body: { class_id: w1, member_id: cardB.member_id } });
check('重复候补被拦截', r.status === 409, JSON.stringify(r.data));

r = await api(`/bookings/${w1Booking}/cancel`, { method: 'POST', body: {} });
check('取消预约后候补自动递补', r.status === 200 && r.data.promotion?.promoted?.member_id === cardB.member_id, JSON.stringify(r.data));
r = await api(`/members/${cardB.member_id}`);
const cardBNow = r.data.cards.find((c) => c.id === cardB.id);
check('递补成功并预扣课次', cardBNow.remaining === cardBBefore - 1, `${cardBNow.remaining} vs ${cardBBefore - 1}`);
r = await api(`/waitlists?class_id=${w1}`);
check('候补状态更新为已递补', r.data[0]?.status === 'promoted', JSON.stringify(r.data));

// 18. 场地整停：预约与递补都被拦截并说明原因；恢复后可手动递补
let w2;
r = await api('/classes', {
  method: 'POST',
  body: { title: '候补测试课2', coach_id: 6, venue_id: 4, start_at: shTs(day15, 17), end_at: shTs(day15, 18), capacity: 1, cost_sessions: 1 },
});
check('创建第二节 1 人容量测试课', r.status === 201, JSON.stringify(r.data));
w2 = r.data.id;
r = await api('/bookings', { method: 'POST', body: { class_id: w2, member_id: MEMBER } });
const w2Booking = r.data.id;
r = await api('/waitlists', { method: 'POST', body: { class_id: w2, member_id: cardB.member_id } });
check('第二节课加入候补', r.status === 201, JSON.stringify(r.data));

const { data: venueList } = await api('/venues');
const v4 = venueList.find((v) => v.id === 4);
r = await api('/venues/4', { method: 'PUT', body: { name: v4.name, capacity: v4.capacity, location: v4.location, status: 'closed' } });
check('场地整停开关关闭', r.status === 200, JSON.stringify(r.data));

r = await api(`/bookings/${w2Booking}/cancel`, { method: 'POST', body: {} });
check('场地停用期间取消预约不递补并说明原因',
  r.status === 200 && !r.data.promotion?.promoted && /停用/.test(r.data.promotion?.note || ''),
  JSON.stringify(r.data));

const cardC = activeCards.find((c) => c.card_type === 'period' && c.member_id !== MEMBER && c.member_id !== cardB.member_id);
r = await api('/bookings', { method: 'POST', body: { class_id: w2, member_id: cardC.member_id } });
check('场地停用期间预约被拦截并说明原因', r.status === 409 && /场地/.test(r.data.error || ''), JSON.stringify(r.data));

r = await api('/venues/4', { method: 'PUT', body: { name: v4.name, capacity: v4.capacity, location: v4.location, status: 'open' } });
check('场地恢复开放', r.status === 200, JSON.stringify(r.data));
r = await api('/waitlists/promote', { method: 'POST', body: { class_id: w2 } });
check('恢复开放后手动递补成功', r.status === 200 && r.data.promoted?.member_id === cardB.member_id, JSON.stringify(r.data));

// 19. 删除不可用时段后恢复可排课
r = await api(`/venues/blocks/${weeklyBlockId}`, { method: 'DELETE' });
check('删除每周固定闭馆时段', r.status === 200, JSON.stringify(r.data));
r = await api('/classes', {
  method: 'POST',
  body: { title: '解除后测试课', coach_id: 6, venue_id: 4, start_at: shTs(shDate(21), 13), end_at: shTs(shDate(21), 14), capacity: 10, cost_sessions: 1 },
});
check('删除时段后该时段恢复可排课', r.status === 201, JSON.stringify(r.data));

// 20. 场地 7 天可用性视图
r = await api('/venues/week');
check('场地 7 天视图返回每天课程与不可用段',
  r.status === 200 && r.data.days?.length === 7 && r.data.venues?.length >= 5
    && r.data.venues.some((v) => v.blocks.length > 0),
  JSON.stringify({ days: r.data.days?.length, venues: r.data.venues?.length }));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
