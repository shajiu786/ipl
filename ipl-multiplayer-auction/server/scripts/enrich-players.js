// Fetch player photos (Wikipedia) and career IPL stats (Cricsheet) and save them on the players table.
//   npm run enrich:players                 -> only players that are missing a photo / stats
//   npm run enrich:players -- --force      -> refresh everything (use at the start of a new season)
//   npm run enrich:players -- --stats      -> stats only      (--photos for photos only)
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { enrichAll } from '../src/services/enrich.js';
const { Pool } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const only = args.has('--stats') ? 'stats' : args.has('--photos') ? 'photos' : null;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false } });
try {
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS stats JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS stats_updated_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS photo_source TEXT`);
  await enrichAll(pool, {
    force: args.has('--force'), stats: only !== 'photos', photos: only !== 'stats',
    aliasFile: path.join(here, '../../data/player_aliases.json'),
    photoFile: path.join(here, '../../data/player_photos.json')
  });
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await pool.end(); }
