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
  note          VARCHAR(255)
);

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
  status        VARCHAR(10) DEFAULT 'open',  -- open / canceled / finished
  created_at    TIMESTAMPTZ DEFAULT now()
);

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

-- 到期 / 低余额提醒
CREATE TABLE IF NOT EXISTS reminders (
  id            SERIAL PRIMARY KEY,
  member_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  card_id       INTEGER REFERENCES membership_cards(id) ON DELETE CASCADE,
  type          VARCHAR(12) NOT NULL,        -- expiring / expired / low_sessions
  message       VARCHAR(255) NOT NULL,
  status        VARCHAR(10) DEFAULT 'pending', -- pending / notified / ignored
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classes_start ON classes(start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_member ON bookings(member_id);
CREATE INDEX IF NOT EXISTS idx_bookings_class ON bookings(class_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status_class ON bookings(class_id, status);
CREATE INDEX IF NOT EXISTS idx_cards_member ON membership_cards(member_id);
CREATE INDEX IF NOT EXISTS idx_cards_created ON membership_cards(created_at);
CREATE INDEX IF NOT EXISTS idx_renewals_date ON renewals(renewed_at);
CREATE INDEX IF NOT EXISTS idx_schedules_date ON coach_schedules(work_date);
CREATE INDEX IF NOT EXISTS idx_members_joined ON members(joined_at);

-- ===================== 经营报表模块 =====================

-- 会员生命周期：流失日（每日巡检满足流失规则时落戳，续费/重开卡自动清空）、最近到店日
-- 用 DO 块做幂等加列（PGlite 多语句执行对 ADD COLUMN IF NOT EXISTS 兼容性不佳）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='members' AND column_name='lost_at') THEN
    ALTER TABLE members ADD COLUMN lost_at DATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='members' AND column_name='last_active_at') THEN
    ALTER TABLE members ADD COLUMN last_active_at DATE;
  END IF;
END $$;

-- 退款流水（开卡退款 source_type='card'，续费退款 source_type='renewal'）
CREATE TABLE IF NOT EXISTS refunds (
  id            SERIAL PRIMARY KEY,
  source_type   VARCHAR(10) NOT NULL,         -- card / renewal
  source_id     INTEGER,                      -- membership_cards.id / renewals.id
  card_id       INTEGER REFERENCES membership_cards(id) ON DELETE SET NULL,
  member_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  amount        NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  reason        VARCHAR(255),
  refunded_at   TIMESTAMPTZ DEFAULT now(),
  created_by    VARCHAR(50) DEFAULT '店长'
);
CREATE INDEX IF NOT EXISTS idx_refunds_date ON refunds(refunded_at);

-- 口径版本：每次修改统计规则发一版，冻结的历史快照永久绑定当时版本
CREATE TABLE IF NOT EXISTS caliber_versions (
  version       SERIAL PRIMARY KEY,
  published_at  TIMESTAMPTZ DEFAULT now(),
  note          TEXT
);

-- 历史期间结账快照（周 / 月，结束 3 天后由系统自动冻结，payload 永久保留）
CREATE TABLE IF NOT EXISTS report_snapshots (
  id              SERIAL PRIMARY KEY,
  period_type     VARCHAR(8) NOT NULL,        -- week / month
  period_start    DATE NOT NULL,
  report_key      VARCHAR(30) NOT NULL,       -- summary / attendance / members / card_sales
  payload         JSONB NOT NULL,
  caliber_version INTEGER NOT NULL,
  generated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (period_type, period_start, report_key, caliber_version)
);

-- 日级经营汇总（只写已结束的日期，增量 upsert，周/月报表直接对它求和）
CREATE TABLE IF NOT EXISTS daily_metrics (
  day                     DATE PRIMARY KEY,
  classes_scheduled       INTEGER DEFAULT 0,  -- 实际开课（不含整课取消）
  classes_canceled        INTEGER DEFAULT 0,
  seats_total             INTEGER DEFAULT 0,  -- 开课座位总数
  seats_effective         INTEGER DEFAULT 0,  -- 有效预约人次（核销+未到店）
  checkins                INTEGER DEFAULT 0,  -- 核销（实际到店）
  no_shows                INTEGER DEFAULT 0,  -- 未到店
  canceled_bookings       INTEGER DEFAULT 0,  -- 会员主动取消的预约
  full_classes            INTEGER DEFAULT 0,  -- 满员课节
  new_members             INTEGER DEFAULT 0,
  lost_members            INTEGER DEFAULT 0,
  card_sales_count        INTEGER DEFAULT 0,  -- 新办卡张数
  card_sales_amount       NUMERIC(12,2) DEFAULT 0,
  card_refund_count       INTEGER DEFAULT 0,
  card_refund_amount      NUMERIC(12,2) DEFAULT 0,
  renewal_count           INTEGER DEFAULT 0,
  renewal_amount          NUMERIC(12,2) DEFAULT 0,
  renewal_refund_count    INTEGER DEFAULT 0,
  renewal_refund_amount   NUMERIC(12,2) DEFAULT 0
);

-- 日 × 维度（课程名 / 场地）汇总，供分组报表与下钻
CREATE TABLE IF NOT EXISTS daily_group_metrics (
  day                 DATE NOT NULL,
  dim                 VARCHAR(8) NOT NULL,    -- course / venue
  dim_key             VARCHAR(80) NOT NULL,   -- 课程标题 / 'venue:<id>'
  dim_name            VARCHAR(80) NOT NULL,
  classes_scheduled   INTEGER DEFAULT 0,
  classes_canceled    INTEGER DEFAULT 0,
  seats_total         INTEGER DEFAULT 0,
  seats_effective     INTEGER DEFAULT 0,
  checkins            INTEGER DEFAULT 0,
  no_shows            INTEGER DEFAULT 0,
  canceled_bookings   INTEGER DEFAULT 0,
  full_classes        INTEGER DEFAULT 0,
  PRIMARY KEY (day, dim, dim_key)
);

-- 导出审计（谁、什么角色、在什么时间范围、导了多少行、屏蔽了哪些字段）
CREATE TABLE IF NOT EXISTS report_exports (
  id            SERIAL PRIMARY KEY,
  role          VARCHAR(12) NOT NULL,
  username      VARCHAR(50),              -- 登录账号（角色只从登录会话取，无法伪造）
  report        VARCHAR(30) NOT NULL,
  params        VARCHAR(255),
  row_count     INTEGER DEFAULT 0,
  masked_fields VARCHAR(255),
  exported_at   TIMESTAMPTZ DEFAULT now()
);

-- 员工账号（演示账号：front/front123、manager/manager123、investor/investor123）
CREATE TABLE IF NOT EXISTS app_secrets (
  key        VARCHAR(50) PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_users (
  id             SERIAL PRIMARY KEY,
  username       VARCHAR(50) UNIQUE NOT NULL,
  display_name   VARCHAR(50) NOT NULL,
  role           VARCHAR(12) NOT NULL,   -- front_desk / manager / investor
  password_hash  TEXT NOT NULL,          -- scrypt 哈希
  password_salt  TEXT NOT NULL,
  status         VARCHAR(10) DEFAULT 'active',
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- 登录会话：token 只以 SHA-256 哈希落库；角色随 staff_users 实时取，令牌本身不含角色、无法提权
CREATE TABLE IF NOT EXISTS login_sessions (
  token_hash  TEXT PRIMARY KEY,
  staff_id    INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_staff ON login_sessions(staff_id);

-- 日汇总物化水位：已计算的日期只算一次（昨天重算 1 天以接纳当日补录），历史查询不再全量重扫
CREATE TABLE IF NOT EXISTS rollup_state (
  day         DATE PRIMARY KEY,
  computed_at TIMESTAMPTZ DEFAULT now()
);

-- 旧库补列（幂等）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='report_exports' AND column_name='username') THEN
    ALTER TABLE report_exports ADD COLUMN username VARCHAR(50);
  END IF;
END $$;
