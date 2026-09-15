import { Router } from 'express';
import { query, withTransaction } from '../db.js';

const router = Router();

const OPEN_STATUSES = ['pending', 'processing'];
const FINISH_STATUSES = ['done', 'scrapped'];

// 工单列表（?status=&equipment_id=），带器械/场地名与维修耗时
router.get('/', async (req, res, next) => {
  try {
    const { status, equipment_id } = req.query;
    const conds = [];
    const params = [];
    if (status) {
      params.push(status);
      conds.push(`o.status=$${params.length}`);
    }
    if (equipment_id) {
      params.push(equipment_id);
      conds.push(`o.equipment_id=$${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await query(`
      SELECT o.*, e.name AS equipment_name, e.asset_no, e.quantity,
             v.name AS venue_name,
             CASE
               WHEN o.completed_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (o.completed_at - o.created_at))::int
               ELSE EXTRACT(EPOCH FROM (now() - o.created_at))::int
             END AS duration_sec
      FROM repair_orders o
      JOIN equipment e ON e.id = o.equipment_id
      LEFT JOIN venues v ON v.id = e.venue_id
      ${where}
      ORDER BY
        CASE o.status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
        o.created_at DESC`, params);
    res.json(r.rows);
  } catch (e) { next(e); }
});

// 开工单（报修）：同一台器械只能有一张未完成工单；器械置为维修中
router.post('/', async (req, res, next) => {
  try {
    const equipment_id = Number(req.body.equipment_id);
    const reporter = (req.body.reporter || '').trim();
    const fault_desc = (req.body.fault_desc || '').trim();
    const assignee = req.body.assignee ? String(req.body.assignee).trim() : null;
    if (!equipment_id || !reporter || !fault_desc) {
      return res.status(400).json({ error: '报修人和故障描述必填' });
    }
    const eq = await query(`SELECT id, status FROM equipment WHERE id=$1`, [equipment_id]);
    if (eq.rows.length === 0) return res.status(404).json({ error: '器械不存在' });
    if (eq.rows[0].status === 'scrapped') {
      return res.status(409).json({ error: '该器械已报废，不能再开工单' });
    }
    const dup = await query(
      `SELECT 1 FROM repair_orders WHERE equipment_id=$1 AND status = ANY($2)`,
      [equipment_id, OPEN_STATUSES]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: '该器械已有未完成的维修工单，不能重复报修' });
    }
    const r = await withTransaction(async (tx) => {
      const ins = await tx.query(
        `INSERT INTO repair_orders(equipment_id, reporter, fault_desc, assignee, status, started_at)
         VALUES($1,$2,$3,$4::varchar, CASE WHEN $4::varchar IS NULL THEN 'pending' ELSE 'processing' END,
                 CASE WHEN $4::varchar IS NULL THEN NULL ELSE now() END)
         RETURNING *`,
        [equipment_id, reporter, fault_desc, assignee]
      );
      await tx.query(`UPDATE equipment SET status='maintenance' WHERE id=$1`, [equipment_id]);
      // 进入维修后，该器械的保养提醒先关闭（修好/保养后再按新周期生成）
      await tx.query(
        `UPDATE reminders SET status='notified'
         WHERE equipment_id=$1 AND type='equipment_maintain' AND status='pending'`,
        [equipment_id]
      );
      return ins.rows[0];
    });
    res.status(201).json(r);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '该器械已有未完成的维修工单' });
    next(e);
  }
});

// 派单 / 更新处理人（待派单 -> 维修中）
router.post('/:id/dispatch', async (req, res, next) => {
  try {
    const assignee = (req.body.assignee || '').trim();
    if (!assignee) return res.status(400).json({ error: '处理人必填' });
    const r = await query(
      `UPDATE repair_orders SET assignee=$2, status='processing',
         started_at=COALESCE(started_at, now())
       WHERE id=$1 AND status='pending' RETURNING *`,
      [req.params.id, assignee]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: '待派单工单不存在' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

// 完工：登记费用与维修结果，器械自动恢复正常
router.post('/:id/complete', async (req, res, next) => {
  try {
    const cost = Number(req.body.cost) || 0;
    const repair_result = req.body.repair_result ? String(req.body.repair_result).trim() : null;
    const order = await query(`SELECT * FROM repair_orders WHERE id=$1`, [req.params.id]);
    if (order.rows.length === 0) return res.status(404).json({ error: '工单不存在' });
    if (!OPEN_STATUSES.includes(order.rows[0].status)) {
      return res.status(409).json({ error: '该工单已结束，不能重复完工' });
    }
    const r = await withTransaction(async (tx) => {
      const upd = await tx.query(
        `UPDATE repair_orders SET status='done', cost=$2, repair_result=$3, completed_at=now()
         WHERE id=$1 RETURNING *`,
        [req.params.id, cost, repair_result]
      );
      await tx.query(`UPDATE equipment SET status='normal' WHERE id=$1`, [order.rows[0].equipment_id]);
      return upd.rows[0];
    });
    res.json(r);
  } catch (e) { next(e); }
});

// 判定报废：必须填写报废原因和审核人，器械置为报废
router.post('/:id/scrap', async (req, res, next) => {
  try {
    const scrap_reason = (req.body.scrap_reason || '').trim();
    const approver = (req.body.approver || '').trim();
    if (!scrap_reason || !approver) {
      return res.status(400).json({ error: '报废原因和审核人必填' });
    }
    const order = await query(`SELECT * FROM repair_orders WHERE id=$1`, [req.params.id]);
    if (order.rows.length === 0) return res.status(404).json({ error: '工单不存在' });
    if (!OPEN_STATUSES.includes(order.rows[0].status)) {
      return res.status(409).json({ error: '该工单已结束' });
    }
    const r = await withTransaction(async (tx) => {
      const upd = await tx.query(
        `UPDATE repair_orders SET status='scrapped', scrap_reason=$2, approver=$3,
           cost=$4, completed_at=now()
         WHERE id=$1 RETURNING *`,
        [req.params.id, scrap_reason, approver, Number(req.body.cost) || 0]
      );
      await tx.query(`UPDATE equipment SET status='scrapped' WHERE id=$1`, [order.rows[0].equipment_id]);
      return upd.rows[0];
    });
    res.json(r);
  } catch (e) { next(e); }
});

export default router;
