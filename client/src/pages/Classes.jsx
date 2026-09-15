import { useEffect, useMemo, useState } from 'react';
import { api, fmtTime, fmtDateTime, weekdayCN, todayStr, addDaysStr, isoAt, isoAddHours, localDateOf, WAITLIST_STATUS } from '../api.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

const TITLES = ['动感单车', '阴瑜伽', '晨间 HIIT', '搏击操', '自由力量进阶', '核心普拉提', '功能性训练', '水中有氧', '杠铃塑形'];
const HOURS = [7, 9, 10, 12, 14, 16, 18, 19, 20];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export default function Classes() {
  const [list, setList] = useState([]);
  const [coaches, setCoaches] = useState([]);
  const [venues, setVenues] = useState([]);
  const [dayOffset, setDayOffset] = useState(0); // -7..14
  const [showCreate, setShowCreate] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  const [batchResult, setBatchResult] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailBookings, setDetailBookings] = useState([]);
  const [detailWaitlist, setDetailWaitlist] = useState([]);
  const [form, setForm] = useState({
    title: TITLES[0], coach_id: '', venue_id: '', date: todayStr(),
    hour: 19, duration: 1, capacity: 10, cost_sessions: 1,
  });
  const [batchForm, setBatchForm] = useState({
    title: TITLES[0], coach_id: '', venue_id: '', weekdays: [1, 3, 5],
    hour: 19, duration: 1, from: todayStr(), to: addDaysStr(todayStr(), 13),
    capacity: 10, cost_sessions: 1,
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
      notify('排课成功（已校验教练与场地冲突、场地可用性）', 'success');
      setShowCreate(false);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function createBatch() {
    try {
      const r = await api.post('/classes/batch', {
        title: batchForm.title,
        coach_id: batchForm.coach_id ? Number(batchForm.coach_id) : null,
        venue_id: batchForm.venue_id ? Number(batchForm.venue_id) : null,
        weekdays: batchForm.weekdays,
        start_time: `${String(batchForm.hour).padStart(2, '0')}:00`,
        duration_hours: Number(batchForm.duration),
        from: batchForm.from,
        to: batchForm.to,
        capacity: Number(batchForm.capacity),
        cost_sessions: Number(batchForm.cost_sessions) || 1,
      });
      setBatchResult(r);
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
    const [bs, wl] = await Promise.all([
      api.get(`/bookings?class_id=${c.id}`),
      api.get(`/waitlists?class_id=${c.id}`),
    ]);
    setDetailBookings(bs);
    setDetailWaitlist(wl);
  }

  async function cancelWaitlist(w) {
    try {
      await api.post(`/waitlists/${w.id}/cancel`, {});
      notify('已取消候补', 'success');
      openDetail(detail);
    } catch (e) { notify(e.message, 'error'); }
  }

  async function promoteNow() {
    try {
      const r = await api.post('/waitlists/promote', { class_id: detail.id });
      notify(r.promoted ? `已递补：${r.promoted.member_name}（核销码 ${r.promoted.verify_code}）` : (r.note || '暂无可递补会员'), r.promoted ? 'success' : 'info');
      openDetail(detail);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  const selectedDate = addDaysStr(todayStr(), dayOffset);
  const dayList = list
    .filter((c) => localDateOf(c.start_at) === selectedDate)
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

  const waitingCount = detailWaitlist.filter((w) => w.status === 'waiting').length;
  const hasSpot = detail && detail.status === 'open' && detail.booked_count < detail.capacity;

  return (
    <div>
      <div className="page-title">课表排课</div>
      <div className="page-sub">排课自动校验教练、场地时间冲突、容量上限及场地可用性（停用 / 一次性闭馆 / 每周闭馆）</div>

      <div className="toolbar">
        <button className="btn" onClick={() => setDayOffset((d) => d - 1)}>← 前一天</button>
        <b style={{ minWidth: 150, textAlign: 'center' }}>
          {dayOffset === 0 ? '今天' : `${selectedDate} ${weekdayCN(selectedDate)}`}
          {dayOffset !== 0 && <span className="muted" style={{ fontWeight: 400 }}> ({selectedDate})</span>}
        </b>
        <button className="btn" onClick={() => setDayOffset((d) => d + 1)}>后一天 →</button>
        <button className="btn" onClick={() => setDayOffset(0)}>回到今天</button>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => { setBatchResult(null); setShowBatch(true); }}>批量排课</button>
          <button className="btn primary" onClick={() => setShowCreate(true)}>+ 排一节课</button>
        </span>
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
                {Number(c.waitlist_count) > 0 && c.status === 'open' && <span className="badge info">候补 {c.waitlist_count}</span>}
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

      {showBatch && (
        <Modal title="批量生成课表" onClose={() => setShowBatch(false)} wide>
          <div className="form-grid">
            <label className="field">课程名称
              <select value={batchForm.title} onChange={(e) => setBatchForm({ ...batchForm, title: e.target.value })}>
                {TITLES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label className="field">开始日期
              <input type="date" value={batchForm.from} onChange={(e) => setBatchForm({ ...batchForm, from: e.target.value })} /></label>
            <label className="field">结束日期
              <input type="date" value={batchForm.to} onChange={(e) => setBatchForm({ ...batchForm, to: e.target.value })} /></label>
            <label className="field">开始时间
              <select value={batchForm.hour} onChange={(e) => setBatchForm({ ...batchForm, hour: Number(e.target.value) })}>
                {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
            </label>
            <label className="field">时长（小时）
              <select value={batchForm.duration} onChange={(e) => setBatchForm({ ...batchForm, duration: e.target.value })}>
                {[1, 1.5, 2].map((d) => <option key={d} value={d}>{d} 小时</option>)}
              </select>
            </label>
            <label className="field">教练
              <select value={batchForm.coach_id} onChange={(e) => setBatchForm({ ...batchForm, coach_id: e.target.value })}>
                <option value="">待定</option>
                {coaches.filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.name}（{c.specialty}）</option>)}
              </select>
            </label>
            <label className="field">场地
              <select value={batchForm.venue_id} onChange={(e) => setBatchForm({ ...batchForm, venue_id: e.target.value })}>
                <option value="">待定</option>
                {venues.filter((v) => v.status === 'open').map((v) => <option key={v.id} value={v.id}>{v.name}（上限 {v.capacity} 人）</option>)}
              </select>
            </label>
            <label className="field">容量（人）
              <input type="number" value={batchForm.capacity} onChange={(e) => setBatchForm({ ...batchForm, capacity: e.target.value })} /></label>
            <label className="field">消耗课次
              <select value={batchForm.cost_sessions} onChange={(e) => setBatchForm({ ...batchForm, cost_sessions: Number(e.target.value) })}>
                <option value={1}>1 次 / 人</option>
                <option value={2}>2 次 / 人</option>
                <option value={3}>3 次 / 人</option>
              </select>
            </label>
            <div className="field" style={{ gridColumn: '1/-1' }}>每周
              <div className="weekday-picker">
                {WEEKDAYS.map((w, i) => (
                  <button key={i} type="button"
                    className={`btn ${batchForm.weekdays.includes(i) ? 'primary' : ''}`}
                    onClick={() => setBatchForm({
                      ...batchForm,
                      weekdays: batchForm.weekdays.includes(i)
                        ? batchForm.weekdays.filter((d) => d !== i)
                        : [...batchForm.weekdays, i].sort(),
                    })}>周{w}</button>
                ))}
              </div>
            </div>
          </div>

          {batchResult && (
            <div className="batch-result">
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                已生成 {batchResult.created} 节{batchResult.skipped > 0 && <span className="skip">，跳过 {batchResult.skipped} 节</span>}
              </div>
              {batchResult.items.filter((i) => i.status === 'skipped').map((i, idx) => (
                <div key={idx} className="skip">· {fmtDateTime(i.start_at)}：{i.reason}</div>
              ))}
            </div>
          )}

          <div className="form-actions">
            <button className="btn" onClick={() => setShowBatch(false)}>关闭</button>
            <button className="btn primary" disabled={batchForm.weekdays.length === 0} onClick={createBatch}>生成课表</button>
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

          <h4 style={{ margin: '16px 0 8px', fontSize: 14 }}>
            候补队列（{waitingCount} 人排队）
            {hasSpot && waitingCount > 0 &&
              <button className="btn sm primary" style={{ marginLeft: 10 }} onClick={promoteNow}>立即递补</button>}
          </h4>
          <div className="table-wrap">
            <table>
              <thead><tr><th>会员</th><th>电话</th><th>登记时间</th><th>状态</th><th>备注</th><th></th></tr></thead>
              <tbody>
                {detailWaitlist.map((w) => (
                  <tr key={w.id}>
                    <td>{w.member_name}</td>
                    <td className="mono muted">{w.phone}</td>
                    <td className="muted nowrap">{fmtDateTime(w.created_at)}</td>
                    <td><span className={`badge ${WAITLIST_STATUS[w.status]?.cls || 'muted'}`}>{WAITLIST_STATUS[w.status]?.text || w.status}</span></td>
                    <td className="muted" style={{ fontSize: 12 }}>{w.note || '—'}</td>
                    <td>{w.status === 'waiting' &&
                      <button className="btn sm danger" onClick={() => cancelWaitlist(w)}>取消候补</button>}</td>
                  </tr>
                ))}
                {detailWaitlist.length === 0 && <tr><td colSpan={6} className="empty">暂无候补</td></tr>}
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
