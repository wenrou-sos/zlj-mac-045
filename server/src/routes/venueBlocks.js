import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { parseBlockDef, conflictingClassesForBlock } from '../venueAvailability.js';
import { cancelClassWithRefunds, moveClass } from '../classOps.js';

const router = Router();

// 不可用时段列表（每周固定的全部返回；一次性的只返回未结束的，即进行中 + 即将生效）
router.get('/', async (req, res, next) => {
  try {
    const { venue_id } = req.query;
    const conds = [`(b.kind='weekly' OR b.end_at > now())`];
    const params = [];
    if (venue_id) { params.push(venue_id); conds.push(`b.venue_id=$${params.length}`); }
    const r = await query(`
      SELECT b.*, v.name AS venue_name
      FROM venue_blocks b JOIN venues v ON v.id=b.venue_id
      WHERE ${conds.join(' AND ')}
      ORDER BY b.kind, b.start_at NULLS LAST, b.weekday NULLS FIRST, b.start_time NULLS FIRST, b.id`,
      params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 登记前预检：返回该时段会撞上的未来课程（含预约人数），前端据此引导改期/取消
router.post('/preview', async (req, res, next) => {
  try {
    const def = parseBlockDef(req.body);
    const venue = await query(`SELECT id, name FROM venues WHERE id=$1`, [def.venue_id]);
    if (venue.rows.length === 0) return res.status(404).json({ error: '场地不存在' });
    const conflicts = await conflictingClassesForBlock(def);
    res.json({ conflicts });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// 登记不可用时段。若撞上已排课程，必须随请求给出每节课的处理方案（resolutions）：
//   { class_id, action: 'cancel' }                        取消整课并退次
//   { class_id, action: 'move', start_at, end_at }        改期（会再次校验冲突与可用性）
// 时段生效与课程处理在同一事务内完成，任一步失败整体回滚。
router.post('/', async (req, res, next) => {
  try {
    const def = parseBlockDef(req.body);
    const resolutions = Array.isArray(req.body.resolutions) ? req.body.resolutions : [];

    const result = await withTransaction(async (tx) => {
      const tq = (text, params) => tx.query(text, params);
      const venue = await tx.query(`SELECT id, name FROM venues WHERE id=$1`, [def.venue_id]);
      if (venue.rows.length === 0) throw Object.assign(new Error('场地不存在'), { status: 404 });

      const conflicts = await conflictingClassesForBlock(def, tq);
      const conflictIds = new Set(conflicts.map((c) => c.id));
      const resolvedIds = new Set(resolutions.map((r) => Number(r.class_id)));
      if (conflicts.length > 0 && resolutions.length === 0) {
        // 让前端拿到冲突列表后走改期/取消流程
        const err = Object.assign(new Error('该时段内已有排课，请先处理这些课程'), { status: 409 });
        err.conflicts = conflicts;
        throw err;
      }
      for (const id of resolvedIds) {
        if (!conflictIds.has(id)) throw Object.assign(new Error(`课程 #${id} 不在冲突列表中`), { status: 400 });
      }
      for (const id of conflictIds) {
        if (!resolvedIds.has(id)) throw Object.assign(new Error(`还有课程未选择处理方式（共 ${conflicts.length} 节）`), { status: 400 });
      }

      // 先让时段生效，再处理课程：改期校验会命中新时段，避免又改进闭馆时间里
      const ins = await tx.query(
        `INSERT INTO venue_blocks(venue_id, kind, weekday, start_time, end_time, start_at, end_at, reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [def.venue_id, def.kind,
          def.kind === 'weekly' ? def.weekday : null,
          def.kind === 'weekly' ? def.start_time : null,
          def.kind === 'weekly' ? def.end_time : null,
          def.kind === 'once' ? def.start_at : null,
          def.kind === 'once' ? def.end_at : null,
          def.reason]
      );

      let canceled = 0;
      let moved = 0;
      let refunded = 0;
      for (const r of resolutions) {
        if (r.action === 'cancel') {
          refunded += await cancelClassWithRefunds(tq, Number(r.class_id), `场地不可用（${def.reason}），课程取消`);
          canceled++;
        } else if (r.action === 'move') {
          await moveClass(tq, Number(r.class_id), r.start_at, r.end_at);
          moved++;
        } else {
          throw Object.assign(new Error('课程处理方式应为 cancel 或 move'), { status: 400 });
        }
      }
      return { block: ins.rows[0], canceled, moved, refunded };
    });
    res.status(201).json({ ok: true, ...result });
  } catch (e) {
    if (e.conflicts) return res.status(e.status).json({ error: e.message, conflicts: e.conflicts });
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// 删除（解除）一个不可用时段
router.delete('/:id', async (req, res, next) => {
  try {
    const r = await query(`DELETE FROM venue_blocks WHERE id=$1 RETURNING id`, [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: '时段不存在' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
