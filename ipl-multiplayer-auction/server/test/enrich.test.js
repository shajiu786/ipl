import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readZip, accumulateMatch, finalizeStats, computeStatsFromZip, buildNameIndex, matchCricsheetName, fetchWikipediaPhoto, enrichAll } from '../src/services/enrich.js';

// ---- tiny zip writer so the reader is tested against a real archive layout
function makeZip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content, stored] of files) {
    const data = Buffer.from(content), comp = stored ? data : zlib.deflateRawSync(data), nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(stored ? 0 : 8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(stored ? 0 : 8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nm, comp); centrals.push(ch, nm); offset += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const del = (batter, ns, bowler, runs, extras, wickets) => ({ batter, non_striker: ns, bowler, runs: { batter: runs, extras: Object.values(extras || {}).reduce((a, b) => a + b, 0), total: runs + Object.values(extras || {}).reduce((a, b) => a + b, 0) }, ...(extras ? { extras } : {}), ...(wickets ? { wickets } : {}) });
const match = () => ({
  info: { dates: ['2025-04-01'], players: { A: ['V Kohli', 'F du Plessis'], B: ['JJ Bumrah'] } },
  innings: [
    { team: 'A', overs: [{ over: 0, deliveries: [
      del('V Kohli', 'F du Plessis', 'JJ Bumrah', 4),
      del('V Kohli', 'F du Plessis', 'JJ Bumrah', 0, { wides: 1 }),
      del('V Kohli', 'F du Plessis', 'JJ Bumrah', 6),
      del('V Kohli', 'F du Plessis', 'JJ Bumrah', 1),
      del('F du Plessis', 'V Kohli', 'JJ Bumrah', 0, null, [{ player_out: 'F du Plessis', kind: 'bowled' }]),
      del('V Kohli', 'F du Plessis', 'JJ Bumrah', 2, { noballs: 1 })
    ] }] },
    { team: 'A', super_over: true, overs: [{ over: 0, deliveries: [del('V Kohli', 'F du Plessis', 'JJ Bumrah', 6)] }] }
  ]
});

test('zip reader handles deflated and stored entries', () => {
  const zip = makeZip([['a.json', '{"x":1}'], ['dir/', ''], ['b.txt', 'hello', true]]);
  const out = [...readZip(zip)].map(e => [e.name, e.read().toString()]);
  assert.deepEqual(out, [['a.json', '{"x":1}'], ['b.txt', 'hello']]);
});

test('stats: balls, runs, extras, wickets, super overs', () => {
  const acc = new Map(); accumulateMatch(match(), acc);
  const k = finalizeStats(acc.get('V Kohli')), f = finalizeStats(acc.get('F du Plessis')), b = finalizeStats(acc.get('JJ Bumrah'));
  assert.equal(k.matches, 1); assert.equal(k.asOf, '2025-04-01');
  assert.equal(k.bat.runs, 13);          // 4+0+6+1+2, super over ignored
  assert.equal(k.bat.balls, 4);          // the wide is not a ball faced
  assert.equal(k.bat.fours, 1); assert.equal(k.bat.sixes, 1);
  assert.equal(k.bat.avg, null);         // never dismissed
  assert.equal(k.bat.sr, 325);
  assert.equal(f.bat.runs, 0); assert.equal(f.bat.balls, 1); assert.equal(f.bat.avg, 0);
  assert.equal(b.bowl.balls, 4);         // wide and no-ball are not legal balls
  assert.equal(b.bowl.runs, 15);         // 4 + (0+1) + 6 + 1 + 0 + (2+1)
  assert.equal(b.bowl.wkts, 1);
  assert.equal(b.bowl.econ, 22.5);
  assert.equal(b.bowl.best, '1/15');
  assert.equal(b.bat, null);
});

test('run outs are not credited to the bowler; retired hurt is not a dismissal', () => {
  const m = match();
  m.innings[0].overs[0].deliveries.push(del('V Kohli', 'F du Plessis', 'JJ Bumrah', 0, null, [{ player_out: 'V Kohli', kind: 'retired hurt' }]));
  m.innings[0].overs[0].deliveries.push(del('V Kohli', 'F du Plessis', 'JJ Bumrah', 0, null, [{ player_out: 'F du Plessis', kind: 'run out' }]));
  const acc = new Map(); accumulateMatch(m, acc);
  assert.equal(finalizeStats(acc.get('JJ Bumrah')).bowl.wkts, 1);
  assert.equal(finalizeStats(acc.get('V Kohli')).bat.avg, null);
});

test('computeStatsFromZip reads a whole archive', () => {
  const zip = makeZip([['1.json', JSON.stringify(match())], ['2.json', JSON.stringify(match())], ['README.txt', 'x']]);
  const { matches, players } = computeStatsFromZip(zip);
  assert.equal(matches, 2);
  assert.equal(finalizeStats(players.get('V Kohli')).bat.runs, 26);
  assert.equal(finalizeStats(players.get('V Kohli')).matches, 2);
});

test('name matching: initials, full names, particles, aliases, popularity tie-break', () => {
  const mk = (n, matches) => [n, { matches }];
  const idx = buildNameIndex(new Map([
    mk('V Kohli', 250), mk('RG Sharma', 260), mk('I Sharma', 90), mk('Rinku Singh', 60), mk('RP Singh', 82), mk('Q de Kock', 100),
    mk('F du Plessis', 140), mk('KD Karthik', 257), mk('AR Patel', 150), mk('PA Patel', 60), mk('KL Rahul', 130), mk('SP Narine', 177)
  ]));
  assert.equal(matchCricsheetName('Virat Kohli', idx).name, 'V Kohli');
  assert.equal(matchCricsheetName('Rohit Sharma', idx).name, 'RG Sharma');
  assert.equal(matchCricsheetName('Rinku Singh', idx).name, 'Rinku Singh');       // exact beats RP Singh's higher match count
  assert.equal(matchCricsheetName('Quinton de Kock', idx).name, 'Q de Kock');
  assert.equal(matchCricsheetName('Faf du Plessis', idx).name, 'F du Plessis');
  assert.equal(matchCricsheetName('KL Rahul', idx).name, 'KL Rahul');
  assert.equal(matchCricsheetName('Sunil Narine', idx).name, 'SP Narine');
  assert.equal(matchCricsheetName('Dinesh Karthik', idx).name, 'KD Karthik');      // built-in alias
  assert.equal(matchCricsheetName('Axar Patel', idx).name, 'AR Patel');
  assert.equal(matchCricsheetName('Unknown Person', idx), null);
  assert.equal(matchCricsheetName('Some Body', idx, { 'some body': 'V Kohli' }).name, 'V Kohli'); // alias file
});

test('wikipedia photo: picks the cricketer page, ignores other people', async () => {
  const fake = body => async () => ({ ok: true, json: async () => body });
  const hit = await fetchWikipediaPhoto('Virat Kohli', { fetchImpl: fake({ query: { pages: {
    1: { index: 2, title: 'Anushka Sharma', description: 'Indian actress', thumbnail: { source: 'https://x/a.jpg' } },
    2: { index: 1, title: 'Virat Kohli', description: 'Indian cricketer (born 1988)', thumbnail: { source: 'https://x/vk.jpg' } }
  } } }) });
  assert.deepEqual(hit, { url: 'https://x/vk.jpg', title: 'Virat Kohli' });
  const none = await fetchWikipediaPhoto('Virat Kohli', { fetchImpl: fake({ query: { pages: { 1: { index: 1, title: 'Virat Kohli', description: 'Indian cricketer' } } } }) });
  assert.equal(none, null);                                                         // page without an image
  assert.equal(await fetchWikipediaPhoto('Virat Kohli', { fetchImpl: fake({}) }), null);
});

test('enrichAll updates stats and photos through the database layer', async () => {
  const rows = [{ id: 1, name: 'Virat Kohli', photo_url: null, stats: {} }, { id: 2, name: 'Nobody Known', photo_url: null, stats: {} }, { id: 3, name: 'Has Photo', photo_url: 'http://p', stats: { source: 'cricsheet' } }];
  const updates = [];
  const pool = { query: async (sql, args) => { if (sql.startsWith('SELECT')) return { rows }; updates.push([sql.split(' ')[1], args]); return { rows: [] }; } };
  const zip = makeZip([['1.json', JSON.stringify(match())]]);
  const fetchImpl = async url => String(url).includes('cricsheet')
    ? { ok: true, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) }
    : { ok: true, json: async () => ({ query: { pages: { 1: { index: 1, title: 'Virat Kohli', description: 'Indian cricketer', thumbnail: { source: 'https://x/vk.jpg' } } } } }) };
  const s = await enrichAll(pool, { fetchImpl, log: () => {} });
  assert.equal(s.statsUpdated, 1); assert.deepEqual(s.statsMissing, ['Nobody Known']);
  assert.equal(s.photosUpdated, 1); assert.deepEqual(s.photosMissing, ['Nobody Known']);
  const statsWrite = updates.find(u => u[1][0] === 1 && u[1][1].startsWith('{'));
  assert.equal(JSON.parse(statsWrite[1][1]).bat.runs, 13);
});
