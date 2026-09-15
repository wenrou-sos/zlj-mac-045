// 认证、角色权限与审计日志
// ------------------------------------------------------------------
// 三个角色：
//   manager     店长 —— 全量权限（改价、退款、整课取消、导出对账、账号管理、查审计）
//   front_desk  前台 —— 开卡/续费/冻结、代客约课、收款、核销；不可改价/退款/导出对账
//   coach       教练 —— 只能看自己的课和排班（数据在 SQL 层按 coach_id 过滤）
//
// 所有权限判断都在服务端中间件完成，前端隐藏按钮仅为体验，
// 绕过页面直接调用接口同样会被 401 / 403 拦截。
import crypto from 'node:crypto';
import { query } from './db.js';

// ---------- 密码哈希（scrypt + 随机盐） ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(String(password), salt, 64);
  const expect = Buffer.from(hash, 'hex');
  return expect.length === h.length && crypto.timingSafeEqual(expect, h);
}

export function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ---------- 登录态校验 ----------
// 支持 Authorization: Bearer <token> 或 X-Auth-Token
export async function authenticate(req, res, next) {
  try {
    const auth = req.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.get('x-auth-token') || '').trim();
    if (!token) return res.status(401).json({ error: '未登录或登录已失效' });

    const r = await query(
      `SELECT s.token, u.id, u.username, u.display_name, u.role, u.coach_id, u.status
       FROM user_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1`, [token]);
    if (r.rows.length === 0) return res.status(401).json({ error: '登录已失效，请重新登录' });

    const user = r.rows[0];
    if (user.status !== 'active') return res.status(403).json({ error: '账号已停用，请联系店长' });
    req.user = user;
    // 异步刷新最后活跃时间即可，不阻塞请求
    query(`UPDATE user_sessions SET last_used_at = now() WHERE token = $1`, [token]).catch(() => {});
    next();
  } catch (e) { next(e); }
}

// 放行白名单（未登录也可访问）
const PUBLIC_PATHS = new Set(['/health', '/auth/login']);
export function authGuard(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  return authenticate(req, res, next);
}

// ---------- 角色 / 权限 ----------
export const ROLE_TEXT = { manager: '店长', front_desk: '前台', coach: '教练' };

// 权限点 -> 允许的角色。新增敏感操作时在此登记，路由用 requirePerm('xxx') 收口
export const PERMISSIONS = {
  dashboard: ['manager', 'front_desk', 'coach'],
  members_view: ['manager', 'front_desk'],
  members_write: ['manager', 'front_desk'],
  cards_view: ['manager', 'front_desk'],
  cards_open: ['manager', 'front_desk'],          // 开卡（收款）
  cards_renew: ['manager', 'front_desk'],         // 续费（收款）
  cards_freeze: ['manager', 'front_desk'],        // 冻结 / 解冻
  cards_price: ['manager'],                        // 改价（仅店长）
  refund: ['manager'],                             // 退款（仅店长）
  classes_view: ['manager', 'front_desk', 'coach'],
  classes_write: ['manager'],                      // 排课
  class_cancel: ['manager'],                       // 整课取消（批量退次）
  bookings_view: ['manager', 'front_desk', 'coach'],
  booking_create: ['manager', 'front_desk'],       // 代客约课
  booking_cancel: ['manager', 'front_desk'],       // 取消预约/退次
  checkins_view: ['manager', 'front_desk'],
  checkin: ['manager', 'front_desk'],              // 核销
  coaches_view: ['manager', 'front_desk'],
  coaches_write: ['manager'],
  schedules_view: ['manager', 'front_desk', 'coach'],
  schedules_write: ['manager'],
  venues_view: ['manager', 'front_desk'],
  venues_write: ['manager'],
  reminders_view: ['manager', 'front_desk'],
  reminders_update: ['manager', 'front_desk'],
  audit_view: ['manager'],
  users_manage: ['manager'],
  reports_view: ['manager'],
  reports_export: ['manager'],                     // 导出对账（仅店长）
};

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '无权限执行此操作' });
    }
    next();
  };
}

export function requirePerm(perm) {
  return requireRole(...(PERMISSIONS[perm] || []));
}

// ---------- 审计日志（只追加） ----------
// q 可以是事务对象 tx（与业务改动在同一事务内提交，业务回滚则审计一并回滚）
export async function writeAudit(q, opts) {
  const {
    user, action, targetType = null, targetId = null, cardNo = null,
    memberId = null, amount = null, detail = {}, req = null, createdAt = null,
  } = opts;
  await q.query(
    `INSERT INTO audit_logs
       (created_at, actor_id, actor_name, actor_role, action, target_type, target_id,
        card_no, member_id, amount, detail, ip, user_agent)
     VALUES (COALESCE($13, now()), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
    [
      user?.id ?? null,
      user?.display_name || '系统',
      user?.role ?? null,
      action, targetType, targetId == null ? null : String(targetId),
      cardNo, memberId, amount,
      JSON.stringify(detail ?? {}),
      req?.ip || null,
      req?.get ? (req.get('user-agent') || '').slice(0, 255) : null,
      createdAt,
    ]
  );
}

// 动作类型中文说明（前端筛选与展示共用）
export const AUDIT_ACTIONS = {
  login: '登录',
  card_open: '开卡',
  card_renew: '续费',
  card_freeze: '冻结/解冻',
  card_price_change: '改价',
  session_refund: '退次',
  booking_create: '代客约课',
  booking_cancel: '取消预约',
  class_cancel: '整课取消',
  checkin: '核销',
  refund: '退款',
  report_export: '导出对账',
  user_manage: '账号管理',
};
