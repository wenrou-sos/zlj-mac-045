// 排课与整课取消的共享业务逻辑（手工排课 / 周课模板批量生成都走这里）
import { query, withTransaction } from './db.js';

// PG 的 date 类型在不同驱动下可能返回 Date 对象或 'YYYY-MM-DD' 字符串，统一取日期部分
function dayStr(v) {
  if (v == null) return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

// 排课可行性校验。返回 { ok: true } 或 { ok: false, reason: '中文原因', code }
// candidate: { coach_id, venue_id, capacity, start_at, end_at, exclude_class_id }
// runner 默认为全局 query，批量生成时传事务连接，保证批内新增的课也参与冲突判断
export async function checkClassFeasible(candidate, runner) {
  // 默认走全局 query；批量生成时传入事务连接（带 .query）
  const db = runner || { query };
  const { coach_id, venue_id, capacity, start_at, end_at, exclude_class_id } = candidate;
  if (!start_at || !end_at || new Date(end_at) <= new Date(start_at)) {
    return { ok: false, code: 'bad_time', reason: '结束时间必须晚于开始时间' };
  }
  if (capacity != null && (!Number.isInteger(Number(capacity)) || Number(capacity) <= 0)) {
    return { ok: false, code: 'bad_capacity', reason: '容量必须为正整数' };
  }

  const exclude = exclude_class_id ? `AND id <> ${Number(exclude_class_id)}` : '';

  if (venue_id) {
    const venue = (await db.query(`SELECT name, capacity, status FROM venues WHERE id=$1`, [venue_id])).rows[0];
    if (!venue) return { ok: false, code: 'venue_missing', reason: '场地不存在' };

    // 1) 场地整体关闭（场地维护中的“总开关”）
    if (venue.status === 'closed') {
      return { ok: false, code: 'venue_closed', reason: `场地「${venue.name}」已整体关闭，当天不可排课` };
    }
    // 2) 容量上限
    if (capacity != null && Number(capacity) > venue.capacity) {
      return { ok: false, code: 'capacity_exceeded', reason: `容量 ${capacity} 人超过场地「${venue.name}」上限 ${venue.capacity} 人` };
    }

    // 3) 落在场地登记的不可用时段（含当天全天关闭/闭馆维护，可跨多天）
    //    把课程时间换算成会话业务时区的墙上日期与时分，与登记表按区间比较；
    //    跨多天的不可用区间，其首尾两天按时间窗判断、中间各天视为全天不可用
    const blocked = await db.query(`
      WITH cls AS (
        SELECT $2::timestamptz AS s, $3::timestamptz AS e,
          to_char($2::timestamptz::timestamp, 'HH24:MI') AS c_start_time,
          to_char($3::timestamptz::timestamp, 'HH24:MI') AS c_end_time,
          ($2::timestamptz)::date AS c_start_date,
          ($3::timestamptz)::date AS c_end_date
      )
      SELECT vu.* FROM venue_unavailable vu, cls
      WHERE vu.venue_id = $1
        AND vu.start_date <= cls.c_end_date AND vu.end_date >= cls.c_start_date
        AND EXISTS (
          SELECT 1 FROM generate_series(vu.start_date, vu.end_date, interval '1 day') AS d
          WHERE d::date BETWEEN cls.c_start_date AND cls.c_end_date
            AND (
              (d::date > vu.start_date AND d::date < vu.end_date)
              OR (vu.start_date = vu.end_date
                  AND vu.start_time < cls.c_end_time AND vu.end_time > cls.c_start_time)
              OR (d::date = vu.start_date AND vu.start_date <> vu.end_date
                  AND cls.c_start_time < vu.end_time)
              OR (d::date = vu.end_date AND vu.start_date <> vu.end_date
                  AND cls.c_end_time > vu.start_time)
            )
        )
      LIMIT 1`, [venue_id, start_at, end_at]);
    if (blocked.rows.length > 0) {
      const b = blocked.rows[0];
      const allDay = b.start_time === '00:00' && (b.end_time === '23:59' || b.end_time === '24:00');
      const sameDay = dayStr(b.start_date) === dayStr(b.end_date);
      const span = sameDay ? dayStr(b.start_date) : `${dayStr(b.start_date)} ~ ${dayStr(b.end_date)}`;
      if (allDay) {
        return {
          ok: false, code: 'venue_day_closed',
          reason: sameDay
            ? `场地「${venue.name}」${span} 全天关闭（${b.reason || '不可用'}）`
            : `场地「${venue.name}」${span} 闭馆（${b.reason || '不可用'}），该时段不可排课`,
        };
      }
      return {
        ok: false, code: 'venue_unavailable',
        reason: sameDay
          ? `落在场地「${venue.name}」不可用时段 ${span} ${b.start_time}-${b.end_time}（${b.reason || '场地维护'}）`
          : `落在场地「${venue.name}」不可用区间 ${span}（每日 ${b.start_time}-${b.end_time}，${b.reason || '场地维护'}）`,
      };
    }

    // 4) 场地此时段已有其他未取消课程
    const vc = await db.query(`
      SELECT cl.title FROM classes cl
      WHERE cl.venue_id=$1 AND cl.status='open'
        AND cl.start_at < $3 AND cl.end_at > $2
        ${exclude.replaceAll('id', 'cl.id')}
      LIMIT 1`, [venue_id, start_at, end_at]);
    if (vc.rows.length > 0) {
      return { ok: false, code: 'venue_conflict', reason: `场地「${venue.name}」此时段已有课程「${vc.rows[0].title}」` };
    }
  }

  if (coach_id) {
    // 教练停用同样跳过（模板可能挂着一位已停用的教练）
    const coach = (await db.query(`SELECT name, status FROM coaches WHERE id=$1`, [coach_id])).rows[0];
    if (!coach) return { ok: false, code: 'coach_missing', reason: '教练不存在' };
    if (coach.status === 'inactive') {
      return { ok: false, code: 'coach_inactive', reason: `教练「${coach.name}」已停用` };
    }
    const cc = await db.query(`
      SELECT cl.title FROM classes cl
      WHERE cl.coach_id=$1 AND cl.status='open'
        AND cl.start_at < $3 AND cl.end_at > $2
        ${exclude.replaceAll('id', 'cl.id')}
      LIMIT 1`, [coach_id, start_at, end_at]);
    if (cc.rows.length > 0) {
      return { ok: false, code: 'coach_conflict', reason: `教练「${coach.name}」此时段已有课程「${cc.rows[0].title}」` };
    }
  }

  return { ok: true };
}

// 取消一节课：已预约（含已核销）的学员全部取消预约，次卡按课程消耗课次退还。
// 返回 { affected, refunded_sessions, refunds:[{member_id, card_id, sessions}] }
// 调用方负责课程是否存在 / 是否已开始 / 状态可取消等业务判断
export async function cancelClassWithRefunds(tx, classId, reason = '课程取消') {
  const bookings = await tx.query(
    `SELECT b.id, b.member_id, b.card_id, cl.cost_sessions
     FROM bookings b JOIN classes cl ON cl.id = b.class_id
     WHERE b.class_id=$1 AND b.status IN ('booked','checked')`,
    [classId]
  );
  const refunds = [];
  for (const b of bookings.rows) {
    await tx.query(
      `UPDATE bookings SET status='canceled', canceled_at=now(), cancel_reason=$2 WHERE id=$1`,
      [b.id, reason]
    );
    if (b.card_id) {
      // 按该课程实际消耗课次退还（多课次课程不能只退 1），且不超过卡总次数
      await tx.query(
        `UPDATE membership_cards SET remaining = LEAST(COALESCE(remaining,0) + $2, total_sessions)
         WHERE id=$1 AND remaining IS NOT NULL`,
        [b.card_id, b.cost_sessions]
      );
      refunds.push({ member_id: b.member_id, card_id: b.card_id, sessions: b.cost_sessions });
    }
  }
  const refunded_sessions = refunds.reduce((s, r) => s + r.sessions, 0);
  return { affected: bookings.rows.length, refunded_sessions, refunds };
}

// 单节课取消（供 classes 路由调用）：带“已开始不能取消”的业务校验
export async function cancelSingleClass(classId, reason) {
  return withTransaction(async (tx) => {
    const cls = (await tx.query(`SELECT * FROM classes WHERE id=$1 FOR UPDATE`, [classId])).rows[0];
    if (!cls) throw Object.assign(new Error('课程不存在'), { status: 404 });
    if (cls.status === 'canceled') throw Object.assign(new Error('课程已取消，无需重复操作'), { status: 409 });
    if (new Date(cls.start_at) < new Date()) {
      throw Object.assign(new Error('已开始的课程不能取消'), { status: 400 });
    }
    await tx.query(`UPDATE classes SET status='canceled' WHERE id=$1`, [classId]);
    const result = await cancelClassWithRefunds(tx, classId, reason || '课程取消');
    return result;
  });
}
