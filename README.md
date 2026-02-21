# Polymarket Paper Trading Simulator

A paper trading simulator for [Polymarket](https://polymarket.com) prediction markets. Track your bets, P&L, and portfolio performance — all with fake money.

**Live:** [polymarket-sim.pages.dev](https://polymarket-sim.pages.dev)

## Features

- **Virtual wallet** — Start with $10,000 USDC (configurable)
- **Real market data** — Prices fetched from Polymarket's API
- **CLI interface** — Place bets, sell positions, resolve markets
- **Web dashboard** — Dark trading-terminal UI with equity curve, position cards, trade history
- **JSON backend** — All data in flat files, easy to inspect and automate
- **Market snapshots** — Capture market state over time for analysis
- **Anomaly detection** — Scan for price spikes and volume surges
- **Auto-betting** — Momentum-based automated trading with Kelly sizing

## Quick Start

```bash
# Search for markets
node sim.mjs search "bitcoin"

# Place a bet
node sim.mjs bet --market will-bitcoin-hit-100k --side YES --amount 500

# Check portfolio
node sim.mjs status

# Refresh current prices
node sim.mjs refresh

# Sell a position
node sim.mjs sell --bet-id <id>

# Settle resolved markets
node sim.mjs resolve

# Reset portfolio
node sim.mjs reset
```

## Phase 2: Scanning & Auto-Bet

```bash
# Take a market snapshot (run periodically)
node sim.mjs snapshot

# Scan for anomalies (needs 2+ snapshots)
node sim.mjs scan

# Auto-bet on momentum signals
node sim.mjs auto-bet
```

### How It Works

1. **`snapshot`** — Fetches all active Polymarket markets and saves prices + volumes to `data/snapshots/YYYY-MM-DDTHH-mm.json`
2. **`scan`** — Compares the two most recent snapshots. Flags markets with:
   - Price change > 10% (absolute)
   - Volume increase > 200%
3. **`auto-bet`** — Runs `scan`, then places bets on momentum signals:
   - Price moving up → buy YES
   - Price moving down → buy NO
   - Bet size: 2% of equity (simplified Kelly), max $200

## CLI Commands

| Command | Description |
|---------|-------------|
| `search <query>` | Search Polymarket for active markets |
| `bet --market <slug> --side YES\|NO --amount <usd>` | Place a simulated bet |
| `sell --bet-id <id> [--price <0-1>]` | Sell an open position at current (or specified) price |
| `resolve` | Check and settle markets that have resolved |
| `status` | Display portfolio summary and open positions |
| `refresh` | Update all open positions with current market prices |
| `reset` | Reset portfolio to initial $10,000 balance |
| `snapshot` | Capture current market prices & volumes |
| `scan` | Detect anomalous price/volume moves between snapshots |
| `auto-bet` | Auto-bet on detected momentum signals |

## Dashboard

Open `index.html` in a browser or visit the deployed Cloudflare Pages URL.

The dashboard shows:
- Total equity, cash balance, P&L, ROI
- Win rate and Sharpe ratio
- Equity curve chart
- **Recent Signals** — Anomaly cards with direction arrows, price changes, and bet status
- Open position cards with live P&L
- Trade history table

## Data Files

All data lives in `data/`:

- `portfolio.json` — Balance, equity curve
- `bets.json` — Open positions
- `history.json` — Closed/resolved trades
- `signals.json` — Latest scan results (for dashboard)
- `snapshots/` — Market snapshots (timestamped JSON files)

## Deployment

Deployed to Cloudflare Pages. To redeploy:

```bash
wrangler pages deploy . --project-name polymarket-sim
```

## Tech Stack

- **Frontend:** HTML + CSS + vanilla JS
- **Charts:** Chart.js
- **Data:** Static JSON files
- **CLI:** Node.js (ES modules)
- **Hosting:** Cloudflare Pages

## License

MIT
