CREATE TABLE IF NOT EXISTS players (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  nationality TEXT,
  batting_style TEXT,
  bowling_style TEXT,
  photo_url TEXT,
  base_price_paise BIGINT,
  source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_attribution TEXT,
  data_cutoff DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- columns added for photo/stat enrichment and de-duplicated imports (safe to re-run on an existing database)
ALTER TABLE players ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS stats JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE players ADD COLUMN IF NOT EXISTS stats_updated_at TIMESTAMPTZ;
ALTER TABLE players ADD COLUMN IF NOT EXISTS photo_source TEXT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS dataset TEXT NOT NULL DEFAULT 'legends';
CREATE INDEX IF NOT EXISTS players_dataset_idx ON players (dataset);
CREATE INDEX IF NOT EXISTS players_external_id_idx ON players (external_id);
CREATE INDEX IF NOT EXISTS players_name_idx ON players USING GIN (to_tsvector('simple', name));

CREATE TABLE IF NOT EXISTS auction_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  host_participant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  config JSONB NOT NULL DEFAULT '{"openingBidPaise":200000000,"incrementPaise":250000000,"durationSeconds":10}'::jsonb,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS room_participants (
  id BIGSERIAL PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES auction_rooms(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  team_key TEXT,
  is_host BOOLEAN NOT NULL DEFAULT FALSE,
  connected BOOLEAN NOT NULL DEFAULT TRUE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(room_id, participant_id),
  UNIQUE(room_id, team_key)
);
CREATE TABLE IF NOT EXISTS auction_bids (
  id BIGSERIAL PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES auction_rooms(id) ON DELETE CASCADE,
  player_id BIGINT REFERENCES players(id),
  participant_id TEXT NOT NULL,
  team_key TEXT NOT NULL,
  amount_paise BIGINT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS room_chat (
  id BIGSERIAL PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES auction_rooms(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  team_key TEXT,
  message TEXT NOT NULL CHECK (char_length(message) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS room_squad_players (
  id BIGSERIAL PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES auction_rooms(id) ON DELETE CASCADE,
  team_key TEXT NOT NULL,
  player_id BIGINT NOT NULL REFERENCES players(id),
  purchase_price_paise BIGINT NOT NULL,
  UNIQUE(room_id, player_id)
);
CREATE TABLE IF NOT EXISTS playing_xi (
  room_id UUID NOT NULL REFERENCES auction_rooms(id) ON DELETE CASCADE,
  team_key TEXT NOT NULL,
  player_id BIGINT NOT NULL REFERENCES players(id),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 11),
  PRIMARY KEY(room_id, team_key, player_id),
  UNIQUE(room_id, team_key, position)
);
