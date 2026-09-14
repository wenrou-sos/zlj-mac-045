// 手动重置样例数据：npm run seed
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSql, closeDb } from './db.js';
import { seedData } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
await execSql(schema);
const counts = await seedData();
console.log('样例数据已重置：', counts);
await closeDb();
process.exit(0);
