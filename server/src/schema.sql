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
  original_coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL, -- 改派前的原教练
  venue_id      INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  start_at      TIMESTAMPTZ NOT NULL,
  end_at        TIMESTAMPTZ NOT NULL,
  capacity      INTEGER NOT NULL DEFAULT 10,
  cost_sessions INTEGER NOT NULL DEFAULT 1, -- 消耗课次
  status        VARCHAR(10) DEFAULT 'open',  -- open / canceled / finished
  locked_period VARCHAR(7),                  -- 已结算锁定的账期 '2026-09'，NULL=未锁定
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 老库升级：补充 classes 新列（幂等）
ALTER TABLE classes ADD COLUMN IF NOT EXISTS original_coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS locked_period VARCHAR(7);

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

-- 教练请假时段
CREATE TABLE IF NOT EXISTS coach_leaves (
  id            SERIAL PRIMARY KEY,
  coach_id      INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  start_at      TIMESTAMPTZ NOT NULL,
  end_at        TIMESTAMPTZ NOT NULL,
  reason        VARCHAR(255),
  status        VARCHAR(10) DEFAULT 'active', -- active / canceled（销假）
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 课程改派记录（谁 -> 谁，可关联请假单）
CREATE TABLE IF NOT EXISTS class_reassignments (
  id            SERIAL PRIMARY KEY,
  class_id      INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  leave_id      INTEGER REFERENCES coach_leaves(id) ON DELETE SET NULL,
  from_coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL,
  to_coach_id   INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  note          VARCHAR(255),
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 课时结算批次：一个自然月一期，生成后该时段课程锁定
CREATE TABLE IF NOT EXISTS settlement_batches (
  id            SERIAL PRIMARY KEY,
  period        VARCHAR(7) UNIQUE NOT NULL,   -- '2026-09'
  start_date    DATE NOT NULL,                -- 当月 1 号
  end_date      DATE NOT NULL,                -- 次月 1 号（开区间）
  class_count   INTEGER DEFAULT 0,            -- 纳入结算的课程节数
  total_amount  NUMERIC(12,2) DEFAULT 0,      -- 本期应付合计（含调整冲抵）
  operator      VARCHAR(50) DEFAULT '前台',
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 结算明细：每节课一行 + 调整冲抵行（生成后只读，不再修改）
CREATE TABLE IF NOT EXISTS settlement_items (
  id            SERIAL PRIMARY KEY,
  batch_id      INTEGER NOT NULL REFERENCES settlement_batches(id) ON DELETE CASCADE,
  coach_id      INTEGER REFERENCES coaches(id) ON DELETE SET NULL,
  class_id      INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  category      VARCHAR(16) NOT NULL,  -- normal/substitute/canceled/no_show/leave_excluded/adjustment
  hours         NUMERIC(6,2) DEFAULT 0,
  amount        NUMERIC(10,2) DEFAULT 0, -- 计费金额（取消/未到店/请假排除为 0，调整可正可负）
  note          VARCHAR(255)
);

-- 结算后调整记录：锁定期间的更正，冲抵到后续账期，不改已出数字
CREATE TABLE IF NOT EXISTS settlement_adjustments (
  id            SERIAL PRIMARY KEY,
  coach_id      INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  class_id      INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  amount        NUMERIC(10,2) NOT NULL,       -- 正=补发 负=扣减
  reason        VARCHAR(255) NOT NULL,
  source_period VARCHAR(7),                   -- 被更正的账期（关联课程的锁定账期；无课程则为当前最新账期）
  status        VARCHAR(10) DEFAULT 'pending',-- pending / applied（已并入某期结算）
  applied_period VARCHAR(7),
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 老库升级（幂等）
ALTER TABLE settlement_adjustments ADD COLUMN IF NOT EXISTS source_period VARCHAR(7);

CREATE INDEX IF NOT EXISTS idx_classes_start ON classes(start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_member ON bookings(member_id);
CREATE INDEX IF NOT EXISTS idx_bookings_class ON bookings(class_id);
CREATE INDEX IF NOT EXISTS idx_cards_member ON membership_cards(member_id);
CREATE INDEX IF NOT EXISTS idx_schedules_date ON coach_schedules(work_date);
CREATE INDEX IF NOT EXISTS idx_leaves_coach ON coach_leaves(coach_id);
CREATE INDEX IF NOT EXISTS idx_reassign_class ON class_reassignments(class_id);
CREATE INDEX IF NOT EXISTS idx_items_batch ON settlement_items(batch_id);
