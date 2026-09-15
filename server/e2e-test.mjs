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
  const futureDate = new Date(Date.now() + 4 * 86400e3);
  const pad = (n) => String(n).padStart(2, '0');
  const startIso = `${futureDate.getUTCFullYear()}-${pad(futureDate.getUTCMonth() + 1)}-${pad(futureDate.getUTCDate())}T02:00:00Z`;
  const endIso = `${futureDate.getUTCFullYear()}-${pad(futureDate.getUTCMonth() + 1)}-${pad(futureDate.getUTCDate())}T03:00:00Z`;
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

// ================= 请假 / 改派 / 课时结算 =================
// 业务时区（Asia/Shanghai）某天 hh:mm 的 ISO 时间
const bizDay = (offset, hh = 0, mm = 0) => {
  const sh = new Date(Date.now() + 8 * 3600e3);
  sh.setUTCDate(sh.getUTCDate() + offset);
  const y = sh.getUTCFullYear();
  const m = String(sh.getUTCMonth() + 1).padStart(2, '0');
  const d = String(sh.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`;
};
// 上个月账期（结算规则：只能出已完整结束的月份）
const prevD = new Date(); prevD.setDate(1); prevD.setMonth(prevD.getMonth() - 1);
const PERIOD = `${prevD.getFullYear()}-${String(prevD.getMonth() + 1).padStart(2, '0')}`;
const thisPeriod = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`; })();

// 14. 撞课校验：+13 天排两节时间重叠的课，把课A改派给已有课的教练
await api('/schedules', { method: 'POST', body: { coach_id: 5, work_date: bizDay(13).slice(0, 10), start_time: '09:00', end_time: '17:00', shift_type: 'normal' } });
r = await api('/classes', { method: 'POST', body: { title: '撞课测试A', coach_id: 1, venue_id: 1, start_at: bizDay(13, 10), end_at: bizDay(13, 11), capacity: 10 } });
const classA = r.data.id;
r = await api('/classes', { method: 'POST', body: { title: '撞课测试B', coach_id: 5, venue_id: 2, start_at: bizDay(13, 10, 30), end_at: bizDay(13, 11, 30), capacity: 10 } });
const classB = r.data.id;
check('构造两节重叠课成功', !!classA && !!classB, JSON.stringify(r.data));
r = await api(`/classes/${classA}/reassign`, { method: 'POST', body: { to_coach_id: 5 } });
check('撞课改派被拦截 (409)', r.status === 409 && r.data.error.includes('撞课'), JSON.stringify(r.data));

// 15. 代课教练自己在请假 -> 409（样例数据：张猛 +2~+3 天请假中）
r = await api('/classes', { method: 'POST', body: { title: '请假冲突测试', start_at: bizDay(2, 15), end_at: bizDay(2, 16), capacity: 10 } });
const classC = r.data.id;
r = await api(`/classes/${classC}/reassign`, { method: 'POST', body: { to_coach_id: 3 } });
check('代课人请假中被拦截 (409)', r.status === 409 && r.data.error.includes('请假'), JSON.stringify(r.data));

// 16. 请假时段重叠登记 -> 409
r = await api('/leaves', { method: 'POST', body: { coach_id: 3, start_at: bizDay(2, 12), end_at: bizDay(4, 12), reason: '重叠测试' } });
check('请假重叠被拦截 (409)', r.status === 409, JSON.stringify(r.data));

// 17. 登记请假 -> 返回受影响课程；随后销假
r = await api('/leaves', { method: 'POST', body: { coach_id: 4, start_at: bizDay(11, 0), end_at: bizDay(12, 23, 59), reason: '年假' } });
check('登记请假成功并返回受影响课程', r.status === 201 && Array.isArray(r.data.affected), JSON.stringify(r.data));
const leave4 = r.data.leave?.id;
r = await api(`/leaves/${leave4}/cancel`, { method: 'POST' });
check('销假成功', r.status === 200, JSON.stringify(r.data));
r = await api(`/leaves/${leave4}/cancel`, { method: 'POST' });
check('重复销假被拦截 (409)', r.status === 409, JSON.stringify(r.data));

// 18. 生成上月结算单：分类齐全、请假时段课程不计费
r = await api('/settlements', { method: 'POST', body: { period: PERIOD } });
check(`生成 ${PERIOD} 结算单`, r.status === 201 && r.data.batch.class_count > 0, JSON.stringify(r.data));
r = await api(`/settlements/${PERIOD}`);
const cats = new Set(r.data.items.map((i) => i.category));
check('分类含正常/代课/取消/未到店/请假不计费',
  ['normal', 'substitute', 'canceled', 'no_show', 'leave_excluded'].every((c) => cats.has(c)),
  [...cats].join(','));
const wl = r.data.summary.find((s) => s.coach_name === '王磊');
check('王磊请假时段课程不计入收入', wl.leave_excluded.count >= 1, JSON.stringify(wl));

// 19. 结算锁定：取消/改派/补排课均被拦截
const lockedClass = r.data.items.find((i) => i.class_id && i.category === 'normal');
let rr = await api(`/classes/${lockedClass.class_id}/cancel`, { method: 'POST', body: {} });
check('锁定课程取消被拦截 (409)', rr.status === 409, JSON.stringify(rr.data));
rr = await api(`/classes/${lockedClass.class_id}/reassign`, { method: 'POST', body: { to_coach_id: 2 } });
check('锁定课程改派被拦截 (409)', rr.status === 409, JSON.stringify(rr.data));
rr = await api('/classes', { method: 'POST', body: { title: '补排测试', coach_id: 1, venue_id: 1, start_at: `${PERIOD}-15T10:00:00+08:00`, end_at: `${PERIOD}-15T11:00:00+08:00`, capacity: 10 } });
check('已结算时段排课被拦截 (409)', rr.status === 409, JSON.stringify(rr.data));

// 20. 调整记录：创建后待冲抵；金额为 0 被拦截
rr = await api('/settlements/adjustments', { method: 'POST', body: { coach_id: 1, class_id: lockedClass.class_id, amount: -150, reason: '测试扣减：该课实际未上满' } });
check('创建调整记录（待冲抵）', rr.status === 201 && rr.data.status === 'pending', JSON.stringify(rr.data));
rr = await api('/settlements/adjustments', { method: 'POST', body: { coach_id: 2, amount: 0, reason: '金额为0测试' } });
check('调整金额为 0 被拦截 (400)', rr.status === 400, JSON.stringify(rr.data));

// 21. 重复出单 / 未结束月份出单均被拦截
rr = await api('/settlements', { method: 'POST', body: { period: PERIOD } });
check('重复出单被拦截 (409)', rr.status === 409, JSON.stringify(rr.data));
rr = await api('/settlements', { method: 'POST', body: { period: thisPeriod } });
check('未结束月份被拦截 (400)', rr.status === 400, JSON.stringify(rr.data));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
