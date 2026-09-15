import { useEffect, useState } from 'react';
import { api } from '../api.js';

// 常驻「统计口径」面板：取消课 / 未到店 / 退款怎么算，全部写在页面上
const RULES = [
  { k: '上座率', v: '核销人次 ÷ 有效预约人次。有效预约 = 已核销 + 未到店（两者都真实占座）。' },
  { k: '满员率', v: '满员课节数 ÷ 实际开课课节数；满员课 = 有效预约人次 ≥ 课程容量。' },
  { k: '座位利用率', v: '有效预约人次 ÷ 开课座位总数（开课座位 = 各实际开课课节容量之和）。' },
  { k: '整课取消', v: '不计入实际开课、不进任何分母，单列为「取消课节」；其下预约一律不算有效预约，系统已退次。' },
  { k: '会员取消预约', v: '含开课前 ≥2 小时免费取消与不足 2 小时的临期取消（不退次），均不占座、不计上座率，单列「会员取消」。' },
  { k: '未到店', v: '课程结束仍未核销的预约自动转为未到店；占座、计入有效预约（分母），但不计核销（分子）。' },
  { k: '新增会员', v: '按会员档案入会日期（joined_at）落在区间内统计。' },
  { k: '流失会员', v: '无任何有效卡，且最近一次到店/开卡/续费满 30 天，记为流失（以巡检判定日落流失日）；续费或重新开卡自动取消流失。' },
  { k: '卡销量 / 续费', v: '新开卡按开卡时间统计张数与金额；续费按续费时间统计笔数与金额。' },
  { k: '退款 / 净收入', v: '退款以独立退款流水为准（分新开卡退款、续费退款）。净收入 = 新开卡金额 + 续费金额 − 退款金额。' },
  { k: '时间口径', v: '一律按业务时区（东八区）日历日归属；当天数据实时统计，已结束日期走日级汇总。' },
  { k: '历史冻结', v: '周/月结束满 3 天可结账冻结，冻结后永久保留当时口径版本的数据；之后口径升级只影响新期间。' },
];

export default function CaliberPanel({ version }) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState([]);

  useEffect(() => {
    api.get('/reports/caliber').then((d) => setVersions(d.versions || [])).catch(() => {});
  }, []);

  return (
    <div className="panel caliber-panel">
      <h3 className="caliber-head" onClick={() => setOpen((o) => !o)} style={{ cursor: 'pointer' }}>
        📐 统计口径说明
        <span className="tag" style={{ marginLeft: 10 }}>当前版本 v{version || versions[0]?.version || 1}</span>
        <span style={{ marginLeft: 'auto' }} className="muted">{open ? '收起 ▲' : '展开查看取消课 / 未到店 / 退款等规则 ▼'}</span>
      </h3>
      {open && (
        <>
          <div className="caliber-grid">
            {RULES.map((r) => (
              <div key={r.k} className="caliber-item">
                <div className="caliber-k">{r.k}</div>
                <div className="caliber-v">{r.v}</div>
              </div>
            ))}
          </div>
          {versions.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>口径版本历史（规则改动只增不改，旧快照绑定旧版本）</div>
              {versions.map((v) => (
                <div key={v.version} className="caliber-version">
                  <span className="badge ok">v{v.version}</span>
                  <span className="muted" style={{ margin: '0 8px', fontSize: 12 }}>{String(v.published_at).slice(0, 16).replace('T', ' ')}</span>
                  <span style={{ fontSize: 12.5 }}>{v.note}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
