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

-- 周课模板：记录每周固定开的团课（星期几 + 开课时间 + 时长 + 教练/场地/容量/消耗课次）
CREATE TABLE IF NOT EXISTS class_templates (
  id               SERIAL PRIMARY KEY,
  title            VARCHAR(80) NOT NULL,
  weekday          SMALLINT NOT NULL,          -- 0=周日 ... 6=周六
  start_time       VARCHAR(5) NOT NULL,        -- "19:00"
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  coach_id         INTEGER REFERENCES coaches(id) ON DELETE SET NULL,
  venue_id         INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  capacity         INTEGER NOT NULL DEFAULT 10,
  cost_sessions    INTEGER NOT NULL DEFAULT 1, -- 每人消耗课次
  status           VARCHAR(10) DEFAULT 'active', -- active / inactive
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- 模板批量生成批次（一次“选连续几周生成”就是一条批次，支持整批撤回）
CREATE TABLE IF NOT EXISTS class_generation_batches (
  id             SERIAL PRIMARY KEY,
  week_start     DATE NOT NULL,               -- 本次生成的周一
  week_end       DATE NOT NULL,               -- 最后一个周日
  weeks          INTEGER NOT NULL,
  created_count  INTEGER NOT NULL DEFAULT 0,
  existing_count INTEGER NOT NULL DEFAULT 0,
  skipped_count  INTEGER NOT NULL DEFAULT 0,
  result_json    JSONB,                       -- 新增/已存在/跳过明细（含跳过原因）
  status         VARCHAR(10) DEFAULT 'completed', -- completed / revoked
  created_at     TIMESTAMPTZ DEFAULT now(),
  revoked_at     TIMESTAMPTZ
);

-- 场地不可用时段：可表示某天全天闭馆（00:00-23:59）或某段时间不可用（如场地维护）
CREATE TABLE IF NOT EXISTS venue_unavailable (
  id          SERIAL PRIMARY KEY,
  venue_id    INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,                  -- 可跨多天
  start_time  VARCHAR(5) NOT NULL DEFAULT '00:00',
  end_time    VARCHAR(5) NOT NULL DEFAULT '23:59',
  reason      VARCHAR(255),
  created_at  TIMESTAMPTZ DEFAULT now()
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
  template_id   INTEGER REFERENCES class_templates(id) ON DELETE SET NULL, -- 来自哪个周课模板
  generation_batch_id INTEGER REFERENCES class_generation_batches(id) ON DELETE SET NULL, -- 由哪个批次生成
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

-- ============================================================================
-- 升级顺序说明（重要）：
--   老库的 classes 是旧版本建的，CREATE TABLE IF NOT EXISTS 不会自动补列。
--   因此必须严格按「① 建全部表 → ② 幂等补列 → ③ 建索引」执行：
--   任何引用 template_id / generation_batch_id 的索引都必须排在补列之后，
--   否则老库升级会报 column "template_id" does not exist 并中断启动。
-- ============================================================================

-- ② 幂等补列：给旧版库补充周课模板相关字段（PGlite / PostgreSQL 通用）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='classes' AND column_name='template_id') THEN
    ALTER TABLE classes ADD COLUMN template_id INTEGER REFERENCES class_templates(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='classes' AND column_name='generation_batch_id') THEN
    ALTER TABLE classes ADD COLUMN generation_batch_id INTEGER REFERENCES class_generation_batches(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ③ 补列完成后再统一建索引（新库列已在 CREATE TABLE 内，老库由上面补列，二者均安全）
CREATE INDEX IF NOT EXISTS idx_classes_start ON classes(start_at);
CREATE INDEX IF NOT EXISTS idx_classes_batch ON classes(generation_batch_id);
CREATE INDEX IF NOT EXISTS idx_bookings_member ON bookings(member_id);
CREATE INDEX IF NOT EXISTS idx_bookings_class ON bookings(class_id);
CREATE INDEX IF NOT EXISTS idx_cards_member ON membership_cards(member_id);
CREATE INDEX IF NOT EXISTS idx_schedules_date ON coach_schedules(work_date);
CREATE INDEX IF NOT EXISTS idx_venue_unavailable ON venue_unavailable(venue_id, start_date, end_date);

-- 幂等保证：同一个模板在同一时刻只能有一节“未取消”的课
-- （重复生成不会排出两套；已取消的课不占位，允许重新补排）
-- 老库历史课程 template_id 为 NULL，被 WHERE 条件排除，不会触发唯一冲突
CREATE UNIQUE INDEX IF NOT EXISTS uq_class_template_occurrence
  ON classes(template_id, start_at)
  WHERE template_id IS NOT NULL AND status <> 'canceled';
