import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const { Pool } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false } });
try {
  const sql = fs.readFileSync(path.join(here, '../sql/schema.sql'), 'utf8');
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  await pool.query(sql);
  console.log('Database schema applied.');
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await pool.end(); }
