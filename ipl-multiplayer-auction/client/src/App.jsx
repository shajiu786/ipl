import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import {
  ArrowRight, Check, Clipboard, Crown, Gavel, Layers, ListOrdered,
  MessageCircle, Mic, MicOff, Pause, Play, Radio, Send, Trophy,
  Users, Wallet, X, Volume2, VolumeX, Settings, ChevronDown, ChevronRight, ChevronUp, Timer, Flag, ArrowLeft, Ban
} from "lucide-react";
import "./styles/app.css";
import "./styles/theme.css";
import "./styles/auction.css";
import "./styles/modes.css";

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


// WebRTC relay servers. STUN alone fails for many players (mobile data, strict Wi-Fi/NAT),
// so a TURN relay is included. Override with VITE_ICE_SERVERS='[{"urls":"turn:...","username":"..","credential":".."}]'
const DEFAULT_ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turns:openrelay.metered.ca:443?transport=tcp"], username: "openrelayproject", credential: "openrelayproject" }
];
const ICE_SERVERS = (() => {
  try {
    const custom = JSON.parse(import.meta.env.VITE_ICE_SERVERS || "null");
    return Array.isArray(custom) && custom.length ? custom : DEFAULT_ICE_SERVERS;
  } catch { return DEFAULT_ICE_SERVERS; }
})();

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

// second colour per franchise, used by the SOLD pop-up and confetti
const TEAM_ACCENT = { csk: "#1f4ea1", mi: "#d4a24a", rcb: "#f2c94c", kkr: "#f0c24a", rr: "#2a4fa8", srh: "#111111", dc: "#d93a3a", pbks: "#c9ccd2", gt: "#c8a76a", lsg: "#e8a53a" };

const MAX_SQUAD = 25;
const PURSE_PAISE = 120000000000;
const ERRORS = {
  squad_full: "Squad full: you already own 25 players.",
  insufficient_purse: "Not enough purse left for this bid.",
  already_highest_bidder: "You already hold the highest bid.",
  timer_expired: "Time is up for this player.",
  price_changed: "The price just changed. Check the new bid.",
  auction_not_active: "Bidding is not open right now.",
  team_not_selected: "Pick a franchise in the lobby to bid.",
  not_a_room_member: "You are not part of this room.",
  bid_failed: "Bid failed. Please try again.",
  no_valid_bid: "There is no bid to sell yet.",
  player_already_settled: "That player is already settled.",
  player_in_progress: "Finish the current player first.",
  host_only: "Only the host can do that.",
  no_players_remaining: "No players are left to auction."
};
const friendly = code => ERRORS[code] || code || "Something went wrong";

// Game modes: each one auctions its own player dataset (see server/src/services/modes.js)
const MODES = {
  legends: { key: "legends", name: "IPL Legends Auction", short: "Legends", tagline: "Iconic IPL stars from every era, auctioned in themed sets.", badge: "Classic" },
  mega2026: { key: "mega2026", name: "IPL Mega Auction 2026", short: "Mega 2026", tagline: "The real IPL 2026 auction pool: capped and uncapped players at official base prices.", badge: "New" }
};
const modeOf = r => MODES[r?.config?.mode] || MODES.legends;

const CITY = { csk: "Chennai", mi: "Mumbai", rcb: "Bengaluru", kkr: "Kolkata", rr: "Rajasthan", srh: "Hyderabad", dc: "Delhi", pbks: "Punjab", gt: "Gujarat", lsg: "Lucknow" };
const FLAGS = { india: "🇮🇳", australia: "🇦🇺", england: "🇬🇧", "south africa": "🇿🇦", "new zealand": "🇳🇿", "west indies": "🏝️", afghanistan: "🇦🇫", "sri lanka": "🇱🇰", bangladesh: "🇧🇩" };
const isIndian = n => !n || /india|indian|local/i.test(n);
const flagFor = n => FLAGS[String(n || "").trim().toLowerCase()] || (isIndian(n) ? "🇮🇳" : "✈️");
const firstOf = (o, keys) => {
  for (const k of keys) {
    const v = o?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
};
// Role-aware headline stats. Uses the fetched IPL career stats (players.stats); falls back to CSV columns if present.
function playerStats(p) {
  const st = p?.stats || {}, bat = st.bat || {}, bowl = st.bowl || {}, d = p?.source_data || {};
  const role = String(p?.role || "").toUpperCase();
  const num = (v, dp = 0) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v).toFixed(dp));
  const matches = num(st.matches) ?? firstOf(d, ["matches", "Matches", "mat", "ipl_matches"]);
  const runs = num(bat.runs) ?? firstOf(d, ["runs", "Runs", "ipl_runs"]);
  const avg = num(bat.avg, 1);
  const sr = num(bat.sr, 1) ?? firstOf(d, ["strike_rate", "strikeRate", "sr", "SR"]);
  const wkts = num(bowl.wkts) ?? firstOf(d, ["wickets", "Wickets", "wkts", "ipl_wickets"]);
  const eco = num(bowl.econ, 2) ?? firstOf(d, ["economy", "Economy", "eco"]);
  const bowlAvg = num(bowl.avg, 1);
  if (role.includes("BOWL")) return [["Matches", matches], ["Wickets", wkts], ["Eco", eco], ["Avg", bowlAvg]];
  if (role.startsWith("AR") || role.includes("ALL")) return [["Matches", matches], ["Runs", runs], ["SR", sr], ["Wkts", wkts]];
  return [["Matches", matches], ["Runs", runs], ["Avg", avg], ["SR", sr]];
}
const clock = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "";
const clockShort = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

function TeamChip({ teamKey, label }) {
  const t = teamInfo(teamKey);
  return <span className={`ar-chip ${["csk", "gt", "dc"].includes(teamKey) ? "ink" : ""}`} style={{ "--team-color": t?.color || "#2a6bff" }}>{t?.short || label || "•"}</span>;
}

function TimerPicker({ value, onChange }) {
  return (
    <div className="ar-timer-pick" role="group" aria-label="Bid timer in seconds">
      {[5, 6, 7, 8, 9, 10].map(n => (
        <button key={n} type="button" className={value === n ? "active" : ""} aria-pressed={value === n} onClick={() => onChange(n)}>{n}s</button>
      ))}
    </div>
  );
}

function PlayerPhoto({ player }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [player?.photo_url]);
  if (player?.photo_url && !failed) return <img src={player.photo_url} alt={player.name} onError={() => setFailed(true)} />;
  return <div className="ar-photo-fallback">{player ? player.name.split(" ").map(w => w[0]).slice(0, 2).join("") : <Gavel size={34} />}</div>;
}

export default function App() {
  const [page, setPage] = useState("home");
  const [tab, setTab] = useState("messages");
  const [messageMode, setMessageMode] = useState("bids");
  const [bidConfirmOpen, setBidConfirmOpen] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [teamKey, setTeamKey] = useState(null);

  const [participant, setParticipant] = useState(null);
  const [room, setRoom] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [players, setPlayers] = useState([]);
  const [mode, setMode] = useState("legends");
  const [modeCounts, setModeCounts] = useState({});
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
  const [playerSearch, setPlayerSearch] = useState("");
  const [setsFilter, setSetsFilter] = useState("all");
  const [soundOn, setSoundOn] = useState(() => {
    try { return localStorage.getItem("ar-sound") !== "off"; } catch { return true; }
  });
  const soundOnRef = useRef(soundOn);
  const [salePop, setSalePop] = useState(null);
  const clearSale = useCallback(() => setSalePop(null), []);
  const clearNotice = useCallback(() => setNotice(""), []);
  const [micOn, setMicOn] = useState(false);
  const [voiceJoined, setVoiceJoined] = useState(false);
  const [muted, setMuted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voicePeers, setVoicePeers] = useState(0);
  const [voiceDebug, setVoiceDebug] = useState([]);

  const socketRef = useRef(null);
  const barRef = useRef(null);
  const dbgRef = useRef({});
  const audioRef = useRef(null);
  const localStreamRef = useRef(null);
  const peersRef = useRef({});
  const pendingIceRef = useRef({});
  const voiceSocketRef = useRef(null);

  const participantId = participant?.participantId || participant?.participant_id;
  const isHost = Boolean(participant?.isHost || participant?.is_host);
  const myTeam = participant?.teamKey || participant?.team_key;
  const currentPlayer = auction.currentPlayer || null;
  const leadingTeam = teamInfo(auction.highestBidder?.teamKey);
  const duration = Math.min(10, Math.max(5, Number(auction.durationSeconds || room?.config?.durationSeconds || 10)));

  // The server decides the next valid bid (opening bid = the player's base price) and sends it with every state.
  const nextBid = useMemo(() => {
    if (auction.nextBidPaise) return Number(auction.nextBidPaise);
    const current = Number(auction.currentBidPaise || 0);
    return current === 0
      ? Number(currentPlayer?.base_price_paise || room?.config?.openingBidPaise || 200000000)
      : current + Number(room?.config?.incrementPaise || 250000000);
  }, [auction.nextBidPaise, auction.currentBidPaise, currentPlayer?.base_price_paise, room?.config]);

  const myPurse = purses.find(p => p.team_key === myTeam);
  const mySquad = squads.filter(p => p.team_key === myTeam);
  const xiTeam = myTeam || "";
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

  const loadPlayers = useCallback(async code => {
    try {
      // the server picks the pool that belongs to this room's mode
      const response = await api.get("/api/players", { params: { limit: 500, room: code } });
      setPlayers(response.data.data || []);
    } catch (error) {
      setNotice(`Could not load players: ${getError(error)}`);
    }
  }, []);

  useEffect(() => {
    api.get("/api/modes").then(r => setModeCounts(Object.fromEntries((r.data?.data || []).map(m => [m.key, m.players])))).catch(() => {});
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

  // The socket handlers are created once on room entry, so they read the live setting through a ref.
  useEffect(() => {
    soundOnRef.current = soundOn;
    try { localStorage.setItem("ar-sound", soundOn ? "on" : "off"); } catch {}
  }, [soundOn]);

  const playTone = useCallback((frequency = 660) => {
    if (!soundOnRef.current) return;
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
  }, []);

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
          if (response.room?.state) setAuction(response.room.state);
          if (response.room?.config) setRoom(old => ({ ...(old || {}), config: response.room.config }));
          // After a reconnect the server forgets who was in voice: rejoin with fresh peer links.
          if (localStreamRef.current) {
            Object.values(peersRef.current).forEach(peer => peer.close());
            peersRef.current = {};
            pendingIceRef.current = {};
            socket.emit("voice:join");
          }
        } else {
          setNotice(getError({ message: response?.error }, "Room connection failed"));
        }
      });
    });

    const sendVoiceSignal = (targetSocketId, signal) => {
      socket.emit("voice:signal", { targetSocketId, signal });
    };
    const refreshDebug = () => setVoiceDebug(Object.entries(dbgRef.current).map(([id, d]) => ({ id: id.slice(0, 4), ...d, types: [...d.types] })));
    const createVoicePeer = async (targetSocketId, shouldOffer = false) => {
      if (!targetSocketId || targetSocketId === socket.id || peersRef.current[targetSocketId]) return;
      const stream = localStreamRef.current;
      if (!stream) return;
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peersRef.current[targetSocketId] = pc;
      dbgRef.current[targetSocketId] = { conn: "new", ice: "new", types: new Set(), err: "" };
      refreshDebug();
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      pc.onicecandidate = event => {
        if (event.candidate) {
          const kind = /typ (\w+)/.exec(event.candidate.candidate || "");
          if (kind && dbgRef.current[targetSocketId]) { dbgRef.current[targetSocketId].types.add(kind[1]); refreshDebug(); }
          sendVoiceSignal(targetSocketId, { candidate: event.candidate });
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (dbgRef.current[targetSocketId]) { dbgRef.current[targetSocketId].ice = pc.iceConnectionState; refreshDebug(); }
      };
      pc.onicecandidateerror = event => {
        if (dbgRef.current[targetSocketId]) { dbgRef.current[targetSocketId].err = `${event.errorCode || ""} ${event.url || ""}`.trim(); refreshDebug(); }
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
        audio.play().catch(() => {
          setNotice("Tap anywhere once to hear voice chat.");
          const retry = () => document.querySelectorAll('audio[id^="voice-audio-"]').forEach(a => a.play().catch(() => {}));
          window.addEventListener("pointerdown", retry, { once: true });
        });
      };
      const dropPeer = () => {
        pc.close();
        if (peersRef.current[targetSocketId] === pc) delete peersRef.current[targetSocketId];
        document.getElementById(`voice-audio-${targetSocketId}`)?.remove();
        setVoicePeers(Object.values(peersRef.current).filter(p => p.connectionState === "connected").length);
      };
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (dbgRef.current[targetSocketId]) { dbgRef.current[targetSocketId].conn = state; refreshDebug(); }
        setVoicePeers(Object.values(peersRef.current).filter(p => p.connectionState === "connected").length);
        if (state === "failed" || state === "closed") dropPeer();
        // "disconnected" is often a brief network blip: give it a few seconds to recover.
        else if (state === "disconnected") setTimeout(() => { if (pc.connectionState === "disconnected") dropPeer(); }, 6000);
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
          const queued = pendingIceRef.current[from] || [];
          for (const candidate of queued) await pc.addIceCandidate(new RTCIceCandidate(candidate));
          delete pendingIceRef.current[from];
          if (signal.description.type === "offer") {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendVoiceSignal(from, { description: pc.localDescription });
          }
        } else if (signal.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          else pendingIceRef.current[from] = [...(pendingIceRef.current[from] || []), signal.candidate];
        }
      } catch (error) { console.error("Voice signaling failed", error); }
    });
    socket.on("voice:peer-left", ({ socketId: peerId } = {}) => {
      peersRef.current[peerId]?.close();
      delete peersRef.current[peerId];
      delete pendingIceRef.current[peerId];
      delete dbgRef.current[peerId];
      refreshDebug();
      document.getElementById(`voice-audio-${peerId}`)?.remove();
    });

    socket.on("auction:state", state => {
      setAuction(state);
      // When the host starts the auction, every participant leaves the lobby.
      if (state?.status === "active" || state?.status === "paused" || state?.status === "sold" || state?.status === "unsold" || state?.status === "ended") {
        setPage("auction");
      }
    });
    socket.on("auction:set-complete", event => {
      setNotice(`${event?.completedSetName || `Set ${event?.completedSetNumber}`} completed. ${event?.nextSetName || `Set ${event?.nextSetNumber}`} is starting!`);
      playTone(980);
    });
    socket.on("bid:accepted", event => {
      setBids(old => [event.bid, ...old].slice(0, 100));
      playTone(760);
    });
    socket.on("chat:message", message => setMessages(old => [...old, message]));
    socket.on("presence:changed", () => loadRoomData(code));
    socket.on("lobby:participants", list => { if (Array.isArray(list)) setParticipants(list); });

    socket.on("sale:celebration", event => {
      const isUnsold = event?.status === "unsold";
      const team = event?.teamName || teamInfo(event?.teamKey)?.name;
      const detail = isUnsold
        ? `${event?.playerName || "Player"} marked UNSOLD`
        : `${event?.playerName || "Player"} SOLD to ${team || "winning franchise"} for ${money(event?.amountPaise || 0)}`;
      setMessages(old => [{
        id: `auction-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        display_name: "AUCTION UPDATE",
        message: detail,
        auctionEvent: isUnsold ? "unsold" : "sold",
        team_key: event?.teamKey || event?.team_key || null,
        created_at: new Date().toISOString()
      }, ...old].slice(0, 100));
      setSalePop({
        id: Date.now(),
        kind: isUnsold ? "unsold" : "sold",
        player: event?.playerName || "Player",
        teamKey: event?.teamKey || event?.team_key || null,
        teamName: team || "",
        amountPaise: event?.amountPaise || 0
      });
      playTone(isUnsold ? 420 : 880);
      if (!isUnsold) setTimeout(() => playTone(1175), 140);
    });

    socket.on("sale:skipped", event => {
      setMessages(old => [{
        id: `auction-skip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        display_name: "AUCTION UPDATE",
        message: `${event?.playerName || "Player"} skipped by host${event?.nextPlayerName ? ` · Next: ${event.nextPlayerName}` : " · Auction complete"}`,
        auctionEvent: "skipped",
        created_at: new Date().toISOString()
      }, ...old].slice(0, 100));
    });

    socket.on("connect_error", () => setNotice("Connection issue. Retrying…"));

    await Promise.all([loadRoomData(code), loadPlayers(code)]);
  }, [loadPlayers, loadRoomData, playTone]);

  useEffect(() => () => {
    socketRef.current?.disconnect();
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

  // Time bar: shrinks smoothly; green -> yellow (half way) -> red. Painted via ref to avoid re-rendering every frame.
  useEffect(() => {
    const root = barRef.current;
    if (!root) return undefined;
    let raf = 0;
    const paint = fraction => {
      const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
      const hue = f >= 0.5 ? 60 + (f - 0.5) * 150 : f * 120;
      root.querySelectorAll("[data-tp]").forEach(el => {
        el.style.setProperty("--p", String(f));
        el.style.setProperty("--h", String(Math.round(hue)));
      });
    };
    if (auction.status === "active" && auction.deadline) {
      const deadline = new Date(auction.deadline).getTime();
      const loop = () => {
        paint((deadline - Date.now()) / (duration * 1000));
        raf = requestAnimationFrame(loop);
      };
      loop();
    } else if (auction.status === "paused") {
      paint(Number(auction.pausedRemainingMs || 0) / (duration * 1000));
    } else {
      paint(0);
    }
    return () => cancelAnimationFrame(raf);
  }, [page, auction.status, auction.deadline, auction.auctionVersion, auction.pausedRemainingMs, duration]);

  // When the host ends the auction, everyone lands on the full squads view.
  useEffect(() => {
    if (auction.status === "ended") setTab("squads");
  }, [auction.status]);

  const setTimerSeconds = seconds => {
    const socket = socketRef.current;
    if (!socket) return setNotice("Connect to the room first.");
    socket.emit("auction:host-action", { action: "set-duration", payload: { durationSeconds: seconds } }, response => {
      if (!response?.ok) return setNotice(response?.error === "invalid_duration" ? "Timer must be 5 to 10 seconds." : response?.error || "Could not change the timer.");
      setRoom(old => (old ? { ...old, config: { ...(old.config || {}), durationSeconds: seconds } } : old));
      setAuction(old => ({ ...old, durationSeconds: seconds }));
      setNotice(`Bid timer set to ${seconds} seconds`);
    });
  };

  const createRoom = async event => {
    event?.preventDefault();
    if (!displayName.trim()) return setNotice("Enter your display name first.");
    setBusy(true);
    try {
      const id = makeId();
      const response = await api.post("/api/rooms", {
        name: `${displayName.trim()}'s ${MODES[mode].name}`,
        displayName: displayName.trim(),
        participantId: id,
        mode
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
        { participantId: id, displayName: displayName.trim() }
      );
      const raw = response.data.participant || {};
      await enterRoom(roomCodeInput.trim().toUpperCase(), {
        ...raw,
        participantId: raw.participant_id || raw.participantId || id,
        displayName: raw.display_name || displayName.trim(),
        teamKey: raw.team_key || raw.teamKey || null
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
    const myName = participant?.displayName || participant?.display_name || displayName;
    if (owner && owner !== myName) {
      setNotice(`${teamInfo(key)?.name} is already taken.`);
      return;
    }
    const socket = socketRef.current;
    if (!socket?.connected) return setNotice("Reconnecting to room. Please try again.");
    socket.emit("team:select", { code: roomCode, participantId, teamKey: key }, async response => {
      if (!response?.ok) {
        setNotice(response?.error === "team_taken" ? `${teamInfo(key)?.name} is already taken.` : `Team selection failed: ${response?.error || "Please try again"}`);
        return;
      }
      const p = response.participant || {};
      setParticipant(old => ({ ...old, ...p, participantId, teamKey: key, team_key: key, displayName: p.display_name || p.displayName || old?.displayName || displayName }));
      setTeamKey(key);
      if (response.participants) setParticipants(response.participants);
      await loadRoomData(roomCode);
      setNotice(`Selected ${teamInfo(key)?.name}`);
    });
  };

  const hostAction = (action, payload = {}) => {
    const socket = socketRef.current;
    if (!socket) return setNotice("Connect to the room first.");

    const sendAction = (nextAction, nextPayload = {}, onSuccess) => {
      socket.emit("auction:host-action", { action: nextAction, payload: nextPayload }, response => {
        if (!response?.ok) {
          setNotice(friendly(response?.error) || `Host action '${nextAction}' failed`);
          return;
        }
        if (response.state) setAuction(response.state);
        if (onSuccess) onSuccess(response);
        else if (!["sell", "unsold", "next-player", "pause", "resume"].includes(nextAction)) setNotice(nextAction === "start" ? "Auction started" : "Auction updated");
      });
    };

    // The server owns the (de-duplicated, randomized) player order, so starting is a single action.
    sendAction(action, payload, () => {
      if (action === "start" || action === "resume") setPage("auction");
      if (!["sell", "unsold", "next-player", "pause", "resume"].includes(action)) setNotice(action === "start" ? "Auction started" : "Auction updated");
    });
  };

  const placeBid = () => {
    if (!socketRef.current) return setNotice("Connect to a room before bidding.");
    if (bidBlock) return setNotice(bidBlock.message);
    socketRef.current.emit("bid:place", {
      code: roomCode,
      participantId,
      requestId: crypto.randomUUID(),
      expectedBidPaise: nextBid
    }, response => {
      if (response?.state) setAuction(response.state);
      if (!response?.ok) return setNotice(friendly(response?.error));
      setNotice(`Bid placed: ${money(response.bid.amount_paise)}`);
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
    setVoiceJoined(false);
    setMicOn(false);
    setMuted(false);
    setRoom(null);
    setParticipant(null);
    setRoomCode("");
    setPage("home");
  };

  const startVoice = async () => {
    if (voiceJoined) {
      Object.values(peersRef.current).forEach(peer => peer.close());
      peersRef.current = {};
      pendingIceRef.current = {};
      document.querySelectorAll('audio[id^="voice-audio-"]').forEach(audio => audio.remove());
      localStreamRef.current?.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
      socketRef.current?.emit("voice:leave");
      dbgRef.current = {};
      setVoiceDebug([]);
      setVoiceJoined(false);
      setVoicePeers(0);
      setMicOn(false);
      setMuted(false);
      setNotice("You left voice chat.");
      return;
    }
    try {
      if (!window.isSecureContext) {
        setNotice("Voice needs a secure connection. Open the https:// link, not an http:// address.");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setNotice("This browser can't access the microphone.");
        return;
      }
      if (!socketRef.current?.connected) {
        setNotice("Connect to the room before joining voice chat.");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      localStreamRef.current = stream;
      stream.getAudioTracks().forEach(track => { track.enabled = true; });
      setMicOn(true);
      setMuted(false);
      setVoiceJoined(true);
      socketRef.current.emit("voice:join");
      setNotice("Voice joined. Others hear you once they join voice too.");
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
      ...(state.completedPlayerIds || []),
      ...(state.soldPlayerIds || []),
      ...(state.unsoldPlayerIds || [])
    ].map(Number));
    const groups = new Map();

    players.forEach(player => {
      const setNumber = player.source_data?.set_number ?? player.source_data?.setNumber ?? player.set_number ?? "Unassigned";
      const setName = player.source_data?.set_name || player.source_data?.setName || player.set_name || `Set ${setNumber}`;
      if (!groups.has(setNumber)) groups.set(setNumber, { number: setNumber, name: setName, players: [] });
      groups.get(setNumber).players.push({
        ...player,
        sold: (state.soldPlayerIds || []).map(Number).includes(Number(player.id)),
        unsold: (state.unsoldPlayerIds || []).map(Number).includes(Number(player.id))
      });
    });

    const cur = String(state.currentSetNumber ?? "");
    const order = (state.setOrder || []).map(String);
    const rank = g => { const k = order.indexOf(String(g.number)); return k >= 0 ? k : 1000 + (Number(g.number) || 0); };
    return [...groups.values()].sort((a, b) => rank(a) - rank(b)).map(group => {
      const finished = group.players.filter(p => doneIds.has(Number(p.id))).length;
      const completed = group.players.length > 0 && finished === group.players.length;
      const live = !completed && (String(group.number) === cur || finished > 0);
      return {
        ...group,
        status: completed ? "completed" : live ? "current" : "upcoming",
        soldCount: group.players.filter(p => p.sold && !p.unsold).length,
        unsoldCount: group.players.filter(p => p.unsold).length,
        remainingCount: group.players.length - finished
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

          <div className="home-entry">
            <label htmlFor="display-name">Your name</label>
            <input id="display-name" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Enter your name" maxLength={40} required />
            <span className="mode-label">Choose a game mode</span>
            <div className="mode-picker" role="radiogroup" aria-label="Game mode">
              {Object.values(MODES).map(m => (
                <button key={m.key} type="button" role="radio" aria-checked={mode === m.key} className={`mode-card ${mode === m.key ? "on" : ""}`} onClick={() => setMode(m.key)}>
                  <span className="mode-top"><b>{m.name}</b><em className={m.key === "mega2026" ? "new" : ""}>{m.badge}</em></span>
                  <small>{m.tagline}</small>
                  <span className="mode-meta">{modeCounts[m.key] ? `${modeCounts[m.key]} players` : "Player pool"} · 120 Cr purse · 25-man squads</span>
                </button>
              ))}
              {mode === "mega2026" && <p className="mode-note">Heads up: the real 2026 IPL auction was a mini auction. This mode uses its player pool, but every franchise starts from scratch like a mega auction.</p>}
            </div>
            <div className="home-grid home-grid-simple">
              <form className="home-card home-card-simple" onSubmit={createRoom}>
                <button className="primary-button" disabled={busy} type="submit">
                  <Crown size={17} /> {busy ? "Creating..." : `Create ${MODES[mode].short} Room`}
                </button>
              </form>
              <form className="home-card home-card-simple" onSubmit={joinRoom}>
                <label htmlFor="room-code">Join room code</label>
                <input id="room-code" value={roomCodeInput} onChange={e => setRoomCodeInput(e.target.value.toUpperCase())} placeholder="Enter room code" maxLength={8} required />
                <button className="secondary-button" disabled={busy} type="submit">
                  <Users size={17} /> {busy ? "Joining..." : "Join Room"} <ArrowRight size={17} />
                </button>
              </form>
            </div>
          </div>
        </section>
        {notice && <Notice message={notice} onClose={clearNotice} />}
      </main>
    );
  }

  if (page === "lobby") {
    return (
      <main className="lobby-page">
        <header className="lobby-header">
          <div>
            <p className="eyebrow">{modeOf(room).name.toUpperCase()}</p>
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
          {isHost && (
            <div className="lobby-timer"><span>Bid timer</span><TimerPicker value={duration} onChange={setTimerSeconds} /></div>
          )}
          {isHost ? (
            <button className="primary-button" onClick={() => hostAction("start")}>
              <Play size={17} /> Start Auction
            </button>
          ) : (
            <span className="muted">Waiting for the host to start…</span>
          )}
        </footer>

        {notice && <Notice message={notice} onClose={clearNotice} />}
      </main>
    );
  }

  const chatMessages = messages
    .filter(m => !m.auctionEvent)
    .slice()
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  const feed = [
    ...bids.map((b, i) => ({ kind: "bid", id: `b-${b.id ?? i}`, at: b.created_at, bid: b })),
    ...messages.filter(m => m.auctionEvent).map(m => ({ kind: "event", id: `e-${m.id}`, at: m.created_at, msg: m }))
  ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  const visibleFeed = feed.slice(0, 30);
  const myName = participant?.displayName || participant?.display_name || displayName || "Participant";
  const stats = playerStats(currentPlayer);
  const completedCount = (auction.completedPlayerIds || []).length;
  const settledNow = ["sold", "unsold"].includes(auction.status);
  const lotNo = settledNow ? completedCount : completedCount + 1;
  const setInfo = auction.setProgress || null;
  const iLead = Boolean(myTeam) && myTeam === auction.highestBidder?.teamKey;
  const pursePaise = myPurse?.remainingPursePaise ?? PURSE_PAISE;
  const squadCount = Math.max(mySquad.length, Number(myPurse?.players_bought || 0));
  // Why the BID button is locked for this franchise (the server enforces the same rules).
  const bidBlock = !myTeam ? { key: "spectator", label: "Spectating", message: "Pick a franchise in the lobby to bid." }
    : squadCount >= MAX_SQUAD ? { key: "full", label: "Squad full · 25/25", message: ERRORS.squad_full }
    : pursePaise < nextBid ? { key: "purse", label: "Insufficient purse", message: ERRORS.insufficient_purse }
    : null;
  const bidDisabled = auction.status !== "active" || !currentPlayer || remaining <= 0 || iLead || Boolean(bidBlock);
  const bidLabel = bidBlock ? bidBlock.label : iLead ? `You lead · ${money(auction.currentBidPaise)}` : `BID • ${money(nextBid)}`;
  const goLower = id => setTab(id);
  const ended = auction.status === "ended";
  const TABS = ended
    ? [
        { id: "squads", label: "Squads & Purse", Icon: Users },
        { id: "xi", label: "Playing XI", Icon: ListOrdered },
        { id: "sets", label: "Sets", Icon: Layers },
        { id: "messages", label: "Chat", Icon: MessageCircle, count: chatMessages.length }
      ]
    : [
        { id: "messages", label: "Live Chat", Icon: MessageCircle, count: chatMessages.length },
        { id: "squads", label: "My Squad & Purse", Icon: Users },
        { id: "sets", label: "Sets", Icon: Layers }
      ];
  const endAuction = () => {
    if (window.confirm("End the auction now? Remaining players stay unsold and everyone will see the final squads.")) hostAction("end");
  };

  const squadCards = [...TEAMS].sort((a, b) => (a.key === myTeam ? -1 : b.key === myTeam ? 1 : 0)).map(team => {
    const list = squads.filter(p => p.team_key === team.key);
    const purse = purses.find(p => p.team_key === team.key);
    return (
      <article className={`ar-squad ${team.key === myTeam ? "mine" : ""}`} key={team.key} style={{ "--team-color": team.color }}>
        <div className="ar-squad-head">
          <TeamChip teamKey={team.key} />
          <div><b>{team.name}</b><small>{team.key === myTeam ? "Your team" : teamOwners[team.key] || "No owner yet"}</small></div>
          <strong>{money(purse?.remainingPursePaise ?? 120000000000)}</strong>
        </div>
        <div className="ar-squad-meta"><span>Players <b>{list.length}/25</b></span><span>Spent <b>{money(purse?.spent_paise || 0)}</b></span></div>
        {list.map(p => <div className="ar-squad-player" key={p.id}><span>{p.name}</span><b>{money(p.purchase_price_paise)}</b></div>)}
        {!list.length && <p className="ar-empty">No players purchased yet.</p>}
      </article>
    );
  });

  return (
    <main ref={barRef} className={`ar-app ${auction.status === "ended" ? "is-ended" : ""} ${tab === "sets" && auction.status !== "ended" ? "is-big" : ""}`}>
      <div className="ar-timebar" aria-hidden="true"><i data-tp /></div>
      <div className="ar-bar">
      <header className="ar-top">
        <span className="ar-logo"><Gavel size={26} /></span>
        <span className="ar-brand">AUCTION<em>ROOM</em></span>
        <span className={`ar-status ${auction.status === "active" ? "on" : ""}`} title={String(auction.status || "waiting")}><i /><span className="ar-status-text">{String(auction.status || "waiting").toUpperCase()}</span></span>
        <span className="ar-spacer" />
        {isHost && (
          <button className="ar-btn" onClick={() => hostAction(auction.status === "paused" ? "resume" : "pause")} disabled={!["active", "paused"].includes(auction.status)}>
            {auction.status === "paused" ? <Play size={17} /> : <Pause size={17} />}<span>{auction.status === "paused" ? "Resume" : "Pause"}</span>
          </button>
        )}
        <button className={`ar-btn square ${settingsOpen ? "open" : ""}`} onClick={() => setSettingsOpen(v => !v)} aria-label="Settings" aria-expanded={settingsOpen}><Settings size={20} /></button>
        <button className="ar-btn code" onClick={() => { navigator.clipboard?.writeText(roomCode)?.catch(() => {}); setNotice("Room code copied"); }} title="Copy room code">{roomCode}</button>
        <button className="ar-btn square danger" onClick={leaveRoom} aria-label="Exit room"><X size={22} /></button>
      </header>

      {settingsOpen && (
        <div className="ar-settings" role="menu">
          <button onClick={() => setSoundOn(v => !v)}>{soundOn ? <Volume2 size={17} /> : <VolumeX size={17} />} Auction sounds <b>{soundOn ? "On" : "Off"}</b></button>
          <button onClick={startVoice}><Radio size={17} /> Voice chat <b>{voiceJoined ? `Leave · ${voicePeers} linked` : "Join"}</b></button>
          {voiceJoined && (
            <div className="ar-voice-debug">
              <b>Voice status</b>
              {!voiceDebug.length && <span>No other player is in voice yet. Everyone must tap Join.</span>}
              {voiceDebug.map(d => (
                <span key={d.id} className={d.conn === "connected" ? "ok" : d.conn === "failed" || d.ice === "failed" ? "bad" : ""}>
                  Player {d.id}: {d.conn} · route {d.types.join("/") || "searching"}{d.err ? ` · error ${d.err}` : ""}
                </span>
              ))}
              {voiceDebug.some(d => d.conn === "failed" || d.ice === "failed" || (d.conn !== "connected" && d.ice === "checking" && !d.types.includes("relay") && d.err)) && (
                <em>The relay (TURN) isn't reachable. Add your own TURN credentials in VITE_ICE_SERVERS.</em>
              )}
            </div>
          )}
          <button disabled={!voiceJoined} onClick={() => {
            const nextMuted = !muted;
            localStreamRef.current?.getAudioTracks().forEach(track => { track.enabled = !nextMuted; });
            setMuted(nextMuted);
          }}>{muted || !micOn ? <MicOff size={17} /> : <Mic size={17} />} Microphone <b>{muted || !micOn ? "Muted" : "On"}</b></button>
          {isHost && (
            <div className="ar-settings-timer"><span>Bid timer (seconds)</span><TimerPicker value={duration} onChange={setTimerSeconds} /></div>
          )}
        </div>
      )}

      <section className="ar-card ar-identity">
        <span className="ar-avatar">{myName.trim().charAt(0).toUpperCase()}</span>
        <div className="ar-identity-copy"><small>YOU ARE PLAYING AS</small><strong>{myName}</strong></div>
        <span className={`ar-teamtag ${myTeam ? "" : "none"}`} style={{ "--team-color": teamInfo(myTeam)?.color }} title="Teams are picked in the lobby">
          {myTeam ? <><TeamChip teamKey={myTeam} /><b>{teamInfo(myTeam)?.name}</b></> : <b>Spectating</b>}
        </span>
      </section>

      </div>

      <section className="ar-card ar-lot">
        <div className="ar-lot-head">
          <div className="ar-lot-title">
            <span>LOT {currentPlayer ? lotNo : "—"}<em className="ar-lot-sub"> • {modeOf(room).name.toUpperCase()}</em></span>
            <span className="ar-live"><Play size={10} fill="currentColor" /> LIVE</span>
            {setInfo && <span className="ar-setchip" title={setInfo.name}>SET {setInfo.position}/{setInfo.totalSets}<em> · {setInfo.remaining} left</em></span>}
          </div>
          <div className="ar-counts">
            <span><b className="sold">{auction.soldCount || 0}</b><small>SOLD</small></span>
            <span><b className="unsold">{auction.unsoldCount || 0}</b><small>UNSOLD</small></span>
            <span><b>{Math.max(0, players.length - (auction.completedPlayerIds || []).length)}</b><small>LEFT</small></span>
          </div>
        </div>

        <div className="ar-player">
          <figure className="ar-photo">
            <PlayerPhoto player={currentPlayer} />
            <figcaption>CURRENT PLAYER</figcaption>
          </figure>
          <div className="ar-player-info">
            <span className="ar-role">{currentPlayer?.role || "Waiting"}</span>
            <h2>{currentPlayer?.name || "Waiting for the host"}</h2>
            <p className="ar-nation">{currentPlayer ? <><span className="ar-flag">{flagFor(currentPlayer.nationality)}</span>{currentPlayer.nationality || "India"}</> : "Player details will appear here"}</p>
            <div className="ar-statrow">
              <div className="ar-base"><small>BASE PRICE</small><b>{currentPlayer?.base_price_paise ? money(currentPlayer.base_price_paise) : "—"}</b></div>
              {stats.map(([label, value]) => <div className="ar-stat" key={label}><small>{label.toUpperCase()}</small><b>{value ?? "—"}</b></div>)}
            </div>
          </div>
        </div>

        <div className="ar-bidbox">
          <div className="ar-now">
            <div><small>CURRENT BID</small><b>{money(auction.currentBidPaise)}</b></div>
            <div><small>LEADING BIDDER</small><b className={auction.highestBidder ? "" : "dim"}>{auction.highestBidder?.teamName || "No bids yet"}</b></div>
            <div className={`ar-timer ${remaining <= 5 && auction.status === "active" ? "urgent" : ""}`}>
              <small>TIME LEFT</small>
              <b data-tp><Timer size={26} />{String(Math.floor(remaining / 60)).padStart(2, "0")}:{String(remaining % 60).padStart(2, "0")}</b>
            </div>
          </div>
          <div className="ar-next"><span>Next valid bid</span><b>{money(nextBid)}</b></div>
          {bidBlock && bidBlock.key !== "spectator" && <p className="ar-bid-note" role="alert">{bidBlock.message}</p>}
          <button className={`ar-bid ${bidBlock ? "blocked" : ""}`} disabled={bidDisabled} onClick={placeBid}>
            {bidBlock ? <Ban size={22} /> : <Gavel size={24} />}{bidLabel}
          </button>
        </div>

        {isHost && !ended && (
          <div className="ar-host">
            <button disabled={!auction.highestBidder || !currentPlayer || ["sold", "unsold", "ended"].includes(auction.status)} onClick={() => hostAction("sell")}><Check size={15} /> Sold</button>
            <button disabled={!currentPlayer || ["sold", "unsold", "ended"].includes(auction.status)} onClick={() => hostAction("unsold")}>Unsold</button>
            {["sold", "unsold"].includes(auction.status) && <button className="next" onClick={() => hostAction("next-player")}><ArrowRight size={15} /> Next</button>}
            <button className="end" onClick={endAuction}><Flag size={15} /><span className="ar-end-long">End auction</span><span className="ar-end-short">End</span></button>
          </div>
        )}

        <div className="ar-links">
          <button onClick={() => goLower("squads")}><Wallet size={22} /><span>Purse: <b className={bidBlock?.key === "purse" ? "warn" : ""}>{money(pursePaise)}</b></span><ChevronRight size={18} /></button>
          <button onClick={() => goLower("squads")}><Users size={22} /><span>Squad: <b className={squadCount >= MAX_SQUAD ? "warn" : ""}>{squadCount}/{MAX_SQUAD}</b> · {Math.max(0, MAX_SQUAD - squadCount)} slots</span><ChevronRight size={18} /></button>
        </div>
      </section>

      <section className="ar-card ar-feed" aria-label="Live bids">
        <header>
          <span className="ar-feed-title"><i />LIVE BIDS</span>
          <span className="ar-feed-tools">
            <small>Recent activity</small>
            <button className={`ar-sound ${soundOn ? "" : "off"}`} onClick={() => setSoundOn(v => !v)} aria-label={soundOn ? "Turn auction sounds off" : "Turn auction sounds on"} title={soundOn ? "Sounds on" : "Sounds off"}>
              {soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </button>
          </span>
        </header>
        <ul>
          {visibleFeed.map(item => item.kind === "bid" ? (
            <li key={item.id} className={item.bid.team_key && item.bid.team_key === myTeam ? "mine" : ""}>
              <TeamChip teamKey={item.bid.team_key} />
              <span className="ar-feed-text"><span>{item.bid.team_key && item.bid.team_key === myTeam ? "You" : CITY[item.bid.team_key] || item.bid.display_name || "Bidder"} bid <b>{money(item.bid.amount_paise)}</b> for {item.bid.player_name || currentPlayer?.name || "player"}</span></span>
              <time>{clock(item.at)}</time>
            </li>
          ) : (
            <li key={item.id} className={`event ${item.msg.auctionEvent}`}>
              <span className="ar-chip event"><Gavel size={13} /></span>
              <span className="ar-feed-text"><span>{item.msg.message}</span></span>
              <time>{clock(item.at)}</time>
            </li>
          ))}
          {!visibleFeed.length && <li className="empty">Waiting for the first bid…</li>}
        </ul>
      </section>

      <section className="ar-card ar-lower" id="ar-lower">
        {tab === "sets" && !ended && (
          <div className="ar-strip">
            <button className="ar-strip-back" onClick={() => setTab("messages")}><ArrowLeft size={16} /> Auction</button>
            <span className="ar-strip-name">{currentPlayer?.name || "Waiting…"}</span>
            <b className="ar-strip-bid-amt">{money(auction.currentBidPaise)}</b>
            <b data-tp className="ar-strip-time">{String(Math.floor(remaining / 60)).padStart(2, "0")}:{String(remaining % 60).padStart(2, "0")}</b>
            <button className="ar-strip-bid" disabled={bidDisabled} onClick={placeBid}>{bidBlock ? bidBlock.label : `BID ${money(nextBid)}`}</button>
          </div>
        )}
        {ended && (
          <div className="ar-endbanner">
            <Trophy size={20} /><b>Auction complete</b>
            <span>{auction.soldCount || 0} sold · {auction.unsoldCount || 0} unsold</span>
          </div>
        )}
        <div className="ar-tabs" role="tablist">
          {TABS.map(({ id, label, Icon, count }) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              <Icon size={20} /><span>{label}</span>{count ? <em>{count}</em> : null}
            </button>
          ))}
        </div>

        {tab === "messages" && (
          <div className="ar-panel">
            <ul className="ar-chat">
              {chatMessages.slice(0, 60).map((m, i) => (
                <li key={`msg-${m.id ?? i}`}>
                  {m.team_key ? <TeamChip teamKey={m.team_key} /> : <span className="ar-chip plain">{(m.display_name || "P").charAt(0).toUpperCase()}</span>}
                  <b>{m.display_name || "Participant"}</b>
                  <span className="ar-chat-text">{m.message}</span>
                  <time>{clockShort(m.created_at)}</time>
                </li>
              ))}
              {!chatMessages.length && <li className="empty">No messages yet. Start the conversation.</li>}
            </ul>
            <form className="ar-compose" onSubmit={sendChat}>
              <button type="button" className={`ar-voice ${voiceJoined ? "on" : ""}`} onClick={startVoice} aria-label={voiceJoined ? "Leave voice chat" : "Join voice chat"} title={voiceJoined ? `Voice on · ${voicePeers} connected. Tap to leave` : "Join voice chat"}>
                {voiceJoined ? <Mic size={22} /> : <Radio size={22} />}
                {voiceJoined && <i className="ar-voice-count">{voicePeers}</i>}
              </button>
              <input value={chatText} onChange={e => setChatText(e.target.value)} placeholder="Send a message…" maxLength={500} />
              <button className="ar-send" type="submit" aria-label="Send message"><Send size={24} /></button>
            </form>
          </div>
        )}

        {tab === "squads" && <div className="ar-panel ar-squads">{squadCards}</div>}

        {tab === "xi" && auction.status === "ended" && (
          <div className="ar-panel">
            {myTeam ? (
              <>
                <div className="ar-xi-controls">
                  <span className="ar-xi-team"><TeamChip teamKey={myTeam} /><b>{teamInfo(myTeam)?.name} · Playing XI</b></span>
                  <span>{selectedXI.length}/11 selected</span>
                </div>
                <div className="ar-xi-list">
                  {squads.filter(p => p.team_key === myTeam).map(player => (
                    <label className="ar-xi-player" key={player.id}>
                      <input type="checkbox" checked={selectedXI.some(p => Number(p.id) === Number(player.id))} onChange={() => toggleXI(player.id)} />
                      <span><b>{player.name}</b><small>{player.role || "Role unavailable"}{!isIndian(player.nationality) ? " · ✈️ Overseas" : ""}</small></span>
                      <strong>{money(player.purchase_price_paise)}</strong>
                    </label>
                  ))}
                  {!squads.some(p => p.team_key === myTeam) && <p className="ar-empty">You haven't bought any players yet.</p>}
                </div>
                <button className="ar-save" onClick={saveXI}>Save Playing XI</button>
              </>
            ) : (
              <p className="ar-empty">You didn't pick a team in the lobby, so there is no Playing XI to set.</p>
            )}
          </div>
        )}

        {tab === "sets" && (
          <div className="ar-panel">
            <div className="ar-setnow">
              <div><small>NOW AUCTIONING</small><strong>{setInfo?.name || auction.currentSetName || currentPlayer?.source_data?.set_name || (auction.currentSetNumber ? `Set ${auction.currentSetNumber}` : "Waiting for first set")}</strong></div>
              <span>{auction.status === "ended" ? "Auction complete" : setInfo ? `Set ${setInfo.position} of ${setInfo.totalSets} · ${setInfo.remaining} of ${setInfo.total} left` : `${auction.soldCount || 0} sold · ${auction.unsoldCount || 0} unsold`}</span>
            </div>
            <div className="ar-filters">
              {[["all", "All"], ["current", "Current"], ["upcoming", "Upcoming"], ["completed", "Completed"]].map(([key, label]) => (
                <button key={key} className={setsFilter === key ? "active" : ""} onClick={() => setSetsFilter(key)}>{label}</button>
              ))}
            </div>
            <div className="ar-sets">
              {currentSetStatus.map(group => (
                <article className="ar-set" key={`${group.number}-${group.name}`}>
                  <div className="ar-set-head"><div><b>{group.name}</b><small>{group.players.length} players · {group.soldCount} sold · {group.unsoldCount} unsold · {group.remainingCount} left</small></div><span className={`ar-set-status ${group.status}`}>{group.status === "completed" ? "Completed" : group.status === "current" ? "Current" : "Upcoming"}</span></div>
                  <details open={auction.status === "ended" || group.status === "completed"}>
                    <summary>View players · {group.players.length}</summary>
                    <div className="ar-set-players">{group.players.map(p => <p key={p.id} className={p.unsold ? "unsold" : p.sold ? "sold" : ""}><span>{p.name}{!isIndian(p.nationality) ? " ✈️" : ""} · {p.role || "—"}</span><small>{p.unsold ? "UNSOLD" : p.sold ? "SOLD" : "UPCOMING"}</small></p>)}</div>
                  </details>
                </article>
              ))}
              {!currentSetStatus.length && <p className="ar-empty">No sets match this filter.</p>}
            </div>
          </div>
        )}
      </section>

      {salePop && <SaleCelebration key={salePop.id} pop={salePop} onDone={clearSale} />}

      {notice && <Notice message={notice} onClose={clearNotice} />}
    </main>
  );
}

function Notice({ message, onClose }) {
  // Keep the latest onClose in a ref: an inline arrow from the parent changes every render
  // (the bid timer re-renders 4x a second), which used to restart this timer forever.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const timer = setTimeout(() => closeRef.current(), 2600);
    return () => clearTimeout(timer);
  }, [message]);
  const kind = /fail|reject|cannot|can't|not enough|insufficient|full|expired|already|only the host|not part|unavailable|issue|could not|taken|no bid|wrong/i.test(message) ? "bad"
    : /accepted|placed|selected|copied|started|saved|connected|set to|complete/i.test(message) ? "good" : "info";
  return (
    <div className={`toast ${kind}`} role="status" aria-live="polite">
      <i className="toast-dot" />
      <span>{message}</span>
      <button onClick={onClose} aria-label="Dismiss"><X size={14} /></button>
    </div>
  );
}

// ---------- SOLD / UNSOLD celebration: team colours, confetti and party poppers, ~2 seconds ----------
const CONFETTI = Array.from({ length: 44 }, (_, i) => ({
  left: (i * 37 + 11) % 100, delay: (i % 9) * 0.045, dur: 1.15 + (i % 5) * 0.12,
  w: 6 + (i % 4) * 2, h: 9 + (i % 3) * 4, rot: (i * 67) % 360, drift: ((i % 7) - 3) * 26, c: i % 3
}));
const POPPER = Array.from({ length: 16 }, (_, i) => {
  const a = (-18 - (i / 15) * 54) * (Math.PI / 180);        // fan from the bottom corner up and inward
  const d = 120 + (i % 4) * 38;
  return { dx: Math.cos(a) * d, dy: Math.sin(a) * d, delay: (i % 4) * 0.03, c: i % 3, s: 6 + (i % 3) * 2 };
});

function SaleCelebration({ pop, onDone }) {
  const sold = pop.kind === "sold";
  const team = teamInfo(pop.teamKey);
  const primary = sold ? (team?.color || "#4bb38c") : "#8793ad";
  const accent = sold ? (TEAM_ACCENT[pop.teamKey] || "#f2c94c") : "#5b6579";
  const life = sold ? 2100 : 1500;
  useEffect(() => {
    const timer = setTimeout(onDone, life);
    return () => clearTimeout(timer);
  }, [pop.id, life, onDone]);
  const colors = [primary, accent, "#ffffff"];
  return (
    <div className={`ar-cele ${sold ? "sold" : "unsold"}`} style={{ "--tc": primary, "--ta": accent, "--life": `${life}ms` }} role="status" aria-live="polite">
      <div className="ar-cele-glow" />
      {sold && (
        <div className="ar-cele-fx" aria-hidden="true">
          {CONFETTI.map((p, i) => (
            <i key={i} className="ar-confetti" style={{ left: `${p.left}%`, width: p.w, height: p.h, background: colors[p.c], animationDelay: `${p.delay}s`, animationDuration: `${p.dur}s`, "--r": `${p.rot}deg`, "--x": `${p.drift}px` }} />
          ))}
          {[0, 1].map(side => POPPER.map((p, i) => (
            <i key={`${side}-${i}`} className={`ar-popper ${side ? "right" : "left"}`} style={{ width: p.s, height: p.s, background: colors[p.c], animationDelay: `${p.delay}s`, "--dx": `${side ? -p.dx : p.dx}px`, "--dy": `${p.dy}px` }} />
          )))}
        </div>
      )}
      <div className="ar-cele-card">
        {sold && <TeamChip teamKey={pop.teamKey} />}
        <b className="ar-cele-word">{sold ? "SOLD!" : "UNSOLD"}</b>
        <span className="ar-cele-player">{pop.player}</span>
        {sold ? (
          <span className="ar-cele-detail"><em>{pop.teamName || "Winning franchise"}</em><strong>{money(pop.amountPaise)}</strong></span>
        ) : (
          <span className="ar-cele-detail"><em>No bids. Moving on…</em></span>
        )}
      </div>
    </div>
  );
}   
