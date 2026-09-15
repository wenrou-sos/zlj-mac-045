// 极简角色控制：登录态未接入前，由请求头 X-Role 携带当前角色（manager 店长 / frontdesk 前台）。
// 缺省按前台处理（最小权限）。真实环境应由鉴权中间件解析出 req.role。
export function roleOf(req) {
  return req.headers['x-role'] === 'manager' ? 'manager' : 'frontdesk';
}

// 仅店长可写（维护标签、分群、生成待跟进）
export function requireManager(req, res, next) {
  if (roleOf(req) !== 'manager') {
    return res.status(403).json({ error: '仅店长可执行该操作' });
  }
  next();
}
