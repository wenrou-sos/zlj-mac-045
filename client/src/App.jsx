import { useEffect, useState } from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import { subscribe } from './notify.js';
import { api } from './api.js';
import { useRole, setRole, ROLE_LABEL } from './role.js';

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
import Segments from './pages/Segments.jsx';
import FollowUps from './pages/FollowUps.jsx';

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

const nav = [
  { group: '运营总览' },
  { to: '/', label: '工作台', icon: '📊', end: true },
  { to: '/checkins', label: '到店核销', icon: '✅' },
  { group: '会员与卡' },
  { to: '/members', label: '会员管理', icon: '👤' },
  { to: '/segments', label: '会员分群', icon: '🎯' },
  { to: '/follow-ups', label: '跟进事项', icon: '📞', followBadge: true },
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

function RoleSwitcher({ role }) {
  return (
    <div className="role-box">
      <div className="role-title">当前角色</div>
      <div className="role-switch">
        {[['manager', '店长'], ['frontdesk', '前台']].map(([k, t]) => (
          <button key={k} className={role === k ? 'on' : ''} onClick={() => setRole(k)}>{t}</button>
        ))}
      </div>
      <div className="role-hint">
        {role === 'manager'
          ? '可维护标签 / 分群，生成待跟进'
          : `${ROLE_LABEL.frontdesk}：使用现成分群、导出名单、更新跟进`}
      </div>
    </div>
  );
}

export default function App() {
  const role = useRole();
  const [pending, setPending] = useState(0);
  const [followPending, setFollowPending] = useState(0);
  useEffect(() => {
    const load = () => {
      api.get('/reminders').then((r) => setPending(r.length)).catch(() => {});
      api.get('/follow-ups/counts').then((c) => setFollowPending(c.pending + c.contacted)).catch(() => {});
    };
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [role]);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">Power<span>Gym</span> 🏋</div>
        {nav.map((item, i) =>
          item.group ? (
            <div key={i} className="nav-group">{item.group}</div>
          ) : (
            <NavLink key={i} to={item.to} end={item.end}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <span>{item.icon}</span>{item.label}
              {item.badge && pending > 0 && <span className="nav-badge">{pending}</span>}
              {item.followBadge && followPending > 0 && <span className="nav-badge follow">{followPending}</span>}
            </NavLink>
          )
        )}
        <div style={{ marginTop: 'auto' }}>
          <RoleSwitcher role={role} />
        </div>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/checkins" element={<Checkins />} />
          <Route path="/members" element={<Members />} />
          <Route path="/members/:id" element={<MemberDetail />} />
          <Route path="/segments" element={<Segments />} />
          <Route path="/follow-ups" element={<FollowUps />} />
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
