import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime, WAITLIST_STATUS, countdownText } from '../api.js';
import { notify } from '../notify.js';

const TABS = [
  ['active', '进行中'],
  ['', '全部'],
  ['waiting', '排队中'],
  ['promoted', '待确认'],
  ['confirmed', '已确认'],
  ['ended', '已结束'],
];

export default function Waitlists() {
  const [list, setList] = useState([]);
  const [tab, setTab] = useState('active');
  const [, setTick] = useState(0);

  const load = () =>
    api.get('/waitlists').then((rows) => {
      if (tab === 'active') return rows.filter((w) => ['waiting', 'promoted'].includes(w.status));
      if (tab === 'ended') return rows.filter((w) => ['expired', 'abandoned', 'closed'].includes(w.status));
      if (tab) return rows.filter((w) => w.status === tab);
      return rows;
    }).then(setList);

  useEffect(() => { load(); }, [tab]);
  // 30 秒拉取最新状态（自动递补/逾期结果）
  useEffect(() => {
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [tab]);
  // 每秒刷新倒计时显示
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  async function confirm(w) {
    if (!confirm(`确认 ${w.member_name} 候补转正「${w.title}」吗？\n确认后预约生效，核销码 ${w.verify_code}`)) return;
    try {
      const r = await api.post(`/waitlists/${w.id}/confirm`, {});
      notify(`已确认，核销码 ${r.verify_code}`, 'success');
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  async function abandon(w) {
    const tip = w.status === 'promoted'
      ? '放弃后将取消已转正的预约并退还预扣次数，名额自动递补给下一位'
      : '退出后候补名额将顺延给后面的会员';
    if (!confirm(`确定放弃「${w.title}」的候补吗？\n${tip}`)) return;
    try {
      const r = await api.post(`/waitlists/${w.id}/abandon`, {});
      notify(r.refund_sessions > 0 ? `已放弃并退还 ${r.refund_sessions} 次，正在递补下一位` : '已退出候补队列', 'success');
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  return (
    <div>
      <div className="page-title">候补队列</div>
      <div className="page-sub">
        满员课程可加入候补；有人取消预约或整课取消时，按加入顺序自动递补。
        转正后需在确认截止时间（默认 2 小时内、最晚开课前 15 分钟）前确认，逾期自动放弃退次并顺延
      </div>

      <div className="toolbar">
        {TABS.map(([k, t]) => (
          <button key={t} className={`btn ${tab === k ? 'primary' : ''}`} onClick={() => setTab(k)}>{t}</button>
        ))}
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={load}>刷新</button>
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>会员</th><th>课程</th><th>上课时间</th><th>排队顺序</th><th>状态</th>
              <th>候补时间</th><th>转正/确认</th><th>确认截止</th><th>核销码</th>
              <th>结果说明</th><th>操作</th>
            </tr></thead>
            <tbody>
              {list.map((w) => {
                const overdue = w.status === 'promoted' && new Date(w.confirm_deadline) <= new Date();
                return (
                  <tr key={w.id} style={w.status === 'promoted' ? { background: 'rgba(245,165,36,.06)' } : undefined}>
                    <td><Link to={`/members/${w.member_id}`} style={{ color: 'var(--accent)' }}>{w.member_name}</Link>
                      <div className="muted mono" style={{ fontSize: 11 }}>{w.phone}</div></td>
                    <td style={{ fontWeight: 600 }}>{w.title}
                      <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>
                        {w.coach_name || '待定'} · {w.venue_name || '待定场地'} · {w.cost_sessions} 课次
                      </div></td>
                    <td className="nowrap">{fmtDateTime(w.start_at)}</td>
                    <td>{w.status === 'waiting'
                      ? <b style={{ color: 'var(--info)' }}>第 {w.queue_position} 位</b>
                      : <span className="muted">—</span>}
                      {w.status === 'waiting' && <div className="muted" style={{ fontSize: 11 }}>共 {w.waiting_count} 人</div>}
                    </td>
                    <td><span className={`badge ${WAITLIST_STATUS[w.status]?.cls || 'muted'}`}>
                      {WAITLIST_STATUS[w.status]?.text || w.status}
                    </span></td>
                    <td className="muted nowrap" style={{ fontSize: 12 }}>{fmtDateTime(w.joined_at)}</td>
                    <td className="muted nowrap" style={{ fontSize: 12 }}>
                      {w.confirmed_at ? `确认 ${fmtDateTime(w.confirmed_at)}`
                        : w.promoted_at ? `转正 ${fmtDateTime(w.promoted_at)}` : '—'}
                    </td>
                    <td className="nowrap">
                      {w.confirm_deadline ? <>
                        <div style={{ fontWeight: 600, color: overdue ? 'var(--danger)' : 'var(--warn)' }}>
                          {overdue ? '已截止' : countdownText(w.confirm_deadline)}
                        </div>
                        <div className="muted" style={{ fontSize: 11 }}>{fmtDateTime(w.confirm_deadline)}</div>
                      </> : <span className="muted">—</span>}
                    </td>
                    <td className="code-chip">{w.verify_code || '—'}</td>
                    <td className="muted" style={{ fontSize: 12, maxWidth: 220 }}>
                      {w.result_note || w.skip_reason || (w.status === 'waiting' ? '等待名额空缺' : '—')}
                      {w.abandon_reason && <div>放弃原因：{w.abandon_reason}</div>}
                    </td>
                    <td className="nowrap">
                      {w.status === 'promoted' && !overdue &&
                        <button className="btn sm primary" onClick={() => confirm(w)}>确认转正</button>}
                      {['waiting', 'promoted'].includes(w.status) &&
                        <button className="btn sm danger" style={{ marginLeft: 6 }} onClick={() => abandon(w)}>
                          {w.status === 'promoted' ? '放弃名额' : '退出候补'}
                        </button>}
                      {!['waiting', 'promoted'].includes(w.status) && <span className="muted">—</span>}
                    </td>
                  </tr>
                );
              })}
              {list.length === 0 && <tr><td colSpan={11} className="empty">没有候补记录</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
