# 🌤 WeatherBet — Polymarket Weather Trading Bot

Automated weather market trading bot for Polymarket. Finds mispriced temperature outcomes using real forecast data from multiple sources across 20 cities worldwide.

No SDK. No black box. Pure Python.

---

## Versions

### `bot_v1.py` — Base Bot
The foundation. Scans 6 US cities, fetches forecasts from NWS using airport station coordinates, finds matching temperature buckets on Polymarket, and enters trades when the market price is below the entry threshold.

No math, no complexity. Just the core logic — good for understanding how the system works.

### `weatherbet.py` — Full Bot (current)
Everything in v1, plus:
- **20 cities** across 4 continents (US, Europe, Asia, South America, Oceania)
- **3 forecast sources** — ECMWF (global), HRRR/GFS (US, hourly), METAR (real-time observations)
- **Expected Value** — skips trades where the math doesn't work
- **Kelly Criterion** — sizes positions based on edge strength
- **Stop-loss + trailing stop** — 20% stop, moves to breakeven at +20%
- **Slippage filter** — skips markets with spread > $0.03
- **Self-calibration** — learns forecast accuracy per city over time
- **Full data storage** — every forecast snapshot, trade, and resolution saved to JSON

---

## How It Works

Polymarket runs markets like "Will the highest temperature in Chicago be between 46–47°F on March 7?" These markets are often mispriced — the forecast says 78% likely but the market is trading at 8 cents.

The bot:
1. Fetches forecasts from ECMWF and HRRR via Open-Meteo (free, no key required)
2. Gets real-time observations from METAR airport stations
3. Finds the matching temperature bucket on Polymarket
4. Calculates Expected Value — only enters if the math is positive
5. Sizes the position using fractional Kelly Criterion
6. Monitors stops every 10 minutes, full scan every hour
7. Auto-resolves markets by querying Polymarket API directly

---

## Why Airport Coordinates Matter

Most bots use city center coordinates. That's wrong.

Every Polymarket weather market resolves on a specific airport station. NYC resolves on LaGuardia (KLGA), Dallas on Love Field (KDAL) — not DFW. The difference between city center and airport can be 3–8°F. On markets with 1–2°F buckets, that's the difference between the right trade and a guaranteed loss.

| City | Station | Airport |
|------|---------|---------|
| NYC | KLGA | LaGuardia |
| Chicago | KORD | O'Hare |
| Miami | KMIA | Miami Intl |
| Dallas | KDAL | Love Field |
| Seattle | KSEA | Sea-Tac |
| Atlanta | KATL | Hartsfield |
| London | EGLC | London City |
| Tokyo | RJTT | Haneda |
| ... | ... | ... |

---

## Installation
```bash
git clone https://github.com/alteregoeth-ai/weatherbot
cd weatherbot
pip install -r requirements.txt
```

Create `config.json` in the project folder:
```json
{
  "balance": 10000.0,
  "max_bet": 20.0,
  "min_ev": 0.05,
  "max_price": 0.45,
  "min_volume": 2000,
  "min_hours": 2.0,
  "max_hours": 72.0,
  "kelly_fraction": 0.25,
  "max_slippage": 0.03,
  "scan_interval": 3600,
  "calibration_min": 30,
  "vc_key": "YOUR_VISUAL_CROSSING_KEY"
}
```

Get a free Visual Crossing API key at visualcrossing.com — used to fetch actual temperatures after market resolution.

---

## Usage

### Bot
```bash
python bot_v2.py           # start the bot — scans every hour
python bot_v2.py status    # balance and open positions
python bot_v2.py report    # full breakdown of all resolved markets

# Run in background with real-time logging
nohup python -u bot_v2.py >> nohup.out 2>&1 &
tail -f nohup.out          # follow the log
```

### Dashboard

A real-time Bloomberg-style operations center that reads the bot's JSON files and displays everything in a single-page UI.

```bash
python dashboard.py                    # start on default port 8050
python dashboard.py --port 9000        # custom port
```

Open `http://localhost:8050` in your browser.

**Features:**
- **KPI Strip** — Starting balance, open positions cost, realized/unrealized P&L, cash available, win rate, drawdown
- **World Map** — Interactive Leaflet.js map with 20 city markers showing forecast, EV, and position status
- **Open Positions** — Live table with entry → current price and unrealized P&L
- **Trade History** — Closed positions with close reason (stop_loss, trailing_stop, take_profit, forecast_changed) and realized P&L
- **Forecast Sources** — Side-by-side comparison of ECMWF, HRRR, and METAR for all cities
- **Calibration** — Forecast accuracy (sigma) per city/source (appears after enough resolved markets)
- **Activity Feed** — Real-time event log reconstructed from market file changes
- **Balance Chart** — Equity history over time

**Real-time updates:** The dashboard watches the `data/` directory for file changes and pushes updates via WebSocket. Falls back to 30-second polling if WebSocket disconnects.

**Tech stack:** FastAPI, Jinja2, Chart.js, Leaflet.js — no Node.js or build tools required.

**Note:** The dashboard calculates all KPIs directly from market JSON files rather than trusting `state.json`, ensuring accurate financial data.

---

## Docker

A `Dockerfile` and `docker-compose.yml` are provided to run the bot and dashboard side by side in containers.

### Requirements

- Docker 20.10+ with Docker Compose v2 (`docker compose`, not the legacy `docker-compose`)

### Quick start

```bash
# Build both images and start the services in the background.
docker compose up -d --build

# Tail the bot log (scans, trades, monitor ticks).
docker compose logs -f bot

# Tail the dashboard log.
docker compose logs -f dashboard

# Stop everything (state persists in ./data).
docker compose down
```

Open `http://localhost:8050` while the containers are running.

### What the services do

- **bot** — runs `python -u bot_v2.py`, scans every hour, monitors positions every 10 minutes. Writes market JSONs, `state.json`, and `calibration.json` to `./data`.
- **dashboard** — runs `python dashboard.py --host 0.0.0.0 --port 8050` and serves the operations center on port 8050. Watches `./data` for changes and pushes updates via WebSocket.

Both containers share the same image and mount the host's `./data` directory, so restarts are non-destructive and the dashboard sees the bot's writes immediately.

### Editing config

`config.json` is mounted into both containers read-only. Edit it on the host and restart only the bot:

```bash
docker compose restart bot
```

No rebuild is needed for config changes — only for code changes.

### Useful commands

```bash
docker compose ps                          # service status
docker compose exec bot python bot_v2.py status   # status report inside the bot container
docker compose exec bot python bot_v2.py report   # full report
docker compose down -v                     # stop and wipe volumes (keeps ./data on host)
```

---

## Data Storage

All data is saved to `data/markets/` — one JSON file per market. Each file contains:
- Hourly forecast snapshots (ECMWF, HRRR, METAR)
- Market price history
- Position details (entry, stop, PnL)
- Final resolution outcome

This data is used for self-calibration — the bot learns forecast accuracy per city over time and adjusts position sizing accordingly.

---

## APIs Used

| API | Auth | Purpose |
|-----|------|---------|
| Open-Meteo | None | ECMWF + HRRR forecasts |
| Aviation Weather (METAR) | None | Real-time station observations |
| Polymarket Gamma | None | Market data |
| Visual Crossing | Free key | Historical temps for resolution |

---

## Disclaimer

This is not financial advice. Prediction markets carry real risk. Run the simulation thoroughly before committing real capital.
