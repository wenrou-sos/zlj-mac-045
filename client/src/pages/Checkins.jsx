import { useEffect, useRef, useState } from 'react';
import { api, fmtTime } from '../api.js';
import { notify } from '../notify.js';

export default function Checkins() {
  const [code, setCode] = useState('');
  const [result, setResult] = useState(null);
  const [list, setList] = useState([]);
  const inputRef = useRef();

  const loadToday = () => api.get('/checkins/today').then(setList);
  useEffect(() => { loadToday(); inputRef.current?.focus(); }, []);

  async function verify() {
    if (!code.trim()) return;
    try {
      const r = await api.post('/checkins/verify', { code: code.trim() });
      setResult({ ok: true, ...r });
      notify(`${r.member_name} 核销成功`, 'success');
      setCode('');
      loadToday();
    } catch (e) {
      setResult({ ok: false, error: e.message });
      notify(e.message, 'error');
    }
    inputRef.current?.focus();
  }

  async function manualCheck(b) {
    try {
      await api.post(`/checkins/${b.id}/check`);
      notify('核销成功', 'success');
      loadToday();
    } catch (e) { notify(e.message, 'error'); }
  }

  const counts = {
    booked: list.filter((x) => x.status === 'booked').length,
    checked: list.filter((x) => x.status === 'checked').length,
    canceled: list.filter((x) => x.status === 'canceled').length,
  };

  return (
    <div>
      <div className="page-title">到店核销</div>
      <div className="page-sub">输入会员预约时生成的 6 位核销码，开课前 2 小时内可核销</div>

      <div className="panel verify-box">
        <h3>🔎 输入核销码</h3>
        <input
          ref={inputRef}
          className="verify-input"
          value={code}
          maxLength={6}
          placeholder="000000"
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && verify()}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button className="btn primary" style={{ flex: 1 }} onClick={verify}>核销</button>
          <button className="btn" onClick={() => { setCode(''); setResult(null); inputRef.current?.focus(); }}>清空</button>
        </div>
        {result && (
          <div className={`verify-result ${result.ok ? 'ok' : 'err'}`}>
            {result.ok ? (
              <>
                <div>✅ 核销成功</div>
                <div className="big">{result.member_name} · {result.title}</div>
                <div className="muted">{result.venue_name} · {new Date(result.start_at).toLocaleString('zh-CN')} · {result.plan_name}</div>
              </>
            ) : <>❌ {result.error}</>}
          </div>
        )}
      </div>

      <div className="panel">
        <h3>📋 今日预约列表
          <span style={{ marginLeft: 'auto', fontWeight: 400, fontSize: 12.5 }} className="muted">
            待核销 <b style={{ color: 'var(--warn)' }}>{counts.booked}</b> ·
            已核销 <b style={{ color: 'var(--ok)' }}>{counts.checked}</b> ·
            已取消 {counts.canceled}
          </span>
        </h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>核销码</th><th>会员</th><th>电话</th><th>课程</th><th>场地</th><th>时间</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id}>
                  <td className="code-chip">{b.verify_code}</td>
                  <td>{b.member_name}</td>
                  <td className="muted">{b.phone}</td>
                  <td>{b.title}</td>
                  <td className="muted">{b.venue_name}</td>
                  <td>{fmtTime(b.start_at)}</td>
                  <td>
                    <span className={`badge ${b.status === 'checked' ? 'ok' : b.status === 'booked' ? 'info' : 'muted'}`}>
                      {b.status === 'checked' ? '已核销' : b.status === 'booked' ? '待核销' : '已取消'}
                    </span>
                  </td>
                  <td>
                    {b.status === 'booked' && <button className="btn sm primary" onClick={() => manualCheck(b)}>手动核销</button>}
                    {b.status === 'checked' && <span className="muted" style={{ fontSize: 12 }}>{fmtTime(b.checked_at)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
