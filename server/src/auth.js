// 服务端登录认证：
// - 密码 scrypt 加盐哈希，不存明文
// - 登录成功生成高熵随机令牌（不透明 token，本身不含角色），哈希后落库
// - 每个请求拿令牌换会话 → 实时读取 staff_users.role，因此伪造请求头无法提权
import crypto from 'node:crypto';
import { query } from './db.js';

const TOKEN_TTL_HOURS = 12;

export const ROLE_LABEL = { front_desk: '前台', manager: '店长', investor: '投资人' };
const VALID_ROLES = new Set(['front_desk', 'manager', 'investor']);

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384 }, (err, derived) => {
      if (err) reject(err); else resolve(derived.toString('hex'));
    });
  });
}
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// 确保演示账号存在（幂等）
export async function ensureStaffUsers() {
  const seed = [
    ['front', '前台-小芳', 'front_desk', 'front123'],
    ['manager', '店长-老周', 'manager', 'manager123'],
    ['investor', '投资人-吴总', 'investor', 'investor123'],
  ];
  for (const [username, display_name, role, pwd] of seed) {
    const exists = await query(`SELECT 1 FROM staff_users WHERE username=$1`, [username]);
    if (exists.rows.length) continue;
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await hashPassword(pwd, salt);
    await query(
      `INSERT INTO staff_users(username, display_name, role, password_hash, password_salt)
       VALUES($1,$2,$3,$4,$5)`,
      [username, display_name, role, hash, salt]);
  }
}

export async function login(username, password) {
  const u = (await query(`SELECT * FROM staff_users WHERE username=$1 AND status='active'`,
    [String(username || '').trim()])).rows[0];
  // 用户不存在时也做一次等成本计算，降低时序侧信道差异
  const salt = u ? u.password_salt : crypto.randomBytes(16).toString('hex');
  const hash = await hashPassword(String(password || ''), salt);
  if (!u || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.password_hash, 'hex'))) {
    throw Object.assign(new Error('账号或密码错误'), { status: 401 });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256(token);
  await query(
    `INSERT INTO login_sessions(token_hash, staff_id, expires_at)
     VALUES($1,$2, now() + ($3 || ' hours')::interval)`,
    [tokenHash, u.id, String(TOKEN_TTL_HOURS)]);
  return {
    token,
    user: { username: u.username, display_name: u.display_name, role: u.role },
    expires_in_hours: TOKEN_TTL_HOURS,
  };
}

export async function logout(token) {
  if (!token) return;
  await query(`UPDATE login_sessions SET revoked=TRUE WHERE token_hash=$1`, [sha256(token)]);
}

// 用令牌换当前用户；无效/过期/已撤销返回 null
export async function authenticateToken(token) {
  if (!token) return null;
  const r = await query(`
    SELECT s.expires_at, s.revoked, u.id, u.username, u.display_name, u.role, u.status
    FROM login_sessions s
    JOIN staff_users u ON u.id = s.staff_id
    WHERE s.token_hash=$1`, [sha256(token)]);
  const row = r.rows[0];
  if (!row || row.revoked || row.status !== 'active' || new Date(row.expires_at) < new Date()) return null;
  return { id: row.id, username: row.username, display_name: row.display_name, role: row.role };
}

// Express 中间件：把当前登录用户挂到 req.user；显式带旧的 X-User-Role 头视为伪造并拒绝
export function attachUser(req, _res, next) {
  if (req.get('X-User-Role')) {
    return next(Object.assign(new Error('角色不能由客户端声明，请使用登录令牌'), { status: 403 }));
  }
  const auth = req.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  authenticateToken(token)
    .then((user) => { req.user = user; next(); })
    .catch(() => { req.user = null; next(); });
}

// 必须登录；roles 给定时限定角色
export function requireAuth(roles) {
  const allow = roles ? new Set(roles) : null;
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '请先登录', login_required: true });
    if (allow && (!VALID_ROLES.has(req.user.role) || !allow.has(req.user.role))) {
      return res.status(403).json({ error: '当前账号无权执行该操作' });
    }
    next();
  };
}
