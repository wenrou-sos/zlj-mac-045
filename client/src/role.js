// 当前登录角色（演示用：manager 店长 / frontdesk 前台），持久化到 localStorage。
// 真实环境应由登录态/网关注入。
import { useSyncExternalStore } from 'react';

const KEY = 'powergym_role';
const listeners = new Set();

export function getRole() {
  return localStorage.getItem(KEY) === 'manager' ? 'manager' : 'frontdesk';
}
export function setRole(role) {
  localStorage.setItem(KEY, role === 'manager' ? 'manager' : 'frontdesk');
  listeners.forEach((fn) => fn());
}
export function isManager() {
  return getRole() === 'manager';
}

export function useRole() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    getRole,
    getRole
  );
}

export const ROLE_LABEL = { manager: '店长', frontdesk: '前台' };
