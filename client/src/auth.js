// 前端登录态：token 存 localStorage，api.js 请求时带上；401 自动回到登录页
import { api } from './api.js';

const TOKEN_KEY = 'powergym_token';
const USER_KEY = 'powergym_user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
}

const listeners = new Set();
function emit() { listeners.forEach((fn) => fn(getUser())); }

export function subscribeAuth(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function login(username, password) {
  const r = await api.post('/auth/login', { username, password });
  localStorage.setItem(TOKEN_KEY, r.token);
  localStorage.setItem(USER_KEY, JSON.stringify(r.user));
  emit();
  return r.user;
}

export function logoutLocal() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  emit();
}

export async function logout() {
  try { await api.post('/auth/logout', {}); } catch { /* 忽略网络错误，本地照样清 */ }
  logoutLocal();
}

// 与服务端 PERMISSIONS 保持一致（仅用于界面显隐；真正拦截在后端）
const FRONT_PERMS = {
  manager: new Set(['dashboard', 'members_view', 'members_write', 'cards_view', 'cards_open',
    'cards_renew', 'cards_freeze', 'cards_price', 'refund', 'classes_view', 'classes_write',
    'class_cancel', 'bookings_view', 'booking_create', 'booking_cancel', 'checkins_view', 'checkin',
    'coaches_view', 'coaches_write', 'schedules_view', 'schedules_write', 'venues_view', 'venues_write',
    'reminders_view', 'reminders_update', 'audit_view', 'users_manage', 'reports_view', 'reports_export']),
  front_desk: new Set(['dashboard', 'members_view', 'members_write', 'cards_view', 'cards_open',
    'cards_renew', 'cards_freeze', 'classes_view', 'bookings_view', 'booking_create', 'booking_cancel',
    'checkins_view', 'checkin', 'coaches_view', 'schedules_view', 'venues_view',
    'reminders_view', 'reminders_update']),
  coach: new Set(['dashboard', 'classes_view', 'bookings_view', 'schedules_view']),
};

export function can(perm) {
  const u = getUser();
  return !!u && (FRONT_PERMS[u.role]?.has(perm) ?? false);
}

export const ROLE_TEXT = { manager: '店长', front_desk: '前台', coach: '教练' };
