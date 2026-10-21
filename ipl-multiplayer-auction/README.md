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
The importer preserves original CSV columns in `source_data` JSONB and maps common name/role/base-price columns when detected, including `base_price_lakh` from the supplied CSV. Unknown statistics remain NULL; this does not certify the data as verified. Review source attribution and cutoff before public redistribution.

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
