import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../api.js';
import { can } from '../auth.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

const empty = { name: '', phone: '', gender: '男', note: '' };

export default function Members() {
  const [list, setList] = useState([]);
  const [keyword, setKeyword] = useState('');
  const [modal, setModal] = useState(null); // {mode:'create'} | {mode:'edit', member}
  const [form, setForm] = useState(empty);

  const load = (kw = '') => api.get(`/members?keyword=${encodeURIComponent(kw)}`).then(setList);
  useEffect(() => { load(); }, []);

  async function save() {
    try {
      if (modal.mode === 'create') {
        await api.post('/members', form);
        notify('会员已添加', 'success');
      } else {
        await api.put(`/members/${modal.member.id}`, form);
        notify('会员信息已更新', 'success');
      }
      setModal(null);
      load(keyword);
    } catch (e) { notify(e.message, 'error'); }
  }

  return (
    <div>
      <div className="page-title">会员管理</div>
      <div className="page-sub">共 {list.length} 名会员</div>

      <div className="toolbar">
        <input className="search" placeholder="搜索姓名 / 手机号" value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load(keyword)} />
        <button className="btn" onClick={() => load(keyword)}>搜索</button>
        {can('members_write') && (
          <button className="btn primary" style={{ marginLeft: 'auto' }}
            onClick={() => { setForm(empty); setModal({ mode: 'create' }); }}>+ 新增会员</button>
        )}
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>姓名</th><th>性别</th><th>手机号</th><th>会员卡</th><th>入会日期</th><th>备注</th><th></th></tr></thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id}>
                  <td className="muted">#{m.id}</td>
                  <td style={{ fontWeight: 600 }}>{m.name}</td>
                  <td>{m.gender}</td>
                  <td className="mono">{m.phone}</td>
                  <td className="muted">{m.card_nos || '—'}</td>
                  <td>{fmtDate(m.joined_at)}</td>
                  <td className="muted">{m.note || '—'}</td>
                  <td className="nowrap">
                    <Link className="btn sm" to={`/members/${m.id}`}>详情</Link>
                    {can('members_write') && (
                      <button className="btn sm" style={{ marginLeft: 6 }}
                        onClick={() => { setForm({ name: m.name, phone: m.phone, gender: m.gender, note: m.note || '' }); setModal({ mode: 'edit', member: m }); }}>
                        编辑
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <Modal title={modal.mode === 'create' ? '新增会员' : '编辑会员'} onClose={() => setModal(null)}>
          <div className="form-grid">
            <label className="field">姓名 *
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field">手机号 *
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
            <label className="field">性别
              <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
                <option>男</option><option>女</option><option>未知</option>
              </select></label>
            <label className="field">备注
              <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setModal(null)}>取消</button>
            <button className="btn primary" onClick={save}>保存</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
