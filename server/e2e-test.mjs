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

// 14. 维修工单：开工单 -> 重复报修拦截 -> 派单 -> 完工恢复正常 -> 报废留痕
{
  // 找一台正常且无未完成工单的器械（用台账数据）
  const { data: equipList } = await api('/venues/equipment/all?status=normal');
  const eq = equipList.find((e) => !e.has_open_order);
  check('找到可报修的正常器械', !!eq, JSON.stringify(equipList?.length));

  let rr = await api('/repair-orders', {
    method: 'POST',
    body: { equipment_id: eq.id, reporter: 'e2e测试员', fault_desc: '测试故障-异响' },
  });
  check('开工单成功（默认待派单）', rr.status === 201 && rr.data.status === 'pending', JSON.stringify(rr.data));
  const orderId = rr.data.id;

  rr = await api('/repair-orders', {
    method: 'POST',
    body: { equipment_id: eq.id, reporter: 'e2e测试员', fault_desc: '重复报修' },
  });
  check('同一器械重复报修被拒绝', rr.status === 409, JSON.stringify(rr.data));

  const during = await api(`/venues/equipment/all?venue_id=${eq.venue_id}`);
  check('开工单后器械自动变为维修中', during.data.find((x) => x.id === eq.id)?.status === 'maintenance');

  rr = await api(`/repair-orders/${orderId}/dispatch`, { method: 'POST', body: { assignee: '李师傅' } });
  check('派单成功', rr.status === 200 && rr.data.status === 'processing', JSON.stringify(rr.data));

  rr = await api(`/repair-orders/${orderId}/complete`, {
    method: 'POST', body: { cost: 188.5, repair_result: '更换零件' },
  });
  check('完工登记费用成功', rr.status === 200 && rr.data.status === 'done'
    && Number(rr.data.cost) === 188.5 && !!rr.data.completed_at, JSON.stringify(rr.data));

  const after = await api(`/venues/equipment/all?venue_id=${eq.venue_id}`);
  check('完工后器械自动恢复正常', after.data.find((x) => x.id === eq.id)?.status === 'normal');

  // 再开一张工单走报废流程
  rr = await api('/repair-orders', {
    method: 'POST',
    body: { equipment_id: eq.id, reporter: 'e2e测试员', fault_desc: '彻底损坏' },
  });
  const scrapId = rr.data.id;
  rr = await api(`/repair-orders/${scrapId}/scrap`, { method: 'POST', body: { scrap_reason: '无零件' } });
  check('报废缺少审核人被拒绝', rr.status === 400, JSON.stringify(rr.data));
  rr = await api(`/repair-orders/${scrapId}/scrap`, {
    method: 'POST', body: { scrap_reason: '无零件可换', approver: '王经理' },
  });
  check('带原因+审核人报废成功', rr.status === 200 && rr.data.status === 'scrapped'
    && rr.data.scrap_reason === '无零件可换' && rr.data.approver === '王经理', JSON.stringify(rr.data));
}

// 15. 器械保养提醒：同器械重复拉取不产生重复提醒；登记保养后提醒消除
{
  await api('/reminders?status=pending');
  const r1 = await api('/reminders?status=pending');
  const eqReminders = r1.data.filter((x) => x.type === 'equipment_maintain');
  check('存在器械保养提醒', eqReminders.length >= 1, `条数=${eqReminders.length}`);
  const target = eqReminders[0];
  const r2 = await api('/reminders?status=pending');
  check('同一器械不重复生成提醒',
    r2.data.filter((x) => x.equipment_id === target.equipment_id && x.type === 'equipment_maintain').length === 1);
  const mr = await api(`/venues/equipment/${target.equipment_id}/maintain`, {
    method: 'POST', body: {},
  });
  check('登记保养成功', mr.status === 200, JSON.stringify(mr.data));
  const r3 = await api('/reminders?status=pending');
  check('登记保养后该提醒自动消除',
    !r3.data.some((x) => x.id === target.id && x.status === 'pending'));
}

// 16. 排课时校验场地可用器械数量
{
  const { data: venues } = await api('/venues');
  const { data: equipList } = await api('/venues/equipment/all?status=normal');
  const eq = equipList.find((e) => e.venue_id && e.quantity >= 2);
  check('找到带场地的正常器械用于排课校验', !!eq);
  if (eq) {
    const futureDate = new Date(Date.now() + 6 * 86400e3);
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${futureDate.getUTCFullYear()}-${pad(futureDate.getUTCMonth() + 1)}-${pad(futureDate.getUTCDate())}`;
    const base = {
      title: '器械校验测试课', coach_id: null, venue_id: eq.venue_id,
      start_at: `${day}T05:00:00Z`, end_at: `${day}T06:00:00Z`, capacity: 6,
    };
    let rr = await api('/classes', { method: 'POST', body: { ...base, required_equipment_id: eq.id, required_quantity: eq.quantity + 999 } });
    check('所需器械超出可用数量被拦截', rr.status === 409, JSON.stringify(rr.data));
    rr = await api('/classes', { method: 'POST', body: { ...base, required_equipment_id: eq.id, required_quantity: 1 } });
    check('所需器械数量充足排课成功', rr.status === 201 && rr.data.required_equipment_id === eq.id, JSON.stringify(rr.data));
  }
  check('场地返回按台数汇总的可用数量',
    venues.every((v) => Number(v.normal_count) <= Number(v.equipment_count)));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
