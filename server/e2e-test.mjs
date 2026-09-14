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
for (const c of classes.filter((x) => x.status === 'open' && x.booked_count < x.capacity)) {
  const r = await api('/bookings', { method: 'POST', body: { class_id: c.id, member_id: MEMBER } });
  if (r.status === 201) { target = c; bookingId = r.data.id; code = r.data.verify_code; break; }
}
check('约课成功返回核销码', !!code, '所有课程均不可约');

// 2. 重复约课应被拒
let r = await api('/bookings', { method: 'POST', body: { class_id: target.id, member_id: MEMBER } });
check('重复约课被拒绝 (409)', r.status === 409, JSON.stringify(r.data));

// 3. 次卡已扣 1 次
r = await api(`/members/${MEMBER}`);
let card = r.data.cards.find((c) => c.id === cardId);
check('次卡预扣 1 次', card.remaining === remainingBefore - 1, `${card.remaining} vs ${remainingBefore - 1}`);

// 4. 取消预约（>2h，应退次）
r = await api(`/bookings/${bookingId}/cancel`, { method: 'POST', body: { reason: '临时有事' } });
check('取消成功且退次', r.status === 200 && r.data.refund === true, JSON.stringify(r.data));
r = await api(`/members/${MEMBER}`);
card = r.data.cards.find((c) => c.id === cardId);
check('取消后次数返还', card.remaining === remainingBefore, `${card.remaining} vs ${remainingBefore}`);

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

// 12. 仪表盘统计
const { status: st, data: stats } = await api('/dashboard/stats');
check('仪表盘统计可访问', st === 200 && stats.members >= 20, JSON.stringify(stats));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
