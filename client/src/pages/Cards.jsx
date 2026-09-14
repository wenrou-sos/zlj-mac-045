import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, CARD_STATUS } from '../api.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

export default function Cards() {
  const [list, setList] = useState([]);
  const [status, setStatus] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [renewCard, setRenewCard] = useState(null);
  const [showRecords, setShowRecords] = useState(false);
  const [records, setRecords] = useState([]);
  const [form, setForm] = useState({ amount: 0, extend_days: 30, add_sessions: 10 });

  const load = () =>
    api.get(`/cards?status=${status}&keyword=${encodeURIComponent(keyword)}`).then(setList);
  useEffect(() => { load(); }, [status]);

  function openRenew(c) {
    setForm({
      amount: Number(c.price) || 0,
      extend_days: c.plan_name.includes('年') ? 365 : c.plan_name.includes('季') ? 90 : c.plan_name.includes('半年') ? 180 : 30,
      add_sessions: c.total_sessions ? Math.round(c.total_sessions / 2) : 10,
    });
    setRenewCard(c);
  }

  async function submitRenew() {
    try {
      await api.post(`/cards/${renewCard.id}/renew`, {
        amount: form.amount,
        extend_days: renewCard.card_type === 'period' ? form.extend_days : 0,
        add_sessions: renewCard.card_type === 'count' ? form.add_sessions : 0,
      });
      notify('续费成功', 'success');
      setRenewCard(null);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function freeze(c) {
    try { await api.post(`/cards/${c.id}/freeze`); notify(c.status === 'frozen' ? '已解冻' : '已冻结', 'success'); load(); }
    catch (e) { notify(e.message, 'error'); }
  }

  async function viewRecords() {
    setRecords(await api.get('/cards/renewals/list'));
    setShowRecords(true);
  }

  const tabs = [['all', '全部'], ['active', '有效'], ['expired', '已过期'], ['used_up', '已用完'], ['frozen', '已冻结']];

  return (
    <div>
      <div className="page-title">会员卡</div>
      <div className="page-sub">开卡、续费、冻结；次卡按约课扣次，取消规则内自动退次</div>

      <div className="toolbar">
        {tabs.map(([k, t]) => (
          <button key={k} className={`btn btn-tab ${status === k ? 'primary' : ''}`} onClick={() => setStatus(k)}>{t}</button>
        ))}
        <input className="search" style={{ marginLeft: 'auto' }} placeholder="卡号 / 会员姓名" value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()} />
        <button className="btn" onClick={load}>搜索</button>
        <button className="btn" onClick={viewRecords}>📖 续费记录</button>
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>卡号</th><th>会员</th><th>手机</th><th>卡种</th><th>类型</th><th>有效期</th><th>剩余次数</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.card_no}</td>
                  <td><Link to={`/members/${c.member_id}`} style={{ color: 'var(--accent)' }}>{c.member_name}</Link></td>
                  <td className="mono muted">{c.phone}</td>
                  <td style={{ fontWeight: 600 }}>{c.plan_name}</td>
                  <td>{c.card_type === 'period' ? '期限卡' : '次卡'}</td>
                  <td className="nowrap">
                    {c.card_type === 'period' ? `${fmtDate(c.start_date)} ~ ${fmtDate(c.end_date)}` : '不限日期'}
                  </td>
                  <td>{c.card_type === 'count'
                    ? <b className={c.remaining <= 3 ? 'badge warn' : ''} style={c.remaining <= 3 ? {} : { color: 'var(--accent)' }}>{c.remaining} / {c.total_sessions}</b>
                    : '不限'}</td>
                  <td><span className={`badge ${CARD_STATUS[c.status]?.cls}`}>{CARD_STATUS[c.status]?.text}</span></td>
                  <td className="nowrap">
                    <button className="btn sm primary" onClick={() => openRenew(c)}>续费</button>
                    <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => freeze(c)}>
                      {c.status === 'frozen' ? '解冻' : '冻结'}
                    </button>
                  </td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={9} className="empty">没有符合条件的会员卡</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {renewCard && (
        <Modal title={`续费 · ${renewCard.member_name} 的 ${renewCard.plan_name}`} onClose={() => setRenewCard(null)}>
          <div className="muted" style={{ marginBottom: 12, fontSize: 12.5 }}>
            卡号 {renewCard.card_no} · 当前状态：
            <span className={`badge ${CARD_STATUS[renewCard.status]?.cls}`}>{CARD_STATUS[renewCard.status]?.text}</span>
          </div>
          <div className="form-grid">
            <label className="field">续费金额（元）
              <input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })} /></label>
            {renewCard.card_type === 'period'
              ? <label className="field">延长天数
                  <input type="number" value={form.extend_days} onChange={(e) => setForm({ ...form, extend_days: Number(e.target.value) })} /></label>
              : <label className="field">增加次数
                  <input type="number" value={form.add_sessions} onChange={(e) => setForm({ ...form, add_sessions: Number(e.target.value) })} /></label>}
          </div>
          <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
            {renewCard.card_type === 'period'
              ? `规则：已过期的卡从今天起顺延，未过期的卡从原到期日顺延`
              : `当前剩余 ${renewCard.remaining ?? 0} 次，续费后恢复有效`}
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setRenewCard(null)}>取消</button>
            <button className="btn primary" onClick={submitRenew}>确认续费</button>
          </div>
        </Modal>
      )}

      {showRecords && (
        <Modal title="最近续费记录" onClose={() => setShowRecords(false)} wide>
          <div className="table-wrap">
            <table>
              <thead><tr><th>时间</th><th>会员</th><th>卡种</th><th>金额</th><th>延长/加次</th><th>新到期日</th><th>操作人</th></tr></thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{new Date(r.renewed_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{r.member_name}</td>
                    <td>{r.plan_name}</td>
                    <td>¥{Number(r.amount).toFixed(0)}</td>
                    <td>{r.added_sessions ? `+${r.added_sessions} 次` : '—'}</td>
                    <td>{r.new_end_date ? fmtDate(r.new_end_date) : '—'}</td>
                    <td className="muted">{r.operator}</td>
                  </tr>
                ))}
                {records.length === 0 && <tr><td colSpan={7} className="empty">暂无续费记录</td></tr>}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}
