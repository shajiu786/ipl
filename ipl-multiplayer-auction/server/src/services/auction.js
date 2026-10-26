// Shared auction rules and pure helpers. Nothing in here touches the database,
// so the rules can be unit-tested (see server/test/*.test.js).

export const TEAM_LIST = [
  ['csk','Chennai Super Kings'],['mi','Mumbai Indians'],['rcb','Royal Challengers Bengaluru'],
  ['kkr','Kolkata Knight Riders'],['rr','Rajasthan Royals'],['srh','Sunrisers Hyderabad'],
  ['dc','Delhi Capitals'],['pbks','Punjab Kings'],['gt','Gujarat Titans'],['lsg','Lucknow Super Giants']
];
export const TEAM_NAMES = Object.fromEntries(TEAM_LIST);

// Money is stored in paise: 1 crore = 1_000_000_000 paise.
export const PURSE_PAISE = 120_000_000_000;   // 120 Cr per franchise
export const MAX_SQUAD = 25;                    // hard cap on players per franchise

export const makeCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

export const emptyState = () => ({
  currentPlayerId: null, currentPlayer: null, currentBidPaise: 0, highestBidder: null,
  deadline: null, status: 'waiting', soldCount: 0, unsoldCount: 0, auctionVersion: 1, queue: [],
  completedPlayerIds: [], soldPlayerIds: [], unsoldPlayerIds: [], doneNames: []
});

/* ---------- player identity ---------- */

// "Sanju  Samson " and "sanju samson" are the same person. Accents and punctuation are ignored.
export const normName = name => String(name ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const setKeyOf = p => String(p?.source_data?.set_number ?? p?.source_data?.setNumber ?? p?.set_number ?? 'Unassigned');
export const setNameOf = p => p?.source_data?.set_name ?? p?.source_data?.setName ?? p?.set_name ?? `Set ${setKeyOf(p)}`;

const isTrue = v => v === true || String(v).toLowerCase() === 'true';

// The CSV lists some players in several sets (duplicate_in_pool = True). Keep exactly one row
// per person: the original (not flagged as a duplicate), otherwise the lowest id.
export function dedupePlayers(rows) {
  const best = new Map();
  for (const row of rows) {
    const key = normName(row.name);
    if (!key) continue;
    const cur = best.get(key);
    if (!cur) { best.set(key, row); continue; }
    const rowDup = isTrue(row.source_data?.duplicate_in_pool);
    const curDup = isTrue(cur.source_data?.duplicate_in_pool);
    if ((curDup && !rowDup) || (curDup === rowDup && Number(row.id) < Number(cur.id))) best.set(key, row);
  }
  return [...best.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

export function shuffle(items, rand = Math.random) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// One randomized, server-owned order per room: sets shuffled, players shuffled inside each set.
// Returns [{ key, name, ids }] so progress per set is easy to compute later.
export function buildAuctionSets(rows, rand = Math.random) {
  const unique = dedupePlayers(rows);
  const bySet = new Map();
  for (const p of unique) {
    const key = setKeyOf(p);
    if (!bySet.has(key)) bySet.set(key, { key, name: setNameOf(p), ids: [] });
    bySet.get(key).ids.push(Number(p.id));
  }
  return shuffle([...bySet.values()], rand).map(s => ({ ...s, ids: shuffle(s.ids, rand) }));
}

/* ---------- bidding rules ---------- */

export function openingBid(room, player) {
  const base = Number(player?.base_price_paise || 0);
  return base > 0 ? base : Number(room?.config?.openingBidPaise || 200_000_000);
}

export function nextBidAmount(room, state) {
  const current = Number(state?.currentBidPaise || 0);
  return current === 0
    ? openingBid(room, state?.currentPlayer)
    : current + Number(room?.config?.incrementPaise || 250_000_000);
}

// Why this franchise cannot place the next bid, or null when the bid is allowed.
export function bidBlocker({ squadCount, spentPaise, nextPaise }) {
  if (Number(squadCount) >= MAX_SQUAD) return 'squad_full';
  if (PURSE_PAISE - Number(spentPaise || 0) < Number(nextPaise)) return 'insufficient_purse';
  return null;
}

/* ---------- what clients are allowed to see ---------- */

// Strip server-only bookkeeping (full order, id lists per set) and add derived fields.
export function publicState(room, state) {
  const { auctionPlayerOrder, auctionSets, queue, unsoldPlayers, doneNames, ...rest } = state || {};
  const sets = Array.isArray(auctionSets) ? auctionSets : [];
  const done = new Set((state?.completedPlayerIds || []).map(Number));
  const curKey = state?.currentSetNumber != null ? String(state.currentSetNumber) : null;
  const idx = sets.findIndex(s => String(s.key) === curKey);
  const cur = idx >= 0 ? sets[idx] : null;
  return {
    ...rest,
    durationSeconds: Number(room?.config?.durationSeconds || 10),
    nextBidPaise: state?.currentPlayer || state?.status === 'ready' ? nextBidAmount(room, state) : null,
    setProgress: cur ? {
      key: cur.key, name: cur.name, position: idx + 1, totalSets: sets.length,
      total: cur.ids.length, remaining: cur.ids.filter(id => !done.has(Number(id))).length
    } : null,
    setOrder: sets.map(s => String(s.key))
  };
}
