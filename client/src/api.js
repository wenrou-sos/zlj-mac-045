// API 封装
async function request(path, options = {}) {
  const token = localStorage.getItem('powergym_token') || '';
  const res = await fetch(`/api${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  // 审计导出等接口直接返回 CSV，交给调用方处理
  if (res.headers.get('content-type')?.includes('application/json') !== true && res.ok) {
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // 登录失效：清本地态并跳登录页（登录接口本身的 401 不跳转）
    localStorage.removeItem('powergym_token');
    localStorage.removeItem('powergym_user');
    if (!path.startsWith('/auth/login') && location.pathname !== '/login') {
      location.assign('/login');
    }
    throw new Error(data.error || '请先登录');
  }
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
