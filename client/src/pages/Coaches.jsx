import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

const empty = { name: '', phone: '', specialty: '', hourly_rate: 200 };

export default function Coaches() {
  const [list, setList] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(empty);

  const load = () => api.get('/coaches').then(setList);
  useEffect(() => { load(); }, []);

  async function save() {
    try {
      if (modal.mode === 'create') await api.post('/coaches', form);
      else await api.put(`/coaches/${modal.coach.id}`, { ...form, status: modal.coach.status });
      notify('保存成功', 'success');
      setModal(null);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function toggle(c) {
    await api.put(`/coaches/${c.id}`, { ...c, status: c.status === 'active' ? 'inactive' : 'active' });
    notify(c.status === 'active' ? '已停用' : '已启用', 'success');
    load();
  }

  return (
    <div>
      <div className="page-title">教练管理</div>
      <div className="page-sub">教练档案、专长与课时费；停用后不再出现在排课教练列表</div>

      <div className="toolbar">
        <button className="btn primary" style={{ marginLeft: 'auto' }}
          onClick={() => { setForm(empty); setModal({ mode: 'create' }); }}>+ 新增教练</button>
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>姓名</th><th>电话</th><th>专长</th><th>课时费</th><th>未来排班</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td className="muted">#{c.id}</td>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td className="mono">{c.phone}</td>
                  <td>{c.specialty}</td>
                  <td>¥{Number(c.hourly_rate).toFixed(0)}/时</td>
                  <td>{c.upcoming_shifts} 个班</td>
                  <td><span className={`badge ${c.status === 'active' ? 'ok' : 'muted'}`}>{c.status === 'active' ? '在岗' : '停用'}</span></td>
                  <td className="nowrap">
                    <button className="btn sm" onClick={() => { setForm({ name: c.name, phone: c.phone || '', specialty: c.specialty || '', hourly_rate: Number(c.hourly_rate) }); setModal({ mode: 'edit', coach: c }); }}>编辑</button>
                    <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => toggle(c)}>{c.status === 'active' ? '停用' : '启用'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <Modal title={modal.mode === 'create' ? '新增教练' : '编辑教练'} onClose={() => setModal(null)}>
          <div className="form-grid">
            <label className="field">姓名 *
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field">电话
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
            <label className="field">专长
              <input value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} placeholder="如：力量训练/瑜伽" /></label>
            <label className="field">课时费（元/时）
              <input type="number" value={form.hourly_rate} onChange={(e) => setForm({ ...form, hourly_rate: Number(e.target.value) })} /></label>
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
