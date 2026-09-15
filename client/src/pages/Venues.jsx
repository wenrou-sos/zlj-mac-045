import { useEffect, useState } from 'react';
import { api, fmtDate, todayStr, EQUIP_STATUS } from '../api.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

export default function Venues() {
  const [venues, setVenues] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [unavailable, setUnavailable] = useState([]);
  const [venueModal, setVenueModal] = useState(null);
  const [equipModal, setEquipModal] = useState(null);
  const [unavailModal, setUnavailModal] = useState(null);
  const [venueForm, setVenueForm] = useState({ name: '', capacity: 10, location: '' });
  const [equipForm, setEquipForm] = useState({ name: '', asset_no: '', quantity: 1, status: 'normal', venue_id: '', purchased_at: '', note: '' });
  const [unavailForm, setUnavailForm] = useState({ venue_id: '', start_date: todayStr(), end_date: todayStr(), all_day: true, start_time: '08:00', end_time: '12:00', reason: '' });
  const [filter, setFilter] = useState('');

  const load = async () => {
    setVenues(await api.get('/venues'));
    setEquipment(await api.get('/venues/equipment/all'));
    setUnavailable(await api.get('/venues/unavailable/all'));
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
    notify(v.status === 'open' ? '场地已关闭' : '场地已开放', 'success');
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

  async function saveUnavail() {
    try {
      const f = unavailForm;
      const body = {
        venue_id: Number(f.venue_id),
        start_date: f.start_date, end_date: f.end_date,
        start_time: f.all_day ? '00:00' : f.start_time,
        end_time: f.all_day ? '23:59' : f.end_time,
        reason: f.reason || (f.all_day ? '场地全天关闭' : '场地时段不可用'),
      };
      if (unavailModal.mode === 'create') await api.post('/venues/unavailable', body);
      else await api.put(`/venues/unavailable/${unavailModal.u.id}`, body);
      notify('不可用时段已保存，排课将自动跳过', 'success');
      setUnavailModal(null);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function removeUnavail(u) {
    if (!confirm(`删除「${u.venue_name} ${u.start_date}」的不可用记录？`)) return;
    await api.del(`/venues/unavailable/${u.id}`);
    notify('已删除', 'success');
    load();
  }

  const shown = equipment.filter((e) => !filter || e.status === filter);

  return (
    <div>
      <div className="page-title">场地与器械</div>
      <div className="page-sub">场地开放状态决定能否排课；器械维修中 / 报废会在工作台提示</div>

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
                      {v.status === 'open' ? '开放中' : '已关闭'}
                    </span>
                  </td>
                  <td className="nowrap">
                    <button className="btn sm" onClick={() => { setVenueForm({ name: v.name, capacity: v.capacity, location: v.location || '' }); setVenueModal({ mode: 'edit', v }); }}>编辑</button>
                    <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => toggleVenue(v)}>{v.status === 'open' ? '关闭' : '开放'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>🚫 不可用时段（全天闭馆 / 部分时段维护）
          <button className="btn sm primary" style={{ marginLeft: 'auto' }}
            onClick={() => { setUnavailForm({ venue_id: venues[0]?.id || '', start_date: todayStr(), end_date: todayStr(), all_day: true, start_time: '08:00', end_time: '12:00', reason: '' }); setUnavailModal({ mode: 'create' }); }}>
            + 登记不可用
          </button>
        </h3>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
          落在该时段的课（含按周课模板批量生成）会被自动跳过并说明原因；可登记跨多天的全天闭馆。
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>场地</th><th>开始</th><th>结束</th><th>时段</th><th>类型</th><th>原因</th><th></th></tr></thead>
            <tbody>
              {unavailable.map((u) => {
                const allDay = u.start_time === '00:00' && (u.end_time === '23:59' || u.end_time === '24:00');
                const multiDay = u.start_date !== u.end_date;
                return (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>{u.venue_name}</td>
                    <td className="nowrap">{u.start_date}</td>
                    <td className="nowrap">{u.end_date}</td>
                    <td className="mono">{allDay ? '全天' : `${u.start_time} - ${u.end_time}`}</td>
                    <td><span className={`badge ${allDay && !multiDay ? 'danger' : 'warn'}`}>
                      {allDay ? (multiDay ? '连续闭馆' : '当天闭馆') : '部分时段'}
                    </span></td>
                    <td className="muted" style={{ fontSize: 12 }}>{u.reason || '—'}</td>
                    <td className="nowrap">
                      <button className="btn sm" onClick={() => {
                        setUnavailForm({ venue_id: u.venue_id, start_date: u.start_date, end_date: u.end_date, all_day: allDay, start_time: u.start_time === '00:00' ? '08:00' : u.start_time, end_time: u.end_time === '23:59' ? '12:00' : u.end_time, reason: u.reason || '' });
                        setUnavailModal({ mode: 'edit', u });
                      }}>编辑</button>
                      <button className="btn sm danger" style={{ marginLeft: 6 }} onClick={() => removeUnavail(u)}>删除</button>
                    </td>
                  </tr>
                );
              })}
              {unavailable.length === 0 && <tr><td colSpan={7} className="empty">暂无不可用时段</td></tr>}
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

      {unavailModal && (
        <Modal title={unavailModal.mode === 'create' ? '登记场地不可用' : '编辑不可用时段'} onClose={() => setUnavailModal(null)}>
          <div className="form-grid">
            <label className="field">场地
              <select value={unavailForm.venue_id} onChange={(e) => setUnavailForm({ ...unavailForm, venue_id: e.target.value })}>
                {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
            <label className="field">类型
              <select value={unavailForm.all_day ? 'all' : 'part'} onChange={(e) => setUnavailForm({ ...unavailForm, all_day: e.target.value === 'all' })}>
                <option value="all">全天关闭</option>
                <option value="part">部分时段不可用</option>
              </select>
            </label>
            <label className="field">开始日期
              <input type="date" value={unavailForm.start_date} onChange={(e) => setUnavailForm({ ...unavailForm, start_date: e.target.value, end_date: unavailForm.end_date < e.target.value ? e.target.value : unavailForm.end_date })} /></label>
            <label className="field">结束日期
              <input type="date" min={unavailForm.start_date} value={unavailForm.end_date} onChange={(e) => setUnavailForm({ ...unavailForm, end_date: e.target.value })} /></label>
            {!unavailForm.all_day && (
              <>
                <label className="field">开始时间
                  <input type="time" value={unavailForm.start_time} onChange={(e) => setUnavailForm({ ...unavailForm, start_time: e.target.value })} /></label>
                <label className="field">结束时间
                  <input type="time" value={unavailForm.end_time} onChange={(e) => setUnavailForm({ ...unavailForm, end_time: e.target.value })} /></label>
              </>
            )}
            <label className="field" style={{ gridColumn: '1/-1' }}>原因（如：消防检修 / 地面保养）
              <input value={unavailForm.reason} onChange={(e) => setUnavailForm({ ...unavailForm, reason: e.target.value })} /></label>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
            开始、结束日期可不同，跨多天时中间各天按全天关闭处理。
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setUnavailModal(null)}>取消</button>
            <button className="btn primary" onClick={saveUnavail}>保存</button>
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
    </div>
  );
}
