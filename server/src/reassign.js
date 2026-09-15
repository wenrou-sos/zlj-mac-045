// 课程改派共享逻辑：单节改派与请假批量改派都走这里，保证校验口径一致
import { httpError } from './httpError.js';

// 业务时区（与 db.js 口径一致），错误提示里的时间按本地墙上时间展示
const APP_TZ = process.env.APP_TZ || 'Asia/Shanghai';
const fmtLocal = (d) => new Date(d).toLocaleString('zh-CN', {
  timeZone: APP_TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

// 在事务内把一节课改派给代课教练，并写入改派记录
// 校验：课程可改派（未取消/未结算锁定）→ 代课教练有效 → 当天排班覆盖课程时段 → 不撞课 → 代课人自己不在请假
export async function reassignClass(tx, classId, toCoachId, leaveId = null, note = null) {
  const cls = (await tx.query(`SELECT * FROM classes WHERE id=$1`, [classId])).rows[0];
  if (!cls) throw httpError(404, `课程 #${classId} 不存在`);
  const label = `「${cls.title}」(${fmtLocal(cls.start_at)})`;
  if (cls.status === 'canceled') throw httpError(409, `课程${label}已取消，不能改派`);
  if (cls.locked_period) {
    throw httpError(409, `课程${label}已进入 ${cls.locked_period} 期结算并锁定，不能直接改派，请用结算调整记录更正`);
  }
  if (!toCoachId) throw httpError(400, `课程${label}未选择代课教练`);
  if (Number(cls.coach_id) === Number(toCoachId)) throw httpError(400, `课程${label}的代课教练不能与现任教练相同`);

  const coach = (await tx.query(`SELECT * FROM coaches WHERE id=$1 AND status='active'`, [toCoachId])).rows[0];
  if (!coach) throw httpError(404, `课程${label}的代课教练不存在或已停用`);

  // 代课教练当天必须有覆盖课程时段的排班（按会话时区的墙上时间比较）
  const shift = await tx.query(
    `SELECT 1 FROM coach_schedules s
     WHERE s.coach_id=$1 AND s.work_date = $2::timestamptz::date
       AND s.start_time <= to_char($2::timestamptz, 'HH24:MI')
       AND s.end_time   >= to_char($3::timestamptz, 'HH24:MI')`,
    [toCoachId, cls.start_at, cls.end_at]
  );
  if (shift.rows.length === 0) {
    throw httpError(409, `${coach.name} 当天没有覆盖课程${label}时段的排班`);
  }

  // 撞课校验：代课教练此时段不能有其他进行中的课
  const clash = await tx.query(
    `SELECT title FROM classes
     WHERE coach_id=$1 AND status='open' AND id<>$2
       AND start_at < $3 AND end_at > $4`,
    [toCoachId, classId, cls.end_at, cls.start_at]
  );
  if (clash.rows.length > 0) {
    throw httpError(409, `${coach.name} 此时段已有「${clash.rows[0].title}」，撞课`);
  }

  // 代课教练自己此时段不能在请假
  const onLeave = await tx.query(
    `SELECT 1 FROM coach_leaves
     WHERE coach_id=$1 AND status='active' AND start_at < $3 AND end_at > $2`,
    [toCoachId, cls.start_at, cls.end_at]
  );
  if (onLeave.rows.length > 0) throw httpError(409, `${coach.name} 此时段也在请假，不能代课`);

  // 首次改派时把现任教练记入 original_coach_id，之后无论改派几次都保留最初的人
  await tx.query(
    `UPDATE classes SET original_coach_id = COALESCE(original_coach_id, coach_id), coach_id=$2 WHERE id=$1`,
    [classId, toCoachId]
  );
  const r = await tx.query(
    `INSERT INTO class_reassignments(class_id, leave_id, from_coach_id, to_coach_id, note)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [classId, leaveId, cls.coach_id, toCoachId, note]
  );
  return r.rows[0];
}
