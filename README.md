# PowerGym 健身场馆管理系统

一个功能完整的健身场馆运营管理系统，覆盖 **会员卡管理、课程预约、教练排班、器械场地、到店核销、约课取消、到期/续费提醒** 全流程。

技术栈：**React 18 + Vite + React Router**（前端）· **Express 5**（后端）· **PostgreSQL**（数据库）。

> 数据库默认使用 **PGlite**（嵌入式 PostgreSQL，数据落盘到 `server/.pglite-data/`，无需安装任何数据库即可运行）；
> 想连真实 PostgreSQL 时，只需设置环境变量 `DATABASE_URL`，代码会自动切换（见文末）。

## 快速开始

```bash
cd gym-system

# 1. 安装依赖（根目录已装好时可跳过）
npm run install:all

# 2. 一键启动前后端
npm run dev
```

- 前端：http://localhost:5173
- 后端 API：http://localhost:4000/api/health

首次启动会自动建表并写入样例数据。也可以分别启动：

```bash
npm run dev:server   # 仅后端 http://localhost:4000
npm run dev:client   # 仅前端 http://localhost:5173
npm run seed         # 随时重置样例数据
```

## 功能模块

| 模块 | 功能点 |
| --- | --- |
| 📊 工作台 | 核心指标（会员数/今日课程/核销数/到期数…）、近 7 天开课核销趋势、今日待核销、待处理提醒 |
| 👤 会员管理 | 会员档案、搜索、新增/编辑、会员卡与预约历史 |
| 💳 会员卡 | 开卡（月/季/半年/年卡、10~50 次卡）、续费（延期/加次）、冻结/解冻、续费记录 |
| 📅 课表排课 | 按天查看课表、排课自动校验**教练冲突、场地冲突、场地容量上限、场地开放状态**；整节课取消并批量退次 |
| 📝 预约管理 | 代客约课，自动选卡、**次卡预扣次数**、满员/重复/过期卡拦截；取消预约按规则退次；满员可一键加入候补 |
| 🕒 候补队列 | **满员自动候补、实时排队顺序、取消自动递补、转正限时确认、逾期自动放弃顺延、全流程记录可查** |
| 🏋️ 教练管理 | 教练档案、专长、课时费、停用/启用 |
| ⏰ 教练排班 | 周视图排班（早/正常/晚班），时间重叠自动拦截 |
| 🏟️ 场地与器械 | 场地开放/关闭（关闭后不可排课）、器械台账、正常/维修中/报废流转 |
| ✅ 到店核销 | 输入 6 位核销码核销，限**开课前 2 小时窗口**；防重复核销、卡有效性校验；支持手动核销 |
| 🔔 续费提醒 | 期限卡 7 天内到期/已过期、次卡剩余 ≤3 次自动生成提醒；续费后自动消除；可标记已通知/忽略 |

## 核心业务规则

- **约课**：事务内完成「重复预约 → 满员 → 选可用卡 → 次卡预扣 → 生成核销码」，有效预约对 `(class_id, member_id)` 有数据库级唯一约束。
- **候补递补**：满员课程可加入候补（按 `joined_at` 排序）；会员取消预约或整课取消时，在**同一数据库事务**内按加入顺序递补——递补时重新校验会员卡有效（未过期/未冻结）且剩余次数 ≥ 课程消耗，不合格者**保留排队位置并记录跳过原因**，继续往下递补直至补满。
- **候补确认**：候补转正即预扣次数并生成预约（`source='waitlist'`），需在 **2 小时内且最晚开课前 15 分钟**确认（确认时二次校验卡状态）；逾期未确认自动放弃、退还预扣次数，并把名额**级联递补**给队列下一位。开课后仍排队的候补自动失效。
- **取消预约**：开课前 **≥2 小时**取消自动退还 1 次课；不足 2 小时允许取消但不退次（记录取消原因）。
- **整课取消**：已预约的学员全部取消并退次；候补队列（排队中 + 待确认）一并关闭并留痕。
- **核销**：6 位核销码 + 2 小时时间窗 + 会员卡有效（期限卡未过期、次卡有余量）+ 防重复。
- **续费**：期限卡未过期从原到期日顺延、已过期从当天顺延；次卡增加次数并自动恢复有效；写入续费流水并关闭对应提醒。
- **自动状态**：查询时自动把到期的期限卡置为 `expired`、次数耗尽的次卡置为 `used_up`，并增量生成提醒（不会重复打扰）。

## 样例数据

内置 6 位教练、20 位会员、18 张覆盖各种状态的会员卡（有效/即将到期/已过期/次数不足/用完/冻结）、
5 块场地、8 项器械、近 3 周共 70 节课、270+ 条预约（含已核销/已取消/未到店）、满员课的候补演示数据（排队中/待确认/已确认/已放弃），
以及自动生成的提醒。

后端自带两套端到端冒烟测试：

```bash
# 先启动后端，再执行：
node server/e2e-test.mjs           # 约课 → 取消退次 → 重约 → 核销拦截 → 续费等（21 项断言）
node server/waitlist-e2e-test.mjs  # 候补 → 自动递补（卡失效跳过）→ 确认 → 逾期顺延 → 整课取消（36 项断言）
```

## API 一览

```
GET  /api/dashboard/stats | /trend        工作台统计与趋势
GET/POST /api/members      GET/PUT /api/members/:id
GET/POST /api/cards        POST /api/cards/:id/renew | /freeze
                           GET  /api/cards/renewals/list
GET/POST /api/coaches      PUT  /api/coaches/:id
GET/POST/DELETE /api/schedules
GET/POST/PUT /api/venues   GET/POST/PUT /api/venues/equipment(/:id)
GET/POST /api/classes      POST /api/classes/:id/cancel
GET/POST /api/bookings     POST /api/bookings/:id/cancel
GET/POST /api/waitlists    POST /api/waitlists/:id/confirm | /:id/abandon
                           POST /api/waitlists/sweep
GET  /api/checkins/today   POST /api/checkins/verify | /:id/check
GET  /api/reminders        POST /api/reminders/:id/status
POST /api/dev/reseed                            重置样例数据
```

## 切换到真实 PostgreSQL

```bash
# 例如：postgres://user:password@localhost:5432/gym
DATABASE_URL=postgres://user:password@localhost:5432/gym npm run dev:server
```

表结构在 `server/src/schema.sql`（标准 PG 语法，含外键、唯一索引、事务），首次启动自动执行。

## 目录结构

```
gym-system/
├── package.json              # 一键启动脚本
├── scripts/dev.js            # 并行拉起前后端
├── server/
│   ├── src/
│   │   ├── index.js          # Express 入口
│   │   ├── db.js             # PGlite / pg.Pool 双后端适配
│   │   ├── schema.sql        # 数据库表结构
│   │   ├── seed.js           # 样例数据生成
│   │   ├── reminderLogic.js  # 卡状态刷新 & 提醒生成
│   │   ├── waitlistLogic.js  # 候补自动递补 & 逾期放弃
│   │   └── routes/           # 各业务模块路由
│   ├── e2e-test.mjs          # API 端到端冒烟测试
│   └── waitlist-e2e-test.mjs # 候补队列端到端冒烟测试
└── client/
    └── src/
        ├── App.jsx           # 布局/导航/路由
        ├── api.js            # 请求封装与格式化工具
        └── pages/            # 10 个页面
```
