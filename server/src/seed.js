// 生成本地样例数据（可重复执行：先清空再生成）
import { query } from './db.js';

// 统一按业务时区（默认东八区）取墙上日历日期，避免部署在 UTC 服务器时整体差一天
const APP_TZ = process.env.APP_TZ || 'Asia/Shanghai';
const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
function todayInTz() {
  // en-CA 输出形如 YYYY-MM-DD
  return dateFmt.format(new Date());
}
function dateStr(n) {
  const [y, m, d] = todayInTz().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
// 课程时间统一按业务时区墙上时钟生成（如 19:00 就是本地 19:00）
function classTs(dayOffset, hh, mm = 0) {
  const day = dateStr(dayOffset);
  const H = String(hh).padStart(2, '0');
  const M = String(mm).padStart(2, '0');
  // APP_TZ 默认东八区；非东八区时退化为 UTC 偏移由数据库解释
  const offset = APP_TZ === 'Asia/Shanghai' ? '+08:00' : 'Z';
  return `${day}T${H}:${M}:00${offset}`;
}
function weekdayOf(dayOffset) {
  return new Date(`${dateStr(dayOffset)}T00:00:00+08:00`).getUTCDay();
}
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[randInt(0, arr.length - 1)];

export async function seedData() {
  // 1. 清空
  await query(`TRUNCATE reminders, renewals, bookings, classes, coach_schedules,
    equipment, venues, membership_cards, members, coaches RESTART IDENTITY CASCADE`);

  // 2. 教练
  const coaches = [
    ['王磊', '13800000001', '力量训练/增肌', 300],
    ['李静', '13800000002', '瑜伽/普拉提', 260],
    ['张猛', '13800000003', '动感单车/HIIT', 280],
    ['刘芳', '13800000004', '搏击操', 250],
    ['陈晨', '13800000005', '游泳/水中有氧', 320],
    ['赵宇', '13800000006', '功能性训练', 270],
  ];
  for (const [name, phone, sp, rate] of coaches) {
    await query(
      `INSERT INTO coaches(name, phone, specialty, hourly_rate) VALUES($1,$2,$3,$4)`,
      [name, phone, sp, rate]
    );
  }

  // 3. 会员
  const memberNames = [
    '周杰', '吴敏', '郑爽', '孙浩', '马丽', '朱琳', '胡军', '郭涛',
    '林梅', '何平', '高源', '罗成', '梁静', '宋佳', '谢楠', '韩寒',
    '曹颖', '彭于', '曾轶', '蒋欣',
  ];
  for (let i = 0; i < memberNames.length; i++) {
    await query(
      `INSERT INTO members(name, phone, gender, joined_at, note)
       VALUES($1,$2,$3,$4,$5)`,
      [
        memberNames[i],
        `139${String(10000000 + i).padStart(8, '0')}`,
        pick(['男', '女']),
        dateStr(-randInt(10, 400)),
        i % 5 === 0 ? '老会员' : null,
      ]
    );
  }

  // 4. 会员卡（覆盖各种状态：正常、即将到期、已过期、次数不足、用完）
  // [member_id, card_no, plan, type, price, startOffset, endOffset/null, total/null, remaining, status]
  const cards = [
    [1, 'VIP2026001', '年卡', 'period', 2388, -200, 165, null, null, 'active'],
    [2, 'VIP2026002', '季卡', 'period', 699, -80, 5, null, null, 'active'],   // 即将到期
    [3, 'VIP2026003', '30次卡', 'count', 899, -60, null, 30, 2, 'active'],    // 次数不足
    [4, 'VIP2026004', '月卡', 'period', 268, -40, -10, null, null, 'expired'],
    [5, 'VIP2026005', '50次卡', 'count', 1299, -120, null, 50, 50, 'active'],
    [6, 'VIP2026006', '季卡', 'period', 699, -30, 60, null, null, 'active'],
    [7, 'VIP2026007', '20次卡', 'count', 699, -90, null, 20, 0, 'used_up'],
    [8, 'VIP2026008', '年卡', 'period', 2388, -300, 65, null, null, 'active'],
    [9, 'VIP2026009', '月卡', 'period', 268, -25, 3, null, null, 'active'],   // 即将到期
    [10, 'VIP2026010', '10次卡', 'count', 399, -20, null, 10, 7, 'active'],
    [11, 'VIP2026011', '半年卡', 'period', 1299, -200, -20, null, null, 'expired'],
    [12, 'VIP2026012', '季卡', 'period', 699, -10, 82, null, null, 'active'],
    [13, 'VIP2026013', '30次卡', 'count', 899, -40, null, 30, 12, 'active'],
    [14, 'VIP2026014', '月卡', 'period', 268, -28, -2, null, null, 'expired'],
    [15, 'VIP2026015', '年卡', 'period', 2388, -10, 355, null, null, 'active'],
    [16, 'VIP2026016', '20次卡', 'count', 699, -30, null, 20, 1, 'active'],   // 次数不足
    [17, 'VIP2026017', '月卡', 'period', 268, -5, 25, null, null, 'frozen'],
    [18, 'VIP2026018', '季卡', 'period', 699, -60, 30, null, null, 'active'],
  ];
  for (const c of cards) {
    const [mid, no, plan, type, price, sOff, eOff, total, remaining, status] = c;
    await query(
      `INSERT INTO membership_cards
       (member_id, card_no, plan_name, card_type, price, start_date, end_date, total_sessions, remaining, status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [mid, no, plan, type, price, dateStr(sOff), eOff == null ? null : dateStr(eOff), total, remaining, status]
    );
  }

  // 5. 场地
  const venues = [
    ['动感单车厅', 20, '1楼东侧'],
    ['瑜伽室', 15, '2楼 201'],
    ['综合操厅', 25, '2楼 202'],
    ['自由力量区', 30, '1楼西侧'],
    ['游泳池', 18, 'B1层'],
  ];
  for (const [name, cap, loc] of venues) {
    await query('INSERT INTO venues(name, capacity, location) VALUES($1,$2,$3)', [name, cap, loc]);
  }

  // 6. 器械
  const equipment = [
    [4, '跑步机', 'TM-001', 8, 'normal', -500],
    [4, '史密斯架', 'SM-002', 2, 'normal', -400],
    [4, '卧推凳', 'BE-003', 6, 'maintenance', -300],
    [1, '动感单车', 'BK-010', 20, 'normal', -200],
    [2, '瑜伽垫', 'YM-020', 30, 'normal', -100],
    [3, '搏击沙袋', 'BG-030', 6, 'normal', -150],
    [5, '泳道计时器', 'WT-040', 2, 'scrapped', -600],
    [4, '龙门架', 'CM-005', 2, 'normal', -250],
  ];
  for (const [vid, name, asset, qty, status, pOff] of equipment) {
    await query(
      `INSERT INTO equipment(venue_id, name, asset_no, quantity, status, purchased_at)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [vid, name, asset, qty, status, dateStr(pOff)]
    );
  }

  // 7. 教练排班：最近 7 天 ~ 未来 14 天
  const shifts = [
    ['09:00', '17:00', 'normal'],
    ['13:00', '21:00', 'evening'],
    ['07:00', '12:00', 'morning'],
  ];
  for (let d = -7; d <= 14; d++) {
    for (let coachId = 1; coachId <= 6; coachId++) {
      // 教练每周休息一天（id 偏移）
      if (weekdayOf(d) === (coachId % 7)) continue;
      const [st, et, type] = pick(shifts);
      await query(
        `INSERT INTO coach_schedules(coach_id, work_date, start_time, end_time, shift_type)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [coachId, dateStr(d), st, et, type]
      );
    }
  }

  // 8. 课表：过去 5 天 ~ 未来 10 天，每天 3~5 节
  // [课程, 教练, 场地, 容量, 消耗课次]
  const classTemplates = [
    ['动感单车', 3, 1, 20, 1], ['阴瑜伽', 2, 2, 15, 1], ['晨间 HIIT', 3, 3, 20, 1],
    ['搏击操', 4, 3, 20, 1], ['自由力量进阶', 1, 4, 12, 2], ['核心普拉提', 2, 2, 15, 2],
    ['功能性训练', 6, 3, 16, 1], ['水中有氧', 5, 5, 18, 1], ['杠铃塑形', 1, 4, 12, 1],
  ];
  const hours = [9, 10, 14, 16, 19];
  const classIds = [];
  for (let d = -5; d <= 10; d++) {
    const count = randInt(3, 5);
    const chosenHours = [...hours].sort(() => Math.random() - 0.5).slice(0, count).sort((a, b) => a - b);
    for (const h of chosenHours) {
      const [title, coachId, venueId, cap, cost] = pick(classTemplates);
      const r = await query(
        `INSERT INTO classes(title, coach_id, venue_id, start_at, end_at, capacity, cost_sessions, status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [title, coachId, venueId, classTs(d, h), classTs(d, h + 1), cap, cost, d < -1 ? 'finished' : 'open']
      );
      classIds.push(r.rows[0].id);
    }
  }
  // 随机取消一节课（未来）
  const futureClasses = classIds.slice(-10);
  await query(`UPDATE classes SET status='canceled' WHERE id = $1`, [pick(futureClasses)]);

  // 9. 预约：给每节课随机 0~80% 上座率；过去的课大部分已核销
  const memberIds = Array.from({ length: 18 }, (_, i) => i + 1);
  const usedCodes = new Set();
  for (const classId of classIds) {
    const clsRes = await query('SELECT start_at, capacity, cost_sessions, status FROM classes WHERE id=$1', [classId]);
    const cls = clsRes.rows[0];
    if (cls.status === 'canceled') continue;
    const cost = cls.cost_sessions;
    const isPast = new Date(cls.start_at) < new Date();
    const n = Math.min(cls.capacity, randInt(0, Math.floor(cls.capacity * 0.8)));
    const shuffled = [...memberIds].sort(() => Math.random() - 0.5).slice(0, n);
    for (const memberId of shuffled) {
      // 取该会员一张有效且次数够的卡（次卡按 cost 扣次）
      const cardRes = await query(
        `SELECT id FROM membership_cards
         WHERE member_id=$1 AND status='active'
           AND (end_date IS NULL OR end_date >= CURRENT_DATE)
           AND (remaining IS NULL OR remaining >= $2)
         LIMIT 1`,
        [memberId, cost]
      );
      if (cardRes.rows.length === 0) continue;
      const cardId = cardRes.rows[0].id;
      // 次卡模拟已扣次（按课程消耗课次）
      await query(
        `UPDATE membership_cards SET remaining = GREATEST(remaining - $2, 0)
         WHERE id=$1 AND remaining IS NOT NULL`,
        [cardId, cost]
      );
      let code;
      do { code = String(randInt(100000, 999999)); } while (usedCodes.has(code));
      usedCodes.add(code);

      let status = 'booked';
      let checkedAt = null;
      if (isPast && Math.random() < 0.85) {
        status = 'checked';
        checkedAt = new Date(new Date(cls.start_at).getTime() - 10 * 60000).toISOString();
      } else if (isPast && Math.random() < 0.5) {
        status = 'no_show';
      } else if (!isPast && Math.random() < 0.12) {
        status = 'canceled';
      }
      try {
        await query(
          `INSERT INTO bookings(class_id, member_id, card_id, verify_code, status, checked_at, canceled_at)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [classId, memberId, cardId, code, status, checkedAt,
            status === 'canceled' ? new Date().toISOString() : null]
        );
        // 取消则按课程消耗课次退还
        if (status === 'canceled') {
          await query(
            `UPDATE membership_cards SET remaining = LEAST(remaining + $2, total_sessions)
             WHERE id=$1 AND remaining IS NOT NULL`,
            [cardId, cost]
          );
        }
      } catch (e) {
        // 唯一冲突（同会员同课）直接忽略
      }
    }
  }

  // 9.5 固定保留两张「次数不足但仍有效」的次卡，保证低余额提醒有样例
  await query(`UPDATE membership_cards SET remaining=2, status='active' WHERE card_no='VIP2026003'`);
  await query(`UPDATE membership_cards SET remaining=1, status='active' WHERE card_no='VIP2026016'`);

  // 10. 生成提醒
  await query(
    `INSERT INTO reminders(member_id, card_id, type, message)
     SELECT m.id, c.id,
       CASE
         WHEN c.remaining IS NOT NULL AND c.remaining <= 3 THEN 'low_sessions'
         WHEN c.end_date < CURRENT_DATE THEN 'expired'
         ELSE 'expiring'
       END,
       CASE
         WHEN c.remaining IS NOT NULL AND c.remaining <= 3
           THEN '您的「' || c.plan_name || '」仅剩 ' || c.remaining || ' 次，建议及时续费'
         WHEN c.end_date < CURRENT_DATE
           THEN '您的「' || c.plan_name || '」已到期，请尽快续费'
         ELSE '您的「' || c.plan_name || '」将于 ' || c.end_date || ' 到期，续费可享优惠'
       END
     FROM membership_cards c JOIN members m ON m.id = c.member_id
     WHERE c.status IN ('active','expired','used_up')
       AND (
         (c.card_type='count' AND c.remaining <= 3)
         OR (c.card_type='period' AND c.end_date <= CURRENT_DATE + INTERVAL '7 days')
       )`
  );

  const counts = {};
  for (const t of ['coaches','members','membership_cards','venues','equipment','coach_schedules','classes','bookings','reminders']) {
    counts[t] = (await query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  }
  return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const counts = await seedData();
  console.log('样例数据生成完成：', counts);
  process.exit(0);
}
