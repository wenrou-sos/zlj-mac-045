import { useEffect, useMemo, useState } from 'react';
import { api, todayStr, addDaysStr } from '../api.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

const WEEKDAYS = [
  { v: 1, t: '周一' }, { v: 2, t: '周二' }, { v: 3, t: '周三' }, { v: 4, t: '周四' },
  { v: 5, t: '周五' }, { v: 6, t: '周六' }, { v: 0, t: '周日' },
];
const TIME_OPTIONS = ['07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00'];
const DURATION_OPTIONS = [
  { v: 30, t: '30 分钟' }, { v: 45, t: '45 分钟' }, { v: 60, t: '1 小时' },
  { v: 75, t: '1 小时 15 分' }, { v: 90, t: '1.5 小时' }, { v: 120, t: '2 小时' },
];
const SKIP_BADGE = {
  past: 'muted', venue_closed: 'danger', venue_day_closed: 'danger',
  venue_unavailable: 'warn', venue_conflict: 'warn', coach_conflict: 'warn',
  coach_inactive: 'muted', capacity_exceeded: 'danger',
};

function mondayOf(base) {
  const d = new Date(base + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - dow);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fmtDay(d) { return d ? String(d).slice(0, 10) : ''; }

export default function ClassTemplates() {
  const [templates, setTemplates] = useState([]);
  const [coaches, setCoaches] = useState([]);
  const [venues, setVenues] = useState([]);
  const [batches, setBatches] = useState([]);
  const [tab, setTab] = useState('templates');
  const [edit, setEdit] = useState(null);
  const [genModal, setGenModal] = useState(false);
  const [report, setReport] = useState(null);
  const [batchDetail, setBatchDetail] = useState(null);
  const [gen, setGen] = useState({ week: mondayOf(todayStr()), weeks: 2 });

  const loadTemplates = () => api.get('/class-templates').then(setTemplates);
  const loadBatches = () => api.get('/class-templates/batches').then(setBatches);

  useEffect(() => {
    loadTemplates();
    api.get('/coaches').then(setCoaches);
    api.get('/venues').then(setVenues);
    loadBatches();
  }, []);

  const venueMap = useMemo(() => Object.fromEntries(venues.map((v) => [v.id, v])), [venues]);
  const coachMap = useMemo(() => Object.fromEntries(coaches.map((c) => [c.id, c])), [coaches]);

  function openCreate() {
    setEdit({
      mode: 'create', title: '', weekday: 1, start_time: '19:00', duration_minutes: 60,
      coach_id: '', venue_id: '', capacity: 10, cost_sessions: 1, status: 'active',
    });
  }
  function openEdit(t) {
    setEdit({
      mode: 'edit', id: t.id, title: t.title, weekday: t.weekday, start_time: t.start_time,
      duration_minutes: t.duration_minutes, coach_id: t.coach_id || '', venue_id: t.venue_id || '',
      capacity: t.capacity, cost_sessions: t.cost_sessions, status: t.status,
    });
  }

  async function saveTemplate() {
    try {
      const body = {
        ...edit,
        coach_id: edit.coach_id ? Number(edit.coach_id) : null,
        venue_id: edit.venue_id ? Number(edit.venue_id) : null,
        capacity: Number(edit.capacity),
        cost_sessions: Number(edit.cost_sessions),
      };
      if (edit.mode === 'create') await api.post('/class-templates', body);
      else await api.put(`/class-templates/${edit.id}`, body);
      notify('模板已保存', 'success');
      setEdit(null);
      loadTemplates();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function removeTemplate(t) {
    if (!confirm(`删除模板「${t.title}」？若已有由它生成的课程，将改为停用而不是删除。`)) return;
    try {
      await api.del(`/class-templates/${t.id}`);
      notify('模板已删除', 'success');
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      loadTemplates();
    }
  }

  async function toggleActive(t) {
    try {
      await api.put(`/class-templates/${t.id}`, {
        title: t.title, weekday: t.weekday, start_time: t.start_time,
        duration_minutes: t.duration_minutes, coach_id: t.coach_id, venue_id: t.venue_id,
        capacity: t.capacity, cost_sessions: t.cost_sessions,
        status: t.status === 'active' ? 'inactive' : 'active',
      });
      loadTemplates();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function runGenerate() {
    try {
      const r = await api.post('/class-templates/generate', {
        week_start: gen.week, weeks: Number(gen.weeks),
      });
      setReport(r);
      setGenModal(false);
      loadTemplates();
      loadBatches();
      if (r.created.length === 0 && r.existing.length > 0) {
        notify(`没有新课：${r.existing.length} 节已存在，跳过 ${r.skipped.length} 节`, 'info');
      } else {
        notify(`生成完成：新增 ${r.created.length}，已存在 ${r.existing.length}，跳过 ${r.skipped.length}`, 'success');
      }
    } catch (e) { notify(e.message, 'error'); }
  }

  async function revokeBatch(b) {
    if (!confirm(`确定整批撤回「${fmtDay(b.week_start)} ~ ${fmtDay(b.week_end)}」生成的 ${b.active_classes} 节课？\n已预约学员将被取消并按消耗课次退次。`)) return;
    try {
      const r = await api.post(`/class-templates/batches/${b.id}/revoke`, { reason: '整批撤回' });
      notify(`已撤回 ${r.canceled_count} 节课，取消 ${r.affected_bookings} 个预约，退还 ${r.refunded_sessions} 课次`, 'success');
      loadBatches();
      loadTemplates();
      setBatchDetail(null);
    } catch (e) { notify(e.message, 'error'); }
  }

  async function openBatch(b) {
    setBatchDetail(await api.get(`/class-templates/batches/${b.id}`));
  }

  const grouped = useMemo(() => {
    const g = Object.fromEntries(WEEKDAYS.map((w) => [w.v, []]));
    for (const t of templates) (g[t.weekday] || (g[t.weekday] = [])).push(t);
    Object.values(g).forEach((arr) => arr.sort((a, b) => a.start_time.localeCompare(b.start_time)));
    return g;
  }, [templates]);

  const weekEnd = gen.week ? addDaysStr(gen.week, 6) : '';

  return (
    <div>
      <div className="page-title">周课模板</div>
      <div className="page-sub">维护每周固定团课，选连续几周一键生成；冲突 / 闭馆 / 不可用时段自动跳过并说明原因，重复生成只补缺</div>

      <div className="toolbar">
        <div style={{ display: 'flex', gap: 4 }}>
          <button className={`btn ${tab === 'templates' ? 'primary' : ''}`} onClick={() => setTab('templates')}>模板列表</button>
          <button className={`btn ${tab === 'batches' ? 'primary' : ''}`} onClick={() => { setTab('batches'); loadBatches(); }}>生成批次 / 撤回</button>
        </div>
        {tab === 'templates' && (
          <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={openCreate}>+ 新增模板</button>
        )}
      </div>

      {tab === 'templates' && (
        <>
          <div className="panel" style={{ marginBottom: 16 }}>
            <h3>📆 按模板批量生成整段课表
              <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => { setGen({ week: mondayOf(todayStr()), weeks: 2 }); setReport(null); setGenModal(true); }}>
                批量生成课表
              </button>
            </h3>
            <div className="muted" style={{ fontSize: 12.5 }}>
              生成时会逐节校验：教练时段冲突、场地时段冲突、场地当天整体关闭、场地登记的不可用时段；命中的时段跳过并给出原因，其余正常排课。同一模板同一周重复生成不会排出两套课。
            </div>
          </div>

          <div className="schedule-scroll" style={{ flexWrap: 'wrap' }}>
            {WEEKDAYS.map(({ v, t }) => (
              <div key={v} className="day-col" style={{ flex: '1 1 220px' }}>
                <div className="day-head">{t}</div>
                {(grouped[v] || []).map((tpl) => {
                  const coach = coachMap[tpl.coach_id];
                  const venue = venueMap[tpl.venue_id];
                  return (
                    <div key={tpl.id} className="shift-chip" style={tpl.status === 'inactive' ? { opacity: 0.5 } : {}}>
                      <div className="row1">
                        <span>{tpl.start_time} · {tpl.title}</span>
                        <span className={`badge ${tpl.status === 'active' ? 'ok' : 'muted'}`}>
                          {tpl.status === 'active' ? '启用' : '停用'}
                        </span>
                      </div>
                      <div className="row2" style={{ display: 'block' }}>
                        <div>🏋️ {coach?.name || '待定'}　🏟️ {venue?.name || '待定'}</div>
                        <div>{tpl.duration_minutes} 分钟 · {tpl.capacity} 人 · {tpl.cost_sessions} 课次</div>
                        <div style={{ marginTop: 4, display: 'flex', gap: 6 }}>
                          <button className="btn sm" onClick={() => openEdit(tpl)}>编辑</button>
                          <button className="btn sm" onClick={() => toggleActive(tpl)}>{tpl.status === 'active' ? '停用' : '启用'}</button>
                          <button className="btn sm danger" onClick={() => removeTemplate(tpl)}>删</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {(grouped[v] || []).length === 0 && <div className="muted" style={{ fontSize: 12, padding: '6px 4px' }}>无模板</div>}
              </div>
            ))}
          </div>
        </>
      )}

      {tab === 'batches' && (
        <div className="panel">
          <div className="table-wrap">
            <table>
              <thead><tr><th>批次</th><th>周期</th><th>周数</th><th>新增</th><th>已存在</th><th>跳过</th><th>有效课</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>#{b.id}</td>
                    <td className="nowrap">{fmtDay(b.week_start)} ~ {fmtDay(b.week_end)}</td>
                    <td>{b.weeks}</td>
                    <td>{b.created_count}</td>
                    <td>{b.existing_count}</td>
                    <td>{b.skipped_count > 0 ? <span className="badge warn">{b.skipped_count}</span> : 0}</td>
                    <td>{b.active_classes}</td>
                    <td><span className={`badge ${b.status === 'completed' ? 'info' : 'muted'}`}>
                      {b.status === 'completed' ? '已生成' : '已撤回'}</span></td>
                    <td className="nowrap">
                      <button className="btn sm" onClick={() => openBatch(b)}>明细</button>
                      {b.status === 'completed' && b.active_classes > 0 &&
                        <button className="btn sm danger" style={{ marginLeft: 6 }} onClick={() => revokeBatch(b)}>整批撤回</button>}
                    </td>
                  </tr>
                ))}
                {batches.length === 0 && <tr><td colSpan={9} className="empty">还没有生成批次</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 新增 / 编辑模板 */}
      {edit && (
        <Modal title={edit.mode === 'create' ? '新增周课模板' : '编辑周课模板'} onClose={() => setEdit(null)}>
          <div className="form-grid">
            <label className="field">课程名称
              <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="如：动感单车" />
            </label>
            <label className="field">星期
              <select value={edit.weekday} onChange={(e) => setEdit({ ...edit, weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((w) => <option key={w.v} value={w.v}>{w.t}</option>)}
              </select>
            </label>
            <label className="field">开课时间
              <select value={edit.start_time} onChange={(e) => setEdit({ ...edit, start_time: e.target.value })}>
                {TIME_OPTIONS.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label className="field">时长
              <select value={edit.duration_minutes} onChange={(e) => setEdit({ ...edit, duration_minutes: Number(e.target.value) })}>
                {DURATION_OPTIONS.map((d) => <option key={d.v} value={d.v}>{d.t}</option>)}
              </select>
            </label>
            <label className="field">教练
              <select value={edit.coach_id} onChange={(e) => setEdit({ ...edit, coach_id: e.target.value })}>
                <option value="">待定</option>
                {coaches.filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.name}（{c.specialty}）</option>)}
              </select>
            </label>
            <label className="field">场地
              <select value={edit.venue_id} onChange={(e) => {
                const v = venues.find((x) => x.id === Number(e.target.value));
                setEdit({ ...edit, venue_id: e.target.value, capacity: v ? Math.min(edit.capacity || v.capacity, v.capacity) : edit.capacity });
              }}>
                <option value="">待定</option>
                {venues.map((v) => <option key={v.id} value={v.id} disabled={v.status === 'closed'}>
                  {v.name}（{v.status === 'closed' ? '已关闭 · ' : `上限 ${v.capacity} 人`}）
                </option>)}
              </select>
            </label>
            <label className="field">容量（人）
              <input type="number" min="1" value={edit.capacity} onChange={(e) => setEdit({ ...edit, capacity: e.target.value })} />
            </label>
            <label className="field">消耗课次
              <select value={edit.cost_sessions} onChange={(e) => setEdit({ ...edit, cost_sessions: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} 次 / 人</option>)}
              </select>
            </label>
            <label className="field">状态
              <select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
                <option value="active">启用</option>
                <option value="inactive">停用</option>
              </select>
            </label>
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setEdit(null)}>取消</button>
            <button className="btn primary" onClick={saveTemplate}>保存模板</button>
          </div>
        </Modal>
      )}

      {/* 批量生成参数 */}
      {genModal && (
        <Modal title="按周课模板批量生成" onClose={() => setGenModal(false)}>
          <div className="form-grid">
            <label className="field">起始周（任选该周一天，自动归一到周一）
              <input type="date" value={gen.week} onChange={(e) => setGen({ ...gen, week: e.target.value })} />
            </label>
            <label className="field">连续生成周数
              <select value={gen.weeks} onChange={(e) => setGen({ ...gen, weeks: Number(e.target.value) })}>
                {[1, 2, 3, 4, 6, 8, 12].map((n) => <option key={n} value={n}>{n} 周</option>)}
              </select>
            </label>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
            将生成区间：<b>{gen.week}（周一）~ {weekEnd}（周日）</b> 内全部启用中的模板课；同一时刻已有课则跳过新增并计入“已存在”。
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setGenModal(false)}>取消</button>
            <button className="btn primary" onClick={runGenerate}>开始生成</button>
          </div>
        </Modal>
      )}

      {/* 生成结果报告 */}
      {report && (
        <Modal title={`批次 #${report.batch_id} 生成结果（${report.week_start} ~ ${report.week_end}）`} onClose={() => setReport(null)} wide>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            <span className="badge ok">新增 {report.created.length}</span>
            <span className="badge info">已存在 {report.existing.length}</span>
            <span className="badge warn">跳过 {report.skipped.length}</span>
          </div>

          {report.skipped.length > 0 && (
            <>
              <h3 style={{ fontSize: 14, margin: '10px 0' }}>⚠️ 跳过的时段及原因</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>日期</th><th>课程</th><th>原因</th></tr></thead>
                  <tbody>
                    {report.skipped.map((s, i) => (
                      <tr key={i}>
                        <td className="nowrap">{s.date} {s.weekday} {s.time}</td>
                        <td>{s.template_title}</td>
                        <td><span className={`badge ${SKIP_BADGE[s.code] || 'muted'}`} style={{ whiteSpace: 'normal' }}>{s.reason}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {report.existing.length > 0 && (
            <>
              <h3 style={{ fontSize: 14, margin: '14px 0 10px' }}>ℹ️ 已存在（未重复排课，只补缺）</h3>
              <div className="muted" style={{ fontSize: 12.5 }}>{report.existing.length} 节课在该时段已存在，本次未重复生成。</div>
            </>
          )}
          <div className="form-actions">
            <button className="btn primary" onClick={() => setReport(null)}>知道了</button>
          </div>
        </Modal>
      )}

      {/* 批次明细 */}
      {batchDetail && (
        <Modal title={`批次 #${batchDetail.id} 明细 · ${fmtDay(batchDetail.week_start)} ~ ${fmtDay(batchDetail.week_end)}`} onClose={() => setBatchDetail(null)} wide>
          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <span className={`badge ${batchDetail.status === 'completed' ? 'info' : 'muted'}`}>
              {batchDetail.status === 'completed' ? '已生成' : '已撤回'}
            </span>
            <span className="badge ok">新增 {batchDetail.created_count}</span>
            <span className="badge info">已存在 {batchDetail.existing_count}</span>
            <span className="badge warn">跳过 {batchDetail.skipped_count}</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>时间</th><th>课程</th><th>教练</th><th>场地</th><th>预约</th><th>状态</th></tr></thead>
              <tbody>
                {batchDetail.classes.map((c) => (
                  <tr key={c.id}>
                    <td className="nowrap">{new Date(c.start_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{c.title}</td>
                    <td>{c.coach_name || '待定'}</td>
                    <td>{c.venue_name || '待定'}</td>
                    <td>{c.booked_count}/{c.capacity}</td>
                    <td><span className={`badge ${c.status === 'open' ? 'ok' : 'muted'}`}>
                      {c.status === 'open' ? '未开始' : c.status === 'canceled' ? '已取消' : c.status === 'finished' ? '已结束' : c.status}
                    </span></td>
                  </tr>
                ))}
                {batchDetail.classes.length === 0 && <tr><td colSpan={6} className="empty">批次下没有课程</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            {batchDetail.status === 'completed' && batchDetail.classes.some((c) => c.status === 'open') &&
              <button className="btn danger" style={{ marginRight: 'auto' }} onClick={() => revokeBatch(batchDetail)}>整批撤回（取消课程并退次）</button>}
            <button className="btn" onClick={() => setBatchDetail(null)}>关闭</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
