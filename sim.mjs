#!/usr/bin/env node
/**
 * Polymarket Paper Trading Simulator - CLI
 *
 * Commands:
 *   bet    --market <slug> --side YES|NO --amount <usd>
 *   sell   --bet-id <id> [--price <0-1>]
 *   resolve  — settle resolved markets
 *   status   — show portfolio & open positions
 *   refresh  — update current prices for all open bets
 *   search   <query> — search polymarket markets
 *   reset    — reset portfolio to initial state
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, 'data');
const PORTFOLIO_FILE = join(DATA_DIR, 'portfolio.json');
const BETS_FILE = join(DATA_DIR, 'bets.json');
const HISTORY_FILE = join(DATA_DIR, 'history.json');

const POLYMARKET_CLI = '/Users/quen/.openclaw/workspace/skills/polymarket-odds/polymarket.mjs';
const GAMMA_API = 'https://gamma-api.polymarket.com';

// ─── Data helpers ────────────────────────────────────────────────

function loadJSON(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8'));
}

function saveJSON(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function loadPortfolio() {
  return loadJSON(PORTFOLIO_FILE) || {
    initialBalance: 10000,
    cashBalance: 10000,
    totalDeposited: 10000,
    createdAt: new Date().toISOString(),
    equityCurve: [{ date: today(), equity: 10000 }],
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

  // try by condition_id / id
  try {
    return await fetchJSON(`${GAMMA_API}/markets/${slug}`);
  } catch {
    return null;
  }
}

async function fetchMarketById(id) {
  try {
    return await fetchJSON(`${GAMMA_API}/markets/${id}`);
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

// ─── Update equity curve ─────────────────────────────────────────

function updateEquityCurve(portfolio, bets) {
  const openValue = bets.reduce((sum, b) => {
    const currentPrice = b.currentPrice || b.entryPrice;
    return sum + b.shares * currentPrice;
  }, 0);
  const totalEquity = parseFloat((portfolio.cashBalance + openValue).toFixed(2));
  const d = today();
  const curve = portfolio.equityCurve || [];
  const last = curve[curve.length - 1];
  if (last && last.date === d) {
    last.equity = totalEquity;
  } else {
    curve.push({ date: d, equity: totalEquity });
  }
  portfolio.equityCurve = curve;
}

// ─── Commands ────────────────────────────────────────────────────

async function cmdBet(args) {
  const market = argVal(args, '--market');
  const side = (argVal(args, '--side') || '').toUpperCase();
  const amount = parseFloat(argVal(args, '--amount'));

  if (!market || !side || isNaN(amount)) {
    console.log('Usage: sim.mjs bet --market <slug> --side YES|NO --amount <usd>');
    process.exit(1);
  }
  if (!['YES', 'NO'].includes(side)) {
    console.error('Side must be YES or NO');
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
  if (amount > portfolio.cashBalance) {
    console.error(`Insufficient balance. Have $${portfolio.cashBalance.toFixed(2)}, need $${amount.toFixed(2)}`);
    process.exit(1);
  }

  const shares = parseFloat((amount / price).toFixed(4));
  const cost = parseFloat(amount.toFixed(2));

  const bet = {
    id: genId(),
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
  };

  const bets = loadBets();
  bets.push(bet);

  portfolio.cashBalance = parseFloat((portfolio.cashBalance - cost).toFixed(2));
  updateEquityCurve(portfolio, bets);

  saveJSON(BETS_FILE, bets);
  saveJSON(PORTFOLIO_FILE, portfolio);

  console.log(`✅ BET PLACED`);
  console.log(`   ${bet.question}`);
  console.log(`   Side: ${side} @ ${(price * 100).toFixed(1)}¢`);
  console.log(`   Shares: ${shares.toFixed(2)} | Cost: $${cost.toFixed(2)}`);
  console.log(`   Bet ID: ${bet.id}`);
  console.log(`   Balance: $${portfolio.cashBalance.toFixed(2)}`);
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

  // Remove from open bets
  bets.splice(idx, 1);

  const history = loadHistory();
  history.push(closedBet);

  const portfolio = loadPortfolio();
  portfolio.cashBalance = parseFloat((portfolio.cashBalance + proceeds).toFixed(2));
  updateEquityCurve(portfolio, bets);

  saveJSON(BETS_FILE, bets);
  saveJSON(HISTORY_FILE, history);
  saveJSON(PORTFOLIO_FILE, portfolio);

  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  console.log(`💰 BET SOLD`);
  console.log(`   ${closedBet.question}`);
  console.log(`   ${bet.side}: ${(bet.entryPrice * 100).toFixed(1)}¢ → ${(exitPrice * 100).toFixed(1)}¢`);
  console.log(`   P&L: ${pnlStr}`);
  console.log(`   Balance: $${portfolio.cashBalance.toFixed(2)}`);
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
    let mkt;
    try {
      mkt = await fetchMarketBySlug(bet.marketSlug);
    } catch {
      continue;
    }
    if (!mkt) continue;

    // Check if market is resolved
    if (mkt.resolved || mkt.closed) {
      let exitPrice;
      const resolutionOutcome = (mkt.resolution || '').toUpperCase();

      if (resolutionOutcome === bet.side) {
        exitPrice = 1.0;
      } else if (resolutionOutcome && resolutionOutcome !== bet.side) {
        exitPrice = 0.0;
      } else if (mkt.closed && !mkt.resolved) {
        // Market closed but not resolved yet — skip
        continue;
      } else {
        // Try to determine from outcome prices
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
      portfolio.cashBalance = parseFloat((portfolio.cashBalance + proceeds).toFixed(2));
      resolved++;

      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      console.log(`${exitPrice === 1.0 ? '🏆' : '❌'} ${closedBet.question}`);
      console.log(`   ${closedBet.status.toUpperCase()} | P&L: ${pnlStr}`);
    }
  }

  updateEquityCurve(portfolio, bets);
  saveJSON(BETS_FILE, bets);
  saveJSON(HISTORY_FILE, history);
  saveJSON(PORTFOLIO_FILE, portfolio);

  if (resolved === 0) {
    console.log('No markets have resolved yet.');
  } else {
    console.log(`\nResolved ${resolved} bet(s). Balance: $${portfolio.cashBalance.toFixed(2)}`);
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
    } catch {
      // skip
    }
  }

  updateEquityCurve(portfolio, bets);
  saveJSON(BETS_FILE, bets);
  saveJSON(PORTFOLIO_FILE, portfolio);
  console.log(`Refreshed ${updated}/${bets.length} positions.`);
  printPositions(bets);
}

function cmdStatus() {
  const portfolio = loadPortfolio();
  const bets = loadBets();
  const history = loadHistory();

  const openValue = bets.reduce((sum, b) => sum + b.shares * (b.currentPrice || b.entryPrice), 0);
  const openCost = bets.reduce((sum, b) => sum + b.cost, 0);
  const unrealizedPnl = openValue - openCost;
  const totalEquity = portfolio.cashBalance + openValue;

  const realizedPnl = history.reduce((sum, h) => sum + (h.pnl || 0), 0);
  const wins = history.filter(h => h.pnl > 0).length;
  const losses = history.filter(h => h.pnl <= 0).length;
  const winRate = history.length > 0 ? (wins / history.length * 100).toFixed(1) : '—';
  const totalPnl = realizedPnl + unrealizedPnl;
  const roi = ((totalPnl / portfolio.initialBalance) * 100).toFixed(2);

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║     POLYMARKET PAPER TRADING             ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Cash Balance:   $${portfolio.cashBalance.toFixed(2).padStart(10)}          ║`);
  console.log(`║  Open Positions: $${openValue.toFixed(2).padStart(10)}          ║`);
  console.log(`║  Total Equity:   $${totalEquity.toFixed(2).padStart(10)}          ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Unrealized P&L: ${fmtPnl(unrealizedPnl).padStart(12)}          ║`);
  console.log(`║  Realized P&L:   ${fmtPnl(realizedPnl).padStart(12)}          ║`);
  console.log(`║  Total P&L:      ${fmtPnl(totalPnl).padStart(12)}          ║`);
  console.log(`║  ROI:            ${(roi + '%').padStart(12)}          ║`);
  console.log(`║  Win Rate:       ${(winRate + (winRate === '—' ? '' : '%')).padStart(12)}          ║`);
  console.log(`║  Trades:         ${(history.length + '').padStart(12)}          ║`);
  console.log(`╚══════════════════════════════════════════╝`);

  if (bets.length > 0) {
    console.log('\n📊 Open Positions:');
    printPositions(bets);
  }

  if (history.length > 0) {
    console.log('\n📜 Recent History (last 5):');
    for (const h of history.slice(-5).reverse()) {
      const icon = h.status === 'won' ? '🏆' : h.status === 'lost' ? '❌' : '💰';
      console.log(`  ${icon} ${h.question}`);
      console.log(`     ${h.side} ${(h.entryPrice * 100).toFixed(1)}¢ → ${(h.exitPrice * 100).toFixed(1)}¢ | ${fmtPnl(h.pnl)}`);
    }
  }
}

function printPositions(bets) {
  for (const b of bets) {
    const currentVal = b.shares * (b.currentPrice || b.entryPrice);
    const pnl = currentVal - b.cost;
    const pnlPct = ((pnl / b.cost) * 100).toFixed(1);
    console.log(`  • ${b.question}`);
    console.log(`    ${b.side} @ ${(b.entryPrice * 100).toFixed(1)}¢ → ${((b.currentPrice || b.entryPrice) * 100).toFixed(1)}¢ | ${b.shares.toFixed(2)} shares | ${fmtPnl(pnl)} (${pnlPct}%) | ID: ${b.id}`);
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
  const portfolio = {
    initialBalance: 10000,
    cashBalance: 10000,
    totalDeposited: 10000,
    createdAt: new Date().toISOString(),
    equityCurve: [{ date: today(), equity: 10000 }],
  };
  saveJSON(PORTFOLIO_FILE, portfolio);
  saveJSON(BETS_FILE, []);
  saveJSON(HISTORY_FILE, []);
  console.log('✅ Portfolio reset to $10,000.');
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
        cmdStatus();
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
      default:
        console.log(`Polymarket Paper Trading Simulator

Commands:
  bet      --market <slug> --side YES|NO --amount <usd>   Place a bet
  sell     --bet-id <id> [--price <0-1>]                  Sell a position
  resolve                                                  Settle resolved markets
  status                                                   Show portfolio
  refresh                                                  Update prices
  search   <query>                                         Search markets
  reset                                                    Reset portfolio

Examples:
  node sim.mjs search "bitcoin"
  node sim.mjs bet --market will-bitcoin-hit-100k --side YES --amount 500
  node sim.mjs status
  node sim.mjs sell --bet-id abc123
  node sim.mjs refresh
  node sim.mjs resolve
`);
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
