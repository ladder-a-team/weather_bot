#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dashboard.py — WeatherBet Operations Center Dashboard Backend
=============================================================
Reads JSON files written by bot_v2.py and serves a real-time UI via
FastAPI REST endpoints, WebSocket push, and a file-watcher background task.

Usage:
    python dashboard.py [--port 8050] [--host 0.0.0.0]
"""

import json
import asyncio
import argparse
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import psutil
import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from version import __version__

# =============================================================================
# PATH CONSTANTS
# =============================================================================

BASE_DIR         = Path(__file__).parent
DATA_DIR         = BASE_DIR / "data"
STATE_FILE       = DATA_DIR / "state.json"
MARKETS_DIR      = DATA_DIR / "markets"
CALIBRATION_FILE = DATA_DIR / "calibration.json"
HEARTBEAT_FILE   = DATA_DIR / "heartbeat.json"

# If the heartbeat is older than this, we consider the bot dead. The bot
# writes a heartbeat after every monitor tick (default 10 min) and every
# scan — 20 min gives us one full missed tick of grace.
HEARTBEAT_STALE_SECONDS = 20 * 60

# =============================================================================
# LOCATIONS  (mirrored from bot_v2.py)
# =============================================================================

LOCATIONS = {
    "nyc":          {"lat":  40.7772, "lon":  -73.8726, "name": "New York City", "station": "KLGA", "unit": "F", "region": "us"},
    "chicago":      {"lat":  41.9742, "lon":  -87.9073, "name": "Chicago",       "station": "KORD", "unit": "F", "region": "us"},
    "miami":        {"lat":  25.7959, "lon":  -80.2870, "name": "Miami",         "station": "KMIA", "unit": "F", "region": "us"},
    "dallas":       {"lat":  32.8471, "lon":  -96.8518, "name": "Dallas",        "station": "KDAL", "unit": "F", "region": "us"},
    "seattle":      {"lat":  47.4502, "lon": -122.3088, "name": "Seattle",       "station": "KSEA", "unit": "F", "region": "us"},
    "atlanta":      {"lat":  33.6407, "lon":  -84.4277, "name": "Atlanta",       "station": "KATL", "unit": "F", "region": "us"},
    "london":       {"lat":  51.5048, "lon":    0.0495, "name": "London",        "station": "EGLC", "unit": "C", "region": "eu"},
    "paris":        {"lat":  48.9962, "lon":    2.5979, "name": "Paris",         "station": "LFPG", "unit": "C", "region": "eu"},
    "munich":       {"lat":  48.3537, "lon":   11.7750, "name": "Munich",        "station": "EDDM", "unit": "C", "region": "eu"},
    "ankara":       {"lat":  40.1281, "lon":   32.9951, "name": "Ankara",        "station": "LTAC", "unit": "C", "region": "eu"},
    "seoul":        {"lat":  37.4691, "lon":  126.4505, "name": "Seoul",         "station": "RKSI", "unit": "C", "region": "asia"},
    "tokyo":        {"lat":  35.7647, "lon":  140.3864, "name": "Tokyo",         "station": "RJTT", "unit": "C", "region": "asia"},
    "shanghai":     {"lat":  31.1443, "lon":  121.8083, "name": "Shanghai",      "station": "ZSPD", "unit": "C", "region": "asia"},
    "singapore":    {"lat":   1.3502, "lon":  103.9940, "name": "Singapore",     "station": "WSSS", "unit": "C", "region": "asia"},
    "lucknow":      {"lat":  26.7606, "lon":   80.8893, "name": "Lucknow",       "station": "VILK", "unit": "C", "region": "asia"},
    "tel-aviv":     {"lat":  32.0114, "lon":   34.8867, "name": "Tel Aviv",      "station": "LLBG", "unit": "C", "region": "asia"},
    "toronto":      {"lat":  43.6772, "lon":  -79.6306, "name": "Toronto",       "station": "CYYZ", "unit": "C", "region": "ca"},
    "sao-paulo":    {"lat": -23.4356, "lon":  -46.4731, "name": "Sao Paulo",     "station": "SBGR", "unit": "C", "region": "sa"},
    "buenos-aires": {"lat": -34.8222, "lon":  -58.5358, "name": "Buenos Aires",  "station": "SAEZ", "unit": "C", "region": "sa"},
    "wellington":   {"lat": -41.3272, "lon":  174.8052, "name": "Wellington",    "station": "NZWN", "unit": "C", "region": "oc"},
}

# =============================================================================
# IN-MEMORY STATE
# =============================================================================

balance_history: deque = deque(maxlen=2000)   # [{ts, balance}, ...] — capped
activity_feed: deque = deque(maxlen=200)      # recent events (buys, exits, resolves)
previous_markets: dict = {}                   # last snapshot keyed by stem
connected_clients: set = set()                # active WebSocket connections
_market_cache: dict = {}                      # {path_str: (mtime, data)} for read_all_markets

# =============================================================================
# DATA READING HELPERS
# =============================================================================


def read_json(path: Path) -> Optional[dict]:
    """Read a JSON file; return None if missing or corrupt."""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def read_state() -> dict:
    """Read state.json with safe defaults."""
    defaults = {
        "balance": 0.0,
        "starting_balance": 0.0,
        "total_trades": 0,
        "wins": 0,
        "losses": 0,
        "peak_balance": 0.0,
    }
    data = read_json(STATE_FILE)
    if data is None:
        return defaults
    defaults.update(data)
    return defaults


def read_all_markets() -> dict:
    """Read all data/markets/*.json; keyed by file stem (e.g. 'nyc_2026-03-24').
    Reads are cached by mtime so unchanged files are never re-parsed.
    With 80+ market files and a file-watcher firing on every bot save,
    the naive re-read path was pure wasted I/O."""
    markets = {}
    if not MARKETS_DIR.exists():
        return markets

    alive_keys = set()
    for path in sorted(MARKETS_DIR.glob("*.json")):
        try:
            mtime = path.stat().st_mtime
        except FileNotFoundError:
            continue
        key = str(path)
        alive_keys.add(key)
        cached = _market_cache.get(key)
        if cached and cached[0] == mtime:
            markets[path.stem] = cached[1]
            continue
        data = read_json(path)
        if data is not None:
            _market_cache[key] = (mtime, data)
            markets[path.stem] = data

    # Prune cache entries for files that have been deleted.
    for stale in [k for k in _market_cache if k not in alive_keys]:
        _market_cache.pop(stale, None)

    return markets


def read_calibration() -> Optional[dict]:
    """Read calibration.json; return None if missing."""
    return read_json(CALIBRATION_FILE)


def check_bot_status() -> dict:
    """Decide whether the bot is alive from the heartbeat file it drops in
    data/. Works across processes, across containers, and across hosts as
    long as they share the data volume. psutil is only used as a best-effort
    fallback when the bot happens to live in the same PID namespace (legacy
    single-process setup)."""
    heartbeat = read_json(HEARTBEAT_FILE)
    if heartbeat:
        try:
            mtime       = HEARTBEAT_FILE.stat().st_mtime
            age_seconds = max(0, datetime.now().timestamp() - mtime)
            started_at  = heartbeat.get("started_at")
            uptime_s    = 0
            if started_at:
                try:
                    started_dt = datetime.fromisoformat(started_at)
                    uptime_s   = int((datetime.now(timezone.utc) - started_dt).total_seconds())
                except Exception:
                    pass
            return {
                "running":        age_seconds < HEARTBEAT_STALE_SECONDS,
                "pid":            heartbeat.get("pid"),
                "version":        heartbeat.get("version"),
                "cpu_percent":    0.0,
                "memory_mb":      0.0,
                "uptime_seconds": uptime_s,
                "heartbeat_age":  round(age_seconds, 1),
                "last_scan":      heartbeat.get("last_scan"),
                "last_monitor":   heartbeat.get("last_monitor"),
                "source":         "heartbeat",
            }
        except Exception:
            pass

    # Legacy fallback — only finds the bot if it shares our PID namespace.
    for proc in psutil.process_iter(["pid", "name", "cmdline", "cpu_percent", "memory_info", "create_time"]):
        try:
            cmdline = proc.info.get("cmdline") or []
            if any("bot_v2.py" in arg for arg in cmdline):
                mem_mb   = round(proc.info["memory_info"].rss / 1024 / 1024, 1) if proc.info.get("memory_info") else 0
                uptime_s = int(datetime.now().timestamp() - proc.info.get("create_time", 0))
                return {
                    "running":        True,
                    "pid":            proc.info["pid"],
                    "cpu_percent":    proc.info.get("cpu_percent", 0.0),
                    "memory_mb":      mem_mb,
                    "uptime_seconds": uptime_s,
                    "source":         "psutil",
                }
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return {
        "running":        False,
        "pid":            None,
        "cpu_percent":    0.0,
        "memory_mb":      0.0,
        "uptime_seconds": 0,
        "source":         "none",
    }

# =============================================================================
# ACTIVITY RECONSTRUCTION
# =============================================================================


def detect_changes(old_markets: dict, new_markets: dict) -> list[dict]:
    """Compare market snapshots and generate activity feed events.
    Only emits high-signal events (new market, buy, exit, resolve). Per-scan
    forecast snapshots used to be logged here too but they drowned every
    other event in the capped deque — 80 FORECAST lines per scan left no
    room for BUY/SELL history."""
    events = []
    now = datetime.now(timezone.utc).isoformat()

    for key, new_data in new_markets.items():
        old_data = old_markets.get(key)
        city = new_data.get("city_name", key)

        if old_data is None:
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

    return events

# =============================================================================
# DASHBOARD AGGREGATION
# =============================================================================


def build_dashboard_data() -> dict:
    """Build the complete dashboard payload."""
    state = read_state()
    markets = read_all_markets()
    calibration = read_calibration()
    bot_status = check_bot_status()

    # Compute derived KPIs
    open_positions = []
    closed_positions = []
    forecasts = []
    for key, m in markets.items():
        pos = m.get("position")
        if pos and pos.get("status") == "open":
            # Calculate unrealized PnL using bid price (what you'd actually sell at)
            entry_price = pos.get("entry_price", 0)
            shares = pos.get("shares", 0)
            current_price = entry_price  # fallback
            market_id = pos.get("market_id")
            if market_id:
                for o in m.get("all_outcomes", []):
                    if o.get("market_id") == market_id:
                        # Use bid (sell price), fall back to price
                        current_price = o.get("bid", o.get("price", entry_price))
                        break
            unrealized_pnl = round((current_price - entry_price) * shares, 2)

            open_positions.append({
                "city": m["city"],
                "city_name": m.get("city_name", m["city"]),
                "date": m["date"],
                "unit": m.get("unit", "F"),
                "bucket_low": pos.get("bucket_low"),
                "bucket_high": pos.get("bucket_high"),
                "entry_price": entry_price,
                "current_price": current_price,
                "ev": pos.get("ev"),
                "kelly": pos.get("kelly"),
                "cost": pos.get("cost"),
                "pnl": unrealized_pnl,
                "forecast_src": pos.get("forecast_src"),
                "sigma": pos.get("sigma"),
            })
        elif pos and pos.get("status") == "closed":
            closed_positions.append({
                "city": m["city"],
                "city_name": m.get("city_name", m["city"]),
                "date": m["date"],
                "unit": m.get("unit", "F"),
                "bucket_low": pos.get("bucket_low"),
                "bucket_high": pos.get("bucket_high"),
                "entry_price": pos.get("entry_price"),
                "exit_price": pos.get("exit_price"),
                "pnl": pos.get("pnl", 0),
                "cost": pos.get("cost"),
                "close_reason": pos.get("close_reason", "unknown"),
                "closed_at": pos.get("closed_at"),
            })

        # Latest forecast
        snaps = m.get("forecast_snapshots", [])
        if snaps:
            latest = snaps[-1]
            forecasts.append({
                "city":            m["city"],
                "city_name":       m.get("city_name", m["city"]),
                "date":            m["date"],
                "unit":            m.get("unit", "F"),
                "horizon":         latest.get("horizon"),
                "ecmwf":           latest.get("ecmwf"),
                "graphcast":       latest.get("graphcast"),
                "hrrr":            latest.get("hrrr"),
                "regional_source": latest.get("regional_source"),
                "ens_mean":        latest.get("ens_mean"),
                "ens_std":         latest.get("ens_std"),
                "ens_n":           latest.get("ens_n"),
                "metar":           latest.get("metar"),
                "best":            latest.get("best"),
                "best_source":     latest.get("best_source"),
            })

    # Sort closed positions by closed_at descending (most recent first)
    closed_positions.sort(key=lambda x: x.get("closed_at") or "", reverse=True)

    # Calculate KPIs from real trade data
    starting = state.get("starting_balance", 1000.0)

    realized_pnl = round(sum(p["pnl"] for p in closed_positions), 2)
    unrealized_pnl = round(sum(p["pnl"] for p in open_positions), 2)
    open_cost = round(sum(p.get("cost", 0) for p in open_positions), 2)
    cash = round(starting + realized_pnl - open_cost, 2)
    equity = round(cash + open_cost + unrealized_pnl, 2)

    # Win rate from closed trades
    wins = sum(1 for p in closed_positions if p.get("pnl", 0) > 0)
    total_closed = len(closed_positions)
    win_rate = (wins / total_closed * 100) if total_closed > 0 else None

    # Replay equity chronologically to find peak
    events = []
    for key, m in markets.items():
        pos = m.get("position")
        if pos and pos.get("status") == "closed" and pos.get("closed_at"):
            events.append((pos["closed_at"], pos.get("pnl", 0) or 0))
    events.sort(key=lambda x: x[0])
    running_equity = starting
    peak = starting
    for _, pnl_val in events:
        running_equity += pnl_val
        if running_equity > peak:
            peak = running_equity
    if equity > peak:
        peak = equity

    drawdown = ((equity - peak) / peak * 100) if peak > 0 else 0

    # Track balance history (equity over time)
    now_str = datetime.now(timezone.utc).isoformat()
    if not balance_history or balance_history[-1]["balance"] != equity:
        balance_history.append({"ts": now_str, "balance": equity})

    bot_version = None
    if isinstance(bot_status, dict):
        bot_version = bot_status.get("version")

    return {
        "version": __version__,
        "bot_version": bot_version,
        "state": state,
        "kpi": {
            "starting_balance": starting,
            "open_cost": open_cost,
            "realized_pnl": realized_pnl,
            "cash": cash,
            "unrealized_pnl": unrealized_pnl,
            "open_count": len(open_positions),
            "win_rate": round(win_rate, 1) if win_rate is not None else None,
            "drawdown": round(drawdown, 1),
        },
        "open_positions": open_positions,
        "closed_positions": closed_positions,
        "forecasts": forecasts,
        "calibration": calibration,
        "bot_status": bot_status,
        "balance_history": list(balance_history),
        "activity": list(activity_feed),
        "locations": LOCATIONS,
    }

# =============================================================================
# FASTAPI APP
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Launch the file-watcher on startup and cancel it cleanly on shutdown.
    Replaces the deprecated @app.on_event('startup') hook."""
    watcher_task = asyncio.create_task(watch_data_directory())
    try:
        yield
    finally:
        watcher_task.cancel()
        try:
            await watcher_task
        except (asyncio.CancelledError, Exception):
            pass


app = FastAPI(title="WeatherBet Operations Center", version="1.0.0", lifespan=lifespan)

# Mount static files if the directory exists
_static_dir = BASE_DIR / "static"
_static_dir.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")

# Jinja2 templates
_templates_dir = BASE_DIR / "templates"
_templates_dir.mkdir(exist_ok=True)
templates = Jinja2Templates(directory=str(_templates_dir))

# ---------------------------------------------------------------------------
# HTTP Routes
# ---------------------------------------------------------------------------


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Serve the main dashboard page."""
    data = build_dashboard_data()
    return templates.TemplateResponse(request=request, name="index.html", context={"data": data})


@app.get("/api/state")
async def api_state():
    return read_state()


@app.get("/api/markets")
async def api_markets():
    return read_all_markets()


@app.get("/api/markets/{city}/{date}")
async def api_market_detail(city: str, date: str):
    stem = f"{city}_{date}"
    path = MARKETS_DIR / f"{stem}.json"
    data = read_json(path)
    if data is None:
        raise HTTPException(status_code=404, detail=f"Market {stem} not found")
    return data


@app.get("/api/calibration")
async def api_calibration():
    return read_calibration() or {}


@app.get("/api/bot-status")
async def api_bot_status():
    return check_bot_status()


@app.get("/api/dashboard")
async def api_dashboard():
    return build_dashboard_data()


def build_backtest_data() -> dict:
    """Compute backtest stats from every market file.

    Returns per-source and per-close-reason breakdowns plus a per-trade
    list the frontend uses for scatter / calibration plots. Works even
    when no markets have fully resolved yet — in that case the calibration
    block is empty but the by-reason / by-source tables still populate
    from stop_loss / forecast_changed exits."""
    markets = read_all_markets()

    closed = []           # every position that hit any close_reason
    resolved = []         # subset where the market actually settled (actual_temp set, resolved_outcome ∈ {win, loss})

    for m in markets.values():
        pos = m.get("position")
        if not pos or pos.get("status") != "closed":
            continue
        cost         = float(pos.get("cost") or 0) or 1.0
        pnl          = float(pos.get("pnl") or 0)
        realized_ret = pnl / cost
        rec = {
            "city":          m.get("city"),
            "city_name":     m.get("city_name") or m.get("city"),
            "date":          m.get("date"),
            "unit":          m.get("unit", "F"),
            "p":             pos.get("p"),
            "ev":            pos.get("ev"),
            "kelly":         pos.get("kelly"),
            "sigma":         pos.get("sigma"),
            "forecast_src":  pos.get("forecast_src") or pos.get("prob_source"),
            "entry_price":   pos.get("entry_price"),
            "exit_price":    pos.get("exit_price"),
            "cost":          cost,
            "pnl":           round(pnl, 2),
            "realized_ret":  round(realized_ret, 4),
            "close_reason":  pos.get("close_reason"),
            "closed_at":     pos.get("closed_at"),
            "resolved":      m.get("status") == "resolved",
            "won":           (m.get("resolved_outcome") == "win") if m.get("status") == "resolved" else None,
            "actual_temp":   m.get("actual_temp"),
            "bucket_low":    pos.get("bucket_low"),
            "bucket_high":   pos.get("bucket_high"),
        }
        closed.append(rec)
        if rec["resolved"] and rec["won"] is not None:
            resolved.append(rec)

    closed.sort(key=lambda r: r.get("closed_at") or "", reverse=True)

    # ----- Breakdown: close_reason -----
    by_reason = {}
    for r in closed:
        key = r["close_reason"] or "unknown"
        slot = by_reason.setdefault(key, {"n": 0, "total_pnl": 0.0, "wins": 0})
        slot["n"] += 1
        slot["total_pnl"] += r["pnl"]
        if (r["pnl"] or 0) > 0:
            slot["wins"] += 1
    for slot in by_reason.values():
        slot["avg_pnl"]  = round(slot["total_pnl"] / slot["n"], 2) if slot["n"] else 0.0
        slot["total_pnl"] = round(slot["total_pnl"], 2)
        slot["hit_rate"] = round(slot["wins"] / slot["n"], 3) if slot["n"] else None

    # ----- Breakdown: forecast source -----
    by_source = {}
    for r in closed:
        key = r["forecast_src"] or "unknown"
        slot = by_source.setdefault(key, {
            "n": 0, "total_pnl": 0.0, "wins": 0,
            "sum_predicted_p": 0.0, "sum_ev": 0.0, "sum_realized_ret": 0.0,
            "n_with_p": 0,
        })
        slot["n"] += 1
        slot["total_pnl"] += r["pnl"]
        slot["sum_realized_ret"] += r["realized_ret"] or 0
        slot["sum_ev"] += float(r["ev"] or 0)
        if r["p"] is not None:
            slot["sum_predicted_p"] += float(r["p"])
            slot["n_with_p"] += 1
        if (r["pnl"] or 0) > 0:
            slot["wins"] += 1
    for slot in by_source.values():
        n = slot["n"]
        slot["total_pnl"]        = round(slot["total_pnl"], 2)
        slot["avg_pnl"]          = round(slot["total_pnl"] / n, 2) if n else 0.0
        slot["avg_ev"]           = round(slot["sum_ev"] / n, 3) if n else 0.0
        slot["avg_realized_ret"] = round(slot["sum_realized_ret"] / n, 4) if n else 0.0
        slot["avg_predicted_p"]  = round(slot["sum_predicted_p"] / slot["n_with_p"], 3) if slot["n_with_p"] else None
        slot["hit_rate"]         = round(slot["wins"] / n, 3) if n else None
        # trim internals
        for k in ("sum_predicted_p", "sum_ev", "sum_realized_ret", "n_with_p"):
            slot.pop(k, None)

    # ----- Calibration curve (only fully resolved markets) -----
    # Bin predicted p into deciles and compare against actual win rate.
    bins = [(i / 10, (i + 1) / 10) for i in range(10)]
    calibration = []
    for lo, hi in bins:
        group = [r for r in resolved if r["p"] is not None and lo <= r["p"] < hi]
        if not group:
            continue
        avg_p  = sum(r["p"] for r in group) / len(group)
        wins   = sum(1 for r in group if r["won"])
        calibration.append({
            "bin_lo":   round(lo, 2),
            "bin_hi":   round(hi, 2),
            "n":        len(group),
            "avg_p":    round(avg_p, 3),
            "observed": round(wins / len(group), 3),
        })

    # ----- Summary headline -----
    wins   = sum(1 for r in closed if (r["pnl"] or 0) > 0)
    losses = sum(1 for r in closed if (r["pnl"] or 0) < 0)
    total_pnl = round(sum(r["pnl"] for r in closed), 2)
    avg_realized_ret = (
        round(sum(r["realized_ret"] or 0 for r in closed) / len(closed), 4)
        if closed else None
    )
    avg_ev = (
        round(sum(float(r["ev"] or 0) for r in closed) / len(closed), 3)
        if closed else None
    )

    return {
        "version":        __version__,
        "summary": {
            "total_closed":     len(closed),
            "total_resolved":   len(resolved),
            "wins":             wins,
            "losses":           losses,
            "total_pnl":        total_pnl,
            "avg_realized_ret": avg_realized_ret,
            "avg_ev_predicted": avg_ev,
        },
        "by_reason":      by_reason,
        "by_source":      by_source,
        "calibration":    calibration,
        "trades":         closed,     # already sorted newest-first
    }


@app.get("/api/backtest")
async def api_backtest():
    return build_backtest_data()


# ---------------------------------------------------------------------------
# Admin endpoints
#
# These are intentionally unauthenticated — the dashboard is assumed to be
# reachable only from a trusted local network / Docker host. If the service
# is ever exposed publicly, wrap these behind a shared secret header check.
# ---------------------------------------------------------------------------

RESCAN_REQUEST_FILE = DATA_DIR / "rescan.request"


def _touch_rescan_trigger(reason: str) -> None:
    """Drop a file the bot polls for, which short-circuits its sleep and
    forces a full scan on the next tick."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RESCAN_REQUEST_FILE.write_text(reason, encoding="utf-8")


@app.post("/api/admin/rescan")
async def api_admin_rescan():
    """Force the bot to run a full market scan on its next poll tick."""
    _touch_rescan_trigger("manual")
    return {"ok": True, "action": "rescan_requested"}


@app.post("/api/admin/reset")
async def api_admin_reset():
    """Wipe all bot runtime state so the next scan starts from zero.

    Deletes: every market JSON, state.json, calibration.json.
    Keeps: heartbeat.json (so the bot-status tile stays accurate) and
    the data/.gitkeep placeholders.

    Also clears in-memory dashboard caches so the UI doesn't briefly
    show stale values from the capped deques while the bot rebuilds
    everything."""
    deleted = 0
    for path in MARKETS_DIR.glob("*.json"):
        try:
            path.unlink()
            deleted += 1
        except Exception:
            pass

    for path in (STATE_FILE, CALIBRATION_FILE):
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass

    # Seed a fresh state.json from config.json so the KPI strip reads
    # the proper starting balance immediately instead of briefly flashing
    # $0 until the bot completes its next scan and calls save_state().
    try:
        with open(BASE_DIR / "config.json", encoding="utf-8") as fh:
            cfg = json.load(fh)
        starting = float(cfg.get("balance", 10000.0))
    except Exception:
        starting = 10000.0
    fresh_state = {
        "balance":          starting,
        "starting_balance": starting,
        "total_trades":     0,
        "wins":             0,
        "losses":           0,
        "peak_balance":     starting,
    }
    try:
        STATE_FILE.write_text(json.dumps(fresh_state, indent=2), encoding="utf-8")
    except Exception:
        pass

    # Reset in-memory dashboard state so the next /api/dashboard call
    # computes everything from the now-empty disk.
    balance_history.clear()
    activity_feed.clear()
    _market_cache.clear()
    previous_markets.clear()

    # Kick the bot so it runs a fresh scan right away.
    _touch_rescan_trigger("reset")

    # Push an empty-state update to any connected WebSocket clients.
    try:
        await broadcast({"type": "full_update", "data": build_dashboard_data()})
    except Exception:
        pass

    return {"ok": True, "markets_deleted": deleted}

# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------


async def broadcast(payload: dict):
    """Push JSON payload to all connected WebSocket clients."""
    message = json.dumps(payload)
    dead = set()
    for ws in connected_clients:
        try:
            await ws.send_text(message)
        except Exception:
            dead.add(ws)
    connected_clients.difference_update(dead)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)
    try:
        # Send full state on connect
        data = build_dashboard_data()
        await websocket.send_text(json.dumps({"type": "full_update", "data": data}))
        # Keep alive — receive messages (ping/close) until disconnect
        while True:
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
            except asyncio.TimeoutError:
                # Send a heartbeat ping
                try:
                    await websocket.send_text(json.dumps({"type": "ping"}))
                except Exception:
                    break
    except WebSocketDisconnect:
        pass
    finally:
        connected_clients.discard(websocket)

# ---------------------------------------------------------------------------
# File-watcher background task
# ---------------------------------------------------------------------------


async def watch_data_directory():
    """Monitor data/ directory with watchfiles and push updates to clients."""
    global previous_markets

    try:
        from watchfiles import awatch
    except ImportError:
        # watchfiles not available — fall back to polling every 10 s.
        while True:
            await asyncio.sleep(10)
            new_markets = read_all_markets()
            events = detect_changes(previous_markets, new_markets)
            for ev in events:
                activity_feed.appendleft(ev)
            previous_markets = new_markets
            if connected_clients:
                data = build_dashboard_data()
                await broadcast({"type": "full_update", "data": data})
        return  # pragma: no cover — unreachable, here to pacify linters

    previous_markets = read_all_markets()

    async for changes in awatch(str(DATA_DIR)):
        # The bot uses atomic writes (temp file + rename), so every real save
        # generates events for both `foo.json.tmp` and `foo.json`. Ignore the
        # tmp ones — they double the work and nothing downstream wants them.
        real = [c for c in changes if not str(c[1]).endswith(".tmp")]
        if not real:
            continue
        new_markets = read_all_markets()
        events = detect_changes(previous_markets, new_markets)
        for ev in events:
            activity_feed.appendleft(ev)
        previous_markets = new_markets
        if connected_clients:
            data = build_dashboard_data()
            await broadcast({"type": "full_update", "data": data})

# =============================================================================
# ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WeatherBet Dashboard Server")
    parser.add_argument("--port", type=int, default=8050, help="Port to listen on (default: 8050)")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host to bind (default: 0.0.0.0)")
    args = parser.parse_args()

    uvicorn.run("dashboard:app", host=args.host, port=args.port, reload=False)
