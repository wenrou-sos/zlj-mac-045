// 会员卡状态刷新 & 提醒生成的公共逻辑
import { query } from './db.js';

// 期限卡到期自动置为 expired；次卡次数为 0 置为 used_up
export async function refreshCardStatuses() {
  await query(`
    UPDATE membership_cards SET status = 'expired'
    WHERE card_type = 'period' AND status = 'active' AND end_date < CURRENT_DATE`);
  await query(`
    UPDATE membership_cards SET status = 'used_up'
    WHERE card_type = 'count' AND status = 'active' AND remaining <= 0`);
  await query(`
    UPDATE membership_cards SET status = 'active'
    WHERE status = 'used_up' AND remaining > 0`);
}

// 根据会员卡现状生成续费/到期提醒（已存在 pending 的不重复生成）
export async function regenerateReminders() {
  await query(`
    INSERT INTO reminders(member_id, card_id, type, message)
    SELECT m.id, c.id, x.type, x.message
    FROM membership_cards c
    JOIN members m ON m.id = c.member_id
    CROSS JOIN LATERAL (
      SELECT
        CASE
          WHEN c.card_type='count' AND c.remaining <= 3 THEN 'low_sessions'
          WHEN c.card_type='period' AND c.end_date < CURRENT_DATE THEN 'expired'
          ELSE 'expiring'
        END AS type,
        CASE
          WHEN c.card_type='count' AND c.remaining <= 3
            THEN '您的「' || c.plan_name || '」仅剩 ' || c.remaining || ' 次，建议及时续费'
          WHEN c.card_type='period' AND c.end_date < CURRENT_DATE
            THEN '您的「' || c.plan_name || '」已到期，请尽快续费'
          ELSE '您的「' || c.plan_name || '」将于 ' || c.end_date || ' 到期，续费可享优惠'
        END AS message
    ) x
    WHERE c.status IN ('active','expired','used_up')
      AND (
        (c.card_type='count' AND c.remaining <= 3)
        OR (c.card_type='period' AND c.end_date <= CURRENT_DATE + INTERVAL '7 days')
      )
      AND NOT EXISTS (
        SELECT 1 FROM reminders r
        WHERE r.card_id = c.id AND r.status = 'pending'
      )`);
}
