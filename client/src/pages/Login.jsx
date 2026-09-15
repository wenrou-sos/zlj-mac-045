import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { login } from '../auth.js';
import { notify } from '../notify.js';

const DEMO = [
  { role: '店长', username: 'manager', password: 'manager123' },
  { role: '前台', username: 'front', password: 'front123' },
  { role: '教练', username: 'coach1', password: 'coach123' },
];

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();

  async function submit(e) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    try {
      const u = await login(username.trim(), password);
      notify(`欢迎，${u.display_name}（${u.role_text}）`, 'success');
      nav(loc.state?.from || '/', { replace: true });
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  function fill(d) {
    setUsername(d.username);
    setPassword(d.password);
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="logo" style={{ textAlign: 'center', fontSize: 26, marginBottom: 4 }}>
          Power<span>Gym</span> 🏋
        </div>
        <div className="muted" style={{ textAlign: 'center', marginBottom: 20, fontSize: 13 }}>
          健身场馆管理系统 · 请登录
        </div>
        <label className="field">账号
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="登录账号" />
        </label>
        <label className="field">密码
          <input type="password" value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="密码" />
        </label>
        <button className="btn primary" style={{ width: '100%', marginTop: 6 }} disabled={loading}>
          {loading ? '登录中…' : '登 录'}
        </button>

        <div className="muted" style={{ fontSize: 12, marginTop: 16, textAlign: 'center' }}>
          演示账号（点击填充）
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {DEMO.map((d) => (
            <button type="button" key={d.username} className="btn sm" style={{ flex: 1, fontSize: 12 }}
              onClick={() => fill(d)}>
              {d.role}
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
