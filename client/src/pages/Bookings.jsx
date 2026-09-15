import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime, BOOKING_STATUS, todayStr, addDaysStr } from '../api.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

export default function Bookings() {
  const [list, setList] = useState([]);
  const [status, setStatus] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [members, setMembers] = useState([]);
  const [classes, setClasses] = useState([]);
  const [form, setForm] = useState({ member_id: '', class_id: '' });

  const load = () =>
    api.get(`/bookings${status ? `?status=${status}` : ''}`).then(setList);
  useEffect(() => { load(); }, [status]);

  async function openCreate() {
    const [ms, cs] = await Promise.all([
      api.get('/members'),
      api.get(`/classes?from=${new Date().toISOString()}&to=${addDaysStr(todayStr(), 14)}T23:59:00`),
    ]);
    setMembers(ms);
    setClasses(cs.filter((c) => c.status === 'open' && new Date(c.start_at) > new Date()));
    setForm({ member_id: '', class_id: '' });
    setShowCreate(true);
  }

  async function create() {
    try {
      const r = await api.post('/bookings', { member_id: Number(form.member_id), class_id: Number(form.class_id) });
      notify(`约课成功，核销码 ${r.verify_code}（已预扣课次）`, 'success');
      setShowCreate(false);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function cancel(b) {
    const hours = (new Date(b.start_at) - Date.now()) / 3600e3;
    const n = b.cost_sessions || 1;
    const refundTip = hours >= 2 ? `将退还 ${n} 次课` : `距开课不足 2 小时，取消不退 ${n} 次课`;
    if (!confirm(`确定取消 ${b.member_name} 的「${b.title}」预约吗？\n${refundTip}`)) return;
    try {
      const r = await api.post(`/bookings/${b.id}/cancel`, {});
      notify(r.refund ? `已取消并退还 ${r.refund_sessions ?? n} 次课` : '已取消（不退次）', 'success');
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  const tabs = [['', '全部'], ['booked', '已预约'], ['checked', '已核销'], ['canceled', '已取消'], ['no_show', '未到店']];
  const selectedClass = classes.find((c) => c.id === Number(form.class_id));

  return (
    <div>
      <div className="page-title">预约管理</div>
      <div className="page-sub">约课时自动选卡、预扣课次；开课前 2 小时外取消退次，2 小时内取消不退次</div>

      <div className="toolbar">
        {tabs.map(([k, t]) => (
          <button key={t} className={`btn ${status === k ? 'primary' : ''}`} onClick={() => setStatus(k)}>{t}</button>
        ))}
        <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={openCreate}>+ 代客约课</button>
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>会员</th><th>课程</th><th>教练</th><th>场地</th><th>上课时间</th><th>核销码</th><th>状态</th><th>取消原因</th><th></th></tr></thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id}>
                  <td><Link to={`/members/${b.member_id}`} style={{ color: 'var(--accent)' }}>{b.member_name}</Link>
                    <div className="muted mono" style={{ fontSize: 11 }}>{b.phone}</div></td>
                  <td style={{ fontWeight: 600 }}>{b.title}</td>
                  <td className="muted">{b.coach_name || '—'}</td>
                  <td className="muted">{b.venue_name}</td>
                  <td className="nowrap">{fmtDateTime(b.start_at)}</td>
                  <td className="code-chip">{b.verify_code}</td>
                  <td><span className={`badge ${BOOKING_STATUS[b.status]?.cls || 'muted'}`}>{BOOKING_STATUS[b.status]?.text || b.status}</span></td>
                  <td className="muted" style={{ fontSize: 12, maxWidth: 180 }}>{b.cancel_reason || '—'}</td>
                  <td>{b.status === 'booked' && new Date(b.start_at) > new Date() &&
                    <button className="btn sm danger" onClick={() => cancel(b)}>取消预约</button>}</td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={9} className="empty">没有预约记录</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <Modal title="代客约课" onClose={() => setShowCreate(false)}>
          <div className="form-grid">
            <label className="field">会员
              <select value={form.member_id} onChange={(e) => setForm({ ...form, member_id: e.target.value })}>
                <option value="">请选择会员</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}（{m.phone}）</option>)}
              </select>
            </label>
            <label className="field">课程
              <select value={form.class_id} onChange={(e) => setForm({ ...form, class_id: e.target.value })}>
                <option value="">请选择课程</option>
                {classes.map((c) => <option key={c.id} value={c.id} disabled={c.booked_count >= c.capacity}>
                  {fmtDateTime(c.start_at)} {c.title}（{c.booked_count}/{c.capacity}）
                </option>)}
              </select>
            </label>
          </div>
          {selectedClass && (
            <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
              {selectedClass.coach_name} · {selectedClass.venue_name} · 已约 {selectedClass.booked_count}/{selectedClass.capacity} ·
              消耗 {selectedClass.cost_sessions} 课次
            </div>
          )}
          <div className="form-actions">
            <button className="btn" onClick={() => setShowCreate(false)}>取消</button>
            <button className="btn primary" disabled={!form.member_id || !form.class_id} onClick={create}>确认约课</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
