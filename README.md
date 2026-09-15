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
| 📅 课表排课 | 按天查看课表、排课自动校验**教练冲突、场地冲突、场地容量上限、场地开放状态**；整节课取消并批量退次；课程单节改派 |
| 📝 预约管理 | 代客约课，自动选卡、**次卡预扣次数**、满员/重复/过期卡拦截；取消预约按规则退次 |
| 🏋️ 教练管理 | 教练档案、专长、课时费、停用/启用 |
| ⏰ 教练排班 | 周视图排班（早/正常/晚班），时间重叠自动拦截 |
| 🔄 请假与改派 | 登记教练请假时段、**受影响课程一键批量改派**（自动校验代课人当天排班、撞课、本人是否在请假）、原教练→代课教练全程留痕、销假 |
| 💰 课时结算 | 月度结算单：正常授课/代课/取消/未到店分开统计，**请假时段课程不计入请假教练收入**；出单后课程锁定，更正走**调整记录冲抵下期**，不改已出数字 |
| 🏟️ 场地与器械 | 场地开放/关闭（关闭后不可排课）、器械台账、正常/维修中/报废流转 |
| ✅ 到店核销 | 输入 6 位核销码核销，限**开课前 2 小时窗口**；防重复核销、卡有效性校验；支持手动核销 |
| 🔔 续费提醒 | 期限卡 7 天内到期/已过期、次卡剩余 ≤3 次自动生成提醒；续费后自动消除；可标记已通知/忽略 |

## 核心业务规则

- **约课**：事务内完成「重复预约 → 满员 → 选可用卡 → 次卡预扣 → 生成核销码」，有效预约对 `(class_id, member_id)` 有数据库级唯一约束。
- **取消预约**：开课前 **≥2 小时**取消自动退还 1 次课；不足 2 小时允许取消但不退次（记录取消原因）。
- **整课取消**：已预约的学员全部取消并退次。
- **核销**：6 位核销码 + 2 小时时间窗 + 会员卡有效（期限卡未过期、次卡有余量）+ 防重复。
- **续费**：期限卡未过期从原到期日顺延、已过期从当天顺延；次卡增加次数并自动恢复有效；写入续费流水并关闭对应提醒。
- **请假登记**：按时段登记，与已有请假重叠自动拦截；登记后立即列出受影响课程。
- **课程改派**：逐节校验「代课人当天排班覆盖课程时段、不与其他课程撞课、本人不在请假」；首次改派把原教练记入 `original_coach_id`，课表上可见「原 → 现」；批量改派任一失败则整体回滚。
- **课时结算**：只能为**已完整结束的月份**出单；每节课按实际结果归类——`正常授课`（有核销且原教练授课）、`代课`（有核销且被改派过，按代课人费率计）、`取消`、`未到店`（结课时无人核销）、`请假不计费`（授课时教练处于请假期）；计费 = 课时 × 教练课时费，取消/未到店/请假不计费只计节数。
- **账期隔离**：每期结算单**只含本账期的课程**，不吞其他月份的课；早期月份漏结算的，补出对应月份的账单即可，各期互不串账。
- **结算锁定**：出单后该账期课程写入 `locked_period`，**取消、改派、补排课一律拦截**；需要更正时创建调整记录（补发/扣减），已出结算单数字永不回改。
- **调整冲抵**：调整记录自动归属被更正课程的账期（`source_period`），只会被**更晚账期**的结算单吸收——8 月的扣款进 9 月及以后的账单，补出的历史账单不会吞掉它。
- **自动状态**：查询时自动把到期的期限卡置为 `expired`、次数耗尽的次卡置为 `used_up`，并增量生成提醒（不会重复打扰）。

## 样例数据

内置 6 位教练、20 位会员、18 张覆盖各种状态的会员卡（有效/即将到期/已过期/次数不足/用完/冻结）、
5 块场地、8 项器械、上月+近 3 周共 100+ 节课（上月课程用于结算演示）、300+ 条预约（含已核销/已取消/未到店）、
2 条请假记录（王磊上月请假且课程已部分改派；张猛未来 2 天请假待改派，可在界面上演练）、以及自动生成的提醒。

后端自带一份 45 项断言的端到端测试（约课 → 取消退次 → 重约 → 核销拦截 → 续费 → 请假改派 → 结算锁定 → 调整冲抵 → 账期串扰防护等）：

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
GET/POST /api/classes      POST /api/classes/:id/cancel | /:id/reassign
GET/POST /api/bookings     POST /api/bookings/:id/cancel
GET  /api/checkins/today   POST /api/checkins/verify | /:id/check
GET  /api/reminders        POST /api/reminders/:id/status
GET/POST /api/leaves       GET  /api/leaves/:id/affected
                           POST /api/leaves/:id/reassign | /:id/cancel
GET  /api/reassignments                         改派记录（原教练→代课教练）
GET/POST /api/settlements  GET  /api/settlements/:period   结算批次/生成/明细
                           GET/POST /api/settlements/adjustments(/list)  调整记录
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
│   │   ├── reassign.js       # 课程改派共享校验（排班/撞课/请假/锁定）
│   │   └── routes/           # 各业务模块路由（含 leaves / reassignments / settlements）
│   └── e2e-test.mjs          # API 端到端冒烟测试
└── client/
    └── src/
        ├── App.jsx           # 布局/导航/路由
        ├── api.js            # 请求封装与格式化工具
        └── pages/            # 12 个页面（含 请假与改派、课时结算）
```
