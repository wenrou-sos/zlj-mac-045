// 候补递补逻辑：空位释放时按排队顺序补位，递补前重新校验场地可用性
import { query } from './db.js';
import { venueAvailabilityBlock } from './venueAvailability.js';

const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

// 选一张可用卡（优先到期早的期限卡，其次到期早的次卡），与约课口径一致
export async function pickUsableCard(q, memberId, costSessions) {
  const r = await q(`
    SELECT * FROM membership_cards
    WHERE member_id=$1 AND status='active'
      AND (end_date IS NULL OR end_date >= CURRENT_DATE)
      AND (remaining IS NULL OR remaining >= $2)
    ORDER BY
      CASE WHEN card_type='period' THEN 0 ELSE 1 END,
      end_date ASC NULLS LAST
    LIMIT 1`, [memberId, costSessions]);
  return r.rows[0] || null;
}

export async function genUniqueVerifyCode(q) {
  for (let i = 0; i < 10; i++) {
    const code = genCode();
    const exists = await q(`SELECT 1 FROM bookings WHERE verify_code=$1`, [code]);
    if (exists.rows.length === 0) return code;
  }
  return genCode();
}

// 尝试为某节课递补一位候补会员。
// 返回 null（无需递补）或 { promoted, note }；场地不可用时不会递补并说明原因。
export async function promoteWaitlist(q, classId) {
  const cls = (await q(`SELECT * FROM classes WHERE id=$1 FOR UPDATE`, [classId])).rows[0];
  if (!cls || cls.status !== 'open') return null;
  if (new Date(cls.start_at) < new Date()) return null;
  const booked = (await q(
    `SELECT count(*)::int n FROM bookings WHERE class_id=$1 AND status IN ('booked','checked')`,
    [classId]
  )).rows[0].n;
  if (booked >= cls.capacity) return null;

  // 按生效后的场地可用性判断：整停 / 一次性区间 / 每周固定任一命中都不递补
  if (cls.venue_id) {
    const block = await venueAvailabilityBlock(cls.venue_id, cls.start_at, cls.end_at, q);
    if (block) return { promoted: null, note: `未递补：${block.reason}` };
  }

  const waiting = await q(
    `SELECT w.*, m.name AS member_name
     FROM waitlists w JOIN members m ON m.id=w.member_id
     WHERE w.class_id=$1 AND w.status='waiting'
     ORDER BY w.created_at, w.id
     FOR UPDATE OF w`,
    [classId]
  );
  for (const w of waiting.rows) {
    // 排队期间可能已自行约上，跳过
    const dup = await q(
      `SELECT 1 FROM bookings WHERE class_id=$1 AND member_id=$2 AND status IN ('booked','checked')`,
      [classId, w.member_id]
    );
    if (dup.rows.length > 0) {
      await q(`UPDATE waitlists SET status='failed', resolved_at=now(), note='该会员已有有效预约' WHERE id=$1`, [w.id]);
      continue;
    }
    const card = await pickUsableCard(q, w.member_id, cls.cost_sessions);
    if (!card) {
      await q(`UPDATE waitlists SET status='failed', resolved_at=now(), note='无可用会员卡（已过期或次数不足）' WHERE id=$1`, [w.id]);
      continue;
    }
    if (card.card_type === 'count') {
      await q(`UPDATE membership_cards SET remaining = remaining - $2 WHERE id=$1`, [card.id, cls.cost_sessions]);
    }
    const code = await genUniqueVerifyCode(q);
    const ins = await q(
      `INSERT INTO bookings(class_id, member_id, card_id, verify_code) VALUES($1,$2,$3,$4) RETURNING *`,
      [classId, w.member_id, card.id, code]
    );
    await q(`UPDATE waitlists SET status='promoted', resolved_at=now(), note='已递补为正式预约' WHERE id=$1`, [w.id]);
    return {
      promoted: { member_id: w.member_id, member_name: w.member_name, booking_id: ins.rows[0].id, verify_code: code },
      note: null,
    };
  }
  return { promoted: null, note: '候补队列中没有可递补的会员' };
}
