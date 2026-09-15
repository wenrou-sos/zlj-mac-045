import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtDateTime, FOLLOWUP_STATUS } from '../api.js';
import { notify } from '../notify.js';
import { useRole } from '../role.js';
import Modal from '../components/Modal.jsx';

const TABS = [
  ['pending', '待跟进'], ['contacted', '已联系'], ['renewed', '已续费'],
  ['invalid', '无效'], ['all', '全部'],
];

const TARGET_STATUS = {
  contacted: { label: '已联系', requireNote: false, hint: '已电话/微信联系，暂未续费，继续跟进' },
  renewed: { label: '已续费', requireNote: false, hint: '会员已续费/续卡，事项结束' },
  invalid: { label: '无效', requireNote: true, hint: '号码错误/明确拒绝等，请写明原因' },
};

function ResolveModal({ item, target, onClose, done }) {
  const [note, setNote] = useState('');
  const meta = TARGET_STATUS[target];
  async function submit() {
    if (meta.requireNote && !note.trim()) return notify('标记无效需要填写原因', 'error');
    try {
      await api.post(`/follow-ups/${item.id}/status`, { status: target, result_note: note.trim() });
      notify(`已标记为${meta.label}`, 'success');
      done();
    } catch (e) { notify(e.message, 'error'); }
  }
  return (
    <Modal title={`标记「${meta.label}」· ${item.member_name}`} onClose={onClose}>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>{meta.hint}</div>
      <label className="field">跟进结论
        <textarea rows={4} placeholder="联系情况、会员意向、下次跟进时间……"
          value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="form-actions">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={submit}>确认</button>
      </div>
    </Modal>
  );
}

export default function FollowUps() {
  const role = useRole();
  const manager = role === 'manager';
  const [tab, setTab] = useState('pending');
  const [list, setList] = useState([]);
  const [resolve, setResolve] = useState(null); // {item, target}

  const load = () => api.get(`/follow-ups?status=${tab}`).then(setList);
  useEffect(() => { load(); }, [tab]);

  async function setStatus(f, status) {
    try {
      await api.post(`/follow-ups/${f.id}/status`, { status });
      notify(status === 'pending' ? '已重新打开' : '状态已更新', 'success');
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  const open = (f) => f.status === 'pending' || f.status === 'contacted';

  return (
    <div>
      <div className="page-title">跟进事项</div>
      <div className="page-sub">
        分群名单一键生成的回访待办都在这里；处理后请标记状态，会员续费/续卡后事项会自动结束
        {!manager && '（前台：只能使用现成分群并更新跟进状态）'}
      </div>

      <div className="toolbar">
        {TABS.map(([k, t]) => (
          <button key={k} className={`btn ${tab === k ? 'primary' : ''}`} onClick={() => setTab(k)}>{t}</button>
        ))}
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>状态</th><th>会员</th><th>跟进内容</th><th>来源分群</th><th>指派</th><th>应跟进</th>
              <th>结论</th><th>时间</th><th>操作</th></tr>
            </thead>
            <tbody>
              {list.map((f) => {
                const overdue = open(f) && f.due_date && f.due_date.slice(0, 10) < new Date().toLocaleDateString('en-CA');
                return (
                  <tr key={f.id} className={f.status === 'pending' ? 'row-open' : ''}>
                    <td>
                      <span className={`badge ${FOLLOWUP_STATUS[f.status]?.cls}`}>{FOLLOWUP_STATUS[f.status]?.text}</span>
                      {f.auto_closed && <div style={{ fontSize: 11 }} className="muted">系统自动</div>}
                    </td>
                    <td>
                      <Link to={`/members/${f.member_id}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>{f.member_name}</Link>
                      <div className="muted mono" style={{ fontSize: 11.5 }}>{f.phone}</div>
                    </td>
                    <td style={{ maxWidth: 220 }}>
                      <div style={{ fontWeight: 600 }}>{f.title}</div>
                      {f.content && <div className="muted" style={{ fontSize: 12 }}>{f.content}</div>}
                    </td>
                    <td className="muted">{f.segment_name || '手工创建'}</td>
                    <td className="muted">{f.assignee}</td>
                    <td className="nowrap">
                      {f.due_date ? (
                        <span className={overdue ? 'badge danger' : 'muted'} style={{ fontSize: 11.5 }}>
                          {overdue && '逾期 · '}{fmtDate(f.due_date)}
                        </span>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td style={{ maxWidth: 200, fontSize: 12.5 }}>
                      {f.result_note || <span className="muted">—</span>}
                      {f.handler && <div className="muted" style={{ fontSize: 11 }}>{f.handler} 处理</div>}
                      {f.auto_closed && f.closed_reason && <div className="muted" style={{ fontSize: 11 }}>{f.closed_reason}</div>}
                    </td>
                    <td className="muted nowrap" style={{ fontSize: 11.5 }}>
                      创 {fmtDateTime(f.created_at)}
                      {f.contacted_at && <div>联 {fmtDateTime(f.contacted_at)}</div>}
                      {f.closed_at && <div>结 {fmtDateTime(f.closed_at)}</div>}
                    </td>
                    <td className="nowrap">
                      {f.status === 'pending' && (
                        <>
                          <button className="btn sm" onClick={() => setResolve({ item: f, target: 'contacted' })}>已联系</button>
                          <button className="btn sm primary" style={{ marginLeft: 6 }}
                            onClick={() => setResolve({ item: f, target: 'renewed' })}>已续费</button>
                          <button className="btn sm danger" style={{ marginLeft: 6 }}
                            onClick={() => setResolve({ item: f, target: 'invalid' })}>无效</button>
                        </>
                      )}
                      {f.status === 'contacted' && (
                        <>
                          <button className="btn sm primary" onClick={() => setResolve({ item: f, target: 'renewed' })}>已续费</button>
                          <button className="btn sm danger" style={{ marginLeft: 6 }}
                            onClick={() => setResolve({ item: f, target: 'invalid' })}>无效</button>
                          {manager && <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => setStatus(f, 'pending')}>重开</button>}
                        </>
                      )}
                      {!open(f) && manager && (
                        <button className="btn sm" onClick={() => setStatus(f, 'pending')}>重新打开</button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {list.length === 0 && <tr><td colSpan={9} className="empty">没有该状态的跟进事项 🎉</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {resolve && <ResolveModal item={resolve.item} target={resolve.target}
        onClose={() => setResolve(null)} done={() => { setResolve(null); load(); }} />}
    </div>
  );
}
