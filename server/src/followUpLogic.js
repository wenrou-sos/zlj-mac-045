// 跟进事项的自动结束：会员续费/续卡或开出新卡后，挂起的跟进不应一直留在列表里
import { query } from './db.js';

// 结束某会员全部未结束的跟进（pending / contacted -> renewed）
// tx 可为事务对象（与续费同事务提交）
export async function autoCloseByRenewal(memberId, reason, tx = null) {
  const runner = tx || { query };
  const r = await runner.query(`
    UPDATE follow_ups SET
      status='renewed',
      auto_closed=true,
      closed_reason=$2,
      closed_at=now()
    WHERE member_id=$1 AND status IN ('pending','contacted')`,
    [memberId, reason]);
  return r.rowCount;
}
