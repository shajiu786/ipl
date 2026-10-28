import { z } from 'zod';
import {
  TEAM_NAMES, PURSE_PAISE, nextBidAmount, bidBlocker, buildAuctionSets, normName, setKeyOf, setNameOf, publicState
} from '../services/auction.js';
import { enrichPlayerPhoto } from '../services/enrich.js';
import { datasetOfRoom } from '../services/modes.js';

const PLAYER_COLS = 'id,name,role,nationality,batting_style,bowling_style,photo_url,base_price_paise,source_data,stats';
const ADVANCE_DELAY_MS = Number(process.env.ADVANCE_DELAY_MS || 3000);          // gap between SOLD/UNSOLD and the next player (the pop-up shows for ~2s)
const norm = code => String(code || '').trim().toUpperCase();
const addUnique = (list, id) => { const a = Array.isArray(list) ? list : []; if (!a.map(Number).includes(Number(id))) a.push(Number(id)); return a; };
const bump = state => { state.auctionVersion = Number(state.auctionVersion || 0) + 1; };

export function registerSockets(io, pool) {
  const deadlineTimers = new Map();
  const advanceTimers = new Map();
  const photoTried = new Set();

  /* ------------------------------------------------------------------ timers */
  const clearAdvanceTimer = code => { clearTimeout(advanceTimers.get(norm(code))); advanceTimers.delete(norm(code)); };
  const clearRoomTimer = code => { clearTimeout(deadlineTimers.get(norm(code))); deadlineTimers.delete(norm(code)); };
  const scheduleRoomTimer = (code, deadline) => {
    clearRoomTimer(code);
    if (!deadline) return;
    const delay = Math.max(0, new Date(deadline).getTime() - Date.now());
    deadlineTimers.set(norm(code), setTimeout(() => settleExpired(norm(code)), delay));
  };
  const scheduleAdvance = code => {
    clearAdvanceTimer(code);
    advanceTimers.set(norm(code), setTimeout(() => advanceRoom(norm(code)), ADVANCE_DELAY_MS));
  };

  /* ------------------------------------------------------------------ one place that touches room state */
  // Every change to an auction goes through here: the room row is locked for the whole
  // read-modify-write, so a bid, the host's buttons and the expiry timer can never interleave.
  async function withRoom(code, fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query('SELECT * FROM auction_rooms WHERE code=$1 FOR UPDATE', [norm(code)]);
      if (!r.rowCount) { await client.query('ROLLBACK'); return { error: 'room_not_found' }; }
      const room = r.rows[0];
      const state = room.state || {};
      const out = (await fn({ client, room, state })) || {};
      if (out.error || out.skip) { await client.query('ROLLBACK'); return { ...out, room, state }; }
      room.status = state.status;
      await client.query('UPDATE auction_rooms SET state=$2::jsonb, status=$3, config=$4::jsonb WHERE id=$1',
        [room.id, JSON.stringify(state), state.status, JSON.stringify(room.config || {})]);
      await client.query('COMMIT');
      return { ...out, room, state };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* already closed */ }
      throw error;
    } finally { client.release(); }
  }

  // After a commit: timers, state broadcast, extra events.
  const finish = (room, state, out = {}) => {
    if (state.status === 'active' && state.deadline) scheduleRoomTimer(room.code, state.deadline); else clearRoomTimer(room.code);
    if (out.settled) scheduleAdvance(room.code);
    else if (!['sold', 'unsold'].includes(state.status)) clearAdvanceTimer(room.code);
    io.to(room.code).emit('auction:state', publicState(room, state));
    for (const [event, payload] of out.events || []) io.to(room.code).emit(event, payload);
    if (out.liveCurrent) warmPlayer(room.code, state.currentPlayer);
  };

  /* ------------------------------------------------------------------ player order (no repeats) */
  async function loadOrder(ctx) {
    const { client, room, state } = ctx;
    if (Array.isArray(state.auctionSets) && state.auctionSets.length) return;
    // each mode auctions only its own dataset
    const { rows } = await client.query('SELECT id, name, source_data FROM players WHERE dataset=$1 ORDER BY id', [datasetOfRoom(room)]);
    // Rooms created by the previous version have no auctionSets: keep what was already auctioned.
    const byId = new Map(rows.map(r => [Number(r.id), r]));
    const names = new Set(state.doneNames || []);
    for (const id of state.completedPlayerIds || []) { const row = byId.get(Number(id)); if (row) names.add(normName(row.name)); }
    state.doneNames = [...names];
    state.completedPlayerIds = (state.completedPlayerIds || []).map(Number);
    state.auctionSets = buildAuctionSets(rows);                // one row per person, shuffled sets and players
    state.auctionSetOrder = state.auctionSets.map(s => s.key);
    state.auctionPlayerOrder = state.auctionSets.flatMap(s => s.ids);
  }

  // Next player who has not been auctioned yet. A player counts as done if their id OR their name was used.
  async function pickNext(ctx) {
    await loadOrder(ctx);
    const { client, state } = ctx;
    const done = new Set((state.completedPlayerIds || []).map(Number));
    const names = new Set(state.doneNames || []);
    const deferredSets = new Set((state.deferredSetKeys || []).map(String));
    const deferredPlayers = new Set((state.deferredPlayerIds || []).map(Number));
    const orderedSets = [
      ...state.auctionSets.filter(s => !deferredSets.has(String(s.key))),
      ...state.auctionSets.filter(s => deferredSets.has(String(s.key)))
    ];
    // Deferred individual players go after all ordinary players, without duplicating a player.
    const candidates = [];
    for (const set of orderedSets) for (const id of set.ids) candidates.push({ set, id });
    candidates.sort((a, b) => Number(deferredPlayers.has(Number(a.id))) - Number(deferredPlayers.has(Number(b.id))));
    for (const { set, id } of candidates) {
        if (done.has(Number(id))) continue;
        const { rows } = await client.query(`SELECT ${PLAYER_COLS} FROM players WHERE id=$1`, [id]);
        const player = rows[0];
        if (!player || names.has(normName(player.name))) { done.add(Number(id)); continue; }
        state.completedPlayerIds = [...done];
        return player;
    }
    state.completedPlayerIds = [...done];
    return null;
  }

  function setCurrent(ctx, player, status) {
    const { room, state } = ctx;
    state.currentPlayerId = Number(player.id);
    state.currentPlayer = player;
    state.currentSetNumber = setKeyOf(player);
    state.currentSetName = setNameOf(player);
    state.currentBidPaise = 0;
    state.highestBidder = null;
    state.pausedRemainingMs = null;
    state.status = status;
    state.deadline = status === 'active' ? new Date(Date.now() + Number(room.config?.durationSeconds || 10) * 1000).toISOString() : null;
    bump(state);
  }

  function endAuction(state) {
    state.currentPlayerId = null; state.currentPlayer = null; state.currentBidPaise = 0; state.highestBidder = null;
    state.status = 'ended'; state.deadline = null; state.pausedRemainingMs = null;
    bump(state);
  }

  const syncCounts = state => {
    state.soldCount = (state.soldPlayerIds || []).length;
    state.unsoldCount = (state.unsoldPlayerIds || []).length;
  };

  async function teamTotals(client, roomId, teamKey) {
    const r = await client.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(s.purchase_price_paise),0)::bigint AS spent,
              COUNT(*) FILTER (WHERE p.nationality IS NOT NULL
                AND BTRIM(p.nationality) <> ''
                AND LOWER(p.nationality) NOT LIKE '%india%'
                AND LOWER(p.nationality) NOT LIKE '%local%')::int AS overseas
         FROM room_squad_players s
         JOIN players p ON p.id=s.player_id
        WHERE s.room_id=$1 AND s.team_key=$2`,
      [roomId, teamKey]);
    return {
      count: Number(r.rows[0]?.count || 0),
      spent: Number(r.rows[0]?.spent || 0),
      overseas: Number(r.rows[0]?.overseas || 0)
    };
  }

  const isOverseas = nationality => Boolean(String(nationality || '').trim())
    && !/india|local/i.test(String(nationality));

  // Close the current lot as sold or unsold. Used by the expiry timer and by the host buttons.
  async function settleCurrent(ctx, kind) {
    const { client, room, state } = ctx;
    const id = Number(state.currentPlayerId || 0);
    if (!id || !['active', 'paused', 'ready'].includes(state.status)) return { error: 'player_already_settled' };
    const player = state.currentPlayer || {};
    let sold = kind === 'sold';
    const bidder = state.highestBidder;
    if (sold && (!bidder || !(Number(state.currentBidPaise) > 0))) return { error: 'no_valid_bid' };
    let reason = null;
    if (sold) {
      // Last line of defence: bidding already enforces this, but a sale must never break the rules either.
      const totals = await teamTotals(client, room.id, bidder.teamKey);
      reason = bidBlocker({ squadCount: totals.count, spentPaise: totals.spent, nextPaise: Number(state.currentBidPaise), overseasCount: totals.overseas, playerOverseas: isOverseas(player.nationality) });
      if (reason) sold = false;
    }
    if (sold) {
      await client.query(
        `INSERT INTO room_squad_players(room_id,team_key,player_id,purchase_price_paise) VALUES($1,$2,$3,$4) ON CONFLICT(room_id,player_id) DO NOTHING`,
        [room.id, bidder.teamKey, id, Number(state.currentBidPaise)]);
      state.soldPlayerIds = addUnique(state.soldPlayerIds, id);
    } else {
      state.unsoldPlayerIds = addUnique(state.unsoldPlayerIds, id);
    }
    state.completedPlayerIds = addUnique(state.completedPlayerIds, id);
    state.doneNames = [...new Set([...(state.doneNames || []), normName(player.name)])];
    syncCounts(state);
    const result = {
      status: sold ? 'sold' : 'unsold', playerId: id, playerName: player.name || 'Player', role: player.role || null,
      teamKey: sold ? bidder.teamKey : null, teamName: sold ? bidder.teamName : null,
      amountPaise: sold ? Number(state.currentBidPaise) : 0, reason
    };
    state.lastResult = { ...result, at: new Date().toISOString() };
    const eventMessage = sold
      ? `${result.playerName} SOLD to ${result.teamName} for ₹${(Number(result.amountPaise || 0) / 1000000000).toFixed(2)} Cr`
      : `${result.playerName} marked UNSOLD`;
    await client.query(
      `INSERT INTO room_chat(room_id,participant_id,display_name,team_key,message) VALUES($1,$2,$3,$4,$5)`,
      [room.id, 'system', 'AUCTION UPDATE', result.teamKey, eventMessage]
    );
    state.status = result.status;
    state.deadline = null;
    state.pausedRemainingMs = null;
    bump(state);
    return { events: [['sale:celebration', result]], settled: true };
  }

  // Move on to the next player and start the clock. Announces when a whole set has just finished.
  async function advance(ctx, status = 'active') {
    const { state } = ctx;
    const previousKey = state.currentSetNumber != null ? String(state.currentSetNumber) : null;
    const next = await pickNext(ctx);
    if (!next) { endAuction(state); return { events: [] }; }
    const events = [];
    const nextKey = setKeyOf(next);
    if (previousKey != null && previousKey !== nextKey) {
      const prev = (state.auctionSets || []).find(s => String(s.key) === previousKey);
      const done = new Set((state.completedPlayerIds || []).map(Number));
      if (prev && prev.ids.every(i => done.has(Number(i)))) {
        events.push(['auction:set-complete', {
          completedSetNumber: previousKey, completedSetName: prev.name || `Set ${previousKey}`,
          nextSetNumber: nextKey, nextSetName: setNameOf(next)
        }]);
      }
    }
    setCurrent(ctx, next, status);
    return { events, liveCurrent: true };
  }

  /* ------------------------------------------------------------------ timer-driven transitions */
  async function settleExpired(code) {
    try {
      const out = await withRoom(code, ctx => {
        const { state } = ctx;
        if (state.status !== 'active' || !state.deadline) return { skip: true };
        if (new Date(state.deadline).getTime() - Date.now() > 50) return { skip: true, again: state.deadline };
        return settleCurrent(ctx, state.highestBidder && Number(state.currentBidPaise) > 0 ? 'sold' : 'unsold');
      });
      if (out.again) return scheduleRoomTimer(code, out.again);
      if (out.room && !out.error && !out.skip) finish(out.room, out.state, out);
    } catch (error) {
      console.error('settle failed, retrying:', error.message);
      scheduleRoomTimer(code, new Date(Date.now() + 2000));
    }
  }

  async function advanceRoom(code) {
    try {
      const out = await withRoom(code, ctx => (['sold', 'unsold'].includes(ctx.state.status) ? advance(ctx) : { skip: true }));
      if (out.room && !out.error && !out.skip) finish(out.room, out.state, out);
    } catch (error) {
      console.error('advance failed, retrying:', error.message);
      advanceTimers.set(norm(code), setTimeout(() => advanceRoom(code), 2000));
    }
  }

  // Fetch a missing photo in the background when a player goes live, then tell everyone.
  function warmPlayer(code, player) {
    if (!player || player.photo_url || photoTried.has(player.id)) return;
    photoTried.add(player.id);
    enrichPlayerPhoto(pool, player).then(async url => {
      if (!url) return;
      const out = await withRoom(code, ctx => {
        if (Number(ctx.state.currentPlayerId) !== Number(player.id)) return { skip: true };
        ctx.state.currentPlayer = { ...ctx.state.currentPlayer, photo_url: url };
        return {};
      });
      if (out.room && !out.error && !out.skip) finish(out.room, out.state);
    }).catch(() => { /* photos are optional */ });
  }

  const roomByCode = async code => (await pool.query('SELECT * FROM auction_rooms WHERE code=$1', [norm(code)])).rows[0] || null;

  /* ------------------------------------------------------------------ sockets */
  io.on('connection', socket => {
    socket.on('team:select', async ({ code, participantId, teamKey } = {}, ack = () => {}) => {
      const normalizedCode = norm(code);
      if (!participantId || !TEAM_NAMES[teamKey]) return ack({ ok: false, error: 'invalid_team' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const roomResult = await client.query('SELECT id,code FROM auction_rooms WHERE code=$1 FOR UPDATE', [normalizedCode]);
        if (!roomResult.rowCount) { await client.query('ROLLBACK'); return ack({ ok: false, error: 'room_not_found' }); }
        const room = roomResult.rows[0];
        const member = await client.query('SELECT * FROM room_participants WHERE room_id=$1 AND participant_id=$2 FOR UPDATE', [room.id, participantId]);
        if (!member.rowCount) { await client.query('ROLLBACK'); return ack({ ok: false, error: 'not_a_room_member' }); }
        const taken = await client.query('SELECT 1 FROM room_participants WHERE room_id=$1 AND team_key=$2 AND participant_id<>$3 LIMIT 1', [room.id, teamKey, participantId]);
        if (taken.rowCount) { await client.query('ROLLBACK'); return ack({ ok: false, error: 'team_taken' }); }
        await client.query('UPDATE room_participants SET team_key=$3 WHERE room_id=$1 AND participant_id=$2', [room.id, participantId, teamKey]);
        await client.query('COMMIT');
        const participantsResult = await pool.query('SELECT participant_id,display_name,team_key,is_host,connected FROM room_participants WHERE room_id=$1 ORDER BY display_name', [room.id]);
        const participants = participantsResult.rows;
        if (socket.data?.participantId === participantId) socket.data.teamKey = teamKey;
        io.to(normalizedCode).emit('lobby:participants', participants);
        ack({ ok: true, participant: participants.find(p => p.participant_id === participantId), participants });
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        ack({ ok: false, error: 'team_selection_failed' });
      } finally { client.release(); }
    });

    socket.on('room:join-live', async ({ code, participantId } = {}, ack = () => {}) => {
      try {
        const room = await roomByCode(code);
        if (!room) return ack({ ok: false, error: 'room_not_found' });
        const p = await pool.query('SELECT * FROM room_participants WHERE room_id=$1 AND participant_id=$2', [room.id, participantId]);
        if (!p.rowCount) return ack({ ok: false, error: 'not_a_room_member' });
        socket.data = { roomId: room.id, roomCode: room.code, participantId, teamKey: p.rows[0].team_key, isHost: p.rows[0].is_host };
        socket.join(room.code);
        const st = room.state || {};
        // After a server restart the in-memory timers are gone: pick them up again.
        if (st.status === 'active' && st.deadline) scheduleRoomTimer(room.code, st.deadline);
        if (['sold', 'unsold'].includes(st.status) && !advanceTimers.has(room.code)) scheduleAdvance(room.code);
        await pool.query('UPDATE room_participants SET connected=true WHERE room_id=$1 AND participant_id=$2', [room.id, participantId]);
        socket.to(room.code).emit('presence:changed', { participantId, connected: true });
        const participants = (await pool.query('SELECT participant_id,display_name,team_key,is_host,connected FROM room_participants WHERE room_id=$1 ORDER BY display_name', [room.id])).rows;
        io.to(room.code).emit('lobby:participants', participants);
        ack({ ok: true, room: { code: room.code, state: publicState(room, st), config: room.config, status: room.status }, participants });
      } catch { ack({ ok: false, error: 'join_failed' }); }
    });

    socket.on('bid:place', async (payload = {}, ack = () => {}) => {
      const schema = z.object({
        code: z.string().min(4), participantId: z.string().min(8), requestId: z.string().min(8).max(100),
        expectedBidPaise: z.number().int().positive().optional()
      });
      const p = schema.safeParse(payload);
      if (!p.success) return ack({ ok: false, error: 'invalid_request' });
      try {
        const out = await withRoom(p.data.code, async ctx => {
          const { client, room, state } = ctx;
          const member = await client.query('SELECT * FROM room_participants WHERE room_id=$1 AND participant_id=$2', [room.id, p.data.participantId]);
          if (!member.rowCount) return { error: 'not_a_room_member' };
          const who = member.rows[0];
          // Idempotency: if the server accepted a bid but the acknowledgement was lost,
          // retrying the same request ID returns the original accepted bid instead of creating another.
          const cached = (state.bidRequestCache || []).find(item => item.requestId === p.data.requestId && item.participantId === p.data.participantId);
          if (cached) return { duplicateBid: cached.bid };
          if (state.status !== 'active') return { error: 'auction_not_active' };
          if (!state.currentPlayerId) return { error: 'no_current_player' };
          if (!state.deadline || Date.now() >= new Date(state.deadline).getTime()) return { error: 'timer_expired' };
          if (!who.team_key || !TEAM_NAMES[who.team_key]) return { error: 'team_not_selected' };
          if (state.highestBidder?.teamKey === who.team_key) return { error: 'already_highest_bidder' };
          const next = nextBidAmount(room, state);
          // The bidder saw a price on screen; if someone outbid them a moment ago they must confirm the new one.
          if (p.data.expectedBidPaise && p.data.expectedBidPaise !== next) return { error: 'price_changed' };
          const totals = await teamTotals(client, room.id, who.team_key);
          const blocker = bidBlocker({ squadCount: totals.count, spentPaise: totals.spent, nextPaise: next, overseasCount: totals.overseas, playerOverseas: isOverseas(state.currentPlayer?.nationality) });
          if (blocker) return { error: blocker, remainingPursePaise: PURSE_PAISE - totals.spent, squadCount: totals.count };

          const bid = await client.query(
            `INSERT INTO auction_bids(room_id,player_id,participant_id,team_key,amount_paise,status) VALUES($1,$2,$3,$4,$5,'accepted') RETURNING *`,
            [room.id, state.currentPlayerId, p.data.participantId, who.team_key, next]);
          state.currentBidPaise = next;
          state.highestBidder = { participantId: p.data.participantId, displayName: who.display_name, teamKey: who.team_key, teamName: TEAM_NAMES[who.team_key] };
          state.deadline = new Date(Date.now() + Number(room.config.durationSeconds || 10) * 1000).toISOString();
          bump(state);
          const saved = { ...bid.rows[0], display_name: who.display_name, player_name: state.currentPlayer?.name };
          state.bidRequestCache = [...(state.bidRequestCache || []).filter(item => item.requestId !== p.data.requestId), {
            requestId: p.data.requestId, participantId: p.data.participantId, bid: saved
          }].slice(-100);
          return { bid: saved, events: [['bid:accepted', { bid: saved, participantName: who.display_name, teamKey: who.team_key }]] };
        });
        if (out.error) {
          const extra = out.state && out.room ? { state: publicState(out.room, out.state) } : {};
          return ack({ ok: false, error: out.error, remainingPursePaise: out.remainingPursePaise, squadCount: out.squadCount, ...extra });
        }
        if (out.duplicateBid) {
          const pub = publicState(out.room, out.state);
          return ack({ ok: true, bid: out.duplicateBid, duplicate: true, state: pub, nextBidPaise: pub.nextBidPaise });
        }
        finish(out.room, out.state, out);
        const pub = publicState(out.room, out.state);
        ack({ ok: true, bid: out.bid, state: pub, nextBidPaise: pub.nextBidPaise });
      } catch (e) { console.error('bid failed:', e.message); ack({ ok: false, error: 'bid_failed' }); }
    });

    socket.on('reaction:send', async ({ emoji } = {}, ack = () => {}) => {
      const allowed = new Set(['👏', '🔥', '😂', '😮', '💸', '🏏']);
      if (!socket.data?.roomId || !socket.data?.participantId) return ack({ ok: false, error: 'not_in_room' });
      if (!allowed.has(emoji)) return ack({ ok: false, error: 'invalid_reaction' });
      try {
        const member = await pool.query('SELECT display_name,team_key FROM room_participants WHERE room_id=$1 AND participant_id=$2', [socket.data.roomId, socket.data.participantId]);
        if (!member.rowCount) return ack({ ok: false, error: 'not_a_room_member' });
        io.to(socket.data.roomCode).emit('reaction:received', {
          emoji,
          participantId: socket.data.participantId,
          displayName: member.rows[0].display_name,
          teamKey: member.rows[0].team_key,
          at: new Date().toISOString()
        });
        ack({ ok: true });
      } catch (error) {
        console.error('reaction failed:', error.message);
        ack({ ok: false, error: 'reaction_failed' });
      }
    });

    socket.on('chat:send', async (payload = {}, ack = () => {}) => {
      const p = z.object({ message: z.string().trim().min(1).max(500) }).safeParse(payload);
      if (!p.success) return ack({ ok: false, error: 'invalid_message' });
      if (!socket.data.roomId || !socket.data.participantId) return ack({ ok: false, error: 'not_in_room' });
      try {
        const r = await pool.query('SELECT display_name,team_key FROM room_participants WHERE room_id=$1 AND participant_id=$2', [socket.data.roomId, socket.data.participantId]);
        if (!r.rowCount) return ack({ ok: false, error: 'not_a_room_member' });
        const saved = await pool.query(`INSERT INTO room_chat(room_id,participant_id,display_name,team_key,message) VALUES($1,$2,$3,$4,$5) RETURNING *`,
          [socket.data.roomId, socket.data.participantId, r.rows[0].display_name, r.rows[0].team_key, p.data.message]);
        io.to(socket.data.roomCode).emit('chat:message', saved.rows[0]);
        ack({ ok: true, message: saved.rows[0] });
      } catch { ack({ ok: false, error: 'chat_send_failed' }); }
    });

    socket.on('voice:join', () => {
      if (!socket.data.roomCode || !socket.data.participantId) return;
      socket.data.voiceJoined = true;
      const peers = [...io.sockets.sockets.values()]
        .filter(peer => peer.id !== socket.id && peer.data?.roomCode === socket.data.roomCode && peer.data?.voiceJoined)
        .map(peer => ({ socketId: peer.id, participantId: peer.data.participantId }));
      socket.emit('voice:peers', peers);
      socket.to(socket.data.roomCode).emit('voice:peer-joined', { socketId: socket.id, participantId: socket.data.participantId });
    });
    socket.on('voice:leave', () => {
      if (!socket.data?.voiceJoined) return;
      socket.data.voiceJoined = false;
      socket.to(socket.data.roomCode).emit('voice:peer-left', { socketId: socket.id });
    });
    socket.on('voice:signal', ({ targetSocketId, signal } = {}) => {
      if (!socket.data.roomCode || !socket.data.voiceJoined || !targetSocketId || !signal) return;
      const target = io.sockets.sockets.get(targetSocketId);
      if (!target || target.data?.roomCode !== socket.data.roomCode || !target.data?.voiceJoined) return;
      io.to(targetSocketId).emit('voice:signal', { from: socket.id, signal, participantId: socket.data.participantId });
    });

    /* ---------------- host controls ---------------- */
    const hostActions = {
      'set-duration': ctx => {
        const duration = Number(ctx.payload.durationSeconds);
        if (!Number.isInteger(duration) || duration < 5 || duration > 10) return { error: 'invalid_duration' };
        ctx.room.config = { ...(ctx.room.config || {}), durationSeconds: duration };
        if (ctx.state.status === 'active') { ctx.state.deadline = new Date(Date.now() + duration * 1000).toISOString(); bump(ctx.state); }
        return {};
      },
      start: async ctx => {
        const { state, room } = ctx;
        if (state.status === 'active') return { skip: true };
        if (state.status === 'ended') return { error: 'auction_ended' };
        if (state.status === 'paused') return hostActions.resume(ctx);
        if (['sold', 'unsold'].includes(state.status)) return advance(ctx);
        if (!state.currentPlayerId) {
          const out = await advance(ctx);
          return state.status === 'ended' ? { error: 'no_players_remaining' } : out;
        }
        state.status = 'active';
        state.deadline = new Date(Date.now() + Number(room.config.durationSeconds || 10) * 1000).toISOString();
        bump(state);
        return { liveCurrent: true };
      },
      pause: ctx => {
        const { state } = ctx;
        if (state.status !== 'active') return { error: 'auction_not_active' };
        state.pausedRemainingMs = Math.max(0, new Date(state.deadline || Date.now()).getTime() - Date.now());
        state.status = 'paused'; state.deadline = null;
        bump(state);
        return {};
      },
      resume: ctx => {
        const { state, room } = ctx;
        if (state.status !== 'paused') return { error: 'auction_not_paused' };
        const remaining = Math.max(1000, Number(state.pausedRemainingMs || Number(room.config.durationSeconds || 10) * 1000));
        state.status = 'active'; state.deadline = new Date(Date.now() + remaining).toISOString(); state.pausedRemainingMs = null;
        bump(state);
        return {};
      },
      'next-player': ctx => {
        if (!['sold', 'unsold', 'ready'].includes(ctx.state.status)) return { error: 'player_in_progress' };
        return advance(ctx);
      },
      sell: ctx => settleCurrent(ctx, 'sold'),
      unsold: ctx => settleCurrent(ctx, 'unsold'),
      'set-player': async ctx => {
        const { client, state } = ctx;
        if (!['waiting', 'ready'].includes(state.status)) return { error: 'player_in_progress' };
        const r = await client.query(`SELECT ${PLAYER_COLS} FROM players WHERE id=$1`, [Number(ctx.payload.playerId)]);
        if (!r.rowCount) return { error: 'player_not_found' };
        if ((state.completedPlayerIds || []).map(Number).includes(Number(r.rows[0].id)) || (state.doneNames || []).includes(normName(r.rows[0].name))) return { error: 'player_already_settled' };
        await loadOrder(ctx);
        setCurrent(ctx, r.rows[0], 'ready');
        return {};
      },
      'defer-player': async ctx => {
        const { state } = ctx; const id = Number(state.currentPlayerId || 0);
        if (!id || ['sold','unsold','ended'].includes(state.status)) return { error: 'no_active_player' };
        state.deferredPlayerIds = addUnique(state.deferredPlayerIds, id);
        const name = state.currentPlayer?.name || 'Player';
        const next = await pickNext(ctx);
        if (!next) endAuction(state); else setCurrent(ctx, next, state.status === 'active' ? 'active' : 'ready');
        return { liveCurrent: Boolean(next), events: [['auction:player-deferred', { playerId:id, playerName:name }]] };
      },
      'defer-set': async ctx => {
        const { state } = ctx; await loadOrder(ctx);
        const key = String(ctx.payload.setKey ?? state.currentSetNumber ?? '');
        if (!state.auctionSets.some(s => String(s.key) === key)) return { error: 'set_not_found' };
        state.deferredSetKeys = [...new Set([...(state.deferredSetKeys || []).map(String), key])];
        const current = state.currentPlayerId && String(state.currentSetNumber) === key && !['sold','unsold','ended'].includes(state.status);
        if (current) { const next = await pickNext(ctx); if (!next) endAuction(state); else setCurrent(ctx,next,state.status === 'active' ? 'active' : 'ready'); }
        return { liveCurrent: Boolean(current && state.currentPlayerId), events: [['auction:set-deferred',{setKey:key}]] };
      },
      'undo-defer-set': async ctx => {
        const { state } = ctx; const key = String(ctx.payload.setKey ?? '');
        state.deferredSetKeys = (state.deferredSetKeys || []).filter(k => String(k) !== key);
        return {};
      },
      'reorder-sets': async ctx => {
        const { state } = ctx; await loadOrder(ctx);
        const requested = (ctx.payload.setOrder || []).map(String);
        const known = new Set(state.auctionSets.map(s => String(s.key)));
        if (requested.some(k => !known.has(k)) || new Set(requested).size !== requested.length) return { error: 'invalid_set_order' };
        const order = [...requested, ...state.auctionSets.map(s => String(s.key)).filter(k => !requested.includes(k))];
        const rank = new Map(order.map((k,i) => [k,i]));
        state.auctionSets.sort((a,b) => rank.get(String(a.key))-rank.get(String(b.key)));
        state.auctionSetOrder = state.auctionSets.map(s => s.key);
        return {};
      },
      'skip-set': async ctx => {
        const { state } = ctx; await loadOrder(ctx);
        const key = String(ctx.payload.setKey ?? state.currentSetNumber ?? '');
        const set = state.auctionSets.find(s => String(s.key) === key);
        if (!set) return { error: 'set_not_found' };
        const done = new Set((state.completedPlayerIds || []).map(Number));
        for (const id of set.ids) if (!done.has(Number(id))) { done.add(Number(id)); state.unsoldPlayerIds = addUnique(state.unsoldPlayerIds,id); }
        state.completedPlayerIds = [...done]; state.deferredSetKeys = (state.deferredSetKeys || []).filter(k => String(k) !== key);
        state.doneNames = [...new Set([...(state.doneNames || []), ...set.ids.map(Number)])];
        const names = await ctx.client.query('SELECT name FROM players WHERE id = ANY($1::int[])', [set.ids]);
        state.doneNames = [...new Set([...(state.doneNames || []).filter(v => typeof v === 'string'), ...names.rows.map(r => normName(r.name))])];
        syncCounts(state);
        const isCurrent = String(state.currentSetNumber) === key;
        if (isCurrent) { const next = await pickNext(ctx); if (!next) endAuction(state); else setCurrent(ctx,next,state.status === 'active' ? 'active' : 'ready'); }
        return { liveCurrent: Boolean(isCurrent && state.currentPlayerId), events: [['auction:set-skipped',{setKey:key, playerCount:set.ids.length}]] };
      },
      'unsold-round': async ctx => {
        const { state } = ctx;
        if (!['ended','waiting','ready'].includes(state.status)) return { error: 'auction_must_be_idle' };
        const ids = [...new Set((state.unsoldPlayerIds || []).map(Number))];
        if (!ids.length) return { error: 'no_unsold_players' };
        const namesResult = await ctx.client.query('SELECT id,name FROM players WHERE id = ANY($1::int[])', [ids]);
        const nameKeys = new Set(namesResult.rows.map(r => normName(r.name)));
        state.completedPlayerIds = (state.completedPlayerIds || []).filter(id => !ids.includes(Number(id)));
        state.doneNames = (state.doneNames || []).filter(name => !nameKeys.has(name));
        state.unsoldPlayerIds = []; state.unsoldCount = 0; state.soldCount = (state.soldPlayerIds || []).length;
        state.deferredPlayerIds = ids; state.status = 'ready'; state.currentPlayerId = null; state.currentPlayer = null;
        const next = await pickNext(ctx); if (!next) return { error: 'no_players_remaining' };
        setCurrent(ctx,next,'ready'); return { liveCurrent:true, events:[['auction:unsold-round-started',{playerCount:ids.length}]] };
      },
      'skip-player': async ctx => {
        const { state } = ctx;
        if (!state.currentPlayerId || ['sold', 'unsold', 'ended'].includes(state.status)) return { error: 'no_active_player' };
        const skipped = state.currentPlayer || {};
        const wasActive = state.status === 'active';
        state.completedPlayerIds = addUnique(state.completedPlayerIds, state.currentPlayerId);
        state.skippedPlayerIds = addUnique(state.skippedPlayerIds, state.currentPlayerId);
        state.doneNames = [...new Set([...(state.doneNames || []), normName(skipped.name)])];
        const next = await pickNext(ctx);
        if (!next) endAuction(state); else setCurrent(ctx, next, wasActive ? 'active' : 'ready');
        return { liveCurrent: Boolean(next), events: [['sale:skipped', { playerName: skipped.name || 'Player', nextPlayerName: next?.name || null }]] };
      },
      end: async ctx => {
        const { state } = ctx;
        await loadOrder(ctx);
        const done = new Set((state.completedPlayerIds || []).map(Number));
        for (const set of state.auctionSets) for (const id of set.ids) {
          if (!done.has(Number(id))) { done.add(Number(id)); state.unsoldPlayerIds = addUnique(state.unsoldPlayerIds, id); }
        }
        state.completedPlayerIds = [...done];
        syncCounts(state);
        state.status = 'ended'; state.deadline = null; state.pausedRemainingMs = null;
        bump(state);
        return {};
      }
    };

    socket.on('auction:host-action', async ({ action, payload = {} } = {}, ack = () => {}) => {
      if (!socket.data?.isHost || !socket.data?.roomCode) return ack({ ok: false, error: 'host_only' });
      const run = hostActions[action];
      if (!run) return ack({ ok: false, error: 'unknown_action' });
      try {
        if (['next-player', 'skip-player', 'end'].includes(action)) clearAdvanceTimer(socket.data.roomCode);
        const out = await withRoom(socket.data.roomCode, ctx => run({ ...ctx, payload }));
        if (out.error) return ack({ ok: false, error: out.error });
        if (out.skip) return ack({ ok: true, state: publicState(out.room, out.state) });
        finish(out.room, out.state, out);
        ack({ ok: true, state: publicState(out.room, out.state) });
      } catch (e) { console.error('host action failed:', action, e.message); ack({ ok: false, error: 'host_action_failed' }); }
    });

    socket.on('disconnect', async () => {
      if (socket.data?.roomId && socket.data?.participantId) {
        try {
          // A participant may briefly have an old and a reconnected socket at once.
          // Do not mark them offline if another live socket already rejoined the room.
          const activeSockets = await io.in(socket.data.roomCode).fetchSockets();
          const replacementExists = activeSockets.some(s => s.data?.participantId === socket.data.participantId);
          if (!replacementExists) {
            await pool.query('UPDATE room_participants SET connected=false WHERE room_id=$1 AND participant_id=$2', [socket.data.roomId, socket.data.participantId]);
            socket.to(socket.data.roomCode).emit('presence:changed', { participantId: socket.data.participantId, connected: false });
            const participants = (await pool.query('SELECT participant_id,display_name,team_key,is_host,connected FROM room_participants WHERE room_id=$1 ORDER BY display_name', [socket.data.roomId])).rows;
            io.to(socket.data.roomCode).emit('lobby:participants', participants);
          }
          if (socket.data.voiceJoined) socket.to(socket.data.roomCode).emit('voice:peer-left', { socketId: socket.id });
        } catch { /* ignore */ }
      }
    });
  });
}
