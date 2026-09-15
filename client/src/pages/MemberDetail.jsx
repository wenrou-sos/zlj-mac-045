import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, fmtDateTime, CARD_STATUS, BOOKING_STATUS, FOLLOWUP_STATUS, todayStr, addDaysStr } from '../api.js';
import { notify } from '../notify.js';
import { useRole } from '../role.js';
import { TagChip } from './Segments.jsx';
import Modal from '../components/Modal.jsx';

const PLANS = [
  { name: '月卡', type: 'period', price: 268, days: 30 },
  { name: '季卡', type: 'period', price: 699, days: 90 },
  { name: '半年卡', type: 'period', price: 1299, days: 180 },
  { name: '年卡', type: 'period', price: 2388, days: 365 },
  { name: '10次卡', type: 'count', price: 399, sessions: 10 },
  { name: '20次卡', type: 'count', price: 699, sessions: 20 },
  { name: '30次卡', type: 'count', price: 899, sessions: 30 },
  { name: '50次卡', type: 'count', price: 1299, sessions: 50 },
];

export default function MemberDetail() {
  const { id } = useParams();
  const manager = useRole() === 'manager';
  const [m, setM] = useState(null);
  const [allTags, setAllTags] = useState([]);
  const [tagEditing, setTagEditing] = useState(false);
  const [chosenTags, setChosenTags] = useState([]);
  const [manualFollow, setManualFollow] = useState(false);
  const [followForm, setFollowForm] = useState({
    title: '', content: '', assignee: '前台', due_date: addDaysStr(todayStr(), 3),
  });
  const [openCard, setOpenCard] = useState(false);
  const [renewCard, setRenewCard] = useState(null);
  const [planIdx, setPlanIdx] = useState(0);
  const [startDate, setStartDate] = useState(todayStr());

  // 续费表单
  const [renewForm, setRenewForm] = useState({ amount: 0, extend_days: 30, add_sessions: 10 });

  const load = () => api.get(`/members/${id}`).then(setM);
  useEffect(() => {
    load();
    api.get('/tags').then(setAllTags).catch(() => {});
  }, [id]);

  if (!m) return <div className="empty">加载中…</div>;

  function openTagEditor() {
    setChosenTags((m.tags || []).map((t) => t.id));
    setTagEditing(true);
  }
  async function saveTags() {
    try {
      await api.put(`/members/${id}/tags`, { tag_ids: chosenTags });
      notify('标签已更新', 'success');
      setTagEditing(false);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }
  async function submitManualFollow() {
    if (!followForm.title.trim()) return notify('请填写跟进标题', 'error');
    try {
      await api.post(`/members/${id}/follow-ups`, followForm);
      notify('待跟进已创建', 'success');
      setManualFollow(false);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function submitOpenCard() {
    const p = PLANS[planIdx];
    const body = {
      member_id: Number(id),
      plan_name: p.name,
      card_type: p.type,
      price: p.price,
      start_date: startDate,
      end_date: p.type === 'period' ? addDaysStr(startDate, p.days) : null,
      total_sessions: p.type === 'count' ? p.sessions : null,
    };
    try {
      await api.post('/cards', body);
      notify(`已开卡：${p.name}`, 'success');
      setOpenCard(false);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function submitRenew() {
    try {
      await api.post(`/cards/${renewCard.id}/renew`, {
        amount: renewForm.amount,
        extend_days: renewCard.card_type === 'period' ? renewForm.extend_days : 0,
        add_sessions: renewCard.card_type === 'count' ? renewForm.add_sessions : 0,
      });
      notify('续费成功', 'success');
      setRenewCard(null);
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function toggleFreeze(c) {
    try {
      await api.post(`/cards/${c.id}/freeze`);
      notify(c.status === 'frozen' ? '已解冻' : '已冻结', 'success');
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  function openRenew(c) {
    const p = PLANS.find((x) => x.name === c.plan_name);
    setRenewForm({
      amount: p?.price || 0,
      extend_days: p?.days || 30,
      add_sessions: p?.sessions || 10,
    });
    setRenewCard(c);
  }

  return (
    <div>
      <div className="page-sub"><Link to="/members" className="muted">← 返回会员列表</Link></div>
      <div className="page-title">{m.name} <span className="muted" style={{ fontSize: 14 }}>#{m.id} · {m.phone}</span></div>
      <div className="page-sub">{m.gender} · 入会于 {fmtDate(m.joined_at)}{m.note ? ` · ${m.note}` : ''}</div>

      <div className="panel">
        <h3>🏷️ 标签
          {manager && <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={openTagEditor}>编辑标签</button>}
        </h3>
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          {(m.tags || []).map((t) => <TagChip key={t.id} tag={t} />)}
          {(!m.tags || m.tags.length === 0) && <span className="muted">暂无标签</span>}
        </span>
      </div>

      <div className="panel">
        <h3>💳 会员卡
          <button className="btn sm primary" style={{ marginLeft: 'auto' }} onClick={() => setOpenCard(true)}>+ 开新卡</button>
        </h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>卡号</th><th>卡种</th><th>类型</th><th>有效期</th><th>剩余</th><th>价格</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {m.cards.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.card_no}</td>
                  <td style={{ fontWeight: 600 }}>{c.plan_name}</td>
                  <td>{c.card_type === 'period' ? '期限卡' : '次卡'}</td>
                  <td className="nowrap">{fmtDate(c.start_date)} ~ {c.end_date ? fmtDate(c.end_date) : '不限'}</td>
                  <td>{c.card_type === 'count' ? <b>{c.remaining}</b> : '不限次'}</td>
                  <td>¥{Number(c.price).toFixed(0)}</td>
                  <td><span className={`badge ${CARD_STATUS[c.status]?.cls}`}>{CARD_STATUS[c.status]?.text}</span></td>
                  <td className="nowrap">
                    <button className="btn sm primary" onClick={() => openRenew(c)}>续费</button>
                    <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => toggleFreeze(c)}>
                      {c.status === 'frozen' ? '解冻' : '冻结'}
                    </button>
                  </td>
                </tr>
              ))}
              {m.cards.length === 0 && <tr><td colSpan={8} className="empty">还没有会员卡</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>📝 最近预约</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>课程</th><th>场地</th><th>上课时间</th><th>核销码</th><th>状态</th></tr></thead>
            <tbody>
              {m.recentBookings.map((b) => (
                <tr key={b.id}>
                  <td>{b.title}</td>
                  <td className="muted">{b.venue_name}</td>
                  <td className="nowrap">{fmtDateTime(b.start_at)}</td>
                  <td className="code-chip">{b.verify_code}</td>
                  <td><span className={`badge ${BOOKING_STATUS[b.status]?.cls || 'muted'}`}>{BOOKING_STATUS[b.status]?.text || b.status}</span></td>
                </tr>
              ))}
              {m.recentBookings.length === 0 && <tr><td colSpan={5} className="empty">暂无预约记录</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>📞 历次跟进
          {manager && <button className="btn sm primary" style={{ marginLeft: 'auto' }}
            onClick={() => setManualFollow(true)}>+ 新建跟进</button>}
        </h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>状态</th><th>跟进内容</th><th>来源</th><th>结论</th><th>处理人</th><th>时间</th></tr></thead>
            <tbody>
              {(m.followUps || []).map((f) => (
                <tr key={f.id}>
                  <td><span className={`badge ${FOLLOWUP_STATUS[f.status]?.cls}`}>{FOLLOWUP_STATUS[f.status]?.text}</span>
                    {f.auto_closed && <div className="muted" style={{ fontSize: 11 }}>自动结束</div>}</td>
                  <td style={{ maxWidth: 220 }}>
                    <div style={{ fontWeight: 600 }}>{f.title}</div>
                    {f.content && <div className="muted" style={{ fontSize: 12 }}>{f.content}</div>}
                    {f.due_date && <div className="muted" style={{ fontSize: 11 }}>应跟进 {fmtDate(f.due_date)}</div>}
                  </td>
                  <td className="muted">{f.segment_name || '手工创建'}</td>
                  <td style={{ maxWidth: 220, fontSize: 12.5 }}>
                    {f.result_note || <span className="muted">—</span>}
                    {f.auto_closed && f.closed_reason && <div className="muted" style={{ fontSize: 11 }}>{f.closed_reason}</div>}
                  </td>
                  <td className="muted">{f.handler || '—'}</td>
                  <td className="muted nowrap" style={{ fontSize: 11.5 }}>
                    创 {fmtDateTime(f.created_at)}
                    {f.contacted_at && <div>联 {fmtDateTime(f.contacted_at)}</div>}
                    {f.closed_at && <div>结 {fmtDateTime(f.closed_at)}</div>}
                  </td>
                </tr>
              ))}
              {(!m.followUps || m.followUps.length === 0) &&
                <tr><td colSpan={6} className="empty">暂无跟进记录</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* 标签编辑 */}
      {tagEditing && (
        <Modal title={`编辑标签 · ${m.name}`} onClose={() => setTagEditing(false)}>
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {allTags.map((t) => {
              const on = chosenTags.includes(t.id);
              return (
                <button key={t.id} type="button" className={on ? 'tag-pick on' : 'tag-pick'}
                  style={{ '--tc': t.color }}
                  onClick={() => setChosenTags((xs) => on ? xs.filter((x) => x !== t.id) : [...xs, t.id])}>
                  {t.name}
                </button>
              );
            })}
            {allTags.length === 0 && <span className="muted">还没有可选标签，请店长先在「会员分群」页创建</span>}
          </span>
          <div className="form-actions">
            <button className="btn" onClick={() => setTagEditing(false)}>取消</button>
            <button className="btn primary" onClick={saveTags}>保存</button>
          </div>
        </Modal>
      )}

      {/* 手工新建跟进 */}
      {manualFollow && (
        <Modal title={`新建跟进 · ${m.name}`} onClose={() => setManualFollow(false)}>
          <div className="form-grid">
            <label className="field">跟进标题 *
              <input value={followForm.title}
                onChange={(e) => setFollowForm({ ...followForm, title: e.target.value })}
                placeholder="如：续费意向确认" /></label>
            <label className="field">指派给
              <input value={followForm.assignee}
                onChange={(e) => setFollowForm({ ...followForm, assignee: e.target.value })} /></label>
            <label className="field">应跟进日期
              <input type="date" value={followForm.due_date}
                onChange={(e) => setFollowForm({ ...followForm, due_date: e.target.value })} /></label>
          </div>
          <label className="field" style={{ marginTop: 14 }}>跟进说明
            <textarea rows={3} value={followForm.content}
              onChange={(e) => setFollowForm({ ...followForm, content: e.target.value })} /></label>
          <div className="form-actions">
            <button className="btn" onClick={() => setManualFollow(false)}>取消</button>
            <button className="btn primary" onClick={submitManualFollow}>创建</button>
          </div>
        </Modal>
      )}

      {/* 开卡 */}
      {openCard && (
        <Modal title="开设新卡" onClose={() => setOpenCard(false)}>
          <div className="form-grid">
            <label className="field">选择卡种
              <select value={planIdx} onChange={(e) => setPlanIdx(Number(e.target.value))}>
                {PLANS.map((p, i) => <option key={p.name} value={i}>{p.name} — ¥{p.price}</option>)}
              </select>
            </label>
            <label className="field">开始日期
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
          </div>
          <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
            {PLANS[planIdx].type === 'period'
              ? `有效期 ${PLANS[planIdx].days} 天，到期日 ${addDaysStr(startDate, PLANS[planIdx].days)}`
              : `共 ${PLANS[planIdx].sessions} 次，按约课扣次`}
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setOpenCard(false)}>取消</button>
            <button className="btn primary" onClick={submitOpenCard}>确认开卡</button>
          </div>
        </Modal>
      )}

      {/* 续费 */}
      {renewCard && (
        <Modal title={`续费 · ${renewCard.plan_name}（${renewCard.card_no}）`} onClose={() => setRenewCard(null)}>
          <div className="form-grid">
            <label className="field">续费金额（元）
              <input type="number" value={renewForm.amount}
                onChange={(e) => setRenewForm({ ...renewForm, amount: Number(e.target.value) })} /></label>
            {renewCard.card_type === 'period' ? (
              <label className="field">延长天数
                <input type="number" value={renewForm.extend_days}
                  onChange={(e) => setRenewForm({ ...renewForm, extend_days: Number(e.target.value) })} /></label>
            ) : (
              <label className="field">增加次数
                <input type="number" value={renewForm.add_sessions}
                  onChange={(e) => setRenewForm({ ...renewForm, add_sessions: Number(e.target.value) })} /></label>
            )}
          </div>
          <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
            {renewCard.card_type === 'period'
              ? `当前到期 ${fmtDate(renewCard.end_date)}，续费后自动顺延`
              : `当前剩余 ${renewCard.remaining} 次`}
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setRenewCard(null)}>取消</button>
            <button className="btn primary" onClick={submitRenew}>确认续费</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
