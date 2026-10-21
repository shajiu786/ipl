import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { Activity, ArrowUpRight, BadgeIndianRupee, Check, ChevronDown, CircleHelp, Clipboard, Crown, Gavel, Headphones, Home, ListOrdered, MessageCircle, Mic, MicOff, Pause, Play, Radio, Search, Settings, ShieldCheck, Users, Wallet, X } from 'lucide-react';

const API = (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/$/,'');
const SOCKET_URL = (import.meta.env.VITE_SOCKET_URL || API).replace(/\/$/,'');
const TEAM_LIST = [['csk','Chennai Super Kings'],['mi','Mumbai Indians'],['rcb','Royal Challengers Bengaluru'],['kkr','Kolkata Knight Riders'],['rr','Rajasthan Royals'],['srh','Sunrisers Hyderabad'],['dc','Delhi Capitals'],['pbks','Punjab Kings'],['gt','Gujarat Titans'],['lsg','Lucknow Super Giants']];
const money = paise => `₹${(Number(paise || 0)/1000000000).toFixed(2)} Cr`;
const idFor = () => { let v=sessionStorage.getItem('iplParticipantId'); if(!v){v=crypto.randomUUID();sessionStorage.setItem('iplParticipantId',v);} return v; };
const explain = code => ({team_already_taken:'That franchise is already taken.',auction_not_active:'The auction is not active.',no_current_player:'The host has not selected a player.',timer_expired:'The countdown has expired.',already_highest_bidder:'Your team is already the highest bidder.',insufficient_purse:'Your team does not have enough purse.',not_a_room_member:'You are not a participant in this room.',host_only:'Only the host can perform this action.'}[code] || String(code || 'Something went wrong').replaceAll('_',' '));

export default function App() {
  const [view,setView]=useState('landing');
  const [roomCode,setRoomCode]=useState('');
  const [roomName,setRoomName]=useState('Friday Night Auction');
  const [displayName,setDisplayName]=useState('');
  const [teamKey,setTeamKey]=useState('csk');
  const [participant,setParticipant]=useState(null);
  const [room,setRoom]=useState(null);
  const [participants,setParticipants]=useState([]);
  const [players,setPlayers]=useState([]);
  const [playerQuery,setPlayerQuery]=useState('');
  const [auction,setAuction]=useState({status:'waiting',currentBidPaise:0,deadline:null,auctionVersion:1});
  const [bids,setBids]=useState([]);
  const [messages,setMessages]=useState([]);
  const [chatText,setChatText]=useState('');
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);
  const [remaining,setRemaining]=useState(0);
  const [purses,setPurses]=useState([]);
  const [squads,setSquads]=useState([]);
  const [xi,setXi]=useState([]);
  const [xiTeam,setXiTeam]=useState('csk');
  const [voiceJoined,setVoiceJoined]=useState(false);
  const [muted,setMuted]=useState(false);
  const [speechListening,setSpeechListening]=useState(false);
  const [speechText,setSpeechText]=useState('');
  const socketRef=useRef(null);
  const chatRef=useRef(null);
  const bottomRef=useRef(null);
  const lastMessageCount=useRef(0);
  const isHost=Boolean(participant?.isHost || participant?.is_host);
  const myTeam=participant?.teamKey || participant?.team_key;
  const currentPlayer=auction.currentPlayer || null;
  const nextBid=useMemo(()=>Number(auction.currentBidPaise||0)===0?Number(room?.config?.openingBidPaise||200000000):Number(auction.currentBidPaise)+Number(room?.config?.incrementPaise||250000000),[auction.currentBidPaise,room?.config]);
  const api=axios.create({baseURL:API});

  const loadPlayers=useCallback(async(q='')=>{try{const r=await api.get('/api/players',{params:{q,limit:60}});setPlayers(r.data.data||[]);}catch{}},[]);
  const loadRoomData=useCallback(async(code)=>{
    try {
      const [roomR,bidR,purseR,squadR,xiR,chatR]=await Promise.all([
        api.get(`/api/rooms/${code}`),api.get(`/api/rooms/${code}/bids`),api.get(`/api/rooms/${code}/purses`),
        api.get(`/api/rooms/${code}/squads`),api.get(`/api/rooms/${code}/playing-xi`),
        api.get(`/api/rooms/${code}/chat`).catch(()=>({data:{data:[]}}))
      ]);
      setRoom(roomR.data.room);setParticipants(roomR.data.participants||[]);setAuction(roomR.data.room.state||{status:roomR.data.room.status,currentBidPaise:0});
      setBids(bidR.data.data||[]);setPurses(purseR.data.data||[]);setSquads(squadR.data.data||[]);setXi(xiR.data.data||[]);setMessages(chatR.data.data||[]);
    } catch(e){setNotice(explain(e.response?.data?.error||'could_not_load_room'));}
  },[]);
  const enterRoom=useCallback(async(code,p)=>{
    setParticipant(p);setRoomCode(code);setView('room');
    const socket=io(SOCKET_URL,{transports:['websocket','polling']});socketRef.current=socket;
    socket.on('connect',()=>socket.emit('room:join-live',{code,participantId:p.participantId||p.participant_id},res=>{if(res?.ok){setAuction(res.room.state||{});setNotice('Connected to live auction');}else setNotice(explain(res?.error));}));
    socket.on('auction:state',s=>setAuction(s));
    socket.on('bid:accepted',e=>{setBids(old=>[e.bid,...old].slice(0,100));setNotice(`${e.participantName} bid ${money(e.bid.amount_paise)}`);});
    socket.on('chat:message',m=>setMessages(old=>[...old,m]));
    socket.on('presence:changed',()=>loadRoomData(code));
    socket.on('connect_error',()=>setNotice('Connection issue. Retrying…'));
    await loadRoomData(code); await loadPlayers();
  },[loadRoomData,loadPlayers]);
  useEffect(()=>()=>{socketRef.current?.disconnect();},[]);
  useEffect(()=>{if(!auction.deadline){setRemaining(0);return;}const tick=()=>setRemaining(Math.max(0,Math.ceil((new Date(auction.deadline).getTime()-Date.now())/1000)));tick();const t=setInterval(tick,250);return()=>clearInterval(t);},[auction.deadline,auction.auctionVersion]);
  useEffect(()=>{if(view==='room'&&roomCode){const t=setInterval(()=>loadRoomData(roomCode),12000);return()=>clearInterval(t);}},[view,roomCode,loadRoomData]);
  useEffect(()=>{if(view==='room')loadPlayers(playerQuery);},[playerQuery,view,loadPlayers]);

  const createRoom=async()=>{
    if(!displayName.trim())return setNotice('Enter your display name first.');
    setBusy(true);try{const r=await api.post('/api/rooms',{name:roomName,displayName,participantId:idFor()});const p={participantId:r.data.participant.participantId,displayName,isHost:true,teamKey:null};await enterRoom(r.data.room.code,p);}catch(e){setNotice(explain(e.response?.data?.error||'room_create_failed'));}finally{setBusy(false);}
  };
  const joinRoom=async()=>{
    if(!displayName.trim()||!roomCode.trim())return setNotice('Enter your name and room code.');
    setBusy(true);try{const r=await api.post(`/api/rooms/${roomCode.trim().toUpperCase()}/join`,{participantId:idFor(),displayName,teamKey});const p={...r.data.participant,participantId:r.data.participant.participant_id||idFor(),teamKey:r.data.participant.team_key||teamKey};await enterRoom(roomCode.trim().toUpperCase(),p);}catch(e){setNotice(explain(e.response?.data?.error||'room_join_failed'));}finally{setBusy(false);}
  };
  const placeBid=()=>{if(!socketRef.current)return setNotice('Connect to a room before bidding.');setNotice('Submitting bid…');socketRef.current.emit('bid:place',{code:roomCode,participantId:participant?.participantId||participant?.participant_id,requestId:crypto.randomUUID()},res=>{if(res?.ok){setAuction(res.state);setNotice(`Bid accepted: ${money(res.bid.amount_paise)}`);}else setNotice(`Bid rejected: ${explain(res?.error)}`);});};
  const sendChat=e=>{e?.preventDefault();const message=chatText.trim();if(!message||!socketRef.current)return;socketRef.current.emit('chat:send',{message},res=>{if(res?.ok)setChatText('');else setNotice(explain(res?.error));});};
  const hostAction=(action,payload={})=>socketRef.current?.emit('auction:host-action',{action,payload},res=>{if(!res?.ok)setNotice(explain(res?.error));else{setAuction(res.state);setNotice('Auction state updated.');}});
  const choosePlayer=player=>hostAction('set-player',{playerId:Number(player.id)});
  const saveXI=async()=>{
    try{await api.put(`/api/rooms/${roomCode}/playing-xi`,{participantId:participant?.participantId||participant?.participant_id,teamKey:xiTeam,playerIds:xi.filter(x=>x.team_key===xiTeam).map(x=>Number(x.id))});setNotice('Playing XI saved.');await loadRoomData(roomCode);}
    catch(e){setNotice(explain(e.response?.data?.error||'playing_xi_save_failed'));}
  };
  const toggleXI=playerId=>{
    const current=xi.filter(x=>x.team_key===xiTeam);
    if(current.some(x=>Number(x.id)===Number(playerId)))setXi(xi.filter(x=>!(x.team_key===xiTeam&&Number(x.id)===Number(playerId))));
    else if(current.length<11){const p=squads.find(x=>x.team_key===xiTeam&&Number(x.id)===Number(playerId));if(p)setXi([...xi,{...p,team_key:xiTeam,position:current.length+1}]);}
    else setNotice('Playing XI can contain up to 11 players.');
  };
  const sendVoiceCommand=command=>{
    const c=command.toLowerCase();
    if(c.includes('bid'))placeBid();
    else if(c.includes('squad'))setView('squads');
    else if(c.includes('playing'))setView('xi');
    else if(c.includes('purse'))setView('stats');
    else if(c.includes('auction'))setView('auction');
    else if(c.includes('mute microphone'))setMuted(true);
    else if(c.includes('unmute microphone'))setMuted(false);
  };
  const toggleSpeech=()=>{
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR)return setNotice('Speech recognition is not supported in this browser.');
    if(speechListening){setSpeechListening(false);return;}
    const rec=new SR();rec.lang='en-IN';rec.continuous=false;rec.interimResults=false;
    rec.onresult=e=>{const phrase=e.results[0][0].transcript;setSpeechText(phrase);sendVoiceCommand(phrase);};
    rec.onerror=()=>setNotice('Could not recognize that command. Use the manual controls.');
    rec.onend=()=>setSpeechListening(false);setSpeechListening(true);rec.start();
  };
  const teamName=key=>TEAM_LIST.find(t=>t[0]===key)?.[1]||'No team selected';
  const leaveRoom=()=>{socketRef.current?.disconnect();socketRef.current=null;setRoom(null);setParticipant(null);setView('landing');setRoomCode('');};

  if(view==='landing') return <main className="landing">
    <div className="landing-top"><div className="brand"><span className="brand-mark"><Gavel size={21}/></span><span>AUCTION<span className="gold">ROOM</span></span></div><span className="pill"><span className="live-dot"/> REAL-TIME IPL AUCTION</span></div>
    <section className="hero"><div className="eyebrow"><Radio size={15}/> THE AUCTION STARTS HERE</div><h1>Build your legacy.<br/><span>One bid at a time.</span></h1><p>Create a private auction room, draft your franchise, and compete live with friends.</p>
      <div className="entry-grid"><article className="entry-card"><div className="card-icon"><Crown/></div><h2>Create a room</h2><p>Host your own IPL player auction.</p><label>Room name</label><input value={roomName} onChange={e=>setRoomName(e.target.value)} maxLength="60"/><label>Your display name</label><input value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="e.g. Shaji" maxLength="40"/><button className="primary wide" disabled={busy} onClick={createRoom}>{busy?'Creating…':'Create private room'} <ArrowUpRight size={17}/></button></article>
      <article className="entry-card"><div className="card-icon"><Users/></div><h2>Join a room</h2><p>Enter a code and claim your franchise.</p><label>Room code</label><input value={roomCode} onChange={e=>setRoomCode(e.target.value.toUpperCase())} placeholder="e.g. A8F2QK" maxLength="8"/><label>Your display name</label><input value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="Your name" maxLength="40"/><label>Choose franchise</label><select value={teamKey} onChange={e=>setTeamKey(e.target.value)}>{TEAM_LIST.map(([k,n])=><option value={k} key={k}>{n}</option>)}</select><button className="secondary wide" disabled={busy} onClick={joinRoom}>Join auction room <ArrowUpRight size={17}/></button></article></div>
    </section><footer className="landing-footer">MADE FOR THE LOVE OF THE GAME <span>•</span> PRIVATE ROOMS • LIVE BIDDING</footer>{notice&&<div className="toast">{notice}<button onClick={()=>setNotice('')}><X size={14}/></button></div>}
  </main>;

  const nav=[['auction','Auction',Gavel],['squads','Squads',Users],['xi','Playing XI',ListOrdered],['stats','Stats & Purses',Wallet],['more','More',Settings]];
  const teamPurse=purses.find(p=>p.team_key===myTeam);
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark"><Gavel size={19}/></span><span>AUCTION<span className="gold">ROOM</span></span></div><div className="room-meta"><span className="pill"><span className="live-dot"/>{auction.status==='active'?'LIVE':String(auction.status||'WAITING').toUpperCase()}</span><span className="room-label">{room?.name||'IPL Auction'}</span><button className="code-chip" onClick={()=>{navigator.clipboard?.writeText(roomCode);setNotice('Room code copied.')}}><Clipboard size={13}/>{roomCode}</button></div><div className="top-actions"><span className="connection"><span className="green-dot"/> Connected</span><button className="icon-btn" title="Leave room" onClick={leaveRoom}><X size={17}/></button></div></header>
    <div className="workspace">
      <section className="auction-stage">
        <div className="section-heading"><div><div className="eyebrow">LOT {auction.currentPlayerId||'—'} <span>•</span> IPL PLAYER AUCTION</div><h1>Live auction <span className="live-badge"><span className="live-dot"/> LIVE</span></h1></div><div className="stage-stats"><div><strong>{auction.soldCount||0}</strong><small>SOLD</small></div><div><strong>{auction.unsoldCount||0}</strong><small>UNSOLD</small></div><div><strong>{players.length}</strong><small>LOADED</small></div></div></div>
        <div className="auction-grid">
          <article className="player-card">
            <div className="player-art">{currentPlayer?.photo_url?<img src={currentPlayer.photo_url} alt={currentPlayer.name}/>:<div className="player-placeholder"><span>IPL</span><Gavel size={46}/><small>PLAYER PROFILE</small></div>}<div className="player-label">CURRENT PLAYER</div></div>
            <div className="player-info"><div className="player-topline"><span className="role-tag">{currentPlayer?.role||'Awaiting player'}</span><span className="nation-tag">{currentPlayer?.nationality||'—'}</span></div><h2>{currentPlayer?.name||'Waiting for the host'}</h2><p>{currentPlayer?.batting_style||'Batting style unavailable'}{currentPlayer?.bowling_style?` · ${currentPlayer.bowling_style}`:''}</p><div className="player-metrics"><div><small>BASE PRICE</small><strong>{currentPlayer?.base_price_paise?money(currentPlayer.base_price_paise):'—'}</strong></div><div><small>PLAYER ID</small><strong>{currentPlayer?.id||'—'}</strong></div></div></div>
          </article>
          <article className="bid-card"><div className="bid-card-head"><span><Activity size={15}/> LIVE BIDDING</span><span className="round-tag">ROUND 01</span></div><div className="countdown"><div className={`timer ${remaining<=5?'urgent':''}`}>{String(Math.floor(remaining/60)).padStart(2,'0')}:{String(remaining%60).padStart(2,'0')}</div><span>TIME LEFT</span></div><div className="current-bid"><small>CURRENT BID</small><strong>{money(auction.currentBidPaise)}</strong><div className="highest"><span className="avatar">{(auction.highestBidder?.teamName||'?').slice(0,1)}</span><div><small>HIGHEST BIDDER</small><b>{auction.highestBidder?.teamName||'No bids yet'}</b></div><span className="highest-amount">{auction.highestBidder?money(auction.currentBidPaise):'—'}</span></div></div><div className="next-bid"><span>NEXT VALID BID</span><strong>{money(nextBid)}</strong></div><button className="primary bid-button" onClick={placeBid} disabled={auction.status!=='active'||!currentPlayer||remaining===0||myTeam===auction.highestBidder?.teamKey}><Gavel size={18}/> PLACE BID <span>{money(nextBid)}</span></button><div className="your-purse"><span><Wallet size={15}/> YOUR TEAM PURSE</span><strong>{teamPurse?money(teamPurse.remainingPursePaise):'₹120.00 Cr'}</strong></div>
            {isHost&&<div className="host-controls"><div className="host-label"><ShieldCheck size={14}/> HOST CONTROLS</div><div className="host-row"><button onClick={()=>hostAction(auction.status==='active'?'pause':'start')}><Play size={14}/>{auction.status==='active'?'Pause':'Start'}</button><button onClick={()=>hostAction('resume')}><Activity size={14}/>Resume</button><button onClick={()=>hostAction('sell')}><Check size={14}/>Sold</button><button onClick={()=>hostAction('unsold')}>Unsold</button><button onClick={()=>hostAction('end')}><X size={14}/>End</button></div></div>}
          </article>
        </div>
      </section>
      <section className="activity-grid"><article className="panel chat-panel"><div className="panel-title"><div><MessageCircle size={17}/><h3>Live chat</h3><span className="count">{messages.length}</span></div><span className="subtle">ROOM CHAT</span></div><div className="chat-list" ref={chatRef}>{messages.map((m,i)=><div className="chat-message" key={m.id||i}><span className="chat-avatar">{(m.display_name||'P').slice(0,1).toUpperCase()}</span><div className="chat-body"><div className="chat-author"><b>{m.display_name||'Participant'}</b><span>{m.team_key?teamName(m.team_key):'Host'}</span><time>{m.created_at?new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'now'}</time></div><p>{m.message}</p></div></div>)}{!messages.length&&<div className="empty-state">Say hello to the room. Keep the banter friendly.</div>}</div><form className="chat-compose" onSubmit={sendChat}><input value={chatText} onChange={e=>setChatText(e.target.value)} placeholder="Message the room…" maxLength="500"/><button className="send-btn" type="submit"><ArrowUpRight size={17}/></button></form></article>
        <article className="panel activity-panel"><div className="panel-title"><div><ListOrdered size={17}/><h3>Bid activity</h3><span className="count">{bids.length}</span></div><span className="subtle">LATEST BIDS</span></div><div className="bid-feed">{bids.slice(0,15).map((b,i)=><div className="bid-row" key={b.id||i}><div className="bid-status"><Check size={13}/></div><div className="bid-row-copy"><b>{b.display_name||b.participant_id||'Bidder'}</b><span>{teamName(b.team_key)} · {b.player_name||currentPlayer?.name||'Player'}</span></div><strong>{money(b.amount_paise)}</strong></div>)}{!bids.length&&<div className="empty-state">Accepted bids will appear here in real time.</div>}</div></article></section>
      <section className="section-content" aria-live="polite">
        {view==='squads'&&<div className="panel content-panel"><div className="content-head"><div><div className="eyebrow">TEAM MANAGEMENT</div><h2>Franchise squads</h2></div><span className="subtle">{squads.length} PURCHASED PLAYERS</span></div><div className="team-grid">{TEAM_LIST.map(([key,name])=>{const list=squads.filter(p=>p.team_key===key);const purse=purses.find(p=>p.team_key===key);return <article className="team-card" key={key}><div className="team-mark">{key.toUpperCase()}</div><h3>{name}</h3><div className="team-card-stats"><span>{list.length} players</span><b>{money(purse?.remainingPursePaise??120000000000)} left</b></div><div className="mini-roster">{list.slice(0,5).map(p=><span key={p.id}>{p.name}</span>)}{!list.length&&<span className="muted">No players purchased yet</span>}{list.length>5&&<span className="muted">+{list.length-5} more</span>}</div></article>})}</div></div>}
        {view==='xi'&&<div className="panel content-panel"><div className="content-head"><div><div className="eyebrow">LINEUP BUILDER</div><h2>Playing XI</h2></div><select value={xiTeam} onChange={e=>setXiTeam(e.target.value)}>{TEAM_LIST.map(([k,n])=><option value={k} key={k}>{n}</option>)}</select></div><p className="muted">Select up to 11 players from the chosen franchise's purchased squad. Changes are saved to the server.</p><div className="xi-progress"><span>{xi.filter(x=>x.team_key===xiTeam).length}/11 selected</span><div><i style={{width:`${xi.filter(x=>x.team_key===xiTeam).length/11*100}%`}}/></div></div><div className="xi-list">{squads.filter(p=>p.team_key===xiTeam).map(p=><label className="xi-player" key={p.id}><input type="checkbox" checked={xi.some(x=>x.team_key===xiTeam&&Number(x.id)===Number(p.id))} onChange={()=>toggleXI(p.id)}/><span><b>{p.name}</b><small>{p.role||'Role N/A'}</small></span><strong>{money(p.purchase_price_paise)}</strong></label>)}{!squads.some(p=>p.team_key===xiTeam)&&<div className="empty-state">This team has no purchased players yet.</div>}</div><button className="primary" onClick={saveXI} disabled={!(myTeam===xiTeam||isHost)}>Save Playing XI</button></div>}
        {view==='stats'&&<div className="panel content-panel"><div className="content-head"><div><div className="eyebrow">AUCTION OVERVIEW</div><h2>Stats & purses</h2></div><span className="subtle">TEAM BUDGETS</span></div><div className="purse-table"><div className="purse-row purse-header"><span>FRANCHISE</span><span>PLAYERS</span><span>SPENT</span><span>REMAINING</span></div>{purses.map(p=><div className="purse-row" key={p.team_key}><b>{teamName(p.team_key)}</b><span>{p.players_bought}</span><span>{money(p.spent_paise)}</span><strong>{money(p.remainingPursePaise)}</strong></div>)}</div></div>}
        {view==='more'&&<div className="panel content-panel"><div className="eyebrow">ROOM CONTROL</div><h2>Room & voice settings</h2><div className="more-grid"><div className="setting-card"><h3><Users size={17}/> Participants</h3>{participants.map(p=><p key={p.participant_id}><span className={p.connected?'green-dot':'gray-dot'}/>{p.display_name} · {p.team_key?teamName(p.team_key):'Host'} {p.is_host?'(Host)':''}</p>)}</div><div className="setting-card"><h3><Headphones size={17}/> Voice chat</h3><p>Voice signaling is available in the server. Add a peer-connection client for your chosen topology before using this as production voice chat.</p><button className="secondary" onClick={()=>{setVoiceJoined(!voiceJoined);setNotice(voiceJoined?'Voice mode left.':'Voice mode toggled. Connect WebRTC peers to enable audio.')}}>{voiceJoined?'Leave voice':'Join voice'}</button><button className="secondary" onClick={()=>setMuted(!muted)}>{muted?<Mic size={15}/>:<MicOff size={15}/>} {muted?'Unmute':'Mute'} microphone</button></div><div className="setting-card"><h3><Mic size={17}/> Voice commands</h3><p>Say “Bid”, “Squads”, “Playing XI”, “Purses”, or “Auction”. Commands use the same app actions as manual controls.</p><button className={speechListening?'danger':'secondary'} onClick={toggleSpeech}>{speechListening?'Listening…':'Enable speech commands'}</button>{speechText&&<p className="muted">Recognized: “{speechText}”</p>}</div><div className="setting-card"><h3><CircleHelp size={17}/> Room info</h3><p>Share this room code with your friends.</p><button className="secondary" onClick={()=>{navigator.clipboard?.writeText(`${location.origin}?room=${roomCode}`);setNotice('Room link copied.')}}><Clipboard size={15}/> Copy invite link</button><p className="muted">Room code: {roomCode}</p></div></div></div>}
      </section>
    </div>
    <nav className="bottom-nav">{nav.map(([id,label,Icon])=><button key={id} className={view===id?'active':''} onClick={()=>setView(id)}><Icon size={18}/><span>{label}</span></button>)}</nav>
    {notice&&<div className="toast">{notice}<button onClick={()=>setNotice('')}><X size={14}/></button></div>}
  </div>;
}
