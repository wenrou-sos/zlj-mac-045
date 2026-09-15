import { useEffect, useMemo, useState } from 'react';
import { api, fmtDate, fmtDateTime, fmtTime, weekdayCN, WEEKDAYS_CN, EQUIP_STATUS, isoAt, isoAddHours, addDaysStr, localDateOf } from '../api.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

const DAY_MS = 86400e3;

// 把课程/不可用段裁剪到某一天，换算成时间条上的百分比位置
function daySegments(items, day, kind, label) {
  const dayStart = new Date(day + 'T00:00:00').getTime();
  const dayEnd = dayStart + DAY_MS;
  const segs = [];
  for (const it of items) {
    const s = Math.max(new Date(it.start_at).getTime(), dayStart);
    const e = Math.min(new Date(it.end_at).getTime(), dayEnd);
    if (e <= s) continue;
    segs.push({
      kind,
      left: ((s - dayStart) / DAY_MS) * 100,
      width: ((e - s) / DAY_MS) * 100,
      title: label(it),
    });
  }
  return segs;
}

export default function Venues() {
  const [venues, setVenues] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [week, setWeek] = useState(null);
  const [blocks, setBlocks] = useState([]);
  const [venueModal, setVenueModal] = useState(null);
  const [equipModal, setEquipModal] = useState(null);
  const [venueForm, setVenueForm] = useState({ name: '', capacity: 10, location: '' });
  const [equipForm, setEquipForm] = useState({ name: '', asset_no: '', quantity: 1, status: 'normal', venue_id: '', purchased_at: '', note: '' });
  const [filter, setFilter] = useState('');

  // 登记不可用时段
  const [blockModal, setBlockModal] = useState(false);
  const [blockForm, setBlockForm] = useState({
    venue_id: '', kind: 'once', weekday: 1, start_time: '09:00', end_time: '12:00',
    start_at: '', end_at: '', reason: '',
  });
  const [conflicts, setConflicts] = useState(null); // null=未检查；[]=无冲突
  const [resMap, setResMap] = useState({}); // { classId: { action:'cancel'|'move', date, hour } }

  const load = async () => {
    const [vs, eq, wk, bl] = await Promise.all([
      api.get('/venues'),
      api.get('/venues/equipment/all'),
      api.get('/venues/week'),
      api.get('/venues/blocks'),
    ]);
    setVenues(vs);
    setEquipment(eq);
    setWeek(wk);
    setBlocks(bl);
  };
  useEffect(() => { load(); }, []);

  async function saveVenue() {
    try {
      if (venueModal.mode === 'create') await api.post('/venues', venueForm);
      else await api.put(`/venues/${venueModal.v.id}`, { ...venueForm, status: venueModal.v.status });
      notify('场地已保存', 'success');
      setVenueModal(null);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function toggleVenue(v) {
    await api.put(`/venues/${v.id}`, { ...v, status: v.status === 'open' ? 'closed' : 'open' });
    notify(v.status === 'open' ? '场地已关闭（整场地停用）' : '场地已开放', 'success');
    load();
  }

  async function saveEquip() {
    try {
      const body = { ...equipForm, venue_id: equipForm.venue_id ? Number(equipForm.venue_id) : null };
      if (equipModal.mode === 'create') await api.post('/venues/equipment', body);
      else await api.put(`/venues/equipment/${equipModal.e.id}`, body);
      notify('器械已保存', 'success');
      setEquipModal(null);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function changeEquipStatus(e, status) {
    await api.put(`/venues/equipment/${e.id}`, {
      venue_id: e.venue_id, name: e.name, quantity: e.quantity, status, note: e.note,
    });
    notify(`已标记为「${EQUIP_STATUS[status].text}」`, 'success');
    load();
  }

  // ---------- 不可用时段 ----------
  function blockPayload() {
    const base = { venue_id: Number(blockForm.venue_id), kind: blockForm.kind, reason: blockForm.reason };
    if (blockForm.kind === 'weekly') {
      return { ...base, weekday: Number(blockForm.weekday), start_time: blockForm.start_time, end_time: blockForm.end_time };
    }
    return {
      ...base,
      start_at: blockForm.start_at ? new Date(blockForm.start_at).toISOString() : '',
      end_at: blockForm.end_at ? new Date(blockForm.end_at).toISOString() : '',
    };
  }

  function openBlockModal() {
    setBlockForm({
      venue_id: venues[0]?.id || '', kind: 'once', weekday: 1,
      start_time: '09:00', end_time: '12:00', start_at: '', end_at: '', reason: '',
    });
    setConflicts(null);
    setResMap({});
    setBlockModal(true);
  }

  async function previewBlock() {
    try {
      const r = await api.post('/venues/blocks/preview', blockPayload());
      setConflicts(r.conflicts);
      // 默认全部「取消并退次」；改期默认原日期 +1 天同时刻
      const m = {};
      for (const c of r.conflicts) {
        m[c.id] = { action: 'cancel', date: addDaysStr(localDateOf(c.start_at), 1), hour: new Date(c.start_at).getHours() };
      }
      setResMap(m);
    } catch (e) { notify(e.message, 'error'); }
  }

  async function submitBlock() {
    try {
      const payload = blockPayload();
      if (conflicts && conflicts.length > 0) {
        payload.resolutions = conflicts.map((c) => {
          const r = resMap[c.id] || { action: 'cancel' };
          if (r.action === 'cancel') return { class_id: c.id, action: 'cancel' };
          const durH = (new Date(c.end_at) - new Date(c.start_at)) / 3600e3;
          return { class_id: c.id, action: 'move', start_at: isoAt(r.date, r.hour), end_at: isoAddHours(r.date, r.hour, durH) };
        });
      }
      const r = await api.post('/venues/blocks', payload);
      const parts = [];
      if (r.canceled) parts.push(`取消 ${r.canceled} 节课（退次 ${r.refunded} 条预约）`);
      if (r.moved) parts.push(`改期 ${r.moved} 节课`);
      notify(`不可用时段已登记${parts.length ? '，' + parts.join('，') : ''}`, 'success');
      setBlockModal(false);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function removeBlock(b) {
    const desc = b.kind === 'weekly'
      ? `每${WEEKDAYS_CN[b.weekday]} ${String(b.start_time).slice(0, 5)}-${String(b.end_time).slice(0, 5)}`
      : `${fmtDateTime(b.start_at)} ~ ${fmtDateTime(b.end_at)}`;
    if (!confirm(`确定删除「${b.venue_name}」的不可用时段（${desc}）吗？\n删除后该时段恢复可排课。`)) return;
    try {
      await api.del(`/venues/blocks/${b.id}`);
      notify('时段已删除', 'success');
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  const shown = equipment.filter((e) => !filter || e.status === filter);
  const blockReady = useMemo(() => {
    if (!blockForm.venue_id || !blockForm.reason.trim()) return false;
    if (blockForm.kind === 'weekly') return blockForm.start_time < blockForm.end_time;
    return blockForm.start_at && blockForm.end_at && new Date(blockForm.end_at) > new Date(blockForm.start_at);
  }, [blockForm]);

  return (
    <div>
      <div className="page-title">场地与器械</div>
      <div className="page-sub">整场地停用、一次性闭馆区间、每周固定闭馆三层叠加，任一命中即不可排课/预约</div>

      <div className="panel">
        <h3>📅 未来 7 天场地视图
          <span className="legend" style={{ marginLeft: 'auto' }}>
            <span><i style={{ background: 'rgba(53,208,127,.35)' }}></i>可用</span>
            <span><i style={{ background: 'var(--accent)' }}></i>被课占用</span>
            <span><i style={{ background: 'repeating-linear-gradient(45deg, rgba(242,85,85,.75) 0 3px, rgba(242,85,85,.30) 3px 6px)' }}></i>不可用</span>
            <span><i style={{ background: '#39424f' }}></i>整场地停用</span>
          </span>
        </h3>
        <div className="table-wrap">
          <table className="week-table">
            <thead>
              <tr>
                <th>场地</th>
                {week?.days.map((d, i) => (
                  <th key={d}>{i === 0 ? '今天' : weekdayCN(d)}<br /><span className="muted" style={{ fontWeight: 400 }}>{d.slice(5)}</span></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {week?.venues.map((v) => (
                <tr key={v.id}>
                  <td className="venue-cell">
                    {v.name}
                    <div className="muted">{v.status === 'open' ? `${v.capacity} 人` : '已停用'}</div>
                  </td>
                  {week.days.map((day) => {
                    const segs = [
                      ...daySegments(v.blocks, day, 'block', (b) => `不可用：${b.reason}（${fmtTime(b.start_at)}-${fmtTime(b.end_at)}）`),
                      ...daySegments(v.classes, day, 'class', (c) => `${fmtTime(c.start_at)}-${fmtTime(c.end_at)} ${c.title}（${c.booked_count}/${c.capacity}）`),
                    ];
                    return (
                      <td key={day}>
                        <div className="vday-bar">
                          {v.status === 'closed' && <div className="seg closed" title="场地已停用"></div>}
                          {v.status !== 'closed' && segs.map((s, i) => (
                            <div key={i} className={`seg ${s.kind}`} style={{ left: `${s.left}%`, width: `${s.width}%` }} title={s.title}></div>
                          ))}
                        </div>
                        <div className="vday-hours"><span>0</span><span>12</span><span>24</span></div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>🚫 不可用时段（即将生效 / 生效中）
          <button className="btn sm primary" style={{ marginLeft: 'auto' }} onClick={openBlockModal}>+ 登记不可用时段</button>
        </h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>场地</th><th>类型</th><th>时间</th><th>原因</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.id}>
                  <td style={{ fontWeight: 600 }}>{b.venue_name}</td>
                  <td><span className={`badge ${b.kind === 'weekly' ? 'info' : 'warn'}`}>{b.kind === 'weekly' ? '每周固定' : '一次性'}</span></td>
                  <td className="nowrap">
                    {b.kind === 'weekly'
                      ? `每${WEEKDAYS_CN[b.weekday]} ${String(b.start_time).slice(0, 5)} - ${String(b.end_time).slice(0, 5)}`
                      : `${fmtDateTime(b.start_at)} ~ ${fmtDateTime(b.end_at)}`}
                  </td>
                  <td className="muted">{b.reason}</td>
                  <td>
                    {b.kind === 'weekly'
                      ? <span className="badge info">长期生效</span>
                      : new Date(b.start_at) > new Date()
                        ? <span className="badge warn">未开始</span>
                        : <span className="badge danger">生效中</span>}
                  </td>
                  <td><button className="btn sm danger" onClick={() => removeBlock(b)}>删除</button></td>
                </tr>
              ))}
              {blocks.length === 0 && <tr><td colSpan={6} className="empty">暂无不可用时段</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>🏟️ 场地
          <button className="btn sm primary" style={{ marginLeft: 'auto' }}
            onClick={() => { setVenueForm({ name: '', capacity: 10, location: '' }); setVenueModal({ mode: 'create' }); }}>+ 新增场地</button>
        </h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>场地</th><th>位置</th><th>容量</th><th>器械（正常/总数）</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {venues.map((v) => (
                <tr key={v.id}>
                  <td style={{ fontWeight: 600 }}>{v.name}</td>
                  <td className="muted">{v.location}</td>
                  <td>{v.capacity} 人</td>
                  <td>{v.normal_count} / {v.equipment_count}</td>
                  <td>
                    <span className={`badge ${v.status === 'open' ? 'ok' : 'muted'}`}>
                      <span className={`dot ${v.status === 'open' ? 'ok' : 'off'}`} style={{ marginRight: 5 }}></span>
                      {v.status === 'open' ? '开放中' : '已停用'}
                    </span>
                  </td>
                  <td className="nowrap">
                    <button className="btn sm" onClick={() => { setVenueForm({ name: v.name, capacity: v.capacity, location: v.location || '' }); setVenueModal({ mode: 'edit', v }); }}>编辑</button>
                    <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => toggleVenue(v)}>{v.status === 'open' ? '停用' : '开放'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>🏋️ 器械台账
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">全部状态</option>
              <option value="normal">正常</option>
              <option value="maintenance">维修中</option>
              <option value="scrapped">已报废</option>
            </select>
            <button className="btn sm primary"
              onClick={() => { setEquipForm({ name: '', asset_no: '', quantity: 1, status: 'normal', venue_id: venues[0]?.id || '', purchased_at: '', note: '' }); setEquipModal({ mode: 'create' }); }}>
              + 新增器械
            </button>
          </div>
        </h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>资产编号</th><th>器械</th><th>所属场地</th><th>数量</th><th>购置日期</th><th>状态</th><th>备注</th><th>操作</th></tr></thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id}>
                  <td className="mono">{e.asset_no}</td>
                  <td style={{ fontWeight: 600 }}>{e.name}</td>
                  <td className="muted">{e.venue_name || '未分配'}</td>
                  <td>{e.quantity}</td>
                  <td>{fmtDate(e.purchased_at)}</td>
                  <td><span className={`badge ${EQUIP_STATUS[e.status].cls}`}>{EQUIP_STATUS[e.status].text}</span></td>
                  <td className="muted" style={{ fontSize: 12 }}>{e.note || '—'}</td>
                  <td className="nowrap">
                    {e.status === 'normal' && <button className="btn sm" onClick={() => changeEquipStatus(e, 'maintenance')}>送修</button>}
                    {e.status === 'maintenance' && <button className="btn sm primary" onClick={() => changeEquipStatus(e, 'normal')}>修复</button>}
                    {e.status !== 'scrapped' && <button className="btn sm danger" style={{ marginLeft: 6 }} onClick={() => changeEquipStatus(e, 'scrapped')}>报废</button>}
                    <button className="btn sm" style={{ marginLeft: 6 }}
                      onClick={() => { setEquipForm({ name: e.name, asset_no: e.asset_no || '', quantity: e.quantity, status: e.status, venue_id: e.venue_id || '', purchased_at: e.purchased_at || '', note: e.note || '' }); setEquipModal({ mode: 'edit', e }); }}>
                      编辑
                    </button>
                  </td>
                </tr>
              ))}
              {shown.length === 0 && <tr><td colSpan={8} className="empty">暂无器械</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {venueModal && (
        <Modal title={venueModal.mode === 'create' ? '新增场地' : '编辑场地'} onClose={() => setVenueModal(null)}>
          <div className="form-grid">
            <label className="field">场地名称
              <input value={venueForm.name} onChange={(e) => setVenueForm({ ...venueForm, name: e.target.value })} /></label>
            <label className="field">位置
              <input value={venueForm.location} onChange={(e) => setVenueForm({ ...venueForm, location: e.target.value })} /></label>
            <label className="field">容量（人）
              <input type="number" value={venueForm.capacity} onChange={(e) => setVenueForm({ ...venueForm, capacity: Number(e.target.value) })} /></label>
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setVenueModal(null)}>取消</button>
            <button className="btn primary" onClick={saveVenue}>保存</button>
          </div>
        </Modal>
      )}

      {equipModal && (
        <Modal title={equipModal.mode === 'create' ? '新增器械' : '编辑器械'} onClose={() => setEquipModal(null)}>
          <div className="form-grid">
            <label className="field">器械名称
              <input value={equipForm.name} onChange={(e) => setEquipForm({ ...equipForm, name: e.target.value })} /></label>
            <label className="field">资产编号
              <input value={equipForm.asset_no} onChange={(e) => setEquipForm({ ...equipForm, asset_no: e.target.value })} /></label>
            <label className="field">所属场地
              <select value={equipForm.venue_id} onChange={(e) => setEquipForm({ ...equipForm, venue_id: e.target.value })}>
                <option value="">未分配</option>
                {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
            <label className="field">数量
              <input type="number" value={equipForm.quantity} onChange={(e) => setEquipForm({ ...equipForm, quantity: Number(e.target.value) })} /></label>
            <label className="field">购置日期
              <input type="date" value={equipForm.purchased_at} onChange={(e) => setEquipForm({ ...equipForm, purchased_at: e.target.value })} /></label>
            <label className="field">状态
              <select value={equipForm.status} onChange={(e) => setEquipForm({ ...equipForm, status: e.target.value })}>
                <option value="normal">正常</option>
                <option value="maintenance">维修中</option>
                <option value="scrapped">已报废</option>
              </select>
            </label>
            <label className="field" style={{ gridColumn: '1/-1' }}>备注
              <input value={equipForm.note} onChange={(e) => setEquipForm({ ...equipForm, note: e.target.value })} /></label>
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setEquipModal(null)}>取消</button>
            <button className="btn primary" onClick={saveEquip}>保存</button>
          </div>
        </Modal>
      )}

      {blockModal && (
        <Modal title="登记不可用时段" onClose={() => setBlockModal(null)} wide>
          <div className="form-grid">
            <label className="field">场地
              <select value={blockForm.venue_id} onChange={(e) => { setBlockForm({ ...blockForm, venue_id: e.target.value }); setConflicts(null); }}>
                {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
            <label className="field">类型
              <select value={blockForm.kind} onChange={(e) => { setBlockForm({ ...blockForm, kind: e.target.value }); setConflicts(null); }}>
                <option value="once">一次性日期区间（换水 / 装修 / 节假日）</option>
                <option value="weekly">每周固定闭馆时段</option>
              </select>
            </label>
            {blockForm.kind === 'weekly' ? (
              <>
                <label className="field">每周
                  <select value={blockForm.weekday} onChange={(e) => { setBlockForm({ ...blockForm, weekday: e.target.value }); setConflicts(null); }}>
                    {WEEKDAYS_CN.map((w, i) => <option key={i} value={i}>{w}</option>)}
                  </select>
                </label>
                <label className="field">开始时间
                  <input type="time" value={blockForm.start_time} onChange={(e) => { setBlockForm({ ...blockForm, start_time: e.target.value }); setConflicts(null); }} /></label>
                <label className="field">结束时间
                  <input type="time" value={blockForm.end_time} onChange={(e) => { setBlockForm({ ...blockForm, end_time: e.target.value }); setConflicts(null); }} /></label>
              </>
            ) : (
              <>
                <label className="field">开始时间
                  <input type="datetime-local" value={blockForm.start_at} onChange={(e) => { setBlockForm({ ...blockForm, start_at: e.target.value }); setConflicts(null); }} /></label>
                <label className="field">结束时间
                  <input type="datetime-local" value={blockForm.end_at} onChange={(e) => { setBlockForm({ ...blockForm, end_at: e.target.value }); setConflicts(null); }} /></label>
              </>
            )}
            <label className="field" style={{ gridColumn: '1/-1' }}>原因
              <input placeholder="如：泳池换水 / 场地装修 / 节假日闭馆" value={blockForm.reason}
                onChange={(e) => setBlockForm({ ...blockForm, reason: e.target.value })} /></label>
          </div>

          {conflicts === null && (
            <div className="form-actions">
              <button className="btn" onClick={() => setBlockModal(false)}>取消</button>
              <button className="btn primary" disabled={!blockReady} onClick={previewBlock}>检查时段内已排课程</button>
            </div>
          )}

          {conflicts && conflicts.length === 0 && (
            <>
              <div className="muted" style={{ marginTop: 14 }}>✅ 该时段内没有已排课程，可直接登记。</div>
              <div className="form-actions">
                <button className="btn" onClick={() => setConflicts(null)}>返回修改</button>
                <button className="btn primary" onClick={submitBlock}>确认登记</button>
              </div>
            </>
          )}

          {conflicts && conflicts.length > 0 && (
            <>
              <div style={{ margin: '14px 0 10px', fontWeight: 600, color: 'var(--warn)' }}>
                ⚠️ 该时段内有 {conflicts.length} 节已排课程，请逐节选择处理方式：
              </div>
              {conflicts.map((c) => {
                const r = resMap[c.id] || { action: 'cancel' };
                const durH = (new Date(c.end_at) - new Date(c.start_at)) / 3600e3;
                return (
                  <div className="conflict-item" key={c.id}>
                    <div className="head">
                      <span>{fmtDateTime(c.start_at)} {c.title}</span>
                      <span className="muted" style={{ fontWeight: 400 }}>{c.coach_name || '待定教练'} · 已约 {c.booked_count}/{c.capacity}</span>
                    </div>
                    <div className="ops">
                      <label>
                        <input type="radio" checked={r.action === 'cancel'}
                          onChange={() => setResMap({ ...resMap, [c.id]: { ...r, action: 'cancel' } })} />
                        取消课程{Number(c.booked_count) > 0 ? `（${c.booked_count} 条预约退次）` : ''}
                      </label>
                      <label>
                        <input type="radio" checked={r.action === 'move'}
                          onChange={() => setResMap({ ...resMap, [c.id]: { ...r, action: 'move' } })} />
                        改期到
                      </label>
                      {r.action === 'move' && (
                        <>
                          <input type="date" value={r.date}
                            onChange={(e) => setResMap({ ...resMap, [c.id]: { ...r, date: e.target.value } })} />
                          <select value={r.hour}
                            onChange={(e) => setResMap({ ...resMap, [c.id]: { ...r, hour: Number(e.target.value) } })}>
                            {Array.from({ length: 16 }, (_, i) => i + 7).map((h) => (
                              <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                            ))}
                          </select>
                          <span>（时长 {durH} 小时不变）</span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              <div className="form-actions">
                <button className="btn" onClick={() => setConflicts(null)}>返回修改</button>
                <button className="btn primary" onClick={submitBlock}>登记时段并处理课程</button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
