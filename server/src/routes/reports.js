// 经营报表路由
// 角色由请求头 X-User-Role（front_desk 前台 / manager 店长 / investor 投资人）声明，
// 前端切换角色时带上；生产环境应换成登录态下发的角色，矩阵不变。
import { Router } from 'express';
import { query } from '../db.js';
import {
  CALIBER_VERSION, runMaintenance,
  getSummary, getAttendanceGroups, getAttendanceDetails,
  getClassRoster, getMemberFlow, getCardSales,
  freezePeriod, getFrozenReport,
} from '../metrics.js';

const router = Router();

const ROLES = {
  front_desk: { label: '前台', money: false, phone: false, refund: false,
    reports: ['summary', 'attendance', 'members', 'card_sales'] },
  manager:    { label: '店长', money: true,  phone: true,  refund: true,
    reports: ['summary', 'attendance', 'members', 'card_sales'] },
  investor:   { label: '投资人', money: true, phone: false, refund: false,
    reports: ['summary', 'attendance', 'card_sales'] }, // 投资人不看会员个人明细
};
function getRole(req) {
  const r = String(req.get('X-User-Role') || req.query.role || 'manager');
  return ROLES[r] ? r : 'manager';
}
function requireReport(role, report) {
  return ROLES[role].reports.includes(report);
}

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
  if (q.preset === 'thisWeek' || (!from && !q.from)) {
    // 默认最近 7 天
    from = add(to, -6);
  }
  if (q.preset === 'thisMonth') from = add(to, 1 - Number(to.slice(8)));
  if (q.preset === 'lastMonth') {
    const d = new Date(`${to.slice(0, 8)}01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    from = d.toISOString().slice(0, 10);
    to = add(add(from, 31).slice(0, 8) + '01', -1);
  }
  if (!from) from = add(to, -6);
  if (from > to) throw Object.assign(new Error('开始日期不能晚于结束日期'), { status: 400 });
  return [from, to];
}

// 口径说明（页面常驻展示，带版本号）
router.get('/caliber', async (req, res, next) => {
  try {
    const rows = (await query(`SELECT version, published_at, note
      FROM caliber_versions ORDER BY version DESC`)).rows;
    res.json({ current: CALIBER_VERSION, versions: rows });
  } catch (e) { next(e); }
});

// 总览 KPI
router.get('/summary', async (req, res, next) => {
  try {
    const role = getRole(req);
    const [from, to] = parseRange(req);
    const t = await getSummary(from, to);
    // 前台/投资人看不到收入明细字段（金额抹除）
    if (!ROLES[role].money) {
      for (const k of ['card_sales_amount','card_refund_amount','renewal_amount',
        'renewal_refund_amount','net_revenue']) delete t[k];
    }
    res.json({ ...t, caliber_version: CALIBER_VERSION, frozen: false });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});

// 上座/满员分组（dim=course|venue）
router.get('/attendance', async (req, res, next) => {
  try {
    const [from, to] = parseRange(req);
    const dim = req.query.dim === 'venue' ? 'venue' : 'course';
    const groups = await getAttendanceGroups(from, to, dim);
    res.json({ from, to, dim, groups, caliber_version: CALIBER_VERSION, frozen: false });
  } catch (e) { next(e); }
});

// 分组 → 课节明细
router.get('/attendance/details', async (req, res, next) => {
  try {
    const [from, to] = parseRange(req);
    const dim = req.query.dim || 'course';
    const dimKey = req.query.key;
    if (!dimKey && dim !== 'all') return res.status(400).json({ error: '缺少分组 key' });
    res.json(await getAttendanceDetails(from, to, dim, dimKey));
  } catch (e) { next(e); }
});

// 单节课预约名单（前台导出/查看时后端就不返回手机号）
router.get('/classes/:id/roster', async (req, res, next) => {
  try {
    const role = getRole(req);
    const rows = await getClassRoster(req.params.id, ROLES[role].phone);
    res.json({ role, phone_visible: ROLES[role].phone, rows });
  } catch (e) { next(e); }
});

// 会员新增/流失（kind=new|lost，投资人无权）
router.get('/members', async (req, res, next) => {
  try {
    const role = getRole(req);
    if (!requireReport(role, 'members')) return res.status(403).json({ error: '当前角色无权查看会员明细' });
    const [from, to] = parseRange(req);
    const kind = req.query.kind === 'lost' ? 'lost' : 'new';
    let rows = await getMemberFlow(from, to, kind);
    if (!ROLES[role].phone) rows = rows.map(({ phone, ...rest }) => rest);
    res.json({ from, to, kind, phone_visible: ROLES[role].phone, rows });
  } catch (e) { next(e); }
});

// 卡种销量与续费（非财务角色隐藏金额）
router.get('/card-sales', async (req, res, next) => {
  try {
    const role = getRole(req);
    const [from, to] = parseRange(req);
    let rows = await getCardSales(from, to);
    if (!ROLES[role].money) {
      rows = rows.map(({ sales_amount, renewal_amount, refund_amount, net_amount, ...rest }) => rest);
    }
    res.json({ from, to, money_visible: ROLES[role].money, rows });
  } catch (e) { next(e); }
});

// 退款流水（仅店长）+ 登记退款（仅店长）
router.get('/refunds', async (req, res, next) => {
  try {
    const role = getRole(req);
    if (!ROLES[role].refund) return res.status(403).json({ error: '仅店长可查看退款流水' });
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

router.post('/refunds', async (req, res, next) => {
  try {
    const role = getRole(req);
    if (!ROLES[role].refund) return res.status(403).json({ error: '仅店长可登记退款' });
    const { source_type, source_id, card_id, member_id, amount, reason } = req.body;
    if (!['card', 'renewal'].includes(source_type) || !member_id || !(amount > 0)) {
      return res.status(400).json({ error: '退款类型、会员、金额必填且金额需大于 0' });
    }
    const member = await query(`SELECT 1 FROM members WHERE id=$1`, [member_id]);
    if (!member.rows.length) return res.status(404).json({ error: '会员不存在' });
    let resolvedCardId = card_id || null;
    if (source_type === 'renewal') {
      const ren = await query(`SELECT card_id, member_id FROM renewals WHERE id=$1`, [source_id]);
      if (!ren.rows.length) return res.status(404).json({ error: '续费记录不存在' });
      resolvedCardId = ren.rows[0].card_id;
    } else if (source_id) {
      const card = await query(`SELECT member_id FROM membership_cards WHERE id=$1`, [source_id]);
      if (!card.rows.length) return res.status(404).json({ error: '会员卡不存在' });
      resolvedCardId = Number(source_id);
    }
    const r = await query(`
      INSERT INTO refunds(source_type, source_id, card_id, member_id, amount, reason, created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [source_type, source_id || null, resolvedCardId, member_id, amount,
        reason || null, ROLES[role].label]);
    res.status(201).json(r.rows[0]);
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});

// ---------- 历史期间结账（周/月冻结快照，口径版本随快照固化） ----------
router.post('/freeze', async (req, res, next) => {
  try {
    const role = getRole(req);
    if (role !== 'manager') return res.status(403).json({ error: '仅店长可结账冻结' });
    const { period_type, period_start } = req.body;
    if (!['week', 'month'].includes(period_type) || !period_start) {
      return res.status(400).json({ error: '期间类型与起始日必填' });
    }
    await runMaintenance();
    const done = await freezePeriod(period_type, period_start);
    res.json({ ok: true, frozen: done, caliber_version: CALIBER_VERSION,
      note: done ? '已按当前口径冻结' : '该期间尚未结束或仍在 3 天结账缓冲期内（或已冻结）' });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});

// 冻结报表读取（report_key=summary/attendance/members/card_sales）
router.get('/frozen/:type/:key', async (req, res, next) => {
  try {
    const role = getRole(req);
    const { type, key } = req.params;
    if (!['week', 'month'].includes(type) ||
        !['summary', 'attendance', 'members', 'card_sales'].includes(key)) {
      return res.status(400).json({ error: '期间或报表类型不支持' });
    }
    if (key === 'members' && !requireReport(role, 'members')) {
      return res.status(403).json({ error: '当前角色无权查看会员明细' });
    }
    const snap = await getFrozenReport(type, req.query.period_start, key);
    if (!snap) return res.status(404).json({ error: '该期间尚无冻结报表（结束 3 天后自动冻结，或由店长手动结账）' });
    if (key === 'members' && !ROLES[role].phone) {
      snap.data.new = (snap.data.new || []).map(({ phone, ...rest }) => rest);
      snap.data.lost = (snap.data.lost || []).map(({ phone, ...rest }) => rest);
    }
    if (!ROLES[role].money && (key === 'summary' || key === 'card_sales')) {
      const moneyKeys = ['card_sales_amount','card_refund_amount','renewal_amount',
        'renewal_refund_amount','net_revenue','sales_amount','renewal_amount:r','refund_amount','net_amount'];
      const strip = (o) => {
        if (Array.isArray(o)) return o.map(strip);
        if (o && typeof o === 'object') {
          for (const k of Object.keys(o)) if (moneyKeys.includes(k)) delete o[k];
          else o[k] = strip(o[k]);
        }
        return o;
      };
      snap.data = strip(snap.data);
    }
    res.json(snap);
  } catch (e) { next(e); }
});

// ---------- CSV 导出（按角色矩阵裁剪字段，动作写审计） ----------
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}
function toCsv(headers, rows) {
  const head = headers.map((h) => csvCell(h.label)).join(',');
  const body = rows.map((r) => headers.map((h) => csvCell(h.get ? h.get(r) : r[h.key])).join(',')).join('\n');
  // UTF-8 BOM，Excel 直接打开不乱码
  return '﻿' + head + '\n' + body;
}

async function writeAudit(role, report, params, rowCount, masked) {
  await query(`INSERT INTO report_exports(role, report, params, row_count, masked_fields)
    VALUES($1,$2,$3,$4,$5)`,
    [role, report, params, rowCount, masked.join(',') || null]);
}
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(csv);
}

// 导出 KPI 汇总 / 卡种（财务字段按角色）
router.get('/export/:report', async (req, res, next) => {
  try {
    const role = getRole(req);
    const report = req.params.report;
    const [from, to] = parseRange(req);
    const params = `${from}~${to}`;

    if (report === 'summary') {
      const t = await getSummary(from, to);
      const money = ROLES[role].money;
      const rows = [
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
      await writeAudit(role, 'summary', params, 1, money ? [] : ['amounts']);
      const csvFixed = toCsv(
        [{ label: '指标', get: (r) => r[0] }, { label: '数值', get: (r) => r[1] }], rows);
      return sendCsv(res, `经营汇总_${from}_${to}.csv`, csvFixed);
    }

    if (report === 'card-sales') {
      if (!requireReport(role, 'card_sales')) return res.status(403).json({ error: '无权导出' });
      const rows = await getCardSales(from, to);
      const money = ROLES[role].money;
      const headers = [
        { label: '卡种', key: 'plan_name' }, { label: '类型', get: (r) => r.card_type === 'period' ? '期限卡' : r.card_type === 'count' ? '次卡' : '—' },
        { label: '新办张数', key: 'sales_count' },
        ...(money ? [{ label: '新开卡金额', key: 'sales_amount' }] : []),
        { label: '续费笔数', key: 'renewal_count' },
        ...(money ? [{ label: '续费金额', key: 'renewal_amount' },
          { label: '退款金额', key: 'refund_amount' }, { label: '净额', key: 'net_amount' }] : []),
      ];
      await writeAudit(role, 'card-sales', params, rows.length, money ? [] : ['amounts']);
      return sendCsv(res, `卡种销量续费_${from}_${to}.csv`, toCsv(headers, rows));
    }

    if (report === 'attendance') {
      const dim = req.query.dim === 'venue' ? 'venue' : 'course';
      const rows = await getAttendanceGroups(from, to, dim);
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
      await writeAudit(role, 'attendance', `${params}:${dim}`, rows.length, []);
      return sendCsv(res, `${dim === 'course' ? '课程' : '场地'}上座明细_${from}_${to}.csv`, toCsv(headers, rows));
    }

    if (report === 'members') {
      if (!requireReport(role, 'members')) return res.status(403).json({ error: '无权导出会员名单' });
      const kind = req.query.kind === 'lost' ? 'lost' : 'new';
      const rows = await getMemberFlow(from, to, kind);
      const phone = ROLES[role].phone;
      const headers = [
        { label: '会员', key: 'name' }, { label: '性别', key: 'gender' },
        ...(phone ? [{ label: '手机号', key: 'phone' }] : []),
        { label: kind === 'lost' ? '流失日期' : '入会日期', key: 'event_date' },
        { label: '最近卡种', key: 'last_plan' },
      ];
      await writeAudit(role, `members-${kind}`, params, rows.length, phone ? [] : ['phone']);
      return sendCsv(res, `${kind === 'lost' ? '流失' : '新增'}会员名单_${from}_${to}.csv`,
        toCsv(headers, phone ? rows : rows.map(({ phone, ...rest }) => rest)));
    }

    if (report === 'roster') {
      // 前台可导名单，但后端下发的数据本身就没有手机号
      const classId = req.query.class_id;
      const phone = ROLES[role].phone;
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
      await writeAudit(role, 'roster', `class:${classId}`, rows.length, phone ? [] : ['phone']);
      return sendCsv(res, `课程签到名单_${classId}.csv`, toCsv(headers, rows));
    }

    return res.status(404).json({ error: '不支持的导出类型' });
  } catch (e) { next(e); }
});

export default router;
