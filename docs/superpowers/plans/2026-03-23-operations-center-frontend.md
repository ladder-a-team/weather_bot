# WeatherBet Operations Center — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real-time Bloomberg-style dashboard that displays all WeatherBet trading bot data (positions, forecasts, markets, calibration) in a single-page operations center.

**Architecture:** Separate FastAPI process reads the bot's existing JSON files (`data/state.json`, `data/markets/*.json`, `data/calibration.json`) and serves a Jinja2-rendered single-page dashboard. WebSocket push via filesystem watching provides real-time updates; REST endpoints provide initial load and polling fallback.

**Tech Stack:** FastAPI, uvicorn, Jinja2, watchfiles, psutil (backend); HTMX, Chart.js, Leaflet.js (frontend CDN)

**Spec:** `docs/superpowers/specs/2026-03-23-operations-center-frontend-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `requirements.txt` (create) | Python dependencies for both bot and dashboard |
| `dashboard.py` (create) | FastAPI server: REST endpoints, WebSocket, file watching, data reading, activity reconstruction |
| `templates/index.html` (create) | Jinja2 template: full single-page layout with all panels, HTMX attributes |
| `static/style.css` (create) | Bloomberg dark theme: colors, grid layout, panel styling, KPI cards |
| `static/dashboard.js` (create) | Client-side: WebSocket connection, Chart.js balance chart, Leaflet map, polling fallback, panel updates |

---

## Task 1: Project Setup & Dependencies

**Files:**
- Create: `requirements.txt`

- [ ] **Step 1: Create requirements.txt**

```
requests>=2.28.0
fastapi>=0.115.0
uvicorn>=0.30.0
jinja2>=3.1.0
watchfiles>=0.20.0
psutil>=5.9.0
```

- [ ] **Step 2: Install dependencies**

Run: `pip install -r requirements.txt`
Expected: All packages install successfully

- [ ] **Step 3: Create directories**

Run: `mkdir -p templates static`
Expected: Both directories created

- [ ] **Step 4: Commit**

```bash
git add requirements.txt
git commit -m "feat: add requirements.txt with dashboard dependencies"
```

---

## Task 2: Dashboard Backend — Data Reading & REST API

**Files:**
- Create: `dashboard.py`

- [ ] **Step 1: Create dashboard.py with imports, constants, and data reading functions**

```python
#!/usr/bin/env python3
"""WeatherBet Operations Center — Real-time Dashboard Server"""

import json
import asyncio
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import psutil
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
STATE_FILE = DATA_DIR / "state.json"
MARKETS_DIR = DATA_DIR / "markets"
CALIBRATION_FILE = DATA_DIR / "calibration.json"

# ---------------------------------------------------------------------------
# City coordinates (duplicated from bot_v2.py LOCATIONS)
# ---------------------------------------------------------------------------
LOCATIONS = {
    "nyc":          {"lat": 40.7772,  "lon":  -73.8726, "name": "New York City",  "station": "KLGA", "unit": "F", "region": "us"},
    "chicago":      {"lat": 41.9742,  "lon":  -87.9073, "name": "Chicago",        "station": "KORD", "unit": "F", "region": "us"},
    "miami":        {"lat": 25.7959,  "lon":  -80.2870, "name": "Miami",          "station": "KMIA", "unit": "F", "region": "us"},
    "dallas":       {"lat": 32.8471,  "lon":  -96.8518, "name": "Dallas",         "station": "KDAL", "unit": "F", "region": "us"},
    "seattle":      {"lat": 47.4502,  "lon": -122.3088, "name": "Seattle",        "station": "KSEA", "unit": "F", "region": "us"},
    "atlanta":      {"lat": 33.6407,  "lon":  -84.4277, "name": "Atlanta",        "station": "KATL", "unit": "F", "region": "us"},
    "london":       {"lat": 51.5048,  "lon":    0.0495, "name": "London",         "station": "EGLC", "unit": "C", "region": "eu"},
    "paris":        {"lat": 48.9962,  "lon":    2.5979, "name": "Paris",          "station": "LFPG", "unit": "C", "region": "eu"},
    "munich":       {"lat": 48.3537,  "lon":   11.7750, "name": "Munich",         "station": "EDDM", "unit": "C", "region": "eu"},
    "ankara":       {"lat": 40.1281,  "lon":   32.9951, "name": "Ankara",         "station": "LTAC", "unit": "C", "region": "eu"},
    "seoul":        {"lat": 37.4691,  "lon":  126.4505, "name": "Seoul",          "station": "RKSI", "unit": "C", "region": "asia"},
    "tokyo":        {"lat": 35.7647,  "lon":  140.3864, "name": "Tokyo",          "station": "RJTT", "unit": "C", "region": "asia"},
    "shanghai":     {"lat": 31.1443,  "lon":  121.8083, "name": "Shanghai",       "station": "ZSPD", "unit": "C", "region": "asia"},
    "singapore":    {"lat":  1.3502,  "lon":  103.9940, "name": "Singapore",      "station": "WSSS", "unit": "C", "region": "asia"},
    "lucknow":      {"lat": 26.7606,  "lon":   80.8893, "name": "Lucknow",        "station": "VILK", "unit": "C", "region": "asia"},
    "tel-aviv":     {"lat": 32.0114,  "lon":   34.8867, "name": "Tel Aviv",       "station": "LLBG", "unit": "C", "region": "asia"},
    "toronto":      {"lat": 43.6772,  "lon":  -79.6306, "name": "Toronto",        "station": "CYYZ", "unit": "C", "region": "ca"},
    "sao-paulo":    {"lat": -23.4356, "lon":  -46.4731, "name": "Sao Paulo",      "station": "SBGR", "unit": "C", "region": "sa"},
    "buenos-aires": {"lat": -34.8222, "lon":  -58.5358, "name": "Buenos Aires",   "station": "SAEZ", "unit": "C", "region": "sa"},
    "wellington":   {"lat": -41.3272, "lon":  174.8052, "name": "Wellington",      "station": "NZWN", "unit": "C", "region": "oc"},
}

# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------
balance_history: list[dict] = []          # [{"ts": iso_str, "balance": float}, ...]
activity_feed: deque[dict] = deque(maxlen=100)
previous_markets: dict = {}               # key -> market dict (for diff)
connected_clients: set[WebSocket] = set()


# ---------------------------------------------------------------------------
# Data reading helpers
# ---------------------------------------------------------------------------
def read_json(path: Path) -> Optional[dict]:
    """Read a JSON file, return None if missing or corrupt."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def read_state() -> dict:
    """Read state.json, return defaults if missing."""
    data = read_json(STATE_FILE)
    if data is None:
        return {
            "balance": 0, "starting_balance": 0, "total_trades": 0,
            "wins": 0, "losses": 0, "peak_balance": 0,
        }
    return data


def read_all_markets() -> dict:
    """Read all market JSON files, return dict keyed by filename stem."""
    markets = {}
    if not MARKETS_DIR.exists():
        return markets
    for f in sorted(MARKETS_DIR.glob("*.json")):
        data = read_json(f)
        if data:
            markets[f.stem] = data
    return markets


def read_calibration() -> Optional[dict]:
    """Read calibration.json, return None if not yet created."""
    return read_json(CALIBRATION_FILE)


def check_bot_status() -> dict:
    """Check if bot_v2.py is running."""
    for proc in psutil.process_iter(["pid", "cmdline"]):
        try:
            cmdline = proc.info.get("cmdline") or []
            if any("bot_v2.py" in arg for arg in cmdline):
                return {"running": True, "pid": proc.info["pid"]}
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    # Fallback: check last modification time of state.json
    if STATE_FILE.exists():
        mtime = datetime.fromtimestamp(STATE_FILE.stat().st_mtime, tz=timezone.utc)
        return {"running": False, "pid": None, "last_update": mtime.isoformat()}
    return {"running": False, "pid": None, "last_update": None}


# ---------------------------------------------------------------------------
# Activity reconstruction
# ---------------------------------------------------------------------------
def detect_changes(old_markets: dict, new_markets: dict) -> list[dict]:
    """Compare market snapshots and generate activity feed events."""
    events = []
    now = datetime.now(timezone.utc).isoformat()

    for key, new_data in new_markets.items():
        old_data = old_markets.get(key)
        city = new_data.get("city_name", key)

        if old_data is None:
            # New market discovered
            events.append({"ts": now, "type": "scan", "msg": f"SCAN New market: {city} {new_data.get('date', '')}"})
            continue

        old_pos = old_data.get("position")
        new_pos = new_data.get("position")

        # New position opened
        if old_pos is None and new_pos is not None:
            bucket = f"{new_pos.get('bucket_low')}-{new_pos.get('bucket_high')}{new_data.get('unit', '')}"
            events.append({
                "ts": now, "type": "buy",
                "msg": f"BUY {city} ${new_pos.get('cost', 0):.0f} @ {new_pos.get('entry_price', 0):.3f} bucket {bucket} (EV +{new_pos.get('ev', 0):.2f})"
            })

        # Position closed
        if old_pos and new_pos and old_pos.get("status") == "open" and new_pos.get("status") == "closed":
            reason = new_pos.get("close_reason", "unknown")
            pnl = new_pos.get("pnl", 0) or 0
            sign = "+" if pnl >= 0 else ""
            events.append({
                "ts": now, "type": "stop" if pnl < 0 else "resolved",
                "msg": f"EXIT {city} {reason} @ {new_pos.get('exit_price', 0):.3f} ({sign}${pnl:.2f})"
            })

        # New forecast snapshot
        old_snaps = len(old_data.get("forecast_snapshots", []))
        new_snaps = len(new_data.get("forecast_snapshots", []))
        if new_snaps > old_snaps:
            latest = new_data["forecast_snapshots"][-1]
            events.append({
                "ts": now, "type": "monitor",
                "msg": f"FORECAST {city} {latest.get('best_source', '').upper()} {latest.get('best')}°"
            })

    return events


# ---------------------------------------------------------------------------
# Aggregate data for API / WebSocket
# ---------------------------------------------------------------------------
def build_dashboard_data() -> dict:
    """Build the complete dashboard payload."""
    state = read_state()
    markets = read_all_markets()
    calibration = read_calibration()
    bot_status = check_bot_status()

    # Compute derived KPIs
    open_positions = []
    forecasts = []
    for key, m in markets.items():
        pos = m.get("position")
        if pos and pos.get("status") == "open":
            open_positions.append({
                "city": m["city"],
                "city_name": m.get("city_name", m["city"]),
                "date": m["date"],
                "unit": m.get("unit", "F"),
                "bucket_low": pos.get("bucket_low"),
                "bucket_high": pos.get("bucket_high"),
                "entry_price": pos.get("entry_price"),
                "ev": pos.get("ev"),
                "kelly": pos.get("kelly"),
                "cost": pos.get("cost"),
                "pnl": pos.get("pnl"),
                "forecast_src": pos.get("forecast_src"),
                "sigma": pos.get("sigma"),
            })

        # Latest forecast
        snaps = m.get("forecast_snapshots", [])
        if snaps:
            latest = snaps[-1]
            forecasts.append({
                "city": m["city"],
                "city_name": m.get("city_name", m["city"]),
                "date": m["date"],
                "unit": m.get("unit", "F"),
                "horizon": latest.get("horizon"),
                "ecmwf": latest.get("ecmwf"),
                "hrrr": latest.get("hrrr"),
                "metar": latest.get("metar"),
                "best": latest.get("best"),
                "best_source": latest.get("best_source"),
            })

    total_resolved = state.get("wins", 0) + state.get("losses", 0)
    win_rate = (state["wins"] / total_resolved * 100) if total_resolved > 0 else None
    pnl = state.get("balance", 0) - state.get("starting_balance", 0)
    peak = state.get("peak_balance", 0)
    drawdown = ((state.get("balance", 0) - peak) / peak * 100) if peak > 0 else 0

    return {
        "state": state,
        "kpi": {
            "balance": state.get("balance", 0),
            "pnl": round(pnl, 2),
            "open_count": len(open_positions),
            "win_rate": round(win_rate, 1) if win_rate is not None else None,
            "peak_balance": peak,
            "drawdown": round(drawdown, 1),
        },
        "open_positions": open_positions,
        "forecasts": forecasts,
        "calibration": calibration,
        "bot_status": bot_status,
        "balance_history": balance_history,
        "activity": list(activity_feed),
        "locations": LOCATIONS,
    }


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="WeatherBet Operations Center")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    data = build_dashboard_data()
    return templates.TemplateResponse("index.html", {"request": request, "data": data})


@app.get("/api/state")
async def api_state():
    return read_state()


@app.get("/api/markets")
async def api_markets():
    return read_all_markets()


@app.get("/api/markets/{city}/{date}")
async def api_market_detail(city: str, date: str):
    key = f"{city}_{date}"
    data = read_json(MARKETS_DIR / f"{key}.json")
    if data is None:
        return {"error": "not found"}
    return data


@app.get("/api/calibration")
async def api_calibration():
    data = read_calibration()
    if data is None:
        return {"status": "not_available"}
    return data


@app.get("/api/bot-status")
async def api_bot_status():
    return check_bot_status()


@app.get("/api/dashboard")
async def api_dashboard():
    return build_dashboard_data()


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    connected_clients.add(ws)
    try:
        # Send full state on connect
        data = build_dashboard_data()
        await ws.send_json({"type": "full_update", "data": data})
        # Keep alive — client sends pings, we just wait
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        connected_clients.discard(ws)


async def broadcast(message: dict):
    """Send a message to all connected WebSocket clients."""
    dead = set()
    for ws in connected_clients:
        try:
            await ws.send_json(message)
        except Exception:
            dead.add(ws)
    connected_clients.difference_update(dead)


# ---------------------------------------------------------------------------
# File watcher background task
# ---------------------------------------------------------------------------
async def watch_data_directory():
    """Watch data/ for changes and push updates via WebSocket."""
    global previous_markets

    from watchfiles import awatch

    # Initial state
    previous_markets = read_all_markets()
    state = read_state()
    if state.get("balance"):
        balance_history.append({
            "ts": datetime.now(timezone.utc).isoformat(),
            "balance": state["balance"],
        })

    async for changes in awatch(str(DATA_DIR)):
        for change_type, path in changes:
            path = Path(path)

            if path.name == "state.json":
                new_state = read_state()
                # Record balance history
                if balance_history:
                    last_bal = balance_history[-1]["balance"]
                else:
                    last_bal = None
                if new_state.get("balance") != last_bal:
                    balance_history.append({
                        "ts": datetime.now(timezone.utc).isoformat(),
                        "balance": new_state["balance"],
                    })
                await broadcast({"type": "state_update", "data": build_dashboard_data()})

            elif path.suffix == ".json" and path.parent == MARKETS_DIR:
                new_markets = read_all_markets()
                events = detect_changes(previous_markets, new_markets)
                for ev in events:
                    activity_feed.append(ev)
                previous_markets = new_markets
                await broadcast({"type": "market_update", "data": build_dashboard_data()})

            elif path.name == "calibration.json":
                await broadcast({"type": "calibration_update", "data": build_dashboard_data()})


@app.on_event("startup")
async def startup():
    asyncio.create_task(watch_data_directory())


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="WeatherBet Dashboard")
    parser.add_argument("--port", type=int, default=8050)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
```

- [ ] **Step 2: Verify the server starts without errors (no templates yet, just test import)**

Run: `python -c "from dashboard import app; print('OK')"`
Expected: `OK` (FastAPI app instantiates, templates dir warning is fine)

- [ ] **Step 3: Commit**

```bash
git add dashboard.py
git commit -m "feat: add dashboard backend with REST API, WebSocket, and file watcher"
```

---

## Task 3: CSS Theme — Bloomberg Dark

**Files:**
- Create: `static/style.css`

- [ ] **Step 1: Create static/style.css**

```css
/* WeatherBet Operations Center — Bloomberg Dark Theme */

:root {
    --bg-main: #1a1d23;
    --bg-panel: #21262d;
    --bg-hover: #292e36;
    --border: #30363d;
    --text-primary: #e1e4e8;
    --text-secondary: #8b949e;
    --text-data: #c9d1d9;
    --accent-blue: #58a6ff;
    --accent-green: #3fb950;
    --accent-red: #f85149;
    --accent-yellow: #d29922;
    --font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    --font-mono: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
    font-family: var(--font-ui);
    background: var(--bg-main);
    color: var(--text-primary);
    overflow: hidden;
    height: 100vh;
}

/* ---- Status Bar ---- */
.status-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 16px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    font-size: 12px;
}

.status-bar .brand {
    font-weight: 600;
    font-size: 14px;
    margin-right: 12px;
}

.status-bar .left, .status-bar .right {
    display: flex;
    align-items: center;
    gap: 12px;
}

.status-bar .right {
    color: var(--text-secondary);
    font-size: 11px;
}

.live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    margin-right: 4px;
}

.live-dot.live {
    background: var(--accent-green);
    animation: pulse 2s infinite;
}

.live-dot.polling {
    background: var(--accent-yellow);
}

.live-dot.offline {
    background: var(--accent-red);
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}

.badge {
    font-size: 9px;
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: 600;
    text-transform: uppercase;
}

.badge-live { background: #238636; color: white; }
.badge-polling { background: #9e6a03; color: white; }
.badge-offline { background: #da3633; color: white; }
.badge-stopped { background: #da3633; color: white; }

/* ---- KPI Strip ---- */
.kpi-strip {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 1px;
    background: var(--border);
    border-bottom: 1px solid var(--border);
}

.kpi-card {
    background: var(--bg-panel);
    padding: 8px 12px;
}

.kpi-label {
    font-size: 9px;
    text-transform: uppercase;
    color: var(--text-secondary);
    letter-spacing: 0.5px;
}

.kpi-value {
    font-size: 18px;
    font-weight: 600;
    font-family: var(--font-mono);
    margin-top: 2px;
}

.kpi-sub {
    font-size: 10px;
    margin-top: 1px;
}

.text-green { color: var(--accent-green); }
.text-red { color: var(--accent-red); }
.text-yellow { color: var(--accent-yellow); }
.text-blue { color: var(--accent-blue); }
.text-muted { color: var(--text-secondary); }

/* ---- Main Grid ---- */
.main-grid {
    display: grid;
    grid-template-columns: 1fr 1.5fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 1px;
    background: var(--border);
    height: calc(100vh - 80px); /* status bar + kpi strip */
}

/* ---- Panels ---- */
.panel {
    background: var(--bg-main);
    padding: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

.panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    font-size: 10px;
    text-transform: uppercase;
    color: var(--text-secondary);
    letter-spacing: 0.5px;
    flex-shrink: 0;
}

.panel-header .count {
    font-family: var(--font-mono);
}

/* Map panel spans 2 rows */
.panel-map {
    grid-row: span 2;
}

/* Right panel spans 2 rows */
.panel-right {
    grid-row: span 2;
    display: flex;
    flex-direction: column;
}

#map {
    flex: 1;
    border-radius: 4px;
    min-height: 0;
}

/* ---- City Cards (below map) ---- */
.city-cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    margin-top: 8px;
    max-height: 140px;
    overflow-y: auto;
    flex-shrink: 0;
}

.city-card {
    background: var(--bg-panel);
    border-radius: 3px;
    padding: 4px 6px;
    border-left: 2px solid var(--text-secondary);
    font-size: 10px;
}

.city-card.profitable { border-left-color: var(--accent-green); }
.city-card.losing { border-left-color: var(--accent-red); }
.city-card .city-code { font-weight: 600; color: var(--text-primary); }
.city-card .city-detail { color: var(--text-secondary); font-size: 9px; }

/* ---- Balance Chart ---- */
.chart-container {
    flex: 1;
    background: var(--bg-panel);
    border-radius: 4px;
    padding: 8px;
    min-height: 0;
    position: relative;
}

/* ---- Positions Table ---- */
.positions-table {
    background: var(--bg-panel);
    border-radius: 4px;
    overflow: hidden;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
}

.table-header, .table-row {
    display: grid;
    grid-template-columns: 50px 80px 60px 50px 50px 60px;
    padding: 4px 8px;
    font-size: 10px;
    align-items: center;
}

.table-header {
    color: var(--text-secondary);
    text-transform: uppercase;
    font-size: 9px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
}

.table-body {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
}

.table-row {
    color: var(--text-data);
    border-bottom: 1px solid rgba(48, 54, 61, 0.3);
    cursor: pointer;
    transition: background 0.15s;
}

.table-row:hover {
    background: var(--bg-hover);
}

/* ---- Activity Feed ---- */
.activity-feed {
    background: var(--bg-panel);
    border-radius: 4px;
    padding: 8px;
    font-family: var(--font-mono);
    font-size: 10px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    margin-top: 8px;
}

.activity-entry {
    padding: 1px 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.activity-entry.buy { color: var(--accent-green); }
.activity-entry.stop { color: var(--accent-red); }
.activity-entry.monitor { color: var(--accent-yellow); }
.activity-entry.scan { color: var(--accent-blue); }
.activity-entry.resolved { color: var(--text-primary); }

/* ---- Forecast Table ---- */
.forecast-table {
    background: var(--bg-panel);
    border-radius: 4px;
    overflow: hidden;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
}

.forecast-header, .forecast-row {
    display: grid;
    grid-template-columns: 50px 50px 50px 50px 50px;
    padding: 3px 6px;
    font-size: 10px;
}

.forecast-header {
    color: var(--text-secondary);
    text-transform: uppercase;
    font-size: 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
}

.forecast-body {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
}

.forecast-row {
    color: var(--text-data);
    border-bottom: 1px solid rgba(48, 54, 61, 0.2);
}

.forecast-row .best { color: var(--accent-green); font-weight: 600; }

/* ---- Calibration Bars ---- */
.calibration-section {
    margin-top: 10px;
    flex-shrink: 0;
}

.calibration-entry {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
    font-size: 10px;
}

.calibration-entry .label {
    color: var(--text-data);
    width: 90px;
    flex-shrink: 0;
}

.calibration-bar-track {
    flex: 1;
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
    margin: 0 6px;
}

.calibration-bar-fill {
    height: 100%;
    border-radius: 2px;
}

.calibration-value {
    font-family: var(--font-mono);
    font-size: 10px;
    width: 50px;
    text-align: right;
    flex-shrink: 0;
}

/* ---- Scrollbar styling ---- */
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-secondary); }

/* ---- Empty states ---- */
.empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-secondary);
    font-size: 12px;
    font-style: italic;
}

/* ---- Leaflet marker overrides ---- */
.city-marker {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 2px 5px;
    font-size: 9px;
    white-space: nowrap;
    font-family: var(--font-ui);
    line-height: 1.3;
}

.city-marker .code { font-weight: 600; color: var(--text-primary); }
.city-marker .temp { color: var(--text-secondary); margin: 0 3px; }
.city-marker .ev { font-weight: 600; }

.leaflet-popup-content-wrapper {
    background: var(--bg-panel) !important;
    color: var(--text-primary) !important;
    border-radius: 4px !important;
    border: 1px solid var(--border) !important;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4) !important;
}

.leaflet-popup-tip {
    background: var(--bg-panel) !important;
    border: 1px solid var(--border) !important;
}

.popup-detail {
    font-size: 11px;
    line-height: 1.5;
}

.popup-detail .label { color: var(--text-secondary); font-size: 9px; text-transform: uppercase; }
.popup-detail .value { color: var(--text-data); font-family: var(--font-mono); }
```

- [ ] **Step 2: Commit**

```bash
git add static/style.css
git commit -m "feat: add Bloomberg dark theme CSS for dashboard"
```

---

## Task 4: Jinja2 Template — Dashboard Layout

**Files:**
- Create: `templates/index.html`

- [ ] **Step 1: Create templates/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WeatherBet // Operations Center</title>
    <link rel="stylesheet" href="/static/style.css">
    <!-- Leaflet CSS -->
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
</head>
<body>

<!-- Status Bar -->
<div class="status-bar">
    <div class="left">
        <span class="brand">WeatherBet</span>
        <span class="live-dot live" id="connection-dot"></span>
        <span class="badge badge-live" id="connection-badge">LIVE</span>
        <span class="text-muted" id="last-scan">—</span>
    </div>
    <div class="right">
        <span>Scan interval: 60m</span>
        <span id="bot-status">Bot: checking...</span>
    </div>
</div>

<!-- KPI Strip -->
<div class="kpi-strip" id="kpi-strip">
    <div class="kpi-card">
        <div class="kpi-label">Balance</div>
        <div class="kpi-value" id="kpi-balance">${{ "%.2f"|format(data.kpi.balance) }}</div>
    </div>
    <div class="kpi-card">
        <div class="kpi-label">Total P&L</div>
        <div class="kpi-value {{ 'text-green' if data.kpi.pnl >= 0 else 'text-red' }}" id="kpi-pnl">
            {{ "+" if data.kpi.pnl >= 0 else "" }}${{ "%.2f"|format(data.kpi.pnl) }}
        </div>
    </div>
    <div class="kpi-card">
        <div class="kpi-label">Open Positions</div>
        <div class="kpi-value" id="kpi-open">{{ data.kpi.open_count }}</div>
    </div>
    <div class="kpi-card">
        <div class="kpi-label">Win Rate</div>
        <div class="kpi-value" id="kpi-winrate">{{ "%.1f%%"|format(data.kpi.win_rate) if data.kpi.win_rate is not none else "—" }}</div>
    </div>
    <div class="kpi-card">
        <div class="kpi-label">Peak Balance</div>
        <div class="kpi-value" id="kpi-peak">${{ "%.2f"|format(data.kpi.peak_balance) }}</div>
    </div>
    <div class="kpi-card">
        <div class="kpi-label">Drawdown</div>
        <div class="kpi-value {{ 'text-red' if data.kpi.drawdown < 0 else 'text-muted' }}" id="kpi-drawdown">
            {{ "%.1f"|format(data.kpi.drawdown) }}%
        </div>
    </div>
</div>

<!-- Main Grid -->
<div class="main-grid">

    <!-- LEFT: Map Panel (spans 2 rows) -->
    <div class="panel panel-map">
        <div class="panel-header">
            <span>World Map</span>
            <span class="count">{{ data.locations|length }} cities</span>
        </div>
        <div id="map"></div>
        <div class="city-cards" id="city-cards">
            {% for key, m in data.locations.items() %}
            <div class="city-card" id="card-{{ key }}">
                <div class="city-code">{{ key.upper()[:3] }}</div>
                <div class="city-detail">{{ m.name }}</div>
            </div>
            {% endfor %}
        </div>
    </div>

    <!-- CENTER TOP: Balance Chart -->
    <div class="panel">
        <div class="panel-header">
            <span>Balance History</span>
        </div>
        <div class="chart-container">
            <canvas id="balance-chart"></canvas>
        </div>
    </div>

    <!-- RIGHT: Forecasts + Calibration (spans 2 rows) -->
    <div class="panel panel-right">
        <div class="panel-header">
            <span>Forecast Sources</span>
        </div>
        <div class="forecast-table">
            <div class="forecast-header">
                <span>City</span><span>ECMWF</span><span>HRRR</span><span>METAR</span><span>Best</span>
            </div>
            <div class="forecast-body" id="forecast-body">
                {% for f in data.forecasts %}
                <div class="forecast-row">
                    <span style="font-weight:600;">{{ f.city.upper()[:3] }}</span>
                    <span>{{ f.ecmwf if f.ecmwf is not none else "—" }}°</span>
                    <span>{{ f.hrrr if f.hrrr is not none else "—" }}°</span>
                    <span>{{ f.metar if f.metar is not none else "—" }}°</span>
                    <span class="best">{{ f.best }}°{{ f.unit }}</span>
                </div>
                {% endfor %}
                {% if not data.forecasts %}
                <div class="empty-state">Waiting for first scan...</div>
                {% endif %}
            </div>
        </div>

        <div class="calibration-section">
            <div class="panel-header">
                <span>Calibration (σ)</span>
            </div>
            <div id="calibration-bars">
                {% if data.calibration %}
                    {% for key, val in data.calibration.items() %}
                        {% if val.n >= 10 %}
                        <div class="calibration-entry">
                            <span class="label">{{ key }}</span>
                            <div class="calibration-bar-track">
                                <div class="calibration-bar-fill"
                                     style="width: {{ [val.sigma / 4 * 100, 100] | min }}%;
                                            background: {{ 'var(--accent-green)' if val.sigma < 1.5 else ('var(--accent-yellow)' if val.sigma < 2.5 else 'var(--accent-red)') }};">
                                </div>
                            </div>
                            <span class="calibration-value {{ 'text-green' if val.sigma < 1.5 else ('text-yellow' if val.sigma < 2.5 else 'text-red') }}">
                                σ={{ "%.1f"|format(val.sigma) }}
                            </span>
                        </div>
                        {% endif %}
                    {% endfor %}
                {% else %}
                <div class="empty-state" style="height:auto;padding:12px;">
                    Calibration data not yet available — requires resolved markets
                </div>
                {% endif %}
            </div>
        </div>
    </div>

    <!-- CENTER BOTTOM: Positions + Activity -->
    <div class="panel" style="display:flex;flex-direction:column;">
        <div class="panel-header">
            <span>Open Positions</span>
            <span class="count" id="positions-count">{{ data.open_positions|length }} active</span>
        </div>
        <div class="positions-table">
            <div class="table-header">
                <span>City</span><span>Bucket</span><span>Entry</span><span>EV</span><span>Kelly</span><span>P&L</span>
            </div>
            <div class="table-body" id="positions-body">
                {% for p in data.open_positions %}
                <div class="table-row">
                    <span>{{ p.city.upper()[:3] }}</span>
                    <span>{{ p.bucket_low }}-{{ p.bucket_high }}°{{ p.unit }}</span>
                    <span>${{ "%.3f"|format(p.entry_price) }}</span>
                    <span class="text-green">+{{ "%.2f"|format(p.ev) }}</span>
                    <span>{{ "%.2f"|format(p.kelly) }}</span>
                    <span class="{{ 'text-green' if p.pnl and p.pnl >= 0 else 'text-red' if p.pnl else 'text-muted' }}">
                        {{ ("$%.2f"|format(p.pnl)) if p.pnl else "—" }}
                    </span>
                </div>
                {% endfor %}
                {% if not data.open_positions %}
                <div class="empty-state">No open positions</div>
                {% endif %}
            </div>
        </div>

        <div class="panel-header" style="margin-top:8px;">
            <span>Activity Feed</span>
            <span class="count">Live</span>
        </div>
        <div class="activity-feed" id="activity-feed">
            {% for ev in data.activity %}
            <div class="activity-entry {{ ev.type }}">{{ ev.ts[:19] }} {{ ev.msg }}</div>
            {% endfor %}
            {% if not data.activity %}
            <div class="activity-entry scan">Waiting for activity...</div>
            {% endif %}
        </div>
    </div>

</div>

<!-- Scripts -->
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0"></script>
<!-- Pass server data to JS -->
<script>
    window.__DASHBOARD_DATA__ = {{ data | tojson }};
</script>
<script src="/static/dashboard.js"></script>

</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add templates/index.html
git commit -m "feat: add Jinja2 dashboard template with all panels"
```

---

## Task 5: Client-Side JavaScript — Map, Chart, WebSocket

**Files:**
- Create: `static/dashboard.js`

- [ ] **Step 1: Create static/dashboard.js**

```javascript
/* WeatherBet Operations Center — Client-side logic */

(function () {
    "use strict";

    const DATA = window.__DASHBOARD_DATA__;
    let ws = null;
    let reconnectDelay = 1000;

    // =========================================================================
    // Leaflet Map
    // =========================================================================
    const map = L.map("map", {
        zoomControl: false,
        attributionControl: false,
    }).setView([20, 0], 2);

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 18,
    }).addTo(map);

    const markers = {};

    function buildMarkerHtml(city, loc, forecasts, positions) {
        const code = city.toUpperCase().slice(0, 3);
        const forecast = forecasts.find(f => f.city === city);
        const position = positions.find(p => p.city === city);

        let temp = "";
        let evText = "";
        let dotColor = "#8b949e";

        if (forecast) {
            temp = forecast.best + "°" + forecast.unit;
        }
        if (position) {
            const ev = position.ev || 0;
            evText = (ev >= 0 ? "+" : "") + ev.toFixed(2);
            const pnl = position.pnl || 0;
            dotColor = pnl >= 0 ? "#3fb950" : "#f85149";
        }

        return `<div class="city-marker">` +
            `<span class="code">${code}</span>` +
            `<span class="temp">${temp}</span>` +
            (evText ? `<span class="ev" style="color:${dotColor}">${evText}</span>` : "") +
            `</div>`;
    }

    function buildPopupHtml(city, loc, forecasts, positions) {
        const forecast = forecasts.find(f => f.city === city);
        const position = positions.find(p => p.city === city);

        let html = `<div class="popup-detail">`;
        html += `<div style="font-weight:600;font-size:13px;margin-bottom:4px;">${loc.name}</div>`;

        if (forecast) {
            html += `<div class="label">Forecasts</div>`;
            html += `<div class="value">ECMWF: ${forecast.ecmwf ?? "—"}° | HRRR: ${forecast.hrrr ?? "—"}° | METAR: ${forecast.metar ?? "—"}°</div>`;
            html += `<div class="value">Best: <span style="color:#3fb950;font-weight:600;">${forecast.best}°${forecast.unit}</span> (${(forecast.best_source || "").toUpperCase()})</div>`;
            html += `<div class="value">Horizon: ${forecast.horizon || "—"} | Date: ${forecast.date || "—"}</div>`;
        }

        if (position) {
            html += `<div class="label" style="margin-top:6px;">Position</div>`;
            html += `<div class="value">Bucket: ${position.bucket_low}-${position.bucket_high}°${position.unit}</div>`;
            html += `<div class="value">Entry: $${position.entry_price?.toFixed(3)} | Cost: $${position.cost?.toFixed(0)}</div>`;
            html += `<div class="value">EV: +${position.ev?.toFixed(2)} | Kelly: ${position.kelly?.toFixed(2)} | σ: ${position.sigma?.toFixed(1)}</div>`;
            const pnl = position.pnl;
            if (pnl !== null && pnl !== undefined) {
                const color = pnl >= 0 ? "#3fb950" : "#f85149";
                html += `<div class="value">P&L: <span style="color:${color};font-weight:600;">$${pnl.toFixed(2)}</span></div>`;
            }
        }

        html += `</div>`;
        return html;
    }

    function updateMap(data) {
        const locations = data.locations || {};
        const forecasts = data.forecasts || [];
        const positions = data.open_positions || [];

        for (const [city, loc] of Object.entries(locations)) {
            const html = buildMarkerHtml(city, loc, forecasts, positions);
            const icon = L.divIcon({
                html: html,
                className: "",
                iconAnchor: [0, 0],
            });

            if (markers[city]) {
                markers[city].setIcon(icon);
                markers[city].setPopupContent(buildPopupHtml(city, loc, forecasts, positions));
            } else {
                markers[city] = L.marker([loc.lat, loc.lon], { icon: icon })
                    .addTo(map)
                    .bindPopup(buildPopupHtml(city, loc, forecasts, positions), {
                        maxWidth: 280,
                    });
            }
        }

        // Fit bounds only on first load (don't reset user's zoom/pan on updates)
        if (!map._boundsSet) {
            const bounds = Object.values(locations).map(l => [l.lat, l.lon]);
            if (bounds.length > 0) {
                map.fitBounds(bounds, { padding: [20, 20] });
                map._boundsSet = true;
            }
        }
    }

    // =========================================================================
    // Chart.js — Balance History
    // =========================================================================
    const ctx = document.getElementById("balance-chart").getContext("2d");
    const balanceChart = new Chart(ctx, {
        type: "line",
        data: {
            labels: [],
            datasets: [{
                data: [],
                borderColor: "#58a6ff",
                backgroundColor: "rgba(88,166,255,0.1)",
                fill: true,
                tension: 0.3,
                pointRadius: 2,
                pointHoverRadius: 4,
                borderWidth: 1.5,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: "#21262d",
                    titleColor: "#e1e4e8",
                    bodyColor: "#c9d1d9",
                    borderColor: "#30363d",
                    borderWidth: 1,
                    callbacks: {
                        label: function (ctx) {
                            return "$" + ctx.parsed.y.toFixed(2);
                        },
                    },
                },
            },
            scales: {
                x: {
                    display: true,
                    ticks: { color: "#8b949e", font: { size: 9 }, maxTicksLimit: 6 },
                    grid: { color: "rgba(48,54,61,0.5)", drawBorder: false },
                },
                y: {
                    display: true,
                    ticks: {
                        color: "#8b949e",
                        font: { size: 9 },
                        callback: v => "$" + v,
                    },
                    grid: { color: "rgba(48,54,61,0.5)", drawBorder: false },
                },
            },
        },
    });

    function updateChart(history) {
        if (!history || history.length === 0) return;
        balanceChart.data.labels = history.map(h => {
            const d = new Date(h.ts);
            return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        });
        balanceChart.data.datasets[0].data = history.map(h => h.balance);
        balanceChart.update("none");
    }

    // =========================================================================
    // Update city cards
    // =========================================================================
    function updateCityCards(data) {
        const container = document.getElementById("city-cards");
        const forecasts = data.forecasts || [];
        const positions = data.open_positions || [];
        const locations = data.locations || {};

        let html = "";
        for (const [key, loc] of Object.entries(locations)) {
            const forecast = forecasts.find(f => f.city === key);
            const position = positions.find(p => p.city === key);

            let statusClass = "";
            if (position) {
                statusClass = (position.pnl || 0) >= 0 ? "profitable" : "losing";
            }

            const temp = forecast ? `${forecast.best}°${forecast.unit}` : "—";
            const bucket = position ? `${position.bucket_low}-${position.bucket_high}` : "—";
            const price = position ? `$${position.entry_price.toFixed(2)}` : "—";

            html += `<div class="city-card ${statusClass}">` +
                `<div class="city-code">${key.toUpperCase().slice(0, 3)}</div>` +
                `<div class="city-detail">${temp} → ${bucket} @ ${price}</div>` +
                `</div>`;
        }
        container.innerHTML = html;
    }

    // =========================================================================
    // Update KPIs
    // =========================================================================
    function updateKPIs(kpi) {
        document.getElementById("kpi-balance").textContent = "$" + kpi.balance.toFixed(2);

        const pnlEl = document.getElementById("kpi-pnl");
        pnlEl.textContent = (kpi.pnl >= 0 ? "+" : "") + "$" + kpi.pnl.toFixed(2);
        pnlEl.className = "kpi-value " + (kpi.pnl >= 0 ? "text-green" : "text-red");

        document.getElementById("kpi-open").textContent = kpi.open_count;
        document.getElementById("kpi-winrate").textContent = kpi.win_rate !== null ? kpi.win_rate.toFixed(1) + "%" : "—";
        document.getElementById("kpi-peak").textContent = "$" + kpi.peak_balance.toFixed(2);

        const ddEl = document.getElementById("kpi-drawdown");
        ddEl.textContent = kpi.drawdown.toFixed(1) + "%";
        ddEl.className = "kpi-value " + (kpi.drawdown < 0 ? "text-red" : "text-muted");
    }

    // =========================================================================
    // Update Positions Table
    // =========================================================================
    function updatePositions(positions) {
        const body = document.getElementById("positions-body");
        const count = document.getElementById("positions-count");
        count.textContent = positions.length + " active";

        if (positions.length === 0) {
            body.innerHTML = '<div class="empty-state">No open positions</div>';
            return;
        }

        let html = "";
        for (const p of positions) {
            const pnlClass = p.pnl && p.pnl >= 0 ? "text-green" : p.pnl ? "text-red" : "text-muted";
            const pnlText = p.pnl !== null && p.pnl !== undefined ? "$" + p.pnl.toFixed(2) : "—";

            html += `<div class="table-row">` +
                `<span>${p.city.toUpperCase().slice(0, 3)}</span>` +
                `<span>${p.bucket_low}-${p.bucket_high}°${p.unit}</span>` +
                `<span>$${p.entry_price.toFixed(3)}</span>` +
                `<span class="text-green">+${p.ev.toFixed(2)}</span>` +
                `<span>${p.kelly.toFixed(2)}</span>` +
                `<span class="${pnlClass}">${pnlText}</span>` +
                `</div>`;
        }
        body.innerHTML = html;
    }

    // =========================================================================
    // Update Forecasts Table
    // =========================================================================
    function updateForecasts(forecasts) {
        const body = document.getElementById("forecast-body");

        if (!forecasts || forecasts.length === 0) {
            body.innerHTML = '<div class="empty-state">Waiting for first scan...</div>';
            return;
        }

        let html = "";
        for (const f of forecasts) {
            html += `<div class="forecast-row">` +
                `<span style="font-weight:600;">${f.city.toUpperCase().slice(0, 3)}</span>` +
                `<span>${f.ecmwf !== null && f.ecmwf !== undefined ? f.ecmwf + "°" : "—"}</span>` +
                `<span>${f.hrrr !== null && f.hrrr !== undefined ? f.hrrr + "°" : "—"}</span>` +
                `<span>${f.metar !== null && f.metar !== undefined ? f.metar + "°" : "—"}</span>` +
                `<span class="best">${f.best}°${f.unit}</span>` +
                `</div>`;
        }
        body.innerHTML = html;
    }

    // =========================================================================
    // Update Calibration
    // =========================================================================
    function updateCalibration(calibration) {
        const container = document.getElementById("calibration-bars");

        if (!calibration) {
            container.innerHTML = '<div class="empty-state" style="height:auto;padding:12px;">Calibration data not yet available — requires resolved markets</div>';
            return;
        }

        let html = "";
        for (const [key, val] of Object.entries(calibration)) {
            if (val.n < 10) continue;
            const pct = Math.min(val.sigma / 4 * 100, 100);
            const color = val.sigma < 1.5 ? "var(--accent-green)" : val.sigma < 2.5 ? "var(--accent-yellow)" : "var(--accent-red)";
            const textClass = val.sigma < 1.5 ? "text-green" : val.sigma < 2.5 ? "text-yellow" : "text-red";

            html += `<div class="calibration-entry">` +
                `<span class="label">${key}</span>` +
                `<div class="calibration-bar-track"><div class="calibration-bar-fill" style="width:${pct}%;background:${color};"></div></div>` +
                `<span class="calibration-value ${textClass}">σ=${val.sigma.toFixed(1)}</span>` +
                `</div>`;
        }
        container.innerHTML = html || '<div class="empty-state" style="height:auto;padding:12px;">No calibration entries with n≥10</div>';
    }

    // =========================================================================
    // Update Activity Feed
    // =========================================================================
    function updateActivity(events) {
        const feed = document.getElementById("activity-feed");
        if (!events || events.length === 0) return;

        let html = "";
        for (const ev of events) {
            const ts = ev.ts ? ev.ts.slice(11, 19) : "";
            html += `<div class="activity-entry ${ev.type}">${ts} ${ev.msg}</div>`;
        }
        feed.innerHTML = html;
        feed.scrollTop = feed.scrollHeight;
    }

    // =========================================================================
    // Update Bot Status
    // =========================================================================
    function updateBotStatus(status) {
        const el = document.getElementById("bot-status");
        if (status.running) {
            el.textContent = "Bot: PID " + status.pid;
        } else {
            el.innerHTML = '<span class="badge badge-stopped">STOPPED</span>';
        }
    }

    // =========================================================================
    // Full dashboard update
    // =========================================================================
    function updateDashboard(data) {
        updateKPIs(data.kpi);
        updateMap(data);
        updateChart(data.balance_history);
        updateCityCards(data);
        updatePositions(data.open_positions || []);
        updateForecasts(data.forecasts || []);
        updateCalibration(data.calibration);
        updateActivity(data.activity || []);
        updateBotStatus(data.bot_status || {});
    }

    // =========================================================================
    // Connection status UI
    // =========================================================================
    function setConnectionStatus(status) {
        const dot = document.getElementById("connection-dot");
        const badge = document.getElementById("connection-badge");

        dot.className = "live-dot " + status;
        badge.className = "badge badge-" + status;
        badge.textContent = status.toUpperCase();
    }

    // =========================================================================
    // WebSocket connection
    // =========================================================================
    let pollInterval = null;

    function connectWebSocket() {
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(`${protocol}//${location.host}/ws`);

        ws.onopen = function () {
            reconnectDelay = 1000;
            setConnectionStatus("live");
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
        };

        ws.onmessage = function (event) {
            const msg = JSON.parse(event.data);
            if (msg.data) {
                updateDashboard(msg.data);
            }
        };

        ws.onclose = function () {
            setConnectionStatus("polling");
            startPolling();
            // Reconnect with exponential backoff
            setTimeout(connectWebSocket, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        };

        ws.onerror = function () {
            ws.close();
        };
    }

    // =========================================================================
    // Polling fallback
    // =========================================================================
    function startPolling() {
        if (pollInterval) return;
        pollInterval = setInterval(async function () {
            try {
                const resp = await fetch("/api/dashboard");
                if (resp.ok) {
                    const data = await resp.json();
                    updateDashboard(data);
                    setConnectionStatus("polling");
                } else {
                    setConnectionStatus("offline");
                }
            } catch {
                setConnectionStatus("offline");
            }
        }, 30000);
    }

    // =========================================================================
    // Init
    // =========================================================================
    updateDashboard(DATA);
    connectWebSocket();

    // Keep WebSocket alive with pings
    setInterval(function () {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send("ping");
        }
    }, 30000);

})();
```

- [ ] **Step 2: Commit**

```bash
git add static/dashboard.js
git commit -m "feat: add client-side JS with map, chart, WebSocket, and polling fallback"
```

---

## Task 6: Integration Test & Polish

**Files:**
- Modify: `dashboard.py` (if needed)
- Modify: `templates/index.html` (if needed)
- Modify: `static/style.css` (if needed)
- Modify: `static/dashboard.js` (if needed)

- [ ] **Step 1: Start the dashboard and verify it loads**

Run: `python dashboard.py --port 8050 &`
Expected: Server starts, prints "Uvicorn running on http://0.0.0.0:8050"

- [ ] **Step 2: Open in browser and verify all panels render**

Open: `http://localhost:8050`
Expected:
- Status bar shows "WeatherBet", LIVE badge, bot status
- KPI strip shows 6 metrics with real data from state.json
- Map shows 20 city markers with CartoDB Dark Matter tiles
- Balance chart renders (single point initially)
- Positions table shows open positions from market files
- Forecast table shows latest forecasts per city
- Calibration shows empty state message (calibration.json may not exist)
- Activity feed shows "Waiting for activity..."

- [ ] **Step 3: Verify REST endpoints return data**

Run: `curl -s http://localhost:8050/api/state | python -m json.tool`
Expected: JSON with balance, starting_balance, total_trades, wins, losses, peak_balance

Run: `curl -s http://localhost:8050/api/markets | python -m json.tool | head -20`
Expected: JSON object with market data keyed by city_date

Run: `curl -s http://localhost:8050/api/bot-status | python -m json.tool`
Expected: JSON with running (true/false) and pid

- [ ] **Step 4: Verify WebSocket delivers updates**

Trigger a file change manually:
```bash
# Read current state, write it back to trigger watchfiles
python -c "
import json
with open('data/state.json') as f: d = json.load(f)
with open('data/state.json', 'w') as f: json.dump(d, f, indent=2)
"
```
Expected: Browser dashboard updates automatically (check browser console for WebSocket messages)

- [ ] **Step 5: Fix any visual/layout issues found during testing**

Check:
- Map markers are positioned correctly on all 20 cities
- No CSS overflow or panel collapsing
- Chart.js canvas fills its container
- Activity feed scrolls correctly
- City cards below map have colored left borders for positions

- [ ] **Step 6: Stop test server and commit final state**

Run: `kill %1` (or the appropriate PID)

```bash
git add -A
git commit -m "feat: complete WeatherBet operations center dashboard v1"
```

---

## Task 7: Add .gitignore entry

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add .superpowers/ to .gitignore**

Append `.superpowers/` to `.gitignore` to exclude brainstorm mockup files from version control.

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: add .superpowers/ to .gitignore"
```
