import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  api, getUser, getRole,
  fmtDate, fmtPct, fmtMoney, downloadReport, todayStr, addDaysStr,
} from '../api.js';
import { notify } from '../notify.js';
import CaliberPanel from '../components/CaliberPanel.jsx';

// 角色能力（与后端 reports.js 矩阵一致；角色来源是登录会话，页面不能自行提升）
const CAN = {
  front_desk: { money: false, phone: false, refunds: false, members: true, freeze: false },
  manager:    { money: true,  phone: true,  refunds: true,  members: true, freeze: true },
  investor:   { money: true,  phone: false, refunds: false, members: false, freeze: false },
};

const PRESETS = [
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'thisWeek', label: '本周' },
  { key: 'thisMonth', label: '本月' },
];

function defaultRange() {
  const to = todayStr();
  return { from: addDaysStr(to, -6), to };
}
// 周/月标准结束日（与后端 periodBounds 一致）
function periodEnd(type, start) {
  if (type === 'week') return addDaysStr(start, 6);
  const d = new Date(`${start.slice(0, 8)}01T00:00:00Z`);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return last.toISOString().slice(0, 10);
}

export default function Reports() {
  const user = getUser();
  const role = getRole();
  const can = CAN[role] || CAN.front_desk;
  const [range, setRange] = useState(defaultRange());
  const [preset, setPreset] = useState('7d');
  const [summary, setSummary] = useState(null);
  const [dim, setDim] = useState('course');
  const [groups, setGroups] = useState([]);
  const [attendanceFrozen, setAttendanceFrozen] = useState(false);
  const [members, setMembers] = useState({ new: [], lost: [], frozen: false });
  const [cardSales, setCardSales] = useState({ rows: [], frozen: false });
  const [refunds, setRefunds] = useState([]);
  const [frozenPeriods, setFrozenPeriods] = useState([]);
  const [loading, setLoading] = useState(false);
  const [drill, setDrill] = useState(null);

  const qs = useMemo(() => `?from=${range.from}&to=${range.to}`, [range]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const tasks = [
        api.get(`/reports/summary${qs}`).then(setSummary),
        api.get(`/reports/attendance${qs}&dim=${dim}`).then((d) => {
          setGroups(d.groups); setAttendanceFrozen(!!d.frozen);
        }),
        api.get(`/reports/card-sales${qs}`).then((d) =>
          setCardSales({ rows: d.rows, frozen: !!d.frozen })),
      ];
      if (can.members) {
        tasks.push(
          api.get(`/reports/members${qs}&kind=new`).then((d) =>
            setMembers((m) => ({ ...m, new: d.rows, frozen: !!d.frozen }))),
          api.get(`/reports/members${qs}&kind=lost`).then((d) =>
            setMembers((m) => ({ ...m, lost: d.rows, frozen: !!d.frozen }))),
        );
      } else {
        setMembers({ new: [], lost: [], frozen: false });
      }
      if (can.refunds) tasks.push(api.get(`/reports/refunds${qs}`).then(setRefunds));
      else setRefunds([]);
      await Promise.all(tasks);
    } catch (e) { notify(e.message, 'error'); }
    finally { setLoading(false); }
  }, [qs, dim, can.members, can.refunds]);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => {
    api.get('/reports/frozen-periods').then(setFrozenPeriods).catch(() => {});
  }, []);

  function applyPreset(key) {
    setPreset(key);
    const to = todayStr();
    if (key === '7d') setRange({ from: addDaysStr(to, -6), to });
    else if (key === '30d') setRange({ from: addDaysStr(to, -29), to });
    else if (key === 'thisWeek') {
      const d = new Date(to + 'T00:00:00');
      setRange({ from: addDaysStr(to, -((d.getDay() + 6) % 7)), to });
    } else if (key === 'thisMonth') setRange({ from: to.slice(0, 8) + '01', to });
  }
  // 选历史结账期间：区间设为该周/月的精确闭区间 → 所有查询/导出自动读快照
  function pickFrozen(ev) {
    const id = ev.target.value;
    if (!id) return;
    const p = frozenPeriods.find((x) => `${x.period_type}|${x.period_start}` === id);
    if (!p) return;
    setPreset('');
    setRange({ from: p.period_start, to: periodEnd(p.period_type, p.period_start) });
  }

  function exportCsv(report, extra = '') {
    downloadReport(`/reports/export/${report}${qs}${extra}`)
      .then(() => notify('导出成功（已按登录角色脱敏，冻结期间为结账快照）', 'ok'))
      .catch((e) => notify(e.message, 'error'));
  }
  async function freeze(kind) {
    try {
      const period_start = kind === 'month' ? range.from.slice(0, 8) + '01' : range.from;
      const r = await api.post('/reports/freeze', { period_type: kind, period_start });
      notify(r.frozen ? `${kind === 'month' ? '月' : '周'}报表已冻结（口径 v${r.caliber_version}）` : r.note,
        r.frozen ? 'ok' : 'warn');
      if (r.frozen) api.get('/reports/frozen-periods').then(setFrozenPeriods).catch(() => {});
    } catch (e) { notify(e.message, 'error'); }
  }

  return (
    <div>
      <div className="page-title">经营报表</div>
      <div className="page-sub">
        当前账号：<b>{user?.display_name}</b>（{user?.role_label}）·
        自选区间统计上座率/满员率、会员新增流失、卡种销量与续费；历史月结账后口径永久冻结
      </div>

      <div className="panel report-toolbar">
        <div className="tb-group">
          {can.freeze && (
            <>
              <span className="tb-label">历史结账期间</span>
              <select className="frozen-select" defaultValue="" onChange={pickFrozen}>
                <option value="">（实时区间）</option>
                {frozenPeriods.map((p) => (
                  <option key={`${p.period_type}|${p.period_start}`}
                    value={`${p.period_type}|${p.period_start}`}>
                    {p.period_type === 'month' ? '月' : '周'} {p.period_start}（已冻结 v{p.caliber_version}）
                  </option>
                ))}
              </select>
            </>
          )}
          {!can.phone && <span className="tag warn">名单导出不含手机号</span>}
          {!can.money && <span className="tag muted">当前角色不可见金额</span>}
        </div>
        <div className="tb-group">
          <div className="seg">
            {PRESETS.map((p) => (
              <button key={p.key} className={`seg-btn${preset === p.key ? ' active' : ''}`} onClick={() => applyPreset(p.key)}>
                {p.label}
              </button>
            ))}
          </div>
          <input type="date" value={range.from} max={range.to}
            onChange={(e) => { setPreset(''); setRange((r) => ({ ...r, from: e.target.value })); }} />
          <span className="muted">至</span>
          <input type="date" value={range.to} min={range.from} max={todayStr()}
            onChange={(e) => { setPreset(''); setRange((r) => ({ ...r, to: e.target.value })); }} />
          <button className="btn" onClick={loadAll} disabled={loading}>{loading ? '统计中…' : '查询'}</button>
        </div>
      </div>

      {summary?.frozen && (
        <div className="frozen-banner">
          🔒 当前为<b>结账冻结快照</b>（{summary.frozen_period_type === 'month' ? '月' : '周'}
          {' '}{range.from} ~ {range.to}，口径 v{summary.caliber_version}，
          于 {fmtDate(summary.frozen_generated_at)} 冻结）。重查或导出都读取该快照，不受之后数据变动影响。
        </div>
      )}

      {summary && <SummaryCards s={summary} can={can} onExport={() => exportCsv('summary')} />}

      {/* 上座/满员 */}
      <div className="panel">
        <h3>
          🧺 课程上座率与满员率
          {attendanceFrozen && <span className="tag" style={{ marginLeft: 8 }}>冻结快照</span>}
          <span className="seg" style={{ marginLeft: 12 }}>
            <button className={`seg-btn${dim === 'course' ? ' active' : ''}`} onClick={() => setDim('course')}>按课程</button>
            <button className={`seg-btn${dim === 'venue' ? ' active' : ''}`} onClick={() => setDim('venue')}>按场地</button>
          </span>
          <button className="btn sm" style={{ marginLeft: 'auto' }}
            onClick={() => exportCsv('attendance', `&dim=${dim}`)}>导出 CSV</button>
        </h3>
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>{dim === 'course' ? '课程' : '场地'}</th><th>实际开课</th><th>取消课节</th>
              <th>核销人次</th><th>未到店</th><th>会员取消</th><th>有效预约</th>
              <th>上座率</th><th>满员率</th><th>座位利用率</th><th></th>
            </tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.dim_key}>
                  <td className="strong">{g.dim_name}</td>
                  <td>{g.classes_scheduled}</td>
                  <td className="muted">{g.classes_canceled}</td>
                  <td>{g.checkins}</td>
                  <td className={g.no_shows ? 'warn-text' : ''}>{g.no_shows}</td>
                  <td className="muted">{g.canceled_bookings}</td>
                  <td>{g.seats_effective}</td>
                  <td><RateBar v={g.attendance_rate} /></td>
                  <td>{fmtPct(g.full_rate)}</td>
                  <td>{fmtPct(g.utilization_rate)}</td>
                  <td>
                    <button className="btn xs"
                      onClick={() => setDrill({ dim, key: g.dim_key, name: g.dim_name, from: range.from, to: range.to })}>
                      下钻明细
                    </button>
                  </td>
                </tr>
              ))}
              {groups.length === 0 && <tr><td colSpan={11}><div className="empty">该区间暂无课程数据{attendanceFrozen ? '（冻结快照）' : ''}</div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* 会员新增/流失 */}
      {can.members ? (
        <div className="panel">
          <h3>👥 会员新增与流失
            {members.frozen && <span className="tag" style={{ marginLeft: 8 }}>冻结快照</span>}
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => exportCsv('members', '&kind=new')}>导出新增</button>
            <button className="btn sm" onClick={() => exportCsv('members', '&kind=lost')}>导出流失</button>
          </h3>
          <div className="flow-grid">
            <FlowTable title={`新增会员（${members.new.length}）`} rows={members.new} kind="new" phone={can.phone} />
            <FlowTable title={`流失会员（${members.lost.length}）`} rows={members.lost} kind="lost" phone={can.phone} />
          </div>
        </div>
      ) : (
        <div className="panel"><div className="empty">当前角色（{user?.role_label}）不可查看会员明细，仅可见上方汇总数</div></div>
      )}

      {/* 卡种销量续费 */}
      <div className="panel">
        <h3>💳 各卡种销量与续费金额
          {cardSales.frozen && <span className="tag" style={{ marginLeft: 8 }}>冻结快照</span>}
          <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => exportCsv('card-sales')}>导出 CSV</button>
        </h3>
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>卡种</th><th>类型</th><th>新办张数</th>
              {can.money && <th>新开卡金额</th>}
              <th>续费笔数</th>
              {can.money && <><th>续费金额</th><th>退款金额</th><th>净额</th></>}
            </tr></thead>
            <tbody>
              {cardSales.rows.map((c) => (
                <tr key={c.plan_name}>
                  <td className="strong">{c.plan_name}</td>
                  <td className="muted">{c.card_type === 'period' ? '期限卡' : c.card_type === 'count' ? '次卡' : '—'}</td>
                  <td>{c.sales_count}</td>
                  {can.money && <td>{fmtMoney(c.sales_amount)}</td>}
                  <td>{c.renewal_count}</td>
                  {can.money && <td>{fmtMoney(c.renewal_amount)}</td>}
                  {can.money && <td className="danger-text">{c.refund_count ? fmtMoney(c.refund_amount) : '—'}</td>}
                  {can.money && <td className="strong">{fmtMoney(c.net_amount)}</td>}
                </tr>
              ))}
              {cardSales.rows.length === 0 && <tr><td colSpan={can.money ? 8 : 4}><div className="empty">该区间暂无开卡/续费</div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* 退款流水（仅店长） */}
      {can.refunds && (
        <div className="panel">
          <h3>↩️ 退款流水（仅店长可见）</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>时间</th><th>会员</th><th>卡种</th><th>类型</th><th>金额</th><th>原因</th><th>登记人</th></tr></thead>
              <tbody>
                {refunds.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.refunded_at)}</td>
                    <td>{r.member_name}</td>
                    <td className="muted">{r.plan_name || '—'}</td>
                    <td><span className="badge info">{r.source_type === 'card' ? '开卡退款' : '续费退款'}</span></td>
                    <td className="danger-text strong">{fmtMoney(r.amount)}</td>
                    <td className="muted">{r.reason || '—'}</td>
                    <td className="muted">{r.created_by}</td>
                  </tr>
                ))}
                {refunds.length === 0 && <tr><td colSpan={7}><div className="empty">该区间无退款</div></td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 结账冻结 */}
      {can.freeze && (
        <div className="panel freeze-bar">
          <div>
            <div className="strong">🔒 历史期间结账</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              区间结束满 3 天后可冻结；冻结后永久保留当时口径（{summary ? `当前 v${summary.caliber_version}` : ''}）的数据，重查与导出都走快照。
            </div>
          </div>
          <button className="btn" onClick={() => freeze('week')}>冻结所选周</button>
          <button className="btn" onClick={() => freeze('month')}>冻结所选月</button>
        </div>
      )}

      <CaliberPanel version={summary?.caliber_version} />

      {drill && <DrillModal drill={drill} onClose={() => setDrill(null)} canPhone={can.phone} />}
    </div>
  );
}

function SummaryCards({ s, can, onExport }) {
  const cards = [
    { label: '实际开课（节）', value: s.classes_scheduled },
    { label: '取消课节', value: s.classes_canceled, cls: 'muted' },
    { label: '上座率', value: fmtPct(s.attendance_rate), cls: 'accent' },
    { label: '满员率', value: fmtPct(s.full_rate) },
    { label: '座位利用率', value: fmtPct(s.utilization_rate) },
    { label: '核销 / 有效预约', value: `${s.checkins} / ${s.seats_effective}` },
    { label: '未到店人次', value: s.no_shows, cls: 'warn' },
    { label: '会员取消预约', value: s.canceled_bookings, cls: 'muted' },
    { label: '新增 / 流失会员', value: `${s.new_members} / ${s.lost_members}` },
  ];
  return (
    <div className="panel">
      <h3>📊 区间总览（{s.from} ~ {s.to}）
        <span className="tag" style={{ marginLeft: 10 }}>口径 v{s.caliber_version}</span>
        {s.frozen && <span className="tag warn" style={{ marginLeft: 6 }}>结账冻结</span>}
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={onExport}>导出汇总 CSV</button>
      </h3>
      <div className="kpi-grid">
        {cards.map((c) => (
          <div key={c.label} className="kpi">
            <div className="kpi-label">{c.label}</div>
            <div className={`kpi-value ${c.cls || ''}`}>{c.value}</div>
          </div>
        ))}
      </div>
      {can.money && (
        <div className="kpi-grid" style={{ marginTop: 12 }}>
          <div className="kpi"><div className="kpi-label">新开卡金额</div><div className="kpi-value">{fmtMoney(s.card_sales_amount)}</div></div>
          <div className="kpi"><div className="kpi-label">续费金额</div><div className="kpi-value">{fmtMoney(s.renewal_amount)}</div></div>
          <div className="kpi"><div className="kpi-label">退款金额</div><div className="kpi-value danger-text">{fmtMoney(Number(s.card_refund_amount || 0) + Number(s.renewal_refund_amount || 0))}</div></div>
          <div className="kpi"><div className="kpi-label">净收入（给投资人）</div><div className="kpi-value accent">{fmtMoney(s.net_revenue)}</div></div>
        </div>
      )}
    </div>
  );
}

function RateBar({ v }) {
  if (v === null || v === undefined) return <span className="muted">—</span>;
  const color = v >= 0.8 ? 'var(--ok)' : v >= 0.5 ? 'var(--warn)' : 'var(--danger)';
  return (
    <div className="rate-cell">
      <div className="rate-track"><div className="rate-fill" style={{ width: `${Math.round(v * 100)}%`, background: color }} /></div>
      <span>{fmtPct(v)}</span>
    </div>
  );
}

function FlowTable({ title, rows, kind, phone }) {
  return (
    <div>
      <div className="strong" style={{ marginBottom: 8 }}>{title}</div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>会员</th><th>性别</th>{phone && <th>手机号</th>}<th>{kind === 'lost' ? '流失日期' : '入会日期'}</th><th>最近卡种</th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td className="muted">{m.gender}</td>
                {phone && <td>{m.phone}</td>}
                <td>{m.event_date?.slice(0, 10)}</td>
                <td className="muted">{m.last_plan || '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={phone ? 5 : 4}><div className="empty">无</div></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DrillModal({ drill, onClose, canPhone }) {
  const [details, setDetails] = useState(null);
  const [roster, setRoster] = useState(null);

  useEffect(() => {
    api.get(`/reports/attendance/details?from=${drill.from}&to=${drill.to}&dim=${drill.dim}&key=${encodeURIComponent(drill.key)}`)
      .then(setDetails).catch((e) => notify(e.message, 'error'));
  }, [drill]);

  async function openRoster(id) {
    try {
      const r = await api.get(`/reports/classes/${id}/roster`);
      setRoster({ id, rows: r.rows, phoneVisible: r.phone_visible });
    } catch (e) { notify(e.message, 'error'); }
  }
  function exportRoster(id) {
    downloadReport(`/reports/export/roster?class_id=${id}`)
      .then(() => notify('名单已导出（按登录角色脱敏）', 'ok'))
      .catch((e) => notify(e.message, 'error'));
  }

  const STATUS = { booked: ['已预约', 'info'], checked: ['已核销', 'ok'], canceled: ['已取消', 'muted'], no_show: ['未到店', 'warn'] };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{drill.name} · 课节明细（{drill.from} ~ {drill.to}）</b>
          <button className="btn xs" onClick={onClose}>关闭</button>
        </div>
        <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
          <table>
            <thead><tr><th>日期</th><th>课程</th><th>场地</th><th>教练</th><th>状态</th><th>核销/有效</th><th>上座率</th><th></th></tr></thead>
            <tbody>
              {(details || []).map((c) => (
                <tr key={c.id}>
                  <td>{fmtDate(c.start_at)} {new Date(c.start_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</td>
                  <td>{c.title}</td>
                  <td className="muted">{c.venue_name}</td>
                  <td className="muted">{c.coach_name || '—'}</td>
                  <td>{c.status === 'canceled'
                    ? <span className="badge danger">已取消</span>
                    : c.is_full ? <span className="badge ok">满员</span> : <span className="badge muted">正常</span>}</td>
                  <td>{c.status === 'canceled' ? '—' : `${c.checkins} / ${c.seats_effective}`}</td>
                  <td>{c.status === 'canceled' ? '—' : fmtPct(c.attendance_rate)}</td>
                  <td className="nowrap">
                    <button className="btn xs" onClick={() => openRoster(c.id)}>名单</button>
                    <button className="btn xs" onClick={() => exportRoster(c.id)}>导出</button>
                  </td>
                </tr>
              ))}
              {details && details.length === 0 && <tr><td colSpan={8}><div className="empty">无课节</div></td></tr>}
            </tbody>
          </table>
        </div>

        {roster && (
          <div style={{ marginTop: 14 }}>
            <div className="strong" style={{ marginBottom: 8 }}>
              预约名单（课节 #{roster.id}）
              {!roster.phoneVisible && <span className="tag warn" style={{ marginLeft: 8 }}>当前角色名单不含手机号</span>}
            </div>
            <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
              <table>
                <thead><tr><th>会员</th>{roster.phoneVisible && <th>手机号</th>}<th>状态</th><th>核销码</th><th>卡种</th><th>备注</th></tr></thead>
                <tbody>
                  {roster.rows.map((b) => (
                    <tr key={b.id}>
                      <td>{b.member_name}</td>
                      {roster.phoneVisible && <td>{b.phone || '—'}</td>}
                      <td><span className={`badge ${(STATUS[b.status] || ['', 'muted'])[1]}`}>{(STATUS[b.status] || [b.status])[0]}</span></td>
                      <td className="code-chip">{b.verify_code}</td>
                      <td className="muted">{b.card_plan || '—'}</td>
                      <td className="muted">{b.cancel_reason || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
