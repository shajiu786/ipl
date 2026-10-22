import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import {
  ArrowRight, Check, Clipboard, Crown, Gavel, Layers, ListOrdered,
  MessageCircle, Mic, MicOff, Pause, Play, Radio, Send, Trophy,
  Users, Wallet, X, Volume2, VolumeX
} from "lucide-react";
import "./styles/app.css";

const API = (import.meta.env.VITE_API_URL || "http://localhost:4000").replace(/\/$/, "");
const SOCKET_URL = (import.meta.env.VITE_SOCKET_URL || API).replace(/\/$/, "");
const api = axios.create({ baseURL: API });

const TEAMS = [
  { key: "csk", short: "CSK", name: "Chennai Super Kings", color: "#F5C542" },
  { key: "mi", short: "MI", name: "Mumbai Indians", color: "#3986E8" },
  { key: "rcb", short: "RCB", name: "Royal Challengers Bengaluru", color: "#E64C54" },
  { key: "kkr", short: "KKR", name: "Kolkata Knight Riders", color: "#A58AE8" },
  { key: "rr", short: "RR", name: "Rajasthan Royals", color: "#F17DB7" },
  { key: "srh", short: "SRH", name: "Sunrisers Hyderabad", color: "#F18C35" },
  { key: "dc", short: "DC", name: "Delhi Capitals", color: "#62A9EF" },
  { key: "pbks", short: "PBKS", name: "Punjab Kings", color: "#E95B65" },
  { key: "gt", short: "GT", name: "Gujarat Titans", color: "#A6B2C3" },
  { key: "lsg", short: "LSG", name: "Lucknow Super Giants", color: "#54C5C4" }
];

const NAV = [
  { id: "messages", label: "Live Messages", Icon: MessageCircle },
  { id: "squads", label: "Squads & Purse", Icon: Users },
  { id: "xi", label: "Playing XI", Icon: ListOrdered },
  { id: "sets", label: "Sets", Icon: Layers }
];

const makeId = () => {
  let id = sessionStorage.getItem("iplParticipantId");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("iplParticipantId", id);
  }
  return id;
};

const teamInfo = key => TEAMS.find(t => t.key === key);

function money(paise) {
  return `₹${(Number(paise || 0) / 1000000000).toFixed(2)} Cr`;
}

function getError(error, fallback = "Something went wrong") {
  return error?.response?.data?.error || error?.message || fallback;
}

export default function App() {
  const [page, setPage] = useState("home");
  const [tab, setTab] = useState("messages");

  const [displayName, setDisplayName] = useState("");
  const [roomName, setRoomName] = useState("Friday Night Auction");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [teamKey, setTeamKey] = useState("csk");

  const [participant, setParticipant] = useState(null);
  const [room, setRoom] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [players, setPlayers] = useState([]);
  const [auction, setAuction] = useState({ status: "waiting", currentBidPaise: 0 });
  const [bids, setBids] = useState([]);
  const [messages, setMessages] = useState([]);
  const [chatText, setChatText] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [purses, setPurses] = useState([]);
  const [squads, setSquads] = useState([]);
  const [xi, setXi] = useState([]);
  const [xiTeam, setXiTeam] = useState("csk");
  const [playerSearch, setPlayerSearch] = useState("");
  const [setsFilter, setSetsFilter] = useState("all");
  const [soundOn, setSoundOn] = useState(true);
  const [micOn, setMicOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [sale, setSale] = useState(null);

  const socketRef = useRef(null);
  const audioRef = useRef(null);
  const localStreamRef = useRef(null);
  const peersRef = useRef({});
  const saleTimerRef = useRef(null);
  const voiceSocketRef = useRef(null);

  const participantId = participant?.participantId || participant?.participant_id;
  const isHost = Boolean(participant?.isHost || participant?.is_host);
  const myTeam = participant?.teamKey || participant?.team_key;
  const currentPlayer = auction.currentPlayer || null;
  const leadingTeam = teamInfo(auction.highestBidder?.teamKey);

  const nextBid = useMemo(() => {
    const current = Number(auction.currentBidPaise || 0);
    return current === 0
      ? Number(room?.config?.openingBidPaise || 200000000)
      : current + Number(room?.config?.incrementPaise || 250000000);
  }, [auction.currentBidPaise, room?.config]);

  const myPurse = purses.find(p => p.team_key === myTeam);
  const mySquad = squads.filter(p => p.team_key === myTeam);
  const selectedXI = xi.filter(p => p.team_key === xiTeam);

  const filteredPlayers = players.filter(p =>
    `${p.name || ""} ${p.role || ""}`.toLowerCase().includes(playerSearch.toLowerCase())
  );

  const teamOwners = useMemo(() => {
    const owners = {};
    participants.forEach(p => {
      const key = p.team_key || p.teamKey;
      if (key) owners[key] = p.display_name || p.displayName || "Participant";
    });
    return owners;
  }, [participants]);

  const loadPlayers = useCallback(async () => {
    try {
      const response = await api.get("/api/players", { params: { limit: 500 } });
      setPlayers(response.data.data || []);
    } catch (error) {
      setNotice(`Could not load players: ${getError(error)}`);
    }
  }, []);

  const loadRoomData = useCallback(async code => {
    if (!code) return;
    try {
      const [roomR, bidR, purseR, squadR, xiR, chatR] = await Promise.all([
        api.get(`/api/rooms/${code}`),
        api.get(`/api/rooms/${code}/bids`).catch(() => ({ data: { data: [] } })),
        api.get(`/api/rooms/${code}/purses`).catch(() => ({ data: { data: [] } })),
        api.get(`/api/rooms/${code}/squads`).catch(() => ({ data: { data: [] } })),
        api.get(`/api/rooms/${code}/playing-xi`).catch(() => ({ data: { data: [] } })),
        api.get(`/api/rooms/${code}/chat`).catch(() => ({ data: { data: [] } }))
      ]);

      const nextRoom = roomR.data.room;
      setRoom(nextRoom);
      setParticipants(roomR.data.participants || []);
      setAuction(nextRoom.state || { status: nextRoom.status, currentBidPaise: 0 });
      setBids(bidR.data.data || []);
      setPurses(purseR.data.data || []);
      setSquads(squadR.data.data || []);
      setXi(xiR.data.data || []);
      setMessages(chatR.data.data || []);
    } catch (error) {
      setNotice(`Room data: ${getError(error, "could_not_load_room")}`);
    }
  }, []);

  const playTone = useCallback((frequency = 660) => {
    if (!soundOn) return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      const context = new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.value = 0.05;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.25);
      oscillator.stop(context.currentTime + 0.25);
      oscillator.onended = () => context.close();
    } catch {}
  }, [soundOn]);

  const enterRoom = useCallback(async (code, p) => {
    socketRef.current?.disconnect();
    setParticipant(p);
    setRoomCode(code);
    setPage("lobby");
    setTab("messages");

    const socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("room:join-live", {
        code,
        participantId: p.participantId || p.participant_id
      }, response => {
        if (response?.ok) {
          setNotice("Connected to live auction");
          if (response.room?.state) setAuction(response.room.state);
        } else {
          setNotice(getError({ message: response?.error }, "Room connection failed"));
        }
      });
    });

    const sendVoiceSignal = (targetSocketId, signal) => {
      socket.emit("voice:signal", { targetSocketId, signal });
    };
    const createVoicePeer = async (targetSocketId, shouldOffer = false) => {
      if (!targetSocketId || targetSocketId === socket.id || peersRef.current[targetSocketId]) return;
      const stream = localStreamRef.current;
      if (!stream) return;
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
      });
      peersRef.current[targetSocketId] = pc;
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      pc.onicecandidate = event => {
        if (event.candidate) sendVoiceSignal(targetSocketId, { candidate: event.candidate });
      };
      pc.ontrack = event => {
        let audio = document.getElementById(`voice-audio-${targetSocketId}`);
        if (!audio) {
          audio = document.createElement("audio");
          audio.id = `voice-audio-${targetSocketId}`;
          audio.autoplay = true;
          audio.playsInline = true;
          audio.style.display = "none";
          document.body.appendChild(audio);
        }
        audio.srcObject = event.streams[0];
        audio.play().catch(() => setNotice("Tap the page once to allow incoming voice audio."));
      };
      pc.onconnectionstatechange = () => {
        if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
          pc.close();
          delete peersRef.current[targetSocketId];
        }
      };
      if (shouldOffer) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendVoiceSignal(targetSocketId, { description: pc.localDescription });
      }
    };
    socket.on("voice:peers", async peerList => {
      if (!localStreamRef.current) return;
      for (const peer of peerList || []) {
        try { await createVoicePeer(peer.socketId, socket.id < peer.socketId); } catch {}
      }
    });
    socket.on("voice:peer-joined", async ({ socketId: peerId } = {}) => {
      if (localStreamRef.current) {
        try { await createVoicePeer(peerId, socket.id < peerId); } catch {}
      }
    });
    socket.on("voice:signal", async ({ from, signal } = {}) => {
      if (!from || !signal || !localStreamRef.current) return;
      try {
        let pc = peersRef.current[from];
        if (!pc) {
          await createVoicePeer(from, false);
          pc = peersRef.current[from];
        }
        if (!pc) return;
        if (signal.description) {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.description));
          if (signal.description.type === "offer") {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendVoiceSignal(from, { description: pc.localDescription });
          }
        } else if (signal.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      } catch (error) { console.error("Voice signaling failed", error); }
    });
    socket.on("voice:peer-left", ({ socketId: peerId } = {}) => {
      peersRef.current[peerId]?.close();
      delete peersRef.current[peerId];
      document.getElementById(`voice-audio-${peerId}`)?.remove();
    });

    socket.on("auction:state", state => {
      setAuction(state);
      // When the host starts the auction, every participant leaves the lobby.
      if (state?.status === "active" || state?.status === "paused" || state?.status === "sold" || state?.status === "unsold" || state?.status === "ended") {
        setPage("auction");
      }
    });
    socket.on("bid:accepted", event => {
      setBids(old => [event.bid, ...old].slice(0, 100));
      setNotice(`${event.participantName || "A participant"} placed a bid`);
      playTone(760);
    });
    socket.on("chat:message", message => setMessages(old => [...old, message]));
    socket.on("presence:changed", () => loadRoomData(code));

    socket.on("sale:celebration", event => {
      setSale(event);
      playTone(880);
      clearTimeout(saleTimerRef.current);
      saleTimerRef.current = setTimeout(() => setSale(null), 4500);
    });

    socket.on("connect_error", () => setNotice("Connection issue. Retrying…"));

    await Promise.all([loadRoomData(code), loadPlayers()]);
  }, [loadPlayers, loadRoomData, playTone]);

  useEffect(() => () => {
    socketRef.current?.disconnect();
    clearTimeout(saleTimerRef.current);
    Object.values(peersRef.current).forEach(peer => peer.close());
    peersRef.current = {};
    document.querySelectorAll('audio[id^="voice-audio-"]').forEach(audio => audio.remove());
    localStreamRef.current?.getTracks().forEach(track => track.stop());
  }, []);

  useEffect(() => {
    if (!auction.deadline) {
      setRemaining(0);
      return;
    }
    const tick = () => setRemaining(Math.max(0,
      Math.ceil((new Date(auction.deadline).getTime() - Date.now()) / 1000)
    ));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [auction.deadline, auction.auctionVersion]);

  useEffect(() => {
    if (page !== "home" && roomCode) {
      const timer = setInterval(() => loadRoomData(roomCode), 12000);
      return () => clearInterval(timer);
    }
  }, [page, roomCode, loadRoomData]);

  const createRoom = async event => {
    event?.preventDefault();
    if (!displayName.trim()) return setNotice("Enter your display name first.");
    setBusy(true);
    try {
      const id = makeId();
      const response = await api.post("/api/rooms", {
        name: roomName.trim(),
        displayName: displayName.trim(),
        participantId: id
      });
      const rawParticipant = response.data?.participant || {};
      const p = {
        ...rawParticipant,
        participantId: rawParticipant.participantId || rawParticipant.participant_id || id,
        displayName: rawParticipant.displayName || rawParticipant.display_name || displayName.trim(),
        isHost: rawParticipant.isHost ?? rawParticipant.is_host ?? true,
        teamKey: rawParticipant.teamKey || rawParticipant.team_key || null
      };
      await enterRoom(response.data.room.code, p);
    } catch (error) {
      setNotice(`Create room failed: ${getError(error, "room_create_failed")}`);
    } finally {
      setBusy(false);
    }
  };

  const joinRoom = async event => {
    event?.preventDefault();
    if (!displayName.trim() || !roomCodeInput.trim()) {
      return setNotice("Enter your name and room code.");
    }
    setBusy(true);
    try {
      const id = makeId();
      const response = await api.post(
        `/api/rooms/${roomCodeInput.trim().toUpperCase()}/join`,
        { participantId: id, displayName: displayName.trim(), teamKey }
      );
      const raw = response.data.participant || {};
      await enterRoom(roomCodeInput.trim().toUpperCase(), {
        ...raw,
        participantId: raw.participant_id || raw.participantId || id,
        displayName: raw.display_name || displayName.trim(),
        teamKey: raw.team_key || teamKey
      });
    } catch (error) {
      setNotice(`Join room failed: ${getError(error, "room_join_failed")}`);
    } finally {
      setBusy(false);
    }
  };

  const chooseTeam = async key => {
    if (!participantId) return;
    const owner = teamOwners[key];
    if (owner && owner !== participant?.displayName) {
      setNotice(`${teamInfo(key)?.name} is already taken.`);
      return;
    }
    try {
      const response = await api.post(`/api/rooms/${roomCode}/join`, {
        participantId,
        displayName: participant?.displayName || participant?.display_name || displayName,
        teamKey: key
      });
      const p = response.data.participant || {};
      setParticipant(old => ({
        ...old,
        ...p,
        participantId: p.participant_id || p.participantId || participantId,
        teamKey: p.team_key || p.teamKey || key,
        displayName: p.display_name || old?.displayName || displayName
      }));
      setTeamKey(key);
      await loadRoomData(roomCode);
      setNotice(`Selected ${teamInfo(key)?.name}`);
    } catch (error) {
      setNotice(`Team selection failed: ${getError(error)}`);
    }
  };

  const hostAction = (action, payload = {}) => {
    const socket = socketRef.current;
    if (!socket) return setNotice("Connect to the room first.");

    const sendAction = (nextAction, nextPayload = {}, onSuccess) => {
      socket.emit("auction:host-action", { action: nextAction, payload: nextPayload }, response => {
        if (!response?.ok) {
          setNotice(response?.error || `Host action '${nextAction}' failed`);
          return;
        }
        if (response.state) setAuction(response.state);
        if (onSuccess) onSuccess(response);
        else setNotice(nextAction === "start" ? "Auction started" : "Auction updated");
      });
    };

    // The backend requires a current player before it can start the timer.
    // If none is selected, select the first imported player, then start.
    if (action === "start" && !auction.currentPlayerId) {
      if (!players.length) {
        setNotice("No players are loaded. Check the players API first.");
        return;
      }
      const randomized = [...players].sort(() => Math.random() - 0.5);
      sendAction("set-player", { playerId: randomized[0].id }, () => {
        sendAction("start", {}, () => {
          setPage("auction");
          setNotice("Auction started");
        });
      });
      return;
    }

    sendAction(action, payload, () => {
      if (action === "start" || action === "resume") setPage("auction");
      setNotice(action === "start" ? "Auction started" : "Auction updated");
    });
  };

  const placeBid = () => {
    if (!socketRef.current) return setNotice("Connect to a room before bidding.");
    socketRef.current.emit("bid:place", {
      code: roomCode,
      participantId,
      requestId: crypto.randomUUID()
    }, response => {
      if (!response?.ok) return setNotice(response?.error || "Bid rejected");
      setAuction(response.state);
      setNotice(`Bid accepted: ${money(response.bid.amount_paise)}`);
    });
  };

  const sendChat = event => {
    event?.preventDefault();
    const message = chatText.trim();
    if (!message || !socketRef.current) return;
    socketRef.current.emit("chat:send", { message }, response => {
      if (response?.ok) setChatText("");
      else setNotice(response?.error || "Message failed");
    });
  };

  const leaveRoom = () => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    localStreamRef.current?.getTracks().forEach(track => track.stop());
    setRoom(null);
    setParticipant(null);
    setRoomCode("");
    setPage("home");
  };

  const startVoice = async () => {
    try {
      if (micOn) {
        Object.values(peersRef.current).forEach(peer => peer.close());
        peersRef.current = {};
        document.querySelectorAll('audio[id^="voice-audio-"]').forEach(audio => audio.remove());
        localStreamRef.current?.getTracks().forEach(track => track.stop());
        localStreamRef.current = null;
        setMicOn(false);
        setNotice("Voice chat disconnected.");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setNotice("Voice chat requires HTTPS and a browser with microphone support.");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      localStreamRef.current = stream;
      setMicOn(true);
      socketRef.current?.emit("voice:join");
      setNotice("Voice chat connected. Other participants must also enable their microphones.");
    } catch (error) {
      setNotice(error?.name === "NotAllowedError" ? "Allow microphone permission in your browser settings." : "Microphone unavailable. Use HTTPS and check your audio device.");
    }
  };

  const saveXI = async () => {
    try {
      await api.put(`/api/rooms/${roomCode}/playing-xi`, {
        participantId,
        teamKey: xiTeam,
        playerIds: selectedXI.map(p => Number(p.id))
      });
      setNotice("Playing XI saved");
      await loadRoomData(roomCode);
    } catch (error) {
      setNotice(`Playing XI save failed: ${getError(error)}`);
    }
  };

  const toggleXI = playerId => {
    const already = selectedXI.some(p => Number(p.id) === Number(playerId));
    if (already) {
      setXi(old => old.filter(p => !(p.team_key === xiTeam && Number(p.id) === Number(playerId))));
    } else if (selectedXI.length < 11) {
      const player = mySquad.find(p => Number(p.id) === Number(playerId));
      if (player) setXi(old => [...old, { ...player, team_key: xiTeam, position: selectedXI.length + 1 }]);
    } else {
      setNotice("Playing XI is limited to 11 players.");
    }
  };

  const currentSetStatus = useMemo(() => {
    const state = auction;
    const doneIds = new Set([
      ...(state.soldPlayerIds || []),
      ...(state.unsoldPlayerIds || [])
    ].map(Number));
    const groups = new Map();

    players.forEach(player => {
      const setNumber = Number(player.source_data?.set_number || player.set_number || 0);
      const setName = player.source_data?.set_name || player.set_name || `Set ${setNumber || "Unassigned"}`;
      if (!groups.has(setNumber)) groups.set(setNumber, { number: setNumber, name: setName, players: [] });
      groups.get(setNumber).players.push({
        ...player,
        sold: doneIds.has(Number(player.id))
      });
    });

    return [...groups.values()].map(group => {
      const completed = group.players.length > 0 && group.players.every(p => p.sold);
      const upcoming = group.players.every(p => !p.sold) &&
        group.number !== Number(state.currentSetNumber);
      return {
        ...group,
        status: completed ? "completed" : upcoming ? "upcoming" : "current"
      };
    }).filter(group => setsFilter === "all" || group.status === setsFilter);
  }, [players, auction, setsFilter]);

  if (page === "home") {
    return (
      <main className="home-page">
        <header className="home-brand">
          <span className="brand-mark"><Gavel size={24} /></span>
          <span>AUCTION<span className="gold">ROOM</span></span>
        </header>

        <section className="home-hero">
          <p className="eyebrow"><Radio size={15} /> MULTIPLAYER IPL AUCTION</p>
          <h1>Build your franchise.<br /><span>Win the auction.</span></h1>
          <p className="muted">Create a private room, select your team and bid live with friends.</p>

          <div className="home-grid">
            <form className="home-card" onSubmit={createRoom}>
              <Crown size={24} />
              <h2>Create room</h2>
              <label>Room name</label>
              <input value={roomName} onChange={e => setRoomName(e.target.value)} maxLength={60} />
              <label>Your display name</label>
              <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Enter your name" maxLength={40} />
              <button className="primary-button" disabled={busy}>
                {busy ? "Creating..." : "Create Room"} <ArrowRight size={17} />
              </button>
            </form>

            <form className="home-card" onSubmit={joinRoom}>
              <Users size={24} />
              <h2>Join room</h2>
              <label>Room code</label>
              <input value={roomCodeInput} onChange={e => setRoomCodeInput(e.target.value.toUpperCase())} placeholder="Enter room code" maxLength={8} />
              <label>Your display name</label>
              <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Enter your name" maxLength={40} />
              <label>Preferred franchise</label>
              <select value={teamKey} onChange={e => setTeamKey(e.target.value)}>
                {TEAMS.map(team => <option key={team.key} value={team.key}>{team.name}</option>)}
              </select>
              <button className="secondary-button" disabled={busy}>
                {busy ? "Joining..." : "Join Room"} <ArrowRight size={17} />
              </button>
            </form>
          </div>
        </section>
        {notice && <Notice message={notice} onClose={() => setNotice("")} />}
      </main>
    );
  }

  if (page === "lobby") {
    return (
      <main className="lobby-page">
        <header className="lobby-header">
          <div>
            <p className="eyebrow">FRANCHISE DRAFT</p>
            <h1>Teams & owners</h1>
            <p className="muted">Room code: <b>{roomCode}</b> · Share this code with friends.</p>
          </div>
          <button className="icon-button" onClick={leaveRoom} aria-label="Leave room"><X /></button>
        </header>

        <div className="lobby-grid">
          {TEAMS.map(team => {
            const owner = teamOwners[team.key];
            const isMine = myTeam === team.key;
            return (
              <button
                key={team.key}
                className={`team-card ${owner ? "claimed" : ""} ${isMine ? "selected" : ""}`}
                style={{ "--team-color": team.color }}
                onClick={() => chooseTeam(team.key)}
                disabled={Boolean(owner && !isMine)}
              >
                <span className="team-logo">{team.short}</span>
                <span className="team-copy">
                  <b>{team.name}</b>
                  <small>{owner ? `Owned by ${owner}` : "Available — click to select"}</small>
                </span>
                {isMine && <Check className="team-check" />}
              </button>
            );
          })}
        </div>

        <footer className="lobby-footer">
          <span className="muted">{Object.keys(teamOwners).length}/10 franchises claimed</span>
          {isHost ? (
            <button className="primary-button" onClick={() => hostAction("start")}>
              <Play size={17} /> Start Auction
            </button>
          ) : (
            <span className="muted">Waiting for the host to start…</span>
          )}
        </footer>

        {notice && <Notice message={notice} onClose={() => setNotice("")} />}
      </main>
    );
  }

  return (
    <main className="auction-app">
      <header className="auction-topbar">
        <div className="home-brand">
          <span className="brand-mark"><Gavel size={19} /></span>
          <span>AUCTION<span className="gold">ROOM</span></span>
        </div>
        <div className="room-info">
          <span className={`status-pill ${auction.status === "active" ? "active" : ""}`}>
            <i /> {String(auction.status || "waiting").toUpperCase()}
          </span>
          <b>{room?.name || "IPL Auction"}</b>
          <button className="code-button" onClick={() => {
            navigator.clipboard?.writeText(roomCode);
            setNotice("Room code copied");
          }}><Clipboard size={14} /> {roomCode}</button>
        </div>
        <button className="icon-button" onClick={leaveRoom} aria-label="Leave room"><X /></button>
      </header>

      <section className="live-auction-panel">
        <div className="live-panel-title">
          <div>
            <p className="eyebrow">LOT {auction.currentPlayerId || "—"} · IPL PLAYER AUCTION</p>
            <h1>Live Auction <span className="live-badge">LIVE</span></h1>
          </div>
          <div className="auction-counts">
            <span><b>{auction.soldCount || 0}</b><small>SOLD</small></span>
            <span><b>{auction.unsoldCount || 0}</b><small>UNSOLD</small></span>
            <span><b>{players.length}</b><small>PLAYERS</small></span>
          </div>
        </div>

        <div className="live-player-bidding">
          <article className="current-player-card">
            <div className="player-placeholder"><Gavel size={34} /><small>CURRENT PLAYER</small></div>
            <div className="player-description">
              <span className="role-chip">{currentPlayer?.role || "Waiting for player"}</span>
              <h2>{currentPlayer?.name || "Waiting for the host"}</h2>
              <p>{currentPlayer?.nationality || "Player details will appear here"}</p>
              <div className="base-price"><small>BASE PRICE</small><b>{currentPlayer?.base_price_paise ? money(currentPlayer.base_price_paise) : "—"}</b></div>
            </div>
          </article>

          <article className="bidding-card">
            <div className="bid-clock">
              <span>TIME LEFT</span>
              <strong className={remaining <= 5 ? "urgent" : ""}>
                {String(Math.floor(remaining / 60)).padStart(2, "0")}:{String(remaining % 60).padStart(2, "0")}
              </strong>
            </div>
            <div className="bid-values">
              <div><small>CURRENT BID</small><b>{money(auction.currentBidPaise)}</b></div>
              <div><small>LEADING BIDDER</small><b>{auction.highestBidder?.teamName || "No bids yet"}</b></div>
            </div>
            <p className="next-bid-label">Next valid bid <b>{money(nextBid)}</b></p>
            <button
              className="bid-now-button"
              disabled={auction.status !== "active" || !currentPlayer || remaining <= 0 || myTeam === auction.highestBidder?.teamKey}
              onClick={placeBid}
            >
              <Gavel size={19} /> BID NOW · {money(nextBid)}
            </button>
            <div className="purse-summary"><Wallet size={15} /> Your purse <b>{money(myPurse?.remainingPursePaise ?? 120000000000)}</b></div>
            {isHost && (
              <div className="host-actions">
                {auction.status === "active" ? (
                  <button onClick={() => hostAction("pause")}><Pause size={14} /> Pause</button>
                ) : (
                  <button onClick={() => hostAction(auction.status === "paused" ? "resume" : "start")}>
                    <Play size={14} /> {auction.status === "paused" ? "Resume" : "Start"}
                  </button>
                )}
                <button disabled={!auction.highestBidder || !currentPlayer} onClick={() => hostAction("sell")}><Check size={14} /> Sold</button>
                <button disabled={!currentPlayer || ["sold", "unsold", "ended"].includes(auction.status)} onClick={() => hostAction("unsold")}>Unsold</button>
                {["sold", "unsold"].includes(auction.status) && <button onClick={() => hostAction("next-player")}><ArrowRight size={14} /> Next player</button>}
              </div>
            )}
          </article>
        </div>
      </section>

      <nav className="bottom-nav">
        {NAV.map(({ id, label, Icon }) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            <Icon size={18} /><span>{label}</span>
          </button>
        ))}
      </nav>

      <section className="lower-content">
        {tab === "messages" && (
          <div className="content-panel messages-panel">
            <header className="panel-header">
              <div><MessageCircle size={18} /><h2>Live Messages</h2></div>
              <div className="sound-controls">
                <button className="icon-button" title={soundOn ? "Mute sounds" : "Enable sounds"} onClick={() => setSoundOn(!soundOn)}>
                  {soundOn ? <Volume2 size={17} /> : <VolumeX size={17} />}
                </button>
                <button className="icon-button" title={micOn ? "Disable microphone" : "Enable microphone"} onClick={startVoice}>
                  {micOn ? <Mic size={17} /> : <MicOff size={17} />}
                </button>
              </div>
            </header>

            <div className="message-feed">
              {bids.map((bid, index) => (
                <div className="feed-item bid-message" key={`bid-${bid.id || index}`}>
                  <span className="feed-icon"><Gavel size={14} /></span>
                  <div><b>{bid.display_name || bid.participant_id || "Bidder"}</b>
                    <p>bid {money(bid.amount_paise)} · {bid.player_name || currentPlayer?.name || "Player"}</p>
                  </div>
                  <small>{teamInfo(bid.team_key)?.short || bid.team_key || ""}</small>
                </div>
              ))}
              {messages.map((message, index) => (
                <div className="feed-item" key={`msg-${message.id || index}`}>
                  <span className="feed-icon"><MessageCircle size={14} /></span>
                  <div><b>{message.display_name || "Participant"}</b><p>{message.message}</p></div>
                  <small>{message.created_at ? new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</small>
                </div>
              ))}
              {!bids.length && !messages.length && <p className="empty-state">Chat and bid activity will appear here.</p>}
            </div>

            <form className="chat-form" onSubmit={sendChat}>
              <input value={chatText} onChange={e => setChatText(e.target.value)} placeholder="Message the room…" maxLength={500} />
              <button className="primary-button" type="submit"><Send size={16} /></button>
            </form>
          </div>
        )}

        {tab === "squads" && (
          <div className="content-panel">
            <header className="panel-header"><div><Users size={18} /><h2>Squads & Purse</h2></div></header>
            <div className="squad-grid">
              {TEAMS.map(team => {
                const list = squads.filter(p => p.team_key === team.key);
                const purse = purses.find(p => p.team_key === team.key);
                return (
                  <article className="squad-card" key={team.key} style={{ "--team-color": team.color }}>
                    <div className="squad-team-heading"><span className="team-logo">{team.short}</span><div><b>{team.name}</b><small>{teamOwners[team.key] || "No owner yet"}</small></div></div>
                    <div className="purse-stats"><span>Players <b>{list.length}</b></span><span>Spent <b>{money(purse?.spent_paise || 0)}</b></span></div>
                    <div className="remaining-purse">Remaining balance <b>{money(purse?.remainingPursePaise ?? 120000000000)}</b></div>
                    {list.length ? list.map(p => <div className="squad-player" key={p.id}><span>{p.name}</span><b>{money(p.purchase_price_paise)}</b></div>) : <p className="muted">No players purchased yet.</p>}
                  </article>
                );
              })}
            </div>
          </div>
        )}

        {tab === "xi" && (
          <div className="content-panel">
            <header className="panel-header"><div><ListOrdered size={18} /><h2>Playing XI Creator</h2></div></header>
            <div className="xi-controls">
              <label>Franchise
                <select value={xiTeam} onChange={e => setXiTeam(e.target.value)}>
                  {TEAMS.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}
                </select>
              </label>
              <span>{selectedXI.length}/11 selected</span>
            </div>
            <div className="xi-list">
              {myTeam === xiTeam || isHost ? squads.filter(p => p.team_key === xiTeam).map(player => (
                <label className="xi-player" key={player.id}>
                  <input type="checkbox" checked={selectedXI.some(p => Number(p.id) === Number(player.id))} onChange={() => toggleXI(player.id)} />
                  <span><b>{player.name}</b><small>{player.role || "Role unavailable"}</small></span>
                  <strong>{money(player.purchase_price_paise)}</strong>
                </label>
              )) : <p className="empty-state">You can edit your own team's Playing XI. The host can manage all teams.</p>}
              {!squads.some(p => p.team_key === xiTeam) && <p className="empty-state">Buy players for this franchise before creating its XI.</p>}
            </div>
            <button className="primary-button" disabled={!(myTeam === xiTeam || isHost)} onClick={saveXI}>Save Playing XI</button>
          </div>
        )}

        {tab === "sets" && (
          <div className="content-panel">
            <header className="panel-header"><div><Layers size={18} /><h2>Auction Sets</h2></div></header>
            <div className="sets-filters">
              {[
                ["all", "All Sets"], ["current", "Current"], ["upcoming", "Upcoming"], ["completed", "Completed"]
              ].map(([key, label]) => (
                <button key={key} className={setsFilter === key ? "active" : ""} onClick={() => setSetsFilter(key)}>{label}</button>
              ))}
            </div>
            <div className="sets-list">
              {currentSetStatus.map(group => (
                <article className="set-card" key={`${group.number}-${group.name}`}>
                  <div><b>{group.name}</b><small>{group.players.length} players</small></div>
                  <span className={`set-status ${group.status}`}>{group.status}</span>
                  <details><summary>View players</summary>
                    {group.players.map(p => <p key={p.id}>{p.name} · {p.role || "Role unavailable"}</p>)}
                  </details>
                </article>
              ))}
              {!currentSetStatus.length && <p className="empty-state">No sets match this filter. Check that your player API includes set metadata.</p>}
            </div>
            <h3>Unsold players</h3>
            {auction.unsoldPlayers?.length
              ? auction.unsoldPlayers.map(p => <span className="unsold-chip" key={p.id}>{p.name}</span>)
              : <p className="muted">Unsold player list depends on backend state.</p>}
          </div>
        )}
      </section>

      {sale && (
        <div className="sale-overlay">
          <div className="sale-card" style={{ "--team-color": teamInfo(sale.teamKey)?.color || "#D9A441" }}>
            <Trophy size={40} />
            <h2>SOLD!</h2>
            <h3>{sale.playerName || "Player"}</h3>
            <strong>{money(sale.amountPaise)}</strong>
            <p>{teamInfo(sale.teamKey)?.name || sale.teamName || "Winning franchise"}</p>
          </div>
        </div>
      )}

      {notice && <Notice message={notice} onClose={() => setNotice("")} />}
    </main>
  );
}

function Notice({ message, onClose }) {
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      <button onClick={onClose} aria-label="Dismiss"><X size={15} /></button>
    </div>
  );
}
