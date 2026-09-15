// 分群条件引擎：把前端提交的条件数组转成参数化 SQL。
// 支持的条件（多条之间为 AND）：
//   { field:'card_expiring', days:7 }       期限卡 N 天内到期（未过期、非冻结）
//   { field:'card_expired' }                 存在已过期的卡
//   { field:'low_sessions', sessions:3 }     有效次卡剩余 ≤ N 次
//   { field:'no_visit', days:30 }            最近 N 天无到店核销（含从未到店）
//   { field:'has_tag', tag_id:1 }            拥有指定标签
import { query } from './db.js';

export const CONDITION_FIELDS = {
  card_expiring: { label: '即将到期（天内）', operator: '≤', needValue: 'days' },
  card_expired: { label: '已过期', operator: '', needValue: null },
  low_sessions: { label: '剩余次数 ≤', operator: '≤', needValue: 'sessions' },
  no_visit: { label: '最近未到店（天）', operator: '≥', needValue: 'days' },
  has_tag: { label: '拥有标签', operator: '', needValue: 'tag_id' },
};

// 规整 + 校验单条条件，返回干净的对象；非法则抛 Error
export async function normalizeCondition(c) {
  if (!c || typeof c !== 'object' || !CONDITION_FIELDS[c.field]) {
    throw new Error('存在不支持的分群条件');
  }
  const { field } = c;
  if (field === 'card_expiring') {
    const days = Number(c.days);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('到期天数需为 0~3650 的整数');
    return { field, days };
  }
  if (field === 'card_expired') return { field };
  if (field === 'low_sessions') {
    const sessions = Number(c.sessions);
    if (!Number.isInteger(sessions) || sessions < 0 || sessions > 999) throw new Error('剩余次数需为 0~999 的整数');
    return { field, sessions };
  }
  if (field === 'no_visit') {
    const days = Number(c.days);
    if (!Number.isInteger(days) || days <= 0 || days > 3650) throw new Error('未到店天数需为 1~3650 的整数');
    return { field, days };
  }
  if (field === 'has_tag') {
    const tag_id = Number(c.tag_id);
    if (!Number.isInteger(tag_id)) throw new Error('请选择有效标签');
    const t = await query(`SELECT id FROM tags WHERE id=$1`, [tag_id]);
    if (t.rows.length === 0) throw new Error('所选标签不存在');
    return { field, tag_id };
  }
  throw new Error('存在不支持的分群条件');
}

export async function normalizeConditions(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new Error('至少需要一条分群条件');
  }
  if (conditions.length > 10) throw new Error('分群条件最多 10 条');
  const out = [];
  for (const c of conditions) out.push(await normalizeCondition(c));
  return out;
}

// 构造 WHERE 片段（所有片段均为 EXISTS 子查询，不会让会员行重复）
export function buildWhere(conditions) {
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  const conds = conditions.map((c) => {
    switch (c.field) {
      case 'card_expiring': {
        const p = push(c.days);
        return `EXISTS (SELECT 1 FROM membership_cards x
                 WHERE x.member_id=m.id AND x.card_type='period' AND x.status='active'
                   AND x.end_date >= CURRENT_DATE
                   AND x.end_date <= CURRENT_DATE + (${p} * INTERVAL '1 day'))`;
      }
      case 'card_expired':
        return `EXISTS (SELECT 1 FROM membership_cards x
                 WHERE x.member_id=m.id AND x.status='expired')`;
      case 'low_sessions': {
        const p = push(c.sessions);
        // 含已用完（remaining=0）的次卡；冻结卡不打扰
        return `EXISTS (SELECT 1 FROM membership_cards x
                 WHERE x.member_id=m.id AND x.card_type='count'
                   AND x.status IN ('active','used_up')
                   AND x.remaining <= ${p})`;
      }
      case 'no_visit': {
        const p = push(c.days);
        return `NOT EXISTS (SELECT 1 FROM bookings b
                 JOIN classes cl ON cl.id=b.class_id
                 WHERE b.member_id=m.id AND b.status='checked'
                   AND cl.start_at >= CURRENT_DATE - (${p} * INTERVAL '1 day'))`;
      }
      case 'has_tag': {
        const p = push(c.tag_id);
        return `EXISTS (SELECT 1 FROM member_tags mt
                 WHERE mt.member_id=m.id AND mt.tag_id=${p})`;
      }
      default:
        throw new Error('存在不支持的分群条件');
    }
  });
  return { where: conds.join(' AND '), params };
}

// 会员行附加信息：标签数组、代表卡、最近到店
export const MEMBER_ENRICH_SELECT = `
  COALESCE((
    SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.id)
    FILTER (WHERE t.id IS NOT NULL)
    FROM member_tags mt JOIN tags t ON t.id=mt.tag_id
    WHERE mt.member_id=m.id
  ), '[]'::json) AS tags,
  (
    SELECT x.plan_name || CASE WHEN x.card_type='period'
             THEN '（' || x.end_date::text || ' 到期）'
             ELSE '（剩 ' || x.remaining || ' 次）' END
    FROM membership_cards x
    WHERE x.member_id=m.id
    ORDER BY CASE WHEN x.status='active' THEN 0 ELSE 1 END,
             x.end_date NULLS LAST, x.id DESC
    LIMIT 1
  ) AS card_summary,
  (
    SELECT max(cl.start_at) FROM bookings b
    JOIN classes cl ON cl.id=b.class_id
    WHERE b.member_id=m.id AND b.status='checked'
  ) AS last_visit_at`;

export async function countMembers(conditions) {
  const { where, params } = buildWhere(conditions);
  const r = await query(`SELECT count(*)::int AS n FROM members m WHERE ${where}`, params);
  return r.rows[0].n;
}

export async function findMembers(conditions, limit = 500) {
  const { where, params } = buildWhere(conditions);
  params.push(limit);
  const limitP = `$${params.length}`;
  const r = await query(`
    SELECT m.id, m.name, m.phone, m.gender, m.joined_at, m.note,
           ${MEMBER_ENRICH_SELECT}
    FROM members m
    WHERE ${where}
    ORDER BY m.id
    LIMIT ${limitP}`, params);
  return r.rows;
}
