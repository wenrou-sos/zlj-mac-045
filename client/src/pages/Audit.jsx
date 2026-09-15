import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api.js';
import { can } from '../auth.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

const ACTION_TABS = [
  ['', '全部'],
  ['card_open', '开卡'],
  ['card_renew', '续费'],
  ['card_freeze', '冻结/解冻'],
  ['card_price_change', '改价'],
  ['session_refund', '退次'],
  ['refund', '退款'],
  ['checkin', '核销'],
  ['class_cancel', '整课取消'],
  ['booking_create', '代客约课'],
  ['booking_cancel', '取消预约'],
  ['report_export', '导出对账'],
  ['user_manage', '账号管理'],
  ['login', '登录'],
];

const ACTION_CLS = {
  card_open: 'ok', card_renew: 'ok', checkin: 'info',
  card_price_change: 'warn', refund: 'danger', session_refund: 'warn',
  class_cancel: 'danger', card_freeze: 'muted', login: 'muted',
};

// 展示一条审计的关键字段（金额 / 卡号 / 改动前后）
function DetailView({ d }) {
  if (!d || typeof d !== 'object') return null;
  const entries = Object.entries(d).filter(([k]) => k !== 'reason');
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
      {d.reason && <div>📝 原因：<b>{d.reason}</b></div>}
      {entries.map(([k, v]) => (
        <div key={k} className="muted">
          {k}: {v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
        </div>
      ))}
    </div>
  );
}

export default function Audit() {
  const [logs, setLogs] = useState([]);
  const [actors, setActors] = useState([]);
  const [action, setAction] = useState('');
  const [actorId, setActorId] = useState('');
  const [date, setDate] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [keyword, setKeyword] = useState('');
  const [detail, setDetail] = useState(null);

  // 对账汇总
  const [rFrom, setRFrom] = useState('');
  const [rTo, setRTo] = useState('');
  const [report, setReport] = useState(null);
  const [exporting, setExporting] = useState(false);

  const load = () => {
    const q = new URLSearchParams();
    if (action) q.set('action', action);
    if (actorId) q.set('actor_id', actorId);
    if (date) q.set('date', date);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (keyword) q.set('keyword', keyword);
    api.get(`/audit/logs?${q}`).then(setLogs).catch((e) => notify(e.message, 'error'));
  };
  useEffect(() => {
    api.get('/audit/actors').then(setActors).catch(() => {});
    load();
  }, []);

  async function loadReport() {
    if (!rFrom || !rTo) { notify('请选择对账起止日期', 'error'); return; }
    setReport(await api.get(`/audit/report?from=${rFrom}&to=${rTo}`));
  }

  async function exportCsv() {
    if (!rFrom || !rTo) { notify('请先选择对账起止日期', 'error'); return; }
    setExporting(true);
    try {
      const token = localStorage.getItem('powergym_token') || '';
      const res = await fetch(`/api/audit/report/export?from=${rFrom}&to=${rTo}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `导出失败 (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `对账_${rFrom}_${rTo}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      notify('对账单已导出（导出动作已记录审计）', 'success');
    } catch (e) { notify(e.message, 'error'); }
    finally { setExporting(false); }
  }

  return (
    <div>
      <div className="page-title">操作审计</div>
      <div className="page-sub">所有敏感操作只追加记录，不可修改或删除；可按操作员、动作类型、日期和卡号查询</div>

      <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select className="search" style={{ width: 130 }} value={actorId} onChange={(e) => setActorId(e.target.value)}>
          <option value="">全部操作员</option>
          {actors.map((a) => <option key={a.id} value={a.id}>{a.display_name}（{a.role_text}）</option>)}
        </select>
        <input type="date" className="search" style={{ width: 140 }} value={date} onChange={(e) => setDate(e.target.value)} title="单日" />
        <span className="muted" style={{ fontSize: 12 }}>区间</span>
        <input type="date" className="search" style={{ width: 140 }} value={from} onChange={(e) => { setFrom(e.target.value); setDate(''); }} />
        <span className="muted">~</span>
        <input type="date" className="search" style={{ width: 140 }} value={to} onChange={(e) => { setTo(e.target.value); setDate(''); }} />
        <input className="search" placeholder="卡号 / 会员姓名 / 单据号" value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()} />
        <button className="btn primary" onClick={load}>查询</button>
      </div>

      <div className="toolbar" style={{ flexWrap: 'wrap', gap: 6, paddingTop: 0 }}>
        {ACTION_TABS.map(([k, t]) => (
          <button key={k} className={`btn btn-tab ${action === k ? 'primary' : ''}`}
            onClick={() => setAction(k)}>{t}</button>
        ))}
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>时间</th><th>操作员</th><th>动作</th><th>卡号</th><th>会员</th>
              <th>金额</th><th>业务单据</th><th></th>
            </tr></thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="nowrap">{fmtDateTime(l.created_at)}</td>
                  <td>{l.actor_name}
                    {l.actor_role && <div className="muted" style={{ fontSize: 11 }}>{l.actor_role === 'manager' ? '店长' : l.actor_role === 'front_desk' ? '前台' : '教练'}</div>}
                  </td>
                  <td><span className={`badge ${ACTION_CLS[l.action] || 'muted'}`}>{l.action_text}</span></td>
                  <td className="mono">{l.card_no || '—'}</td>
                  <td>{l.member_name || '—'}</td>
                  <td>{l.amount != null ? <b>¥{Number(l.amount).toFixed(2)}</b> : '—'}</td>
                  <td className="muted mono" style={{ fontSize: 12 }}>{l.target_type}#{l.target_id || ''}</td>
                  <td><button className="btn sm" onClick={() => setDetail(l)}>详情</button></td>
                </tr>
              ))}
              {logs.length === 0 && <tr><td colSpan={8} className="empty">没有符合条件的审计记录</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {can('reports_view') && (
        <div className="panel">
          <h3>🧾 对账汇总
            <span className="muted" style={{ marginLeft: 10, fontWeight: 400, fontSize: 12.5 }}>
              区间内开卡 / 续费收款与退款（仅店长）
            </span>
          </h3>
          <div className="toolbar" style={{ padding: 0 }}>
            <input type="date" className="search" style={{ width: 150 }} value={rFrom} onChange={(e) => setRFrom(e.target.value)} />
            <span className="muted">~</span>
            <input type="date" className="search" style={{ width: 150 }} value={rTo} onChange={(e) => setRTo(e.target.value)} />
            <button className="btn primary" onClick={loadReport}>生成对账</button>
            {can('reports_export') &&
              <button className="btn" style={{ marginLeft: 'auto' }} disabled={exporting} onClick={exportCsv}>
                ⬇️ 导出对账单 CSV
              </button>}
          </div>
          {report && (
            <>
              <div style={{ display: 'flex', gap: 14, margin: '12px 0' }}>
                <div className="stat-mini"><div className="muted" style={{ fontSize: 12 }}>收款合计</div><b style={{ color: 'var(--ok)' }}>¥{report.income.toFixed(2)}</b></div>
                <div className="stat-mini"><div className="muted" style={{ fontSize: 12 }}>退款合计</div><b style={{ color: 'var(--danger)' }}>¥{report.refunded.toFixed(2)}</b></div>
                <div className="stat-mini"><div className="muted" style={{ fontSize: 12 }}>净收入</div><b>¥{report.net.toFixed(2)}</b></div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>操作员</th><th>开卡</th><th>续费</th><th>核销</th><th>退次</th><th>整课取消</th></tr></thead>
                  <tbody>
                    {report.byOperator.map((o) => (
                      <tr key={o.id}>
                        <td>{o.display_name}</td>
                        <td>{o.card_opens}</td>
                        <td>{o.card_renews}</td>
                        <td>{o.checkins}</td>
                        <td>{o.session_refunds}</td>
                        <td>{o.class_cancels}</td>
                      </tr>
                    ))}
                    {report.byOperator.length === 0 && <tr><td colSpan={6} className="empty">区间内无操作</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {detail && (
        <Modal title={`审计记录 #${detail.id}`} onClose={() => setDetail(null)}>
          <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: '6px 10px', marginBottom: 12, fontSize: 13 }}>
            <div className="muted">时间</div><div>{new Date(detail.created_at).toLocaleString('zh-CN')}</div>
            <div className="muted">操作员</div><div>{detail.actor_name}（{detail.actor_username || '—'}）</div>
            <div className="muted">动作</div><div><span className={`badge ${ACTION_CLS[detail.action] || 'muted'}`}>{detail.action_text}</span></div>
            <div className="muted">卡号</div><div className="mono">{detail.card_no || '—'}</div>
            <div className="muted">会员</div><div>{detail.member_name ? `${detail.member_name}${detail.member_phone ? ' · ' + detail.member_phone : ''}` : '—'}</div>
            <div className="muted">金额</div><div>{detail.amount != null ? `¥${Number(detail.amount).toFixed(2)}` : '—'}</div>
            <div className="muted">业务单据</div><div className="mono">{detail.target_type}#{detail.target_id || ''}（退款/退次争议时凭此反查原始单据）</div>
            <div className="muted">IP</div><div className="mono">{detail.ip || '—'}</div>
          </div>
          <div className="muted" style={{ marginBottom: 4, fontSize: 12 }}>关键信息 / 改动前后值：</div>
          <div className="panel" style={{ padding: 10 }}>
            <DetailView d={detail.detail} />
          </div>
        </Modal>
      )}
    </div>
  );
}
