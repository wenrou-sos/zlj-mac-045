// API 封装
async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  del: (path) => request(path, { method: 'DELETE' }),
};

// ---- 工具函数 ----
export function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
export function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
export function fmtTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function weekdayCN(d) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(d).getDay()];
}
export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
export function addDaysStr(base, n) {
  const d = new Date(base + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
export function isoAt(dateStr, hh, mm = 0) {
  return new Date(`${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`).toISOString();
}

// 会员卡状态 -> 展示
export const CARD_STATUS = {
  active: { text: '有效', cls: 'ok' },
  expired: { text: '已过期', cls: 'danger' },
  used_up: { text: '已用完', cls: 'warn' },
  frozen: { text: '已冻结', cls: 'muted' },
};
export const BOOKING_STATUS = {
  booked: { text: '已预约', cls: 'info' },
  checked: { text: '已核销', cls: 'ok' },
  canceled: { text: '已取消', cls: 'muted' },
  no_show: { text: '未到店', cls: 'warn' },
};
export const EQUIP_STATUS = {
  normal: { text: '正常', cls: 'ok' },
  maintenance: { text: '维修中', cls: 'warn' },
  scrapped: { text: '已报废', cls: 'muted' },
};
