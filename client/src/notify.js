// 轻量提示：notify('成功', 'success') / notify('失败原因', 'error')
const listeners = new Set();

export function notify(message, type = 'info') {
  listeners.forEach((fn) => fn(message, type));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
