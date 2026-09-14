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

let mode;
let engine;
let pool;

if (connectionString) {
  mode = 'postgres';
  pool = new pg.Pool({ connectionString });
  engine = {
    query: (text, params) => pool.query(text, params),
  };
} else {
  mode = 'pglite';
  const dataDir = process.env.PGLITE_DATA_DIR || path.join(__dirname, '..', '.pglite-data');
  engine = new PGlite(dataDir);
}

export const DB_MODE = mode;

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
