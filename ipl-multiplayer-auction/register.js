import { z } from 'zod';
import { nextBidAmount, TEAM_NAMES } from '../services/auction.js';

export function registerSockets(io, pool) {
  const deadlineTimers = new Map();
  const advanceTimers = new Map();
  const clearAdvanceTimer = code => {
    const timer = advanceTimers.get(String(code).toUpperCase());
    if (timer) clearTimeout(timer);
    advanceTimers.delete(String(code).toUpperCase());
  };
  const clearRoomTimer = code => {
    const timer = deadlineTimers.get(code);
    if (timer) clearTimeout(timer);
    deadlineTimers.delete(code);
  };
  const scheduleRoomTimer = (code, deadline) => {
    clearRoomTimer(code);
    if (!deadline) return;
    const delay = Math.max(0, new Date(deadline).getTime() - Date.now());
    const timer = setTimeout(() => { settleExpiredAuction(code).catch(() => {}); }, delay);
    deadlineTimers.set(code, timer);
  };
  const settleExpiredAuction = async code => {
    const client = await pool.connect();
    let emitted = null;
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM auction_rooms WHERE code=$1 FOR UPDATE', [String(code).toUpperCase()]);
      if (!result.rowCount) { await client.query('ROLLBACK'); return; }
      const room = result.rows[0];
      const state = room.state || {};
      if (state.status !== 'active' || !state.deadline || Date.now() < new Date(state.deadline).getTime()) {
        await client.query('ROLLBACK');
        if (state.status === 'active' && state.deadline) scheduleRoomTimer(room.code, state.deadline);
        return;
      }
      const playerId = Number(state.currentPlayerId || 0);
      if (!playerId) {
        state.status = 'ended'; state.deadline = null; room.status = 'ended';
      } else {
        state.completedPlayerIds = Array.isArray(state.completedPlayerIds) ? state.completedPlayerIds : [];
        if (!state.completedPlayerIds.map(Number).includes(playerId)) state.completedPlayerIds.push(playerId);
        if (state.highestBidder && Number(state.currentBidPaise) > 0) {
          const inserted = await client.query(
            `INSERT INTO room_squad_players(room_id,team_key,player_id,purchase_price_paise)
             VALUES($1,$2,$3,$4) ON CONFLICT(room_id,player_id) DO NOTHING RETURNING player_id`,
            [room.id, state.highestBidder.teamKey, playerId, Number(state.currentBidPaise)]
          );
          if (inserted.rowCount) {
            state.status = 'sold';
            state.soldCount = Number(state.soldCount || 0) + 1;
            state.soldPlayerIds = Array.isArray(state.soldPlayerIds) ? state.soldPlayerIds : [];
            if (!state.soldPlayerIds.map(Number).includes(playerId)) state.soldPlayerIds.push(playerId);
            emitted = { status: 'sold', teamKey: state.highestBidder.teamKey, teamName: state.highestBidder.teamName,
              playerName: state.currentPlayer?.name || 'Player', amountPaise: Number(state.currentBidPaise) };
          } else {
            state.status = 'sold';
          }
        } else {
          state.status = 'unsold';
          state.unsoldCount = Number(state.unsoldCount || 0) + 1;
          state.unsoldPlayerIds = Array.isArray(state.unsoldPlayerIds) ? state.unsoldPlayerIds : [];
          if (!state.unsoldPlayerIds.map(Number).includes(playerId)) state.unsoldPlayerIds.push(playerId);
          state.unsoldPlayers = Array.isArray(state.unsoldPlayers) ? state.unsoldPlayers : [];
          if (state.currentPlayer && !state.unsoldPlayers.some(p => Number(p.id) === playerId)) state.unsoldPlayers.push(state.currentPlayer);
          emitted = { status: 'unsold', playerName: state.currentPlayer?.name || 'Player', amountPaise: 0 };
        }
        state.deadline = null;
        state.pausedRemainingMs = null;
        room.status = state.status;
        state.currentSetNumber = state.currentPlayer?.source_data?.set_number ?? state.currentPlayer?.source_data?.setNumber ?? state.currentSetNumber ?? 'Unassigned';
      }
      await client.query('UPDATE auction_rooms SET state=$2::jsonb,status=$3 WHERE id=$1', [room.id, JSON.stringify(state), room.status]);
      await client.query('COMMIT');
      io.to(room.code).emit('auction:state', state);
      if (emitted) io.to(room.code).emit('sale:celebration', emitted);
      if (['sold', 'unsold'].includes(state.status)) scheduleAdvance(room.code);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
      clearRoomTimer(String(code).toUpperCase());
    }
  };
  const roomIdFor = async code => {
    const r = await pool.query('SELECT * FROM auction_rooms WHERE code=$1', [String(code || '').toUpperCase()]);
    return r.rows[0] || null;
  };
  // Create one randomized, server-owned order per room. Sets are shuffled first,
  // then players inside each set; the saved ID list is reused after reconnects.
  const shuffle = items => {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const ensureAuctionOrder = async (room, state) => {
    if (Array.isArray(state.auctionPlayerOrder) && state.auctionPlayerOrder.length) return state;
    const result = await pool.query(`SELECT id, source_data FROM players ORDER BY id`);
    const bySet = new Map();
    for (const row of result.rows) {
      const setKey = String(row.source_data?.set_number ?? row.source_data?.setNumber ?? 'Unassigned');
      if (!bySet.has(setKey)) bySet.set(setKey, []);
      bySet.get(setKey).push(Number(row.id));
    }
    const randomizedSetKeys = shuffle([...bySet.keys()]);
    state.auctionSetOrder = randomizedSetKeys;
    state.auctionPlayerOrder = randomizedSetKeys.flatMap(key => shuffle(bySet.get(key)));
    state.completedPlayerIds = Array.isArray(state.completedPlayerIds) ? state.completedPlayerIds : [];
    await pool.query('UPDATE auction_rooms SET state=$2::jsonb WHERE id=$1', [room.id, JSON.stringify(state)]);
    return state;
  };
  const selectNextFromSavedOrder = async (state) => {
    const completed = new Set((state.completedPlayerIds || []).map(Number));
    const currentId = Number(state.currentPlayerId || 0);
    if (currentId && ['sold', 'unsold'].includes(state.status)) completed.add(currentId);
    state.completedPlayerIds = [...completed];
    const nextId = (state.auctionPlayerOrder || []).map(Number).find(id => !completed.has(id));
    if (!nextId) return null;
    const player = await pool.query('SELECT id,name,role,nationality,batting_style,bowling_style,photo_url,base_price_paise,source_data FROM players WHERE id=$1', [nextId]);
    return player.rows[0] || null;
  };
  const scheduleAdvance = code => {
    clearAdvanceTimer(code);
    const normalizedCode = String(code).toUpperCase();
    const timer = setTimeout(() => {
      advanceRoomToNext(normalizedCode).catch(() => {});
    }, 3500);
    advanceTimers.set(normalizedCode, timer);
  };
  const advanceRoomToNext = async code => {
    const client = await pool.connect();
    let stateToEmit = null;
    let setCompleteEvent = null;
    let roomCode = String(code).toUpperCase();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM auction_rooms WHERE code=$1 FOR UPDATE', [roomCode]);
      if (!result.rowCount) { await client.query('ROLLBACK'); return; }
      const room = result.rows[0];
      const state = room.state || {};
      if (!['sold', 'unsold'].includes(state.status)) { await client.query('ROLLBACK'); return; }
      const previousPlayer = state.currentPlayer || {};
      const previousSet = previousPlayer.source_data?.set_number ?? previousPlayer.source_data?.setNumber ?? state.currentSetNumber ?? 'Unassigned';
      await ensureAuctionOrder(room, state);
      const next = await selectNextFromSavedOrder(state);
      if (!next) {
        state.currentPlayerId = null;
        state.currentPlayer = null;
        state.currentBidPaise = 0;
        state.highestBidder = null;
        state.status = 'ended';
        state.deadline = null;
        room.status = 'ended';
      } else {
        const nextSet = next.source_data?.set_number ?? next.source_data?.setNumber ?? 'Unassigned';
        const allPlayersInPreviousSet = await client.query(
          `SELECT id FROM players WHERE COALESCE(source_data->>'set_number', source_data->>'setNumber', 'Unassigned')=$1`,
          [String(previousSet)]
        );
        const completedIds = new Set((state.completedPlayerIds || []).map(Number));
        const setIsComplete = allPlayersInPreviousSet.rows.length > 0 && allPlayersInPreviousSet.rows.every(row => completedIds.has(Number(row.id)));
        if (String(previousSet) !== String(nextSet) && setIsComplete) {
          setCompleteEvent = { completedSetNumber: String(previousSet), nextSetNumber: String(nextSet), completedSetName: `Set ${previousSet}`, nextSetName: `Set ${nextSet}` };
        }
        state.currentPlayerId = Number(next.id);
        state.currentPlayer = next;
        state.currentSetNumber = nextSet;
        state.currentBidPaise = 0;
        state.highestBidder = null;
        state.status = 'active';
        state.pausedRemainingMs = null;
        state.deadline = new Date(Date.now() + Number(room.config.durationSeconds || 10) * 1000).toISOString();
        room.status = 'active';
      }
      stateToEmit = state;
      await client.query('UPDATE auction_rooms SET state=$2::jsonb,status=$3 WHERE id=$1', [room.id, JSON.stringify(state), room.status]);
      await client.query('COMMIT');
      clearAdvanceTimer(roomCode);
      io.to(roomCode).emit('auction:state', stateToEmit);
      if (setCompleteEvent) io.to(roomCode).emit('auction:set-complete', setCompleteEvent);
      if (stateToEmit.status === 'active' && stateToEmit.deadline) scheduleRoomTimer(roomCode, stateToEmit.deadline);
      else clearRoomTimer(roomCode);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  };
  io.on('connection', socket => {
    socket.on('team:select', async ({ code, participantId, teamKey } = {}, ack = () => {}) => {
      const normalizedCode = String(code || '').toUpperCase();
      if (!participantId || !TEAM_NAMES[teamKey]) return ack({ ok:false, error:'invalid_team' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const roomResult = await client.query('SELECT id,code FROM auction_rooms WHERE code=$1 FOR UPDATE', [normalizedCode]);
        if (!roomResult.rowCount) { await client.query('ROLLBACK'); return ack({ ok:false, error:'room_not_found' }); }
        const room = roomResult.rows[0];
        const member = await client.query('SELECT * FROM room_participants WHERE room_id=$1 AND participant_id=$2 FOR UPDATE', [room.id, participantId]);
        if (!member.rowCount) { await client.query('ROLLBACK'); return ack({ ok:false, error:'not_a_room_member' }); }
        const taken = await client.query('SELECT 1 FROM room_participants WHERE room_id=$1 AND team_key=$2 AND participant_id<>$3 LIMIT 1', [room.id, teamKey, participantId]);
        if (taken.rowCount) { await client.query('ROLLBACK'); return ack({ ok:false, error:'team_taken' }); }
        await client.query('UPDATE room_participants SET team_key=$3 WHERE room_id=$1 AND participant_id=$2', [room.id, participantId, teamKey]);
        await client.query('COMMIT');
        const participantsResult = await pool.query('SELECT participant_id,display_name,team_key,is_host,connected FROM room_participants WHERE room_id=$1 ORDER BY display_name', [room.id]);
        const participants = participantsResult.rows;
        const updated = participants.find(p => p.participant_id === participantId);
        io.to(normalizedCode).emit('lobby:participants', participants);
        ack({ ok:true, participant:updated, participants });
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        ack({ ok:false, error:'team_selection_failed' });
      } finally { client.release(); }
    });

    socket.on('room:join-live', async ({ code, participantId } = {}, ack = () => {}) => {
      try {
        const room = await roomIdFor(code);
        if (!room) return ack({ ok:false, error:'room_not_found' });
        const p = await pool.query('SELECT * FROM room_participants WHERE room_id=$1 AND participant_id=$2', [room.id, participantId]);
        if (!p.rowCount) return ack({ ok:false, error:'not_a_room_member' });
        socket.data = { roomId: room.id, roomCode: room.code, participantId, teamKey: p.rows[0].team_key, isHost: p.rows[0].is_host };
        socket.join(room.code);
        if (room.state?.status === 'active' && room.state?.deadline) scheduleRoomTimer(room.code, room.state.deadline);
        await pool.query('UPDATE room_participants SET connected=true WHERE room_id=$1 AND participant_id=$2',[room.id,participantId]);
        socket.to(room.code).emit('presence:changed', { participantId, connected:true });
        ack({ ok:true, room: { code:room.code, state:room.state, config:room.config, status:room.status } });
      } catch { ack({ ok:false, error:'join_failed' }); }
    });

    socket.on('bid:place', async (payload = {}, ack = () => {}) => {
      const schema = z.object({ code:z.string().min(4), participantId:z.string().min(8), requestId:z.string().min(8).max(100) });
      const p = schema.safeParse(payload);
      if (!p.success) return ack({ ok:false, error:'invalid_request' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query('SELECT * FROM auction_rooms WHERE code=$1 FOR UPDATE',[p.data.code.toUpperCase()]);
        if (!r.rowCount) { await client.query('ROLLBACK'); return ack({ok:false,error:'room_not_found'}); }
        const room = r.rows[0];
        const member = await client.query('SELECT * FROM room_participants WHERE room_id=$1 AND participant_id=$2',[room.id,p.data.participantId]);
        if (!member.rowCount) { await client.query('ROLLBACK'); return ack({ok:false,error:'not_a_room_member'}); }
        const state = room.state || {};
        if (state.status !== 'active' || room.status !== 'active') { await client.query('ROLLBACK'); return ack({ok:false,error:'auction_not_active'}); }
        if (!state.currentPlayerId) { await client.query('ROLLBACK'); return ack({ok:false,error:'no_current_player'}); }
        if (!state.deadline || Date.now() >= new Date(state.deadline).getTime()) { await client.query('ROLLBACK'); return ack({ok:false,error:'timer_expired'}); }
        if (!member.rows[0].team_key || !TEAM_NAMES[member.rows[0].team_key]) { await client.query('ROLLBACK'); return ack({ok:false,error:'team_not_selected'}); }
        if (state.highestBidder?.teamKey === member.rows[0].team_key) { await client.query('ROLLBACK'); return ack({ok:false,error:'already_highest_bidder'}); }
        const next = nextBidAmount(room,state);
        const purse = await client.query(`SELECT 120000000000-COALESCE(SUM(purchase_price_paise),0) AS remaining FROM room_squad_players WHERE room_id=$1 AND team_key=$2`,[room.id,member.rows[0].team_key]);
        const remaining = Number(purse.rows[0]?.remaining ?? 120000000000);
        if (remaining < next) { await client.query('ROLLBACK'); return ack({ok:false,error:'insufficient_purse',remainingPursePaise:remaining}); }
        const bid = await client.query(`INSERT INTO auction_bids(room_id,player_id,participant_id,team_key,amount_paise,status) VALUES($1,$2,$3,$4,$5,'accepted') RETURNING *`,
          [room.id,state.currentPlayerId,p.data.participantId,member.rows[0].team_key,next]);
        state.currentBidPaise = next;
        state.highestBidder = { participantId:p.data.participantId, displayName:member.rows[0].display_name, teamKey:member.rows[0].team_key, teamName:TEAM_NAMES[member.rows[0].team_key] };
        state.deadline = new Date(Date.now() + Number(room.config.durationSeconds || 10) * 1000).toISOString();
        state.auctionVersion = Number(state.auctionVersion || 0) + 1;
        await client.query('UPDATE auction_rooms SET state=$2::jsonb WHERE id=$1',[room.id,JSON.stringify(state)]);
        await client.query('COMMIT');
        const response = { ok:true, bid:bid.rows[0], state, nextBidPaise:nextBidAmount(room,state) };
        scheduleRoomTimer(room.code, state.deadline);
        io.to(room.code).emit('auction:state',state);
        io.to(room.code).emit('bid:accepted',{...response, participantName:member.rows[0].display_name, teamKey:member.rows[0].team_key});
        ack(response);
      } catch (e) { await client.query('ROLLBACK'); ack({ok:false,error:'bid_failed'}); }
      finally { client.release(); }
    });

    socket.on('chat:send', async (payload = {}, ack = () => {}) => {
      const p=z.object({message:z.string().trim().min(1).max(500)}).safeParse(payload);
      if(!p.success)return ack({ok:false,error:'invalid_message'});
      if(!socket.data.roomId || !socket.data.participantId)return ack({ok:false,error:'not_in_room'});
      try {
        const r=await pool.query('SELECT display_name,team_key FROM room_participants WHERE room_id=$1 AND participant_id=$2',[socket.data.roomId,socket.data.participantId]);
        if(!r.rowCount)return ack({ok:false,error:'not_a_room_member'});
        const saved=await pool.query(`INSERT INTO room_chat(room_id,participant_id,display_name,team_key,message) VALUES($1,$2,$3,$4,$5) RETURNING *`,
          [socket.data.roomId,socket.data.participantId,r.rows[0].display_name,r.rows[0].team_key,p.data.message]);
        io.to(socket.data.roomCode).emit('chat:message',saved.rows[0]); ack({ok:true,message:saved.rows[0]});
      } catch { ack({ok:false,error:'chat_send_failed'}); }
    });

    socket.on('voice:join', () => {
      if (!socket.data.roomCode || !socket.data.participantId) return;
      socket.data.voiceJoined = true;
      const peers = [...io.sockets.sockets.values()]
        .filter(peer => peer.id !== socket.id
          && peer.data?.roomCode === socket.data.roomCode
          && peer.data?.voiceJoined)
        .map(peer => ({ socketId: peer.id, participantId: peer.data.participantId }));
      socket.emit('voice:peers', peers);
      socket.to(socket.data.roomCode).emit('voice:peer-joined', {
        socketId: socket.id, participantId: socket.data.participantId
      });
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
      io.to(targetSocketId).emit('voice:signal', { from:socket.id, signal, participantId:socket.data.participantId });
    });

    socket.on('auction:host-action', async ({ action, payload = {} } = {}, ack = () => {}) => {
      if (!socket.data.isHost || !socket.data.roomId) return ack({ok:false,error:'host_only'});
      try {
        const r=await pool.query('SELECT * FROM auction_rooms WHERE id=$1 FOR UPDATE',[socket.data.roomId]);
        const room=r.rows[0], state=room.state || {};
        if(action==='set-duration') {
          const duration = Number(payload.durationSeconds);
          if (!Number.isInteger(duration) || duration < 5 || duration > 10) return ack({ok:false,error:'invalid_duration'});
          room.config = { ...(room.config || {}), durationSeconds: duration };
          state.durationSeconds = duration;
          if (state.status === 'active') state.deadline = new Date(Date.now() + duration * 1000).toISOString();
          await pool.query('UPDATE auction_rooms SET config=$2::jsonb,state=$3::jsonb WHERE id=$1', [room.id, JSON.stringify(room.config), JSON.stringify(state)]);
          if (state.status === 'active' && state.deadline) scheduleRoomTimer(room.code, state.deadline);
          io.to(room.code).emit('auction:state', state);
        } else if(action==='skip-player') {
          clearAdvanceTimer(room.code);
          if (!state.currentPlayerId || ['sold','unsold','ended'].includes(state.status)) return ack({ok:false,error:'no_active_player'});
          const skippedPlayer = state.currentPlayer || {};
          const wasActive = state.status === 'active';
          state.completedPlayerIds = Array.isArray(state.completedPlayerIds) ? state.completedPlayerIds : [];
          state.skippedPlayerIds = Array.isArray(state.skippedPlayerIds) ? state.skippedPlayerIds : [];
          const skippedId = Number(state.currentPlayerId);
          if (!state.completedPlayerIds.map(Number).includes(skippedId)) state.completedPlayerIds.push(skippedId);
          if (!state.skippedPlayerIds.map(Number).includes(skippedId)) state.skippedPlayerIds.push(skippedId);
          await ensureAuctionOrder(room, state);
          const next = await selectNextFromSavedOrder(state);
          state.currentBidPaise = 0;
          state.highestBidder = null;
          state.pausedRemainingMs = null;
          if (!next) {
            state.currentPlayerId = null; state.currentPlayer = null; state.status = 'ended'; state.deadline = null; room.status = 'ended';
          } else {
            state.currentPlayerId = Number(next.id); state.currentPlayer = next;
            state.currentSetNumber = next.source_data?.set_number ?? next.source_data?.setNumber ?? 'Unassigned';
            state.status = wasActive ? 'active' : 'ready';
            state.deadline = wasActive ? new Date(Date.now() + Number(room.config.durationSeconds || 10) * 1000).toISOString() : null;
            room.status = state.status;
          }
          await pool.query('UPDATE auction_rooms SET state=$2::jsonb,status=$3 WHERE id=$1', [room.id, JSON.stringify(state), room.status]);
          if (state.status === 'active' && state.deadline) scheduleRoomTimer(room.code, state.deadline); else clearRoomTimer(room.code);
          io.to(room.code).emit('auction:state', state);
          io.to(room.code).emit('sale:skipped', { playerName: skippedPlayer.name || 'Player', nextPlayerName: state.currentPlayer?.name || null });
        } else if(action==='start') {
          await ensureAuctionOrder(room, state);
          if(!state.currentPlayerId) {
            const next = await selectNextFromSavedOrder(state);
            if (!next) return ack({ok:false,error:'no_players_remaining'});
            state.currentPlayerId=Number(next.id); state.currentPlayer=next; state.currentSetNumber=next.source_data?.set_number ?? next.source_data?.setNumber ?? 'Unassigned'; state.currentBidPaise=0; state.highestBidder=null;
          }
          state.status='active'; state.deadline=new Date(Date.now() + Number(room.config.durationSeconds || 10)*1000).toISOString(); room.status='active';
        } else if(action==='next-player') {
          clearAdvanceTimer(room.code);
          await ensureAuctionOrder(room, state);
          const next = await selectNextFromSavedOrder(state);
          if (!next) { state.currentPlayerId=null; state.currentPlayer=null; state.status='ended'; state.deadline=null; room.status='ended'; }
          else { state.currentPlayerId=Number(next.id); state.currentPlayer=next; state.currentSetNumber=next.source_data?.set_number ?? next.source_data?.setNumber ?? 'Unassigned'; state.currentBidPaise=0; state.highestBidder=null; state.status='ready'; state.deadline=null; room.status='ready'; }
        } else if(action==='pause') {
          if (state.status !== 'active') return ack({ok:false,error:'auction_not_active'});
          state.pausedRemainingMs = Math.max(0, new Date(state.deadline || Date.now()).getTime() - Date.now());
          state.status='paused'; state.deadline=null; room.status='paused';
        }
        else if(action==='resume') {
          if (state.status !== 'paused') return ack({ok:false,error:'auction_not_paused'});
          const remainingMs = Math.max(1000, Number(state.pausedRemainingMs || Number(room.config.durationSeconds || 10) * 1000));
          state.status='active'; state.deadline=new Date(Date.now()+remainingMs).toISOString(); state.pausedRemainingMs=null; room.status='active';
        }
        else if(action==='set-player') {
          const id=Number(payload.playerId);
          const player=await pool.query('SELECT id,name,role,nationality,batting_style,bowling_style,photo_url,base_price_paise,source_data FROM players WHERE id=$1',[id]);
          if(!player.rowCount)return ack({ok:false,error:'player_not_found'});
          state.currentPlayerId=id;state.currentPlayer=player.rows[0];state.currentBidPaise=0;state.highestBidder=null;state.status='ready';state.deadline=null;room.status='ready';
        } else if(action==='sell') {
          if(!state.highestBidder || !state.currentPlayerId)return ack({ok:false,error:'no_valid_bid'});
          if (['sold', 'unsold', 'ended'].includes(state.status)) return ack({ok:false,error:'player_already_settled'});
          const alreadySold = await pool.query('SELECT 1 FROM room_squad_players WHERE room_id=$1 AND player_id=$2', [room.id, state.currentPlayerId]);
          if (alreadySold.rowCount) return ack({ok:false,error:'player_already_settled'});
          await pool.query('INSERT INTO room_squad_players(room_id,team_key,player_id,purchase_price_paise) VALUES($1,$2,$3,$4) ON CONFLICT(room_id,player_id) DO NOTHING',[room.id,state.highestBidder.teamKey,state.currentPlayerId,state.currentBidPaise]);
          state.status='sold';state.soldCount=Number(state.soldCount||0)+1;state.deadline=null;room.status='sold';state.completedPlayerIds=Array.isArray(state.completedPlayerIds)?state.completedPlayerIds:[];state.soldPlayerIds=Array.isArray(state.soldPlayerIds)?state.soldPlayerIds:[];if(!state.completedPlayerIds.map(Number).includes(Number(state.currentPlayerId)))state.completedPlayerIds.push(Number(state.currentPlayerId));if(!state.soldPlayerIds.map(Number).includes(Number(state.currentPlayerId)))state.soldPlayerIds.push(Number(state.currentPlayerId));
        } else if(action==='unsold') {
          if (!state.currentPlayerId || ['sold','unsold','ended'].includes(state.status)) return ack({ok:false,error:'no_active_player'});
          state.status='unsold';state.unsoldCount=Number(state.unsoldCount||0)+1;state.deadline=null;room.status='unsold';
          state.completedPlayerIds=Array.isArray(state.completedPlayerIds)?state.completedPlayerIds:[];
          state.unsoldPlayerIds=Array.isArray(state.unsoldPlayerIds)?state.unsoldPlayerIds:[];
          state.unsoldPlayers=Array.isArray(state.unsoldPlayers)?state.unsoldPlayers:[];
          if(!state.completedPlayerIds.map(Number).includes(Number(state.currentPlayerId)))state.completedPlayerIds.push(Number(state.currentPlayerId));
          if(!state.unsoldPlayerIds.map(Number).includes(Number(state.currentPlayerId)))state.unsoldPlayerIds.push(Number(state.currentPlayerId));
          if(state.currentPlayer && !state.unsoldPlayers.some(p=>Number(p.id)===Number(state.currentPlayerId)))state.unsoldPlayers.push(state.currentPlayer);
        }
        else if(action==='end') {
          state.completedPlayerIds=Array.isArray(state.completedPlayerIds)?state.completedPlayerIds:[];
          state.unsoldPlayerIds=Array.isArray(state.unsoldPlayerIds)?state.unsoldPlayerIds:[];
          state.unsoldPlayers=Array.isArray(state.unsoldPlayers)?state.unsoldPlayers:[];
          const remainingPlayers = await pool.query('SELECT id,name,role,nationality,source_data FROM players WHERE NOT (id = ANY($1::bigint[])) ORDER BY id', [state.completedPlayerIds.map(Number)]);
          for (const player of remainingPlayers.rows) {
            const id=Number(player.id);
            if (!state.unsoldPlayerIds.map(Number).includes(id)) state.unsoldPlayerIds.push(id);
            if (!state.completedPlayerIds.map(Number).includes(id)) state.completedPlayerIds.push(id);
            if (!state.unsoldPlayers.some(p=>Number(p.id)===id)) state.unsoldPlayers.push(player);
          }
          state.status='ended';state.deadline=null;state.pausedRemainingMs=null;room.status='ended';
        }
        else return ack({ok:false,error:'unknown_action'});
        await pool.query('UPDATE auction_rooms SET state=$2::jsonb,status=$3 WHERE id=$1',[room.id,JSON.stringify(state),room.status]);
        if (state.status === 'active' && state.deadline) scheduleRoomTimer(room.code, state.deadline);
        else clearRoomTimer(room.code);
        io.to(room.code).emit('auction:state',state);
        if (['sell', 'unsold'].includes(action)) io.to(room.code).emit('sale:celebration', {
          status: action === 'unsold' ? 'unsold' : 'sold',
          teamKey: state.highestBidder?.teamKey,
          teamName: state.highestBidder?.teamName,
          playerName: state.currentPlayer?.name || 'Player',
          amountPaise: Number(state.currentBidPaise || 0)
        });
        if (['sell', 'unsold'].includes(action)) scheduleAdvance(room.code);
        ack({ok:true,state});
      } catch { ack({ok:false,error:'host_action_failed'}); }
    });

    socket.on('disconnect', async () => {
      if(socket.data?.roomId && socket.data?.participantId) {
        try {
          await pool.query('UPDATE room_participants SET connected=false WHERE room_id=$1 AND participant_id=$2',[socket.data.roomId,socket.data.participantId]);
          socket.to(socket.data.roomCode).emit('presence:changed',{participantId:socket.data.participantId,connected:false});
          if (socket.data.voiceJoined) socket.to(socket.data.roomCode).emit('voice:peer-left',{socketId:socket.id});
        } catch {}
      }
    });
  }); 
}
