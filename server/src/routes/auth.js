import { Router } from 'express';
import { query } from '../db.js';
import {
  hashPassword, verifyPassword, genToken, authenticate, requirePerm,
  writeAudit, ROLE_TEXT,
} from '../auth.js';

const router = Router();

// 登录（公开接口）
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });

    const r = await query(`SELECT * FROM users WHERE username=$1`, [username.trim()]);
    const u = r.rows[0];
    // 不区分「账号不存在」和「密码错误」，避免账号枚举
    if (!u || !verifyPassword(password, u.password_hash)) {
      return res.status(401).json({ error: '账号或密码错误' });
    }
    if (u.status !== 'active') return res.status(403).json({ error: '账号已停用，请联系店长' });

    const token = genToken();
    await query(
      `INSERT INTO user_sessions(token, user_id, user_agent) VALUES($1,$2,$3)`,
      [token, u.id, (req.get('user-agent') || '').slice(0, 255)]
    );
    // 登录动作同样入审计
    await writeAudit(query, { user: u, action: 'login', targetType: 'user', targetId: u.id, req });

    res.json({
      token,
      user: {
        id: u.id, username: u.username, display_name: u.display_name,
        role: u.role, role_text: ROLE_TEXT[u.role], coach_id: u.coach_id,
      },
    });
  } catch (e) { next(e); }
});

// 退出登录
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    const token = (req.get('authorization') || '').replace('Bearer ', '');
    await query(`DELETE FROM user_sessions WHERE token=$1`, [token]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 当前登录人信息
router.get('/me', authenticate, async (req, res) => {
  const u = req.user;
  res.json({
    id: u.id, username: u.username, display_name: u.display_name,
    role: u.role, role_text: ROLE_TEXT[u.role], coach_id: u.coach_id,
  });
});

// 修改自己的密码
router.put('/me/password', authenticate, async (req, res, next) => {
  try {
    const { old_password, new_password } = req.body || {};
    if (!new_password || String(new_password).length < 6) {
      return res.status(400).json({ error: '新密码至少 6 位' });
    }
    const r = await query(`SELECT password_hash FROM users WHERE id=$1`, [req.user.id]);
    if (!verifyPassword(old_password || '', r.rows[0].password_hash)) {
      return res.status(400).json({ error: '原密码不正确' });
    }
    await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hashPassword(new_password), req.user.id]);
    await writeAudit(query, { user: req.user, action: 'user_manage', targetType: 'user', targetId: req.user.id, detail: { op: 'change_own_password' }, req });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ============ 账号管理（仅店长） ============

// 账号列表（不返回密码）
router.get('/users', authenticate, requirePerm('users_manage'), async (req, res, next) => {
  try {
    const r = await query(`
      SELECT u.id, u.username, u.display_name, u.role, u.coach_id, u.status, u.created_at,
             c.name AS coach_name,
             (SELECT max(last_used_at) FROM user_sessions s WHERE s.user_id=u.id) AS last_login_at
      FROM users u LEFT JOIN coaches c ON c.id=u.coach_id
      ORDER BY u.id`);
    res.json(r.rows.map((u) => ({ ...u, role_text: ROLE_TEXT[u.role] })));
  } catch (e) { next(e); }
});

// 新建账号
router.post('/users', authenticate, requirePerm('users_manage'), async (req, res, next) => {
  try {
    const { username, display_name, password, role, coach_id } = req.body || {};
    if (!username || !display_name || !password || !role) {
      return res.status(400).json({ error: '账号、姓名、密码、角色必填' });
    }
    if (!ROLE_TEXT[role]) return res.status(400).json({ error: '非法角色' });
    if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    let coachId = null;
    if (role === 'coach') {
      coachId = coach_id ? Number(coach_id) : null;
      if (!coachId) return res.status(400).json({ error: '教练账号必须关联教练档案' });
      const c = await query(`SELECT id FROM coaches WHERE id=$1`, [coachId]);
      if (c.rows.length === 0) return res.status(404).json({ error: '教练档案不存在' });
      const dup = await query(`SELECT 1 FROM users WHERE role='coach' AND coach_id=$1`, [coachId]);
      if (dup.rows.length > 0) return res.status(409).json({ error: '该教练已有登录账号' });
    }
    const r = await query(
      `INSERT INTO users(username, display_name, password_hash, role, coach_id)
       VALUES($1,$2,$3,$4,$5) RETURNING id, username, display_name, role, coach_id, status`,
      [username.trim(), display_name, hashPassword(password), role, coachId]
    );
    await writeAudit(query, {
      user: req.user, action: 'user_manage', targetType: 'user', targetId: r.rows[0].id,
      detail: { op: 'create', username: username.trim(), role, coach_id: coachId }, req,
    });
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '登录名已存在' });
    next(e);
  }
});

// 编辑账号（姓名/角色/关联教练/状态/重置密码）
router.put('/users/:id', authenticate, requirePerm('users_manage'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = await query(`SELECT * FROM users WHERE id=$1`, [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: '账号不存在' });
    const before = cur.rows[0];

    const { display_name, role, coach_id, status, password } = req.body || {};
    const nextRole = role || before.role;
    if (!ROLE_TEXT[nextRole]) return res.status(400).json({ error: '非法角色' });

    let nextCoachId = before.coach_id;
    if (nextRole === 'coach' && coach_id !== undefined) {
      nextCoachId = coach_id ? Number(coach_id) : null;
      if (!nextCoachId) return res.status(400).json({ error: '教练账号必须关联教练档案' });
    } else if (nextRole !== 'coach') {
      nextCoachId = null;
    }
    const nextStatus = status || before.status;
    if (!['active', 'disabled'].includes(nextStatus)) return res.status(400).json({ error: '非法状态' });
    // 不能停用自己，避免锁死系统
    if (id === req.user.id && nextStatus === 'disabled') {
      return res.status(400).json({ error: '不能停用当前登录账号' });
    }

    await query(
      `UPDATE users SET display_name=$1, role=$2, coach_id=$3, status=$4 WHERE id=$5`,
      [display_name || before.display_name, nextRole, nextCoachId, nextStatus, id]
    );
    const changes = {
      op: 'update',
      display_name: { from: before.display_name, to: display_name || before.display_name },
      role: { from: before.role, to: nextRole },
      coach_id: { from: before.coach_id, to: nextCoachId },
      status: { from: before.status, to: nextStatus },
    };
    if (password) {
      if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
      await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hashPassword(password), id]);
      changes.reset_password = true;
    }
    if (nextStatus === 'disabled') {
      // 停用即踢下线：清除其全部会话
      await query(`DELETE FROM user_sessions WHERE user_id=$1`, [id]);
    }
    await writeAudit(query, {
      user: req.user, action: 'user_manage', targetType: 'user', targetId: id, detail: changes, req,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 可关联账号的教练档案（供店长建教练账号时选择）
router.get('/coaches-linkable', authenticate, requirePerm('users_manage'), async (req, res, next) => {
  try {
    const r = await query(`
      SELECT c.id, c.name, c.specialty, c.status,
             (SELECT u.id FROM users u WHERE u.coach_id=c.id) AS linked_user_id
      FROM coaches c ORDER BY c.id`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

export default router;
