import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { notify } from '../notify.js';

export default function ChangePassword() {
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');

  async function submit() {
    if (newPassword.length < 6) return notify('新密码至少 6 位', 'error');
    if (newPassword !== confirm) return notify('两次输入的新密码不一致', 'error');
    try {
      await api.put('/auth/me/password', { old_password: oldPassword, new_password: newPassword });
      notify('密码已修改', 'success');
      setOld(''); setNew(''); setConfirm('');
    } catch (e) { notify(e.message, 'error'); }
  }

  return (
    <div>
      <div className="page-sub"><Link to="/" className="muted">← 返回工作台</Link></div>
      <div className="page-title">修改密码</div>
      <div className="panel" style={{ maxWidth: 420 }}>
        <div className="form-grid">
          <label className="field">原密码
            <input type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} /></label>
          <label className="field">新密码（至少 6 位）
            <input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} /></label>
          <label className="field">确认新密码
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()} /></label>
        </div>
        <div className="form-actions">
          <button className="btn primary" onClick={submit}>保存</button>
        </div>
      </div>
    </div>
  );
}
