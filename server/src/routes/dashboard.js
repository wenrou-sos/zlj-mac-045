import { Router } from 'express';
import { query } from '../db.js';
import { refreshCardStatuses, regenerateReminders } from '../reminderLogic.js';
import { getTodaySummary, getTrend } from '../metrics.js';

const router = Router();

// 工作台数字与经营报表共用 metrics.js（同一口径层）：
// 今日课程/今日预约/已核销即「当天区间报表」的开课数/有效预约/核销数
router.get('/stats', async (req, res, next) => {
  try {
    await refreshCardStatuses();
    await regenerateReminders();
    const one = async (sql) => (await query(sql)).rows[0];
    const [summary, members, activeCards, expiringSoon, lowSessions,
      coaches, venuesOpen, maintenance] = await Promise.all([
      getTodaySummary(),
      one(`SELECT count(*)::int n FROM members`),
      one(`SELECT count(*)::int n FROM membership_cards WHERE status='active'
           AND (end_date IS NULL OR end_date >= CURRENT_DATE)`),
      one(`SELECT count(*)::int n FROM membership_cards
           WHERE card_type='period' AND status='active'
           AND end_date >= CURRENT_DATE AND end_date <= CURRENT_DATE + INTERVAL '7 days'`),
      one(`SELECT count(*)::int n FROM membership_cards
           WHERE card_type='count' AND status='active' AND remaining <= 3`),
      one(`SELECT count(*)::int n FROM coaches WHERE status='active'`),
      one(`SELECT count(*)::int n FROM venues WHERE status='open'`),
      one(`SELECT count(*)::int n FROM equipment WHERE status='maintenance'`),
    ]);
    res.json({
      members: members.n,
      activeCards: activeCards.n,
      expiringSoon: expiringSoon.n,
      lowSessions: lowSessions.n,
      todayClasses: summary.classes_scheduled,
      todayBookings: summary.seats_effective,
      checkedToday: summary.checkins,
      noShowToday: summary.no_shows,
      coaches: coaches.n,
      venuesOpen: venuesOpen.n,
      maintenance: maintenance.n,
      caliber_version: summary.caliber_version,
    });
  } catch (e) { next(e); }
});

// 近 7 天上课 / 核销趋势（历史日走日汇总，今天实时）
router.get('/trend', async (req, res, next) => {
  try {
    res.json(await getTrend(7));
  } catch (e) { next(e); }
});

export default router;
