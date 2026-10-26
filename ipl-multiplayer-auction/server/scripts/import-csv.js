import 'dotenv/config';
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import pg from 'pg';
import { normName } from '../src/services/auction.js';
const { Pool } = pg;
const file = process.argv[2];
if (!file) { console.error('Usage: npm run import:csv -- ../data/ipl_auction_players_24_sets.csv'); process.exit(1); }
const records = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false } });
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pick = (r, keys) => { const k = Object.keys(r).find(x => keys.includes(norm(x))); return k ? r[k] : null; };
const moneyToPaise = (v, sourceKey = '') => {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).replace(/[₹,\s]/g, '');
  const n = Number(s.replace(/(cr|crore|lakh|lakhs)$/i, ''));
  if (!Number.isFinite(n)) return null;
  const key = norm(sourceKey);
  if (key.includes('lakh') || /lakh(s)?$/i.test(s)) return Math.round(n * 10000000); // 1 lakh = 10,000,000 paise
  return Math.round(n * 1000000000); // default price columns to crore
};
const isDup = r => String(pick(r, ['duplicateinpool']) ?? '').toLowerCase() === 'true';

try {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  // make sure the newer columns exist even if schema.sql was never re-applied
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS external_id TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS stats JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS stats_updated_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS photo_source TEXT`);

  // One row per person. The CSV repeats 45 players in later sets (duplicate_in_pool=True); keep the original.
  const chosen = new Map();
  let skippedDuplicates = 0;
  for (const r of records) {
    const name = pick(r, ['name', 'playername', 'fullname', 'player']);
    if (!name) continue;
    const key = normName(name);
    const cur = chosen.get(key);
    if (!cur) { chosen.set(key, r); continue; }
    skippedDuplicates++;
    if (isDup(cur) && !isDup(r)) chosen.set(key, r);
  }

  let inserted = 0, updated = 0;
  for (const r of chosen.values()) {
    const name = String(pick(r, ['name', 'playername', 'fullname', 'player'])).trim();
    const role = pick(r, ['role', 'playerrole', 'category', 'type']);
    const nationality = pick(r, ['nationality', 'country', 'indianoverseas', 'status']);
    const baseKey = Object.keys(r).find(x => ['baseprice', 'basepricecr', 'basepricelakh', 'price', 'base'].includes(norm(x)));
    const photo = pick(r, ['photourl', 'imageurl', 'photo', 'image']);
    const attribution = pick(r, ['source', 'sourceattribution', 'datasource']);
    const cutoff = pick(r, ['datacutoff', 'cutoffdate']);
    const externalId = pick(r, ['playerid', 'id']);
    const values = [name, role || null, nationality || null, photo || null, moneyToPaise(baseKey ? r[baseKey] : null, baseKey || ''), JSON.stringify(r), attribution || null, cutoff || null, externalId || null];

    // Re-running the import updates the existing row instead of inserting a second copy.
    const existing = await pool.query(
      `SELECT id FROM players WHERE ($1::text IS NOT NULL AND external_id=$1) OR regexp_replace(lower(name),'[^a-z0-9]+',' ','g')=$2 ORDER BY id LIMIT 1`,
      [externalId || null, normName(name)]
    );
    if (existing.rowCount) {
      await pool.query(
        `UPDATE players SET name=$2, role=$3, nationality=$4, photo_url=COALESCE(photo_url,$5), base_price_paise=$6, source_data=$7::jsonb,
           source_attribution=$8, data_cutoff=$9, external_id=$10 WHERE id=$1`,
        [existing.rows[0].id, ...values]
      );
      updated++;
    } else {
      await pool.query(
        `INSERT INTO players(name, role, nationality, photo_url, base_price_paise, source_data, source_attribution, data_cutoff, external_id)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`, values);
      inserted++;
    }
  }
  console.log(`Players: ${inserted} added, ${updated} refreshed, ${skippedDuplicates} repeated CSV rows skipped (${chosen.size} unique players).`);
  console.log('Next: npm run enrich:players   (fetch photos + IPL stats)');
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await pool.end(); }
