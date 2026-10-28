# IPL Multiplayer Auction

Responsive full-stack IPL auction starter built with React + Vite, Express, Socket.IO, and PostgreSQL.

## Included
- Permanent auction workspace with persistent secondary navigation
- Live bid requests and chat via Socket.IO
- Server-side bid validation and serialized room auction state
- Room creation/joining and franchise reservation
- Squads, Playing XI, purse summary and player search endpoints
- PostgreSQL schema and CSV import script for your supplied player dataset
- Vercel frontend and Render backend deployment configuration
- Optional WebRTC voice-chat signaling and browser speech-command UI hooks (voice media is browser-to-browser)

## Project structure
```text
ipl-multiplayer-auction/
  client/       React + Vite frontend
  server/       Express + Socket.IO API
  data/         Your uploaded CSV
  render.yaml
  vercel.json
```

## Requirements
- Node.js 20+
- PostgreSQL database
- npm

## Run locally
1. Create a PostgreSQL database.
2. Copy `server/.env.example` to `server/.env` and set `DATABASE_URL` and `CLIENT_ORIGIN`.
3. In PostgreSQL, run `server/sql/schema.sql`.
4. Import your CSV (see below).
5. In one terminal:
   ```bash
   cd server && npm install && npm run dev
   ```
6. In another terminal:
   ```bash
   cd client && npm install && npm run dev
   ```
7. Open the Vite URL shown in the terminal.

## Import the supplied CSV
The supplied file has 288 rows and these detected columns:
`player_id, set_number, set_name, player_name, role, nationality, age_group, player_tier, base_price_lakh, estimated_auction_value_lakh, duplicate_in_pool, price_note`

From the project root:
```bash
cd server
npm install
npm run import:csv -- ../data/ipl_auction_players_24_sets.csv
```
The importer preserves original CSV columns in `source_data` JSONB and maps common name/role/base-price columns when detected, including `base_price_lakh` from the supplied CSV. Statistics and photos are filled by `npm run enrich:players` (see below); this does not certify the data as verified. Review source attribution and cutoff before public redistribution.

## Game modes
Pick a mode on the home screen when creating a room (joiners follow the room's mode automatically).

| Mode | Dataset file | Players |
|---|---|---|
| **IPL Legends Auction** (the original game) | `data/ipl_auction_players_24_sets.csv` | 243 unique |
| **IPL Mega Auction 2026** | `data/ipl_mega_auction_2026_players.csv` | 356 |

Load both datasets into the same database (each is stored under its own `dataset`, so they never mix):
```bash
cd server
npm run db:schema
npm run import:csv -- ../data/ipl_auction_players_24_sets.csv
npm run import:csv -- ../data/ipl_mega_auction_2026_players.csv
npm run enrich:players
```
Existing players in your database automatically become the *Legends* dataset.

**About the Mega 2026 data.** The real IPL 2026 auction (16 Dec 2025, Abu Dhabi) was a *mini* auction, not a mega auction. The mode keeps the name you chose, uses that auction's player pool and official base prices, and starts every franchise from scratch (120 Cr, 25 players) like a mega auction. Names, nationality, capped/uncapped status and base prices come from the BCCI/IPL player list as reported by Wisden and NewsX. Sets 1-10 follow the official auction sets; later sets follow the official list order. Role is `PLAYER` where the role could not be established (about 50 uncapped players): `npm run enrich:players` fills those in from IPL stats where a player has an IPL record. The list holds 356 of the roughly 359-369 players that were in the pool, so a few late additions may be missing. Correct or add rows in the CSV and re-run the import any time.

## Player photos and stats (fetch + update)
Photos come from each player's Wikipedia page; career IPL stats (matches, runs, average, strike rate, wickets, economy) are computed from the free Cricsheet ball-by-ball archive. Neither is in the CSV, so fetch them once after importing:
```bash
cd server
npm run enrich:players              # only players missing a photo or stats
npm run enrich:players -- --force   # refresh everything (e.g. at the start of a new season)
```
- The script prints players it could not match. Add them to `data/player_aliases.json` as `{ "Auction name": "Cricsheet name" }` and run it again with `-- --stats`.
- No shell on your host? Set `AUTO_ENRICH=1` on the server and it fetches missing photos/stats in the background on boot.
- A missing photo is also fetched live when that player comes up in an auction.
- Wikimedia images keep their own licences (`players.photo_source` records the page). Cricsheet data is ODC-BY: credit https://cricsheet.org. Set `WIKI_USER_AGENT` to a string with your contact details.

## Repeated players
The supplied CSV lists 45 players a second time in later sets (`duplicate_in_pool=True`), so sets 23 and 24 are entirely repeats and the real pool is 243 players in 22 sets. The importer now keeps one row per person and can be re-run safely. If your database was already imported (possibly twice):
```bash
cd server
npm run db:schema                    # adds the new columns
npm run dedupe:players               # preview
npm run dedupe:players -- --apply    # clean up
```
The auction also skips any player whose name was already auctioned, so a room can never repeat someone even if the table still has duplicates.

## Auction rules enforced by the server
- A franchise cannot bid once it holds 25 players or when its remaining purse (120 Cr start) is below the next bid.
- Bidding opens at the player's base price. A bid sent at an out-of-date price is refused instead of silently going higher.
- Host Next starts the next player immediately; sets are auctioned one after another and the current set is shown live.

## Tests
```bash
cd server && npm install && npm test
```
Includes a full simulated auction (243 lots) against an in-memory database stand-in.

## Environment variables
See `server/.env.example` and `client/.env.example`. Never commit `.env` files or production secrets.

## Deploy
### Backend (Render)
- Create a PostgreSQL database and copy its connection URL.
- Create a Render Web Service from this repository, root directory `server`.
- Build command: `npm install`
- Start command: `npm start`
- Set `DATABASE_URL`, `CLIENT_ORIGIN` (your Vercel URL), and `SESSION_SECRET`.
- Run `npm run db:schema` once from the Render shell or apply `server/sql/schema.sql` with your database client.
- To import players, run `npm run import:csv -- ../data/ipl_auction_players_24_sets.csv` from the server root after uploading the CSV into the deployment environment, or import locally into the hosted database.

### Frontend (Vercel)
- Import this repository in Vercel and set Root Directory to `client`.
- Set `VITE_API_URL` to your Render service URL (no trailing slash).
- Set `VITE_SOCKET_URL` to your Render service URL (no trailing slash).
- Deploy.

## Important implementation notes
- Auction actions are validated on the server. Monetary values are stored as integer paise.
- This is a functional starter, not a hardened production tournament platform. Before public launch, add a proper identity provider, rate limiting, audit logging, and production security review.
- Voice signaling is provided; full WebRTC peer connection orchestration may need adapting for your chosen room topology and expected participant count.
- The included player CSV is user-provided. The app does not claim the records are official or verified.
