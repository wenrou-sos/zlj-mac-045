// API 封装

// 登录态：角色只能来自服务端会话，前端只保存不透明令牌；任何请求都无法自行声明角色
const TOKEN_KEY = 'gym_token';
const USER_KEY = 'gym_user';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
}
export function setSession({ token, user }) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
// 401 全局回调（App 注册，触发跳转登录）
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export function getRole() { return getUser()?.role || null; }
export function getRoleLabel() { return getUser()?.role_label || getUser()?.display_name || ''; }

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(options.headers || {}),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    if (data?.login_required) { clearSession(); onUnauthorized?.(); }
    throw new Error(data.error || '请先登录');
  }
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
// ---- 日历日期工具（一律按浏览器本地日期，禁止用 toISOString().slice() 造成时区差一天）----
function localISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function todayStr() {
  return localISO(new Date());
}
export function addDaysStr(base, n) {
  const d = new Date(base + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localISO(d);
}
// 把「本地日历日期 + 小时」转成 ISO（带正确的本地时区偏移），用于提交给后端的 TIMESTAMPTZ
export function isoAt(dateStr, hh, mm = 0) {
  return new Date(`${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`).toISOString();
}
// 在某天某时基础上追加小时数（支持 1.5 这类小数，跨小时/跨日自动进位）
export function isoAddHours(dateStr, hh, addHours) {
  const base = new Date(`${dateStr}T00:00:00`);
  base.setMinutes(hh * 60 + Math.round(addHours * 60));
  return base.toISOString();
}
// 把后端返回的时间戳转成「本地日历日期 YYYY-MM-DD」，用于按天分组
export function localDateOf(d) {
  return localISO(new Date(d));
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

// ---- 报表工具 ----
export function fmtPct(x, digits = 1) {
  if (x === null || x === undefined) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}
export function fmtMoney(x) {
  if (x === null || x === undefined) return '—';
  return `¥${Number(x).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
// 带登录令牌下载 CSV 导出（无令牌或权限不足由后端拒绝）
export async function downloadReport(path) {
  const res = await fetch(`/api${path}`, {
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
  });
  if (res.status === 401) {
    const e = await res.json().catch(() => ({}));
    clearSession(); onUnauthorized?.();
    throw new Error(e.error || '请先登录');
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `导出失败 (${res.status})`);
  }
  const blob = await res.blob();
  const m = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('Content-Disposition') || '');
  const filename = m ? decodeURIComponent(m[1]) : 'export.csv';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
