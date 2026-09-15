import { useEffect, useMemo, useState } from 'react';
import { api, fmtTime, weekdayCN, todayStr, addDaysStr, isoAt, isoAddHours, localDateOf } from '../api.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

const TITLES = ['动感单车', '阴瑜伽', '晨间 HIIT', '搏击操', '自由力量进阶', '核心普拉提', '功能性训练', '水中有氧', '杠铃塑形'];
const HOURS = [7, 9, 10, 12, 14, 16, 18, 19, 20];

export default function Classes() {
  const [list, setList] = useState([]);
  const [coaches, setCoaches] = useState([]);
  const [venues, setVenues] = useState([]);
  const [dayOffset, setDayOffset] = useState(0); // -7..14
  const [showCreate, setShowCreate] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailBookings, setDetailBookings] = useState([]);
  const [form, setForm] = useState({
    title: TITLES[0], coach_id: '', venue_id: '', date: todayStr(),
    hour: 19, duration: 1, capacity: 10, cost_sessions: 1,
  });

  const from = useMemo(() => addDaysStr(todayStr(), -7), []);
  const to = useMemo(() => addDaysStr(todayStr(), 14), []);

  const load = () =>
    api.get(`/classes?from=${isoAt(from, 0)}&to=${isoAt(to, 23, 59)}`).then(setList);
  useEffect(() => {
    load();
    api.get('/coaches').then(setCoaches);
    api.get('/venues').then(setVenues);
  }, []);

  async function create() {
    try {
      await api.post('/classes', {
        title: form.title,
        coach_id: form.coach_id ? Number(form.coach_id) : null,
        venue_id: form.venue_id ? Number(form.venue_id) : null,
        start_at: isoAt(form.date, form.hour),
        end_at: isoAddHours(form.date, form.hour, Number(form.duration)),
        capacity: Number(form.capacity),
        cost_sessions: Number(form.cost_sessions) || 1,
      });
      notify('排课成功（已校验教练与场地冲突）', 'success');
      setShowCreate(false);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function cancelClass(c) {
    if (!confirm(`确定取消「${c.title}」(${new Date(c.start_at).toLocaleString('zh-CN')})？\n已预约的 ${c.booked_count} 人将全部取消并退还次卡次数。`)) return;
    try {
      const r = await api.post(`/classes/${c.id}/cancel`, {});
      notify(`课程已取消，处理 ${r.affected} 条预约`, 'success');
      load();
      setDetail(null);
    } catch (e) { notify(e.message, 'error'); }
  }

  async function openDetail(c) {
    setDetail(c);
    setDetailBookings(await api.get(`/bookings?class_id=${c.id}`));
  }

  const selectedDate = addDaysStr(todayStr(), dayOffset);
  const dayList = list
    .filter((c) => localDateOf(c.start_at) === selectedDate)
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

  return (
    <div>
      <div className="page-title">课表排课</div>
      <div className="page-sub">排课时自动校验教练、场地时间冲突及场地容量上限</div>

      <div className="toolbar">
        <button className="btn" onClick={() => setDayOffset((d) => d - 1)}>← 前一天</button>
        <b style={{ minWidth: 150, textAlign: 'center' }}>
          {dayOffset === 0 ? '今天' : `${selectedDate} ${weekdayCN(selectedDate)}`}
          {dayOffset !== 0 && <span className="muted" style={{ fontWeight: 400 }}> ({selectedDate})</span>}
        </b>
        <button className="btn" onClick={() => setDayOffset((d) => d + 1)}>后一天 →</button>
        <button className="btn" onClick={() => setDayOffset(0)}>回到今天</button>
        <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => setShowCreate(true)}>+ 排一节课</button>
      </div>

      <div className="class-grid">
        {dayList.map((c) => {
          const pct = Math.round(c.booked_count / c.capacity * 100);
          const full = c.booked_count >= c.capacity;
          return (
            <div key={c.id} className={`class-card ${c.status === 'canceled' ? 'canceled' : new Date(c.start_at) < new Date() ? 'finished' : ''}`}>
              <div className="title">
                <span>{fmtTime(c.start_at)} - {fmtTime(c.end_at)} {c.title}</span>
                {c.status === 'canceled' && <span className="badge danger">已取消</span>}
                {c.status === 'finished' && <span className="badge muted">已结束</span>}
                {full && c.status === 'open' && <span className="badge warn">满员</span>}
              </div>
              <div className="meta">
                <span>🏋️ {c.coach_name || '待定教练'}</span>
                <span>🏟️ {c.venue_name || '待定场地'}</span>
              </div>
              <div className={`cap-bar ${full ? 'full' : ''}`}><div style={{ width: `${pct}%` }}></div></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="muted" style={{ fontSize: 12 }}>预约 {c.booked_count}/{c.capacity} · 已核销 {c.checked_count}</span>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button className="btn sm" onClick={() => openDetail(c)}>预约名单</button>
                  {c.status === 'open' && new Date(c.start_at) > new Date() &&
                    <button className="btn sm danger" onClick={() => cancelClass(c)}>取消课程</button>}
                </span>
              </div>
            </div>
          );
        })}
        {dayList.length === 0 && <div className="empty" style={{ gridColumn: '1/-1' }}>当天暂无排课</div>}
      </div>

      {showCreate && (
        <Modal title="排一节课" onClose={() => setShowCreate(false)}>
          <div className="form-grid">
            <label className="field">课程名称
              <select value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}>
                {TITLES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label className="field">日期
              <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
            <label className="field">开始时间
              <select value={form.hour} onChange={(e) => setForm({ ...form, hour: Number(e.target.value) })}>
                {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
            </label>
            <label className="field">时长（小时）
              <select value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })}>
                {[1, 1.5, 2].map((d) => <option key={d} value={d}>{d} 小时</option>)}
              </select>
            </label>
            <label className="field">教练
              <select value={form.coach_id} onChange={(e) => setForm({ ...form, coach_id: e.target.value })}>
                <option value="">待定</option>
                {coaches.filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.name}（{c.specialty}）</option>)}
              </select>
            </label>
            <label className="field">场地
              <select value={form.venue_id} onChange={(e) => {
                const v = venues.find((x) => x.id === Number(e.target.value));
                setForm({ ...form, venue_id: e.target.value, capacity: v ? Math.min(form.capacity, v.capacity) : form.capacity });
              }}>
                <option value="">待定</option>
                {venues.filter((v) => v.status === 'open').map((v) => <option key={v.id} value={v.id}>{v.name}（上限 {v.capacity} 人）</option>)}
              </select>
            </label>
            <label className="field">容量（人）
              <input type="number" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} /></label>
            <label className="field">消耗课次
              <select value={form.cost_sessions} onChange={(e) => setForm({ ...form, cost_sessions: Number(e.target.value) })}>
                <option value={1}>1 次 / 人</option>
                <option value={2}>2 次 / 人</option>
                <option value={3}>3 次 / 人</option>
              </select>
            </label>
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setShowCreate(false)}>取消</button>
            <button className="btn primary" onClick={create}>确认排课</button>
          </div>
        </Modal>
      )}

      {detail && (
        <Modal title={`${detail.title} · ${new Date(detail.start_at).toLocaleString('zh-CN')}`} onClose={() => setDetail(null)} wide>
          <div className="table-wrap">
            <table>
              <thead><tr><th>会员</th><th>电话</th><th>核销码</th><th>状态</th><th>预约/核销时间</th></tr></thead>
              <tbody>
                {detailBookings.map((b) => (
                  <tr key={b.id}>
                    <td>{b.member_name}</td>
                    <td className="mono muted">{b.phone}</td>
                    <td className="code-chip">{b.verify_code}</td>
                    <td><span className={`badge ${b.status === 'checked' ? 'ok' : b.status === 'booked' ? 'info' : 'muted'}`}>
                      {b.status === 'checked' ? '已核销' : b.status === 'booked' ? '已预约' : b.status === 'canceled' ? '已取消' : b.status === 'no_show' ? '未到店' : b.status}
                    </span></td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {b.status === 'checked' ? `核销于 ${fmtTime(b.checked_at)}` : b.status === 'canceled' ? '已取消' : `预约于 ${new Date(b.booked_at).toLocaleDateString('zh-CN')}`}
                    </td>
                  </tr>
                ))}
                {detailBookings.length === 0 && <tr><td colSpan={5} className="empty">暂无预约</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            {detail.status === 'open' && new Date(detail.start_at) > new Date() &&
              <button className="btn danger" onClick={() => cancelClass(detail)} style={{ marginRight: 'auto' }}>取消整节课（退次）</button>}
            <button className="btn" onClick={() => setDetail(null)}>关闭</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
