import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { subscribe } from './notify.js';
import { api, getUser, clearSession, setUnauthorizedHandler } from './api.js';

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
import Reports from './pages/Reports.jsx';
import Login from './pages/Login.jsx';

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

// 登录守卫：未登录只能看登录页
function RequireAuth({ children }) {
  const location = useLocation();
  if (!getUser()) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return children;
}

const NAV = [
  { group: '运营总览' },
  { to: '/', label: '工作台', icon: '📊', end: true },
  { to: '/reports', label: '经营报表', icon: '📈', auth: true },
  { to: '/checkins', label: '到店核销', icon: '✅' },
  { group: '会员与卡' },
  { to: '/members', label: '会员管理', icon: '👤' },
  { to: '/cards', label: '会员卡', icon: '💳' },
  { to: '/reminders', label: '续费提醒', icon: '🔔', badge: true },
  { group: '课程与教练' },
  { to: '/classes', label: '课表排课', icon: '📅' },
  { to: '/bookings', label: '预约管理', icon: '📝' },
  { to: '/coaches', label: '教练管理', icon: '🏋️' },
  { to: '/schedules', label: '教练排班', icon: '⏰' },
  { group: '场地器械' },
  { to: '/venues', label: '场地与器械', icon: '🏟️' },
];

function MainLayout() {
  const [pending, setPending] = useState(0);
  const user = getUser();
  const nav = useNavigate();

  useEffect(() => {
    const load = () => api.get('/reminders').then((r) => setPending(r.length)).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  async function logout() {
    try { await api.post('/auth/logout', {}); } catch { /* ignore */ }
    clearSession();
    nav('/login', { replace: true });
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">Power<span>Gym</span> 🏋</div>
        {NAV.map((item, i) =>
          item.group ? (
            <div key={i} className="nav-group">{item.group}</div>
          ) : (
            <NavLink key={i} to={item.to} end={item.end}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <span>{item.icon}</span>{item.label}
              {item.badge && pending > 0 && <span className="nav-badge">{pending}</span>}
              {item.auth && user && <span className="nav-role">{user.role_label || user.display_name}</span>}
            </NavLink>
          )
        )}
        {user && (
          <div className="sidebar-user">
            <div className="su-name">{user.display_name}</div>
            <div className="su-role">{user.role_label}</div>
            <button className="btn xs" onClick={logout}>退出登录</button>
          </div>
        )}
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/checkins" element={<Checkins />} />
          <Route path="/members" element={<Members />} />
          <Route path="/members/:id" element={<MemberDetail />} />
          <Route path="/cards" element={<Cards />} />
          <Route path="/reminders" element={<Reminders />} />
          <Route path="/classes" element={<Classes />} />
          <Route path="/bookings" element={<Bookings />} />
          <Route path="/coaches" element={<Coaches />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/venues" element={<Venues />} />
        </Routes>
      </main>
      <ToastHost />
    </div>
  );
}

export default function App() {
  const navigate = useNavigate();
  useEffect(() => {
    setUnauthorizedHandler(() => navigate('/login', { replace: true }));
  }, [navigate]);

  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reports" element={<RequireAuth><Reports /></RequireAuth>} />
        <Route path="/*" element={<MainLayout />} />
      </Routes>
      <ToastHost />
    </>
  );
}
