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

const POLYMARKET_CLI = '/Users/quen/.openclaw/workspace/skills/polymarket-odds/polymarket.mjs';
const GAMMA_API = 'https://gamma-api.polymarket.com';

const STRATEGY_NAMES = ['momentum', 'contrarian', 'status_quo', 'cheap_contracts', 'arb'];
const INITIAL_PER_STRATEGY = 2000;
const TOTAL_INITIAL = INITIAL_PER_STRATEGY * STRATEGY_NAMES.length;

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
  return signals
    .filter(s => s.isPriceSpike)
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
  return signals
    .filter(s => s.isPriceSpike)
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
  const willPatterns = /\b(will|going to|expected to|set to|likely to|plan to|could|may)\b/i;
  return snapshotMarkets
    .filter(m => {
      if (!willPatterns.test(m.title)) return false;
      if (m.price < 0.10 || m.price > 0.40) return false;
      return true;
    })
    .slice(0, 5) // limit to top 5
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
  return snapshotMarkets
    .filter(m => m.price > 0 && m.price < 0.05)
    .sort((a, b) => a.price - b.price)
    .slice(0, 5)
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
    if (m.liquidity && m.liquidity < 5000 && m.price > 0.45 && m.price < 0.55) {
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

    if (betSize < 1 || betSize > strat.cash) continue;

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

// ─── Arg parsing ─────────────────────────────────────────────────

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
      default:
        console.log(`Polymarket Paper Trading Simulator — Multi-Strategy Engine

Commands:
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
  node sim.mjs auto-bet
  node sim.mjs status
  node sim.mjs status --strategy momentum
  node sim.mjs leaderboard
  node sim.mjs bet --market will-bitcoin-hit-100k --side YES --amount 100 --strategy momentum
  node sim.mjs reset
`);
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
