import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setSession } from '../api.js';
import { notify } from '../notify.js';

const DEMO = [
  { username: 'front', role: '前台', desc: '名单导出不含手机号、无金额' },
  { username: 'manager', role: '店长', desc: '全部数据、退款、结账冻结' },
  { username: 'investor', role: '投资人', desc: '经营/财务汇总，无会员明细' },
];

export default function Login() {
  const nav = useNavigate();
  const [username, setUsername] = useState('manager');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post('/auth/login', { username: username.trim(), password });
      setSession({ token: r.token, user: r.user });
      notify(`欢迎，${r.user.display_name}（${r.user.role_label}）`, 'ok');
      nav('/reports', { replace: true });
    } catch (err) {
      notify(err.message, 'error');
    } finally { setBusy(false); }
  }

  function fill(u) {
    setUsername(u);
    setPassword({ front: 'front123', manager: 'manager123', investor: 'investor123' }[u]);
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">Power<span>Gym</span> 🏋</div>
        <div className="login-title">经营报表登录</div>
        <div className="login-sub">角色与数据权限由服务端会话决定，前台导出的名单不会包含手机号</div>
        <label className="login-label">账号</label>
        <input className="login-input" value={username} onChange={(e) => setUsername(e.target.value)}
          autoFocus placeholder="front / manager / investor" />
        <label className="login-label">密码</label>
        <input className="login-input" type="password" value={password}
          onChange={(e) => setPassword(e.target.value)} placeholder="演示密码见下方，点击自动填入" />
        <button className="btn login-btn" disabled={busy}>{busy ? '登录中…' : '登 录'}</button>

        <div className="login-demo">
          <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>演示账号（点击自动填充）</div>
          {DEMO.map((d) => (
            <button type="button" key={d.username} className="demo-chip" onClick={() => fill(d.username)}>
              <b>{d.role}</b><code>{d.username}</code><span className="muted">{d.desc}</span>
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
