# Polymarket Paper Trading Simulator

A paper trading simulator for [Polymarket](https://polymarket.com) prediction markets. Track your bets, P&L, and portfolio performance — all with fake money.

**Live:** [polymarket-sim.pages.dev](https://polymarket-sim.pages.dev)

## Features

- **Virtual wallet** — Start with $10,000 USDC (configurable)
- **Real market data** — Prices fetched from Polymarket's API
- **CLI interface** — Place bets, sell positions, resolve markets
- **Web dashboard** — Dark trading-terminal UI with equity curve, position cards, trade history
- **JSON backend** — All data in flat files, easy to inspect and automate

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

## Dashboard

Open `index.html` in a browser or visit the deployed Cloudflare Pages URL.

The dashboard shows:
- Total equity, cash balance, P&L, ROI
- Win rate and Sharpe ratio
- Equity curve chart
- Open position cards with live P&L
- Trade history table

## Data Files

All data lives in `data/`:

- `portfolio.json` — Balance, equity curve
- `bets.json` — Open positions
- `history.json` — Closed/resolved trades

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
