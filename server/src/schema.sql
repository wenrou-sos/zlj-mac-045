-- 健身场馆管理系统 表结构（标准 SQL，兼容 PostgreSQL / PGlite）

CREATE TABLE IF NOT EXISTS coaches (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(50) NOT NULL,
  phone         VARCHAR(20),
  specialty     VARCHAR(100),          -- 专长，如：力量训练 / 瑜伽
  hourly_rate   NUMERIC(10,2) DEFAULT 0,
  status        VARCHAR(10) DEFAULT 'active', -- active / inactive
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(50) NOT NULL,
  phone         VARCHAR(20) UNIQUE NOT NULL,
  gender        VARCHAR(4) DEFAULT '未知',
  joined_at     DATE DEFAULT CURRENT_DATE,
  note          VARCHAR(255),
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 会员卡（一个会员可有多张，同一时间只允许一张 active）
CREATE TABLE IF NOT EXISTS membership_cards (
  id              SERIAL PRIMARY KEY,
  member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  card_no         VARCHAR(20) UNIQUE NOT NULL,
  plan_name       VARCHAR(50) NOT NULL,        -- 月卡 / 季卡 / 次卡 等
  card_type       VARCHAR(10) NOT NULL,       -- period（期限卡）/ count（次卡）
  price           NUMERIC(10,2) DEFAULT 0,
  start_date      DATE NOT NULL,
  end_date        DATE,                       -- 次卡可为空
  total_sessions  INTEGER,                    -- 期限卡为空
  remaining       INTEGER,                    -- 剩余次数（次卡）
  status          VARCHAR(10) DEFAULT 'active', -- active / expired / used_up / frozen
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS venues (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(50) NOT NULL,        -- 动感单车厅 / 瑜伽室 ...
  capacity      INTEGER NOT NULL DEFAULT 10,
  location      VARCHAR(100),
  status        VARCHAR(10) DEFAULT 'open'   -- open / closed
);

CREATE TABLE IF NOT EXISTS equipment (
  id            SERIAL PRIMARY KEY,
  venue_id      INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  name          VARCHAR(50) NOT NULL,        -- 跑步机 / 史密斯架 ...
  asset_no      VARCHAR(30) UNIQUE,
  quantity      INTEGER DEFAULT 1,
  status        VARCHAR(12) DEFAULT 'normal',-- normal / maintenance / scrapped
  purchased_at  DATE,
  note          VARCHAR(255),
  maintain_interval_days INTEGER,            -- 保养周期（天），为空表示不提醒
  last_maintained_at     DATE                -- 上次保养日期
);
-- 老库升级：表已存在时 CREATE TABLE IF NOT EXISTS 不会补列，需显式幂等补齐
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS maintain_interval_days INTEGER; -- 保养周期（天）
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS last_maintained_at DATE;        -- 上次保养日期

-- 维修工单：一台器械同一时间只允许存在一张未完成（待派单/维修中）的工单
CREATE TABLE IF NOT EXISTS repair_orders (
  id            SERIAL PRIMARY KEY,
  equipment_id  INTEGER NOT NULL REFERENCES equipment(id),
  reporter      VARCHAR(50) NOT NULL,        -- 报修人
  fault_desc    VARCHAR(255) NOT NULL,       -- 故障描述
  assignee      VARCHAR(50),                 -- 处理人（维修师傅/责任人）
  status        VARCHAR(12) DEFAULT 'pending', -- pending（待派单）/ processing（维修中）/ done（已完成）/ scrapped（已报废）
  cost          NUMERIC(10,2) DEFAULT 0,     -- 维修费用
  repair_result VARCHAR(255),                -- 维修结果/备注
  scrap_reason  VARCHAR(255),                -- 报废原因
  approver      VARCHAR(50),                 -- 报废审核人
  created_at    TIMESTAMPTZ DEFAULT now(),   -- 报修时间（开工单）
  started_at    TIMESTAMPTZ,                 -- 派单时间
  completed_at  TIMESTAMPTZ                  -- 完成/报废时间
);

-- 同一台器械同时只能有一张未完成工单（数据库级保证）
CREATE UNIQUE INDEX IF NOT EXISTS uq_repair_order_open
  ON repair_orders(equipment_id) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS idx_repair_orders_equipment ON repair_orders(equipment_id);

-- 教练排班
CREATE TABLE IF NOT EXISTS coach_schedules (
  id            SERIAL PRIMARY KEY,
  coach_id      INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  work_date     DATE NOT NULL,
  start_time    VARCHAR(5) NOT NULL,         -- "09:00"
  end_time      VARCHAR(5) NOT NULL,         -- "18:00"
  shift_type    VARCHAR(10) DEFAULT 'normal',-- morning / normal / evening
  UNIQUE (coach_id, work_date, start_time)
);

-- 课表（排课）：某天某时段的一节课
CREATE TABLE IF NOT EXISTS classes (
  id            SERIAL PRIMARY KEY,
  title         VARCHAR(80) NOT NULL,       -- 动感单车 / 普拉提 ...
  coach_id      INTEGER REFERENCES coaches(id) ON DELETE SET NULL,
  venue_id      INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  start_at      TIMESTAMPTZ NOT NULL,
  end_at        TIMESTAMPTZ NOT NULL,
  capacity      INTEGER NOT NULL DEFAULT 10,
  cost_sessions INTEGER NOT NULL DEFAULT 1, -- 消耗课次
  required_equipment_id INTEGER REFERENCES equipment(id) ON DELETE SET NULL, -- 该课所需器械
  required_quantity    INTEGER DEFAULT 0,  -- 所需可用数量
  status        VARCHAR(10) DEFAULT 'open',  -- open / canceled / finished
  created_at    TIMESTAMPTZ DEFAULT now()
);
-- 老库升级：补齐排课所需器械字段（required_equipment_id 的外键约束随列一起添加）
ALTER TABLE classes ADD COLUMN IF NOT EXISTS
  required_equipment_id INTEGER REFERENCES equipment(id) ON DELETE SET NULL;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS required_quantity INTEGER DEFAULT 0;

-- 预约
CREATE TABLE IF NOT EXISTS bookings (
  id            SERIAL PRIMARY KEY,
  class_id      INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  member_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  card_id       INTEGER REFERENCES membership_cards(id) ON DELETE SET NULL,
  verify_code   VARCHAR(8) UNIQUE NOT NULL, -- 到店核销码
  status        VARCHAR(10) DEFAULT 'booked',-- booked / checked / canceled / no_show / evicted
  booked_at     TIMESTAMPTZ DEFAULT now(),
  checked_at    TIMESTAMPTZ,
  canceled_at   TIMESTAMPTZ,
  cancel_reason VARCHAR(255)
);

-- 一节课同一会员只允许存在一条有效预约（已取消的不占名额、可重约）
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_active
  ON bookings(class_id, member_id) WHERE status IN ('booked','checked');

-- 续费记录
CREATE TABLE IF NOT EXISTS renewals (
  id            SERIAL PRIMARY KEY,
  card_id       INTEGER REFERENCES membership_cards(id) ON DELETE SET NULL,
  member_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  amount        NUMERIC(10,2) NOT NULL,
  new_end_date  DATE,
  added_sessions INTEGER,
  renewed_at    TIMESTAMPTZ DEFAULT now(),
  operator      VARCHAR(50) DEFAULT '前台'
);

-- 到期 / 低余额 / 器械保养提醒（member_id / card_id 对器械类提醒为空）
CREATE TABLE IF NOT EXISTS reminders (
  id            SERIAL PRIMARY KEY,
  member_id     INTEGER REFERENCES members(id) ON DELETE CASCADE,
  card_id       INTEGER REFERENCES membership_cards(id) ON DELETE CASCADE,
  equipment_id  INTEGER REFERENCES equipment(id) ON DELETE CASCADE,
  type          VARCHAR(20) NOT NULL,        -- expiring / expired / low_sessions / equipment_maintain
  message       VARCHAR(255) NOT NULL,
  status        VARCHAR(10) DEFAULT 'pending', -- pending / notified / ignored
  created_at    TIMESTAMPTZ DEFAULT now()
);
-- 老库升级：放宽 member_id 与 type 长度、补 equipment_id 列（IF NOT EXISTS 不支持 ADD COLUMN，用 DO 块）
DO $$
BEGIN
  ALTER TABLE reminders ALTER COLUMN member_id DROP NOT NULL;
  ALTER TABLE reminders ALTER COLUMN type TYPE VARCHAR(20);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_classes_start ON classes(start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_member ON bookings(member_id);
CREATE INDEX IF NOT EXISTS idx_bookings_class ON bookings(class_id);
CREATE INDEX IF NOT EXISTS idx_cards_member ON membership_cards(member_id);
CREATE INDEX IF NOT EXISTS idx_schedules_date ON coach_schedules(work_date);
CREATE INDEX IF NOT EXISTS idx_reminders_equipment ON reminders(equipment_id);
