// Cleans a database that was imported more than once (or from the raw CSV with its repeated rows).
// For every player name it keeps one row and deletes the others, unless an old room still points at them.
//   npm run dedupe:players            -> shows what it would do
//   npm run dedupe:players -- --apply -> does it
import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;
const apply = process.argv.includes('--apply');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false } });
try {
  const { rows } = await pool.query(`
    SELECT p.id, p.name, p.source_data, p.dataset,
      (SELECT COUNT(*) FROM room_squad_players s WHERE s.player_id=p.id) +
      (SELECT COUNT(*) FROM auction_bids b WHERE b.player_id=p.id) +
      (SELECT COUNT(*) FROM playing_xi x WHERE x.player_id=p.id) AS refs
    FROM players p ORDER BY p.id`);
  const key = n => String(n).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const groups = new Map();
  for (const r of rows) { const k = `${r.dataset}|${key(r.name)}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  let remove = 0, blocked = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const isDup = r => String(r.source_data?.duplicate_in_pool).toLowerCase() === 'true';
    const keep = [...list].sort((a, b) => (Number(b.refs > 0) - Number(a.refs > 0)) || (Number(isDup(a)) - Number(isDup(b))) || (a.id - b.id))[0];
    for (const r of list) {
      if (r.id === keep.id) continue;
      if (Number(r.refs) > 0) { blocked++; console.log(`kept (used by an old room): ${r.name} #${r.id}`); continue; }
      remove++;
      console.log(`${apply ? 'deleting' : 'would delete'}: ${r.name} #${r.id} (keeping #${keep.id})`);
      if (apply) await pool.query('DELETE FROM players WHERE id=$1', [r.id]);
    }
  }
  console.log(`${remove} duplicate rows ${apply ? 'deleted' : 'found'}${blocked ? `, ${blocked} still referenced by old rooms` : ''}. Players left: ${rows.length - (apply ? remove : 0)}.`);
  if (!apply && remove) console.log('Run again with --apply to delete them.');
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await pool.end(); }
