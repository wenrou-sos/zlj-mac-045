import { useEffect, useState } from 'react';
import { api, fmtDateTime, fmtTime } from '../api.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

// 把 Date 转成 datetime-local 输入框需要的格式（本地时区）
function toInputValue(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function Leaves() {
  const [leaves, setLeaves] = useState([]);
  const [reassignments, setReassignments] = useState([]);
  const [coaches, setCoaches] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ coach_id: '', start: '', end: '', reason: '' });
  // 改派弹窗状态：当前请假单 + 受影响课程 + 每节课选中的代课教练
  const [reassignLeave, setReassignLeave] = useState(null);
  const [affected, setAffected] = useState([]);
  const [choices, setChoices] = useState({});

  const load = () => {
    api.get('/leaves').then(setLeaves);
    api.get('/reassignments').then(setReassignments);
  };
  useEffect(() => {
    load();
    api.get('/coaches').then((r) => setCoaches(r.filter((c) => c.status === 'active')));
  }, []);

  function openCreate() {
    const start = new Date(Date.now() + 86400e3);
    start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 4 * 3600e3);
    setForm({ coach_id: coaches[0]?.id || '', start: toInputValue(start), end: toInputValue(end), reason: '' });
    setShowCreate(true);
  }

  async function create() {
    try {
      const r = await api.post('/leaves', {
        coach_id: Number(form.coach_id),
        start_at: new Date(form.start).toISOString(),
        end_at: new Date(form.end).toISOString(),
        reason: form.reason,
      });
      setShowCreate(false);
      load();
      if (r.affected.length > 0) {
        notify(`请假已登记，有 ${r.affected.length} 节课受影响，请安排代课`, 'info');
        openReassign(r.leave);
      } else {
        notify('请假已登记，时段内没有受影响课程', 'success');
      }
    } catch (e) { notify(e.message, 'error'); }
  }

  async function cancelLeave(l) {
    if (!confirm(`确定给 ${l.coach_name} 销假？\n已改派出去的课程不会自动改回。`)) return;
    try {
      await api.post(`/leaves/${l.id}/cancel`, {});
      notify('已销假', 'success');
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function openReassign(leave) {
    setReassignLeave(leave);
    setChoices({});
    setAffected(await api.get(`/leaves/${leave.id}/affected`));
  }

  async function submitReassign() {
    const assignments = Object.entries(choices)
      .filter(([, v]) => v)
      .map(([class_id, to_coach_id]) => ({ class_id: Number(class_id), to_coach_id: Number(to_coach_id) }));
    if (assignments.length === 0) return notify('请先为课程选择代课教练', 'error');
    try {
      const r = await api.post(`/leaves/${reassignLeave.id}/reassign`, { assignments });
      notify(`已改派 ${r.count} 节课`, 'success');
      setReassignLeave(null);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  return (
    <div>
      <div className="page-title">请假与改派</div>
      <div className="page-sub">登记教练请假时段，把受影响课程一次改派给代课教练；改派时自动校验代课人当天排班、撞课与请假冲突</div>

      <div className="toolbar">
        <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={openCreate}>+ 登记请假</button>
      </div>

      <div className="panel">
        <h3>📋 请假记录</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>教练</th><th>请假时段</th><th>事由</th><th>状态</th><th>待改派课程</th><th>操作</th></tr></thead>
            <tbody>
              {leaves.map((l) => (
                <tr key={l.id}>
                    <td><b>{l.coach_name}</b></td>
                    <td className="nowrap">{fmtDateTime(l.start_at)} ~ {fmtDateTime(l.end_at)}</td>
                    <td className="muted">{l.reason || '—'}</td>
                    <td>{l.status === 'active' ? <span className="badge warn">请假中</span> : <span className="badge muted">已销假</span>}</td>
                    <td>{Number(l.affected_count) > 0 ? <span className="badge danger">{l.affected_count} 节</span> : <span className="muted">0</span>}</td>
                    <td className="nowrap">
                      {l.status === 'active' && (
                        <>
                          <button className="btn sm" onClick={() => openReassign(l)}>改派课程</button>{' '}
                          <button className="btn sm danger" onClick={() => cancelLeave(l)}>销假</button>
                        </>
                      )}
                    </td>
                  </tr>
              ))}
              {leaves.length === 0 && <tr><td colSpan={6} className="empty">暂无请假记录</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>🔁 改派记录</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>课程</th><th>上课时间</th><th>原教练 → 代课教练</th><th>备注</th><th>操作时间</th></tr></thead>
            <tbody>
              {reassignments.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.title}</b></td>
                  <td className="nowrap">{fmtDateTime(r.start_at)}</td>
                  <td>{r.from_coach_name || '未指派'} <span className="muted">→</span> <b>{r.to_coach_name}</b></td>
                  <td className="muted">{r.note || r.leave_reason || '—'}</td>
                  <td className="muted nowrap">{fmtDateTime(r.created_at)}</td>
                </tr>
              ))}
              {reassignments.length === 0 && <tr><td colSpan={5} className="empty">暂无改派记录</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <Modal title="登记请假" onClose={() => setShowCreate(false)}>
          <div className="form-grid">
            <label className="field">教练
              <select value={form.coach_id} onChange={(e) => setForm({ ...form, coach_id: e.target.value })}>
                {coaches.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.specialty}）</option>)}
              </select>
            </label>
            <label className="field">事由
              <input value={form.reason} placeholder="如：家中有事 / 外出培训" onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </label>
            <label className="field">请假开始
              <input type="datetime-local" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
            </label>
            <label className="field">请假结束
              <input type="datetime-local" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
            </label>
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setShowCreate(false)}>取消</button>
            <button className="btn primary" onClick={create}>登记请假</button>
          </div>
        </Modal>
      )}

      {reassignLeave && (
        <Modal title={`改派「${reassignLeave.coach_name}」请假期间的课程`} onClose={() => setReassignLeave(null)} wide>
          {affected.length === 0 && <div className="empty">该请假时段内没有待改派的课程</div>}
          {affected.length > 0 && (
            <>
              <p className="muted" style={{ marginBottom: 12, fontSize: 12.5 }}>
                为每节课选择代课教练（不选的保持原样）；提交时统一校验排班与撞课，任一失败则全部不生效。
              </p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>时间</th><th>课程</th><th>预约</th><th>代课教练</th></tr></thead>
                  <tbody>
                    {affected.map((c) => (
                      <tr key={c.id}>
                        <td className="nowrap">{fmtDateTime(c.start_at)} - {fmtTime(c.end_at)}</td>
                        <td><b>{c.title}</b>{c.locked_period && <span className="badge muted" style={{ marginLeft: 6 }}>🔒 {c.locked_period} 已结算</span>}</td>
                        <td>{c.booked_count} 人</td>
                        <td>
                          {c.locked_period ? <span className="muted" style={{ fontSize: 12 }}>已锁定，请用结算调整</span> : (
                            <select value={choices[c.id] || ''} onChange={(e) => setChoices({ ...choices, [c.id]: e.target.value })}>
                              <option value="">暂不改派</option>
                              {coaches.filter((x) => x.id !== c.coach_id).map((x) => (
                                <option key={x.id} value={x.id}>{x.name}（{x.specialty}）</option>
                              ))}
                            </select>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="form-actions">
            <button className="btn" onClick={() => setReassignLeave(null)}>关闭</button>
            {affected.some((c) => !c.locked_period) && (
              <button className="btn primary" onClick={submitReassign}>校验并一键改派</button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
