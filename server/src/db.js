// 数据库适配层：
// - 默认使用 PGlite（嵌入式 PostgreSQL，数据落盘到本地目录，零配置）
// - 设置环境变量 DATABASE_URL 后自动切换为真实 PostgreSQL（pg.Pool）
// 两种后端都暴露相同的 query / withTransaction 接口
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const connectionString = process.env.DATABASE_URL;
// 业务按本地日历（默认东八区）计算“今天/到期日”，避免部署在 UTC 服务器时跨天差一天
const APP_TZ = process.env.APP_TZ || 'Asia/Shanghai';

let engine;
let pool;

const mode = connectionString ? 'postgres' : 'pglite';
export const DB_MODE = mode;

if (connectionString) {
  pool = new pg.Pool({ connectionString });
  // 每个连接固定会话时区
  pool.on('connect', (client) => client.query(`SET TIME ZONE '${APP_TZ}'`));
  engine = {
    query: (text, params) => pool.query(text, params),
  };
} else {
  const dataDir = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', '.pglite-data');
  engine = new PGlite(dataDir);
}

// 启动时先把会话时区设好（PGlite 为单连接，设置后全程生效）
export const dbReady = engine.query(`SET TIME ZONE '${APP_TZ}'`);

export async function query(text, params) {
  return engine.query(text, params);
}

// 执行多语句 DDL（建表脚本）
export async function execSql(sqlText) {
  if (mode === 'postgres') {
    return pool.query(sqlText);
  }
  return engine.exec(sqlText);
}

// 在一个事务里执行 fn(tx)，fn 中统一使用 tx.query
export async function withTransaction(fn) {
  if (mode === 'postgres') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  // PGlite 自带事务 API
  return engine.transaction((tx) => fn(tx));
}

export async function closeDb() {
  if (mode === 'postgres') {
    await pool.end();
  } else {
    await engine.close();
  }
}
