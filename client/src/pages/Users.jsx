import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api.js';
import { ROLE_TEXT } from '../auth.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

const empty = { username: '', display_name: '', password: '', role: 'front_desk', coach_id: '' };

export default function Users() {
  const [list, setList] = useState([]);
  const [coaches, setCoaches] = useState([]);
  const [modal, setModal] = useState(null); // {mode:'create'} | {mode:'edit', user}
  const [form, setForm] = useState(empty);
  const [resetPwd, setResetPwd] = useState('');

  const load = () => api.get('/auth/users').then(setList);
  useEffect(() => {
    load();
    api.get('/auth/coaches-linkable').then(setCoaches).catch(() => {});
  }, []);

  async function create() {
    try {
      await api.post('/auth/users', {
        username: form.username.trim(),
        display_name: form.display_name.trim(),
        password: form.password,
        role: form.role,
        coach_id: form.role === 'coach' ? Number(form.coach_id) : null,
      });
      notify('账号已创建', 'success');
      setModal(null);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function saveEdit() {
    try {
      await api.put(`/auth/users/${modal.user.id}`, {
        display_name: form.display_name.trim(),
        role: form.role,
        coach_id: form.role === 'coach' ? Number(form.coach_id) : null,
        status: modal.user.status,
        password: resetPwd || undefined,
      });
      notify('账号已更新', 'success');
      setModal(null);
      setResetPwd('');
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function toggle(u) {
    const next = u.status === 'active' ? 'disabled' : 'active';
    if (!confirm(`确定${next === 'disabled' ? '停用' : '启用'}账号「${u.display_name}」？${next === 'disabled' ? '\n停用后该账号会被立即踢下线。' : ''}`)) return;
    try {
      await api.put(`/auth/users/${u.id}`, {
        display_name: u.display_name, role: u.role, coach_id: u.coach_id, status: next,
      });
      notify(next === 'disabled' ? '已停用' : '已启用', 'success');
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  return (
    <div>
      <div className="page-title">操作员账号</div>
      <div className="page-sub">店长 / 前台 / 教练各自登录，按角色限制页面与操作；教练账号需关联教练档案</div>

      <div className="toolbar">
        <button className="btn primary" style={{ marginLeft: 'auto' }}
          onClick={() => { setForm(empty); setModal({ mode: 'create' }); }}>+ 新建账号</button>
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>登录名</th><th>姓名</th><th>角色</th><th>关联教练</th><th>最近登录</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id}>
                  <td className="muted">#{u.id}</td>
                  <td className="mono">{u.username}</td>
                  <td style={{ fontWeight: 600 }}>{u.display_name}</td>
                  <td><span className={`badge ${u.role === 'manager' ? 'danger' : u.role === 'front_desk' ? 'info' : 'ok'}`}>{u.role_text}</span></td>
                  <td>{u.coach_name || '—'}</td>
                  <td className="muted nowrap">{u.last_login_at ? fmtDateTime(u.last_login_at) : '从未登录'}</td>
                  <td><span className={`badge ${u.status === 'active' ? 'ok' : 'muted'}`}>{u.status === 'active' ? '启用' : '停用'}</span></td>
                  <td className="nowrap">
                    <button className="btn sm" onClick={() => {
                      setForm({ username: u.username, display_name: u.display_name, password: '', role: u.role, coach_id: u.coach_id || '' });
                      setResetPwd('');
                      setModal({ mode: 'edit', user: u });
                    }}>编辑/重置密码</button>
                    <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => toggle(u)}>
                      {u.status === 'active' ? '停用' : '启用'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <Modal title={modal.mode === 'create' ? '新建账号' : `编辑账号 · ${modal.user.username}`} onClose={() => setModal(null)}>
          <div className="form-grid">
            <label className="field">登录名
              <input value={form.username} disabled={modal.mode === 'edit'}
                onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
            <label className="field">姓名
              <input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></label>
            <label className="field">角色
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="manager">店长（全量权限）</option>
                <option value="front_desk">前台（收款/核销，不可改价退款导出）</option>
                <option value="coach">教练（只看自己的课和排班）</option>
              </select>
            </label>
            {form.role === 'coach' && (
              <label className="field">关联教练档案 *
                <select value={form.coach_id} onChange={(e) => setForm({ ...form, coach_id: e.target.value })}>
                  <option value="">请选择教练</option>
                  {coaches.map((c) => <option key={c.id} value={c.id} disabled={c.linked_user_id && c.linked_user_id !== modal.user?.id}>
                    {c.name}（{c.specialty || '—'}）{c.linked_user_id && c.linked_user_id !== modal.user?.id ? ' · 已关联账号' : ''}
                  </option>)}
                </select>
              </label>
            )}
            {modal.mode === 'create'
              ? <label className="field">初始密码（至少 6 位）
                  <input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="至少 6 位" /></label>
              : <label className="field">重置密码（留空表示不改）
                  <input type="text" value={resetPwd} onChange={(e) => setResetPwd(e.target.value)} placeholder="留空不改" /></label>}
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setModal(null)}>取消</button>
            <button className="btn primary" onClick={modal.mode === 'create' ? create : saveEdit}>
              {modal.mode === 'create' ? '创建' : '保存'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
