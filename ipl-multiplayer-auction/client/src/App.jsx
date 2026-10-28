import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import {
  ArrowRight, Check, Clipboard, Crown, Gavel, Layers, ListOrdered, Star,
  MessageCircle, Mic, MicOff, Pause, Play, Radio, Send, Trophy,
  Users, Wallet, X, Volume2, VolumeX, Settings, ChevronDown, ChevronRight, ChevronUp, Timer, Flag, Ban,
  Copy, Home, Zap
} from "lucide-react";

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
  overseas_limit: "Overseas limit reached: a team can buy a maximum of 8 overseas players.",
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

const THEMES = [
  { id: "stadium", name: "Stadium Broadcast", description: "Navy · floodlight · lime", swatches: ["#080b12", "#c7f36b", "#56c8ff"] },
  { id: "broadcast", name: "Broadcast Pro", description: "Midnight · electric blue", swatches: ["#07111f", "#43a5ff", "#f2f7ff"] },
  { id: "royal", name: "Royal Gold", description: "Black · gold · champagne", swatches: ["#100d0a", "#e8bd69", "#f7e7c5"] },
  { id: "black", name: "Midnight Black", description: "Graphite · monochrome", swatches: ["#080808", "#f3f4f6", "#858b98"] },
  { id: "ipl", name: "IPL Energy", description: "Deep blue · vibrant orange", swatches: ["#081326", "#ff8a36", "#5c8cff"] },
  { id: "arctic", name: "Arctic Light", description: "Clean white · silver · blue", swatches: ["#f3f6fb", "#2563eb", "#d6deea"] },
  { id: "emerald", name: "Emerald Elite", description: "Forest · emerald · ivory", swatches: ["#071710", "#34d399", "#f0fdf4"] },
  { id: "crimson", name: "Crimson Arena", description: "Charcoal · crimson · silver", swatches: ["#130b10", "#ff4d6d", "#d9dce5"] },
  { id: "purple", name: "Purple Nebula", description: "Black · violet · neon", swatches: ["#100a1c", "#a78bfa", "#ec4899"] },
  { id: "carbon", name: "Carbon Fiber", description: "Graphite · steel", swatches: ["#111316", "#aab3c2", "#e5e7eb"] },
  { id: "retro", name: "Retro Cricket", description: "Cream · forest · burgundy", swatches: ["#f4eddf", "#1f5a43", "#7c2638"] },
  { id: "cyber", name: "Neon Cyber", description: "Black · cyan · magenta", swatches: ["#070b13", "#22d3ee", "#f472b6"] },
  { id: "blue", name: "Royal Blue", description: "Navy · royal blue · champagne", swatches: ["#07142b", "#4d83ff", "#f0d49b"] },
  { id: "night", name: "Stadium Night", description: "Pitch green · floodlight white", swatches: ["#07130f", "#7ce0a3", "#f4fff8"] }
];

function ThemePicker({ value, onChange, compact = false }) {
  const [open, setOpen] = useState(false);
  const active = THEMES.find(t => t.id === value) || THEMES[0];
  return <div className={`cx-theme-picker ${compact ? "compact" : ""}`}>
    <button className="cx-theme-trigger" type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label="Choose appearance">
      <span className="cx-theme-swatches">{active.swatches.map(c => <i key={c} style={{ background: c }} />)}</span>
      {!compact && <span className="cx-theme-current"><b>{active.name}</b><small>Appearance</small></span>}
      <ChevronDown size={14} />
    </button>
    {open && <div className="cx-theme-popover" role="listbox" aria-label="Available themes">
      <div className="cx-theme-pop-head"><b>Choose your theme</b><small>Saved on this device</small></div>
      <div className="cx-theme-grid">
        {THEMES.map(theme => <button type="button" role="option" aria-selected={value === theme.id} className={`cx-theme-option ${value === theme.id ? "selected" : ""}`} key={theme.id} onClick={() => { onChange(theme.id); setOpen(false); }}>
          <span className="cx-theme-preview" style={{ background: theme.swatches[0] }}>{theme.swatches.slice(1).map((c, i) => <i key={c} style={{ background: c, left: `${12 + i * 17}px` }} />)}</span>
          <span className="cx-theme-option-copy"><b>{theme.name}</b><small>{theme.description}</small></span>
          {value === theme.id && <Check size={15} />}
        </button>)}
      </div>
    </div>}
  </div>;
}

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

const crShort = paise => `₹${(Number(paise || 0) / 1000000000).toFixed(1)} Cr`;
const csvCell = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
function downloadCsv(filename, rows) {
  if (!rows?.length) return false;
  const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.style.display = "none";
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  return true;
}
const ROLE_LABELS = { BAT: "Batter", BOWL: "Bowler", AR: "All-rounder", WK: "Wicketkeeper" };
const roleLabel = r => ROLE_LABELS[String(r || "").toUpperCase()] || r || "Player";
const STAT_LABELS = { Eco: "Economy", Avg: "Average", SR: "Strike rate", Wkts: "Wickets" };
const statLabel = l => STAT_LABELS[l] || l;

// Squad shape score out of 100 (depth + role balance + overseas count). It is not a player-quality rating.
function squadRating(list) {
  if (!list.length) return null;
  const count = r => list.filter(p => String(p.role || "").toUpperCase() === r).length;
  const overseas = list.filter(p => !isIndian(p.nationality)).length;
  const depth = (Math.min(list.length, 18) / 18) * 40;
  const balance = [count("WK") >= 1, count("BAT") >= 3, count("AR") >= 2, count("BOWL") >= 4].filter(Boolean).length * 10;
  const overseasScore = overseas <= 8 ? 20 : Math.max(0, 20 - (overseas - 8) * 5);
  return Math.round(depth + balance + overseasScore);
}

const SPLASH_TIPS = [
  "Hosting a room is free. Create a room, pick a franchise and share the code with your friends.",
  "Your purse is shared across the whole squad. Leave room for the later sets.",
  "The bid timer resets on every new bid, so a late bid can still win the player.",
  "Only the host can mark players sold or unsold, and end the auction."
];

function Splash({ onEnter }) {
  const [ready, setReady] = useState(false);
  const [tip] = useState(() => SPLASH_TIPS[Math.floor(Math.random() * SPLASH_TIPS.length)]);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 1200);
    return () => clearTimeout(timer);
  }, []);
  return (
    <main className="cx-page cx-splash">
      <span className="cx-splash-brand"><i><Gavel size={16} /></i>AuctionRoom</span>
      <div className="cx-splash-foot">
        <div className="cx-tip"><b>LOADING TIP</b><p>{tip}</p></div>
        <button className="cx-enter" disabled={!ready} onClick={onEnter}>ENTER AUCTION ROOM <ChevronRight size={15} /></button>
        <div className="cx-loadline"><i /></div>
      </div>
    </main>
  );
}

const logoMissing = new Set();

// Uses /public/logos/<key>.png (csk, mi, rcb, kkr, rr, srh, dc, pbks, gt, lsg) when present,
// otherwise draws a shield crest in the franchise colour.
function TeamChip({ teamKey, label }) {
  const t = teamInfo(teamKey);
  const [, force] = useState(0);
  if (!t) return <span className="cx-chip plain">{label || "•"}</span>;
  const useImg = !logoMissing.has(t.key);
  return (
    <span className="cx-chip logo" style={{ "--team-color": t.color }} title={t.name}>
      {useImg ? (
        <img src={`/logos/${t.key}.png`} alt={t.short} draggable="false" onError={() => { logoMissing.add(t.key); force(n => n + 1); }} />
      ) : (
        <svg viewBox="0 0 40 46" role="img" aria-label={t.short}>
          <defs>
            <linearGradient id={`g-${t.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={t.color} />
              <stop offset="1" stopColor={TEAM_ACCENT[t.key] || t.color} />
            </linearGradient>
          </defs>
          <path d="M20 1.5 37 7v15c0 11-7.5 18.5-17 22C10.500 40.500 3 33 3 22V7z" fill={`url(#g-${t.key})`} stroke="rgba(255,255,255,.75)" strokeWidth="1.8" />
          <path d="M20 5 34 9.500V22c0 9-6 15.500-14 19" fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="1.2" />
          <text x="20" y="26" textAnchor="middle" fontSize={t.short.length > 3 ? 10 : 12.500} fontWeight="900" fontFamily="Inter, system-ui, sans-serif" fill="#fff" stroke="rgba(0,0,0,.45)" strokeWidth=".6" paintOrder="stroke">{t.short}</text>
        </svg>
      )}
    </span>
  );
}

function TimerPicker({ value, onChange }) {
  return (
    <div className="cx-timer-pick" role="group" aria-label="Bid timer in seconds">
      {[5, 6, 7, 8, 9, 10].map(n => (
        <button key={n} type="button" className={value === n ? "active" : ""} aria-pressed={value === n} onClick={() => onChange(n)}>{n}s</button>
      ))}
    </div>
  );
}

function PlayerPhoto({ player }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [player?.photo_url]);
  if (player?.photo_url && !failed) return <img referrerPolicy="no-referrer" src={player.photo_url} alt={player.name} onError={() => setFailed(true)} />;
  return <div className="cx-photo-fallback">{player ? player.name.split(" ").map(w => w[0]).slice(0, 2).join("") : <Gavel size={34} />}</div>;
}

export default function App() {
  const [page, setPage] = useState("home");
  const [theme, setTheme] = useState(() => {
    try { const saved = localStorage.getItem("auctionroom-theme"); return THEMES.some(t => t.id === saved) ? saved : "stadium"; } catch { return "stadium"; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("auctionroom-theme", theme); } catch {}
  }, [theme]);
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
  const [socketConnected, setSocketConnected] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [reactionBursts, setReactionBursts] = useState([]);
  const [replayOpen, setReplayOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [purses, setPurses] = useState([]);
  const [squads, setSquads] = useState([]);
  const [xi, setXi] = useState([]);
  const [playerSearch, setPlayerSearch] = useState("");
  const [setsFilter, setSetsFilter] = useState("all");
  const [watchlist, setWatchlist] = useState(() => {
    try { const saved = JSON.parse(localStorage.getItem("auctionroom-watchlist") || "[]"); return Array.isArray(saved) ? saved.map(Number) : []; } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem("auctionroom-watchlist", JSON.stringify(watchlist)); } catch {} }, [watchlist]);
  const toggleWatchlist = playerId => setWatchlist(old => old.includes(Number(playerId)) ? old.filter(id => id !== Number(playerId)) : [...old, Number(playerId)]);
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
  const [splash, setSplash] = useState(() => { try { return sessionStorage.getItem("cx-splash") !== "1"; } catch { return true; } });
  const [homeTab, setHomeTab] = useState("create");
  const [lobbyTab, setLobbyTab] = useState("players");
  const [railTab, setRailTab] = useState("activity");
  const [pane, setPane] = useState("auction");
  const [sheet, setSheet] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [openTeam, setOpenTeam] = useState(null);
  const [endTab, setEndTab] = useState("squads");

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
    try {
      const code = new URLSearchParams(window.location.search).get("room");
      if (code) { setRoomCodeInput(code.toUpperCase().slice(0, 8)); setHomeTab("join"); }
    } catch {}
  }, []);

  useEffect(() => {
    api.get("/api/modes").then(r => setModeCounts(Object.fromEntries((r.data?.data || []).map(m => [m.key, m.players])))).catch(() => {});
  }, []);

  const loadRoomData = useCallback(async (code, teamForDraft = myTeam) => {
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
      const squadRows = squadR.data.data || [];
      const serverXi = xiR.data.data || [];
      setSquads(squadRows);
      let restoredXi = serverXi;
      try {
        const draftIds = JSON.parse(localStorage.getItem(`auctionroom-xi-draft:${code}:${teamForDraft || "spectator"}`) || "null");
        if (Array.isArray(draftIds)) {
          const ownDraft = draftIds.map(id => squadRows.find(p => p.team_key === teamForDraft && Number(p.id) === Number(id))).filter(Boolean)
            .map((p, index) => ({ ...p, team_key: teamForDraft, position: index + 1 }));
          restoredXi = [...serverXi.filter(p => p.team_key !== teamForDraft), ...ownDraft];
        }
      } catch {}
      setXi(restoredXi);
      setMessages(chatR.data.data || []);
    } catch (error) {
      setNotice(`Room data: ${getError(error, "could_not_load_room")}`);
    }
  }, [myTeam]);

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
      setSocketConnected(true);
      socket.emit("room:join-live", {
        code,
        participantId: p.participantId || p.participant_id
      }, response => {
        if (response?.ok) {
          if (response.room?.state) {
            setAuction(response.room.state);
            if (["active", "paused", "sold", "unsold", "ended"].includes(response.room.state.status)) setPage("auction");
          }
          if (response.room?.config) setRoom(old => ({ ...(old || {}), config: response.room.config }));
          if (Array.isArray(response.participants)) setParticipants(response.participants);
          // Re-fetch durable data after every successful connect/reconnect so bids, squads,
          // messages and the saved XI are restored rather than relying only on missed socket events.
          loadRoomData(code, p.teamKey || p.team_key || null);
          setNotice("Connected · room state synced");
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

    socket.on("disconnect", () => {
      setSocketConnected(false);
      setNotice("Connection lost. Reconnecting and syncing room state…");
    });
    socket.on("connect_error", () => {
      setSocketConnected(false);
      setNotice("Connection issue. Retrying…");
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
    socket.on("reaction:received", event => {
      const item = { ...event, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
      setReactionBursts(old => [...old.slice(-7), item]);
      setTimeout(() => setReactionBursts(old => old.filter(r => r.id !== item.id)), 2600);
    });

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
      try { localStorage.removeItem(`auctionroom-xi-draft:${roomCode}:${xiTeam || "spectator"}`); } catch {}
      setNotice("Playing XI saved");
      await loadRoomData(roomCode);
    } catch (error) {
      setNotice(`Playing XI save failed: ${getError(error)}`);
    }
  };

  const persistXiDraft = ids => {
    try { localStorage.setItem(`auctionroom-xi-draft:${roomCode}:${xiTeam || "spectator"}`, JSON.stringify(ids.map(Number))); } catch {}
  };

  const toggleXI = playerId => {
    const already = selectedXI.some(p => Number(p.id) === Number(playerId));
    if (already) {
      const next = selectedXI.filter(p => Number(p.id) !== Number(playerId));
      persistXiDraft(next.map(p => p.id));
      setXi(old => [...old.filter(p => p.team_key !== xiTeam), ...next.map((p, index) => ({ ...p, team_key: xiTeam, position: index + 1 }))]);
    } else if (selectedXI.length < 11) {
      const player = mySquad.find(p => Number(p.id) === Number(playerId));
      if (player) {
        const next = [...selectedXI, { ...player, team_key: xiTeam, position: selectedXI.length + 1 }];
        persistXiDraft(next.map(p => p.id));
        setXi(old => [...old.filter(p => p.team_key !== xiTeam), ...next]);
      }
    } else {
      setNotice("Playing XI is limited to 11 players.");
    }
  };

  const reorderXI = (playerId, direction) => {
    setXi(old => {
      const teamRows = old.filter(p => p.team_key === xiTeam);
      const otherRows = old.filter(p => p.team_key !== xiTeam);
      const from = teamRows.findIndex(p => Number(p.id) === Number(playerId));
      const to = from + direction;
      if (from < 0 || to < 0 || to >= teamRows.length) return old;
      const [moved] = teamRows.splice(from, 1);
      teamRows.splice(to, 0, moved);
      const ordered = teamRows.map((p, index) => ({ ...p, position: index + 1 }));
      persistXiDraft(ordered.map(p => p.id));
      return [...otherRows, ...ordered];
    });
  };

  const copyXI = () => {
    if (!selectedXI.length) return setNotice("Select players for your Playing XI first.");
    const text = selectedXI.map((p, index) => `${index + 1}. ${p.name}${isIndian(p.nationality) ? "" : " ✈️"}`).join("\n");
    copyText(text, "Playing XI copied in batting order.");
  };

  const sendReaction = emoji => {
    const socket = socketRef.current;
    if (!socket?.connected) return setNotice("Reconnect before sending a reaction.");
    socket.emit("reaction:send", { emoji }, response => {
      if (!response?.ok) setNotice(friendly(response?.error || "reaction_failed"));
    });
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
    }).filter(group => setsFilter === "all" || (setsFilter === "watchlist" ? group.players.some(p => watchlist.includes(Number(p.id))) : group.status === setsFilter));
  }, [players, auction, setsFilter, watchlist]);

  // ---------- values shared by every screen ----------
  const claimed = Object.keys(teamOwners).length;
  const myName = participant?.displayName || participant?.display_name || displayName || "Participant";
  const chatMessages = messages
    .filter(m => !m.auctionEvent && String(m.display_name || "").trim().toUpperCase() !== "AUCTION UPDATE" && !["sold", "unsold", "skipped"].includes(String(m.kind || "").toLowerCase()))
    .slice()
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  const feed = [
    ...bids.map((b, i) => ({ kind: "bid", id: `b-${b.id ?? i}`, at: b.created_at, bid: b })),
    ...messages.filter(m => m.auctionEvent || m.display_name === "AUCTION UPDATE").map(m => ({ kind: "event", id: `e-${m.id}`, at: m.created_at, msg: m }))
  ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  const visibleFeed = feed.slice(0, 30);
  const stats = playerStats(currentPlayer);
  const completedCount = (auction.completedPlayerIds || []).length;
  const settledNow = ["sold", "unsold"].includes(auction.status);
  const lotNo = settledNow ? completedCount : completedCount + 1;
  const setInfo = auction.setProgress || null;
  const iLead = Boolean(myTeam) && myTeam === auction.highestBidder?.teamKey;
  const pursePaise = myPurse?.remainingPursePaise ?? PURSE_PAISE;
  const squadCount = Math.max(mySquad.length, Number(myPurse?.players_bought || 0));
  const overseasCount = mySquad.filter(p => !isIndian(p.nationality)).length;
  const currentPlayerIsOverseas = Boolean(currentPlayer && !isIndian(currentPlayer.nationality));
  // UI feedback mirrors the server checks; the server remains authoritative.
  const bidBlock = !myTeam ? { key: "spectator", label: "Spectating", message: "Pick a franchise in the lobby to bid." }
    : squadCount >= MAX_SQUAD ? { key: "full", label: "Squad full · 25/25", message: ERRORS.squad_full }
    : currentPlayerIsOverseas && overseasCount >= 8 ? { key: "overseas", label: "Overseas limit · 8/8", message: ERRORS.overseas_limit }
    : pursePaise < nextBid ? { key: "purse", label: "Insufficient purse", message: ERRORS.insufficient_purse }
    : null;
  const bidDisabled = auction.status !== "active" || !currentPlayer || remaining <= 0 || iLead || Boolean(bidBlock);
  const ended = auction.status === "ended";
  const endAuction = () => {
    if (window.confirm("End the auction now? Remaining players stay unsold and everyone will see the final squads.")) hostAction("end");
  };
  const copyText = (text, done) => {
    navigator.clipboard?.writeText(text)?.catch(() => {});
    setNotice(done);
  };
  const exportSquadsCsv = () => {
    const rows = [["Room", "Mode", "Team", "Player", "Role", "Nationality", "Purchase price (paise)", "Purchase price (Cr)"]];
    for (const player of squads) rows.push([roomCode, modeOf(room).name, teamInfo(player.team_key)?.name || player.team_key, player.name, roleLabel(player.role), player.nationality || "", Number(player.purchase_price_paise || 0), (Number(player.purchase_price_paise || 0) / 1000000000).toFixed(2)]);
    setNotice(downloadCsv(`ipl-auction-${roomCode.toLowerCase()}-squads.csv`, rows) ? "Squad CSV exported." : "There are no sold players to export yet.");
  };
  const exportResultsCsv = () => {
    const rows = [["Rank", "Team", "Players", "Overseas players", "Spent (paise)", "Remaining purse (paise)", "Squad shape score"]];
    const ranked = TEAMS.map(team => {
      const list = squads.filter(p => p.team_key === team.key);
      const purse = purses.find(p => p.team_key === team.key);
      return { team, list, overseas: list.filter(p => !isIndian(p.nationality)).length, spent: Number(purse?.spent_paise || list.reduce((sum, p) => sum + Number(p.purchase_price_paise || 0), 0)), remaining: Number(purse?.remainingPursePaise ?? Math.max(0, PURSE_PAISE - list.reduce((sum, p) => sum + Number(p.purchase_price_paise || 0), 0))), rating: squadRating(list) };
    }).sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
    ranked.forEach((r, i) => rows.push([i + 1, r.team.name, r.list.length, r.overseas, r.spent, r.remaining, r.rating ?? "N/A"]));
    setNotice(downloadCsv(`ipl-auction-${roomCode.toLowerCase()}-results.csv`, rows) ? "Results CSV exported." : "Could not export results.");
  };
  const exportUnsoldCsv = () => {
    const ids = new Set((auction.unsoldPlayerIds || []).map(Number));
    const unsold = players.filter(p => ids.has(Number(p.id)));
    const rows = [["Player", "Role", "Nationality", "Set", "Base price (paise)"]];
    unsold.forEach(p => rows.push([p.name, roleLabel(p.role), p.nationality || "", p.source_data?.set_name || p.source_data?.set || "", Number(p.base_price_paise || 0)]));
    setNotice(downloadCsv(`ipl-auction-${roomCode.toLowerCase()}-unsold.csv`, rows) ? "Unsold player report exported." : "No unsold players are available to export.");
  };
  const exportEventHistoryCsv = () => {
    const rows = [["Timestamp", "Event", "Player", "Team", "Amount (paise)"]];
    feed.slice().reverse().forEach(item => rows.push([item.at || "", item.kind === "bid" ? "Bid" : item.msg?.message || "Auction event", item.kind === "bid" ? item.bid?.player_name || "" : "", item.kind === "bid" ? (teamInfo(item.bid?.team_key)?.name || item.bid?.team_key || "") : "", item.kind === "bid" ? Number(item.bid?.amount_paise || 0) : ""]));
    setNotice(downloadCsv(`ipl-auction-${roomCode.toLowerCase()}-event-history.csv`, rows) ? "Event history exported." : "No event history to export yet.");
  };
  const inviteLink = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
  const openBoard = which => { setTab(which); setSheet(true); };

  const chatPanel = (
    <>
      <ul className="cx-chat cx-scroll">
        {chatMessages.slice(0, 60).map((m, i) => (
          <li key={`msg-${m.id ?? i}`}>
            {m.team_key ? <TeamChip teamKey={m.team_key} /> : <span className="cx-chip plain">{(m.display_name || "P").charAt(0).toUpperCase()}</span>}
            <b>{m.display_name || "Participant"}</b>
            <time>{clockShort(m.created_at)}</time>
            <span className="t">{m.message}</span>
          </li>
        ))}
        {!chatMessages.length && <li className="empty">No messages yet. Say hello.</li>}
      </ul>
      <form className="cx-compose" onSubmit={sendChat}>
        <button type="button" className={`cx-btn square ${voiceJoined ? "on" : ""}`} onClick={startVoice} aria-label={voiceJoined ? "Leave voice chat" : "Join voice chat"} title={voiceJoined ? `Voice on · ${voicePeers} connected. Tap to leave` : "Join voice chat"}>
          {voiceJoined ? <Mic size={18} /> : <Radio size={18} />}
        </button>
        <input className="cx-input" value={chatText} onChange={e => setChatText(e.target.value)} placeholder="Send a message" maxLength={500} />
        <button className="cx-btn square send" type="submit" aria-label="Send message"><Send size={18} /></button>
      </form>
    </>
  );

  const squadsView = (
    <div className="cx-squads">
      {[...TEAMS].sort((a, b) => (a.key === myTeam ? -1 : b.key === myTeam ? 1 : 0)).map(team => {
        const list = squads.filter(p => p.team_key === team.key);
        const purse = purses.find(p => p.team_key === team.key);
        return (
          <article className={`cx-squad ${team.key === myTeam ? "mine" : ""}`} key={team.key} style={{ "--team-color": team.color }}>
            <div className="cx-squad-head">
              <TeamChip teamKey={team.key} />
              <div><b>{team.name}</b><small>{team.key === myTeam ? "Your team" : teamOwners[team.key] || "No owner yet"}</small></div>
              <strong>{money(purse?.remainingPursePaise ?? PURSE_PAISE)}</strong>
            </div>
            <div className="cx-squad-meta"><span>Players <b>{list.length}/{MAX_SQUAD}</b></span><span>Spent <b>{money(purse?.spent_paise || 0)}</b></span></div>
            <ul>{list.map(p => <li key={p.id}><span>{p.name}</span><b>{money(p.purchase_price_paise)}</b></li>)}</ul>
            {!list.length && <p className="cx-empty">No players bought yet.</p>}
          </article>
        );
      })}
    </div>
  );

  const setsView = (
    <>
      <div className="cx-setnow">
        <div><span className="cx-label">Now auctioning</span><strong>{setInfo?.name || auction.currentSetName || currentPlayer?.source_data?.set_name || (auction.currentSetNumber ? `Set ${auction.currentSetNumber}` : "Waiting for first set")}</strong></div>
        <span>{ended ? "Auction complete" : setInfo ? `Set ${setInfo.position} of ${setInfo.totalSets} · ${setInfo.remaining} of ${setInfo.total} left` : `${auction.soldCount || 0} sold · ${auction.unsoldCount || 0} unsold`}</span>
      </div>
      <div className="cx-filters">
        {[["all", "All"], ["current", "Current"], ["upcoming", "Upcoming"], ["completed", "Completed"], ["watchlist", `Watchlist (${watchlist.length})`]].map(([key, label]) => (
          <button key={key} className={setsFilter === key ? "on" : ""} onClick={() => setSetsFilter(key)}>{label}</button>
        ))}
      </div>
      <div className="cx-sets">
        {currentSetStatus.map(group => (
          <article className="cx-set" key={`${group.number}-${group.name}`}>
            <div className="cx-set-head">
              <div><b>{group.name}</b><small>{group.players.length} players · {group.soldCount} sold · {group.unsoldCount} unsold · {group.remainingCount} left</small></div>
              <span className={`cx-tag ${group.status === "completed" ? "gray" : group.status === "current" ? "green" : "blue"}`}>{group.status === "completed" ? "Done" : group.status === "current" ? "Live" : "Next"}</span>
              {isHost && group.status === "upcoming" && <span className="cx-set-reorder">
                <button type="button" className="cx-watch-btn" aria-label={`Move ${group.name} earlier`} title="Move set earlier" onClick={() => { const order = (auction.setOrder || []).map(String); const i = order.indexOf(String(group.number)); if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; hostAction("reorder-sets", { setOrder: order }); } }}><ChevronUp size={13} /></button>
                <button type="button" className="cx-watch-btn" aria-label={`Move ${group.name} later`} title="Move set later" onClick={() => { const order = (auction.setOrder || []).map(String); const i = order.indexOf(String(group.number)); if (i >= 0 && i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; hostAction("reorder-sets", { setOrder: order }); } }}><ChevronDown size={13} /></button>
              </span>}
            </div>
            <details open={ended || group.status === "completed"}>
              <summary>View players · {group.players.length}</summary>
              <div className="cx-set-players">{group.players.filter(p => setsFilter !== "watchlist" || watchlist.includes(Number(p.id))).map(p => <p key={p.id} className={p.unsold ? "unsold" : p.sold ? "sold" : ""}><span>{p.name}{!isIndian(p.nationality) ? " ✈️" : ""} · {p.role || "—"}</span><small>{p.unsold ? "UNSOLD" : p.sold ? "SOLD" : "UPCOMING"}</small><button type="button" className={`cx-watch-btn ${watchlist.includes(Number(p.id)) ? "on" : ""}`} onClick={() => toggleWatchlist(p.id)} aria-label={`${watchlist.includes(Number(p.id)) ? "Remove" : "Add"} ${p.name} ${watchlist.includes(Number(p.id)) ? "from" : "to"} watchlist`} title={watchlist.includes(Number(p.id)) ? "Remove from watchlist" : "Add to watchlist"}><Star size={13} fill={watchlist.includes(Number(p.id)) ? "currentColor" : "none"} /></button></p>)}</div>
            </details>
          </article>
        ))}
        {!currentSetStatus.length && <p className="cx-empty">No sets match this filter.</p>}
      </div>
    </>
  );

  const xiView = myTeam ? (
    <>
      <div className="cx-xi-controls">
        <span><TeamChip teamKey={myTeam} /><b>{teamInfo(myTeam)?.name} · Playing XI</b></span>
        <span>{selectedXI.length}/11 selected</span>
      </div>
      <div className="cx-xi-list">
        {mySquad.map(player => (
          <div className={`cx-xi-player ${selectedXI.some(p => Number(p.id) === Number(player.id)) ? "selected" : ""}`} key={player.id}>
            <input type="checkbox" aria-label={`Select ${player.name} for Playing XI`} checked={selectedXI.some(p => Number(p.id) === Number(player.id))} onChange={() => toggleXI(player.id)} />
            <span><b>{player.name}</b><small>{roleLabel(player.role)}{!isIndian(player.nationality) ? " · Overseas ✈️" : ""}</small></span>
            <strong>{money(player.purchase_price_paise)}</strong>
            {selectedXI.some(p => Number(p.id) === Number(player.id)) && <span className="cx-xi-order">
              <b>#{selectedXI.findIndex(p => Number(p.id) === Number(player.id)) + 1}</b>
              <button type="button" className="cx-btn square" disabled={selectedXI.findIndex(p => Number(p.id) === Number(player.id)) === 0} onClick={e => { e.preventDefault(); e.stopPropagation(); reorderXI(player.id, -1); }} aria-label={`Move ${player.name} up`}><ChevronUp size={14} /></button>
              <button type="button" className="cx-btn square" disabled={selectedXI.findIndex(p => Number(p.id) === Number(player.id)) === selectedXI.length - 1} onClick={e => { e.preventDefault(); e.stopPropagation(); reorderXI(player.id, 1); }} aria-label={`Move ${player.name} down`}><ChevronDown size={14} /></button>
            </span>}
          </div>
        ))}
      </div>
      {!mySquad.length && <p className="cx-empty">You haven't bought any players yet.</p>}
      <div className="cx-xi-actions">
        <button className="cx-save" onClick={saveXI}>Save playing XI</button>
        <button className="cx-btn" onClick={copyXI}><Clipboard size={15} /> Copy XI</button>
      </div>
    </>
  ) : <p className="cx-empty">You didn't pick a franchise in the lobby, so there is no playing XI to set.</p>;

  // ---------- splash ----------
  if (splash) {
    return <Splash onEnter={() => { try { sessionStorage.setItem("cx-splash", "1"); } catch {} setSplash(false); }} />;
  }

  // ---------- home ----------
  if (page === "home") {
    const creating = homeTab === "create";
    return (
      <main className="cx-page cx-home">
        <header className="cx-brandbar"><span className="cx-brand"><i><Gavel size={16} /></i>AuctionRoom</span><ThemePicker value={theme} onChange={setTheme} /></header>

        <section className="cx-hero">
          <h1><span>Build your</span><em>franchise</em></h1>
          <p>Host a live IPL auction with friends. Pick a game mode, share the room code and bid against each other in real time.</p>
          <ol className="cx-steps">
            <li><b>1</b>Create room</li><li><b>2</b>Invite friends</li><li><b>3</b>Start bidding</li>
          </ol>
        </section>

        <section className="cx-shell">
          <aside className="cx-shell-left">
            <h2><Trophy size={16} /> Auction rules</h2>
            <div className="cx-modeinfo">
              {creating ? (
                <><b>{MODES[mode].name}</b><p>{MODES[mode].tagline}</p></>
              ) : (
                <><b>Joining a room</b><p>Ask the host for the room code. The room's game mode applies to you automatically.</p></>
              )}
            </div>
            <ul className="cx-facts">
              {creating && <li><span>Player pool</span><b>{modeCounts[mode] ? `${modeCounts[mode]} players` : "—"}</b></li>}
              <li><span>Franchises</span><b>10</b></li>
              <li><span>Purse</span><b>₹120 Cr each</b></li>
              <li><span>Squad size</span><b>Up to {MAX_SQUAD} players</b></li>
              <li><span>Bid timer</span><b>5 to 10 seconds</b></li>
            </ul>
          </aside>

          <form className="cx-shell-right" onSubmit={creating ? createRoom : joinRoom}>
            <label className="cx-field">
              <span className="cx-label">Your name</span>
              <input className="cx-input" id="display-name" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Enter your name" maxLength={40} required />
            </label>

            <div className="cx-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={creating} className={creating ? "on" : ""} onClick={() => setHomeTab("create")}>Create</button>
              <button type="button" role="tab" aria-selected={!creating} className={!creating ? "on" : ""} onClick={() => setHomeTab("join")}>Join</button>
            </div>

            {creating ? (
              <>
                <div className="cx-field" role="radiogroup" aria-label="Game mode">
                  <span className="cx-label">Game mode</span>
                  <div className="cx-modes">
                    {Object.values(MODES).map(m => (
                      <button key={m.key} type="button" role="radio" aria-checked={mode === m.key} className={`cx-mode ${mode === m.key ? "on" : ""}`} onClick={() => setMode(m.key)}>
                        <b>{m.name}</b>
                        <small>{modeCounts[m.key] ? `${modeCounts[m.key]} players` : "Player pool"} · 120 Cr purse</small>
                      </button>
                    ))}
                  </div>
                </div>
                {mode === "mega2026" && <p className="cx-note">The real 2026 IPL auction was a mini auction. This mode uses its player pool, but every franchise starts from scratch like a mega auction.</p>}
                <button className="cx-cta" disabled={busy} type="submit"><Crown size={16} />{busy ? "Creating…" : `Create ${MODES[mode].short} room`}</button>
              </>
            ) : (
              <>
                <label className="cx-field">
                  <span className="cx-label">Room code</span>
                  <input className="cx-input cx-codeinput" id="room-code" value={roomCodeInput} onChange={e => setRoomCodeInput(e.target.value.toUpperCase())} placeholder="ABC123" maxLength={8} required />
                </label>
                <button className="cx-cta" disabled={busy} type="submit"><Users size={16} />{busy ? "Joining…" : "Join room"}</button>
              </>
            )}
          </form>
        </section>
        {notice && <Notice message={notice} onClose={clearNotice} />}
      </main>
    );
  }

  // ---------- lobby ----------
  if (page === "lobby") {
    return (
      <main className="cx-page cx-lobby">
        <header className="cx-lobby-top">
          <button className="cx-btn" onClick={leaveRoom}><Home size={15} /> Exit</button>
          <div className="cx-roomid"><span className="cx-label">Room code</span><b>{roomCode}</b></div>
          <ThemePicker value={theme} onChange={setTheme} compact />
          <span className="cx-grow" />
          {isHost ? (
            <button className="cx-btn primary" onClick={() => hostAction("start")}><Play size={14} /> Start auction</button>
          ) : (
            <span className="cx-pill">Waiting for the host</span>
          )}
        </header>

        <section className="cx-lobby-card">
          <div className="cx-lobby-left">
            <div>
              <h2>Auction rules</h2>
              <div className="cx-rules">
                <div className="cx-rule"><span className="cx-label">Game mode</span><b>{modeOf(room).name}</b></div>
                <div className="cx-rule"><span className="cx-label">Initial budget</span><b style={{ color: "var(--amber)" }}>₹120 Cr</b></div>
                <div className="cx-rule blue"><span className="cx-label">Squad capacity</span><b>{MAX_SQUAD} players</b></div>
                <div className="cx-rule violet"><span className="cx-label">Bid timer</span><b>{duration} seconds</b></div>
              </div>
              {isHost && (
                <div className="cx-rule" style={{ marginTop: 10 }}>
                  <span className="cx-label">Host setting: bid timer</span>
                  <TimerPicker value={duration} onChange={setTimerSeconds} />
                </div>
              )}
            </div>

            <div>
              <h2>Claim franchise {myTeam && <span className="cx-locked">SELECTED</span>}</h2>
              <div className="cx-franchise">
                {TEAMS.map(team => {
                  const owner = teamOwners[team.key];
                  const isMine = myTeam === team.key;
                  return (
                    <button key={team.key} type="button" className={`cx-team ${owner ? "taken" : ""} ${isMine ? "mine" : ""}`} style={{ "--team-color": team.color }}
                      onClick={() => chooseTeam(team.key)} disabled={Boolean(owner && !isMine)} aria-pressed={isMine}
                      title={owner && !isMine ? `${team.name}: taken by ${owner}` : team.name}>
                      <TeamChip teamKey={team.key} />
                      {isMine && <Check size={14} />}
                      <span>{isMine ? "YOU" : team.short}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <h2>Invite players</h2>
              <div className="cx-invite">
                <input className="cx-input" readOnly value={inviteLink} aria-label="Invite link" onFocus={e => e.target.select()} />
                <button className="cx-btn" type="button" onClick={() => copyText(inviteLink, "Invite link copied")} aria-label="Copy invite link"><Copy size={16} /></button>
                <a className="cx-btn wa" href={`https://wa.me/?text=${encodeURIComponent(`Join my IPL auction: ${inviteLink}`)}`} target="_blank" rel="noreferrer" aria-label="Share on WhatsApp"><MessageCircle size={16} /></a>
                <button className="cx-btn" type="button" onClick={() => setQrOpen(v => !v)} aria-expanded={qrOpen} aria-label="Show QR invitation">QR</button>
              </div>
              {qrOpen && <div className="cx-qr-card">
                <img src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=8&data=${encodeURIComponent(inviteLink)}`} alt="QR code for this auction room invitation" />
                <div><b>Scan to join</b><small>Opens this room on the same website.</small><button className="cx-btn" type="button" onClick={() => copyText(inviteLink, "Invite link copied")}>Copy invite link</button></div>
              </div>}
            </div>
          </div>

          <div className="cx-lobby-right">
            <div className="cx-seg" role="tablist">
              <button type="button" role="tab" aria-selected={lobbyTab === "players"} className={lobbyTab === "players" ? "on" : ""} onClick={() => setLobbyTab("players")}><Users size={16} />Players ({participants.length})</button>
              <button type="button" role="tab" aria-selected={lobbyTab === "chat"} className={lobbyTab === "chat" ? "on" : ""} onClick={() => setLobbyTab("chat")}><MessageCircle size={16} />Chat</button>
            </div>
            {lobbyTab === "players" ? (
              <ul className="cx-roster cx-scroll">
                {participants.map((p, i) => {
                  const key = p.team_key || p.teamKey;
                  const name = p.display_name || p.displayName || "Participant";
                  const me = (p.participant_id || p.participantId) === participantId;
                  return (
                    <li className="cx-person" key={p.participant_id || p.participantId || i} style={{ "--team-color": teamInfo(key)?.color }}>
                      {key ? <TeamChip teamKey={key} /> : <span className="cx-chip plain">{name.charAt(0).toUpperCase()}</span>}
                      <div>
                        <b>{name}{(p.is_host || p.isHost) && <Crown size={13} />}{me && <span className="cx-you">YOU</span>}</b>
                        <small>{key ? teamInfo(key)?.name : "No franchise yet"}</small>
                      </div>
                    </li>
                  );
                })}
                {!participants.length && <li className="cx-empty">Nobody has joined yet.</li>}
              </ul>
            ) : (
              <div className="cx-chatbox">{chatPanel}</div>
            )}
          </div>
        </section>
        {notice && <Notice message={notice} onClose={clearNotice} />}
      </main>
    );
  }

  // ---------- results ----------
  if (ended) {
    const topSales = squads.slice().sort((a, b) => Number(b.purchase_price_paise || 0) - Number(a.purchase_price_paise || 0)).slice(0, 10);
    const rated = TEAMS.map(t => {
      const list = squads.filter(p => p.team_key === t.key);
      return { team: t, list, rating: squadRating(list), overseas: list.filter(p => !isIndian(p.nationality)).length };
    }).sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
    const END_TABS = [
      { id: "squads", label: "Team squads", Icon: Users },
      { id: "expensive", label: "Top expensive", Icon: Trophy },
      { id: "ratings", label: "Squad ratings", Icon: Zap },
      { id: "xi", label: "Playing XI", Icon: ListOrdered },
      { id: "sets", label: "Sets", Icon: Layers }
    ];
    return (
      <main className="cx-page cx-end">
        <div className="cx-end-wrap">
          <header className="cx-end-top">
            <span className="cx-pill">Room <b style={{ color: "var(--orange)" }}>{roomCode}</b></span>
            <ThemePicker value={theme} onChange={setTheme} compact />
            <button className="cx-btn" onClick={exportSquadsCsv}><Clipboard size={15} /> Squads CSV</button>
            <button className="cx-btn" onClick={exportResultsCsv}><Trophy size={15} /> Results CSV</button>
            <button className="cx-btn" onClick={exportUnsoldCsv}><Layers size={15} /> Unsold CSV</button>
            <button className="cx-btn" onClick={() => setReplayOpen(true)}><Play size={15} /> Replay</button>
            <button className="cx-btn" onClick={exportEventHistoryCsv}><Timer size={15} /> Event log</button>
            <button className="cx-btn" onClick={leaveRoom}><Home size={15} /> Menu</button>
          </header>
          {replayOpen && <div className="cx-modal-backdrop" role="presentation" onClick={() => setReplayOpen(false)}>
            <section className="cx-replay-modal" role="dialog" aria-modal="true" aria-label="Auction replay" onClick={e => e.stopPropagation()}>
              <header><div><b>Auction replay</b><small>Recorded bids and sold/unsold events from this room</small></div><button className="cx-btn square" onClick={() => setReplayOpen(false)} aria-label="Close replay"><X size={16} /></button></header>
              <ol className="cx-replay-list">{feed.slice().reverse().map(item => <li key={item.id}><time>{item.at ? new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</time>{item.kind === "bid" ? <span><b>{item.bid?.display_name || teamInfo(item.bid?.team_key)?.name || "Team"}</b> bid {money(item.bid?.amount_paise)} on {item.bid?.player_name || "player"}</span> : <span>{item.msg?.message || "Auction event"}</span>}</li>)}{!feed.length && <li className="cx-empty">No recorded events yet.</li>}</ol>
              <footer><button className="cx-btn" onClick={exportEventHistoryCsv}><Clipboard size={14} /> Export event log</button></footer>
            </section>
          </div>}
          <h1>Auction <em>complete</em></h1>
          <nav className="cx-end-tabs" role="tablist">
            {END_TABS.map(({ id, label, Icon }) => (
              <button key={id} role="tab" aria-selected={endTab === id} className={endTab === id ? "on" : ""} onClick={() => setEndTab(id)}><Icon size={15} />{label}</button>
            ))}
          </nav>

          {endTab === "squads" && squadsView}
          {endTab === "expensive" && (
            <ol className="cx-rank">
              {topSales.map((p, i) => (
                <li key={p.id}>
                  <span className="no">{i + 1}</span>
                  <TeamChip teamKey={p.team_key} />
                  <div><b>{p.name}</b><small>{roleLabel(p.role)} · {teamInfo(p.team_key)?.name}</small></div>
                  <strong>{money(p.purchase_price_paise)}</strong>
                </li>
              ))}
              {!topSales.length && <li className="cx-empty" style={{ display: "block" }}>No players were sold.</li>}
            </ol>
          )}
          {endTab === "ratings" && (
            <>
              <p className="cx-formula">Rating out of 100: squad depth (up to 40), role balance (a keeper, 3 batters, 2 all-rounders and 4 bowlers, 10 each) and overseas count (20, minus 5 for each player past 8). It measures squad shape, not player quality.</p>
              <ol className="cx-rank">
                {rated.map((r, i) => (
                  <li key={r.team.key}>
                    <span className="no">{i + 1}</span>
                    <TeamChip teamKey={r.team.key} />
                    <div><b>{r.team.name}</b><small>{r.list.length} players · {r.overseas} overseas</small></div>
                    <strong>{r.rating ?? "N/A"}</strong>
                    {r.rating !== null && <span className="cx-bar"><i style={{ width: `${r.rating}%` }} /></span>}
                  </li>
                ))}
              </ol>
            </>
          )}
          {endTab === "xi" && <div style={{ maxWidth: 900, margin: "0 auto" }}>{xiView}</div>}
          {endTab === "sets" && setsView}
        </div>
        {notice && <Notice message={notice} onClose={clearNotice} />}
      </main>
    );
  }

  // ---------- live auction ----------
  const base = currentPlayer?.base_price_paise ? money(currentPlayer.base_price_paise) : "—";
  const setLabel = setInfo ? `${setInfo.name || "Set"} · ${setInfo.position}/${setInfo.totalSets}` : (auction.currentSetName || currentPlayer?.source_data?.set_name || "Waiting");
  const expandedTeam = openTeam === null ? myTeam : openTeam;
  const nationTag = currentPlayer ? (isIndian(currentPlayer.nationality) ? ["violet", "Indian"] : ["cyan", currentPlayer.nationality || "Overseas"]) : null;

  return (
    <main ref={barRef} className="cx-room" data-pane={pane}>
      <header className="cx-top">
        <span className="cx-code">{roomCode}</span>
        <span className={`cx-connection ${socketConnected ? "online" : "offline"}`} title={socketConnected ? "Connected to auction server" : "Reconnecting to auction server"}><i />{socketConnected ? "Live" : "Reconnecting"}</span>
        <span className={`cx-count ${claimed ? "" : "idle"}`}><i />{claimed}/10</span>
        <button className="cx-btn square hide-sm" onClick={() => copyText(roomCode, "Room code copied")} aria-label="Copy room code" title="Copy room code"><Copy size={15} /></button>
        <button className="cx-btn hide-sm" onClick={() => setReplayOpen(true)} title="Review auction event timeline"><Timer size={14} /> Replay</button>
        {auction.status === "paused" && <span className="cx-tag amber">Paused</span>}
        <span className="grow" />
        {isHost && (
          <>
            <button className="cx-btn" onClick={() => hostAction(auction.status === "paused" ? "resume" : "pause")} disabled={!["active", "paused"].includes(auction.status)}>
              {auction.status === "paused" ? <Play size={14} /> : <Pause size={14} />}<span className="hide-sm">{auction.status === "paused" ? "Resume" : "Pause"}</span>
            </button>
            <button className="cx-btn danger" onClick={endAuction}><Flag size={14} /><span className="hide-sm">End</span></button>
          </>
        )}
        <button className="cx-btn" onClick={() => setPeopleOpen(true)}><Users size={14} /><span className="hide-sm">Participants</span></button>
        <button className="cx-btn square" onClick={() => setSettingsOpen(v => !v)} aria-label="Settings" aria-expanded={settingsOpen}><Settings size={16} /></button>
        <button className="cx-btn square" onClick={leaveRoom} aria-label="Exit room"><Home size={16} /></button>
      </header>

      <div className="cx-reaction-bar" aria-label="Live reactions">
        <span>React</span>
        {["👏", "🔥", "😂", "😮", "💸", "🏏"].map(emoji => <button type="button" key={emoji} onClick={() => sendReaction(emoji)} aria-label={`Send ${emoji} reaction`}>{emoji}</button>)}
      </div>
      {reactionBursts.length > 0 && <div className="cx-reaction-bursts" aria-live="polite">{reactionBursts.map(r => <span key={r.id}>{r.emoji} <small>{r.displayName || "Player"}</small></span>)}</div>}
      {replayOpen && <div className="cx-modal-backdrop" role="presentation" onClick={() => setReplayOpen(false)}>
        <section className="cx-replay-modal" role="dialog" aria-modal="true" aria-label="Auction replay" onClick={e => e.stopPropagation()}>
          <header><div><b>Auction replay</b><small>Chronological view of recorded bids and auction events</small></div><button className="cx-btn square" onClick={() => setReplayOpen(false)} aria-label="Close replay"><X size={16} /></button></header>
          <ol className="cx-replay-list">
            {feed.slice().reverse().map(item => <li key={item.id}>
              <time>{item.at ? new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</time>
              {item.kind === "bid" ? <span><b>{item.bid?.display_name || teamInfo(item.bid?.team_key)?.name || "Team"}</b> bid {money(item.bid?.amount_paise)} on {item.bid?.player_name || "player"}</span> : <span>{item.msg?.message || "Auction event"}</span>}
            </li>)}
            {!feed.length && <li className="cx-empty">No recorded events yet.</li>}
          </ol>
          <footer><button className="cx-btn" onClick={exportEventHistoryCsv}><Clipboard size={14} /> Export event log</button></footer>
        </section>
      </div>}
      {settingsOpen && (
        <div className="cx-menu" role="menu">
          <div className="cx-menu-theme"><span>Appearance</span><ThemePicker value={theme} onChange={setTheme} compact /></div>
          <button onClick={() => setSoundOn(v => !v)}>{soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />} Auction sounds <b>{soundOn ? "On" : "Off"}</b></button>
          <button onClick={startVoice}><Radio size={16} /> Voice chat <b>{voiceJoined ? `Leave · ${voicePeers} linked` : "Join"}</b></button>
          {voiceJoined && (
            <div className="cx-voice-debug">
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
          }}>{muted || !micOn ? <MicOff size={16} /> : <Mic size={16} />} Microphone <b>{muted || !micOn ? "Muted" : "On"}</b></button>
          {isHost && <div className="cx-timer-row"><span>Bid timer (seconds)</span><TimerPicker value={duration} onChange={setTimerSeconds} /></div>}
        </div>
      )}

      <div className="cx-body">
        <aside className="cx-side">
          <div className="cx-side-head"><span className="cx-label">Auction teams</span></div>
          <div className="cx-teamlist cx-scroll">
            {TEAMS.map((team, i) => {
              const list = squads.filter(p => p.team_key === team.key);
              const purse = purses.find(p => p.team_key === team.key);
              const open = expandedTeam === team.key;
              const rating = squadRating(list);
              const lead = auction.highestBidder?.teamKey === team.key && auction.status === "active";
              return (
                <div className={`cx-trow ${team.key === myTeam ? "mine" : ""}`} key={team.key} style={{ "--team-color": team.color }}>
                  <button type="button" className={lead ? "lead" : ""} onClick={() => setOpenTeam(open ? "" : team.key)} aria-expanded={open}>
                    <span className="no">{i + 1}</span>
                    <TeamChip teamKey={team.key} />
                    <span className="nm">
                      <b>{team.name}</b>
                      <small><i className={teamOwners[team.key] ? "" : "off"} />{team.key === myTeam ? `${myName} (you)` : teamOwners[team.key] || "Open"}</small>
                    </span>
                    <span className="pr"><b>{crShort(purse?.remainingPursePaise ?? PURSE_PAISE)}</b><small>{list.length}/{MAX_SQUAD}</small></span>
                    {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                  {open && (
                    <div className="cx-tdetail">
                      <div className="cx-tstats">
                        <span>Spent <b>{crShort(purse?.spent_paise || 0)}</b></span>
                        <span>Rating <b>{rating ?? "N/A"}</b></span>
                        <span>Overseas <b>{list.filter(p => !isIndian(p.nationality)).length}</b></span>
                      </div>
                      {list.length ? (
                        <ul className="cx-tplayers">{list.map(p => <li key={p.id}><span>{p.name}</span><b>{crShort(p.purchase_price_paise)}</b></li>)}</ul>
                      ) : <p className="cx-empty">No players yet</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        <section className="cx-stage cx-scroll">
          <div className="cx-strip">
            <div><span className="cx-tag amber">{setLabel}</span></div>
            <div>Lot <b className="val">{currentPlayer ? lotNo : "—"}</b></div>
            <div>Base <b className="val">{base}</b></div>
            <div>Bidder {auction.highestBidder ? <span className="cx-tag green">{auction.highestBidder.teamName}</span> : <span className="cx-tag gray">No bids yet</span>}</div>
          </div>

          <div className="cx-stagebody">
            <article className="cx-lot">
              <div className="cx-pbar" aria-hidden="true"><i data-tp /></div>
              <div className="cx-lot-main">
                <figure className="cx-photo" style={{ margin: 0 }}><PlayerPhoto player={currentPlayer} /></figure>
                <div className="cx-info">
                  {currentPlayer && (
                    <div className="cx-pills">
                      <span className="cx-tag blue">{roleLabel(currentPlayer.role)}</span>
                      {nationTag && <span className={`cx-tag ${nationTag[0]}`}>{flagFor(currentPlayer.nationality)} {nationTag[1]}</span>}
                    </div>
                  )}
                  <h2 className="cx-name">{currentPlayer?.name || "Waiting for the host"}</h2>
                  {currentPlayer && (
                    <div className="cx-stats">
                      {stats.map(([label, value]) => <div key={label}><small>{statLabel(label)}</small><b>{value ?? "—"}</b></div>)}
                    </div>
                  )}
                  <div className="cx-bidrow">
                    <div className="cx-bid">
                      <span className="cx-label">Current bid</span>
                      {auction.currentBidPaise ? (
                        <b>{money(auction.currentBidPaise)}{auction.highestBidder?.teamKey && <TeamChip teamKey={auction.highestBidder.teamKey} />}</b>
                      ) : (
                        <b className="dim">Opens at {money(nextBid)}</b>
                      )}
                    </div>
                    <div className="cx-ring" data-tp role="timer" aria-label={`${remaining} seconds left`}><div><b>{remaining}</b><small>SEC</small></div></div>
                  </div>
                </div>
              </div>
              {bidBlock && bidBlock.key !== "spectator" && <p className="cx-bidnote" role="alert">{bidBlock.message}</p>}
              <div className="cx-actions">
                <button className="cx-place" disabled={bidDisabled} onClick={placeBid}>
                  {bidBlock ? <Ban size={20} /> : <Gavel size={20} />}
                  {bidBlock ? bidBlock.label : iLead ? `You lead · ${money(auction.currentBidPaise)}` : `Place bid: ${money(nextBid)}`}
                </button>
                <button className="cx-listbtn" onClick={() => openBoard("squads")} aria-label="Open squads and sets" title="Squads and sets"><ListOrdered size={22} /></button>
              </div>
            </article>

            {isHost && (
              <div className="cx-host">
                <button className="cx-btn" disabled={!auction.highestBidder || !currentPlayer || ["sold", "unsold", "ended"].includes(auction.status)} onClick={() => hostAction("sell")}><Check size={14} /> Sold</button>
                <button className="cx-btn" disabled={!currentPlayer || ["sold", "unsold", "ended"].includes(auction.status)} onClick={() => hostAction("unsold")}>Unsold</button>
                {["sold", "unsold"].includes(auction.status) && <button className="cx-btn primary" onClick={() => hostAction("next-player")}><ArrowRight size={14} /> Next player</button>}
                {currentPlayer && !["sold", "unsold", "ended"].includes(auction.status) && <button className="cx-btn" onClick={() => hostAction("defer-player")}><ArrowRight size={14} /> Defer player</button>}
                {currentPlayer && !["sold", "unsold", "ended"].includes(auction.status) && <button className="cx-btn" onClick={() => hostAction("defer-set", { setKey: String(auction.currentSetNumber ?? auction.setProgress?.key ?? "") })}><Layers size={14} /> Defer set</button>}
                {currentPlayer && !["sold", "unsold", "ended"].includes(auction.status) && <button className="cx-btn danger" onClick={() => { if (window.confirm("Permanently skip all remaining players in this set? They will be marked unsold.")) hostAction("skip-set", { setKey: String(auction.currentSetNumber ?? auction.setProgress?.key ?? "") }); }}><Ban size={14} /> Skip set</button>}
                {auction.status === "ended" && Number(auction.unsoldCount || 0) > 0 && <button className="cx-btn primary" onClick={() => hostAction("unsold-round")}><Gavel size={14} /> Start unsold round</button>}
                {(auction.deferredSetKeys || []).length > 0 && <span className="cx-host-note">Deferred sets: {(auction.deferredSetKeys || []).join(", ")}</span>}
              </div>
            )}

            <div className="cx-mine">
              <button onClick={() => openBoard("squads")}><Wallet size={15} />Purse <b className={bidBlock?.key === "purse" ? "warn" : ""}>{money(pursePaise)}</b></button>
              <button onClick={() => openBoard("squads")}><Users size={15} />Squad <b className={squadCount >= MAX_SQUAD ? "warn" : ""}>{squadCount}/{MAX_SQUAD}</b></button>
              <span>Sold <b>{auction.soldCount || 0}</b> · Unsold <b>{auction.unsoldCount || 0}</b> · Left <b>{Math.max(0, players.length - completedCount)}</b></span>
            </div>
          </div>
        </section>

        <aside className="cx-rail">
          <div className="cx-railtabs" role="tablist">
            <button role="tab" aria-selected={railTab === "activity"} className={railTab === "activity" ? "on" : ""} onClick={() => setRailTab("activity")}><Timer size={14} />Live activity</button>
            <button role="tab" aria-selected={railTab === "chat"} className={railTab === "chat" ? "on" : ""} onClick={() => setRailTab("chat")}><MessageCircle size={14} />Chat {chatMessages.length ? <em>{chatMessages.length}</em> : null}</button>
          </div>
          <div className="cx-railbody">
            {railTab === "activity" ? (
              <ul className="cx-feed cx-scroll">
                {visibleFeed.map(item => item.kind === "bid" ? (
                  <li key={item.id} className={`cx-bid-feed-item ${item.bid.team_key && item.bid.team_key === myTeam ? "mine" : ""}`}>
                    <div className="cx-bid-preview"><span>{item.bid.player_name || currentPlayer?.name || "Player"}<small>{item.bid.team_key && item.bid.team_key === myTeam ? "Your team" : CITY[item.bid.team_key] || item.bid.display_name || "Bidder"}</small></span><b>{money(item.bid.amount_paise)}</b></div>
                    <p>{item.bid.team_key && item.bid.team_key === myTeam ? "You" : CITY[item.bid.team_key] || item.bid.display_name || "Bidder"} bid <b>{money(item.bid.amount_paise)}</b> for {item.bid.player_name || currentPlayer?.name || "player"}</p>
                    <time>{clock(item.at)}</time>
                  </li>
                ) : (
                  <li key={item.id} className={item.msg.auctionEvent}>
                    <p>{item.msg.message}</p>
                    <time>{clock(item.at)}</time>
                  </li>
                ))}
                {!visibleFeed.length && <li className="empty">Waiting for the first bid.</li>}
              </ul>
            ) : chatPanel}
          </div>
        </aside>
      </div>

      <nav className="cx-dock" aria-label="Auction sections">
        <button className={pane === "auction" ? "on" : ""} onClick={() => setPane("auction")}><Gavel size={19} />Auction</button>
        <button className={pane === "teams" ? "on" : ""} onClick={() => setPane("teams")}><Users size={19} />Teams</button>
        <button className={pane === "feed" ? "on" : ""} onClick={() => setPane("feed")}><MessageCircle size={19} />Activity</button>
      </nav>

      {sheet && (
        <div className="cx-scrim" onClick={() => setSheet(false)}>
          <section className="cx-sheet" role="dialog" aria-modal="true" aria-label="Auction board" onClick={e => e.stopPropagation()}>
            <header className="cx-sheet-head"><h2>Auction board</h2><button className="cx-btn square" onClick={() => setSheet(false)} aria-label="Close"><X size={16} /></button></header>
            <div className="cx-tabs" role="tablist">
              <button role="tab" aria-selected={tab !== "sets"} className={tab !== "sets" ? "on" : ""} onClick={() => setTab("squads")}>Squads &amp; purse</button>
              <button role="tab" aria-selected={tab === "sets"} className={tab === "sets" ? "on" : ""} onClick={() => setTab("sets")}>Sets</button>
            </div>
            <div className="cx-sheet-body cx-scroll">{tab === "sets" ? setsView : squadsView}</div>
          </section>
        </div>
      )}

      {peopleOpen && (
        <div className="cx-scrim" onClick={() => setPeopleOpen(false)}>
          <section className="cx-sheet narrow" role="dialog" aria-modal="true" aria-label="Participants" onClick={e => e.stopPropagation()}>
            <header className="cx-sheet-head"><h2>Participants ({participants.length})</h2><button className="cx-btn square" onClick={() => setPeopleOpen(false)} aria-label="Close"><X size={16} /></button></header>
            <span />
            <div className="cx-sheet-body cx-scroll">
              <ul className="cx-pop-rows">
                {participants.map((p, i) => {
                  const key = p.team_key || p.teamKey;
                  const name = p.display_name || p.displayName || "Participant";
                  return (
                    <li className="cx-person" key={p.participant_id || p.participantId || i} style={{ "--team-color": teamInfo(key)?.color }}>
                      {key ? <TeamChip teamKey={key} /> : <span className="cx-chip plain">{name.charAt(0).toUpperCase()}</span>}
                      <div><b>{name}{(p.is_host || p.isHost) && <Crown size={13} />}</b><small>{key ? teamInfo(key)?.name : "Spectating"}</small></div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        </div>
      )}

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
    <div className={`cx-toast ${kind}`} role="status" aria-live="polite">
      <i />
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
