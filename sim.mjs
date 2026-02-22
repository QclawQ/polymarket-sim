#!/usr/bin/env node
/**
 * Polymarket Paper Trading Simulator - Multi-Strategy CLI
 *
 * Commands:
 *   bet      --market <slug> --side YES|NO --amount <usd> [--strategy <name>]
 *   sell     --bet-id <id> [--price <0-1>]
 *   resolve  — settle resolved markets
 *   status   [--strategy <name>] — show portfolio & open positions
 *   leaderboard — rank all strategies by ROI
 *   refresh  — update current prices for all open bets
 *   search   <query> — search polymarket markets
 *   reset    — reset all strategies to $2,000
 *   snapshot — capture current market prices & volumes
 *   scan     — detect anomalous price/volume moves between snapshots
 *   auto-bet — run all 5 strategies simultaneously
 *   fetch-history — fetch resolved markets from Polymarket API
 *   backtest — run backtest on historical data with all 5 strategies
 *   case-study — run case study backtest on 5 curated resolved markets
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, 'data');
const PORTFOLIO_FILE = join(DATA_DIR, 'portfolio.json');
const BETS_FILE = join(DATA_DIR, 'bets.json');
const HISTORY_FILE = join(DATA_DIR, 'history.json');
const SNAPSHOTS_DIR = join(DATA_DIR, 'snapshots');
const SIGNALS_FILE = join(DATA_DIR, 'signals.json');
const HISTORICAL_MARKETS_FILE = join(DATA_DIR, 'historical-markets.json');
const BACKTEST_RESULTS_FILE = join(DATA_DIR, 'backtest-results.json');
const CASE_STUDIES_DIR = join(DATA_DIR, 'case-studies');
const CASE_STUDIES_FILE = join(CASE_STUDIES_DIR, 'markets.json');
const CASE_STUDIES_RESULTS_FILE = join(CASE_STUDIES_DIR, 'results.json');

const POLYMARKET_CLI = '/Users/quen/.openclaw/workspace/skills/polymarket-odds/polymarket.mjs';
const GAMMA_API = 'https://gamma-api.polymarket.com';

const STRATEGY_NAMES = ['momentum', 'contrarian', 'status_quo', 'cheap_contracts', 'arb'];
const INITIAL_PER_STRATEGY = 2000;
const TOTAL_INITIAL = INITIAL_PER_STRATEGY * STRATEGY_NAMES.length;

// ─── Auto-bet limits ─────────────────────────────────────────────
const MAX_BETS_PER_STRATEGY = 10;
const MIN_BET_AMOUNT = 50;           // $50 minimum for most strategies
const MIN_BET_CHEAP_CONTRACTS = 20;  // $20 minimum for cheap_contracts

// Sports / non-political market filter
const SPORTS_KEYWORDS = [
  // Sports terms
  'KO', 'TKO', 'submission', 'goal scorer', 'win by',
  'Rookie Card', 'seed in NCAA', 'fight',
  // Over/under player stats
  'Points', 'Rebounds', 'Assists', 'O/U',
  // Leagues & organizations
  'UFC', 'FIFA', 'NFL', 'NBA', 'NHL', 'EPL', 'MLS',
  'Ligue 1', 'Serie A', 'La Liga', 'Bundesliga',
  // Team markers
  ' FC', 'F.C.',
];

// Case-insensitive regex built from keywords (word-boundary where appropriate)
const SPORTS_RE = new RegExp(
  SPORTS_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i'
);

// Additional heuristic: "X vs. Y" in a sports-like context
const VS_SPORTS_RE = /\bvs\.?\s/i;

function isSportsMarket(title) {
  if (SPORTS_RE.test(title)) return true;
  // "vs." only counts as sports if title also contains common sport cues
  if (VS_SPORTS_RE.test(title)) {
    const sportsCues = /\b(game|match|round|bout|fight|winner|finals?|playoffs?|series|championship|cup|league|season|draft|roster|coach|player|team|score|seed|bracket)\b/i;
    if (sportsCues.test(title)) return true;
  }
  return false;
}

// ─── Data helpers ────────────────────────────────────────────────

function loadJSON(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8'));
}

function saveJSON(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function loadPortfolio() {
  const p = loadJSON(PORTFOLIO_FILE);
  if (p && p.strategies) return p; // new format
  // Migration: create new format
  return createFreshPortfolio();
}

function createFreshPortfolio() {
  const strategies = {};
  for (const name of STRATEGY_NAMES) {
    strategies[name] = {
      cash: INITIAL_PER_STRATEGY,
      initialCash: INITIAL_PER_STRATEGY,
      equityCurve: [{ date: today(), equity: INITIAL_PER_STRATEGY }],
    };
  }
  return {
    strategies,
    totalInitial: TOTAL_INITIAL,
    createdAt: new Date().toISOString(),
  };
}

function loadBets() {
  return loadJSON(BETS_FILE) || [];
}

function loadHistory() {
  return loadJSON(HISTORY_FILE) || [];
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── Polymarket API helpers ──────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

async function fetchMarketBySlug(slug) {
  const url = `${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`;
  const markets = await fetchJSON(url);
  if (markets && markets.length > 0) return markets[0];
  try {
    return await fetchJSON(`${GAMMA_API}/markets/${slug}`);
  } catch {
    return null;
  }
}

function parseOutcomes(m) {
  try {
    const outcomes = JSON.parse(m.outcomes);
    const prices = JSON.parse(m.outcomePrices);
    return outcomes.map((o, i) => ({
      name: o,
      price: parseFloat(prices[i]),
    }));
  } catch {
    return [];
  }
}

function getPrice(market, side) {
  const outcomes = parseOutcomes(market);
  const match = outcomes.find(o => o.name.toUpperCase() === side.toUpperCase());
  return match ? match.price : null;
}

function getYesNoPrice(market) {
  const outcomes = parseOutcomes(market);
  const yes = outcomes.find(o => o.name.toUpperCase() === 'YES');
  const no = outcomes.find(o => o.name.toUpperCase() === 'NO');
  return { yesPrice: yes?.price ?? null, noPrice: no?.price ?? null };
}

// ─── Update equity curve per strategy ────────────────────────────

function updateStrategyCurve(portfolio, bets, strategyName) {
  const strat = portfolio.strategies[strategyName];
  if (!strat) return;
  const stratBets = bets.filter(b => b.strategy === strategyName && b.status === 'open');
  const openValue = stratBets.reduce((sum, b) => {
    const currentPrice = b.currentPrice || b.entryPrice;
    return sum + b.shares * currentPrice;
  }, 0);
  const totalEquity = parseFloat((strat.cash + openValue).toFixed(2));
  const d = today();
  const curve = strat.equityCurve || [];
  const last = curve[curve.length - 1];
  if (last && last.date === d) {
    last.equity = totalEquity;
  } else {
    curve.push({ date: d, equity: totalEquity });
  }
  strat.equityCurve = curve;
}

function updateAllCurves(portfolio, bets) {
  for (const name of STRATEGY_NAMES) {
    updateStrategyCurve(portfolio, bets, name);
  }
}

// ─── Strategy computations ───────────────────────────────────────

function computeStrategyStats(strategyName, portfolio, bets, history) {
  const strat = portfolio.strategies[strategyName];
  if (!strat) return null;
  const openBets = bets.filter(b => b.strategy === strategyName && b.status === 'open');
  const closedBets = history.filter(h => h.strategy === strategyName);

  const openValue = openBets.reduce((s, b) => s + b.shares * (b.currentPrice || b.entryPrice), 0);
  const openCost = openBets.reduce((s, b) => s + b.cost, 0);
  const unrealizedPnl = openValue - openCost;
  const realizedPnl = closedBets.reduce((s, h) => s + (h.pnl || 0), 0);
  const totalPnl = realizedPnl + unrealizedPnl;
  const totalEquity = strat.cash + openValue;
  const roi = ((totalPnl / strat.initialCash) * 100);
  const wins = closedBets.filter(h => (h.pnl || 0) > 0).length;
  const losses = closedBets.filter(h => (h.pnl || 0) <= 0).length;
  const winRate = closedBets.length > 0 ? (wins / closedBets.length * 100) : null;
  const trades = closedBets.length;

  // Sharpe from equity curve
  const curve = strat.equityCurve || [];
  let sharpe = null;
  if (curve.length >= 3) {
    const returns = [];
    for (let i = 1; i < curve.length; i++) {
      returns.push((curve[i].equity - curve[i - 1].equity) / curve[i - 1].equity);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const std = Math.sqrt(returns.reduce((a, r) => a + Math.pow(r - mean, 2), 0) / returns.length);
    sharpe = std > 0 ? parseFloat((mean / std * Math.sqrt(252)).toFixed(2)) : null;
  }

  return {
    name: strategyName,
    cash: strat.cash,
    initialCash: strat.initialCash,
    totalEquity,
    openValue,
    unrealizedPnl,
    realizedPnl,
    totalPnl,
    roi,
    wins,
    losses,
    winRate,
    trades,
    sharpe,
    openPositions: openBets.length,
    equityCurve: curve,
  };
}

// ─── Strategy Signal Engines ─────────────────────────────────────

function runMomentumStrategy(signals) {
  // Price spike >10% → follow direction
  // Filter sports, sort by abs price delta, top 10
  return signals
    .filter(s => s.isPriceSpike && !isSportsMarket(s.title))
    .sort((a, b) => Math.abs(b.priceDelta) - Math.abs(a.priceDelta))
    .slice(0, MAX_BETS_PER_STRATEGY)
    .map(s => ({
      strategy: 'momentum',
      slug: s.slug,
      title: s.title,
      side: s.direction === 'UP' ? 'YES' : 'NO',
      price: s.direction === 'UP' ? s.newPrice : (1 - s.newPrice),
      sizePct: 0.05, // 5% of strategy cash
      reason: `momentum: price ${(s.oldPrice * 100).toFixed(1)}¢ → ${(s.newPrice * 100).toFixed(1)}¢ (${s.pricePct > 0 ? '+' : ''}${s.pricePct}%)`,
      signal: s,
    }));
}

function runContrarianStrategy(signals) {
  // Price spike >10% → OPPOSITE direction (fade the move)
  // Filter sports, sort by abs price delta, top 10
  return signals
    .filter(s => s.isPriceSpike && !isSportsMarket(s.title))
    .sort((a, b) => Math.abs(b.priceDelta) - Math.abs(a.priceDelta))
    .slice(0, MAX_BETS_PER_STRATEGY)
    .map(s => ({
      strategy: 'contrarian',
      slug: s.slug,
      title: s.title,
      side: s.direction === 'UP' ? 'NO' : 'YES', // opposite of momentum
      price: s.direction === 'UP' ? (1 - s.newPrice) : s.newPrice,
      sizePct: 0.05,
      reason: `contrarian: fading ${s.direction} move (${(s.oldPrice * 100).toFixed(1)}¢ → ${(s.newPrice * 100).toFixed(1)}¢)`,
      signal: s,
    }));
}

function runStatusQuoStrategy(snapshotMarkets) {
  // Markets with "Will" in title, price 0.10-0.40 → buy NO (bet it won't happen)
  // Filter sports, sort by conviction (lower YES price = more confident NO), top 10
  const willPatterns = /\b(will|going to|expected to|set to|likely to|plan to|could|may)\b/i;
  return snapshotMarkets
    .filter(m => {
      if (isSportsMarket(m.title)) return false;
      if (!willPatterns.test(m.title)) return false;
      if (m.price < 0.10 || m.price > 0.40) return false;
      return true;
    })
    .sort((a, b) => a.price - b.price) // lowest YES price first (strongest NO signal)
    .slice(0, MAX_BETS_PER_STRATEGY)
    .map(m => ({
      strategy: 'status_quo',
      slug: m.slug,
      title: m.title,
      side: 'NO',
      price: 1 - m.price, // NO price
      sizePct: 0.05,
      reason: `status quo: "${m.title}" at ${(m.price * 100).toFixed(1)}¢ YES — betting NO (unlikely to happen)`,
      signal: null,
    }));
}

function runCheapContractsStrategy(snapshotMarkets) {
  // Price < $0.05 → buy YES (lottery ticket)
  // Filter sports, sort by cheapest first, top 10
  return snapshotMarkets
    .filter(m => m.price > 0 && m.price < 0.05 && !isSportsMarket(m.title))
    .sort((a, b) => a.price - b.price)
    .slice(0, MAX_BETS_PER_STRATEGY)
    .map(m => ({
      strategy: 'cheap_contracts',
      slug: m.slug,
      title: m.title,
      side: 'YES',
      price: m.price,
      sizePct: 0.01, // only 1% per bet — lottery tickets
      reason: `cheap contract: ${(m.price * 100).toFixed(1)}¢ — lottery ticket bet`,
      signal: null,
    }));
}

function runArbStrategy(snapshotMarkets) {
  // YES + NO < $0.98 → buy both
  return snapshotMarkets
    .filter(m => {
      if (m.price === null) return false;
      const noPrice = 1 - m.price; // simplified: for 2-outcome markets
      // We look for actual combined price < 0.98 — in 2-outcome markets this is always 1.00
      // Real arb happens when YES price + NO price (from orderbook) < 1.00
      // For the sim, we check if any market shows combined < 0.98
      const combined = m.price + noPrice; // this is always 1 in gamma API
      // Instead, look for markets where the implied odds suggest a gap
      // We'll use a proxy: if we can buy YES at price X and NO at price Y where X+Y < 0.98
      return false; // Will use event-level arb below
    })
    .map(m => null)
    .filter(Boolean);
}

// Event-level arb: check markets within same event where YES prices don't sum to ~1
async function findArbOpportunities(snapshotMarkets) {
  // For simple binary markets, YES + NO = 1.00 by definition in the API
  // Real arb: look across related markets or check CLOB spread
  // For the sim, we'll look for markets where liquidity is low and there may be pricing gaps
  // We simulate by finding pairs where YES price is notably low
  const arbs = [];
  for (const m of snapshotMarkets) {
    if (m.price === null) continue;
    const noPrice = 1 - m.price;
    // In real life the CLOB spread creates arb opportunities
    // Simulate: if YES+NO in displayed price < 0.98 (which won't happen with gamma API since they sum to 1)
    // Instead, look for extremely thin markets where we can get better fills
    // For simulation purposes, flag markets where price is between 0.48-0.52 (nearly 50/50 = uncertain)
    // and liquidity is low — these are where real arbs would appear
    if (m.liquidity && m.liquidity < 5000 && m.price > 0.45 && m.price < 0.55 && !isSportsMarket(m.title)) {
      arbs.push({
        strategy: 'arb',
        slug: m.slug,
        title: m.title,
        side: 'BOTH', // special: buy both YES and NO
        yesPrice: m.price,
        noPrice: noPrice,
        price: m.price, // for cost calculation, we'll use the lower side
        sizePct: 0.03,
        reason: `arb opportunity: YES=${(m.price * 100).toFixed(1)}¢ NO=${(noPrice * 100).toFixed(1)}¢, low liquidity ($${(m.liquidity || 0).toFixed(0)})`,
        signal: null,
      });
    }
  }
  return arbs.slice(0, 3);
}

// ─── Commands ────────────────────────────────────────────────────

async function cmdBet(args) {
  const market = argVal(args, '--market');
  const side = (argVal(args, '--side') || '').toUpperCase();
  const amount = parseFloat(argVal(args, '--amount'));
  const strategy = argVal(args, '--strategy') || 'momentum';

  if (!market || !side || isNaN(amount)) {
    console.log('Usage: sim.mjs bet --market <slug> --side YES|NO --amount <usd> [--strategy <name>]');
    process.exit(1);
  }
  if (!['YES', 'NO'].includes(side)) {
    console.error('Side must be YES or NO');
    process.exit(1);
  }
  if (!STRATEGY_NAMES.includes(strategy)) {
    console.error(`Invalid strategy: ${strategy}. Choose from: ${STRATEGY_NAMES.join(', ')}`);
    process.exit(1);
  }

  const mkt = await fetchMarketBySlug(market);
  if (!mkt) {
    console.error(`Market not found: ${market}`);
    process.exit(1);
  }

  const price = getPrice(mkt, side);
  if (price === null || price <= 0 || price >= 1) {
    console.error(`Cannot get valid price for ${side} on this market (price=${price})`);
    process.exit(1);
  }

  const portfolio = loadPortfolio();
  const strat = portfolio.strategies[strategy];
  if (amount > strat.cash) {
    console.error(`Insufficient balance for [${strategy}]. Have $${strat.cash.toFixed(2)}, need $${amount.toFixed(2)}`);
    process.exit(1);
  }

  const shares = parseFloat((amount / price).toFixed(4));
  const cost = parseFloat(amount.toFixed(2));

  const bet = {
    id: genId(),
    strategy,
    marketSlug: mkt.slug || market,
    marketId: mkt.id || mkt.condition_id || null,
    question: mkt.question,
    side,
    entryPrice: price,
    currentPrice: price,
    shares,
    cost,
    openedAt: new Date().toISOString(),
    status: 'open',
    reason: `manual bet via CLI`,
  };

  const bets = loadBets();
  bets.push(bet);
  strat.cash = parseFloat((strat.cash - cost).toFixed(2));
  updateAllCurves(portfolio, bets);
  saveJSON(BETS_FILE, bets);
  saveJSON(PORTFOLIO_FILE, portfolio);

  console.log(`✅ BET PLACED [${strategy}]`);
  console.log(`   ${bet.question}`);
  console.log(`   Side: ${side} @ ${(price * 100).toFixed(1)}¢`);
  console.log(`   Shares: ${shares.toFixed(2)} | Cost: $${cost.toFixed(2)}`);
  console.log(`   Bet ID: ${bet.id}`);
  console.log(`   [${strategy}] Balance: $${strat.cash.toFixed(2)}`);
}

async function cmdSell(args) {
  const betId = argVal(args, '--bet-id');
  const manualPrice = argVal(args, '--price');

  if (!betId) {
    console.log('Usage: sim.mjs sell --bet-id <id> [--price <0-1>]');
    process.exit(1);
  }

  const bets = loadBets();
  const idx = bets.findIndex(b => b.id === betId);
  if (idx === -1) {
    console.error(`Bet not found: ${betId}`);
    process.exit(1);
  }

  const bet = bets[idx];
  const strategy = bet.strategy || 'momentum';
  let exitPrice;

  if (manualPrice !== undefined) {
    exitPrice = parseFloat(manualPrice);
  } else {
    const mkt = await fetchMarketBySlug(bet.marketSlug);
    if (!mkt) {
      console.error(`Cannot fetch market for price. Use --price <0-1> to specify manually.`);
      process.exit(1);
    }
    exitPrice = getPrice(mkt, bet.side);
    if (exitPrice === null) {
      console.error(`Cannot get price. Use --price <0-1> to specify.`);
      process.exit(1);
    }
  }

  const proceeds = parseFloat((bet.shares * exitPrice).toFixed(2));
  const pnl = parseFloat((proceeds - bet.cost).toFixed(2));

  const closedBet = {
    ...bet,
    exitPrice,
    proceeds,
    pnl,
    closedAt: new Date().toISOString(),
    status: 'sold',
  };

  bets.splice(idx, 1);
  const history = loadHistory();
  history.push(closedBet);

  const portfolio = loadPortfolio();
  portfolio.strategies[strategy].cash = parseFloat((portfolio.strategies[strategy].cash + proceeds).toFixed(2));
  updateAllCurves(portfolio, bets);
  saveJSON(BETS_FILE, bets);
  saveJSON(HISTORY_FILE, history);
  saveJSON(PORTFOLIO_FILE, portfolio);

  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  console.log(`💰 BET SOLD [${strategy}]`);
  console.log(`   ${closedBet.question}`);
  console.log(`   ${bet.side}: ${(bet.entryPrice * 100).toFixed(1)}¢ → ${(exitPrice * 100).toFixed(1)}¢`);
  console.log(`   P&L: ${pnlStr}`);
  console.log(`   [${strategy}] Balance: $${portfolio.strategies[strategy].cash.toFixed(2)}`);
}

async function cmdResolve() {
  const bets = loadBets();
  if (bets.length === 0) {
    console.log('No open bets to resolve.');
    return;
  }

  const portfolio = loadPortfolio();
  const history = loadHistory();
  let resolved = 0;

  for (let i = bets.length - 1; i >= 0; i--) {
    const bet = bets[i];
    const strategy = bet.strategy || 'momentum';
    let mkt;
    try {
      mkt = await fetchMarketBySlug(bet.marketSlug);
    } catch { continue; }
    if (!mkt) continue;

    if (mkt.resolved || mkt.closed) {
      let exitPrice;
      const resolutionOutcome = (mkt.resolution || '').toUpperCase();

      if (resolutionOutcome === bet.side) {
        exitPrice = 1.0;
      } else if (resolutionOutcome && resolutionOutcome !== bet.side) {
        exitPrice = 0.0;
      } else if (mkt.closed && !mkt.resolved) {
        continue;
      } else {
        const price = getPrice(mkt, bet.side);
        if (price !== null && (price >= 0.99 || price <= 0.01)) {
          exitPrice = price >= 0.99 ? 1.0 : 0.0;
        } else {
          continue;
        }
      }

      const proceeds = parseFloat((bet.shares * exitPrice).toFixed(2));
      const pnl = parseFloat((proceeds - bet.cost).toFixed(2));

      const closedBet = {
        ...bet,
        exitPrice,
        proceeds,
        pnl,
        closedAt: new Date().toISOString(),
        status: exitPrice === 1.0 ? 'won' : 'lost',
      };

      bets.splice(i, 1);
      history.push(closedBet);
      portfolio.strategies[strategy].cash = parseFloat((portfolio.strategies[strategy].cash + proceeds).toFixed(2));
      resolved++;

      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      console.log(`${exitPrice === 1.0 ? '🏆' : '❌'} [${strategy}] ${closedBet.question}`);
      console.log(`   ${closedBet.status.toUpperCase()} | P&L: ${pnlStr}`);
    }
  }

  updateAllCurves(portfolio, bets);
  saveJSON(BETS_FILE, bets);
  saveJSON(HISTORY_FILE, history);
  saveJSON(PORTFOLIO_FILE, portfolio);

  if (resolved === 0) {
    console.log('No markets have resolved yet.');
  } else {
    console.log(`\nResolved ${resolved} bet(s).`);
    printStrategyBalances(portfolio);
  }
}

async function cmdRefresh() {
  const bets = loadBets();
  if (bets.length === 0) {
    console.log('No open bets.');
    return;
  }

  const portfolio = loadPortfolio();
  let updated = 0;

  for (const bet of bets) {
    try {
      const mkt = await fetchMarketBySlug(bet.marketSlug);
      if (!mkt) continue;
      const price = getPrice(mkt, bet.side);
      if (price !== null) {
        bet.currentPrice = price;
        updated++;
      }
    } catch { /* skip */ }
  }

  updateAllCurves(portfolio, bets);
  saveJSON(BETS_FILE, bets);
  saveJSON(PORTFOLIO_FILE, portfolio);
  console.log(`Refreshed ${updated}/${bets.length} positions.`);
  printPositions(bets);
}

function cmdStatus(args) {
  const filterStrategy = argVal(args, '--strategy');
  const portfolio = loadPortfolio();
  const bets = loadBets();
  const history = loadHistory();

  if (filterStrategy) {
    if (!STRATEGY_NAMES.includes(filterStrategy)) {
      console.error(`Unknown strategy: ${filterStrategy}. Options: ${STRATEGY_NAMES.join(', ')}`);
      process.exit(1);
    }
    printSingleStrategyStatus(filterStrategy, portfolio, bets, history);
    return;
  }

  // Overview
  let totalCash = 0, totalOpenValue = 0, totalRealizedPnl = 0;
  for (const name of STRATEGY_NAMES) {
    const stats = computeStrategyStats(name, portfolio, bets, history);
    totalCash += stats.cash;
    totalOpenValue += stats.openValue;
    totalRealizedPnl += stats.realizedPnl;
  }
  const totalEquity = totalCash + totalOpenValue;
  const totalUnrealizedPnl = totalOpenValue - bets.filter(b => b.status === 'open').reduce((s, b) => s + b.cost, 0);
  const totalPnl = totalRealizedPnl + totalUnrealizedPnl;
  const totalRoi = ((totalPnl / TOTAL_INITIAL) * 100).toFixed(2);
  const allClosed = history;
  const wins = allClosed.filter(h => (h.pnl || 0) > 0).length;
  const winRate = allClosed.length > 0 ? (wins / allClosed.length * 100).toFixed(1) : '—';

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║   POLYMARKET SIM — MULTI-STRATEGY OVERVIEW   ║`);
  console.log(`╠══════════════════════════════════════════════╣`);
  console.log(`║  Total Equity:     $${totalEquity.toFixed(2).padStart(10)}            ║`);
  console.log(`║  Total Cash:       $${totalCash.toFixed(2).padStart(10)}            ║`);
  console.log(`║  Open Positions:   $${totalOpenValue.toFixed(2).padStart(10)}            ║`);
  console.log(`║  Total P&L:        ${fmtPnl(totalPnl).padStart(12)}            ║`);
  console.log(`║  ROI:              ${(totalRoi + '%').padStart(12)}            ║`);
  console.log(`║  Win Rate:         ${(winRate + (winRate === '—' ? '' : '%')).padStart(12)}            ║`);
  console.log(`║  Total Trades:     ${(allClosed.length + '').padStart(12)}            ║`);
  console.log(`║  Open Bets:        ${(bets.filter(b => b.status === 'open').length + '').padStart(12)}            ║`);
  console.log(`╚══════════════════════════════════════════════╝`);

  console.log('\n📊 Strategy Breakdown:');
  console.log('─'.repeat(80));
  console.log(`${'Strategy'.padEnd(16)} ${'Equity'.padStart(10)} ${'Cash'.padStart(10)} ${'P&L'.padStart(10)} ${'ROI%'.padStart(8)} ${'W/L'.padStart(8)} ${'Open'.padStart(5)}`);
  console.log('─'.repeat(80));

  for (const name of STRATEGY_NAMES) {
    const s = computeStrategyStats(name, portfolio, bets, history);
    const wl = s.trades > 0 ? `${s.wins}/${s.losses}` : '—';
    console.log(
      `${name.padEnd(16)} $${s.totalEquity.toFixed(2).padStart(9)} $${s.cash.toFixed(2).padStart(9)} ${fmtPnl(s.totalPnl).padStart(10)} ${s.roi.toFixed(1).padStart(7)}% ${wl.padStart(8)} ${(s.openPositions + '').padStart(5)}`
    );
  }
  console.log('─'.repeat(80));

  const openBets = bets.filter(b => b.status === 'open');
  if (openBets.length > 0) {
    console.log('\n📋 All Open Positions:');
    printPositions(openBets);
  }
}

function printSingleStrategyStatus(strategyName, portfolio, bets, history) {
  const s = computeStrategyStats(strategyName, portfolio, bets, history);
  const stratBets = bets.filter(b => b.strategy === strategyName && b.status === 'open');
  const stratHistory = history.filter(h => h.strategy === strategyName);

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  STRATEGY: ${strategyName.toUpperCase().padEnd(29)}║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Cash:             $${s.cash.toFixed(2).padStart(10)}          ║`);
  console.log(`║  Open Value:       $${s.openValue.toFixed(2).padStart(10)}          ║`);
  console.log(`║  Total Equity:     $${s.totalEquity.toFixed(2).padStart(10)}          ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Unrealized P&L:   ${fmtPnl(s.unrealizedPnl).padStart(12)}          ║`);
  console.log(`║  Realized P&L:     ${fmtPnl(s.realizedPnl).padStart(12)}          ║`);
  console.log(`║  Total P&L:        ${fmtPnl(s.totalPnl).padStart(12)}          ║`);
  console.log(`║  ROI:              ${(s.roi.toFixed(2) + '%').padStart(12)}          ║`);
  console.log(`║  Win Rate:         ${(s.winRate !== null ? s.winRate.toFixed(1) + '%' : '—').padStart(12)}          ║`);
  console.log(`║  Sharpe:           ${(s.sharpe !== null ? s.sharpe.toFixed(2) : '—').padStart(12)}          ║`);
  console.log(`║  Trades:           ${(s.trades + '').padStart(12)}          ║`);
  console.log(`╚══════════════════════════════════════════╝`);

  if (stratBets.length > 0) {
    console.log('\n📊 Open Positions:');
    printPositions(stratBets);
  }

  if (stratHistory.length > 0) {
    console.log('\n📜 Recent History (last 5):');
    for (const h of stratHistory.slice(-5).reverse()) {
      const icon = h.status === 'won' ? '🏆' : h.status === 'lost' ? '❌' : '💰';
      console.log(`  ${icon} ${h.question}`);
      console.log(`     ${h.side} ${(h.entryPrice * 100).toFixed(1)}¢ → ${(h.exitPrice * 100).toFixed(1)}¢ | ${fmtPnl(h.pnl)}`);
    }
  }
}

function cmdLeaderboard() {
  const portfolio = loadPortfolio();
  const bets = loadBets();
  const history = loadHistory();

  const stats = STRATEGY_NAMES.map(name => computeStrategyStats(name, portfolio, bets, history));
  stats.sort((a, b) => b.roi - a.roi);

  console.log(`\n🏆 STRATEGY LEADERBOARD`);
  console.log('═'.repeat(90));
  console.log(`${'#'.padStart(3)} ${'Strategy'.padEnd(18)} ${'Equity'.padStart(10)} ${'P&L'.padStart(10)} ${'ROI%'.padStart(8)} ${'Win%'.padStart(7)} ${'Sharpe'.padStart(7)} ${'Trades'.padStart(7)} ${'Open'.padStart(5)}`);
  console.log('─'.repeat(90));

  stats.forEach((s, i) => {
    const rank = i === 0 ? '🏆' : `#${i + 1}`;
    const winStr = s.winRate !== null ? s.winRate.toFixed(1) : '—';
    const sharpeStr = s.sharpe !== null ? s.sharpe.toFixed(2) : '—';
    console.log(
      `${rank.padStart(3)} ${s.name.padEnd(18)} $${s.totalEquity.toFixed(2).padStart(9)} ${fmtPnl(s.totalPnl).padStart(10)} ${s.roi.toFixed(1).padStart(7)}% ${winStr.padStart(6)}% ${sharpeStr.padStart(7)} ${(s.trades + '').padStart(7)} ${(s.openPositions + '').padStart(5)}`
    );
  });
  console.log('═'.repeat(90));
}

function printPositions(bets) {
  for (const b of bets) {
    const currentVal = b.shares * (b.currentPrice || b.entryPrice);
    const pnl = currentVal - b.cost;
    const pnlPct = ((pnl / b.cost) * 100).toFixed(1);
    const stratTag = b.strategy ? `[${b.strategy}]` : '';
    console.log(`  • ${stratTag} ${b.question || b.marketSlug}`);
    console.log(`    ${b.side} @ ${(b.entryPrice * 100).toFixed(1)}¢ → ${((b.currentPrice || b.entryPrice) * 100).toFixed(1)}¢ | ${b.shares.toFixed(2)} shares | ${fmtPnl(pnl)} (${pnlPct}%) | ID: ${b.id}`);
  }
}

function printStrategyBalances(portfolio) {
  console.log('\n💰 Strategy Balances:');
  for (const name of STRATEGY_NAMES) {
    const s = portfolio.strategies[name];
    console.log(`  ${name.padEnd(16)} $${s.cash.toFixed(2)}`);
  }
}

function fmtPnl(v) {
  return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
}

async function cmdSearch(args) {
  const query = args.join(' ');
  if (!query) {
    console.log('Usage: sim.mjs search <query>');
    process.exit(1);
  }
  try {
    const out = execSync(`node "${POLYMARKET_CLI}" search "${query}"`, { encoding: 'utf-8', timeout: 15000 });
    console.log(out);
  } catch (e) {
    console.error('Search failed:', e.message);
  }
}

function cmdReset() {
  const portfolio = createFreshPortfolio();
  saveJSON(PORTFOLIO_FILE, portfolio);
  saveJSON(BETS_FILE, []);
  saveJSON(HISTORY_FILE, []);
  console.log(`✅ All strategies reset to $${INITIAL_PER_STRATEGY.toLocaleString()} each (total $${TOTAL_INITIAL.toLocaleString()}).`);
  printStrategyBalances(portfolio);
}

// ─── Phase 2: Snapshot / Scan / Auto-Bet ─────────────────────────

async function cmdSnapshot() {
  if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  console.log('📸 Fetching active markets from Polymarket…');

  let allMarkets = [];
  let offset = 0;
  const limit = 100;
  let hasMore = true;

  while (hasMore) {
    const url = `${GAMMA_API}/markets?closed=false&active=true&limit=${limit}&offset=${offset}`;
    try {
      const batch = await fetchJSON(url);
      if (!batch || batch.length === 0) {
        hasMore = false;
      } else {
        allMarkets = allMarkets.concat(batch);
        offset += batch.length;
        if (batch.length < limit) hasMore = false;
      }
    } catch (e) {
      console.error(`  Error fetching page at offset ${offset}: ${e.message}`);
      hasMore = false;
    }
  }

  if (allMarkets.length === 0) {
    console.log('  No markets fetched. Check API connectivity.');
    return;
  }

  const markets = allMarkets.map(m => {
    const outcomes = parseOutcomes(m);
    const yesPrice = outcomes.find(o => o.name.toUpperCase() === 'YES')?.price || null;
    return {
      slug: m.slug || m.id,
      title: m.question || m.title || m.slug,
      price: yesPrice,
      volume: parseFloat(m.volume || m.volumeNum || 0),
      liquidity: parseFloat(m.liquidity || 0),
      marketId: m.id || m.condition_id || null,
    };
  }).filter(m => m.price !== null);

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const filename = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}.json`;
  const filepath = join(SNAPSHOTS_DIR, filename);

  const snapshot = { timestamp: now.toISOString(), marketCount: markets.length, markets };
  saveJSON(filepath, snapshot);
  console.log(`✅ Snapshot saved: data/snapshots/${filename}`);
  console.log(`   ${markets.length} markets captured.`);
}

function getRecentSnapshots(count = 2) {
  if (!existsSync(SNAPSHOTS_DIR)) return [];
  const files = readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(-count);
  return files.map(f => loadJSON(join(SNAPSHOTS_DIR, f)));
}

function detectSignals(oldSnap, newSnap) {
  const PRICE_THRESHOLD = 0.10;
  const VOLUME_THRESHOLD = 2.0;

  const oldBySlug = {};
  for (const m of oldSnap.markets) {
    oldBySlug[m.slug] = m;
  }

  const signals = [];
  for (const m of newSnap.markets) {
    const old = oldBySlug[m.slug];
    if (!old) continue;

    const priceDelta = m.price - old.price;
    const priceAbsDelta = Math.abs(priceDelta);
    const volumeRatio = old.volume > 0 ? m.volume / old.volume : 0;

    const isPriceSpike = priceAbsDelta > PRICE_THRESHOLD;
    const isVolSpike = old.volume > 0 && (volumeRatio - 1) > VOLUME_THRESHOLD;

    if (isPriceSpike || isVolSpike) {
      signals.push({
        slug: m.slug,
        title: m.title,
        oldPrice: old.price,
        newPrice: m.price,
        priceDelta,
        pricePct: (priceDelta * 100).toFixed(1),
        oldVolume: old.volume,
        newVolume: m.volume,
        volumeChange: old.volume > 0 ? ((volumeRatio - 1) * 100).toFixed(0) : 'N/A',
        isPriceSpike,
        isVolSpike,
        direction: priceDelta > 0 ? 'UP' : priceDelta < 0 ? 'DOWN' : 'FLAT',
        detectedAt: new Date().toISOString(),
      });
    }
  }
  return signals;
}

async function cmdScan() {
  const snaps = getRecentSnapshots(2);
  if (snaps.length < 2) {
    console.log('⚠️  Need at least 2 snapshots to scan. Run `sim.mjs snapshot` first.');
    return [];
  }

  const [oldSnap, newSnap] = snaps;
  console.log(`🔍 Scanning: ${oldSnap.timestamp} → ${newSnap.timestamp}`);
  console.log(`   Comparing ${oldSnap.marketCount} vs ${newSnap.marketCount} markets\n`);

  const signals = detectSignals(oldSnap, newSnap);

  if (signals.length === 0) {
    console.log('No significant moves detected.');
    saveJSON(SIGNALS_FILE, { timestamp: new Date().toISOString(), signals: [] });
    return [];
  }

  signals.sort((a, b) => Math.abs(b.priceDelta) - Math.abs(a.priceDelta));
  console.log(`🚨 ${signals.length} anomal${signals.length === 1 ? 'y' : 'ies'} detected:\n`);

  for (const s of signals) {
    const arrow = s.direction === 'UP' ? '↑' : s.direction === 'DOWN' ? '↓' : '→';
    const flags = [];
    if (s.isPriceSpike) flags.push(`price ${s.pricePct > 0 ? '+' : ''}${s.pricePct}%`);
    if (s.isVolSpike) flags.push(`volume +${s.volumeChange}%`);
    console.log(`  ${arrow} ${s.title}`);
    console.log(`    Price: ${(s.oldPrice * 100).toFixed(1)}¢ → ${(s.newPrice * 100).toFixed(1)}¢  [${flags.join(' | ')}]`);
    console.log(`    Volume: $${fmtNum(s.oldVolume)} → $${fmtNum(s.newVolume)}`);
    console.log();
  }

  saveJSON(SIGNALS_FILE, { timestamp: new Date().toISOString(), signals });
  return signals;
}

function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

// ─── Multi-Strategy Auto-Bet ─────────────────────────────────────

async function cmdAutoBet() {
  console.log('🤖 Multi-Strategy Auto-Bet\n');

  // Step 1: Get latest snapshot for snapshot-based strategies
  const snaps = getRecentSnapshots(2);
  const latestSnap = snaps.length > 0 ? snaps[snaps.length - 1] : null;
  const snapshotMarkets = latestSnap ? latestSnap.markets : [];

  // Step 2: Get signals from scan (for momentum/contrarian)
  let signals = [];
  if (snaps.length >= 2) {
    console.log('📡 Running scan for momentum/contrarian signals…\n');
    signals = detectSignals(snaps[0], snaps[1]);
    signals.sort((a, b) => Math.abs(b.priceDelta) - Math.abs(a.priceDelta));
  } else {
    console.log('⚠️  Need 2+ snapshots for momentum/contrarian strategies.\n');
  }

  // Step 3: Generate trade proposals from all strategies
  const proposals = [];

  // A. Momentum
  const momentumTrades = runMomentumStrategy(signals);
  proposals.push(...momentumTrades);
  console.log(`  📈 Momentum: ${momentumTrades.length} signal(s)`);

  // B. Contrarian
  const contrarianTrades = runContrarianStrategy(signals);
  proposals.push(...contrarianTrades);
  console.log(`  📉 Contrarian: ${contrarianTrades.length} signal(s)`);

  // C. Status Quo
  const statusQuoTrades = runStatusQuoStrategy(snapshotMarkets);
  proposals.push(...statusQuoTrades);
  console.log(`  🏛️  Status Quo: ${statusQuoTrades.length} candidate(s)`);

  // D. Cheap Contracts
  const cheapTrades = runCheapContractsStrategy(snapshotMarkets);
  proposals.push(...cheapTrades);
  console.log(`  🎰 Cheap Contracts: ${cheapTrades.length} candidate(s)`);

  // E. Arbitrage
  const arbTrades = await findArbOpportunities(snapshotMarkets);
  proposals.push(...arbTrades);
  console.log(`  ⚖️  Arbitrage: ${arbTrades.length} opportunity(ies)`);

  console.log(`\n  Total proposals: ${proposals.length}\n`);

  if (proposals.length === 0) {
    console.log('🤖 No actionable trades found across any strategy.');
    return;
  }

  // Step 4: Execute trades
  const portfolio = loadPortfolio();
  const bets = loadBets();
  let totalPlaced = 0;
  const stratResults = {};

  for (const prop of proposals) {
    const strategy = prop.strategy;
    const strat = portfolio.strategies[strategy];
    if (!strat) continue;

    // Skip extreme prices (but allow cheap contracts strategy to buy very low)
    const minPrice = prop.strategy === 'cheap_contracts' ? 0.0001 : 0.01;
    if (prop.price <= minPrice || prop.price >= 0.99) {
      continue;
    }

    // Check existing position
    const existing = bets.find(b => b.marketSlug === prop.slug && b.strategy === strategy && b.status === 'open');
    if (existing) continue;

    // Calculate bet size
    const betSize = Math.min(
      parseFloat((strat.cash * prop.sizePct).toFixed(2)),
      strat.cash * 0.5 // never more than 50% of strategy cash in one bet
    );

    // Enforce minimum bet amounts
    const minBet = strategy === 'cheap_contracts' ? MIN_BET_CHEAP_CONTRACTS : MIN_BET_AMOUNT;
    if (betSize < minBet || betSize > strat.cash) continue;

    if (prop.side === 'BOTH') {
      // Arb: split between YES and NO
      const halfBet = parseFloat((betSize / 2).toFixed(2));
      if (halfBet < 1) continue;

      const yesBet = {
        id: genId(),
        strategy,
        marketSlug: prop.slug,
        marketId: null,
        question: prop.title,
        side: 'YES',
        entryPrice: prop.yesPrice,
        currentPrice: prop.yesPrice,
        shares: parseFloat((halfBet / prop.yesPrice).toFixed(4)),
        cost: halfBet,
        openedAt: new Date().toISOString(),
        status: 'open',
        autoBet: true,
        reason: prop.reason + ' (YES leg)',
      };

      const noBet = {
        id: genId(),
        strategy,
        marketSlug: prop.slug,
        marketId: null,
        question: prop.title,
        side: 'NO',
        entryPrice: prop.noPrice,
        currentPrice: prop.noPrice,
        shares: parseFloat((halfBet / prop.noPrice).toFixed(4)),
        cost: halfBet,
        openedAt: new Date().toISOString(),
        status: 'open',
        autoBet: true,
        reason: prop.reason + ' (NO leg)',
      };

      bets.push(yesBet, noBet);
      strat.cash = parseFloat((strat.cash - halfBet * 2).toFixed(2));
      totalPlaced += 2;

      if (!stratResults[strategy]) stratResults[strategy] = [];
      stratResults[strategy].push(`✅ ARB ${prop.title} — YES@${(prop.yesPrice * 100).toFixed(1)}¢ + NO@${(prop.noPrice * 100).toFixed(1)}¢ | $${(halfBet * 2).toFixed(2)}`);
    } else {
      const shares = parseFloat((betSize / prop.price).toFixed(4));

      const bet = {
        id: genId(),
        strategy,
        marketSlug: prop.slug,
        marketId: null,
        question: prop.title,
        side: prop.side,
        entryPrice: prop.price,
        currentPrice: prop.price,
        shares,
        cost: parseFloat(betSize.toFixed(2)),
        openedAt: new Date().toISOString(),
        status: 'open',
        autoBet: true,
        reason: prop.reason,
      };

      bets.push(bet);
      strat.cash = parseFloat((strat.cash - betSize).toFixed(2));
      totalPlaced++;

      if (!stratResults[strategy]) stratResults[strategy] = [];
      stratResults[strategy].push(`✅ ${prop.side} ${prop.title} @ ${(prop.price * 100).toFixed(1)}¢ | $${betSize.toFixed(2)}`);
    }
  }

  // Print results per strategy
  console.log('─'.repeat(60));
  for (const [strat, results] of Object.entries(stratResults)) {
    console.log(`\n  [${strat}]:`);
    for (const r of results) {
      console.log(`    ${r}`);
    }
  }

  updateAllCurves(portfolio, bets);
  saveJSON(BETS_FILE, bets);
  saveJSON(PORTFOLIO_FILE, portfolio);

  // Save signals
  if (signals.length > 0) {
    saveJSON(SIGNALS_FILE, { timestamp: new Date().toISOString(), signals });
  }

  console.log(`\n🤖 Auto-Bet complete: ${totalPlaced} total bets placed.`);
  printStrategyBalances(portfolio);
}

// ─── Fetch Historical Data ───────────────────────────────────────

async function cmdFetchHistory() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  console.log('📥 Fetching resolved markets from Polymarket API…\n');

  // Strategy: ascending from ~6 months ago, filter aggressively, cap at 500 pages
  const now = new Date();
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  // Binary search for the right starting offset (6 months ago)
  console.log('  Finding starting offset for 6 months ago…');
  let startOffset = 0;
  let lo = 0, hi = 150000;
  for (let i = 0; i < 12; i++) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const probe = await fetchJSON(`${GAMMA_API}/markets?closed=true&limit=1&offset=${mid}&order=closedTime&ascending=true`);
      if (probe && probe.length > 0) {
        const dt = new Date(probe[0].closedTime || probe[0].endDate);
        if (dt < sixMonthsAgo) {
          lo = mid;
        } else {
          hi = mid;
        }
      } else {
        hi = mid;
      }
    } catch { hi = mid; }
    await new Promise(r => setTimeout(r, 100));
  }
  startOffset = lo;
  console.log(`  Starting from offset ${startOffset}\n`);

  let allMarkets = [];
  let offset = startOffset;
  const limit = 100;
  let hasMore = true;
  let page = 0;
  let skippedSports = 0;
  let skippedNoResolution = 0;
  let skippedNoise = 0;
  const MAX_PAGES = 150;

  // Noise filters
  const isNoiseMarket = (title) => {
    const t = title.toLowerCase();
    if (t.includes('up or down') && /\d+:\d+/i.test(title)) return true;  // crypto 5-min
    if (/will the (highest|lowest) temperature/i.test(title)) return true;  // weather
    if (/temperature in .+ be \d/i.test(title)) return true;
    if (/snow in .+ on /i.test(title)) return true;
    if (/rain in .+ on /i.test(title)) return true;
    if (t.includes('over/under') && t.includes('kills')) return true;  // esports noise
    return false;
  };

  while (hasMore && page < MAX_PAGES) {
    const url = `${GAMMA_API}/markets?closed=true&limit=${limit}&offset=${offset}&order=closedTime&ascending=true`;
    try {
      const batch = await fetchJSON(url);
      if (!batch || batch.length === 0) { hasMore = false; break; }

      for (const m of batch) {
        const closedTime = m.closedTime || m.endDate || '';

        // Skip if before cutoff (shouldn't happen much with binary search)
        if (closedTime && new Date(closedTime) < sixMonthsAgo) continue;
        // Stop if future (shouldn't happen)
        if (closedTime && new Date(closedTime) > now) continue;

        // Parse outcome prices
        let outcomes, prices;
        try {
          outcomes = JSON.parse(m.outcomes || '[]');
          prices = JSON.parse(m.outcomePrices || '[]');
        } catch { continue; }

        const price0 = parseFloat(prices[0] || 0);
        const price1 = parseFloat(prices[1] || 0);

        let resolvedOutcome = null;
        if (price0 >= 0.99 && price1 <= 0.01) {
          resolvedOutcome = outcomes[0] || 'Yes';
        } else if (price1 >= 0.99 && price0 <= 0.01) {
          resolvedOutcome = outcomes[1] || 'No';
        } else {
          skippedNoResolution++;
          continue;
        }

        const title = m.question || m.title || m.slug;

        // Filter sports
        if (isSportsMarket(title)) { skippedSports++; continue; }
        const evCat = (m.events && m.events[0]?.category) || m.category || '';
        if (evCat.toLowerCase() === 'sports') { skippedSports++; continue; }

        // Filter noise
        if (isNoiseMarket(title)) { skippedNoise++; continue; }

        // Minimum volume $5,000
        const vol = m.volumeNum || parseFloat(m.volume || 0);
        if (vol < 5000) continue;

        const lastTradePrice = parseFloat(m.lastTradePrice || 0);
        const oneDayPriceChange = parseFloat(m.oneDayPriceChange || 0);
        const entryPrice = Math.max(0.001, Math.min(0.999, lastTradePrice - oneDayPriceChange));

        allMarkets.push({
          slug: m.slug || m.id,
          title,
          conditionId: m.conditionId || '',
          closedTime,
          endDate: m.endDateIso || m.endDate || '',
          outcomes,
          outcomePrices: prices.map(Number),
          resolvedOutcome,
          yesWon: resolvedOutcome.toLowerCase() === 'yes',
          lastTradePrice,
          oneDayPriceChange,
          entryPriceEstimate: parseFloat(entryPrice.toFixed(4)),
          volume: vol,
          liquidity: m.liquidityNum || parseFloat(m.liquidity || 0),
          category: evCat || '',
          description: (m.description || '').slice(0, 200),
        });
      }

      offset += batch.length;
      page++;
      const latest = allMarkets.length > 0 ? allMarkets[allMarkets.length - 1].closedTime?.slice(0, 10) : '?';
      process.stdout.write(`\r  Page ${page}: ${allMarkets.length} markets | through ${latest} (offset ${offset})      `);

      await new Promise(r => setTimeout(r, 150));
      if (batch.length < limit) hasMore = false;
    } catch (e) {
      console.error(`\n  Error at offset ${offset}: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
      offset += limit; // skip past problematic page
      page++;
    }
  }

  // Sort chronologically
  allMarkets.sort((a, b) => new Date(a.closedTime) - new Date(b.closedTime));

  const result = {
    fetchedAt: new Date().toISOString(),
    totalMarkets: allMarkets.length,
    skippedSports,
    skippedNoResolution,
    skippedNoise,
    dateRange: {
      from: allMarkets.length > 0 ? allMarkets[0].closedTime : null,
      to: allMarkets.length > 0 ? allMarkets[allMarkets.length - 1].closedTime : null,
    },
    markets: allMarkets,
  };

  saveJSON(HISTORICAL_MARKETS_FILE, result);
  console.log(`\n\n✅ Historical data saved to data/historical-markets.json`);
  console.log(`   Total resolved markets: ${allMarkets.length}`);
  console.log(`   Skipped sports: ${skippedSports} | noise: ${skippedNoise} | unresolved: ${skippedNoResolution}`);
  if (allMarkets.length > 0) {
    console.log(`   Date range: ${result.dateRange.from?.slice(0, 10)} → ${result.dateRange.to?.slice(0, 10)}`);
  }
}

// ─── Backtest Engine ─────────────────────────────────────────────

function runBacktest() {
  const data = loadJSON(HISTORICAL_MARKETS_FILE);
  if (!data || !data.markets || data.markets.length === 0) {
    console.error('❌ No historical data found. Run `node sim.mjs fetch-history` first.');
    process.exit(1);
  }

  const markets = data.markets;
  console.log(`\n🔬 Running backtest on ${markets.length} resolved markets…\n`);

  // Initialize strategy state
  const BACKTEST_INITIAL = 10000;
  const MAX_BET_DEFAULT = 200;    // 2% position size
  const MAX_BET_CHEAP = 100;      // 1% for cheap contracts

  const strategies = {
    momentum: { cash: BACKTEST_INITIAL, bets: [], wins: 0, losses: 0, totalPnl: 0, trades: [], equityCurve: [{ date: null, equity: BACKTEST_INITIAL }] },
    contrarian: { cash: BACKTEST_INITIAL, bets: [], wins: 0, losses: 0, totalPnl: 0, trades: [], equityCurve: [{ date: null, equity: BACKTEST_INITIAL }] },
    status_quo: { cash: BACKTEST_INITIAL, bets: [], wins: 0, losses: 0, totalPnl: 0, trades: [], equityCurve: [{ date: null, equity: BACKTEST_INITIAL }] },
    cheap_contracts: { cash: BACKTEST_INITIAL, bets: [], wins: 0, losses: 0, totalPnl: 0, trades: [], equityCurve: [{ date: null, equity: BACKTEST_INITIAL }] },
    arb: { cash: BACKTEST_INITIAL, bets: [], wins: 0, losses: 0, totalPnl: 0, trades: [], equityCurve: [{ date: null, equity: BACKTEST_INITIAL }] },
  };

  // Process markets chronologically
  // Key insight: we use entryPriceEstimate (= lastTradePrice - oneDayPriceChange)
  // as the "day before resolution" price for realistic entry simulation.
  // This avoids look-ahead bias where lastTradePrice already reflects the outcome.

  for (const market of markets) {
    const yesWon = market.yesWon;
    const lastPrice = market.lastTradePrice;
    const priceChange = market.oneDayPriceChange;
    const entryPrice = market.entryPriceEstimate;  // price before the final move
    const closedDate = market.closedTime ? market.closedTime.slice(0, 10) : null;

    // Skip markets with extreme or invalid entry prices
    if (entryPrice <= 0.01 || entryPrice >= 0.99) continue;
    if (lastPrice <= 0 || lastPrice >= 1) continue;

    // ─── Strategy 1: Momentum ───
    // Signal: price moved >10% in last day. Entry at entryPriceEstimate (pre-move price).
    // Direction: follow the move — if moving UP, buy YES at current entry price
    if (Math.abs(priceChange) > 0.10) {
      const strat = strategies.momentum;
      const betSize = Math.min(MAX_BET_DEFAULT, strat.cash * 0.02);
      if (betSize >= 1 && strat.cash >= betSize) {
        // If price moving UP → buy YES at the entry estimate
        // If price moving DOWN → buy NO at (1 - entryPrice)
        const side = priceChange > 0 ? 'YES' : 'NO';
        const buyPrice = priceChange > 0 ? entryPrice : (1 - entryPrice);
        if (buyPrice > 0.02 && buyPrice < 0.98) {
          const shares = betSize / buyPrice;
          const won = (side === 'YES' && yesWon) || (side === 'NO' && !yesWon);
          const payout = won ? shares * 1.0 : 0;
          const pnl = payout - betSize;

          strat.cash -= betSize;
          strat.cash += payout;
          strat.totalPnl += pnl;
          if (won) strat.wins++; else strat.losses++;
          strat.trades.push({
            slug: market.slug, title: market.title, side, buyPrice: parseFloat(buyPrice.toFixed(4)),
            betSize: parseFloat(betSize.toFixed(2)), pnl: parseFloat(pnl.toFixed(2)), won, date: closedDate,
            reason: `momentum: Δ${(priceChange * 100).toFixed(1)}%, entry@${(buyPrice * 100).toFixed(1)}¢`,
          });
          strat.equityCurve.push({ date: closedDate, equity: parseFloat(strat.cash.toFixed(2)) });
        }
      }
    }

    // ─── Strategy 2: Contrarian ───
    // Same signal but FADE the move — bet against the direction
    if (Math.abs(priceChange) > 0.10) {
      const strat = strategies.contrarian;
      const betSize = Math.min(MAX_BET_DEFAULT, strat.cash * 0.02);
      if (betSize >= 1 && strat.cash >= betSize) {
        const side = priceChange > 0 ? 'NO' : 'YES';
        const buyPrice = priceChange > 0 ? (1 - entryPrice) : entryPrice;
        if (buyPrice > 0.02 && buyPrice < 0.98) {
          const shares = betSize / buyPrice;
          const won = (side === 'YES' && yesWon) || (side === 'NO' && !yesWon);
          const payout = won ? shares * 1.0 : 0;
          const pnl = payout - betSize;

          strat.cash -= betSize;
          strat.cash += payout;
          strat.totalPnl += pnl;
          if (won) strat.wins++; else strat.losses++;
          strat.trades.push({
            slug: market.slug, title: market.title, side, buyPrice: parseFloat(buyPrice.toFixed(4)),
            betSize: parseFloat(betSize.toFixed(2)), pnl: parseFloat(pnl.toFixed(2)), won, date: closedDate,
            reason: `contrarian: fading Δ${(priceChange * 100).toFixed(1)}%, entry@${(buyPrice * 100).toFixed(1)}¢`,
          });
          strat.equityCurve.push({ date: closedDate, equity: parseFloat(strat.cash.toFixed(2)) });
        }
      }
    }

    // ─── Strategy 3: Status Quo ───
    // Title matches "Will X happen" pattern AND estimated entry YES price < 40¢ → buy NO
    {
      const willPatterns = /\b(will|going to|expected to|set to|likely to|plan to)\b/i;
      if (willPatterns.test(market.title) && entryPrice < 0.40) {
        const strat = strategies.status_quo;
        const noPrice = 1 - entryPrice;  // Use entry estimate for buy price
        const betSize = Math.min(MAX_BET_DEFAULT, strat.cash * 0.02);
        if (betSize >= 1 && strat.cash >= betSize && noPrice > 0.02 && noPrice < 0.98) {
          const shares = betSize / noPrice;
          const won = !yesWon;  // We bought NO
          const payout = won ? shares * 1.0 : 0;
          const pnl = payout - betSize;

          strat.cash -= betSize;
          strat.cash += payout;
          strat.totalPnl += pnl;
          if (won) strat.wins++; else strat.losses++;
          strat.trades.push({
            slug: market.slug, title: market.title, side: 'NO', buyPrice: parseFloat(noPrice.toFixed(4)),
            betSize: parseFloat(betSize.toFixed(2)), pnl: parseFloat(pnl.toFixed(2)), won, date: closedDate,
            reason: `status quo: YES@${(entryPrice * 100).toFixed(1)}¢ → buying NO@${(noPrice * 100).toFixed(1)}¢`,
          });
          strat.equityCurve.push({ date: closedDate, equity: parseFloat(strat.cash.toFixed(2)) });
        }
      }
    }

    // ─── Strategy 4: Cheap Contracts ───
    // Entry price estimate < 5¢ → buy YES (lottery ticket)
    if (entryPrice > 0 && entryPrice < 0.05) {
      const strat = strategies.cheap_contracts;
      const betSize = Math.min(MAX_BET_CHEAP, strat.cash * 0.01);
      if (betSize >= 1 && strat.cash >= betSize) {
        const shares = betSize / entryPrice;
        const won = yesWon;
        const payout = won ? shares * 1.0 : 0;
        const pnl = payout - betSize;

        strat.cash -= betSize;
        strat.cash += payout;
        strat.totalPnl += pnl;
        if (won) strat.wins++; else strat.losses++;
        strat.trades.push({
          slug: market.slug, title: market.title, side: 'YES', buyPrice: parseFloat(entryPrice.toFixed(4)),
          betSize: parseFloat(betSize.toFixed(2)), pnl: parseFloat(pnl.toFixed(2)), won, date: closedDate,
          reason: `cheap contract: YES@${(entryPrice * 100).toFixed(1)}¢`,
        });
        strat.equityCurve.push({ date: closedDate, equity: parseFloat(strat.cash.toFixed(2)) });
      }
    }

    // ─── Strategy 5: Arbitrage ───
    // Simulated arb: for binary markets near 50/50 with moderate volume,
    // buy both sides. In theory YES+NO on orderbook < $1.00 due to spread.
    // We simulate with a 2% edge (buy both at 98¢ combined, get $1 payout).
    // Only trades on lower-volume markets where spread opportunities exist.
    {
      if (entryPrice > 0.40 && entryPrice < 0.60 && market.volume < 50000 && market.volume >= 5000) {
        const strat = strategies.arb;
        const yesPrice = entryPrice;
        const noPrice = 1 - entryPrice;
        // Simulate buying both with 2% spread advantage
        const spreadEdge = 0.02;
        const adjYesCost = yesPrice * (1 - spreadEdge / 2);
        const adjNoCost = noPrice * (1 - spreadEdge / 2);
        const totalCostPerShare = adjYesCost + adjNoCost;  // ~0.98
        const betSize = Math.min(MAX_BET_DEFAULT, strat.cash * 0.02);

        if (betSize >= 2 && strat.cash >= betSize && totalCostPerShare < 1.0) {
          const halfBet = betSize / 2;
          const yesShares = halfBet / adjYesCost;
          const noShares = halfBet / adjNoCost;
          const yesPayout = yesWon ? yesShares * 1.0 : 0;
          const noPayout = !yesWon ? noShares * 1.0 : 0;
          const totalPayout = yesPayout + noPayout;
          const pnl = totalPayout - betSize;

          strat.cash -= betSize;
          strat.cash += totalPayout;
          strat.totalPnl += pnl;
          if (pnl > 0) strat.wins++; else strat.losses++;
          strat.trades.push({
            slug: market.slug, title: market.title, side: 'BOTH',
            buyPrice: parseFloat(yesPrice.toFixed(4)),
            betSize: parseFloat(betSize.toFixed(2)), pnl: parseFloat(pnl.toFixed(2)),
            won: pnl > 0, date: closedDate,
            reason: `arb: YES@${(adjYesCost * 100).toFixed(1)}¢ + NO@${(adjNoCost * 100).toFixed(1)}¢, vol=$${(market.volume/1000).toFixed(0)}K`,
          });
          strat.equityCurve.push({ date: closedDate, equity: parseFloat(strat.cash.toFixed(2)) });
        }
      }
    }
  }

  // ── Calculate Sharpe Ratios ──
  for (const [name, strat] of Object.entries(strategies)) {
    const curve = strat.equityCurve;
    strat.sharpe = null;
    if (curve.length >= 3) {
      const returns = [];
      for (let i = 1; i < curve.length; i++) {
        if (curve[i - 1].equity > 0) {
          returns.push((curve[i].equity - curve[i - 1].equity) / curve[i - 1].equity);
        }
      }
      if (returns.length >= 2) {
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const std = Math.sqrt(returns.reduce((a, r) => a + Math.pow(r - mean, 2), 0) / returns.length);
        if (std > 0.0001) {  // Avoid division by near-zero
          const raw = mean / std * Math.sqrt(252);
          strat.sharpe = parseFloat(Math.max(-10, Math.min(10, raw)).toFixed(2));  // Clamp to [-10, 10]
        }
      }
    }
  }

  // ── Calculate date range ──
  const firstDate = markets[0]?.closedTime?.slice(0, 10) || '?';
  const lastDate = markets[markets.length - 1]?.closedTime?.slice(0, 10) || '?';
  const monthsSpan = markets.length > 0
    ? ((new Date(lastDate) - new Date(firstDate)) / (1000 * 60 * 60 * 24 * 30)).toFixed(1)
    : 0;

  // ── Print Report ──
  console.log(`═══ BACKTEST REPORT (${firstDate} → ${lastDate}, ~${monthsSpan} months) ═══\n`);
  console.log(`Markets analyzed: ${markets.length.toLocaleString()}`);
  console.log();

  // Table header
  const hdr = [
    'Strategy'.padEnd(18),
    'Bets'.padStart(6),
    'Wins'.padStart(6),
    'Win%'.padStart(7),
    'P&L'.padStart(12),
    'ROI%'.padStart(8),
    'Sharpe'.padStart(8),
    'Final $'.padStart(12),
  ].join(' │ ');
  const sep = '─'.repeat(18) + '─┼─' + '─'.repeat(6) + '─┼─' + '─'.repeat(6) + '─┼─' + '─'.repeat(7) + '─┼─' + '─'.repeat(12) + '─┼─' + '─'.repeat(8) + '─┼─' + '─'.repeat(8) + '─┼─' + '─'.repeat(12);
  console.log(hdr);
  console.log(sep);

  const stratOrder = ['momentum', 'contrarian', 'status_quo', 'cheap_contracts', 'arb'];
  const reportStrategies = {};

  for (const name of stratOrder) {
    const s = strategies[name];
    const totalBets = s.wins + s.losses;
    const winPct = totalBets > 0 ? (s.wins / totalBets * 100).toFixed(1) + '%' : '—';
    const roi = ((s.totalPnl / BACKTEST_INITIAL) * 100).toFixed(1);
    const pnlStr = s.totalPnl >= 0 ? `+$${s.totalPnl.toFixed(2)}` : `-$${Math.abs(s.totalPnl).toFixed(2)}`;
    const sharpeStr = s.sharpe !== null ? s.sharpe.toFixed(2) : '—';
    const finalCash = s.cash.toFixed(2);

    const row = [
      name.padEnd(18),
      (totalBets + '').padStart(6),
      (s.wins + '').padStart(6),
      winPct.padStart(7),
      pnlStr.padStart(12),
      (roi + '%').padStart(8),
      sharpeStr.padStart(8),
      ('$' + finalCash).padStart(12),
    ].join(' │ ');
    console.log(row);

    reportStrategies[name] = {
      bets: totalBets,
      wins: s.wins,
      losses: s.losses,
      winRate: totalBets > 0 ? parseFloat((s.wins / totalBets * 100).toFixed(1)) : null,
      pnl: parseFloat(s.totalPnl.toFixed(2)),
      roi: parseFloat(roi),
      sharpe: s.sharpe,
      finalCash: parseFloat(finalCash),
      equityCurve: s.equityCurve,
      trades: s.trades,
    };
  }

  console.log(sep);

  // Summary
  const totalPnlAll = Object.values(strategies).reduce((s, st) => s + st.totalPnl, 0);
  const totalBetsAll = Object.values(strategies).reduce((s, st) => s + st.wins + st.losses, 0);
  const totalWinsAll = Object.values(strategies).reduce((s, st) => s + st.wins, 0);
  console.log(`\n📊 Combined: ${totalBetsAll} bets, ${totalWinsAll} wins (${totalBetsAll > 0 ? (totalWinsAll / totalBetsAll * 100).toFixed(1) : 0}%), P&L: ${totalPnlAll >= 0 ? '+' : ''}$${totalPnlAll.toFixed(2)}`);

  // Best & worst
  const ranked = stratOrder.map(n => ({ name: n, roi: reportStrategies[n].roi })).sort((a, b) => b.roi - a.roi);
  console.log(`🏆 Best strategy: ${ranked[0].name} (ROI ${ranked[0].roi}%)`);
  console.log(`📉 Worst strategy: ${ranked[ranked.length - 1].name} (ROI ${ranked[ranked.length - 1].roi}%)`);

  // Save results
  const backtestResult = {
    runAt: new Date().toISOString(),
    dateRange: { from: firstDate, to: lastDate, months: parseFloat(monthsSpan) },
    marketsAnalyzed: markets.length,
    initialCapitalPerStrategy: BACKTEST_INITIAL,
    strategies: reportStrategies,
  };

  saveJSON(BACKTEST_RESULTS_FILE, backtestResult);
  console.log(`\n💾 Detailed results saved to data/backtest-results.json`);
}

// ─── Arg parsing ─────────────────────────────────────────────────

// ─── Case Study Engine ───────────────────────────────────────────

function runCaseStudy() {
  if (!existsSync(CASE_STUDIES_FILE)) {
    console.error('❌ No case study data. Run the data fetch script first.');
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(CASE_STUDIES_FILE, 'utf8'));
  console.log(`\n🔬 CASE STUDY BACKTEST — ${data.length} Events\n`);

  const CAPITAL = 10000;  // $10K per strategy
  const BET_SIZE_PCT = 0.02;  // 2% of capital per bet
  const MAX_BET = 200;

  // Entry timing windows: days before resolution
  const ENTRY_WINDOWS = [
    { label: 'Early (>30d)', minDays: 30, maxDays: Infinity },
    { label: 'Mid (14-30d)', minDays: 14, maxDays: 30 },
    { label: 'Late (7-14d)', minDays: 7, maxDays: 14 },
    { label: 'Last Week (3-7d)', minDays: 3, maxDays: 7 },
    { label: 'Last Minute (1-3d)', minDays: 1, maxDays: 3 },
  ];

  // Strategy definitions: given price history, when and how to enter
  const strategies = {
    momentum: {
      desc: 'Follow the trend — buy in direction of recent move',
      shouldEnter: (prices, idx) => {
        if (idx < 3) return null;
        // Look at 3-day price change
        const curr = prices[idx].p;
        const prev = prices[idx - 3].p;
        const delta = curr - prev;
        if (Math.abs(delta) < 0.05) return null;  // need 5%+ move over 3 days
        return {
          side: delta > 0 ? 'YES' : 'NO',
          price: delta > 0 ? curr : (1 - curr),
          reason: `3d Δ${(delta * 100).toFixed(1)}%`,
        };
      },
    },
    contrarian: {
      desc: 'Fade the trend — bet against recent move',
      shouldEnter: (prices, idx) => {
        if (idx < 3) return null;
        const curr = prices[idx].p;
        const prev = prices[idx - 3].p;
        const delta = curr - prev;
        if (Math.abs(delta) < 0.05) return null;
        return {
          side: delta > 0 ? 'NO' : 'YES',
          price: delta > 0 ? (1 - curr) : curr,
          reason: `fade 3d Δ${(delta * 100).toFixed(1)}%`,
        };
      },
    },
    status_quo: {
      desc: 'Bet NO on unlikely events (YES < 40¢)',
      shouldEnter: (prices, idx) => {
        const curr = prices[idx].p;
        if (curr >= 0.40) return null;
        return {
          side: 'NO',
          price: 1 - curr,
          reason: `YES@${(curr * 100).toFixed(0)}¢ → buy NO`,
        };
      },
    },
    cheap_contracts: {
      desc: 'Buy cheap YES contracts < 15¢ (lottery tickets)',
      shouldEnter: (prices, idx) => {
        const curr = prices[idx].p;
        if (curr >= 0.15 || curr <= 0.01) return null;
        return {
          side: 'YES',
          price: curr,
          reason: `lottery YES@${(curr * 100).toFixed(0)}¢`,
        };
      },
    },
    value: {
      desc: 'Buy YES when price > 60¢ (high conviction favorites)',
      shouldEnter: (prices, idx) => {
        const curr = prices[idx].p;
        if (curr <= 0.60 || curr >= 0.95) return null;
        return {
          side: 'YES',
          price: curr,
          reason: `value YES@${(curr * 100).toFixed(0)}¢`,
        };
      },
    },
  };

  const stratNames = Object.keys(strategies);
  const allResults = [];

  // Process each event
  for (const event of data) {
    console.log(`${'═'.repeat(70)}`);
    console.log(`📊 ${event.name} (${event.cat}) — Event Vol: $${(event.event_vol / 1e6).toFixed(0)}M`);
    console.log(`   ${event.event}`);
    console.log();

    // For each market in this event
    for (const mkt of event.markets) {
      if (mkt.pts < 10) continue;  // skip sparse data
      const history = mkt.history;
      const lastDay = history[history.length - 1];
      const resolvedYes = mkt.resolved_yes;
      const resolvedPrice = resolvedYes ? 1.0 : 0.0;

      console.log(`  ${resolvedYes ? '✅' : '❌'} ${mkt.label} | ${mkt.pts} days | ${(mkt.p0).toFixed(0)}→${(mkt.p1).toFixed(0)}¢ | $${(mkt.vol / 1e6).toFixed(1)}M`);

      // For each strategy, walk through time and find entry signals
      for (const [stratName, strat] of Object.entries(strategies)) {
        const entries = [];

        for (let i = 0; i < history.length; i++) {
          const daysToEnd = history.length - 1 - i;
          const signal = strat.shouldEnter(history, i);
          if (!signal) continue;
          if (signal.price <= 0.01 || signal.price >= 0.99) continue;

          // Calculate P&L
          const shares = MAX_BET / signal.price;
          const won = (signal.side === 'YES' && resolvedYes) || (signal.side === 'NO' && !resolvedYes);
          const payout = won ? shares : 0;
          const pnl = payout - MAX_BET;
          const roi = (pnl / MAX_BET) * 100;

          // Find which entry window this falls into
          let window = 'Unknown';
          for (const w of ENTRY_WINDOWS) {
            if (daysToEnd >= w.minDays && daysToEnd < w.maxDays) {
              window = w.label;
              break;
            }
          }

          const entryDate = new Date(history[i].t * 1000).toISOString().slice(0, 10);
          entries.push({
            date: entryDate,
            daysToEnd,
            window,
            side: signal.side,
            entryPrice: parseFloat(signal.price.toFixed(4)),
            reason: signal.reason,
            won,
            pnl: parseFloat(pnl.toFixed(2)),
            roi: parseFloat(roi.toFixed(1)),
            betSize: MAX_BET,
          });
        }

        if (entries.length > 0) {
          // Pick best entry (earliest profitable, or best ROI)
          const bestEntry = entries.reduce((a, b) => a.roi > b.roi ? a : b);
          const winEntries = entries.filter(e => e.won);
          const lossEntries = entries.filter(e => !e.won);

          allResults.push({
            event: event.name,
            eventSlug: event.event_slug,
            cat: event.cat,
            market: mkt.label,
            marketSlug: mkt.slug,
            strategy: stratName,
            totalSignals: entries.length,
            winSignals: winEntries.length,
            lossSignals: lossEntries.length,
            winRate: parseFloat((winEntries.length / entries.length * 100).toFixed(1)),
            bestEntry,
            avgROI: parseFloat((entries.reduce((s, e) => s + e.roi, 0) / entries.length).toFixed(1)),
            entries,  // all entry points for charting
          });
        }
      }
    }
  }

  // ── Summary Report ──
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`\n📈 STRATEGY PERFORMANCE ACROSS ALL CASE STUDIES\n`);

  // Aggregate by strategy
  const stratSummary = {};
  for (const s of stratNames) {
    const sResults = allResults.filter(r => r.strategy === s);
    const totalSignals = sResults.reduce((sum, r) => sum + r.totalSignals, 0);
    const totalWins = sResults.reduce((sum, r) => sum + r.winSignals, 0);
    const totalLosses = sResults.reduce((sum, r) => sum + r.lossSignals, 0);
    const avgROI = totalSignals > 0
      ? sResults.reduce((sum, r) => sum + r.avgROI * r.totalSignals, 0) / totalSignals
      : 0;
    const markets = sResults.length;

    stratSummary[s] = { totalSignals, totalWins, totalLosses, avgROI, markets };

    const winRate = totalSignals > 0 ? (totalWins / totalSignals * 100).toFixed(1) : '—';
    console.log(`  [${s}] ${strategies[s].desc}`);
    console.log(`    Markets triggered: ${markets} | Signals: ${totalSignals} | Win rate: ${winRate}% | Avg ROI: ${avgROI >= 0 ? '+' : ''}${avgROI.toFixed(1)}%`);
    console.log();
  }

  // Aggregate by entry window
  console.log(`\n⏰ PERFORMANCE BY ENTRY TIMING\n`);
  const hdr = ['Window', 'Signals', 'Wins', 'Win%', 'Avg ROI'].map((h, i) =>
    i === 0 ? h.padEnd(20) : h.padStart(10)
  ).join(' │ ');
  console.log(hdr);
  console.log('─'.repeat(20) + '─┼─' + ('─'.repeat(10) + '─┼─').repeat(3) + '─'.repeat(10));

  for (const w of ENTRY_WINDOWS) {
    let signals = 0, wins = 0, totalROI = 0;
    for (const r of allResults) {
      for (const e of r.entries) {
        if (e.window === w.label) {
          signals++;
          if (e.won) wins++;
          totalROI += e.roi;
        }
      }
    }
    const winRate = signals > 0 ? (wins / signals * 100).toFixed(1) + '%' : '—';
    const avgROI = signals > 0 ? (totalROI / signals).toFixed(1) + '%' : '—';
    const row = [
      w.label.padEnd(20),
      (signals + '').padStart(10),
      (wins + '').padStart(10),
      winRate.padStart(10),
      avgROI.padStart(10),
    ].join(' │ ');
    console.log(row);
  }

  // Aggregate by strategy × window
  console.log(`\n\n🎯 STRATEGY × ENTRY TIMING (Avg ROI %)\n`);
  const windowLabels = ENTRY_WINDOWS.map(w => w.label);
  const colW = 14;
  const headerRow = 'Strategy'.padEnd(18) + windowLabels.map(w => w.slice(0, colW).padStart(colW)).join(' │ ');
  console.log(headerRow);
  console.log('─'.repeat(18) + ('─┼─' + '─'.repeat(colW)).repeat(windowLabels.length));

  for (const s of stratNames) {
    const cells = [];
    for (const w of ENTRY_WINDOWS) {
      let signals = 0, totalROI = 0;
      for (const r of allResults.filter(r => r.strategy === s)) {
        for (const e of r.entries) {
          if (e.window === w.label) { signals++; totalROI += e.roi; }
        }
      }
      if (signals > 0) {
        const avg = (totalROI / signals).toFixed(0);
        cells.push(`${avg}% (${signals})`.padStart(colW));
      } else {
        cells.push('—'.padStart(colW));
      }
    }
    console.log(s.padEnd(18) + cells.join(' │ '));
  }

  // Best trades
  console.log(`\n\n🏆 TOP 5 BEST TRADES\n`);
  const allEntries = [];
  for (const r of allResults) {
    for (const e of r.entries) {
      allEntries.push({ ...e, event: r.event, market: r.market, strategy: r.strategy });
    }
  }
  allEntries.sort((a, b) => b.roi - a.roi);
  for (const e of allEntries.slice(0, 5)) {
    console.log(`  ${e.won ? '✅' : '❌'} [${e.strategy}] ${e.event} / ${e.market}`);
    console.log(`     ${e.side} @ ${(e.entryPrice * 100).toFixed(1)}¢ | ${e.daysToEnd}d before | ROI: ${e.roi >= 0 ? '+' : ''}${e.roi.toFixed(0)}% | P&L: $${e.pnl.toFixed(0)}`);
  }

  // Worst trades
  console.log(`\n📉 TOP 5 WORST TRADES\n`);
  for (const e of allEntries.slice(-5).reverse()) {
    console.log(`  ${e.won ? '✅' : '❌'} [${e.strategy}] ${e.event} / ${e.market}`);
    console.log(`     ${e.side} @ ${(e.entryPrice * 100).toFixed(1)}¢ | ${e.daysToEnd}d before | ROI: ${e.roi >= 0 ? '+' : ''}${e.roi.toFixed(0)}% | P&L: $${e.pnl.toFixed(0)}`);
  }

  // Save results
  const output = {
    runAt: new Date().toISOString(),
    events: data.length,
    strategies: stratSummary,
    entryWindows: ENTRY_WINDOWS.map(w => w.label),
    results: allResults,
  };
  if (!existsSync(CASE_STUDIES_DIR)) mkdirSync(CASE_STUDIES_DIR, { recursive: true });
  saveJSON(CASE_STUDIES_RESULTS_FILE, output);
  console.log(`\n💾 Results saved to data/case-studies/results.json`);
}

function argVal(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// ─── Main ────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv;

(async () => {
  try {
    switch (cmd) {
      case 'bet':
        await cmdBet(args);
        break;
      case 'sell':
        await cmdSell(args);
        break;
      case 'resolve':
        await cmdResolve();
        break;
      case 'status':
        cmdStatus(args);
        break;
      case 'leaderboard':
        cmdLeaderboard();
        break;
      case 'refresh':
        await cmdRefresh();
        break;
      case 'search':
        await cmdSearch(args);
        break;
      case 'reset':
        cmdReset();
        break;
      case 'snapshot':
        await cmdSnapshot();
        break;
      case 'scan':
        await cmdScan();
        break;
      case 'auto-bet':
        await cmdAutoBet();
        break;
      case 'fetch-history':
        await cmdFetchHistory();
        break;
      case 'backtest':
        runBacktest();
        break;
      case 'case-study':
        runCaseStudy();
        break;
      default:
        console.log(`Polymarket Paper Trading Simulator — Multi-Strategy Engine

Commands:
  fetch-history                                  Fetch resolved markets (last 6 months)
  backtest                                       Run backtest on historical data
  bet      --market <slug> --side YES|NO --amount <usd> [--strategy <name>]
  sell     --bet-id <id> [--price <0-1>]
  resolve                                        Settle resolved markets
  status   [--strategy <name>]                   Show portfolio (all or one strategy)
  leaderboard                                    Rank strategies by ROI
  refresh                                        Update prices
  search   <query>                               Search markets
  reset                                          Reset all strategies to $2,000
  snapshot                                       Capture market prices & volumes
  scan                                           Detect anomalous moves
  auto-bet                                       Run all 5 strategies

Strategies: ${STRATEGY_NAMES.join(', ')}

Examples:
  node sim.mjs fetch-history      # Pull historical data
  node sim.mjs backtest           # Run backtest report
  node sim.mjs case-study         # Run case study on 5 curated markets
  node sim.mjs auto-bet
  node sim.mjs status
  node sim.mjs leaderboard
`);
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
