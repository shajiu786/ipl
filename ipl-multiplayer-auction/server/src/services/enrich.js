// Fetches player photos (Wikipedia) and career IPL stats (Cricsheet ball-by-ball data)
// and writes them to the players table.
//
//  * Photos come from the Wikipedia page of the cricketer (thumbnail of the lead image).
//    Wikimedia images carry their own licences; photo_source records the page they came from.
//  * Stats are computed from Cricsheet's IPL archive (https://cricsheet.org, ODC-BY licence).
//    Super overs are excluded. Stats are IPL-only and as of the newest match in the archive.
//
// Everything that does not need the network or the database is exported separately so it can be tested.

import zlib from 'node:zlib';
import fs from 'node:fs';
import { normName } from './auction.js';

export const CRICSHEET_URL = process.env.CRICSHEET_URL || 'https://cricsheet.org/downloads/ipl_json.zip';
const UA = process.env.WIKI_USER_AGENT || 'ipl-auction-fan-project/1.0 (educational; set WIKI_USER_AGENT with your contact)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ zip (no dependency) */

export function* readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    yield { name, read: () => (method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw)) };
  }
}

/* ------------------------------------------------------------------ cricsheet -> career stats */

const NOT_BOWLER_WICKETS = new Set(['run out', 'retired hurt', 'retired out', 'retired not out', 'obstructing the field', 'handled the ball', 'hit the ball twice', 'timed out']);
const NOT_DISMISSALS = new Set(['retired hurt', 'retired not out']);
const blank = () => ({
  matches: 0, lastDate: null,
  bat: { inns: 0, runs: 0, balls: 0, outs: 0, hs: 0, hsNotOut: false, fifties: 0, hundreds: 0, fours: 0, sixes: 0 },
  bowl: { inns: 0, balls: 0, runs: 0, wkts: 0, bestW: 0, bestR: 0, fourW: 0, fiveW: 0 }
});

export function accumulateMatch(match, acc) {
  const info = match?.info || {};
  const names = new Set(Object.values(info.players || {}).flat());
  const date = (info.dates || [])[0] || null;
  const touch = n => { if (!acc.has(n)) acc.set(n, blank()); return acc.get(n); };
  for (const n of names) { const s = touch(n); s.matches++; if (date && (!s.lastDate || date > s.lastDate)) s.lastDate = date; }

  for (const inn of match?.innings || []) {
    if (inn.super_over) continue;
    const batted = new Map(), bowled = new Map();
    const bi = n => { if (!batted.has(n)) batted.set(n, { runs: 0, balls: 0, out: false, fours: 0, sixes: 0 }); return batted.get(n); };
    const wi = n => { if (!bowled.has(n)) bowled.set(n, { balls: 0, runs: 0, wkts: 0 }); return bowled.get(n); };
    for (const over of inn.overs || []) {
      for (const d of over.deliveries || []) {
        const ex = d.extras || {}, r = d.runs || {};
        const wide = Number(ex.wides) > 0, noball = Number(ex.noballs) > 0;
        const bat = bi(d.batter);
        if (d.non_striker) bi(d.non_striker);
        const batterRuns = Number(r.batter || 0);
        bat.runs += batterRuns;
        if (!wide) bat.balls++;
        if (batterRuns === 4 && !r.non_boundary) bat.fours++;
        if (batterRuns === 6) bat.sixes++;
        const bw = wi(d.bowler);
        if (!wide && !noball) bw.balls++;
        bw.runs += batterRuns + Number(ex.wides || 0) + Number(ex.noballs || 0);
        for (const w of d.wickets || []) {
          const out = bi(w.player_out);
          if (!NOT_DISMISSALS.has(w.kind)) out.out = true;
          if (!NOT_BOWLER_WICKETS.has(w.kind)) bw.wkts++;
        }
      }
    }
    for (const [name, b] of batted) {
      const s = touch(name).bat;
      s.inns++; s.runs += b.runs; s.balls += b.balls; s.fours += b.fours; s.sixes += b.sixes;
      if (b.out) s.outs++;
      if (b.runs >= 100) s.hundreds++; else if (b.runs >= 50) s.fifties++;
      if (b.runs > s.hs || (b.runs === s.hs && !b.out)) { s.hs = b.runs; s.hsNotOut = !b.out; }
    }
    for (const [name, w] of bowled) {
      if (!w.balls && !w.runs) continue;
      const s = touch(name).bowl;
      s.inns++; s.balls += w.balls; s.runs += w.runs; s.wkts += w.wkts;
      if (w.wkts >= 5) s.fiveW++; else if (w.wkts === 4) s.fourW++;
      if (w.wkts > s.bestW || (w.wkts === s.bestW && w.runs < s.bestR)) { s.bestW = w.wkts; s.bestR = w.runs; }
    }
  }
}

const r2 = n => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

export function finalizeStats(raw) {
  const b = raw.bat, w = raw.bowl;
  const out = { source: 'cricsheet', scope: 'IPL career', asOf: raw.lastDate, matches: raw.matches, bat: null, bowl: null };
  if (b.inns > 0) out.bat = {
    inns: b.inns, runs: b.runs, balls: b.balls, hs: b.hs, hsNotOut: b.hsNotOut,
    avg: b.outs ? r2(b.runs / b.outs) : null, sr: b.balls ? r2((b.runs / b.balls) * 100) : null,
    fifties: b.fifties, hundreds: b.hundreds, fours: b.fours, sixes: b.sixes
  };
  if (w.inns > 0) out.bowl = {
    inns: w.inns, balls: w.balls, runs: w.runs, wkts: w.wkts,
    avg: w.wkts ? r2(w.runs / w.wkts) : null, econ: w.balls ? r2(w.runs / (w.balls / 6)) : null,
    sr: w.wkts ? r2(w.balls / w.wkts) : null, best: w.wkts ? `${w.bestW}/${w.bestR}` : null, fourW: w.fourW, fiveW: w.fiveW
  };
  return out;
}

export function computeStatsFromZip(zipBuffer, onProgress = () => {}) {
  const acc = new Map();
  let n = 0;
  for (const entry of readZip(zipBuffer)) {
    if (!/\.json$/i.test(entry.name)) continue;
    try { accumulateMatch(JSON.parse(entry.read().toString('utf8')), acc); n++; } catch { /* skip a bad file */ }
    if (n % 200 === 0) onProgress(n);
  }
  return { matches: n, players: acc };
}

/* ------------------------------------------------------------------ matching auction names to Cricsheet names */

// Cricsheet writes "V Kohli", "AB de Villiers" or "Rinku Singh". The auction CSV writes "Virat Kohli".
// Anything the generic rule cannot resolve goes here, or into data/player_aliases.json
// ({ "Auction name": "Cricsheet name" }), which is merged on top of this list.
export const BUILTIN_ALIASES = {
  'dinesh karthik': ['KD Karthik', 'Dinesh Karthik'],
  'vaibhav sooryavanshi': ['V Suryavanshi', 'Vaibhav Suryavanshi'],
  'sai sudharsan': ['B Sai Sudharsan', 'Sai Sudharsan', 'S Sudharsan'],
  'varun chakravarthy': ['CV Varun', 'Varun Chakravarthy', 'V Chakravarthy'],
  'tilak varma': ['N Tilak Varma', 'Tilak Varma'],
  'mohammed siraj': ['Mohammed Siraj', 'M Siraj'],
  'ms dhoni': ['MS Dhoni'],
  'axar patel': ['AR Patel', 'Axar Patel']
};

const split = name => {
  const t = normName(name).split(' ').filter(Boolean);
  return { first: t[0] || '', surname: t.slice(1).join(''), full: t.join('') };
};
const initialsLike = s => s.length <= 3;

export function buildNameIndex(statsMap) {
  const bySurname = new Map(), byFull = new Map();
  for (const [name, s] of statsMap) {
    const p = { name, ...split(name), matches: s.matches };
    byFull.set(p.full, p);
    if (!bySurname.has(p.surname)) bySurname.set(p.surname, []);
    bySurname.get(p.surname).push(p);
  }
  return { bySurname, byFull };
}

export function matchCricsheetName(playerName, index, aliases = {}) {
  const key = normName(playerName);
  const aliasList = [].concat(aliases[key] || BUILTIN_ALIASES[key] || []);
  for (const a of aliasList) {
    const hit = index.byFull.get(split(a).full);
    if (hit) return { name: hit.name, how: 'alias' };
  }
  const p = split(playerName);
  const exact = index.byFull.get(p.full);
  if (exact) return { name: exact.name, how: 'exact' };
  const candidates = index.bySurname.get(p.surname) || [];
  let best = null;
  for (const c of candidates) {
    let score = 0;
    if (!p.first || !c.first) continue;
    if (initialsLike(c.first) && c.first[0] === p.first[0]) score = 1;
    else if (!initialsLike(c.first) && !initialsLike(p.first) && (p.first.startsWith(c.first) || c.first.startsWith(p.first))) score = 2;
    if (!score) continue;
    if (!best || score > best.score || (score === best.score && c.matches > best.c.matches)) best = { c, score, ties: 0 };
    else if (score === best.score) best.ties++;
  }
  if (!best) return null;
  return { name: best.c.name, how: best.ties ? 'ambiguous' : 'initials' };
}

/* ------------------------------------------------------------------ Wikipedia photos */

export async function fetchWikipediaPhoto(name, { fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch: `${name} cricketer`, gsrlimit: '5',
    prop: 'pageimages|description', piprop: 'thumbnail', pithumbsize: '500', redirects: '1'
  });
  const res = await fetchImpl(`https://en.wikipedia.org/w/api.php?${params}`, {
    headers: { 'User-Agent': UA, 'Api-User-Agent': UA }, signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`wikipedia ${res.status}`);
  const json = await res.json();
  const pages = Object.values(json?.query?.pages || {}).sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
  const { surname, first } = split(name);
  const surnameWord = normName(name).split(' ').slice(-1)[0] || surname;
  for (const pg of pages) {
    const title = normName(pg.title);
    if (!/cricket/i.test(pg.description || '')) continue;
    if (!title.includes(surnameWord) || !title.includes(first.slice(0, 3))) continue;
    if (pg.thumbnail?.source) return { url: pg.thumbnail.source, title: pg.title };
  }
  return null;
}

// For players whose role is unknown ("PLAYER" in the mega-auction CSV) guess BAT / BOWL / AR from their IPL record.
// Wicketkeepers cannot be told apart from batters here, so those stay as BAT.
export function inferRole(stats) {
  const bat = stats?.bat, bowl = stats?.bowl;
  const batInns = bat?.inns || 0, bowlInns = bowl?.inns || 0;
  if (batInns + bowlInns < 4) return null;                       // too little data to say
  if (bowlInns && (!batInns || (bowl.balls >= 120 && bat.runs < 150))) return 'BOWL';
  if (batInns && !bowlInns) return 'BAT';
  if (bowl.balls >= 120 && bat.runs >= 150) return 'AR';
  return batInns >= bowlInns ? 'BAT' : 'BOWL';
}

/* ------------------------------------------------------------------ database jobs */

let running = null;

export async function enrichAll(pool, opts = {}) {
  if (running) return running;                       // never run two jobs at once
  running = (async () => {
    const { photos = true, stats = true, force = false, log = console.log, fetchImpl = fetch, aliasFile } = opts;
    const summary = { statsUpdated: 0, statsMissing: [], photosUpdated: 0, photosMissing: [] };
    const { rows: players } = await pool.query('SELECT id, name, role, photo_url, stats FROM players ORDER BY id');
    const needsStats = p => force || !p.stats || !p.stats.source;

    if (stats && players.some(needsStats)) {
      log('Downloading Cricsheet IPL archive…');
      const res = await fetchImpl(CRICSHEET_URL, { signal: AbortSignal.timeout(180000) });
      if (!res.ok) throw new Error(`cricsheet ${res.status}`);
      const zip = Buffer.from(await res.arrayBuffer());
      const { matches, players: acc } = computeStatsFromZip(zip, n => log(`  parsed ${n} matches`));
      log(`Computed stats from ${matches} matches for ${acc.size} players.`);
      let aliases = {};
      try { if (aliasFile && fs.existsSync(aliasFile)) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(aliasFile, 'utf8')))) aliases[normName(k)] = v; } catch { /* ignore bad alias file */ }
      const index = buildNameIndex(acc);
      const done = new Map();
      for (const p of players.filter(needsStats)) {
        const key = normName(p.name);
        if (!done.has(key)) {
          const m = matchCricsheetName(p.name, index, aliases);
          done.set(key, m ? { m, stats: finalizeStats(acc.get(m.name)) } : null);
        }
        const hit = done.get(key);
        if (!hit) { summary.statsMissing.push(p.name); continue; }
        await pool.query('UPDATE players SET stats=$2::jsonb, stats_updated_at=NOW() WHERE id=$1', [p.id, JSON.stringify({ ...hit.stats, matchedAs: hit.m.name, matchHow: hit.m.how })]);
        summary.statsUpdated++;
        if ((!p.role || String(p.role).toUpperCase() === 'PLAYER') && inferRole(hit.stats)) {
          await pool.query("UPDATE players SET role=$2 WHERE id=$1", [p.id, inferRole(hit.stats)]);
          summary.rolesInferred = (summary.rolesInferred || 0) + 1;
        }
        if (hit.m.how === 'ambiguous') log(`  check: "${p.name}" matched "${hit.m.name}" by surname+initial only`);
      }
      summary.statsMissing = [...new Set(summary.statsMissing)];
    }

    if (photos) {
      const cache = new Map();
      for (const p of players.filter(x => force || !x.photo_url)) {
        const key = normName(p.name);
        if (!cache.has(key)) {
          try { cache.set(key, await fetchWikipediaPhoto(p.name, { fetchImpl })); } catch (e) { cache.set(key, undefined); log(`  photo lookup failed for ${p.name}: ${e.message}`); }
          await sleep(250);
        }
        const hit = cache.get(key);
        if (!hit) { summary.photosMissing.push(p.name); continue; }
        await pool.query('UPDATE players SET photo_url=$2, photo_source=$3 WHERE id=$1', [p.id, hit.url, `wikipedia:${hit.title}`]);
        summary.photosUpdated++;
      }
      summary.photosMissing = [...new Set(summary.photosMissing)];
    }
    log(`Done. Stats updated: ${summary.statsUpdated}, photos updated: ${summary.photosUpdated}.`);
    if (summary.statsMissing.length) log(`No stats match for: ${summary.statsMissing.join(', ')}`);
    if (summary.photosMissing.length) log(`No photo found for: ${summary.photosMissing.join(', ')}`);
    return summary;
  })().finally(() => { running = null; });
  return running;
}

// Lightweight, used while an auction is running: fetch one missing photo when a player goes live.
export async function enrichPlayerPhoto(pool, player, opts = {}) {
  if (!player || player.photo_url) return null;
  const hit = await fetchWikipediaPhoto(player.name, opts);
  if (!hit) return null;
  await pool.query('UPDATE players SET photo_url=$2, photo_source=$3 WHERE id=$1 AND photo_url IS NULL', [player.id, hit.url, `wikipedia:${hit.title}`]);
  return hit.url;
}
