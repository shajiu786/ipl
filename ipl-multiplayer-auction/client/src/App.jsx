import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { Activity, ArrowUpRight, BadgeIndianRupee, Check, ChevronDown, CircleHelp, Clipboard, Crown, Gavel, Headphones, Home, ListOrdered, MessageCircle, Mic, MicOff, Pause, Play, Radio, Search, Settings, ShieldCheck, Users, Wallet, X } from 'lucide-react';

const API = (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/$/,'');
const SOCKET_URL = (import.meta.env.VITE_SOCKET_URL || API).replace(/\/$/,'');
const TEAM_LIST = [['csk','Chennai Super Kings'],['mi','Mumbai Indians'],['rcb','Royal Challengers Bengaluru'],['kkr','Kolkata Knight Riders'],['rr','Rajasthan Royals'],['srh','Sunrisers Hyderabad'],['dc','Delhi Capitals'],['pbks','Punjab Kings'],['gt','Gujarat Titans'],['lsg','Lucknow Super Giants']];
const TEAM_COLORS={csk:'#f4c542',mi:'#4da3ff',rcb:'#f05252',kkr:'#a78bfa',rr:'#f472b6',srh:'#fb923c',dc:'#60a5fa',pbks:'#ef4444',gt:'#9ca3af',lsg:'#34d399'};
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
  const [soundEnabled,setSoundEnabled]=useState(true);
  const [saleCelebration,setSaleCelebration]=useState(null);
  const socketRef=useRef(null);
  const chatRef=useRef(null);
  const bottomRef=useRef(null);
  const lastMessageCount=useRef(0);
  const localStreamRef=useRef(null);
  const peersRef=useRef(new Map());
  const [remoteStreams,setRemoteStreams]=useState([]);
  const sectionRef=useRef(null);
  const isHost=Boolean(participant?.isHost || participant?.is_host);
  const myTeam=participant?.teamKey || participant?.team_key;
  const currentPlayer=auction.currentPlayer || null;
  const nextBid=useMemo(()=>Number(auction.currentBidPaise||0)===0?Number(room?.config?.openingBidPaise||200000000):Number(auction.currentBidPaise)+Number(room?.config?.incrementPaise||250000000),[auction.currentBidPaise,room?.config]);
  const api=axios.create({baseURL:API});

  const loadPlayers=useCallback(async(q='')=>{try{const r=await api.get('/api/players',{params:{q,limit:300}});setPlayers(r.data.data||[]);}catch{}},[]);
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
    socket.on('auction:state',s=>{setAuction(s);if(s?.status==='sold'&&s?.currentPlayer){setSaleCelebration({player:s.currentPlayer,teamKey:s.highestBidder?.teamKey,teamName:s.highestBidder?.teamName,bid:s.currentBidPaise});if(soundEnabled){try{const ctx=new (window.AudioContext||window.webkitAudioContext)();const osc=ctx.createOscillator();const gain=ctx.createGain();osc.connect(gain);gain.connect(ctx.destination);osc.frequency.setValueAtTime(880,ctx.currentTime);osc.frequency.setValueAtTime(1175,ctx.currentTime+0.12);gain.gain.setValueAtTime(0.12,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.35);osc.start();osc.stop(ctx.currentTime+0.35);}catch{}}window.setTimeout(()=>setSaleCelebration(null),4500);}});
    socket.on('bid:accepted',e=>{setBids(old=>[e.bid,...old].slice(0,100));setMessages(old=>[{id:`bid-${e.bid.id||Date.now()}`,eventType:'bid',display_name:e.participantName,team_key:e.teamKey,message:`bid ${money(e.bid.amount_paise)} on ${e.state?.currentPlayer?.name||'the current player'}`,created_at:new Date().toISOString(),amount_paise:e.bid.amount_paise},...old].slice(0,150));setNotice(`${e.participantName} bid ${money(e.bid.amount_paise)}`);});
    socket.on('chat:message',m=>setMessages(old=>[...old,m]));
    socket.on('presence:changed',()=>loadRoomData(code));
    socket.on('connect_error',()=>setNotice('Connection issue. Retrying…'));
    socket.on('voice:peers', peers=>{ if(localStreamRef.current) peers.forEach(peer=>createVoicePeer(peer.socketId,true)); });
    socket.on('voice:peer-joined', peer=>{ if(localStreamRef.current) createVoicePeer(peer.socketId,false); });
    socket.on('voice:peer-left', ({socketId})=>{peersRef.current.get(socketId)?.close();peersRef.current.delete(socketId);setRemoteStreams(old=>old.filter(x=>x.id!==socketId));});
    socket.on('voice:signal', async ({from,signal})=>{try{let pc=peersRef.current.get(from);if(!pc)pc=createVoicePeer(from,false);if(signal?.type){await pc.setRemoteDescription(new RTCSessionDescription(signal));if(signal.type==='offer'){const answer=await pc.createAnswer();await pc.setLocalDescription(answer);socket.emit('voice:signal',{targetSocketId:from,signal:pc.localDescription});}}else if(signal?.candidate){await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));}}catch(err){console.error('Voice signaling error',err);}});
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
  const hostAction=(action,payload={})=>socketRef.current?.emit('auction:host-action',{action,payload},res=>{if(!res?.ok)setNotice(explain(res?.error));else{setAuction(res.state);setNotice('Auction state updated.');if(action==='sell'||action==='unsold'){window.setTimeout(()=>socketRef.current?.emit('auction:host-action',{action:'next-player'},next=>{if(!next?.ok)setNotice(explain(next?.error));else{setAuction(next.state);setNotice(next.state.currentPlayer?`Next player: ${next.state.currentPlayer.name}`:'All players in the auction pool have been processed.');}}),1800);}}});
  const choosePlayer=player=>hostAction('set-player',{playerId:Number(player.id)});
  const createVoicePeer=(peerId,initiate=false)=>{
    if(peersRef.current.has(peerId))return peersRef.current.get(peerId);
    const socket=socketRef.current;if(!socket||!localStreamRef.current)return null;
    const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
    localStreamRef.current.getTracks().forEach(track=>pc.addTrack(track,localStreamRef.current));
    pc.onicecandidate=e=>{if(e.candidate)socket.emit('voice:signal',{targetSocketId:peerId,signal:{candidate:e.candidate}});};
    pc.ontrack=e=>setRemoteStreams(old=>[...old.filter(x=>x.id!==peerId),{id:peerId,stream:e.streams[0]}]);
    pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState)){setRemoteStreams(old=>old.filter(x=>x.id!==peerId));}};
    peersRef.current.set(peerId,pc);
    if(initiate)pc.createOffer().then(offer=>pc.setLocalDescription(offer)).then(()=>socket.emit('voice:signal',{targetSocketId:peerId,signal:pc.localDescription})).catch(err=>console.error('Voice offer failed',err));
    return pc;
  };
  const toggleVoice=async()=>{
    if(voiceJoined){peersRef.current.forEach(pc=>pc.close());peersRef.current.clear();setRemoteStreams([]);localStreamRef.current?.getTracks().forEach(t=>t.stop());localStreamRef.current=null;setVoiceJoined(false);setNotice('Voice chat disconnected.');return;}
    try{if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone access requires HTTPS and a supported browser.');localStreamRef.current=await navigator.mediaDevices.getUserMedia({audio:true,video:false});setVoiceJoined(true);socketRef.current?.emit('voice:join');setNotice('Microphone connected. Joining room voice chat…');}catch(e){setNotice(e.message||'Microphone permission was denied.');}
  };
  useEffect(()=>{if(['messages','squads','xi','sets','more'].includes(view)&&sectionRef.current)sectionRef.current.scrollIntoView({behavior:'smooth',block:'start'});},[view]);
  useEffect(()=>()=>{peersRef.current.forEach(pc=>pc.close());localStreamRef.current?.getTracks().forEach(t=>t.stop());},[]);

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
    else if(c.includes('purse'))setView('squads'); else if(c.includes('set'))setView('sets');
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

  const nav=[['auction','Auction',Gavel],['messages','Live Messages',MessageCircle],['squads','Squads',Users],['xi','Playing XI',ListOrdered],['sets','Sets',ListOrdered],['more','More',Settings]];
  const teamPurse=purses.find(p=>p.team_key===myTeam);
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark"><Gavel size={19}/></span><span>AUCTION<span className="gold">ROOM</span></span></div><div className="room-meta"><span className="pill"><span className="live-dot"/>{auction.status==='active'?'LIVE':String(auction.status||'WAITING').toUpperCase()}</span><span className="room-label">{room?.name||'IPL Auction'}</span><button className="code-chip" onClick={()=>{navigator.clipboard?.writeText(roomCode);setNotice('Room code copied.')}}><Clipboard size={13}/>{roomCode}</button></div><div className="top-actions"><span className="connection"><span className="green-dot"/> Connected</span><button className="icon-btn" title="Leave room" onClick={leaveRoom}><X size={17}/></button></div></header>
    <div className="workspace">
      <section className="panel team-lobby-panel"><div className="content-head"><div><div className="eyebrow">FRANCHISE DRAFT</div><h2>Teams & owners</h2></div><span className="subtle">{participants.filter(p=>p.team_key).length}/10 CLAIMED</span></div><div className="team-lobby-grid">{TEAM_LIST.map(([key,name])=>{const owner=participants.find(p=>p.team_key===key);return <article className={`team-lobby-card ${owner?'claimed':''}`} key={key} style={{'--team-color':TEAM_COLORS[key]}}><div className="team-logo-badge">{key.toUpperCase()}</div><div className="team-lobby-name"><b>{name}</b><small>{owner?`Selected by ${owner.display_name}`:'Available'}</small></div>{owner?<Check size={16}/>:<span className="available-dot"/>}</article>})}</div><div className="lobby-actions"><span className="muted">Host can start when everyone has chosen a franchise.</span>{isHost&&<button className="primary" onClick={()=>hostAction('start')}><Play size={15}/> Start Auction</button>}</div></section>
      <section className="auction-stage">
        <div className="section-heading"><div><div className="eyebrow">LOT {auction.currentPlayerId||'—'} <span>•</span> IPL PLAYER AUCTION</div><h1>Live auction <span className="live-badge"><span className="live-dot"/> LIVE</span></h1></div><div className="stage-stats"><div><strong>{auction.soldCount||0}</strong><small>SOLD</small></div><div><strong>{auction.unsoldCount||0}</strong><small>UNSOLD</small></div><div><strong>{players.length}</strong><small>LOADED</small></div></div></div>
        {isHost&&<details className="player-picker" style={{marginBottom:16,border:'1px solid #2b303b',borderRadius:12,background:'#10131a',padding:12}}>
          <summary style={{cursor:'pointer',fontWeight:700,color:'#f0bd55'}}>Select current player · {players.length} loaded</summary>
          <div style={{display:'flex',gap:8,marginTop:12,flexWrap:'wrap'}}>
            <input aria-label="Search players" value={playerQuery} onChange={e=>setPlayerQuery(e.target.value)} placeholder="Search player name…" style={{flex:'1 1 220px',minWidth:0,padding:'10px 12px',borderRadius:8,border:'1px solid #343b49',background:'#0b0e13',color:'#fff'}} />
            <button className="secondary" onClick={()=>loadPlayers(playerQuery)}>Search</button>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:8,marginTop:12,maxHeight:260,overflowY:'auto'}}>
            {players.map(player=><button key={player.id} type="button" onClick={()=>choosePlayer(player)} style={{textAlign:'left',padding:10,border:'1px solid #2b303b',borderRadius:8,background:Number(auction.currentPlayerId)===Number(player.id)?'#352b17':'#151922',color:'#f5f6f8',cursor:'pointer'}}>
              <strong style={{display:'block'}}>{player.name}</strong>
              <span style={{display:'block',fontSize:12,color:'#aab2c0',marginTop:4}}>{player.role||'Role unavailable'} · Base {player.base_price_paise?money(player.base_price_paise):'—'} · ID {player.id}</span>
            </button>)}
            {!players.length&&<p style={{color:'#aab2c0'}}>No players found. Try another search.</p>}
          </div>
          <p style={{fontSize:12,color:'#aab2c0',marginBottom:0}}>Choose a player here, then click Start in Host Controls to begin bidding.</p>
        </details>}
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
      <section className="activity-grid"><article className="panel chat-panel combined-feed"><div className="panel-title"><div><MessageCircle size={17}/><h3>Live Messages</h3><span className="count">{messages.length+bids.length}</span></div><div className="feed-tools"><button className="secondary sound-toggle" onClick={()=>setSoundEnabled(v=>!v)}>{soundEnabled?'🔊 Sound on':'🔇 Sound off'}</button><button className="secondary" onClick={toggleVoice}>{voiceJoined?'Leave voice':'Join voice'}</button><button className="secondary" disabled={!voiceJoined} onClick={()=>{setMuted(!muted);localStreamRef.current?.getAudioTracks().forEach(t=>{t.enabled=!muted});}}>{muted?<Mic size={14}/>:<MicOff size={14}/>} {muted?'Unmute':'Mute'}</button></div></div><div className="chat-list" ref={chatRef}>{[...messages].sort((a,b)=>new Date(a.created_at||0)-new Date(b.created_at||0)).slice(-100).map((m,i)=><div className={`chat-message ${m.eventType==='bid'?'bid-timeline-message':''}`} key={m.id||i}><span className="chat-avatar" style={m.team_key?{background:TEAM_COLORS[m.team_key]||'#333',color:'#111'}:{}}>{(m.display_name||'P').slice(0,1).toUpperCase()}</span><div className="chat-body"><div className="chat-author"><b>{m.display_name||'Participant'}</b><span>{m.team_key?teamName(m.team_key):'Host'}</span><time>{m.created_at?new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'now'}</time></div><p>{m.eventType==='bid'?'🔨 ':''}{m.message}</p></div></div>)}{!messages.length&&<div className="empty-state">Chat messages and live bids will appear here.</div>}</div><form className="chat-compose" onSubmit={sendChat}><input value={chatText} onChange={e=>setChatText(e.target.value)} placeholder="Message the room…" maxLength="500"/><button className="send-btn" type="submit"><ArrowUpRight size={17}/></button></form><div className="voice-status">{voiceJoined?'🎙 Voice connected':'Voice chat off'} · {remoteStreams.length} connected audio peer(s)</div>{remoteStreams.map(stream=><audio key={stream.id} autoPlay ref={el=>{if(el&&el.srcObject!==stream.stream)el.srcObject=stream.stream;}} />)}</article></section>
      <section className="section-content" aria-live="polite" ref={sectionRef}>
        {view==='squads'&&<div className="panel content-panel"><div className="content-head"><div><div className="eyebrow">TEAM MANAGEMENT</div><h2>Franchise squads</h2></div><span className="subtle">{squads.length} PURCHASED PLAYERS</span></div><div className="team-grid">{TEAM_LIST.map(([key,name])=>{const list=squads.filter(p=>p.team_key===key);const purse=purses.find(p=>p.team_key===key);return <article className="team-card" key={key}><div className="team-mark" style={{color:TEAM_COLORS[key],borderColor:`${TEAM_COLORS[key]}66`,boxShadow:`inset 0 0 18px ${TEAM_COLORS[key]}18`}}>{key.toUpperCase()}</div><h3>{name}</h3><div className="team-card-stats"><span>{list.length} players</span><b>{money(purse?.remainingPursePaise??120000000000)} left</b></div><div className="mini-roster">{list.slice(0,5).map(p=><span key={p.id}>{p.name}</span>)}{!list.length&&<span className="muted">No players purchased yet</span>}{list.length>5&&<span className="muted">+{list.length-5} more</span>}</div></article>})}</div></div>}
        {view==='xi'&&<div className="panel content-panel"><div className="content-head"><div><div className="eyebrow">LINEUP BUILDER</div><h2>Playing XI</h2></div><select value={xiTeam} onChange={e=>setXiTeam(e.target.value)}>{TEAM_LIST.map(([k,n])=><option value={k} key={k}>{n}</option>)}</select></div><p className="muted">Select up to 11 players from the chosen franchise's purchased squad. Changes are saved to the server.</p><div className="xi-progress"><span>{xi.filter(x=>x.team_key===xiTeam).length}/11 selected</span><div><i style={{width:`${xi.filter(x=>x.team_key===xiTeam).length/11*100}%`}}/></div></div><div className="xi-list">{squads.filter(p=>p.team_key===xiTeam).map(p=><label className="xi-player" key={p.id}><input type="checkbox" checked={xi.some(x=>x.team_key===xiTeam&&Number(x.id)===Number(p.id))} onChange={()=>toggleXI(p.id)}/><span><b>{p.name}</b><small>{p.role||'Role N/A'}</small></span><strong>{money(p.purchase_price_paise)}</strong></label>)}{!squads.some(p=>p.team_key===xiTeam)&&<div className="empty-state">This team has no purchased players yet.</div>}</div><button className="primary" onClick={saveXI} disabled={!(myTeam===xiTeam||isHost)}>Save Playing XI</button></div>}
        {view==='sets'&&<div className="panel content-panel"><div className="content-head"><div><div className="eyebrow">RANDOMIZED AUCTION ORDER</div><h2>Auction sets</h2></div><span className="subtle">{auction.auctionSetOrder?.length||new Set(players.map(p=>p.source_data?.set_number||p.source_data?.setNumber||'Unassigned')).size} SETS</span></div><div className="set-tabs"><span>Completed: {(auction.completedPlayerIds||[]).length}</span><span>Current: {currentPlayer?.source_data?.set_number||currentPlayer?.source_data?.setNumber||'—'}</span><span>Unsold: {auction.unsoldCount||0}</span></div><div className="sets-grid">{(auction.auctionSetOrder||[...new Set(players.map(p=>String(p.source_data?.set_number??p.source_data?.setNumber??'Unassigned')))]).map((setKey,index)=>{const setPlayers=players.filter(p=>String(p.source_data?.set_number??p.source_data?.setNumber??'Unassigned')===String(setKey));const completed=new Set((auction.completedPlayerIds||[]).map(Number));const done=setPlayers.length>0&&setPlayers.every(p=>completed.has(Number(p.id)));const current=setPlayers.some(p=>Number(p.id)===Number(auction.currentPlayerId));const unsold=setPlayers.filter(p=>(auction.unsoldPlayerIds||[]).map(Number).includes(Number(p.id)));return <article className="set-card" key={String(setKey)}><div className="set-card-head"><b>Set {setKey}</b><span className={`set-status ${done?'complete':current?'current':'upcoming'}`}>{done?'Completed':current?'In progress':'Upcoming'}</span></div><p>{setPlayers.length} players · {unsold.length} unsold</p><details><summary>View players</summary>{setPlayers.map(player=><div className="set-player-row" key={player.id}><span>{player.name}</span><span>{completed.has(Number(player.id))?(unsold.some(p=>Number(p.id)===Number(player.id))?'Unsold':'Processed'):'Upcoming'}</span></div>)}</details></article>})}</div></div>}
        {view==='more'&&<div className="panel content-panel"><div className="eyebrow">ROOM CONTROL</div><h2>Room & voice settings</h2><div className="more-grid"><div className="setting-card"><h3><Users size={17}/> Participants</h3>{participants.map(p=><p key={p.participant_id}><span className={p.connected?'green-dot':'gray-dot'}/>{p.display_name} · {p.team_key?teamName(p.team_key):'Host'} {p.is_host?'(Host)':''}</p>)}</div><div className="setting-card"><h3><Headphones size={17}/> Voice chat</h3><p>Live room audio uses your browser microphone. Allow microphone access when prompted. Use HTTPS for deployed rooms.</p><button className="secondary" onClick={toggleVoice}>{voiceJoined?'Leave voice chat':'Join voice chat'}</button><button className="secondary" disabled={!voiceJoined} onClick={()=>{setMuted(!muted);localStreamRef.current?.getAudioTracks().forEach(t=>{t.enabled=muted;});}}>{muted?<Mic size={15}/>:<MicOff size={15}/>} {muted?'Unmute microphone':'Mute microphone'}</button><p className="muted">Connected audio peers: {remoteStreams.length}</p>{remoteStreams.map(stream=><audio key={stream.id} autoPlay ref={el=>{if(el&&el.srcObject!==stream.stream)el.srcObject=stream.stream;}} />)}</div><div className="setting-card"><h3><Mic size={17}/> Voice commands</h3><p>Say “Bid”, “Squads”, “Playing XI”, “Purses”, or “Auction”. Commands use the same app actions as manual controls.</p><button className={speechListening?'danger':'secondary'} onClick={toggleSpeech}>{speechListening?'Listening…':'Enable speech commands'}</button>{speechText&&<p className="muted">Recognized: “{speechText}”</p>}</div><div className="setting-card"><h3><ShieldCheck size={17}/> Franchise ownership</h3>{TEAM_LIST.map(([key,name])=>{const owner=participants.find(p=>p.team_key===key);return <p key={key}><span className="team-mark" style={{display:'inline-grid',width:28,height:28,marginRight:8,verticalAlign:'middle',color:TEAM_COLORS[key],borderColor:`${TEAM_COLORS[key]}66`}}>{key.toUpperCase()}</span><b>{name}</b> · {owner?owner.display_name:'Available'}</p>;})}</div><div className="setting-card"><h3><CircleHelp size={17}/> Room info</h3><p>Share this room code with your friends.</p><button className="secondary" onClick={()=>{navigator.clipboard?.writeText(`${location.origin}?room=${roomCode}`);setNotice('Room link copied.')}}><Clipboard size={15}/> Copy invite link</button><p className="muted">Room code: {roomCode}</p></div></div></div>}
      </section>
    </div>
    <nav className="bottom-nav">{nav.map(([id,label,Icon])=><button key={id} className={view===id?'active':''} onClick={()=>setView(id)}><Icon size={18}/><span>{label}</span></button>)}</nav>
    {saleCelebration&&<div className="sale-celebration" style={{'--team-color':TEAM_COLORS[saleCelebration.teamKey]||'#f5c451'}}><div className="celebration-confetti">✦ ✧ ✦ ✧ ✦</div><div className="sale-celebration-card"><div className="sale-trophy">🏆</div><div className="sale-title">SOLD!</div><h2>{saleCelebration.player?.name||'Player'}</h2><strong className="sale-price">{money(saleCelebration.bid)}</strong><div className="sale-winning-team"><span className="team-logo-badge">{(saleCelebration.teamKey||'IPL').toUpperCase()}</span><div><b>{saleCelebration.teamName||teamName(saleCelebration.teamKey)}</b><small>Winning franchise</small></div></div><button className="secondary" onClick={()=>setSaleCelebration(null)}>Continue auction</button></div></div>}
    {notice&&<div className="toast">{notice}<button onClick={()=>setNotice('')}><X size={14}/></button></div>}
  </div>;
}
