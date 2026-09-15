import { Router } from 'express';
import { query } from '../db.js';
import { refreshCardStatuses, regenerateReminders } from '../reminderLogic.js';
import { requirePerm } from '../auth.js';

const router = Router();

router.get('/stats', requirePerm('dashboard'), async (req, res, next) => {
  try {
    // 教练视角：只统计自己的课、核销、排班；不暴露会员/收入相关数字
    if (req.user.role === 'coach') {
      const coachId = req.user.coach_id;
      if (!coachId) {
        return res.json({ role: 'coach', todayClasses: 0, todayBookings: 0, checkedToday: 0, myShifts: 0 });
      }
      const one = async (sql, params = []) => (await query(sql, params)).rows[0];
      const [todayClasses, todayBookings, checked, myShifts, upcomingClasses] = await Promise.all([
        one(`SELECT count(*)::int n FROM classes
             WHERE coach_id=$1 AND status='open'
               AND start_at >= date_trunc('day', now())
               AND start_at < date_trunc('day', now()) + INTERVAL '1 day'`, [coachId]),
        one(`SELECT count(*)::int n FROM bookings b JOIN classes c ON c.id=b.class_id
             WHERE c.coach_id=$1 AND b.status IN ('booked','checked')
               AND c.start_at >= date_trunc('day', now())
               AND c.start_at < date_trunc('day', now()) + INTERVAL '1 day'`, [coachId]),
        one(`SELECT count(*)::int n FROM bookings b JOIN classes c ON c.id=b.class_id
             WHERE c.coach_id=$1 AND b.status='checked'
               AND c.start_at >= date_trunc('day', now())
               AND c.start_at < date_trunc('day', now()) + INTERVAL '1 day'`, [coachId]),
        one(`SELECT count(*)::int n FROM coach_schedules
             WHERE coach_id=$1 AND work_date >= CURRENT_DATE`, [coachId]),
        one(`SELECT count(*)::int n FROM classes
             WHERE coach_id=$1 AND status='open' AND start_at > now()`, [coachId]),
      ]);
      return res.json({
        role: 'coach',
        todayClasses: todayClasses.n,
        todayBookings: todayBookings.n,
        checkedToday: checked.n,
        myShifts: myShifts.n,
        upcomingClasses: upcomingClasses.n,
      });
    }

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
      role: 'manager', // front_desk 与店长共用经营总览
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

// 近 7 天上课 / 核销趋势（教练只看自己的）
router.get('/trend', requirePerm('dashboard'), async (req, res, next) => {
  try {
    if (req.user.role === 'coach') {
      if (!req.user.coach_id) return res.json([]);
      const r = await query(`
        SELECT d::date AS day,
          (SELECT count(*) FROM classes c WHERE c.start_at::date = d AND c.coach_id=$1) AS classes,
          (SELECT count(*) FROM bookings b JOIN classes c ON c.id=b.class_id
            WHERE c.start_at::date = d AND b.status='checked' AND c.coach_id=$1) AS checked
        FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') d
        ORDER BY day`, [req.user.coach_id]);
      return res.json(r.rows);
    }
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
