export const TEAM_LIST = [
  ['csk','Chennai Super Kings'],['mi','Mumbai Indians'],['rcb','Royal Challengers Bengaluru'],
  ['kkr','Kolkata Knight Riders'],['rr','Rajasthan Royals'],['srh','Sunrisers Hyderabad'],
  ['dc','Delhi Capitals'],['pbks','Punjab Kings'],['gt','Gujarat Titans'],['lsg','Lucknow Super Giants']
];
export const TEAM_NAMES = Object.fromEntries(TEAM_LIST);
export const makeCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
export const emptyState = () => ({
  currentPlayerId: null, currentPlayer: null, currentBidPaise: 0, highestBidder: null,
  deadline: null, status: 'waiting', soldCount: 0, unsoldCount: 0, auctionVersion: 1, queue: []
});
export function nextBidAmount(room, state) {
  const cfg = room.config || {};
  return Number(state.currentBidPaise || 0) === 0
    ? Number(cfg.openingBidPaise || 200000000)
    : Number(state.currentBidPaise) + Number(cfg.incrementPaise || 250000000);
}
