// 场地可用性判定：整场地停用开关、一次性闭馆区间、每周固定闭馆时段三层叠加，
// 任一命中即不可用；多层同时命中时按「最严格」的返回原因（整停 > 一次性 > 每周固定）。
// 会话时区已在 db.js 设为 APP_TZ，SQL 里的 date_trunc / date+time 运算均为业务本地时间。
import { query } from './db.js';

export const WEEKDAYS_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const APP_TZ = process.env.APP_TZ || 'Asia/Shanghai';

function fmtTs(d) {
  return new Date(d).toLocaleString('zh-CN', {
    timeZone: APP_TZ, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
const fmtTime = (t) => String(t).slice(0, 5);

// 判断场地在 [startAt, endAt) 是否可用。
// 返回 null（可用）或 { source: 'closed'|'once'|'weekly', reason }（reason 可直接展示给前台）
export async function venueAvailabilityBlock(venueId, startAt, endAt, q = query) {
  if (!venueId) return null;
  const v = await q(`SELECT name, status FROM venues WHERE id=$1`, [venueId]);
  if (v.rows.length === 0) return { source: 'closed', reason: '场地不存在' };
  if (v.rows[0].status === 'closed') {
    return { source: 'closed', reason: `场地「${v.rows[0].name}」已停用` };
  }
  // 一次性闭馆区间
  const once = await q(`
    SELECT reason, start_at, end_at FROM venue_blocks
    WHERE venue_id=$1 AND kind='once' AND start_at < $3 AND end_at > $2
    ORDER BY start_at LIMIT 1`, [venueId, startAt, endAt]);
  if (once.rows.length > 0) {
    const b = once.rows[0];
    return {
      source: 'once',
      reason: `一次性闭馆（${b.reason}）：${fmtTs(b.start_at)} ~ ${fmtTs(b.end_at)}`,
    };
  }
  // 每周固定闭馆：课程区间触及的每个本地日历日，若当天星期几命中且时间窗重叠则不可用
  const weekly = await q(`
    SELECT reason, weekday, start_time, end_time FROM venue_blocks
    WHERE venue_id=$1 AND kind='weekly'
      AND EXISTS (
        SELECT 1 FROM generate_series(
          date_trunc('day', $2::timestamptz)::date,
          date_trunc('day', $3::timestamptz)::date,
          interval '1 day') d(day)
        WHERE EXTRACT(DOW FROM d.day)::int = venue_blocks.weekday
          AND (d.day::date + venue_blocks.start_time) < $3::timestamptz
          AND (d.day::date + venue_blocks.end_time)   > $2::timestamptz
      )
    ORDER BY weekday, start_time LIMIT 1`, [venueId, startAt, endAt]);
  if (weekly.rows.length > 0) {
    const b = weekly.rows[0];
    return {
      source: 'weekly',
      reason: `每周固定闭馆（${b.reason}）：${WEEKDAYS_CN[b.weekday]} ${fmtTime(b.start_time)}-${fmtTime(b.end_time)}`,
    };
  }
  return null;
}

// 校验并规范化一个不可用时段定义；不合法时抛出带 status 的错误
export function parseBlockDef(body) {
  const { kind, reason } = body;
  const venue_id = Number(body.venue_id);
  if (!venue_id) throw Object.assign(new Error('场地必选'), { status: 400 });
  if (!reason || !String(reason).trim()) throw Object.assign(new Error('请填写不可用原因（如：换水 / 装修 / 节假日闭馆）'), { status: 400 });
  const def = { venue_id, kind, reason: String(reason).trim() };
  if (kind === 'weekly') {
    const weekday = Number(body.weekday);
    const { start_time, end_time } = body;
    const re = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw Object.assign(new Error('请选择每周几'), { status: 400 });
    }
    if (!re.test(start_time || '') || !re.test(end_time || '')) {
      throw Object.assign(new Error('起止时间格式应为 HH:MM'), { status: 400 });
    }
    if (end_time <= start_time) throw Object.assign(new Error('结束时间必须晚于开始时间'), { status: 400 });
    Object.assign(def, { weekday, start_time, end_time });
  } else if (kind === 'once') {
    const { start_at, end_at } = body;
    if (!start_at || !end_at || isNaN(new Date(start_at)) || isNaN(new Date(end_at))) {
      throw Object.assign(new Error('请填写完整的起止时间'), { status: 400 });
    }
    if (new Date(end_at) <= new Date(start_at)) {
      throw Object.assign(new Error('结束时间必须晚于开始时间'), { status: 400 });
    }
    Object.assign(def, { start_at, end_at });
  } else {
    throw Object.assign(new Error('时段类型应为 weekly（每周固定）或 once（一次性区间）'), { status: 400 });
  }
  return def;
}

// 查出登记该时段后会撞上的未来课程（已结束/已取消的不算）
export async function conflictingClassesForBlock(def, q = query) {
  const base = `
    SELECT cl.*, co.name AS coach_name,
      (SELECT count(*) FROM bookings b WHERE b.class_id=cl.id AND b.status IN ('booked','checked')) AS booked_count
    FROM classes cl LEFT JOIN coaches co ON co.id=cl.coach_id
    WHERE cl.venue_id=$1 AND cl.status='open' AND cl.end_at > now()`;
  if (def.kind === 'once') {
    const r = await q(
      `${base} AND cl.start_at < $3 AND cl.end_at > $2 ORDER BY cl.start_at`,
      [def.venue_id, def.start_at, def.end_at]
    );
    return r.rows;
  }
  const r = await q(`
    ${base}
      AND EXISTS (
        SELECT 1 FROM generate_series(
          date_trunc('day', cl.start_at)::date,
          date_trunc('day', cl.end_at)::date,
          interval '1 day') d(day)
        WHERE EXTRACT(DOW FROM d.day)::int = $2
          AND (d.day::date + $3::time) < cl.end_at
          AND (d.day::date + $4::time) > cl.start_at
      )
    ORDER BY cl.start_at`,
    [def.venue_id, def.weekday, def.start_time, def.end_time]
  );
  return r.rows;
}
