import { Router } from 'express';
import { query } from '../db.js';
import { refreshCardStatuses, regenerateReminders } from '../reminderLogic.js';

const router = Router();

router.get('/stats', async (req, res, next) => {
  try {
    await refreshCardStatuses();
    await regenerateReminders();
    const one = async (sql) => (await query(sql)).rows[0];
    const [
      members, activeCards, expiringSoon, lowSessions,
      todayClasses, todayBookings, checked, coaches, venuesOpen, maintenance,
    ] = await Promise.all([
      one(`SELECT count(*)::int n FROM members`),
      one(`SELECT count(*)::int n FROM membership_cards WHERE status='active'
           AND (end_date IS NULL OR end_date >= CURRENT_DATE)`),
      one(`SELECT count(*)::int n FROM membership_cards
           WHERE card_type='period' AND status='active'
           AND end_date >= CURRENT_DATE AND end_date <= CURRENT_DATE + INTERVAL '7 days'`),
      one(`SELECT count(*)::int n FROM membership_cards
           WHERE card_type='count' AND status='active' AND remaining <= 3`),
      one(`SELECT count(*)::int n FROM classes
           WHERE start_at >= date_trunc('day', now()) AND start_at < date_trunc('day', now()) + INTERVAL '1 day'
           AND status='open'`),
      one(`SELECT count(*)::int n FROM bookings b JOIN classes c ON c.id=b.class_id
           WHERE c.start_at >= date_trunc('day', now()) AND c.start_at < date_trunc('day', now()) + INTERVAL '1 day'
           AND b.status IN ('booked','checked')`),
      one(`SELECT count(*)::int n FROM bookings b JOIN classes c ON c.id=b.class_id
           WHERE c.start_at >= date_trunc('day', now()) AND c.start_at < date_trunc('day', now()) + INTERVAL '1 day'
           AND b.status='checked'`),
      one(`SELECT count(*)::int n FROM coaches WHERE status='active'`),
      one(`SELECT count(*)::int n FROM venues WHERE status='open'`),
      one(`SELECT count(*)::int n FROM equipment WHERE status='maintenance'`),
    ]);
    res.json({
      members: members.n,
      activeCards: activeCards.n,
      expiringSoon: expiringSoon.n,
      lowSessions: lowSessions.n,
      todayClasses: todayClasses.n,
      todayBookings: todayBookings.n,
      checkedToday: checked.n,
      coaches: coaches.n,
      venuesOpen: venuesOpen.n,
      maintenance: maintenance.n,
    });
  } catch (e) { next(e); }
});

// 近 7 天上课 / 核销趋势
router.get('/trend', async (req, res, next) => {
  try {
    const r = await query(`
      SELECT d::date AS day,
        (SELECT count(*) FROM classes c WHERE c.start_at::date = d) AS classes,
        (SELECT count(*) FROM bookings b JOIN classes c ON c.id=b.class_id
          WHERE c.start_at::date = d AND b.status='checked') AS checked
      FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') d
      ORDER BY day`);
    res.json(r.rows);
  } catch (e) { next(e); }
});

export default router;
