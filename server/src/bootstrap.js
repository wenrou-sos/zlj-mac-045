// 启动引导：
// 1. 保证内置账号存在（店长 / 前台 / 六个教练），可重复执行不覆盖已改密码
// 2. 教练账号按姓名挂接到 coaches 档案（教练登录后只能看到自己的课/排班）
// 3. 把升级前的历史续费记录挂到对应操作员账号，并补写审计轨迹（只追加、幂等）
import { query } from './db.js';
import { hashPassword } from './auth.js';

const DEFAULT_USERS = [
  { username: 'manager', display_name: '周店长', role: 'manager', password: () => process.env.MANAGER_PASSWORD || 'manager123' },
  { username: 'front', display_name: '林前台', role: 'front_desk', password: () => process.env.FRONT_PASSWORD || 'front123' },
  { username: 'coach1', display_name: '王磊', role: 'coach', password: () => process.env.COACH_PASSWORD || 'coach123' },
  { username: 'coach2', display_name: '李静', role: 'coach', password: () => process.env.COACH_PASSWORD || 'coach123' },
  { username: 'coach3', display_name: '张猛', role: 'coach', password: () => process.env.COACH_PASSWORD || 'coach123' },
  { username: 'coach4', display_name: '刘芳', role: 'coach', password: () => process.env.COACH_PASSWORD || 'coach123' },
  { username: 'coach5', display_name: '陈晨', role: 'coach', password: () => process.env.COACH_PASSWORD || 'coach123' },
  { username: 'coach6', display_name: '赵宇', role: 'coach', password: () => process.env.COACH_PASSWORD || 'coach123' },
];

// 幂等建账号：已存在的账号不动（不覆盖店长改过的密码 / 状态）
export async function ensureDefaultUsers() {
  for (const u of DEFAULT_USERS) {
    const exists = await query(`SELECT 1 FROM users WHERE username=$1`, [u.username]);
    if (exists.rows.length === 0) {
      await query(
        `INSERT INTO users(username, display_name, password_hash, role)
         VALUES($1,$2,$3,$4)`,
        [u.username, u.display_name, hashPassword(u.password()), u.role]
      );
    }
  }
}

// 教练账号按「显示名 = 教练姓名」挂接 coach_id
export async function linkCoachAccounts() {
  await query(`
    UPDATE users u SET coach_id = c.id
    FROM coaches c
    WHERE u.role='coach' AND u.coach_id IS NULL AND u.display_name = c.name`);
}

// 历史续费记录迁移：
//  - renewals.operator 文本能对上 users.display_name 的，挂接 operator_id
//  - 每条续费若没有对应审计记录（target_type='renewal'），补写一条 card_renew 审计，
//    时间沿用续费时间；操作人对不上的记为「历史操作员」，actor_id 留空
export async function backfillRenewalAudit() {
  // 1) 挂账号
  await query(`
    UPDATE renewals r SET operator_id = u.id
    FROM users u
    WHERE r.operator_id IS NULL AND r.operator = u.display_name`);

  // 2) 幂等补审计（已补过的续费不再重复写）
  const rows = (await query(`
    SELECT r.id, r.card_id, r.member_id, r.amount, r.new_end_date, r.added_sessions,
           r.renewed_at, r.operator, r.operator_id,
           c.card_no, c.plan_name, c.card_type
    FROM renewals r
    LEFT JOIN membership_cards c ON c.id = r.card_id
    WHERE NOT EXISTS (
      SELECT 1 FROM audit_logs a
      WHERE a.target_type='renewal' AND a.target_id = r.id::text
    )`)).rows;

  for (const r of rows) {
    await query(
      `INSERT INTO audit_logs
         (created_at, actor_id, actor_name, actor_role, action, target_type, target_id,
          card_no, member_id, amount, detail, ip, user_agent)
       VALUES ($1,$2,$3,$4,'card_renew','renewal',$5,$6,$7,$8,$9::jsonb,NULL,'system-migration')`,
      [
        r.renewed_at,
        r.operator_id ?? null,
        r.operator || '历史操作员',
        null,
        String(r.id), r.card_no, r.member_id, r.amount,
        JSON.stringify({
          historical: true,
          migrated: true,
          plan_name: r.plan_name,
          card_type: r.card_type,
          new_end_date: r.new_end_date,
          added_sessions: r.added_sessions,
          note: '升级前历史续费记录，系统迁移补录',
        }),
      ]
    );
  }
  return rows.length;
}

export async function bootstrapAfterSchema() {
  await ensureDefaultUsers();
}
