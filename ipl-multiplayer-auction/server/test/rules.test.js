import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dedupePlayers, buildAuctionSets, bidBlocker, nextBidAmount, openingBid, publicState, normName, MAX_SQUAD, PURSE_PAISE } from '../src/services/auction.js';

// minimal CSV reader for the supplied file (no quoted commas except inside set_name, which has none)
function loadCsv() {
  const [head, ...lines] = fs.readFileSync(new URL('../../data/ipl_auction_players_24_sets.csv', import.meta.url), 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  return lines.map((l, i) => {
    const v = l.split(',');
    const r = Object.fromEntries(cols.map((c, k) => [c, v[k]]));
    return { id: i + 1, name: r.player_name, role: r.role, base_price_paise: Number(r.base_price_lakh) * 1e7, source_data: r };
  });
}

test('normName ignores case, accents and punctuation', () => {
  assert.equal(normName('  Sanju   SAMSON '), 'sanju samson');
  assert.equal(normName('Quinton de Kock'), normName('quinton  de-kock'));
});

test('the supplied CSV has 288 rows but only 243 distinct players, and dedupe keeps one of each', () => {
  const rows = loadCsv();
  assert.equal(rows.length, 288);
  const unique = dedupePlayers(rows);
  assert.equal(unique.length, 243);
  assert.equal(new Set(unique.map(p => normName(p.name))).size, 243);
  // the original entry (not flagged duplicate) wins: Sanju Samson is set 11 (id 124 row), not set 10/24 copies
  const samson = unique.filter(p => normName(p.name) === 'sanju samson');
  assert.equal(samson.length, 1);
  assert.notEqual(String(samson[0].source_data.duplicate_in_pool), 'True');
});

test('re-importing the CSV twice and deduping still gives each player exactly once', () => {
  const rows = loadCsv();
  const doubled = [...rows, ...rows.map((r, i) => ({ ...r, id: 1000 + i }))];
  assert.equal(dedupePlayers(doubled).length, 243);
});

test('auction order contains every unique player exactly once, grouped by set', () => {
  const sets = buildAuctionSets(loadCsv());
  const flat = sets.flatMap(s => s.ids);
  assert.equal(flat.length, 243);
  assert.equal(new Set(flat).size, 243);
  assert.equal(sets.length, 22); // sets 23 and 24 in the CSV contain only repeats of earlier players
});

test('bidBlocker: squad cap and purse', () => {
  assert.equal(bidBlocker({ squadCount: MAX_SQUAD - 1, spentPaise: 0, nextPaise: 1e9 }), null);
  assert.equal(bidBlocker({ squadCount: MAX_SQUAD, spentPaise: 0, nextPaise: 1e9 }), 'squad_full');
  assert.equal(bidBlocker({ squadCount: 3, spentPaise: PURSE_PAISE - 1e9 + 1, nextPaise: 1e9 }), 'insufficient_purse');
  assert.equal(bidBlocker({ squadCount: 3, spentPaise: PURSE_PAISE - 1e9, nextPaise: 1e9 }), null); // exactly enough
  assert.equal(bidBlocker({ squadCount: 30, spentPaise: PURSE_PAISE, nextPaise: 1e9 }), 'squad_full');
});

test('bidding opens at the player base price, then rises by the increment', () => {
  const room = { config: { openingBidPaise: 2e8, incrementPaise: 2.5e8 } };
  const state = { currentBidPaise: 0, currentPlayer: { base_price_paise: 2e9 } };
  assert.equal(openingBid(room, state.currentPlayer), 2e9);
  assert.equal(nextBidAmount(room, state), 2e9);
  assert.equal(nextBidAmount(room, { ...state, currentBidPaise: 2e9 }), 2.25e9);
  assert.equal(nextBidAmount(room, { currentBidPaise: 0, currentPlayer: {} }), 2e8); // no base price -> config
});

test('publicState hides the order, exposes set progress and next bid', () => {
  const room = { config: { durationSeconds: 8, incrementPaise: 2.5e8 } };
  const state = {
    status: 'active', currentPlayerId: 2, currentPlayer: { id: 2, base_price_paise: 5e8 }, currentBidPaise: 0, currentSetNumber: '4',
    completedPlayerIds: [1], auctionPlayerOrder: [1, 2, 3], unsoldPlayers: [{}], doneNames: ['x'],
    auctionSets: [{ key: '7', name: 'Set 7', ids: [9] }, { key: '4', name: 'Set 4', ids: [1, 2, 3] }]
  };
  const pub = publicState(room, state);
  assert.equal(pub.auctionPlayerOrder, undefined);
  assert.equal(pub.doneNames, undefined);
  assert.equal(pub.nextBidPaise, 5e8);
  assert.equal(pub.durationSeconds, 8);
  assert.deepEqual(pub.setProgress, { key: '4', name: 'Set 4', position: 2, totalSets: 2, total: 3, remaining: 2 });
});
