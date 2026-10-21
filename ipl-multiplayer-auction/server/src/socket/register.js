import { z } from 'zod';
import { nextBidAmount, TEAM_NAMES } from '../services/auction.js';

export function registerSockets(io, pool) {
  const roomIdFor = async code => {
    const r = await pool.query('SELECT * FROM auction_rooms WHERE code=$1', [String(code || '').toUpperCase()]);
    return r.rows[0] || null;
  };
  io.on('connection', socket => {
    socket.on('room:join-live', async ({ code, participantId } = {}, ack = () => {}) => {
      try {
        const room = await roomIdFor(code);
        if (!room) return ack({ ok:false, error:'room_not_found' });
        const p = await pool.query('SELECT * FROM room_participants WHERE room_id=$1 AND participant_id=$2', [room.id, participantId]);
        if (!p.rowCount) return ack({ ok:false, error:'not_a_room_member' });
        socket.data = { roomId: room.id, roomCode: room.code, participantId, teamKey: p.rows[0].team_key, isHost: p.rows[0].is_host };
        socket.join(room.code);
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
        state.auctionVersion = Number(state.auctionVersion || 0) + 1;
        await client.query('UPDATE auction_rooms SET state=$2::jsonb WHERE id=$1',[room.id,JSON.stringify(state)]);
        await client.query('COMMIT');
        const response = { ok:true, bid:bid.rows[0], state, nextBidPaise:nextBidAmount(room,state) };
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

    socket.on('voice:signal', ({ targetSocketId, signal } = {}) => {
      if (!socket.data.roomCode || !targetSocketId || !signal) return;
      io.to(targetSocketId).emit('voice:signal', { from:socket.id, signal, participantId:socket.data.participantId });
    });

    socket.on('auction:host-action', async ({ action, payload = {} } = {}, ack = () => {}) => {
      if (!socket.data.isHost || !socket.data.roomId) return ack({ok:false,error:'host_only'});
      try {
        const r=await pool.query('SELECT * FROM auction_rooms WHERE id=$1 FOR UPDATE',[socket.data.roomId]);
        const room=r.rows[0], state=room.state || {};
        if(action==='start') {
          if(!state.currentPlayerId) return ack({ok:false,error:'select_player_first'});
          state.status='active'; state.deadline=new Date(Date.now() + Number(room.config.durationSeconds || 10)*1000).toISOString(); room.status='active';
        } else if(action==='pause') { state.status='paused'; state.deadline=null; room.status='paused'; }
        else if(action==='resume') { state.status='active'; state.deadline=new Date(Date.now()+Number(room.config.durationSeconds||10)*1000).toISOString(); room.status='active'; }
        else if(action==='set-player') {
          const id=Number(payload.playerId);
          const player=await pool.query('SELECT id,name,role,nationality,batting_style,bowling_style,photo_url,base_price_paise,source_data FROM players WHERE id=$1',[id]);
          if(!player.rowCount)return ack({ok:false,error:'player_not_found'});
          state.currentPlayerId=id;state.currentPlayer=player.rows[0];state.currentBidPaise=0;state.highestBidder=null;state.status='ready';state.deadline=null;room.status='ready';
        } else if(action==='sell') {
          if(!state.highestBidder || !state.currentPlayerId)return ack({ok:false,error:'no_valid_bid'});
          await pool.query('INSERT INTO room_squad_players(room_id,team_key,player_id,purchase_price_paise) VALUES($1,$2,$3,$4) ON CONFLICT(room_id,player_id) DO NOTHING',[room.id,state.highestBidder.teamKey,state.currentPlayerId,state.currentBidPaise]);
          state.status='sold';state.soldCount=Number(state.soldCount||0)+1;state.deadline=null;room.status='ready';
        } else if(action==='unsold') { state.status='unsold';state.unsoldCount=Number(state.unsoldCount||0)+1;state.deadline=null;room.status='ready'; }
        else if(action==='end') { state.status='ended';state.deadline=null;room.status='ended'; }
        else return ack({ok:false,error:'unknown_action'});
        await pool.query('UPDATE auction_rooms SET state=$2::jsonb,status=$3 WHERE id=$1',[room.id,JSON.stringify(state),room.status]);
        io.to(room.code).emit('auction:state',state);ack({ok:true,state});
      } catch { ack({ok:false,error:'host_action_failed'}); }
    });

    socket.on('disconnect', async () => {
      if(socket.data?.roomId && socket.data?.participantId) {
        try { await pool.query('UPDATE room_participants SET connected=false WHERE room_id=$1 AND participant_id=$2',[socket.data.roomId,socket.data.participantId]); socket.to(socket.data.roomCode).emit('presence:changed',{participantId:socket.data.participantId,connected:false}); } catch {}
      }
    });
  });
}
