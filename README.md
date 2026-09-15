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
| 📝 预约管理 | 代客约课，自动选卡、**次卡预扣次数**、满员/重复/过期卡拦截；取消预约按规则退次 |
| 🏋️ 教练管理 | 教练档案、专长、课时费、停用/启用 |
| ⏰ 教练排班 | 周视图排班（早/正常/晚班），时间重叠自动拦截 |
| 🏟️ 场地与器械 | 场地开放/关闭（关闭后不可排课）、器械台账、保养周期、正常/维修中/报废流转 |
| 🛠️ 维修工单 | 每台器械开工单（报修人/故障/处理人/状态/费用/完工时间）；同一台器械同时只能有一张未完成工单；完工自动恢复正常；报废强制填写原因与审核人 |
| ✅ 到店核销 | 输入 6 位核销码核销，限**开课前 2 小时窗口**；防重复核销、卡有效性校验；支持手动核销 |
| 🔔 提醒中心 | 期限卡 7 天内到期/已过期、次卡剩余 ≤3 次、**器械保养周期到期**自动生成提醒；续费/登记保养后自动消除；可标记已通知/忽略 |

## 核心业务规则

- **约课**：事务内完成「重复预约 → 满员 → 选可用卡 → 次卡预扣 → 生成核销码」，有效预约对 `(class_id, member_id)` 有数据库级唯一约束。
- **取消预约**：开课前 **≥2 小时**取消自动退还 1 次课；不足 2 小时允许取消但不退次（记录取消原因）。
- **整课取消**：已预约的学员全部取消并退次。
- **核销**：6 位核销码 + 2 小时时间窗 + 会员卡有效（期限卡未过期、次卡有余量）+ 防重复。
- **续费**：期限卡未过期从原到期日顺延、已过期从当天顺延；次卡增加次数并自动恢复有效；写入续费流水并关闭对应提醒。
- **自动状态**：查询时自动把到期的期限卡置为 `expired`、次数耗尽的次卡置为 `used_up`，并增量生成提醒（不会重复打扰）。
- **维修工单**：器械报修必须开工单，未填处理人时为「待派单」、派单后「维修中」；同一器械存在未完成工单时数据库级唯一索引拦截重复报修；完工登记费用/结果并自动把器械恢复为正常；判定报废必须填写报废原因和审核人。
- **保养提醒**：器械可设置保养周期（天），到期前 3 天起在提醒中心生成保养提醒；同一台器械只保留一条待处理/已忽略提醒，登记保养或送修后自动消除。
- **可用器械**：场地与工作台按器械 `quantity` 汇总「可用/总数」台数（维修中、已报废不可用）；排课可指定所需器械与数量，提交时校验该场地当前可用台数是否足够。

## 样例数据

内置 6 位教练、20 位会员、18 张覆盖各种状态的会员卡（有效/即将到期/已过期/次数不足/用完/冻结）、
5 块场地、8 项器械、近 3 周共 60+ 节课、200+ 条预约（含已核销/已取消/未到店）、以及自动生成的提醒。

后端自带一份 16 项断言的端到端测试（约课 → 取消退次 → 重约 → 核销拦截 → 续费等）：

```bash
# 先启动后端，再执行：
node server/e2e-test.mjs
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
                           POST /api/venues/equipment/:id/maintain
GET/POST /api/repair-orders
                           POST /api/repair-orders/:id/dispatch | /complete | /scrap
GET/POST /api/classes      POST /api/classes/:id/cancel
GET/POST /api/bookings     POST /api/bookings/:id/cancel
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
│   │   └── routes/           # 各业务模块路由
│   └── e2e-test.mjs          # API 端到端冒烟测试
└── client/
    └── src/
        ├── App.jsx           # 布局/导航/路由
        ├── api.js            # 请求封装与格式化工具
        └── pages/            # 10 个页面
```
