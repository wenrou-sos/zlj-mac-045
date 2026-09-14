import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../api.js';
import { notify } from '../notify.js';

const TYPE_TEXT = { expired: '已过期', expiring: '即将到期', low_sessions: '次数不足' };
const TYPE_CLS = { expired: 'danger', expiring: 'info', low_sessions: 'warn' };

export default function Reminders() {
  const [list, setList] = useState([]);
  const [status, setStatus] = useState('pending');
  const [type, setType] = useState('');

  const load = () =>
    api.get(`/reminders?status=${status}${type ? `&type=${type}` : ''}`).then(setList);
  useEffect(() => { load(); }, [status, type]);

  async function setOne(r, s) {
    try {
      await api.post(`/reminders/${r.id}/status`, { status: s });
      notify(s === 'notified' ? '已标记为已通知' : '已忽略', 'success');
      load();
    } catch (e) { notify(e.message, 'error'); }
  }

  return (
    <div>
      <div className="page-title">到期 / 续费提醒</div>
      <div className="page-sub">期限卡 7 天内到期或已过期、次卡剩余 ≤ 3 次时自动生成提醒；续费后自动消除</div>

      <div className="toolbar">
        {[['pending', '待处理'], ['notified', '已通知'], ['ignored', '已忽略'], ['all', '全部']].map(([k, t]) => (
          <button key={k} className={`btn ${status === k ? 'primary' : ''}`} onClick={() => setStatus(k)}>{t}</button>
        ))}
        <select style={{ marginLeft: 'auto' }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">全部类型</option>
          <option value="expired">已过期</option>
          <option value="expiring">即将到期</option>
          <option value="low_sessions">次数不足</option>
        </select>
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>类型</th><th>会员</th><th>电话</th><th>卡号 / 卡种</th><th>详情</th><th>提醒内容</th><th>生成时间</th><th>操作</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td><span className={`badge ${TYPE_CLS[r.type]}`}>{TYPE_TEXT[r.type]}</span></td>
                  <td><Link to={`/members/${r.member_id}`} style={{ color: 'var(--accent)' }}>{r.member_name}</Link></td>
                  <td className="mono muted">{r.phone}</td>
                  <td className="nowrap">{r.card_no}<div className="muted" style={{ fontSize: 12 }}>{r.plan_name}</div></td>
                  <td className="muted" style={{ fontSize: 12.5 }}>
                    {r.card_type === 'count'
                      ? `剩余 ${r.remaining ?? '—'} 次`
                      : `到期 ${fmtDate(r.end_date)}`}
                  </td>
                  <td style={{ maxWidth: 280 }}>{r.message}</td>
                  <td className="muted nowrap">{new Date(r.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="nowrap">
                    {r.status === 'pending' && <>
                      <Link className="btn sm primary" to={`/members/${r.member_id}`}>去续费</Link>
                      <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => setOne(r, 'notified')}>已通知</button>
                      <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => setOne(r, 'ignored')}>忽略</button>
                    </>}
                    {r.status !== 'pending' && <span className="muted">{r.status === 'notified' ? '已通知' : '已忽略'}</span>}
                  </td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={8} className="empty">没有符合条件的提醒 🎉</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
