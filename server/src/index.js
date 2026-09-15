import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, execSql, closeDb, dbReady, DB_MODE } from './db.js';
import { seedData } from './seed.js';
import { authGuard, requireRole } from './auth.js';
import { ensureDefaultUsers, linkCoachAccounts, backfillRenewalAudit } from './bootstrap.js';

import authRouter from './routes/auth.js';
import auditRouter from './routes/audit.js';
import dashboardRouter from './routes/dashboard.js';
import membersRouter from './routes/members.js';
import cardsRouter from './routes/cards.js';
import coachesRouter from './routes/coaches.js';
import schedulesRouter from './routes/schedules.js';
import venuesRouter from './routes/venues.js';
import classesRouter from './routes/classes.js';
import bookingsRouter from './routes/bookings.js';
import checkinsRouter from './routes/checkins.js';
import remindersRouter from './routes/reminders.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, db: DB_MODE }));

// 全站登录态校验（/api/health 与 /api/auth/login 除外）。
// 具体角色/权限由各路由上的 requirePerm 中间件二次判断，绕过页面直连接口同样拦截。
app.use('/api', authGuard);

app.use('/api/auth', authRouter);
app.use('/api/audit', auditRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/members', membersRouter);
app.use('/api/cards', cardsRouter);
app.use('/api/coaches', coachesRouter);
app.use('/api/schedules', schedulesRouter);
app.use('/api/venues', venuesRouter);
app.use('/api/classes', classesRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/checkins', checkinsRouter);
app.use('/api/reminders', remindersRouter);

// 重置样例数据（仅店长）
app.post('/api/dev/reseed', requireRole('manager'), async (req, res, next) => {
  try {
    const counts = await seedData();
    res.json({ ok: true, counts });
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

async function init() {
  await dbReady;
  // 建表
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await execSql(schema);

  // 内置账号（店长/前台/教练）幂等创建
  await ensureDefaultUsers();

  // 首次启动（无数据）自动写入样例数据
  const n = (await query(`SELECT count(*)::int AS n FROM members`)).rows[0].n;
  if (n === 0 || process.env.RESEED === '1') {
    const counts = await seedData();
    console.log('已写入样例数据：', counts);
  }

  // 教练账号挂接档案；历史续费记录关联账号并补写审计
  await linkCoachAccounts();
  const backfilled = await backfillRenewalAudit();
  if (backfilled) console.log(`已补录 ${backfilled} 条历史续费审计记录`);

  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`健身场馆管理系统 API: http://localhost:${port}/api/health  (数据库: ${DB_MODE})`);
  });
}

process.on('SIGINT', async () => { await closeDb(); process.exit(0); });

init().catch((e) => { console.error(e); process.exit(1); });
