import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtTime } from '../api.js';
import { getUser, can } from '../auth.js';

function CoachDashboard() {
  const [stats, setStats] = useState(null);
  const [trend, setTrend] = useState([]);
  const [myClasses, setMyClasses] = useState([]);

  useEffect(() => {
    const now = new Date();
    const to = new Date(Date.now() + 7 * 86400e3).toISOString();
    Promise.all([
      api.get('/dashboard/stats'),
      api.get('/dashboard/trend'),
      api.get(`/classes?from=${now.toISOString()}&to=${to}`),
    ]).then(([s, t, cs]) => {
      setStats(s); setTrend(t);
      setMyClasses(cs.filter((c) => new Date(c.start_at) > Date.now()).slice(0, 8));
    }).catch(() => {});
  }, []);

  if (!stats) return <div className="empty">加载中…</div>;
  const maxV = Math.max(1, ...trend.map((d) => Math.max(d.classes, d.checked)));
  const cards = [
    { label: '今日我的课', value: stats.todayClasses, icon: '📅' },
    { label: '今日预约 / 已核销', value: `${stats.todayBookings} / ${stats.checkedToday}`, icon: '✅', cls: 'info' },
    { label: '未来 7 天排班', value: stats.myShifts, icon: '⏰', cls: 'accent' },
    { label: '未来待上课程', value: stats.upcomingClasses, icon: '🏋️', cls: 'warn' },
  ];

  return (
    <div>
      <div className="page-title">我的工作台</div>
      <div className="page-sub">{getUser()?.display_name}，这里只展示你自己的课程与排班数据</div>

      <div className="stat-grid">
        {cards.map((c) => (
          <div key={c.label} className="stat-card">
            <div className="label">{c.icon} {c.label}</div>
            <div className={`value ${c.cls || ''}`}>{c.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 18 }}>
        <div className="panel">
          <h3>📈 近 7 天我的开课与核销</h3>
          <div className="chart-bars">
            {trend.map((d) => (
              <div className="bar-col" key={d.day}>
                <div className="bars">
                  <div className="b classes" style={{ height: `${d.classes / maxV * 100}%` }} title={`开课 ${d.classes}`}></div>
                  <div className="b checked" style={{ height: `${d.checked / maxV * 100}%` }} title={`核销 ${d.checked}`}></div>
                </div>
                <div className="lab">{new Date(d.day).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h3>📅 我即将上的课
            <Link to="/classes" className="btn sm" style={{ marginLeft: 'auto' }}>全部课表</Link>
          </h3>
          {myClasses.length === 0 && <div className="empty">未来 7 天暂无排课</div>}
          {myClasses.map((c) => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid #20262f' }}>
              <div>
                <b>{c.title}</b>
                <div className="muted" style={{ fontSize: 12 }}>{fmtTime(c.start_at)} · {c.venue_name || '场地待定'}</div>
              </div>
              <div className="muted">{c.booked_count}/{c.capacity}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const user = getUser();
  const [stats, setStats] = useState(null);
  const [trend, setTrend] = useState([]);
  const [today, setToday] = useState([]);
  const [reminders, setReminders] = useState([]);

  useEffect(() => {
    if (user.role === 'coach') return;
    const tasks = [
      api.get('/dashboard/stats'),
      api.get('/dashboard/trend'),
      can('checkins_view') ? api.get('/checkins/today') : Promise.resolve([]),
      can('reminders_view') ? api.get('/reminders') : Promise.resolve([]),
    ];
    Promise.all(tasks).then(([s, t, c, r]) => {
      setStats(s); setTrend(t);
      setToday(c.filter((x) => x.status === 'booked'));
      setReminders(r.slice(0, 6));
    }).catch(() => {});
  }, []);

  if (user.role === 'coach') return <CoachDashboard />;
  if (!stats) return <div className="empty">加载中…</div>;

  const maxV = Math.max(1, ...trend.map((d) => Math.max(d.classes, d.checked)));
  const cards = [
    { label: '会员总数', value: stats.members, icon: '👤' },
    { label: '有效会员卡', value: stats.activeCards, icon: '💳', cls: 'accent' },
    { label: '今日课程', value: stats.todayClasses, icon: '📅' },
    { label: '今日预约 / 已核销', value: `${stats.todayBookings} / ${stats.checkedToday}`, icon: '✅', cls: 'info' },
    { label: '7天内到期', value: stats.expiringSoon, icon: '⏳', cls: 'warn' },
    { label: '次卡余额不足', value: stats.lowSessions, icon: '🔔', cls: 'danger' },
    { label: '在岗教练', value: stats.coaches, icon: '🏋️' },
    { label: '开放场地 / 维修器械', value: `${stats.venuesOpen} / ${stats.maintenance}`, icon: '🏟️' },
  ];

  return (
    <div>
      <div className="page-title">工作台</div>
      <div className="page-sub">{new Date().toLocaleDateString('zh-CN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} · 场馆运营总览</div>

      <div className="stat-grid">
        {cards.map((c) => (
          <div key={c.label} className="stat-card">
            <div className="label">{c.icon} {c.label}</div>
            <div className={`value ${c.cls || ''}`}>{c.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 18 }}>
        <div className="panel">
          <h3>📈 近 7 天开课与核销趋势
            <span className="legend" style={{ marginLeft: 'auto' }}>
              <span><i style={{ background: '#3a4555' }}></i>开课</span>
              <span><i style={{ background: 'var(--accent)' }}></i>核销</span>
            </span>
          </h3>
          <div className="chart-bars">
            {trend.map((d) => (
              <div className="bar-col" key={d.day}>
                <div className="bars">
                  <div className="b classes" style={{ height: `${d.classes / maxV * 100}%` }} title={`开课 ${d.classes}`}></div>
                  <div className="b checked" style={{ height: `${d.checked / maxV * 100}%` }} title={`核销 ${d.checked}`}></div>
                </div>
                <div className="lab">{new Date(d.day).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</div>
              </div>
            ))}
          </div>
        </div>

        {can('reminders_view') && (
          <div className="panel">
            <h3>🔔 待处理提醒 <Link to="/reminders" className="btn sm" style={{ marginLeft: 'auto' }}>全部</Link></h3>
            {reminders.length === 0 && <div className="empty">暂无待处理提醒</div>}
            {reminders.map((r) => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid #20262f', gap: 10 }}>
                <div>
                  <span className={`badge ${r.type === 'expired' ? 'danger' : r.type === 'low_sessions' ? 'warn' : 'info'}`}>
                    {r.type === 'expired' ? '已过期' : r.type === 'low_sessions' ? '次数不足' : '即将到期'}
                  </span>
                  <span style={{ marginLeft: 8 }}>{r.member_name}</span>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{r.message}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {can('checkins_view') && (
        <div className="panel">
          <h3>🏃 今日待核销（已预约未到店）<Link to="/checkins" className="btn sm" style={{ marginLeft: 'auto' }}>去核销</Link></h3>
          {today.length === 0 && <div className="empty">今日暂无待核销预约</div>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>核销码</th><th>会员</th><th>课程</th><th>场地</th><th>开始时间</th><th>会员卡</th></tr></thead>
              <tbody>
                {today.slice(0, 8).map((b) => (
                  <tr key={b.id}>
                    <td className="code-chip">{b.verify_code}</td>
                    <td>{b.member_name}</td>
                    <td>{b.title}</td>
                    <td className="muted">{b.venue_name}</td>
                    <td>{fmtTime(b.start_at)}</td>
                    <td className="muted">{b.plan_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
