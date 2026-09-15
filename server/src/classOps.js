// 课程级操作：整课取消（退次）与改期，供排课路由和场地不可用时段登记共用
import { query } from './db.js';
import { venueAvailabilityBlock } from './venueAvailability.js';

// 取消整节课：已预约/已核销的学员全部取消并按课程消耗课次退次，候补队列一并关闭
export async function cancelClassWithRefunds(q, classId, reason) {
  await q(`UPDATE classes SET status='canceled' WHERE id=$1`, [classId]);
  const bookings = await q(
    `SELECT b.id, b.card_id, cl.cost_sessions
     FROM bookings b JOIN classes cl ON cl.id = b.class_id
     WHERE b.class_id=$1 AND b.status IN ('booked','checked')`,
    [classId]
  );
  for (const b of bookings.rows) {
    await q(
      `UPDATE bookings SET status='canceled', canceled_at=now(), cancel_reason=$2 WHERE id=$1`,
      [b.id, reason]
    );
    if (b.card_id) {
      await q(
        `UPDATE membership_cards SET remaining = LEAST(COALESCE(remaining,0) + $2, total_sessions)
         WHERE id=$1 AND remaining IS NOT NULL`,
        [b.card_id, b.cost_sessions]
      );
    }
  }
  await q(
    `UPDATE waitlists SET status='canceled', resolved_at=now(), note='课程已取消'
     WHERE class_id=$1 AND status='waiting'`,
    [classId]
  );
  return bookings.rows.length;
}

// 课程改期：校验时间合法、场地/教练冲突（排除自身）、改后时段场地可用
export async function moveClass(q, classId, startAt, endAt) {
  const cls = (await q(`SELECT * FROM classes WHERE id=$1`, [classId])).rows[0];
  if (!cls) throw Object.assign(new Error('课程不存在'), { status: 404 });
  if (cls.status !== 'open') throw Object.assign(new Error('课程已取消或已结束，不能改期'), { status: 409 });
  if (new Date(cls.start_at) < new Date()) {
    throw Object.assign(new Error('已开始的课程不能改期'), { status: 400 });
  }
  if (!startAt || !endAt || new Date(endAt) <= new Date(startAt)) {
    throw Object.assign(new Error('改期后的结束时间必须晚于开始时间'), { status: 400 });
  }
  if (cls.venue_id) {
    const vc = await q(
      `SELECT 1 FROM classes WHERE venue_id=$1 AND status='open' AND id<>$2
         AND start_at < $4 AND end_at > $3`,
      [cls.venue_id, classId, startAt, endAt]
    );
    if (vc.rows.length > 0) throw Object.assign(new Error('改期后的时间与该场地其他课程冲突'), { status: 409 });
    const block = await venueAvailabilityBlock(cls.venue_id, startAt, endAt, q);
    if (block) throw Object.assign(new Error(`改期后的时间场地不可用：${block.reason}`), { status: 409 });
  }
  if (cls.coach_id) {
    const cc = await q(
      `SELECT 1 FROM classes WHERE coach_id=$1 AND status='open' AND id<>$2
         AND start_at < $4 AND end_at > $3`,
      [cls.coach_id, classId, startAt, endAt]
    );
    if (cc.rows.length > 0) throw Object.assign(new Error('改期后的时间与该教练其他课程冲突'), { status: 409 });
  }
  await q(`UPDATE classes SET start_at=$2, end_at=$3 WHERE id=$1`, [classId, startAt, endAt]);
}
