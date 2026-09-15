-- 健身场馆管理系统 表结构（标准 SQL，兼容 PostgreSQL / PGlite）
-- 注意：PGlite 建表时即校验外键目标存在，因此本脚本严格按依赖顺序排列。

-- ============ 业务基础表 ============

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

-- ============ 操作员账号 / 角色 / 会话 / 审计 / 退款 ============

-- 操作员账号：role = manager（店长）/ front_desk（前台）/ coach（教练）
-- coach 角色通过 coach_id 关联教练档案，用于「只能看自己的课和排班」的数据级隔离
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(50) UNIQUE NOT NULL,   -- 登录名
  display_name  VARCHAR(50) NOT NULL,          -- 显示名（审计里展示）
  password_hash VARCHAR(200) NOT NULL,         -- scrypt: salt:hash
  role          VARCHAR(12) NOT NULL CHECK (role IN ('manager','front_desk','coach')),
  coach_id      INTEGER REFERENCES coaches(id) ON DELETE SET NULL,
  status        VARCHAR(10) NOT NULL DEFAULT 'active', -- active / disabled
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 登录会话（不透明 token；服务端持有，可通过停用账号/删除会话立即失效）
CREATE TABLE IF NOT EXISTS user_sessions (
  token         VARCHAR(80) PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT now(),
  last_used_at  TIMESTAMPTZ DEFAULT now(),
  user_agent    VARCHAR(255)
);

-- 退款单据：退款或退次有争议时，从审计记录反查到的具体业务单据
CREATE TABLE IF NOT EXISTS refunds (
  id            SERIAL PRIMARY KEY,
  card_id       INTEGER REFERENCES membership_cards(id) ON DELETE SET NULL,
  member_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  booking_id    INTEGER REFERENCES bookings(id) ON DELETE SET NULL, -- 关联预约（按单退时）
  amount        NUMERIC(10,2) NOT NULL,              -- 退款金额
  reason        VARCHAR(255),
  refunded_at   TIMESTAMPTZ DEFAULT now(),
  operator_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  operator_name VARCHAR(50) NOT NULL
);

-- 历史续费记录关联到操作员账号（原有 operator 文本列保留，二者并存便于迁移核对）
ALTER TABLE renewals ADD COLUMN IF NOT EXISTS operator_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- 审计日志：只追加。UPDATE/DELETE/TRUNCATE 由文件末尾的触发器在数据库层拒绝，
-- 即使有人拿到业务数据库连接也无法篡改或抹除历史。
CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 操作时间
  actor_id      INTEGER,                             -- 操作人 users.id（历史数据可能为空）
  actor_name    VARCHAR(50) NOT NULL,                -- 操作人姓名（冗余留存，账号删除后仍可读）
  actor_role    VARCHAR(12),
  action        VARCHAR(32) NOT NULL,                -- 动作类型，见服务端 AUDIT_ACTIONS
  target_type   VARCHAR(20),                         -- card / booking / class / refund / renewal ...
  target_id     VARCHAR(40),                         -- 业务单据主键
  card_no       VARCHAR(20),                         -- 关键信息：卡号（便于争议检索）
  member_id     INTEGER,
  amount        NUMERIC(12,2),                       -- 涉及金额（开卡/续费/退款/改价）
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 关键信息 & 改动前后的值
  ip            VARCHAR(64),
  user_agent    VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_card ON audit_logs(card_no);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);

-- ============ 常规索引 ============
CREATE INDEX IF NOT EXISTS idx_classes_start ON classes(start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_member ON bookings(member_id);
CREATE INDEX IF NOT EXISTS idx_bookings_class ON bookings(class_id);
CREATE INDEX IF NOT EXISTS idx_cards_member ON membership_cards(member_id);
CREATE INDEX IF NOT EXISTS idx_schedules_date ON coach_schedules(work_date);

-- ============ 审计日志防篡改：数据库层禁止修改 / 删除 / 清空 ============
-- 业务侧只允许 INSERT。任何 UPDATE / DELETE / TRUNCATE 直接抛错，
-- 连绕过应用直连数据库都无法抹掉记录。
CREATE OR REPLACE FUNCTION audit_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs 为只追加审计记录，禁止 %（已被数据库触发器拦截）', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_no_update ON audit_logs;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_block_mutation();

-- TRUNCATE 是语句级事件，用 TRUNCATE 触发器拦截
DROP TRIGGER IF EXISTS trg_audit_no_truncate ON audit_logs;
CREATE TRIGGER trg_audit_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_block_mutation();
