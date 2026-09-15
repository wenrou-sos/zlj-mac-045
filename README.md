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
| 📊 工作台 | 核心指标（会员数/今日课程/核销数/到期数…）、近 7 天开课核销趋势、今日待核销、待处理提醒（数字与经营报表共用同一口径层） |
| 📈 经营报表 | 自选时间范围统计**上座率/满员率/座位利用率、会员新增流失、各卡种销量与续费金额、净收入**；按课程/场地两级下钻到课节与预约名单；口径说明常驻页面；CSV 导出按角色脱敏；历史周/月结账冻结 |
| 👤 会员管理 | 会员档案、搜索、新增/编辑、会员卡与预约历史 |
| 💳 会员卡 | 开卡（月/季/半年/年卡、10~50 次卡）、续费（延期/加次）、冻结/解冻、续费记录 |
| 📅 课表排课 | 按天查看课表、排课自动校验**教练冲突、场地冲突、场地容量上限、场地开放状态**；整节课取消并批量退次 |
| 📝 预约管理 | 代客约课，自动选卡、**次卡预扣次数**、满员/重复/过期卡拦截；取消预约按规则退次 |
| 🏋️ 教练管理 | 教练档案、专长、课时费、停用/启用 |
| ⏰ 教练排班 | 周视图排班（早/正常/晚班），时间重叠自动拦截 |
| 🏟️ 场地与器械 | 场地开放/关闭（关闭后不可排课）、器械台账、正常/维修中/报废流转 |
| ✅ 到店核销 | 输入 6 位核销码核销，限**开课前 2 小时窗口**；防重复核销、卡有效性校验；支持手动核销 |
| 🔔 续费提醒 | 期限卡 7 天内到期/已过期、次卡剩余 ≤3 次自动生成提醒；续费后自动消除；可标记已通知/忽略 |

## 核心业务规则

- **约课**：事务内完成「重复预约 → 满员 → 选可用卡 → 次卡预扣 → 生成核销码」，有效预约对 `(class_id, member_id)` 有数据库级唯一约束。
- **取消预约**：开课前 **≥2 小时**取消自动退还 1 次课；不足 2 小时允许取消但不退次（记录取消原因）。
- **整课取消**：已预约的学员全部取消并退次。
- **核销**：6 位核销码 + 2 小时时间窗 + 会员卡有效（期限卡未过期、次卡有余量）+ 防重复。
- **续费**：期限卡未过期从原到期日顺延、已过期从当天顺延；次卡增加次数并自动恢复有效；写入续费流水并关闭对应提醒。
- **自动状态**：查询时自动把到期的期限卡置为 `expired`、次数耗尽的次卡置为 `used_up`，并增量生成提醒（不会重复打扰）。
- **经营报表口径 v1**（页面「统计口径」面板与 `server/src/metrics.js` 一一对应）：
  - 上座率 = 核销 ÷ 有效预约（有效预约 = 已核销 + 未到店）；满员率 = 满员课节 ÷ 实际开课；座位利用率 = 有效预约 ÷ 开课座位。
  - **整课取消**：不计开课、不进分母，单列「取消课节」；其下预约不算有效预约（系统退次）。
  - **会员取消预约**（含临期不退次）：不占座、单列；**未到店**：占座进分母但不进核销分子，课程结束自动结转。
  - **流失**：无有效卡且最近到店/开卡/续费满 30 天；续费或重开卡自动回流。
  - **退款**：独立退款流水，净收入 = 新开卡 + 续费 − 退款；一律按业务时区（东八区）日历日归属。
  - **数字一致性**：工作台与报表都只从 `metrics.js` 取数，同一时间段必然相同。
  - **历史冻结**：周/月结束满 3 天可结账，快照永久绑定当时口径版本，之后规则升级只影响新期间。
- **导出权限矩阵**（请求头 `X-User-Role`：`front_desk` / `manager` / `investor`）：

  | 能力 | 前台 | 店长 | 投资人 |
  | --- | --- | --- | --- |
  | 上座/汇总数据 | ✅（无金额） | ✅ | ✅ |
  | 会员新增/流失名单 | ✅（**不含手机号**） | ✅（含手机号） | ❌ 403 |
  | 卡种销量/续费金额 | ✅（仅张数） | ✅ | ✅ |
  | 退款流水 / 登记退款 | ❌ | ✅ | ❌ |
  | 周/月结账冻结 | ❌ | ✅ | ❌ |
  | 课节预约名单导出 | ✅（**不含手机号**） | ✅（含手机号） | — |

  每次导出写入 `report_exports` 审计（登录账号、角色、报表、区间、行数、被屏蔽字段）。

- **登录与鉴权（角色不可伪造）**：报表接口必须先 `POST /api/auth/login` 拿不透明令牌，之后请求带
  `Authorization: Bearer <token>`；角色**只从服务端会话实时读取**，令牌本身不含角色。
  任何客户端发送的 `X-User-Role` 头一律返回 **403**，无令牌返回 **401**（前端自动跳登录页）。
  演示账号（密码 scrypt 加盐存储）：

  | 账号 | 密码 | 角色 |
  | --- | --- | --- |
  | `manager` | `manager123` | 店长（全部数据 / 退款 / 结账冻结） |
  | `front` | `front123` | 前台（名单无手机号、无金额） |
  | `investor` | `investor123` | 投资人（经营/财务汇总，无会员明细） |

- **冻结期间强制读快照**：当查询/导出区间恰好等于某个已结账的周/月，接口自动改读
  `report_snapshots`（响应 `frozen:true`，导出文件名与首行标注「结账冻结快照 vN」），
  即使底层历史数据之后被改动，重查与导出仍是结账当时的数字；区间不等于整周/月时仍为实时数据。

## 样例数据

内置 6 位教练、20 位会员、18 张覆盖各种状态的会员卡（有效/即将到期/已过期/次数不足/用完/冻结）、
5 块场地、8 项器械、近 3 周共 60+ 节课、200+ 条预约（含已核销/已取消/未到店）、以及自动生成的提醒。

后端自带一份 16 项断言的端到端测试（约课 → 取消退次 → 重约 → 核销拦截 → 续费等）：

```bash
# 先启动后端，再执行：
node server/e2e-test.mjs          # 或 npm run test:e2e（业务流，不污染数据）
node server/report-test.mjs       # 或 npm run test:reports（28 项：鉴权防伪造/冻结读快照/不重复全量/对账，结束自动 reseed）
```

## 性能与历史口径

- 已结束日期增量写入 `daily_metrics` / `daily_group_metrics` 日级汇总表，并在 `rollup_state`
  记录每个日期是否已物化：**每个历史日只计算一次**（昨天每天重算 1 次以接纳当日补录），
  重复的周/月查询重算天数为 0、直接对汇总行求和，耗时与区间长度、底层预约量无关。
  当天数据实时聚合后与历史汇总拼接；启动时后台一次性回填缺口（不阻塞启动）。
- 巡检（结课转 `finished`/未到店、会员流失判定）进程内 60 秒节流并合并并发，不再每个请求全表 UPDATE。
- 历史周/月在结束满 3 天后自动（或店长手动）结账，结果连同**口径版本号**冻结进 `report_snapshots`；
  下个月甚至明年再打开（查询或导出），看到的仍是结账当时的数字。口径只追加版本、不覆盖历史。

## API 一览

```
POST /api/auth/login | /api/auth/logout   登录（返回 Bearer 令牌）/ 登出
GET  /api/dashboard/stats | /trend        工作台统计与趋势（与报表同口径）
GET  /api/reports/frozen-periods          已冻结周/月列表（需登录）
GET  /api/reports/summary                 区间总览（整周/月命中冻结则读快照）
GET  /api/reports/attendance?dim=course|venue         按课程/场地分组
GET  /api/reports/attendance/details                  分组下钻到课节
GET  /api/reports/classes/:id/roster                  单课预约名单（手机号按角色下发）
GET  /api/reports/members?kind=new|lost               新增/流失会员（投资人 403）
GET  /api/reports/card-sales                          卡种销量与续费金额
GET/POST /api/reports/refunds                         退款流水/登记（仅店长）
GET  /api/reports/caliber                             口径版本（公开）
POST /api/reports/freeze                              周/月结账冻结（仅店长）
GET  /api/reports/frozen/:type/:key                   直接读冻结快照
GET  /api/reports/export/:report                      CSV 导出（整周/月读快照，按角色脱敏，写审计）
GET/POST /api/members      GET/PUT /api/members/:id
GET/POST /api/cards        POST /api/cards/:id/renew | /freeze
                           GET  /api/cards/renewals/list
GET/POST /api/coaches      PUT  /api/coaches/:id
GET/POST/DELETE /api/schedules
GET/POST/PUT /api/venues   GET/POST/PUT /api/venues/equipment(/:id)
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
