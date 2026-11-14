'use strict';
const crypto = require('crypto');

const SUITS = ['s', 'h', 'd', 'c'];
const SMALL = 10;
const BIG = 20;
const HAND_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
const START_CHIPS = 1000;

// ---------- Deck (cryptographically secure shuffle) ----------
function newDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ---------- Hand evaluation ----------
// Score = array [category, ...tiebreakers]; compare element by element.
// Categories: 8 straight flush, 7 quads, 6 full house, 5 flush, 4 straight,
// 3 trips, 2 two pair, 1 pair, 0 high card.
function score5(cards) {
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const flush = cards.every((c) => c.s === cards[0].s);
  let straightHigh = 0;
  if (new Set(ranks).size === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks.join() === '14,5,4,3,2') straightHigh = 5; // wheel
  }
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([r, c]) => [c, +r])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const tb = groups.map((g) => g[1]);

  if (straightHigh && flush) return [8, straightHigh];
  if (groups[0][0] === 4) return [7, ...tb];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...tb];
  if (flush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][0] === 3) return [3, ...tb];
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...tb];
  if (groups[0][0] === 2) return [1, ...tb];
  return [0, ...ranks];
}

function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Best 5-card hand out of 7 cards (drop every pair of cards).
function best7(cards) {
  let best = null;
  for (let a = 0; a < cards.length; a++) {
    for (let b = a + 1; b < cards.length; b++) {
      const sc = score5(cards.filter((_, i) => i !== a && i !== b));
      if (!best || cmp(sc, best) > 0) best = sc;
    }
  }
  return best;
}

// ---------- Table ----------
class Table {
  constructor(id) {
    this.id = id;
    this.players = [];
    this.dealerId = null;
    this.stage = 'waiting'; // waiting | preflop | flop | turn | river | showdown
    this.board = [];
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = BIG;
    this.current = -1; // index of the player to act
    this.winners = [];
  }

  addPlayer(id, name, chips = START_CHIPS) {
    const existing = this.players.find((p) => p.id === id);
    if (existing) {
      existing.left = false;
      return existing;
    }
    if (this.players.length >= 9) throw new Error('Table is full');
    // New players sit out (folded) until the next hand starts.
    const p = {
      id, name, chips, hole: [], bet: 0, total: 0,
      folded: true, allIn: false, acted: false, left: false,
    };
    this.players.push(p);
    return p;
  }

  removePlayer(id) {
    const i = this.players.findIndex((p) => p.id === id);
    if (i < 0) return;
    if (this.stage === 'waiting') {
      this.players.splice(i, 1);
      return;
    }
    const p = this.players[i];
    p.left = true; // purged when the next hand starts
    if (!p.folded && this.stage !== 'showdown') {
      const wasCurrent = this.current === i;
      p.folded = true;
      this.afterAction(wasCurrent);
    }
  }

  post(p, amount) {
    const a = Math.min(amount, p.chips);
    p.chips -= a;
    p.bet += a;
    p.total += a;
    if (p.chips === 0) p.allIn = true;
  }

  startHand() {
    this.players = this.players.filter((p) => !p.left && p.chips > 0);
    const n = this.players.length;
    if (n < 2) {
      this.stage = 'waiting';
      return false;
    }
    const prev = this.players.findIndex((p) => p.id === this.dealerId);
    const di = (prev + 1) % n;
    this.dealerId = this.players[di].id;
    this.deck = newDeck();
    this.board = [];
    this.winners = [];
    for (const p of this.players) {
      Object.assign(p, {
        hole: [this.deck.pop(), this.deck.pop()],
        bet: 0, total: 0, folded: false, allIn: false, acted: false,
      });
    }
    const sb = n === 2 ? di : (di + 1) % n; // heads-up: dealer posts small blind
    const bb = (sb + 1) % n;
    this.post(this.players[sb], SMALL);
    this.post(this.players[bb], BIG);
    this.currentBet = BIG;
    this.minRaise = BIG;
    this.stage = 'preflop';
    this.current = this.nextToAct(bb);
    if (this.current === -1) this.nextStage();
    this.turnSeq = (this.turnSeq || 0) + 1;
    return true;
  }

  nextToAct(from) {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (from + i) % n;
      const p = this.players[idx];
      if (!p.folded && !p.allIn) return idx;
    }
    return -1;
  }

  // action: 'fold' | 'check' | 'call' | 'raise'
  // For 'raise', amount is the TOTAL bet for this round ("raise to").
  act(id, action, amount = 0) {
    const p = this.players[this.current];
    if (!p || p.id !== id) throw new Error('Not your turn');
    const toCall = this.currentBet - p.bet;

    switch (action) {
      case 'fold':
        if (toCall > 0) p.folded = true; // folding when you can check is treated as a check
        break;
      case 'check':
        if (toCall > 0) throw new Error('Cannot check, you must call or fold');
        break;
      case 'call':
        this.post(p, toCall);
        break;
      case 'raise': {
        const target = Math.floor(Number(amount));
        const maxTarget = p.bet + p.chips;
        if (!Number.isFinite(target) || target > maxTarget) throw new Error('Invalid amount');
        if (target <= this.currentBet) throw new Error('Raise must exceed the current bet');
        const allIn = target === maxTarget;
        if (target < this.currentBet + this.minRaise && !allIn) throw new Error('Raise too small');
        const raiseBy = target - this.currentBet;
        this.post(p, target - p.bet);
        if (raiseBy >= this.minRaise) this.minRaise = raiseBy;
        this.currentBet = target;
        // Simplification: any raise (even a short all-in) reopens the action.
        for (const o of this.players) if (o !== p) o.acted = false;
        break;
      }
      default:
        throw new Error('Unknown action');
    }
    p.acted = true;
    this.afterAction(true);
  }

  afterAction(advance) {
    this.turnSeq = (this.turnSeq || 0) + 1; // lets the server know the turn moved
    const live = this.players.filter((p) => !p.folded);
    if (live.length === 1) {
      // Everyone else folded: no showdown needed.
      this.stage = 'showdown';
      this.current = -1;
      this.payout();
      return;
    }
    const canAct = live.filter((p) => !p.allIn);
    const settled = canAct.every((p) => p.acted && p.bet === this.currentBet);
    if (settled) this.nextStage();
    else if (advance) this.current = this.nextToAct(this.current);
  }

  nextStage() {
    for (const p of this.players) {
      p.bet = 0;
      p.acted = false;
    }
    this.currentBet = 0;
    this.minRaise = BIG;
    const order = ['preflop', 'flop', 'turn', 'river'];
    const next = order[order.indexOf(this.stage) + 1];
    if (!next) return this.showdown();

    this.deck.pop(); // burn card
    const count = next === 'flop' ? 3 : 1;
    for (let i = 0; i < count; i++) this.board.push(this.deck.pop());
    this.stage = next;

    // If nobody (or only one player) can still bet, run the board out.
    const canAct = this.players.filter((p) => !p.folded && !p.allIn);
    if (canAct.length <= 1) return this.nextStage();
    const di = this.players.findIndex((p) => p.id === this.dealerId);
    this.current = this.nextToAct(di);
  }

  showdown() {
    this.stage = 'showdown';
    this.current = -1;
    for (const p of this.players) {
      if (!p.folded) p.score = best7([...p.hole, ...this.board]);
    }
    this.payout();
  }

  // Builds main pot + side pots from each player's total contribution.
  payout() {
    const levels = [...new Set(this.players.map((p) => p.total).filter((t) => t > 0))].sort((a, b) => a - b);
    let prev = 0;
    for (const level of levels) {
      const contributors = this.players.filter((p) => p.total >= level);
      const amount = (level - prev) * contributors.length;
      prev = level;
      let eligible = contributors.filter((p) => !p.folded);
      // Dead money (every contributor folded, e.g. a player left): live players take it.
      if (!eligible.length) eligible = this.players.filter((p) => !p.folded);

      let winners = eligible;
      if (eligible.length > 1) {
        const top = eligible.reduce((m, p) => (cmp(p.score, m) > 0 ? p.score : m), eligible[0].score);
        winners = eligible.filter((p) => cmp(p.score, top) === 0);
      }
      const share = Math.floor(amount / winners.length);
      for (const w of winners) {
        w.chips += share;
        this.winners.push({ id: w.id, name: w.name, amount: share });
      }
      winners[0].chips += amount - share * winners.length; // odd chip
    }
  }

  // State as seen by one player: other players' hole cards stay hidden.
  viewFor(id) {
    const live = this.players.filter((p) => !p.folded).length;
    const reveal = this.stage === 'showdown' && live > 1;
    return {
      room: this.id,
      stage: this.stage,
      board: this.board,
      pot: this.players.reduce((s, p) => s + p.total, 0),
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      toAct: this.players[this.current] ? this.players[this.current].id : null,
      dealerId: this.dealerId,
      winners: this.winners,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        handName: reveal && !p.folded && p.score ? (p.score[0] === 8 && p.score[1] === 14 ? 'Royal flush' : HAND_NAMES[p.score[0]]) : undefined,
        hole: p.id === id || (reveal && !p.folded) ? p.hole : p.hole.length ? [null, null] : [],
      })),
    };
  }
}

module.exports = { Table, START_CHIPS, best7, score5, cmp };
