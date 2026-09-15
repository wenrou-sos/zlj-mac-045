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
| 📅 课表排课 | 按天查看课表、**批量生成课表**（按每周星期×日期区间展开）；排课自动校验**教练冲突、场地冲突、场地容量上限、场地可用性**；整节课取消并批量退次；课程改期 |
| 📝 预约管理 | 代客约课，自动选卡、**次卡预扣次数**、满员/重复/过期卡/场地不可用拦截；取消预约按规则退次；**满员课可加入候补，空位释放自动递补** |
| 🏋️ 教练管理 | 教练档案、专长、课时费、停用/启用 |
| ⏰ 教练排班 | 周视图排班（早/正常/晚班），时间重叠自动拦截 |
| 🏟️ 场地与器械 | **未来 7 天场地可用性视图**（可用/被课占用/不可用）；**不可用时段登记**（每周固定闭馆 + 一次性日期区间，撞上已排课程时逐节改期或取消退次）；整场地停用开关；器械台账、正常/维修中/报废流转 |
| ✅ 到店核销 | 输入 6 位核销码核销，限**开课前 2 小时窗口**；防重复核销、卡有效性校验；支持手动核销 |
| 🔔 续费提醒 | 期限卡 7 天内到期/已过期、次卡剩余 ≤3 次自动生成提醒；续费后自动消除；可标记已通知/忽略 |

## 核心业务规则

- **场地可用性**：整场地停用开关、一次性闭馆区间、每周固定闭馆时段**三层叠加**，任一命中即不可用，拦截时按最严格的命中层给出原因（如「每周固定闭馆（泳池换水维护）：周三 12:00-14:00」）。排课、批量排课、预约、候补递补、课程改期统一走这套判定。
- **登记不可用时段**：若时段内已有排课，接口会列出全部冲突课程及预约人数，必须随登记一并选择**取消（自动退次）或改期**（改期会再次校验冲突与可用性），时段生效与课程处理在同一事务内完成。
- **批量排课**：按「每周哪几天 + 开始时间 + 日期区间」展开槽位，逐槽位校验，能排的排、不能排的跳过并逐条给出原因（单次最多 62 天）。
- **候补递补**：课程满员后可加入候补队列（每人每课一条）；预约取消释放名额时，在同一事务内按排队顺序自动递补（跳过无可用卡的会员），递补前重新校验场地可用性——场地已停用时不递补并说明原因；也支持手动触发递补。
- **约课**：事务内完成「重复预约 → 满员 → 选可用卡 → 次卡预扣 → 生成核销码」，有效预约对 `(class_id, member_id)` 有数据库级唯一约束。
- **取消预约**：开课前 **≥2 小时**取消自动退还课次；不足 2 小时允许取消但不退次（记录取消原因）。
- **整课取消**：已预约的学员全部取消并退次，候补队列一并关闭。
- **核销**：6 位核销码 + 2 小时时间窗 + 会员卡有效（期限卡未过期、次卡有余量）+ 防重复。
- **续费**：期限卡未过期从原到期日顺延、已过期从当天顺延；次卡增加次数并自动恢复有效；写入续费流水并关闭对应提醒。
- **自动状态**：查询时自动把到期的期限卡置为 `expired`、次数耗尽的次卡置为 `used_up`，并增量生成提醒（不会重复打扰）。

## 样例数据

内置 6 位教练、20 位会员、18 张覆盖各种状态的会员卡（有效/即将到期/已过期/次数不足/用完/冻结）、
5 块场地、8 项器械、3 条场地不可用时段（泳池每周三换水 + 一次性检修、瑜伽室每周一清洁）、
近 3 周共 60+ 节课、200+ 条预约（含已核销/已取消/未到店）、满员课的候补队列，以及自动生成的提醒。

后端自带一份 52 项断言的端到端测试（约课 → 取消退次 → 重约 → 核销拦截 → 续费 → 闭馆时段拦截 → 批量排课 → 冲突课程改期/取消 → 候补递补等）：

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
GET/POST/PUT /api/venues   GET  /api/venues/week          未来 7 天可用性视图
                           GET/POST/DELETE /api/venues/blocks(/:id)   不可用时段
                           POST /api/venues/blocks/preview            登记前冲突预检
                           GET/POST/PUT /api/venues/equipment(/:id)
GET/POST /api/classes      POST /api/classes/batch        批量生成课表
                           POST /api/classes/:id/cancel | /move       整课取消 / 改期
GET/POST /api/bookings     POST /api/bookings/:id/cancel（取消后自动触发候补递补）
GET/POST /api/waitlists    POST /api/waitlists/:id/cancel  候补队列 / 取消候补
                           POST /api/waitlists/promote     手动触发递补
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
│   │   ├── venueAvailability.js # 场地可用性三层叠加判定
│   │   ├── classOps.js       # 整课取消退次 / 课程改期
│   │   ├── waitlistLogic.js  # 候补递补
│   │   └── routes/           # 各业务模块路由
│   └── e2e-test.mjs          # API 端到端冒烟测试
└── client/
    └── src/
        ├── App.jsx           # 布局/导航/路由
        ├── api.js            # 请求封装与格式化工具
        └── pages/            # 10 个页面
```
