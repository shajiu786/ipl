// Runs the real socket handlers against an in-memory stand-in for Postgres, with a tiny timer,
// and plays whole auctions to prove: no player repeats, squads stop at 25, purses never go negative.
process.env.ADVANCE_DELAY_MS = '4';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TEAM_LIST, PURSE_PAISE, MAX_SQUAD, normName, emptyState } from '../src/services/auction.js';

// imported dynamically so ADVANCE_DELAY_MS above is read before the module is evaluated
const { registerSockets } = await import('../src/socket/register.js');

globalThis.fetch = async () => { throw new Error('offline'); };   // photo lookups must never block the flow

function loadPlayers({ doubleImport = false } = {}) {
  const [head, ...lines] = fs.readFileSync(new URL('../../data/ipl_auction_players_24_sets.csv', import.meta.url), 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  let rows = lines.map((l, i) => {
    const v = l.split(','); const r = Object.fromEntries(cols.map((c, k) => [c, v[k]]));
    return { id: i + 1, name: r.player_name, role: r.role, nationality: r.nationality, batting_style: null, bowling_style: null, photo_url: 'x', base_price_paise: Number(r.base_price_lakh) * 1e7, source_data: r, stats: {} };
  });
  if (doubleImport) rows = [...rows, ...rows.map((r, i) => ({ ...r, id: 1000 + i }))];   // worst case: raw CSV imported twice
  return rows;
}

function fakeDb({ players, durationSeconds = 0.02, incrementPaise = 2.5e8 }) {
  const db = {
    room: { id: 'room1', code: 'TEST01', status: 'waiting', config: { openingBidPaise: 2e8, incrementPaise, durationSeconds }, state: emptyState() },
    participants: TEAM_LIST.map(([k], i) => ({ room_id: 'room1', participant_id: `participant-${k}`, display_name: `Owner ${k}`, team_key: k, is_host: i === 0, connected: true })),
    squad: [], bids: []
  };
  const txn = { saved: null };
  const run = async (sql, args = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q === 'BEGIN') { txn.saved = JSON.stringify(db.room); return { rows: [], rowCount: 0 }; }
    if (q === 'COMMIT') return { rows: [], rowCount: 0 };
    if (q === 'ROLLBACK') { if (txn.saved) { db.room = JSON.parse(txn.saved); } return { rows: [], rowCount: 0 }; }
    if (q.startsWith('SELECT * FROM auction_rooms WHERE code=$1')) { const r = JSON.parse(JSON.stringify(db.room)); return { rows: [r], rowCount: 1 }; }
    if (q.startsWith('UPDATE auction_rooms SET state=$2')) { db.room.state = JSON.parse(args[1]); db.room.status = args[2]; db.room.config = JSON.parse(args[3]); return { rows: [], rowCount: 1 }; }
    if (q.startsWith('SELECT id, name, source_data FROM players')) return { rows: players.map(({ id, name, source_data }) => ({ id, name, source_data })), rowCount: players.length };
    if (q.includes('FROM players WHERE id=$1')) { const p = players.find(x => x.id === Number(args[0])); return { rows: p ? [JSON.parse(JSON.stringify(p))] : [], rowCount: p ? 1 : 0 }; }
    if (q.startsWith('SELECT COUNT(*)::int AS count')) { const mine = db.squad.filter(s => s.team_key === args[1]); return { rows: [{ count: mine.length, spent: mine.reduce((a, s) => a + s.price, 0) }], rowCount: 1 }; }
    if (q.startsWith('INSERT INTO room_squad_players')) { if (db.squad.some(s => s.player_id === args[2])) return { rows: [], rowCount: 0 }; db.squad.push({ team_key: args[1], player_id: args[2], price: args[3] }); return { rows: [{}], rowCount: 1 }; }
    if (q.startsWith('SELECT * FROM room_participants')) { const p = db.participants.find(x => x.participant_id === args[1]); return { rows: p ? [p] : [], rowCount: p ? 1 : 0 }; }
    if (q.startsWith('INSERT INTO auction_bids')) { const b = { id: db.bids.length + 1, team_key: args[3], amount_paise: args[4], player_id: args[1] }; db.bids.push(b); return { rows: [b], rowCount: 1 }; }
    if (q.startsWith('SELECT * FROM auction_rooms WHERE code=$1')) return { rows: [db.room], rowCount: 1 };
    if (q.startsWith('UPDATE room_participants SET connected')) return { rows: [], rowCount: 1 };
    throw new Error('fake db: unhandled SQL ' + q.slice(0, 80));
  };
  db.pool = { query: run, connect: async () => ({ query: run, release() {} }) };
  return db;
}

function harness(opts) {
  const db = fakeDb(opts);
  const emitted = [];
  const sockets = [];
  const io = {
    on(ev, cb) { if (ev === 'connection') this._conn = cb; },
    to() { return { emit: (event, payload) => emitted.push([event, payload]) }; },
    sockets: { sockets: new Map() }
  };
  registerSockets(io, db.pool);
  const connect = participantId => {
    const handlers = {};
    const socket = { id: 's-' + participantId, data: {}, on: (e, f) => { handlers[e] = f; }, join() {}, emit() {}, to: () => ({ emit() {} }) };
    io._conn(socket);
    const call = (event, payload) => new Promise(res => handlers[event](payload, res));
    return { socket, call };
  };
  return { db, emitted, connect };
}

const waitFor = async (cond, ms = 20000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 2)); } };
const fmtId = k => `participant-${k}`;

async function playFullAuction({ doubleImport, durationSeconds = 0.02, incrementPaise = 2.5e8, strategy, roundsPerLot = 2 }) {
  const h = harness({ players: loadPlayers({ doubleImport }), durationSeconds, incrementPaise });
  const host = h.connect(fmtId('csk'));
  assert.equal((await host.call('room:join-live', { code: 'TEST01', participantId: fmtId('csk') })).ok, true);
  const clients = Object.fromEntries(TEAM_LIST.map(([k]) => { const c = h.connect(fmtId(k)); return [k, c]; }));
  await Promise.all(TEAM_LIST.map(([k]) => clients[k].call('room:join-live', { code: 'TEST01', participantId: fmtId(k) })));
  assert.equal((await host.call('auction:host-action', { action: 'start' })).ok, true);

  const lots = [];
  let lastKey = '';
  const rejected = { squad_full: 0, insufficient_purse: 0 };
  const made = new Map();   // `${lot}:${team}` -> bids already tried, so the bots do not bid forever
  const deadline = Date.now() + 120000;
  while (h.db.room.state.status !== 'ended' && Date.now() < deadline) {
    const st = h.db.room.state;
    if (st.status === 'active' && st.currentPlayerId) {
      const key = `${st.currentPlayerId}`;
      if (key !== lastKey) { lastKey = key; lots.push({ id: st.currentPlayerId, name: st.currentPlayer.name, set: st.currentSetNumber }); }
      for (const [teamKey, c] of Object.entries(clients)) {
        if (!strategy(teamKey, st, lots.length)) continue;
        const mk = `${st.currentPlayerId}:${teamKey}`;
        if ((made.get(mk) || 0) >= roundsPerLot) continue;
        made.set(mk, (made.get(mk) || 0) + 1);
        const res = await c.call('bid:place', { code: 'TEST01', participantId: fmtId(teamKey), requestId: 'req-' + Math.random() });
        if (res.error in rejected) rejected[res.error]++;
      }
    }
    await new Promise(r => setTimeout(r, 1));
  }
  assert.equal(h.db.room.state.status, 'ended', 'auction should finish');
  return { h, lots, rejected };
}

test('every player is auctioned exactly once, even if the CSV was imported twice', async () => {
  // only CSK, MI and RCB bid, on every 3rd lot: a mix of sold and unsold
  const { h, lots } = await playFullAuction({ doubleImport: true, strategy: (k, st, n) => ['csk', 'mi', 'rcb'].includes(k) && n % 3 !== 0 });
  const ids = lots.map(l => l.id), names = lots.map(l => normName(l.name));
  assert.equal(new Set(ids).size, ids.length, 'no player id twice');
  assert.equal(new Set(names).size, names.length, 'no person twice');
  assert.equal(lots.length, 243, 'all 243 distinct players came up');
  const st = h.db.room.state;
  assert.equal(st.soldCount + st.unsoldCount, 243);
  assert.equal(new Set(h.db.squad.map(s => s.player_id)).size, h.db.squad.length);
});

test('sets run one after another: the whole of a set finishes before the next one starts', async () => {
  const { lots } = await playFullAuction({ doubleImport: false, strategy: () => false });
  const seen = []; for (const l of lots) if (seen[seen.length - 1] !== l.set) seen.push(l.set);
  assert.equal(new Set(seen).size, seen.length, 'a set never comes back after another one started');
  assert.equal(seen.length, 22);
});

test('squads never exceed 25 and purses never go below zero', async () => {
  // everyone bids on everything with big increments, so purses and squad caps are hit constantly
  const { h, rejected } = await playFullAuction({ doubleImport: false, incrementPaise: 3e9, strategy: () => true });
  for (const [k] of TEAM_LIST) {
    const mine = h.db.squad.filter(s => s.team_key === k);
    const spent = mine.reduce((a, s) => a + s.price, 0);
    assert.ok(mine.length <= MAX_SQUAD, `${k} has ${mine.length} players`);
    assert.ok(spent <= PURSE_PAISE, `${k} overspent: ${spent}`);
  }
  assert.ok(rejected.squad_full > 0 || rejected.insufficient_purse > 0, 'the limits were actually exercised');
  console.log('      rejected bids:', JSON.stringify(rejected), 'squad sizes:', TEAM_LIST.map(([k]) => h.db.squad.filter(s => s.team_key === k).length).join(','));
});

test('a team with 25 players or too little purse gets a clear rejection and no bid is stored', async () => {
  const h = harness({ players: loadPlayers(), durationSeconds: 30 });
  const host = h.connect(fmtId('csk')); await host.call('room:join-live', { code: 'TEST01', participantId: fmtId('csk') });
  const mi = h.connect(fmtId('mi')); await mi.call('room:join-live', { code: 'TEST01', participantId: fmtId('mi') });
  await host.call('auction:host-action', { action: 'start' });
  // give MI a full squad
  for (let i = 0; i < 25; i++) h.db.squad.push({ team_key: 'mi', player_id: 5000 + i, price: 1e7 });
  let res = await mi.call('bid:place', { code: 'TEST01', participantId: fmtId('mi'), requestId: 'request-1' });
  assert.equal(res.error, 'squad_full');
  assert.equal(h.db.bids.length, 0);
  // an MI with 24 players but 0.05 Cr left cannot afford the opening bid
  h.db.squad.length = 0;
  h.db.squad.push({ team_key: 'mi', player_id: 6000, price: PURSE_PAISE - 5e7 });
  res = await mi.call('bid:place', { code: 'TEST01', participantId: fmtId('mi'), requestId: 'request-2' });
  assert.equal(res.error, 'insufficient_purse');
  assert.equal(res.remainingPursePaise, 5e7);
  assert.equal(h.db.bids.length, 0);
  // exactly enough funds is allowed
  const base = h.db.room.state.currentPlayer.base_price_paise;
  h.db.squad[0].price = PURSE_PAISE - base;
  res = await mi.call('bid:place', { code: 'TEST01', participantId: fmtId('mi'), requestId: 'request-3' });
  assert.equal(res.ok, true);
});

test('a stale price is refused instead of silently bidding higher', async () => {
  const h = harness({ players: loadPlayers(), durationSeconds: 30 });
  const host = h.connect(fmtId('csk')); await host.call('room:join-live', { code: 'TEST01', participantId: fmtId('csk') });
  const mi = h.connect(fmtId('mi')); await mi.call('room:join-live', { code: 'TEST01', participantId: fmtId('mi') });
  await host.call('auction:host-action', { action: 'start' });
  const res = await mi.call('bid:place', { code: 'TEST01', participantId: fmtId('mi'), requestId: 'request-1', expectedBidPaise: 1 });
  assert.equal(res.error, 'price_changed');
  assert.ok(res.state.nextBidPaise > 1);
});

test('host Next goes straight to a live player (no dead "ready" state)', async () => {
  const h = harness({ players: loadPlayers(), durationSeconds: 30 });
  const host = h.connect(fmtId('csk')); await host.call('room:join-live', { code: 'TEST01', participantId: fmtId('csk') });
  await host.call('auction:host-action', { action: 'start' });
  const first = h.db.room.state.currentPlayerId;
  await host.call('auction:host-action', { action: 'unsold' });
  assert.equal(h.db.room.state.status, 'unsold');
  assert.equal((await host.call('auction:host-action', { action: 'next-player' })).ok, true);
  assert.equal(h.db.room.state.status, 'active');
  assert.notEqual(h.db.room.state.currentPlayerId, first);
  assert.ok(h.db.room.state.deadline);
});
