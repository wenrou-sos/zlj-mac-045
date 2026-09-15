import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation, useNavigate, Link } from 'react-router-dom';
import { subscribe } from './notify.js';
import { api } from './api.js';
import { getUser, logout, can, ROLE_TEXT, subscribeAuth } from './auth.js';

import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Members from './pages/Members.jsx';
import MemberDetail from './pages/MemberDetail.jsx';
import Cards from './pages/Cards.jsx';
import Classes from './pages/Classes.jsx';
import Bookings from './pages/Bookings.jsx';
import Coaches from './pages/Coaches.jsx';
import Schedules from './pages/Schedules.jsx';
import Venues from './pages/Venues.jsx';
import Checkins from './pages/Checkins.jsx';
import Reminders from './pages/Reminders.jsx';
import Audit from './pages/Audit.jsx';
import Users from './pages/Users.jsx';
import ChangePassword from './pages/ChangePassword.jsx';

function ToastHost() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => subscribe((message, type) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
  }), []);
  return (
    <div className="toast-wrap">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.type}`}>{t.message}</div>)}
    </div>
  );
}

// 导航项：perm 为空表示任何登录角色可见；隐藏只影响界面，后端仍逐接口鉴权
const NAV = [
  { group: '运营总览' },
  { to: '/', label: '工作台', icon: '📊', end: true, perm: 'dashboard' },
  { to: '/checkins', label: '到店核销', icon: '✅', perm: 'checkins_view' },
  { group: '会员与卡' },
  { to: '/members', label: '会员管理', icon: '👤', perm: 'members_view' },
  { to: '/cards', label: '会员卡', icon: '💳', perm: 'cards_view' },
  { to: '/reminders', label: '续费提醒', icon: '🔔', badge: true, perm: 'reminders_view' },
  { group: '课程与教练' },
  { to: '/classes', label: '课表排课', icon: '📅', perm: 'classes_view' },
  { to: '/bookings', label: '预约管理', icon: '📝', perm: 'bookings_view' },
  { to: '/coaches', label: '教练管理', icon: '🏋️', perm: 'coaches_view' },
  { to: '/schedules', label: '教练排班', icon: '⏰', perm: 'schedules_view' },
  { group: '场地器械' },
  { to: '/venues', label: '场地与器械', icon: '🏟️', perm: 'venues_view' },
  { group: '管理（店长）' },
  { to: '/audit', label: '操作审计', icon: '🛡️', perm: 'audit_view' },
  { to: '/users', label: '操作员账号', icon: '🔑', perm: 'users_manage' },
];

// 路由守卫：未登录跳 /login；权限不足显示 403
function Protected({ perm, children }) {
  const loc = useLocation();
  const user = getUser();
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (perm && !can(perm)) {
    return (
      <div className="panel" style={{ margin: 40, textAlign: 'center', padding: 60 }}>
        <div style={{ fontSize: 40 }}>🚫</div>
        <h3>无访问权限</h3>
        <div className="muted">「{ROLE_TEXT[user.role]}」角色不能访问此页面。如需操作，请联系店长。</div>
        <Link className="btn primary" to="/" style={{ marginTop: 16, display: 'inline-block' }}>返回工作台</Link>
      </div>
    );
  }
  return children;
}

function UserBar() {
  const nav = useNavigate();
  const [user, setUser] = useState(getUser());
  useEffect(() => subscribeAuth(setUser), []);
  async function doLogout() {
    await logout();
    nav('/login', { replace: true });
  }
  if (!user) return null;
  return (
    <header className="topbar">
      <div />
      <div className="userbar">
        <Link to="/account/password" className="user-chip" title="修改密码">
          <span className="user-avatar">{user.display_name.slice(0, 1)}</span>
          <span>{user.display_name}</span>
          <span className="badge info">{ROLE_TEXT[user.role]}</span>
        </Link>
        <button className="btn sm" onClick={doLogout}>退出登录</button>
      </div>
    </header>
  );
}

// 侧边导航：按当前角色过滤，分组下无可见项时连分组标题一起隐藏
function SideNav({ pending }) {
  return (
    <aside className="sidebar">
      <div className="logo">Power<span>Gym</span> 🏋</div>
      {NAV.map((item, i) => {
        if (item.group) {
          const until = NAV.slice(i + 1).findIndex((x) => x.group);
          const siblings = NAV.slice(i + 1, until === -1 ? undefined : i + 1 + until);
          if (!siblings.some((x) => can(x.perm))) return null;
          return <div key={i} className="nav-group">{item.group}</div>;
        }
        if (!can(item.perm)) return null;
        return (
          <NavLink key={i} to={item.to} end={item.end}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <span>{item.icon}</span>{item.label}
            {item.badge && pending > 0 && <span className="nav-badge">{pending}</span>}
          </NavLink>
        );
      })}
    </aside>
  );
}

export default function App() {
  const [user, setUser] = useState(getUser());
  const [pending, setPending] = useState(0);
  useEffect(() => subscribeAuth(setUser), []);

  useEffect(() => {
    if (!user || !can('reminders_view')) { setPending(0); return; }
    const load = () => api.get('/reminders').then((r) => setPending(r.length)).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [user]);

  // 未登录只渲染登录页
  if (!user) {
    return (
      <>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        <ToastHost />
      </>
    );
  }

  return (
    <div className="layout">
      <SideNav pending={pending} />

      <main className="main">
        <UserBar />
        <Routes>
          <Route path="/" element={<Protected perm="dashboard"><Dashboard /></Protected>} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/checkins" element={<Protected perm="checkins_view"><Checkins /></Protected>} />
          <Route path="/members" element={<Protected perm="members_view"><Members /></Protected>} />
          <Route path="/members/:id" element={<Protected perm="members_view"><MemberDetail /></Protected>} />
          <Route path="/cards" element={<Protected perm="cards_view"><Cards /></Protected>} />
          <Route path="/reminders" element={<Protected perm="reminders_view"><Reminders /></Protected>} />
          <Route path="/classes" element={<Protected perm="classes_view"><Classes /></Protected>} />
          <Route path="/bookings" element={<Protected perm="bookings_view"><Bookings /></Protected>} />
          <Route path="/coaches" element={<Protected perm="coaches_view"><Coaches /></Protected>} />
          <Route path="/schedules" element={<Protected perm="schedules_view"><Schedules /></Protected>} />
          <Route path="/venues" element={<Protected perm="venues_view"><Venues /></Protected>} />
          <Route path="/audit" element={<Protected perm="audit_view"><Audit /></Protected>} />
          <Route path="/users" element={<Protected perm="users_manage"><Users /></Protected>} />
          <Route path="/account/password" element={<ChangePassword />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <ToastHost />
    </div>
  );
}
