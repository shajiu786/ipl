import { Router } from 'express';
import { z } from 'zod';
import { MODES, modeKeys, modeOfConfig, DEFAULT_MODE } from '../services/modes.js';
import { PURSE_PAISE, TEAM_LIST, TEAM_NAMES, makeCode, emptyState, dedupePlayers, publicState } from '../services/auction.js';

export function createApiRouter(pool) {
  const router = Router();
  const createSchema = z.object({ name: z.string().trim().min(2).max(60), displayName: z.string().trim().min(1).max(40), participantId: z.string().min(8).max(100), mode: z.enum(modeKeys).optional(), config: z.object({ openingBidPaise: z.number().int().positive().optional(), incrementPaise: z.number().int().positive().optional(), durationSeconds: z.number().int().min(5).max(120).optional() }).optional() });
  router.get('/players', async (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(500, Math.max(1, Number(req.query.limit) || 30));
      const q = String(req.query.q || '').trim(), role = String(req.query.role || '').trim();
      // the pool depends on the room's mode (?room=CODE) or an explicit ?dataset=
      let dataset = MODES[req.query.dataset]?.dataset || null;
      if (!dataset && req.query.room) {
        const r = await pool.query('SELECT config FROM auction_rooms WHERE code=$1', [String(req.query.room).toUpperCase()]);
        if (r.rowCount) dataset = MODES[modeOfConfig(r.rows[0].config)].dataset;
      }
      dataset = dataset || MODES[DEFAULT_MODE].dataset;
      const result = await pool.query(
        `SELECT id, name, role, nationality, batting_style, bowling_style, photo_url, base_price_paise, source_attribution, data_cutoff, source_data, stats
         FROM players WHERE dataset=$3 AND ($1 = '' OR name ILIKE '%' || $1 || '%') AND ($2 = '' OR role ILIKE '%' || $2 || '%')
         ORDER BY id`, [q, role, dataset]);
      // one entry per person, even if the table holds repeated rows
      const unique = dedupePlayers(result.rows).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      res.json({ data: unique.slice((page - 1) * limit, page * limit), page, limit, total: unique.length });
    } catch { res.status(500).json({ error: 'players_query_failed' }); }
  });
  router.get('/players/:id', async (req, res) => {
    try { const r = await pool.query('SELECT * FROM players WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error:'player_not_found' }); res.json(r.rows[0]); }
    catch { res.status(400).json({ error:'invalid_player_id' }); }
  });
  router.get('/modes', async (req, res) => {
    try {
      const counts = await pool.query('SELECT dataset, COUNT(*)::int AS n FROM players GROUP BY dataset');
      const byDataset = Object.fromEntries(counts.rows.map(r => [r.dataset, r.n]));
      res.json({ data: Object.values(MODES).map(m => ({ key: m.key, name: m.name, tagline: m.tagline, players: byDataset[m.dataset] || 0 })) });
    } catch { res.status(500).json({ error: 'modes_query_failed' }); }
  });
  router.post('/rooms', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error:'invalid_request', details: parsed.error.flatten() });
    const { name, displayName, participantId, mode = DEFAULT_MODE, config = {} } = parsed.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let code, exists;
      do { code = makeCode(); exists = await client.query('SELECT 1 FROM auction_rooms WHERE code=$1', [code]); } while (exists.rowCount);
      const state = emptyState();
      const room = await client.query(
        `INSERT INTO auction_rooms(code,name,host_participant_id,config,state) VALUES($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING *`,
        [code, name, participantId, JSON.stringify({ openingBidPaise:200000000, incrementPaise:250000000, durationSeconds:10, ...config, mode }), JSON.stringify(state)]);
      await client.query(`INSERT INTO room_participants(room_id,participant_id,display_name,is_host) VALUES($1,$2,$3,true)`, [room.rows[0].id, participantId, displayName]);
      await client.query('COMMIT');
      res.status(201).json({ room: room.rows[0], participant: { participantId, displayName, isHost: true }, teams: TEAM_LIST });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error:'room_create_failed' }); }
    finally { client.release(); }
  });
  router.post('/rooms/:code/join', async (req, res) => {
    // A participant may join the lobby before choosing a team. The UI uses
    // the separate team:select Socket.IO event to claim a team afterwards.
    const schema = z.object({
      participantId: z.string().min(8).max(100),
      displayName: z.string().trim().min(1).max(40),
      teamKey: z.string().refine(v => Boolean(TEAM_NAMES[v])).optional()
    });
    const p = schema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error:'invalid_request', details:p.error.flatten() });
    try {
      const room = await pool.query('SELECT * FROM auction_rooms WHERE code=$1', [String(req.params.code || '').trim().toUpperCase()]);
      if (!room.rowCount) return res.status(404).json({ error:'room_not_found' });
      const r = room.rows[0];
      const already = await pool.query(
        'SELECT * FROM room_participants WHERE room_id=$1 AND participant_id=$2',
        [r.id, p.data.participantId]
      );
      if (already.rowCount) {
        const updated = await pool.query(
          'UPDATE room_participants SET connected=true, display_name=$3 WHERE room_id=$1 AND participant_id=$2 RETURNING *',
          [r.id, p.data.participantId, p.data.displayName]
        );
        return res.json({ room:r, participant:updated.rows[0] });
      }
      if (p.data.teamKey) {
        const used = await pool.query(
          'SELECT 1 FROM room_participants WHERE room_id=$1 AND team_key=$2',
          [r.id, p.data.teamKey]
        );
        if (used.rowCount) return res.status(409).json({ error:'team_already_taken' });
      }
      const joined = await pool.query(
        'INSERT INTO room_participants(room_id,participant_id,display_name,team_key) VALUES($1,$2,$3,$4) RETURNING *',
        [r.id, p.data.participantId, p.data.displayName, p.data.teamKey || null]
      );
      res.json({ room:r, participant:joined.rows[0] });
    } catch (error) {
      console.error('room_join_failed:', error);
      res.status(500).json({ error:'room_join_failed' });
    }
  });
  router.get('/rooms/:code', async (req,res) => {
    try {
      const r = await pool.query('SELECT id,code,name,status,config,state,created_at FROM auction_rooms WHERE code=$1',[req.params.code.toUpperCase()]);
      if (!r.rowCount) return res.status(404).json({error:'room_not_found'});
      const participants = await pool.query('SELECT participant_id,display_name,team_key,is_host,connected FROM room_participants WHERE room_id=$1 ORDER BY joined_at',[r.rows[0].id]);
      res.json({room:{...r.rows[0],state:publicState(r.rows[0],r.rows[0].state)},participants:participants.rows,teams:TEAM_LIST});
    } catch { res.status(500).json({error:'room_query_failed'}); }
  });
  router.get('/rooms/:code/auction', async (req,res) => {
    try { const r=await pool.query('SELECT id,code,status,config,state FROM auction_rooms WHERE code=$1',[req.params.code.toUpperCase()]); if(!r.rowCount)return res.status(404).json({error:'room_not_found'}); res.json({...r.rows[0],state:publicState(r.rows[0],r.rows[0].state)}); }
    catch { res.status(500).json({error:'auction_query_failed'}); }
  });
  router.get('/rooms/:code/bids', async (req,res) => {
    try { const r=await pool.query(`SELECT b.*,p.name AS player_name, rp.display_name FROM auction_bids b LEFT JOIN players p ON p.id=b.player_id LEFT JOIN room_participants rp ON rp.participant_id=b.participant_id AND rp.room_id=b.room_id JOIN auction_rooms ar ON ar.id=b.room_id WHERE ar.code=$1 ORDER BY b.created_at DESC LIMIT 100`,[req.params.code.toUpperCase()]); res.json({data:r.rows}); }
    catch { res.status(500).json({error:'bids_query_failed'}); }
  });
  router.get('/rooms/:code/chat', async (req,res) => {
    try { const r=await pool.query(`SELECT c.id,c.display_name,c.team_key,c.message,c.created_at FROM room_chat c JOIN auction_rooms a ON a.id=c.room_id WHERE a.code=$1 ORDER BY c.created_at DESC LIMIT 100`,[req.params.code.toUpperCase()]); res.json({data:r.rows.reverse()}); }
    catch { res.status(500).json({error:'chat_query_failed'}); }
  });
  router.get('/rooms/:code/squads', async (req,res) => {
    try { const r=await pool.query(`SELECT s.team_key,p.*,s.purchase_price_paise FROM room_squad_players s JOIN players p ON p.id=s.player_id JOIN auction_rooms r ON r.id=s.room_id WHERE r.code=$1 ORDER BY s.team_key,p.name`,[req.params.code.toUpperCase()]); res.json({data:r.rows}); }
    catch { res.status(500).json({error:'squads_query_failed'}); }
  });
  router.get('/rooms/:code/purses', async (req,res) => {
    try {
      const room=await pool.query('SELECT id FROM auction_rooms WHERE code=$1',[req.params.code.toUpperCase()]);
      if(!room.rowCount)return res.status(404).json({error:'room_not_found'});
      const r=await pool.query(`SELECT t.team_key,COALESCE(SUM(s.purchase_price_paise),0)::bigint AS spent_paise,COUNT(s.id)::int AS players_bought FROM (SELECT unnest($2::text[]) AS team_key) t LEFT JOIN room_squad_players s ON s.room_id=$1 AND s.team_key=t.team_key GROUP BY t.team_key ORDER BY t.team_key`,[room.rows[0].id,TEAM_LIST.map(t=>t[0])]);
      res.json({initialPursePaise:PURSE_PAISE, data:r.rows.map(x=>({...x,remainingPursePaise:PURSE_PAISE-Number(x.spent_paise)}))});
    } catch { res.status(500).json({error:'purses_query_failed'}); }
  });
  router.get('/rooms/:code/playing-xi', async (req,res) => {
    try { const r=await pool.query(`SELECT x.team_key,x.position,p.* FROM playing_xi x JOIN players p ON p.id=x.player_id JOIN auction_rooms a ON a.id=x.room_id WHERE a.code=$1 ORDER BY x.team_key,x.position`,[req.params.code.toUpperCase()]); res.json({data:r.rows}); }
    catch { res.status(500).json({error:'playing_xi_query_failed'}); }
  });
  router.put('/rooms/:code/playing-xi', async (req,res) => {
    const p=z.object({participantId:z.string().min(8),teamKey:z.string(),playerIds:z.array(z.number().int().positive()).max(11)}).safeParse(req.body);
    if(!p.success)return res.status(400).json({error:'invalid_request'});
    if(new Set(p.data.playerIds).size!==p.data.playerIds.length)return res.status(400).json({error:'duplicate_players'});
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      const room=await c.query('SELECT id FROM auction_rooms WHERE code=$1 FOR UPDATE',[req.params.code.toUpperCase()]);
      if(!room.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'room_not_found'});}
      const member=await c.query('SELECT 1 FROM room_participants WHERE room_id=$1 AND participant_id=$2 AND team_key=$3',[room.rows[0].id,p.data.participantId,p.data.teamKey]);
      if(!member.rowCount){await c.query('ROLLBACK');return res.status(403).json({error:'not_team_owner'});}
      const eligible=await c.query('SELECT player_id FROM room_squad_players WHERE room_id=$1 AND team_key=$2 AND player_id=ANY($3::bigint[])',[room.rows[0].id,p.data.teamKey,p.data.playerIds]);
      if(eligible.rowCount!==p.data.playerIds.length){await c.query('ROLLBACK');return res.status(400).json({error:'players_must_be_in_squad'});}
      await c.query('DELETE FROM playing_xi WHERE room_id=$1 AND team_key=$2',[room.rows[0].id,p.data.teamKey]);
      for(let i=0;i<p.data.playerIds.length;i++)await c.query('INSERT INTO playing_xi(room_id,team_key,player_id,position) VALUES($1,$2,$3,$4)',[room.rows[0].id,p.data.teamKey,p.data.playerIds[i],i+1]);
      await c.query('COMMIT'); res.json({ok:true,selected:p.data.playerIds.length});
    } catch { await c.query('ROLLBACK');res.status(500).json({error:'playing_xi_save_failed'}); }
    finally {c.release();}
  });
  return router;
}
 
