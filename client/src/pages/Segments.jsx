import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, CONDITION_META, describeCondition, todayStr, addDaysStr } from '../api.js';
import { notify } from '../notify.js';
import { useRole } from '../role.js';
import Modal from '../components/Modal.jsx';

const TAG_COLORS = ['#4ea8fc', '#c6f135', '#35d07f', '#f5a524', '#f25555', '#b98cff', '#ff8fa3'];

export function TagChip({ tag, size }) {
  return (
    <span className="tag-chip" style={{ '--tc': tag.color, fontSize: size === 'sm' ? 11 : 12 }}>
      {tag.name}
    </span>
  );
}

function BuilderModal({ tags, editing, onClose, onSaved }) {
  const [name, setName] = useState(editing?.name || '');
  const [desc, setDesc] = useState(editing?.description || '');
  const [rows, setRows] = useState(() => {
    const cs = editing?.conditions?.length
      ? editing.conditions
      : [{ field: 'card_expiring', days: 7, sessions: 3, tag_id: tags[0]?.id }];
    return cs.map((c) => ({
      field: c.field,
      days: c.days ?? 7,
      sessions: c.sessions ?? 3,
      tag_id: c.tag_id ?? tags[0]?.id,
    }));
  });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  function patchRow(i, patch) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setPreview(null);
  }
  function payload() {
    return rows.map((r) => {
      if (r.field === 'card_expiring') return { field: r.field, days: Number(r.days) };
      if (r.field === 'low_sessions') return { field: r.field, sessions: Number(r.sessions) };
      if (r.field === 'no_visit') return { field: r.field, days: Number(r.days) };
      if (r.field === 'has_tag') return { field: r.field, tag_id: Number(r.tag_id) };
      return { field: r.field };
    });
  }

  async function doPreview() {
    setBusy(true);
    try {
      const r = await api.post('/segments/preview', { conditions: payload() });
      setPreview(r);
    } catch (e) { notify(e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!name.trim()) return notify('请填写分群名称', 'error');
    try {
      const body = { name: name.trim(), description: desc, conditions: payload() };
      if (editing?.id) await api.put(`/segments/${editing.id}`, body);
      else await api.post('/segments', body);
      notify('分群已保存', 'success');
      onSaved();
    } catch (e) { notify(e.message, 'error'); }
  }

  return (
    <Modal wide title={editing?.id ? '编辑分群' : '新建分群'} onClose={onClose}>
      <div className="form-grid">
        <label className="field">分群名称 *
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：即将到期" /></label>
        <label className="field">说明
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="用途 / 回访话术提示" /></label>
      </div>

      <div style={{ margin: '16px 0 6px', fontWeight: 700 }}>筛选条件（多条同时满足，AND 组合）</div>
      {rows.map((r, i) => {
        const meta = CONDITION_META[r.field];
        return (
          <div key={i} className="cond-row">
            <select value={r.field} onChange={(e) => patchRow(i, { field: e.target.value })}>
              {Object.entries(CONDITION_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            </select>
            {meta.tag ? (
              <select value={r.tag_id} onChange={(e) => patchRow(i, { tag_id: Number(e.target.value) })}>
                {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            ) : meta.def !== null ? (
              <>
                <input type="number" min="1" style={{ width: 90 }}
                  value={r.field === 'low_sessions' ? r.sessions : r.days}
                  onChange={(e) => patchRow(i, r.field === 'low_sessions'
                    ? { sessions: e.target.value } : { days: e.target.value })} />
                <span className="muted">{meta.valueLabel}</span>
              </>
            ) : <span className="muted">无需参数</span>}
            <button className="btn sm danger" style={{ marginLeft: 'auto' }}
              disabled={rows.length === 1}
              onClick={() => { setRows((rs) => rs.filter((_, j) => j !== i)); setPreview(null); }}>
              删除
            </button>
          </div>
        );
      })}
      <button className="btn sm" style={{ marginTop: 8 }}
        onClick={() => setRows((rs) => [...rs, { field: 'card_expiring', days: 7, sessions: 3, tag_id: tags[0]?.id }])}>
        + 增加条件
      </button>

      <div className="form-actions" style={{ justifyContent: 'space-between' }}>
        <button className="btn" onClick={doPreview} disabled={busy}>{busy ? '统计中…' : '试算命中人数'}</button>
        <span>
          {preview && <span className="muted" style={{ marginRight: 12 }}>当前命中 <b style={{ color: 'var(--accent)' }}>{preview.count}</b> 人</span>}
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" style={{ marginLeft: 8 }} onClick={save}>保存分群</button>
        </span>
      </div>
    </Modal>
  );
}

function TagManager({ tags, changed }) {
  const [modal, setModal] = useState(null); // {name,color,id?}
  async function save() {
    if (!modal.name?.trim()) return notify('请填写标签名称', 'error');
    try {
      if (modal.id) await api.put(`/tags/${modal.id}`, { name: modal.name.trim(), color: modal.color });
      else await api.post('/tags', { name: modal.name.trim(), color: modal.color });
      notify('标签已保存', 'success');
      setModal(null);
      changed();
    } catch (e) { notify(e.message, 'error'); }
  }
  async function remove(t) {
    if (!confirm(`删除标签「${t.name}」？会员身上的该标签会一并解除。`)) return;
    try {
      await api.del(`/tags/${t.id}`);
      notify('标签已删除', 'success');
      changed();
    } catch (e) { notify(e.message, 'error'); }
  }
  return (
    <div className="panel">
      <h3>🏷️ 会员标签
        <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>（店长维护，分群条件可按标签筛选）</span>
        <button className="btn sm primary" style={{ marginLeft: 'auto' }}
          onClick={() => setModal({ name: '', color: TAG_COLORS[0] })}>+ 新建标签</button>
      </h3>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {tags.map((t) => (
          <span key={t.id} className="tag-manage-chip" style={{ '--tc': t.color }}>
            <TagChip tag={t} />
            <span className="muted" style={{ fontSize: 11.5 }}>{t.member_count} 人</span>
            <button className="link-btn" onClick={() => setModal({ id: t.id, name: t.name, color: t.color })}>改名</button>
            <button className="link-btn danger" onClick={() => remove(t)}>删除</button>
          </span>
        ))}
        {tags.length === 0 && <span className="muted">还没有标签</span>}
      </div>

      {modal && (
        <Modal title={modal.id ? '编辑标签' : '新建标签'} onClose={() => setModal(null)}>
          <label className="field">标签名称
            <input value={modal.name} onChange={(e) => setModal({ ...modal, name: e.target.value })}
              placeholder="如：企业客户" maxLength={30} /></label>
          <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
            {TAG_COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setModal({ ...modal, color: c })}
                style={{ width: 26, height: 26, borderRadius: '50%', background: c, cursor: 'pointer',
                  border: modal.color === c ? '3px solid #fff' : '3px solid transparent' }} />
            ))}
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setModal(null)}>取消</button>
            <button className="btn primary" onClick={save}>保存</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function GenerateModal({ segment, onClose, done }) {
  const [form, setForm] = useState({
    title: `【${segment.name}】回访跟进`,
    due_date: addDaysStr(todayStr(), 3),
    assignee: '前台',
  });
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const r = await api.post(`/segments/${segment.id}/generate-followups`, form);
      notify(`已生成 ${r.created} 条跟进${r.skipped ? `，跳过 ${r.skipped} 条已有跟进` : ''}`, 'success');
      done();
    } catch (e) { notify(e.message, 'error'); setBusy(false); }
  }
  return (
    <Modal title={`生成待跟进 · ${segment.name}（命中 ${segment.member_count} 人）`} onClose={onClose}>
      <div className="form-grid">
        <label className="field">跟进标题
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <label className="field">指派给
          <input value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} /></label>
        <label className="field">应跟进日期
          <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></label>
      </div>
      <div className="muted" style={{ marginTop: 12, fontSize: 12.5 }}>
        已有未结束跟进的会员会自动跳过，避免重复打扰；会员续费/续卡后事项会自动结束。
      </div>
      <div className="form-actions">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={busy || segment.member_count === 0} onClick={submit}>
          {busy ? '生成中…' : '一键生成待跟进'}
        </button>
      </div>
    </Modal>
  );
}

export default function Segments() {
  const role = useRole();
  const manager = role === 'manager';
  const [tags, setTags] = useState([]);
  const [segments, setSegments] = useState([]);
  const [selected, setSelected] = useState(null); // {segment, count, members}
  const [builder, setBuilder] = useState(null);
  const [gen, setGen] = useState(null);

  const loadTags = () => api.get('/tags').then(setTags);
  const loadSegments = () => api.get('/segments').then(setSegments);
  useEffect(() => { Promise.all([loadTags(), loadSegments()]); }, []);

  async function openSegment(s) {
    try {
      const r = await api.get(`/segments/${s.id}/members`);
      setSelected(r);
    } catch (e) { notify(e.message, 'error'); }
  }

  return (
    <div>
      <div className="page-title">会员分群</div>
      <div className="page-sub">
        把常用筛选条件保存为分群，组合多条条件圈选会员；名单可导出，也可一键生成待跟进交给前台
        {!manager && '（当前为前台角色：可使用分群、导出名单与更新跟进状态）'}
      </div>

      {manager && <TagManager tags={tags} changed={loadTags} />}

      <div className="toolbar">
        <b>常用分群</b>
        {manager && (
          <button className="btn sm primary" style={{ marginLeft: 'auto' }}
            onClick={() => setBuilder({})}>+ 新建分群</button>
        )}
      </div>

      <div className="segment-grid">
        {segments.map((s) => (
          <div key={s.id} className={`segment-card${selected?.segment?.id === s.id ? ' active' : ''}`}
            onClick={() => openSegment(s)}>
            <div className="seg-title">{s.name}</div>
            <div className="seg-conds">
              {s.conditions.map((c, i) => (
                <span key={i} className="cond-chip">
                  {i > 0 && <span className="and">且</span>}{describeCondition(c, tags)}
                </span>
              ))}
            </div>
            {s.description && <div className="muted seg-desc">{s.description}</div>}
            <div className="seg-foot">
              <span className="muted">命中 <b style={{ color: 'var(--accent)' }}>{s.member_count}</b> 人</span>
              {manager && <span className="seg-ops" onClick={(e) => e.stopPropagation()}>
                <button className="link-btn" onClick={() => setBuilder(s)}>编辑</button>
                <button className="link-btn danger" onClick={async () => {
                  if (!confirm(`删除分群「${s.name}」？历史跟进事项保留。`)) return;
                  try {
                    await api.del(`/segments/${s.id}`);
                    notify('分群已删除', 'success');
                    if (selected?.segment?.id === s.id) setSelected(null);
                    loadSegments();
                  } catch (e) { notify(e.message, 'error'); }
                }}>删除</button>
              </span>}
            </div>
          </div>
        ))}
        {segments.length === 0 && <div className="empty">还没有保存的分群</div>}
      </div>

      {selected && (
        <div className="panel">
          <h3>👥 {selected.segment.name} · 命中名单（{selected.count} 人）
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <a className="btn sm" href={`/api/segments/${selected.segment.id}/export`}>⬇ 导出 CSV</a>
              {manager && (
                <button className="btn sm primary"
                  onClick={() => setGen({ ...selected.segment, member_count: selected.count })}>
                  📋 一键生成待跟进
                </button>
              )}
            </span>
          </h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>ID</th><th>姓名</th><th>手机号</th><th>标签</th><th>代表卡</th><th>最近到店</th><th></th></tr></thead>
              <tbody>
                {selected.members.map((m) => (
                  <tr key={m.id}>
                    <td className="muted">#{m.id}</td>
                    <td style={{ fontWeight: 600 }}>{m.name}</td>
                    <td className="mono">{m.phone}</td>
                    <td>
                      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                        {(m.tags || []).map((t) => <TagChip key={t.id} tag={t} size="sm" />)}
                        {(!m.tags || m.tags.length === 0) && <span className="muted">—</span>}
                      </span>
                    </td>
                    <td className="muted">{m.card_summary || '无卡'}</td>
                    <td className="muted nowrap">{m.last_visit_at ? fmtDate(m.last_visit_at.slice(0, 10)) : '从未到店'}</td>
                    <td><Link className="btn sm" to={`/members/${m.id}`}>详情</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {builder && (
        <BuilderModal tags={tags} editing={builder.id ? builder : null}
          onClose={() => setBuilder(null)}
          onSaved={() => { setBuilder(null); setSelected(null); loadSegments(); }} />
      )}
      {gen && <GenerateModal segment={gen} onClose={() => setGen(null)}
        done={() => { setGen(null); openSegment(gen); }} />}
    </div>
  );
}
