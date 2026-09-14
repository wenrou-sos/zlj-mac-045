import { useEffect, useMemo, useState } from 'react';
import { api, todayStr, addDaysStr, weekdayCN } from '../api.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

const TIMES = ['07:00', '09:00', '10:00', '13:00', '14:00', '16:00', '18:00', '19:00'];
const END_AFTER = { '07:00': '12:00', '09:00': '17:00', '10:00': '18:00', '13:00': '21:00', '14:00': '22:00', '16:00': '22:00', '18:00': '22:00', '19:00': '21:00' };
const SHIFT_TEXT = { morning: '早班', normal: '正常班', evening: '晚班' };
const SHIFT_CLS = { morning: 'info', normal: 'ok', evening: 'warn' };

export default function Schedules() {
  const [list, setList] = useState([]);
  const [coaches, setCoaches] = useState([]);
  const [startOffset, setStartOffset] = useState(0);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ coach_id: '', work_date: todayStr(), start_time: '09:00', end_time: '17:00', shift_type: 'normal' });

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysStr(todayStr(), startOffset + i)), [startOffset]);

  const load = () =>
    api.get(`/schedules?start=${days[0]}&end=${days[6]}`).then(setList);
  useEffect(() => { load(); }, [startOffset]);
  useEffect(() => { api.get('/coaches').then((r) => setCoaches(r.filter((c) => c.status === 'active'))); }, []);

  async function save() {
    try {
      await api.post('/schedules', form);
      notify('排班成功', 'success');
      setModal(false);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function remove(s) {
    if (!confirm(`删除 ${s.coach_name} ${s.work_date} ${s.start_time}-${s.end_time} 的排班？`)) return;
    await api.del(`/schedules/${s.id}`);
    notify('排班已删除', 'success');
    load();
  }

  return (
    <div>
      <div className="page-title">教练排班</div>
      <div className="page-sub">以周视图管理教练班次，同一教练时间重叠的排班将被自动拦截</div>

      <div className="toolbar">
        <button className="btn" onClick={() => setStartOffset((d) => d - 7)}>← 上一周</button>
        <b>{days[0]} ~ {days[6]}</b>
        <button className="btn" onClick={() => setStartOffset((d) => d + 7)}>下一周 →</button>
        <button className="btn" onClick={() => setStartOffset(0)}>本周</button>
        <button className="btn primary" style={{ marginLeft: 'auto' }}
          onClick={() => { setForm({ coach_id: coaches[0]?.id || '', work_date: days[0], start_time: '09:00', end_time: '17:00', shift_type: 'normal' }); setModal(true); }}>
          + 新增排班
        </button>
      </div>

      <div className="panel">
        <div className="schedule-scroll">
          {days.map((d) => {
            const shifts = list.filter((s) => s.work_date && s.work_date.slice(0, 10) === d);
            const isToday = d === todayStr();
            return (
              <div key={d} className="day-col">
                <div className="day-head" style={isToday ? { color: 'var(--accent)' } : {}}>
                  {d.slice(5)} {weekdayCN(d)}{isToday && ' · 今天'}
                </div>
                {shifts.length === 0 && <div className="muted" style={{ fontSize: 12, padding: '6px 4px' }}>无排班</div>}
                {shifts.map((s) => (
                  <div key={s.id} className="shift-chip">
                    <div className="row1">
                      <span>{s.coach_name}</span>
                      <span className={`badge ${SHIFT_CLS[s.shift_type]}`}>{SHIFT_TEXT[s.shift_type]}</span>
                    </div>
                    <div className="row2">
                      <span className="mono">{s.start_time} - {s.end_time}</span>
                      <button className="btn sm danger" style={{ padding: '1px 7px' }} onClick={() => remove(s)}>删</button>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {modal && (
        <Modal title="新增排班" onClose={() => setModal(false)}>
          <div className="form-grid">
            <label className="field">教练
              <select value={form.coach_id} onChange={(e) => setForm({ ...form, coach_id: e.target.value })}>
                {coaches.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.specialty}）</option>)}
              </select>
            </label>
            <label className="field">日期
              <input type="date" value={form.work_date} onChange={(e) => setForm({ ...form, work_date: e.target.value })} /></label>
            <label className="field">上班时间
              <select value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value, end_time: END_AFTER[e.target.value] })}>
                {TIMES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label className="field">下班时间
              <input value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} /></label>
            <label className="field">班次类型
              <select value={form.shift_type} onChange={(e) => setForm({ ...form, shift_type: e.target.value })}>
                <option value="morning">早班</option>
                <option value="normal">正常班</option>
                <option value="evening">晚班</option>
              </select>
            </label>
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setModal(false)}>取消</button>
            <button className="btn primary" onClick={save}>保存排班</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
