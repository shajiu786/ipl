// Game modes. Each mode is a separate player dataset (players.dataset) with its own CSV in /data.
export const MODES = {
  legends: {
    key: 'legends', dataset: 'legends', name: 'IPL Legends Auction',
    tagline: 'Iconic IPL stars from every era in 22 themed sets.',
    csv: 'ipl_auction_players_24_sets.csv'
  },
  mega2026: {
    key: 'mega2026', dataset: 'mega2026', name: 'IPL Mega Auction 2026',
    tagline: 'The real IPL 2026 auction pool: capped and uncapped players with official base prices.',
    csv: 'ipl_mega_auction_2026_players.csv'
  }
};
export const DEFAULT_MODE = 'legends';
export const modeKeys = Object.keys(MODES);
export const modeOfConfig = config => (MODES[config?.mode] ? config.mode : DEFAULT_MODE);
export const datasetOfRoom = room => MODES[modeOfConfig(room?.config)].dataset;
