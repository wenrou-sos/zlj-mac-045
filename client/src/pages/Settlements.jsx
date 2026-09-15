import { useEffect, useMemo, useState } from 'react';
import { api, fmtDateTime, SETTLE_CATEGORY } from '../api.js';
import { notify } from '../notify.js';
import Modal from '../components/Modal.jsx';

const fmtMoney = (n) => `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// 默认选中上个月（本月尚未结束，不能结算）
function prevMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function Settlements() {
  const [batches, setBatches] = useState([]);
  const [period, setPeriod] = useState(prevMonth());
  const [detail, setDetail] = useState(null); // { batch, items, summary }
  const [adjustments, setAdjustments] = useState([]);
  const [coaches, setCoaches] = useState([]);
  const [showAdj, setShowAdj] = useState(false);
  const [adjForm, setAdjForm] = useState({ coach_id: '', direction: 'deduct', amount: '', reason: '', class_id: '' });

  const load = () => {
    api.get('/settlements').then(setBatches);
    api.get('/settlements/adjustments/list').then(setAdjustments);
  };
  useEffect(() => {
    load();
    api.get('/coaches').then(setCoaches);
  }, []);

  async function generate() {
    if (!confirm(`确定生成 ${period} 期课时结算单？\n生成后该时段课程将锁定，之后的改动只能通过调整记录冲抵。`)) return;
    try {
      const r = await api.post('/settlements', { period });
      notify(`结算单已生成：${r.batch.class_count} 节课，合计 ${fmtMoney(r.batch.total_amount)}`, 'success');
      load();
      openDetail(period);
    } catch (e) { notify(e.message, 'error'); }
  }

  async function openDetail(p) {
    try {
      setDetail(await api.get(`/settlements/${p}`));
    } catch (e) { notify(e.message, 'error'); }
  }

  function openAdj() {
    setAdjForm({ coach_id: coaches[0]?.id || '', direction: 'deduct', amount: '', reason: '', class_id: '' });
    setShowAdj(true);
  }

  async function saveAdj() {
    try {
      const amount = Number(adjForm.amount);
      if (!amount || amount <= 0) return notify('请填写大于 0 的金额', 'error');
      await api.post('/settlements/adjustments', {
        coach_id: Number(adjForm.coach_id),
        class_id: adjForm.class_id ? Number(adjForm.class_id) : undefined,
        amount: adjForm.direction === 'deduct' ? -amount : amount,
        reason: adjForm.reason,
      });
      notify('调整记录已创建，将在下期结算单中冲抵', 'success');
      setShowAdj(false);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  // 当前详情批次里该教练已结算的课程（供调整记录关联）
  const lockedClasses = useMemo(() => {
    if (!detail || !adjForm.coach_id) return [];
    return detail.items.filter((i) => i.class_id && i.coach_id === Number(adjForm.coach_id));
  }, [detail, adjForm.coach_id]);

  return (
    <div>
      <div className="page-title">课时结算</div>
      <div className="page-sub">按课程实际上课情况出月度结算单；出单后课程锁定，后续更正走调整记录冲抵下期，不改已出数字</div>

      <div className="toolbar">
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>账期
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </label>
        <button className="btn primary" onClick={generate}>生成结算单</button>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={openAdj}>+ 新建调整记录</button>
      </div>

      <div className="panel">
        <h3>🧾 结算批次</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>账期</th><th>结算课程</th><th>教练数</th><th>应付合计</th><th>生成时间</th><th>经办</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td><b>{b.period}</b></td>
                  <td>{b.class_count} 节</td>
                  <td>{b.coach_count} 人</td>
                  <td><b>{fmtMoney(b.total_amount)}</b></td>
                  <td className="muted nowrap">{fmtDateTime(b.created_at)}</td>
                  <td className="muted">{b.operator}</td>
                  <td><span className="badge ok">已出单 · 已锁定</span></td>
                  <td><button className="btn sm" onClick={() => openDetail(b.period)}>查看明细</button></td>
                </tr>
              ))}
              {batches.length === 0 && <tr><td colSpan={8} className="empty">还没有结算批次，选择账期后点击「生成结算单」</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <div className="panel">
          <h3>📑 {detail.batch.period} 期结算明细（课程 {detail.batch.class_count} 节 · 合计 {fmtMoney(detail.batch.total_amount)}）</h3>
          <div className="table-wrap" style={{ marginBottom: 18 }}>
            <table>
              <thead>
                <tr>
                  <th>教练</th>
                  <th>正常授课</th><th>代课</th><th>取消</th><th>未到店</th><th>请假不计费</th>
                  <th>调整冲抵</th><th>本期应付</th>
                </tr>
              </thead>
              <tbody>
                {detail.summary.map((s) => (
                  <tr key={s.coach_id || 'none'}>
                    <td><b>{s.coach_name}</b></td>
                    <td>{s.normal.count} 节 / {s.normal.hours}h<span className="muted">　{fmtMoney(s.normal.amount)}</span></td>
                    <td>{s.substitute.count} 节 / {s.substitute.hours}h<span className="muted">　{fmtMoney(s.substitute.amount)}</span></td>
                    <td>{s.canceled.count} 节</td>
                    <td>{s.no_show.count} 节</td>
                    <td>{s.leave_excluded.count} 节</td>
                    <td style={{ color: s.adjustment < 0 ? 'var(--danger)' : s.adjustment > 0 ? 'var(--ok)' : undefined }}>
                      {s.adjustment ? fmtMoney(s.adjustment) : '—'}
                    </td>
                    <td><b>{fmtMoney(s.total)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>时间</th><th>课程</th><th>教练</th><th>类别</th><th>时长</th><th>金额</th><th>备注</th></tr></thead>
              <tbody>
                {detail.items.map((i) => {
                  const cat = SETTLE_CATEGORY[i.category] || { text: i.category, cls: 'muted' };
                  return (
                    <tr key={i.id}>
                      <td className="muted nowrap">{i.start_at ? fmtDateTime(i.start_at) : '—'}</td>
                      <td>{i.title || '（调整记录）'}</td>
                      <td>{i.coach_name || '未指派'}</td>
                      <td><span className={`badge ${cat.cls}`}>{cat.text}</span></td>
                      <td>{Number(i.hours) > 0 ? `${i.hours}h` : '—'}</td>
                      <td className="nowrap">{Number(i.amount) !== 0 ? fmtMoney(i.amount) : '—'}</td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {i.category === 'substitute' && i.original_coach_name ? `原教练：${i.original_coach_name} · ` : ''}{i.note}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <h3>🧮 调整记录（结算锁定后的更正，冲抵到下期）</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>时间</th><th>教练</th><th>关联课程</th><th>金额</th><th>原因</th><th>状态</th></tr></thead>
            <tbody>
              {adjustments.map((a) => (
                <tr key={a.id}>
                  <td className="muted nowrap">{fmtDateTime(a.created_at)}</td>
                  <td><b>{a.coach_name}</b></td>
                  <td className="muted">{a.class_title ? `${a.class_title}（${fmtDateTime(a.class_start_at)}）` : '—'}</td>
                  <td style={{ color: Number(a.amount) < 0 ? 'var(--danger)' : 'var(--ok)' }} className="nowrap">
                    {Number(a.amount) > 0 ? '+' : ''}{fmtMoney(a.amount)}
                  </td>
                  <td>{a.reason}</td>
                  <td>{a.status === 'pending'
                    ? <span className="badge warn">待冲抵</span>
                    : <span className="badge ok">已并入 {a.applied_period} 期</span>}</td>
                </tr>
              ))}
              {adjustments.length === 0 && <tr><td colSpan={6} className="empty">暂无调整记录</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {showAdj && (
        <Modal title="新建调整记录" onClose={() => setShowAdj(false)}>
          <p className="muted" style={{ marginBottom: 14, fontSize: 12.5 }}>
            用于已结算锁定课程的更正（如代课归属登错、课后补扣）。不会改动已出结算单，将在下期结算时冲抵。
          </p>
          <div className="form-grid">
            <label className="field">教练
              <select value={adjForm.coach_id} onChange={(e) => setAdjForm({ ...adjForm, coach_id: e.target.value, class_id: '' })}>
                {coaches.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="field">类型
              <select value={adjForm.direction} onChange={(e) => setAdjForm({ ...adjForm, direction: e.target.value })}>
                <option value="deduct">扣减（从下期扣除）</option>
                <option value="add">补发（加到下期）</option>
              </select>
            </label>
            <label className="field">金额（元）
              <input type="number" min="0" step="0.01" value={adjForm.amount} onChange={(e) => setAdjForm({ ...adjForm, amount: e.target.value })} />
            </label>
            <label className="field">关联课程（可选）
              <select value={adjForm.class_id} onChange={(e) => setAdjForm({ ...adjForm, class_id: e.target.value })}>
                <option value="">不关联</option>
                {lockedClasses.map((i) => (
                  <option key={i.class_id} value={i.class_id}>{i.title} · {fmtDateTime(i.start_at)}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ gridColumn: '1/-1' }}>调整原因
              <input value={adjForm.reason} placeholder="如：9/12 搏击操实际由李静代课，扣回张猛课时费" onChange={(e) => setAdjForm({ ...adjForm, reason: e.target.value })} />
            </label>
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setShowAdj(false)}>取消</button>
            <button className="btn primary" onClick={saveAdj}>保存调整记录</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
