import 'dotenv/config';
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import pg from 'pg';
const { Pool } = pg;
const file = process.argv[2];
if (!file) { console.error('Usage: npm run import:csv -- ../data/ipl_auction_players_24_sets.csv'); process.exit(1); }
const records = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false } });
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pick = (r, keys) => { const k = Object.keys(r).find(x => keys.includes(norm(x))); return k ? r[k] : null; };
const moneyToPaise = (v, sourceKey = '') => {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).replace(/[₹,\\s]/g, '');
  const n = Number(s.replace(/(cr|crore|lakh|lakhs)$/i, ''));
  if (!Number.isFinite(n)) return null;
  const key = norm(sourceKey);
  if (key.includes('lakh') || /lakh(s)?$/i.test(s)) return Math.round(n * 10000000); // 1 lakh = 10,000,000 paise
  return Math.round(n * 1000000000); // default price columns to crore
};
try {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  await pool.query(`CREATE TABLE IF NOT EXISTS players (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, role TEXT, nationality TEXT, batting_style TEXT, bowling_style TEXT,
    photo_url TEXT, base_price_paise BIGINT, source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_attribution TEXT, data_cutoff DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  let count = 0;
  for (const r of records) {
    const name = pick(r, ['name','playername','fullname','player']);
    if (!name) continue;
    const role = pick(r, ['role','playerrole','category','type']);
    const nationality = pick(r, ['nationality','country','indianoverseas','status']);
    const baseKey = Object.keys(r).find(x => ['baseprice','basepricecr','basepricelakh','price','base'].includes(norm(x)));
    const base = baseKey ? r[baseKey] : null;
    const photo = pick(r, ['photourl','imageurl','photo','image']);
    const attribution = pick(r, ['source','sourceattribution','datasource']);
    const cutoff = pick(r, ['datacutoff','cutoffdate']);
    await pool.query(
      `INSERT INTO players(name, role, nationality, photo_url, base_price_paise, source_data, source_attribution, data_cutoff)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [String(name).trim(), role || null, nationality || null, photo || null, moneyToPaise(base, baseKey || ''), JSON.stringify(r), attribution || null, cutoff || null]
    );
    count++;
  }
  console.log(`Imported ${count} player rows. Source columns preserved in source_data; review mappings and attribution before publishing.`);
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await pool.end(); }
