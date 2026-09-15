import { useEffect, useMemo, useState } from 'react';
import { api, fmtDate, fmtDateTime, fmtDuration, EQUIP_STATUS, ORDER_STATUS, todayStr, addDaysStr } from '../api.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

export default function Venues() {
  const [venues, setVenues] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [orders, setOrders] = useState([]);
  const [venueModal, setVenueModal] = useState(null);
  const [equipModal, setEquipModal] = useState(null);
  // orderModal: { mode: 'create'|'dispatch'|'complete'|'scrap', order?, equipment? }
  const [orderModal, setOrderModal] = useState(null);
  const [venueForm, setVenueForm] = useState({ name: '', capacity: 10, location: '' });
  const [equipForm, setEquipForm] = useState(emptyEquipForm());
  const [orderForm, setOrderForm] = useState({});
  const [equipFilter, setEquipFilter] = useState('');
  const [orderFilter, setOrderFilter] = useState('open');

  function emptyEquipForm() {
    return { name: '', asset_no: '', quantity: 1, venue_id: '', purchased_at: '', note: '',
      maintain_interval_days: '', last_maintained_at: '' };
  }

  const load = async () => {
    const [vs, es, os] = await Promise.all([
      api.get('/venues'),
      api.get('/venues/equipment/all'),
      api.get('/repair-orders'),
    ]);
    setVenues(vs); setEquipment(es); setOrders(os);
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
      const body = {
        ...equipForm,
        venue_id: equipForm.venue_id ? Number(equipForm.venue_id) : null,
        maintain_interval_days: equipForm.maintain_interval_days ? Number(equipForm.maintain_interval_days) : null,
      };
      if (equipModal.mode === 'create') await api.post('/venues/equipment', body);
      else await api.put(`/venues/equipment/${equipModal.e.id}`, body);
      notify('器械已保存', 'success');
      setEquipModal(null);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function maintain(e) {
    if (!confirm(`确认登记「${e.name}」已于今天完成保养？\n保养周期将从今天重新计算。`)) return;
    try {
      await api.post(`/venues/equipment/${e.id}/maintain`, { maintained_at: todayStr() });
      notify('保养已登记，提醒已消除', 'success');
      load();
    } catch (err) { notify(err.message, 'error'); }
  }

  function openCreateOrder(e) {
    setOrderForm({ reporter: '', fault_desc: '', assignee: '' });
    setOrderModal({ mode: 'create', equipment: e });
  }

  async function submitOrder() {
    const { mode, order, equipment: eq } = orderModal;
    try {
      if (mode === 'create') {
        await api.post('/repair-orders', {
          equipment_id: eq.id,
          reporter: orderForm.reporter,
          fault_desc: orderForm.fault_desc,
          assignee: orderForm.assignee || null,
        });
        notify('工单已开出，器械状态已置为维修中', 'success');
      } else if (mode === 'dispatch') {
        await api.post(`/repair-orders/${order.id}/dispatch`, { assignee: orderForm.assignee });
        notify('已派单', 'success');
      } else if (mode === 'complete') {
        await api.post(`/repair-orders/${order.id}/complete`, {
          cost: Number(orderForm.cost) || 0,
          repair_result: orderForm.repair_result || null,
        });
        notify('工单已完成，器械已恢复正常', 'success');
      } else if (mode === 'scrap') {
        await api.post(`/repair-orders/${order.id}/scrap`, {
          scrap_reason: orderForm.scrap_reason,
          approver: orderForm.approver,
          cost: Number(orderForm.cost) || 0,
        });
        notify('已判定报废并记录审核人', 'success');
      }
      setOrderModal(null);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  const shownEquip = equipment.filter((e) => !equipFilter || e.status === equipFilter);
  const shownOrders = useMemo(() => {
    if (orderFilter === 'all') return orders;
    if (orderFilter === 'open') return orders.filter((o) => ['pending', 'processing'].includes(o.status));
    return orders.filter((o) => o.status === orderFilter);
  }, [orders, orderFilter]);

  // 下次保养日期（供表格展示）
  function nextMaintain(e) {
    if (!e.maintain_interval_days) return null;
    const base = e.last_maintained_at || e.purchased_at;
    if (!base) return null;
    return addDaysStr(base.slice(0, 10), e.maintain_interval_days);
  }

  const modalTitle = {
    create: '开工单（器械报修）',
    dispatch: '派单 / 指定处理人',
    complete: '登记维修完成',
    scrap: '判定报废',
  };

  return (
    <div>
      <div className="page-title">场地与器械</div>
      <div className="page-sub">报修必须开工单（报修人/故障/处理人/费用/完工时间全程留痕）；保养到期会生成提醒；可用器械数按台数统计</div>

      <div className="panel">
        <h3>🏟️ 场地
          <button className="btn sm primary" style={{ marginLeft: 'auto' }}
            onClick={() => { setVenueForm({ name: '', capacity: 10, location: '' }); setVenueModal({ mode: 'create' }); }}>+ 新增场地</button>
        </h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>场地</th><th>位置</th><th>容量</th><th>可用器械（台）</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {venues.map((v) => {
                const short = Number(v.normal_count) < Number(v.equipment_count);
                return (
                  <tr key={v.id}>
                    <td style={{ fontWeight: 600 }}>{v.name}</td>
                    <td className="muted">{v.location}</td>
                    <td>{v.capacity} 人</td>
                    <td>
                      <b className={short ? 'warn-text' : ''}>{v.normal_count}</b>
                      <span className="muted"> / {v.equipment_count} 台</span>
                      {short && <span className="badge warn" style={{ marginLeft: 6 }}>有器械不可用</span>}
                    </td>
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
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>🏋️ 器械台账
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <select value={equipFilter} onChange={(e) => setEquipFilter(e.target.value)}>
              <option value="">全部状态</option>
              <option value="normal">正常</option>
              <option value="maintenance">维修中</option>
              <option value="scrapped">已报废</option>
            </select>
            <button className="btn sm primary"
              onClick={() => { setEquipForm({ ...emptyEquipForm(), venue_id: venues[0]?.id || '' }); setEquipModal({ mode: 'create' }); }}>
              + 新增器械
            </button>
          </div>
        </h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>资产编号</th><th>器械</th><th>所属场地</th><th>数量</th><th>购置日期</th>
              <th>保养周期 / 下次保养</th><th>状态</th><th>备注</th><th>操作</th></tr></thead>
            <tbody>
              {shownEquip.map((e) => {
                const nm = nextMaintain(e);
                const overdue = nm && nm < todayStr() && e.status === 'normal';
                const soon = nm && nm >= todayStr() && nm <= addDaysStr(todayStr(), 3) && e.status === 'normal';
                return (
                  <tr key={e.id}>
                    <td className="mono">{e.asset_no}</td>
                    <td style={{ fontWeight: 600 }}>{e.name}</td>
                    <td className="muted">{e.venue_name || '未分配'}</td>
                    <td>{e.quantity}</td>
                    <td>{fmtDate(e.purchased_at)}</td>
                    <td style={{ fontSize: 12 }}>
                      {e.maintain_interval_days
                        ? <><span className="muted">{e.maintain_interval_days} 天</span>
                            <div className={overdue ? 'warn-text' : soon ? 'info-text' : 'muted'}>
                              {nm} {overdue ? '· 已逾期' : soon ? '· 临近' : ''}
                            </div></>
                        : <span className="muted">未设置</span>}
                    </td>
                    <td><span className={`badge ${EQUIP_STATUS[e.status].cls}`}>{EQUIP_STATUS[e.status].text}</span></td>
                    <td className="muted" style={{ fontSize: 12 }}>{e.note || '—'}</td>
                    <td className="nowrap">
                      {e.status !== 'scrapped' && !e.has_open_order &&
                        <button className="btn sm warn" onClick={() => openCreateOrder(e)}>报修开工单</button>}
                      {e.has_open_order && <span className="badge warn">工单处理中</span>}
                      {e.status === 'normal' && e.maintain_interval_days && (overdue || soon) &&
                        <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => maintain(e)}>登记保养</button>}
                      <button className="btn sm" style={{ marginLeft: 6 }}
                        onClick={() => {
                          setEquipForm({
                            name: e.name, asset_no: e.asset_no || '', quantity: e.quantity,
                            venue_id: e.venue_id || '', purchased_at: e.purchased_at || '', note: e.note || '',
                            maintain_interval_days: e.maintain_interval_days ?? '',
                            last_maintained_at: (e.last_maintained_at || '').slice(0, 10),
                          });
                          setEquipModal({ mode: 'edit', e });
                        }}>
                        编辑
                      </button>
                    </td>
                  </tr>
                );
              })}
              {shownEquip.length === 0 && <tr><td colSpan={9} className="empty">暂无器械</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>🛠️ 维修工单
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {[['open', '未完成'], ['pending', '待派单'], ['processing', '维修中'], ['done', '已完成'], ['scrapped', '已报废'], ['all', '全部']].map(([k, t]) => (
              <button key={k} className={`btn sm ${orderFilter === k ? 'primary' : ''}`} onClick={() => setOrderFilter(k)}>{t}</button>
            ))}
          </div>
        </h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>器械 / 场地</th><th>报修人</th><th>故障描述</th><th>处理人</th>
              <th>状态</th><th>费用</th><th>耗时</th><th>报修/完成时间</th><th>操作</th></tr></thead>
            <tbody>
              {shownOrders.map((o) => (
                <tr key={o.id}>
                  <td className="mono muted">#{o.id}</td>
                  <td className="nowrap">
                    <b>{o.equipment_name}</b>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {o.asset_no} · {o.venue_name || '未分配'} ×{o.quantity}
                    </div>
                  </td>
                  <td>{o.reporter}</td>
                  <td style={{ maxWidth: 220, fontSize: 12.5 }}>
                    {o.fault_desc}
                    {o.status === 'scrapped'
                      ? <div className="muted" style={{ marginTop: 2 }}>报废原因：{o.scrap_reason}（审核：{o.approver}）</div>
                      : o.repair_result && <div className="muted" style={{ marginTop: 2 }}>结果：{o.repair_result}</div>}
                  </td>
                  <td>{o.assignee || <span className="muted">未派单</span>}</td>
                  <td><span className={`badge ${ORDER_STATUS[o.status].cls}`}>{ORDER_STATUS[o.status].text}</span></td>
                  <td className="nowrap">{Number(o.cost) > 0 ? `¥${Number(o.cost).toFixed(2)}` : '—'}</td>
                  <td className="nowrap">{fmtDuration(o.duration_sec)}</td>
                  <td className="muted nowrap" style={{ fontSize: 12 }}>
                    报修 {fmtDateTime(o.created_at)}
                    {o.completed_at && <div>完成 {fmtDateTime(o.completed_at)}</div>}
                  </td>
                  <td className="nowrap">
                    {o.status === 'pending' &&
                      <button className="btn sm" onClick={() => { setOrderForm({ assignee: '' }); setOrderModal({ mode: 'dispatch', order: o }); }}>派单</button>}
                    {(o.status === 'pending' || o.status === 'processing') && <>
                      <button className="btn sm primary" style={{ marginLeft: 6 }}
                        onClick={() => { setOrderForm({ cost: '', repair_result: '' }); setOrderModal({ mode: 'complete', order: o }); }}>完工</button>
                      <button className="btn sm danger" style={{ marginLeft: 6 }}
                        onClick={() => { setOrderForm({ scrap_reason: '', approver: '', cost: '' }); setOrderModal({ mode: 'scrap', order: o }); }}>报废</button>
                    </>}
                    {(o.status === 'done' || o.status === 'scrapped') && <span className="muted">已归档</span>}
                  </td>
                </tr>
              ))}
              {shownOrders.length === 0 && <tr><td colSpan={10} className="empty">暂无工单</td></tr>}
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
            <label className="field">数量（台）
              <input type="number" min="1" value={equipForm.quantity} onChange={(e) => setEquipForm({ ...equipForm, quantity: Number(e.target.value) })} /></label>
            <label className="field">购置日期
              <input type="date" value={(equipForm.purchased_at || '').slice(0, 10)} onChange={(e) => setEquipForm({ ...equipForm, purchased_at: e.target.value })} /></label>
            <label className="field">保养周期（天，可空）
              <input type="number" min="1" placeholder="如 90 天" value={equipForm.maintain_interval_days ?? ''}
                onChange={(e) => setEquipForm({ ...equipForm, maintain_interval_days: e.target.value })} /></label>
            <label className="field">上次保养日期
              <input type="date" value={equipForm.last_maintained_at || ''} onChange={(e) => setEquipForm({ ...equipForm, last_maintained_at: e.target.value })} /></label>
            <label className="field" style={{ gridColumn: '1/-1' }}>备注
              <input value={equipForm.note} onChange={(e) => setEquipForm({ ...equipForm, note: e.target.value })} /></label>
          </div>
          {equipModal.mode === 'edit' && equipModal.e.status !== 'normal' && (
            <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
              当前状态为「{EQUIP_STATUS[equipModal.e.status].text}」，状态变更请通过维修工单操作。
            </div>
          )}
          <div className="form-actions">
            <button className="btn" onClick={() => setEquipModal(null)}>取消</button>
            <button className="btn primary" onClick={saveEquip}>保存</button>
          </div>
        </Modal>
      )}

      {orderModal && (
        <Modal title={modalTitle[orderModal.mode]} onClose={() => setOrderModal(null)}>
          {orderModal.mode === 'create' && (
            <div className="form-grid">
              <label className="field" style={{ gridColumn: '1/-1' }}>报修器械
                <input value={`${orderModal.equipment.name}（${orderModal.equipment.asset_no || '未编号'}）`} disabled /></label>
              <label className="field">报修人
                <input value={orderForm.reporter} placeholder="如：前台小雅"
                  onChange={(e) => setOrderForm({ ...orderForm, reporter: e.target.value })} /></label>
              <label className="field">处理人（可先不填，稍后派单）
                <input value={orderForm.assignee} placeholder="维修师傅/责任人"
                  onChange={(e) => setOrderForm({ ...orderForm, assignee: e.target.value })} /></label>
              <label className="field" style={{ gridColumn: '1/-1' }}>故障描述
                <textarea rows={3} value={orderForm.fault_desc} placeholder="请描述故障现象"
                  onChange={(e) => setOrderForm({ ...orderForm, fault_desc: e.target.value })} /></label>
            </div>
          )}
          {orderModal.mode === 'dispatch' && (
            <div className="form-grid">
              <label className="field" style={{ gridColumn: '1/-1' }}>处理人
                <input autoFocus value={orderForm.assignee} placeholder="维修师傅/责任人"
                  onChange={(e) => setOrderForm({ ...orderForm, assignee: e.target.value })} /></label>
            </div>
          )}
          {orderModal.mode === 'complete' && (
            <div className="form-grid">
              <label className="field">维修费用（元）
                <input type="number" min="0" step="0.01" value={orderForm.cost}
                  onChange={(e) => setOrderForm({ ...orderForm, cost: e.target.value })} /></label>
              <label className="field" style={{ gridColumn: '1/-1' }}>维修结果 / 备注
                <textarea rows={3} value={orderForm.repair_result} placeholder="如：更换跑带并校准"
                  onChange={(e) => setOrderForm({ ...orderForm, repair_result: e.target.value })} /></label>
            </div>
          )}
          {orderModal.mode === 'scrap' && (
            <div className="form-grid">
              <label className="field" style={{ gridColumn: '1/-1' }}>报废原因（必填）
                <textarea rows={3} value={orderForm.scrap_reason} placeholder="如：主板腐蚀，维修报价高于新购成本"
                  onChange={(e) => setOrderForm({ ...orderForm, scrap_reason: e.target.value })} /></label>
              <label className="field">审核人（必填）
                <input value={orderForm.approver} placeholder="如：店长 王经理"
                  onChange={(e) => setOrderForm({ ...orderForm, approver: e.target.value })} /></label>
              <label className="field">已产生维修费用（元）
                <input type="number" min="0" step="0.01" value={orderForm.cost}
                  onChange={(e) => setOrderForm({ ...orderForm, cost: e.target.value })} /></label>
            </div>
          )}
          <div className="form-actions">
            <button className="btn" onClick={() => setOrderModal(null)}>取消</button>
            <button className={`btn ${orderModal.mode === 'scrap' ? 'danger' : 'primary'}`} onClick={submitOrder}>
              {orderModal.mode === 'create' ? '开工单' : orderModal.mode === 'dispatch' ? '确认派单' : orderModal.mode === 'complete' ? '确认完工（恢复正常）' : '确认报废'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
