// 候补队列核心逻辑：
// - fillWaitlist：有名额空缺时，按加入顺序自动递补；会员卡失效/次数不足的会员跳过并记录原因
// - expireWaitlists：已递补但超过确认截止时间未确认的，自动放弃、退次，并继续递补下一位
// - PROMOTE_CONFIRM_MS / PROMOTE_MIN_LEAD_MS：确认时限规则
import { query, withTransaction } from './db.js';

// 候补转正后默认有 2 小时确认时间
export const PROMOTE_CONFIRM_MS = 2 * 3600e3;
// 无论如何，最晚也要在开课前 15 分钟完成确认
export const PROMOTE_MIN_LEAD_MS = 15 * 60e3;

// 选取一张「当前可用于本节课」的会员卡（优先到期早的期限卡，其次次数最多的次卡）
async function pickUsableCard(tx, memberId, costSessions) {
  const r = await tx.query(`
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

const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

// 计算某节课递补后的确认截止时间：min(现在+2小时, 开课-15分钟)
export function computeDeadline(startAt) {
  const byConfirmWindow = new Date(Date.now() + PROMOTE_CONFIRM_MS);
  const byClassStart = new Date(new Date(startAt).getTime() - PROMOTE_MIN_LEAD_MS);
  return byConfirmWindow < byClassStart ? byConfirmWindow : byClassStart;
}

/**
 * 在给定事务内，按顺序尝试把候补会员递补进空缺名额。
 * 规则：
 * - 只处理 status='waiting' 的会员，严格按 joined_at 先后
 * - 会员卡有效且次数够：预扣次数、生成预约、置为 promoted（待确认），产生确认截止时间
 * - 不合格：保留排队资格（仍为 waiting），记录跳过原因，继续尝试后面的人
 * - 直到补满名额或队列耗尽为止
 * 返回本次新递补的人数。
 */
export async function fillWaitlist(tx, classId) {
  const cls = (await tx.query(`SELECT * FROM classes WHERE id=$1 FOR UPDATE`, [classId])).rows[0];
  if (!cls || cls.status !== 'open') return 0;
  // 距开课不足 15 分钟，即使有空缺也不再递补（已没有确认时间）
  if (new Date(cls.start_at).getTime() - Date.now() <= PROMOTE_MIN_LEAD_MS) return 0;

  const vacancies = cls.capacity - (await tx.query(
    `SELECT count(*)::int n FROM bookings WHERE class_id=$1 AND status IN ('booked','checked')`,
    [classId]
  )).rows[0].n;
  if (vacancies <= 0) return 0;

  const queue = (await tx.query(`
    SELECT * FROM waitlists
    WHERE class_id=$1 AND status='waiting'
    ORDER BY joined_at, id
    FOR UPDATE SKIP LOCKED`, [classId])).rows;

  let promoted = 0;
  for (const w of queue) {
    if (promoted >= vacancies) break;

    // 防御：理论上唯一索引已排除，但再确认一次没有有效预约
    const dup = await tx.query(
      `SELECT 1 FROM bookings WHERE class_id=$1 AND member_id=$2 AND status IN ('booked','checked')`,
      [classId, w.member_id]
    );
    if (dup.rows.length > 0) {
      await tx.query(
        `UPDATE waitlists SET last_attempt_at=now(), skip_reason='已存在有效预约' WHERE id=$1`,
        [w.id]
      );
      continue;
    }

    const card = await pickUsableCard(tx, w.member_id, cls.cost_sessions);
    if (!card) {
      const reason = '会员卡已过期/冻结或剩余次数不足，本次跳过';
      await tx.query(
        `UPDATE waitlists SET last_attempt_at=now(), skip_reason=$2 WHERE id=$1`,
        [w.id, reason]
      );
      continue;
    }

    // 次卡预扣课次
    if (card.card_type === 'count') {
      await tx.query(`UPDATE membership_cards SET remaining = remaining - $2 WHERE id=$1`,
        [card.id, cls.cost_sessions]);
    }

    let code;
    for (let i = 0; i < 10; i++) {
      code = genCode();
      const exists = await tx.query(`SELECT 1 FROM bookings WHERE verify_code=$1`, [code]);
      if (exists.rows.length === 0) break;
    }

    const ins = await tx.query(
      `INSERT INTO bookings(class_id, member_id, card_id, verify_code, source)
       VALUES($1,$2,$3,$4,'waitlist') RETURNING *`,
      [classId, w.member_id, card.id, code]
    );

    await tx.query(
      `UPDATE waitlists
       SET status='promoted', promoted_at=now(), confirm_deadline=$2,
           booking_id=$3, card_id=$4, skip_reason=NULL,
           result_note='候补转正成功，请在截止时间前确认'
       WHERE id=$1`,
      [w.id, computeDeadline(cls.start_at), ins.rows[0].id, card.id]
    );
    promoted++;
  }
  return promoted;
}

/**
 * 过期/结课清理：
 * 1) promoted 且超过确认截止时间：预约取消、退还预扣次数、候补置 expired，并对该课继续递补
 * 2) waiting 且课程已开课：置 expired（课程开始后候补自动失效）
 * 3) 课程已取消的残留候补（兜底）：置 closed
 * 应周期性调用。返回处理统计。
 */
export async function expireWaitlists() {
  const overdue = await query(`
    SELECT w.id, w.class_id, b.card_id, cl.cost_sessions
    FROM waitlists w
    JOIN classes cl ON cl.id = w.class_id
    LEFT JOIN bookings b ON b.id = w.booking_id
    WHERE w.status='promoted' AND w.confirm_deadline <= now()`);

  for (const row of overdue.rows) {
    await withTransaction(async (tx) => {
      // 行锁再判一次，避免和用户「确认」并发
      const w = (await tx.query(`SELECT * FROM waitlists WHERE id=$1 FOR UPDATE`, [row.id])).rows[0];
      if (!w || w.status !== 'promoted' || new Date(w.confirm_deadline) > new Date()) return;

      if (w.booking_id) {
        const b = (await tx.query(`SELECT * FROM bookings WHERE id=$1 FOR UPDATE`, [w.booking_id])).rows[0];
        if (b && b.status === 'booked') {
          await tx.query(
            `UPDATE bookings SET status='canceled', canceled_at=now(),
             cancel_reason='候补转正后逾期未确认，自动放弃' WHERE id=$1`,
            [b.id]
          );
          if (b.card_id) {
            await tx.query(
              `UPDATE membership_cards SET remaining = LEAST(COALESCE(remaining,0) + $2, total_sessions)
               WHERE id=$1 AND remaining IS NOT NULL`,
              [b.card_id, row.cost_sessions]
            );
          }
        }
      }
      await tx.query(
        `UPDATE waitlists SET status='expired', closed_at=now(),
         result_note='逾期未确认，自动放弃名额（已退还预扣次数）' WHERE id=$1`,
        [row.id]
      );
      // 空出名额，继续递补队列里的下一位
      await fillWaitlist(tx, row.class_id);
    });
  }

  // 课程开始后仍在排队的候补自动失效（未预扣次数，无需退次）
  await query(`
    UPDATE waitlists w
    SET status='expired', closed_at=now(),
        result_note=COALESCE(result_note, '课程已开始，候补自动失效')
    FROM classes cl
    WHERE w.class_id=cl.id AND w.status='waiting' AND cl.start_at <= now()`);

  return { expired: overdue.rows.length };
}
