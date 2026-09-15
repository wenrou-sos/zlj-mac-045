// 经营报表路由（角色只能来自登录会话 req.user；X-User-Role 请求头会被认证中间件拒绝）
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  CALIBER_VERSION,
  getSummary, getAttendanceGroups, getAttendanceDetails,
  getClassRoster, getMemberFlow, getCardSales,
  freezePeriod, getFrozenReport, findFrozenPeriod,
} from '../metrics.js';

const router = Router();

// 除口径说明（公开）外，全部要求登录
const ALL = ['front_desk', 'manager', 'investor'];

const ROLES = {
  front_desk: { label: '前台', money: false, phone: false, refund: false,
    reports: ['summary', 'attendance', 'members', 'card_sales'] },
  manager:    { label: '店长', money: true,  phone: true,  refund: true,
    reports: ['summary', 'attendance', 'members', 'card_sales'] },
  investor:   { label: '投资人', money: true, phone: false, refund: false,
    reports: ['summary', 'attendance', 'card_sales'] }, // 投资人不看会员个人明细
};
const cap = (req) => ROLES[req.user.role];
const canReport = (req, report) => cap(req).reports.includes(report);

function parseRange(req) {
  const q = req.query;
  const now = new Date();
  const toText = () => now.toISOString().slice(0, 10);
  const add = (base, n) => {
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  let from = q.from;
  let to = q.to || toText();
  if (q.preset === 'thisWeek' || !from) from = add(to, -6); // 默认最近 7 天
  if (q.preset === 'thisMonth') from = add(to, 1 - Number(to.slice(8)));
  if (q.preset === 'lastMonth') {
    const d = new Date(`${to.slice(0, 8)}01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    from = d.toISOString().slice(0, 10);
    to = add(add(from, 31).slice(0, 8) + '01', -1);
  }
  if (from > to) throw Object.assign(new Error('开始日期不能晚于结束日期'), { status: 400 });
  return [from, to];
}

// 金额字段抹除（前台）
function stripMoneySummary(t) {
  for (const k of ['card_sales_amount','card_refund_amount','renewal_amount',
    'renewal_refund_amount','net_revenue']) delete t[k];
  return t;
}
function deepStripMoney(o) {
  const moneyKeys = new Set(['card_sales_amount','card_refund_amount','renewal_amount',
    'renewal_refund_amount','net_revenue','sales_amount','refund_amount']);
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      for (const k of Object.keys(x)) {
        if (moneyKeys.has(k)) delete x[k]; else x[k] = walk(x[k]);
      }
    }
    return x;
  };
  return walk(o);
}

// 口径说明（公开，无需登录）
router.get('/caliber', async (req, res, next) => {
  try {
    const rows = (await query(`SELECT version, published_at, note
      FROM caliber_versions ORDER BY version DESC`)).rows;
    res.json({ current: CALIBER_VERSION, versions: rows });
  } catch (e) { next(e); }
});

// 已冻结期间列表（供前端选择历史月/周，选择后一律读快照）
router.get('/frozen-periods', requireAuth(ALL), async (req, res, next) => {
  try {
    const r = await query(`
      SELECT period_type AS period_type, period_start::text AS period_start,
             caliber_version, generated_at::text AS generated_at
      FROM report_snapshots
      WHERE report_key='summary'
      ORDER BY period_start DESC, caliber_version DESC`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 总览 KPI：区间恰好是已结账周/月时强制读快照（冻结后再查仍看到当时口径），否则实时计算
router.get('/summary', requireAuth(ALL), async (req, res, next) => {
  try {
    const [from, to] = parseRange(req);
    const frozen = await findFrozenPeriod(from, to);
    if (frozen) {
      const snap = await getFrozenReport(frozen.period_type, frozen.period_start, 'summary');
      let data = snap.data;
      if (!cap(req).money) data = stripMoneySummary({ ...data });
      return res.json({ ...data, caliber_version: snap.caliber_version,
        frozen: true, frozen_generated_at: snap.generated_at,
        frozen_period_type: frozen.period_type, computed_days: 0 });
    }
    const t = await getSummary(from, to);
    if (!cap(req).money) stripMoneySummary(t);
    res.json({ ...t, caliber_version: CALIBER_VERSION, frozen: false });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});

// 上座/满员分组（dim=course|venue）
router.get('/attendance', requireAuth(ALL), async (req, res, next) => {
  try {
    const [from, to] = parseRange(req);
    const dim = req.query.dim === 'venue' ? 'venue' : 'course';
    const frozen = await findFrozenPeriod(from, to);
    if (frozen) {
      const snap = await getFrozenReport(frozen.period_type, frozen.period_start, 'attendance');
      return res.json({ from, to, dim, groups: snap.data[dim] || [],
        caliber_version: snap.caliber_version, frozen: true,
        frozen_generated_at: snap.generated_at });
    }
    const groups = await getAttendanceGroups(from, to, dim);
    res.json({ from, to, dim, groups, caliber_version: CALIBER_VERSION, frozen: false });
  } catch (e) { next(e); }
});

// 分组 → 课节明细（实时：课节级数据不是结账口径，可在冻结后继续下钻原始记录）
router.get('/attendance/details', requireAuth(ALL), async (req, res, next) => {
  try {
    const [from, to] = parseRange(req);
    const dim = req.query.dim || 'course';
    const dimKey = req.query.key;
    if (!dimKey && dim !== 'all') return res.status(400).json({ error: '缺少分组 key' });
    res.json(await getAttendanceDetails(from, to, dim, dimKey));
  } catch (e) { next(e); }
});

// 单节课预约名单（前台能看名单但后端不下发手机号）
router.get('/classes/:id/roster', requireAuth(ALL), async (req, res, next) => {
  try {
    const rows = await getClassRoster(req.params.id, cap(req).phone);
    res.json({ phone_visible: cap(req).phone, rows });
  } catch (e) { next(e); }
});

// 会员新增/流失（投资人无权）
router.get('/members', requireAuth(['front_desk', 'manager']), async (req, res, next) => {
  try {
    const [from, to] = parseRange(req);
    const kind = req.query.kind === 'lost' ? 'lost' : 'new';
    const frozen = await findFrozenPeriod(from, to);
    let rows;
    let caliber;
    if (frozen) {
      const snap = await getFrozenReport(frozen.period_type, frozen.period_start, 'members');
      caliber = snap.caliber_version;
      rows = snap.data[kind] || [];
    } else {
      caliber = CALIBER_VERSION;
      rows = await getMemberFlow(from, to, kind);
    }
    if (!cap(req).phone) rows = rows.map(({ phone, ...rest }) => rest);
    res.json({ from, to, kind, frozen: !!frozen, caliber_version: caliber,
      phone_visible: cap(req).phone, rows });
  } catch (e) { next(e); }
});

// 卡种销量与续费（前台隐藏金额）
router.get('/card-sales', requireAuth(ALL), async (req, res, next) => {
  try {
    const [from, to] = parseRange(req);
    const frozen = await findFrozenPeriod(from, to);
    let rows;
    let caliber;
    if (frozen) {
      const snap = await getFrozenReport(frozen.period_type, frozen.period_start, 'card_sales');
      caliber = snap.caliber_version; rows = snap.data || [];
    } else {
      caliber = CALIBER_VERSION; rows = await getCardSales(from, to);
    }
    if (!cap(req).money) {
      rows = rows.map(({ sales_amount, renewal_amount, refund_amount, net_amount, ...rest }) => rest);
    }
    res.json({ from, to, frozen: !!frozen, caliber_version: caliber,
      money_visible: cap(req).money, rows });
  } catch (e) { next(e); }
});

// 退款流水（仅店长）
router.get('/refunds', requireAuth(['manager']), async (req, res, next) => {
  try {
    const [from, to] = parseRange(req);
    const r = await query(`
      SELECT rf.*, m.name AS member_name, c.plan_name
      FROM refunds rf
      JOIN members m ON m.id=rf.member_id
      LEFT JOIN membership_cards c ON c.id=rf.card_id
      WHERE rf.refunded_at::date BETWEEN $1 AND $2
      ORDER BY rf.refunded_at DESC`, [from, to]);
    res.json(r.rows);
  } catch (e) { next(e); }
});

router.post('/refunds', requireAuth(['manager']), async (req, res, next) => {
  try {
    const { source_type, source_id, card_id, member_id, amount, reason } = req.body;
    if (!['card', 'renewal'].includes(source_type) || !member_id || !(amount > 0)) {
      return res.status(400).json({ error: '退款类型、会员、金额必填且金额需大于 0' });
    }
    const member = await query(`SELECT 1 FROM members WHERE id=$1`, [member_id]);
    if (!member.rows.length) return res.status(404).json({ error: '会员不存在' });
    let resolvedCardId = card_id || null;
    if (source_type === 'renewal') {
      const ren = await query(`SELECT card_id FROM renewals WHERE id=$1`, [source_id]);
      if (!ren.rows.length) return res.status(404).json({ error: '续费记录不存在' });
      resolvedCardId = ren.rows[0].card_id;
    } else if (source_id) {
      const card = await query(`SELECT 1 FROM membership_cards WHERE id=$1`, [source_id]);
      if (!card.rows.length) return res.status(404).json({ error: '会员卡不存在' });
      resolvedCardId = Number(source_id);
    }
    const r = await query(`
      INSERT INTO refunds(source_type, source_id, card_id, member_id, amount, reason, created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [source_type, source_id || null, resolvedCardId, member_id, amount,
        reason || null, req.user.display_name]);
    res.status(201).json(r.rows[0]);
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});

// ---------- 历史期间结账（周/月冻结快照，仅店长） ----------
router.post('/freeze', requireAuth(['manager']), async (req, res, next) => {
  try {
    const { period_type, period_start } = req.body;
    if (!['week', 'month'].includes(period_type) || !period_start) {
      return res.status(400).json({ error: '期间类型与起始日必填' });
    }
    const done = await freezePeriod(period_type, period_start);
    res.json({ ok: true, frozen: done, caliber_version: CALIBER_VERSION,
      note: done ? '已按当前口径冻结' : '该期间尚未结束或仍在 3 天结账缓冲期内（或已冻结）' });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});

// 直接读取冻结快照（report_key=summary/attendance/members/card_sales）
router.get('/frozen/:type/:key', requireAuth(ALL), async (req, res, next) => {
  try {
    const { type, key } = req.params;
    if (!['week', 'month'].includes(type) ||
        !['summary', 'attendance', 'members', 'card_sales'].includes(key)) {
      return res.status(400).json({ error: '期间或报表类型不支持' });
    }
    if (key === 'members' && !canReport(req, 'members')) {
      return res.status(403).json({ error: '当前角色无权查看会员明细' });
    }
    const snap = await getFrozenReport(type, req.query.period_start, key);
    if (!snap) return res.status(404).json({ error: '该期间尚无冻结报表' });
    if (key === 'members' && !cap(req).phone) {
      snap.data.new = (snap.data.new || []).map(({ phone, ...rest }) => rest);
      snap.data.lost = (snap.data.lost || []).map(({ phone, ...rest }) => rest);
    }
    if (!cap(req).money && (key === 'summary' || key === 'card_sales')) {
      snap.data = deepStripMoney(snap.data);
    }
    res.json(snap);
  } catch (e) { next(e); }
});

// ---------- CSV 导出（按角色矩阵裁剪；冻结期间导出快照；动作写审计） ----------
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}
function toCsv(headers, rows) {
  const head = headers.map((h) => csvCell(h.label)).join(',');
  const body = rows.map((r) => headers.map((h) => csvCell(h.get ? h.get(r) : r[h.key])).join(',')).join('\n');
  return '﻿' + head + '\n' + body;
}
async function writeAudit(req, report, params, rowCount, masked) {
  await query(`INSERT INTO report_exports(role, username, report, params, row_count, masked_fields)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [req.user.role, req.user.username, report, params, rowCount, masked.join(',') || null]);
}
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(csv);
}

router.get('/export/:report', requireAuth(ALL), async (req, res, next) => {
  try {
    const report = req.params.report;
    const [from, to] = parseRange(req);
    const params = `${from}~${to}`;
    const money = cap(req).money;
    // 冻结期间：导出也必须是结账快照，并在文件名标注「冻结」
    const frozen = await findFrozenPeriod(from, to);
    const tag = frozen ? `冻结v${frozen.caliber_version}_` : '';

    if (report === 'summary') {
      let t;
      if (frozen) {
        const snap = await getFrozenReport(frozen.period_type, frozen.period_start, 'summary');
        t = snap.data;
      } else {
        t = await getSummary(from, to);
      }
      if (!money) stripMoneySummary(t);
      const rows = [
        ['数据口径', frozen ? `结账冻结快照 v${frozen.caliber_version}（${frozen.generated_at.slice(0,10)} 冻结）` : '实时'],
        ['实际开课(节)', t.classes_scheduled], ['取消课节', t.classes_canceled],
        ['开课座位', t.seats_total], ['有效预约人次', t.seats_effective],
        ['核销人次', t.checkins], ['未到店人次', t.no_shows],
        ['会员取消预约', t.canceled_bookings], ['满员课节', t.full_classes],
        ['上座率', t.attendance_rate === null ? '—' : (t.attendance_rate * 100).toFixed(1) + '%'],
        ['满员率', t.full_rate === null ? '—' : (t.full_rate * 100).toFixed(1) + '%'],
        ['座位利用率', t.utilization_rate === null ? '—' : (t.utilization_rate * 100).toFixed(1) + '%'],
        ['新增会员', t.new_members], ['流失会员', t.lost_members],
      ];
      if (money) rows.push(
        ['新开卡金额', t.card_sales_amount], ['续费金额', t.renewal_amount],
        ['退款金额', Number(t.card_refund_amount) + Number(t.renewal_refund_amount)],
        ['净收入', t.net_revenue]);
      await writeAudit(req, 'summary', params + (frozen ? ':frozen' : ''), 1, money ? [] : ['amounts']);
      const csv = toCsv(
        [{ label: '指标', get: (r) => r[0] }, { label: '数值', get: (r) => r[1] }], rows);
      return sendCsv(res, `经营汇总_${tag}${from}_${to}.csv`, csv);
    }

    if (report === 'card-sales') {
      if (!canReport(req, 'card_sales')) return res.status(403).json({ error: '无权导出' });
      let rows;
      if (frozen) rows = (await getFrozenReport(frozen.period_type, frozen.period_start, 'card_sales')).data || [];
      else rows = await getCardSales(from, to);
      if (!money) rows = rows.map(({ sales_amount, renewal_amount, refund_amount, net_amount, ...rest }) => rest);
      const headers = [
        { label: '卡种', key: 'plan_name' },
        { label: '类型', get: (r) => r.card_type === 'period' ? '期限卡' : r.card_type === 'count' ? '次卡' : '—' },
        { label: '新办张数', key: 'sales_count' },
        ...(money ? [{ label: '新开卡金额', key: 'sales_amount' }] : []),
        { label: '续费笔数', key: 'renewal_count' },
        ...(money ? [{ label: '续费金额', key: 'renewal_amount' },
          { label: '退款金额', key: 'refund_amount' }, { label: '净额', key: 'net_amount' }] : []),
      ];
      await writeAudit(req, 'card-sales', params, rows.length, money ? [] : ['amounts']);
      return sendCsv(res, `卡种销量续费_${tag}${from}_${to}.csv`, toCsv(headers, rows));
    }

    if (report === 'attendance') {
      const dim = req.query.dim === 'venue' ? 'venue' : 'course';
      let rows;
      if (frozen) {
        rows = (await getFrozenReport(frozen.period_type, frozen.period_start, 'attendance')).data[dim] || [];
      } else rows = await getAttendanceGroups(from, to, dim);
      const headers = [
        { label: dim === 'course' ? '课程' : '场地', key: 'dim_name' },
        { label: '实际开课', key: 'classes_scheduled' },
        { label: '取消课节', key: 'classes_canceled' },
        { label: '核销人次', key: 'checkins' },
        { label: '未到店', key: 'no_shows' },
        { label: '会员取消', key: 'canceled_bookings' },
        { label: '有效预约', key: 'seats_effective' },
        { label: '上座率', get: (r) => r.attendance_rate === null ? '—' : (r.attendance_rate * 100).toFixed(1) + '%' },
        { label: '满员率', get: (r) => r.full_rate === null ? '—' : (r.full_rate * 100).toFixed(1) + '%' },
        { label: '座位利用率', get: (r) => r.utilization_rate === null ? '—' : (r.utilization_rate * 100).toFixed(1) + '%' },
      ];
      await writeAudit(req, 'attendance', `${params}:${dim}${frozen ? ':frozen' : ''}`, rows.length, []);
      return sendCsv(res, `${dim === 'course' ? '课程' : '场地'}上座明细_${tag}${from}_${to}.csv`, toCsv(headers, rows));
    }

    if (report === 'members') {
      if (!canReport(req, 'members')) return res.status(403).json({ error: '无权导出会员名单' });
      const kind = req.query.kind === 'lost' ? 'lost' : 'new';
      let rows;
      if (frozen) rows = (await getFrozenReport(frozen.period_type, frozen.period_start, 'members')).data[kind] || [];
      else rows = await getMemberFlow(from, to, kind);
      const phone = cap(req).phone;
      if (!phone) rows = rows.map(({ phone: _p, ...rest }) => rest);
      const headers = [
        { label: '会员', key: 'name' }, { label: '性别', key: 'gender' },
        ...(phone ? [{ label: '手机号', key: 'phone' }] : []),
        { label: kind === 'lost' ? '流失日期' : '入会日期', key: 'event_date' },
        { label: '最近卡种', key: 'last_plan' },
      ];
      await writeAudit(req, `members-${kind}`, params + (frozen ? ':frozen' : ''), rows.length, phone ? [] : ['phone']);
      return sendCsv(res, `${kind === 'lost' ? '流失' : '新增'}会员名单_${tag}${from}_${to}.csv`, toCsv(headers, rows));
    }

    if (report === 'roster') {
      // 名单不属于期间报表；前台导出时后端数据本身没有手机号
      const classId = req.query.class_id;
      const phone = cap(req).phone;
      const rows = await getClassRoster(classId, phone);
      const statusText = { booked: '已预约', checked: '已核销', canceled: '已取消', no_show: '未到店' };
      const headers = [
        { label: '会员', key: 'member_name' },
        ...(phone ? [{ label: '手机号', key: 'phone' }] : []),
        { label: '状态', get: (r) => statusText[r.status] || r.status },
        { label: '核销码', key: 'verify_code' },
        { label: '卡种', key: 'card_plan' },
        { label: '备注', key: 'cancel_reason' },
      ];
      await writeAudit(req, 'roster', `class:${classId}`, rows.length, phone ? [] : ['phone']);
      return sendCsv(res, `课程签到名单_${classId}.csv`, toCsv(headers, rows));
    }

    return res.status(404).json({ error: '不支持的导出类型' });
  } catch (e) { next(e); }
});

export default router;
