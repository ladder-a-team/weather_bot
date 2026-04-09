/* WeatherBet Operations Center — Client-side logic */

(function () {
    "use strict";

    const DATA = window.__DASHBOARD_DATA__;
    let ws = null;
    let reconnectDelay = 1000;

    // ---- Last-received data snapshot (so sort clicks can re-render
    //      without waiting for the next WebSocket/poll tick). ----
    let lastData = DATA;

    // ---- Sortable table state ----
    // Each entry: { column: <string|null>, dir: 1|-1 }. Null column = no
    // explicit sort (default rendering order).
    const sortState = {
        positions: { column: null, dir:  1 },
        history:   { column: "closed_at", dir: -1 }, // most recent first by default
        forecasts: { column: null, dir:  1 },
    };

    // Comparators per (table, column). Each returns a sortable value.
    const SORT_KEYS = {
        positions: {
            city:   p => (p.city_name || p.city || "").toLowerCase(),
            bucket: p => Number(p.bucket_low ?? 0),
            entry:  p => Number(p.entry_price ?? 0),
            ev:     p => Number(p.ev ?? 0),
            kelly:  p => Number(p.kelly ?? 0),
            pnl:    p => Number(p.pnl ?? 0),
        },
        history: {
            city:    t => (t.city_name || t.city || "").toLowerCase(),
            date:    t => t.date || "",
            entry:   t => Number(t.entry_price ?? 0),
            reason:  t => (t.close_reason || "").toLowerCase(),
            pnl:     t => Number(t.pnl ?? 0),
            closed_at: t => t.closed_at || "",
        },
        forecasts: {
            city:  f => (f.city || "").toLowerCase(),
            ecmwf: f => Number.isFinite(f.ecmwf) ? f.ecmwf : -Infinity,
            hrrr:  f => Number.isFinite(f.hrrr)  ? f.hrrr  : -Infinity,
            metar: f => Number.isFinite(f.metar) ? f.metar : -Infinity,
            best:  f => Number.isFinite(f.best)  ? f.best  : -Infinity,
        },
    };

    function applySort(tableName, rows) {
        const st = sortState[tableName];
        if (!st || !st.column) return rows;
        const keyFn = (SORT_KEYS[tableName] || {})[st.column];
        if (!keyFn) return rows;
        const dir = st.dir;
        return [...rows].sort((a, b) => {
            const av = keyFn(a);
            const bv = keyFn(b);
            if (av < bv) return -1 * dir;
            if (av > bv) return  1 * dir;
            return 0;
        });
    }

    function updateHeaderIndicators() {
        document.querySelectorAll(".col-sort").forEach(el => {
            el.classList.remove("sort-asc", "sort-desc");
        });
        for (const [table, st] of Object.entries(sortState)) {
            if (!st.column) continue;
            const header = document.querySelector(`[data-table="${table}"]`);
            if (!header) continue;
            const el = header.querySelector(`[data-col="${st.column}"]`);
            if (el) el.classList.add(st.dir > 0 ? "sort-asc" : "sort-desc");
        }
    }

    function initTableSorting() {
        document.querySelectorAll("[data-table]").forEach(header => {
            const table = header.dataset.table;
            header.querySelectorAll(".col-sort").forEach(span => {
                span.addEventListener("click", () => {
                    const col = span.dataset.col;
                    const st  = sortState[table];
                    if (st.column === col) {
                        st.dir = -st.dir;
                    } else {
                        st.column = col;
                        st.dir = 1;
                    }
                    updateHeaderIndicators();
                    // Re-render using the last snapshot we have.
                    if (lastData) {
                        if (table === "positions") updatePositions(lastData.open_positions || []);
                        if (table === "history")   updateHistory(lastData.closed_positions || []);
                        if (table === "forecasts") updateForecasts(lastData.forecasts || []);
                    }
                });
            });
        });
        updateHeaderIndicators();
    }

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
        document.getElementById("kpi-starting").textContent = "$" + kpi.starting_balance.toFixed(2);
        document.getElementById("kpi-open-cost").textContent = "$" + kpi.open_cost.toFixed(2);
        document.getElementById("kpi-cash").textContent = "$" + kpi.cash.toFixed(2);

        function setPnl(id, value) {
            const el = document.getElementById(id);
            el.textContent = (value >= 0 ? "+" : "") + "$" + value.toFixed(2);
            el.className = "kpi-value " + (value >= 0 ? "text-green" : "text-red");
        }
        setPnl("kpi-realized", kpi.realized_pnl);
        setPnl("kpi-unrealized", kpi.unrealized_pnl);

        document.getElementById("kpi-open").textContent = kpi.open_count;
        document.getElementById("kpi-winrate").textContent = kpi.win_rate !== null ? kpi.win_rate.toFixed(1) + "%" : "—";

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

        positions = applySort("positions", positions);

        let html = "";
        for (const p of positions) {
            const pnl = p.pnl ?? 0;
            const pnlClass = pnl >= 0 ? "text-green" : "text-red";
            const pnlSign = pnl >= 0 ? "+" : "";
            const pnlText = pnlSign + "$" + pnl.toFixed(2);
            const curPrice = p.current_price ? "$" + p.current_price.toFixed(3) : "—";

            html += `<div class="table-row">` +
                `<span>${p.city.toUpperCase().slice(0, 3)}</span>` +
                `<span>${p.bucket_low}-${p.bucket_high}°${p.unit}</span>` +
                `<span>$${p.entry_price.toFixed(3)} → ${curPrice}</span>` +
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

        forecasts = applySort("forecasts", forecasts);

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
    // Update Trade History
    // =========================================================================
    function updateHistory(trades) {
        const body = document.getElementById("history-body");
        const count = document.getElementById("history-count");
        count.textContent = trades.length + " closed";

        if (trades.length === 0) {
            body.innerHTML = '<div class="empty-state">No closed trades yet</div>';
            return;
        }

        trades = applySort("history", trades);

        let html = "";
        for (const t of trades) {
            const pnl = t.pnl ?? 0;
            const pnlClass = pnl >= 0 ? "text-green" : "text-red";
            const pnlSign = pnl >= 0 ? "+" : "";
            const reason = t.close_reason || "unknown";

            html += `<div class="history-row">` +
                `<span>${t.city_name}</span>` +
                `<span>${t.date}</span>` +
                `<span>$${t.entry_price.toFixed(3)} → $${t.exit_price.toFixed(3)}</span>` +
                `<span class="reason-badge reason-${reason}">${reason}</span>` +
                `<span class="${pnlClass}">${pnlSign}$${pnl.toFixed(2)}</span>` +
                `</div>`;
        }
        body.innerHTML = html;
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
            // Version lives in the dedicated tag on the left (updateVersion).
            // Don't duplicate it here.
            el.textContent = "Bot: PID " + status.pid;
        } else {
            el.innerHTML = '<span class="badge badge-stopped">STOPPED</span>';
        }
    }

    // =========================================================================
    // Update Version Tag
    // =========================================================================
    function updateVersion(data) {
        const tag = document.getElementById("version-tag");
        if (!tag) return;
        const dashVer = data.version;
        const botVer  = data.bot_version || (data.bot_status && data.bot_status.version);
        if (!dashVer) return;
        tag.textContent = "v" + dashVer;
        if (botVer && botVer !== dashVer) {
            tag.classList.add("mismatch");
            tag.title = `Dashboard v${dashVer} / Bot v${botVer} — version mismatch`;
        } else {
            tag.classList.remove("mismatch");
            tag.title = "WeatherBet v" + dashVer;
        }
    }

    // =========================================================================
    // Full dashboard update
    // =========================================================================
    function updateDashboard(data) {
        lastData = data;
        updateVersion(data);
        updateKPIs(data.kpi);
        updateMap(data);
        updateChart(data.balance_history);
        updateCityCards(data);
        updatePositions(data.open_positions || []);
        updateHistory(data.closed_positions || []);
        updateForecasts(data.forecasts || []);
        updateCalibration(data.calibration);
        updateActivity(data.activity || []);
        updateBotStatus(data.bot_status || {});
        // Quietly refresh the backtest tab if it's visible. Stats come
        // from a separate endpoint so we don't do it unconditionally.
        if (activeTab === "backtest") {
            loadBacktest();
        }
    }

    // =========================================================================
    // Admin buttons — Rescan / Reset
    // =========================================================================
    async function postAdmin(path, btn, successLabel) {
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = "…";
        try {
            const resp = await fetch(path, { method: "POST" });
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const data = await resp.json();
            btn.classList.add("success");
            btn.textContent = successLabel || "OK";
            setTimeout(function () {
                btn.classList.remove("success");
                btn.textContent = original;
                btn.disabled = false;
            }, 1500);
            return data;
        } catch (err) {
            btn.textContent = "ERR";
            console.error(path, err);
            setTimeout(function () {
                btn.textContent = original;
                btn.disabled = false;
            }, 1500);
            return null;
        }
    }

    function initAdminButtons() {
        const rescanBtn = document.getElementById("rescan-btn");
        const resetBtn  = document.getElementById("reset-btn");

        if (rescanBtn) {
            rescanBtn.addEventListener("click", async function () {
                if (!confirm("Force a full market scan now?\n\nThe bot will rescan every city on its next poll tick (within ~5 seconds).")) return;
                await postAdmin("/api/admin/rescan", rescanBtn, "QUEUED");
            });
        }

        if (resetBtn) {
            resetBtn.addEventListener("click", async function () {
                const warn =
                    "RESET will permanently delete:\n" +
                    "  • every market JSON (all positions, trades, forecasts)\n" +
                    "  • state.json (balance, counters)\n" +
                    "  • calibration.json (learned σ per city)\n\n" +
                    "The bot will start over from its config starting balance.\n" +
                    "This cannot be undone.\n\n" +
                    "Are you sure?";
                if (!confirm(warn)) return;
                if (!confirm("Really delete everything and start over?")) return;
                await postAdmin("/api/admin/reset", resetBtn, "CLEARED");
            });
        }
    }

    // =========================================================================
    // Center-top panel tabs (Balance History / Backtest)
    // =========================================================================
    let activeTab = "chart";
    let backtestLoaded = false;

    function showTab(name) {
        activeTab = name;
        document.querySelectorAll(".panel-tab").forEach(el => {
            el.classList.toggle("active", el.dataset.tab === name);
        });
        document.querySelectorAll("[data-tab-view]").forEach(el => {
            el.hidden = el.dataset.tabView !== name;
        });
        if (name === "chart") {
            // Chart.js needs a resize kick after becoming visible.
            setTimeout(function () { balanceChart.resize(); }, 50);
        } else if (name === "backtest") {
            loadBacktest();
        }
    }

    function initPanelTabs() {
        document.querySelectorAll(".panel-tab").forEach(el => {
            el.addEventListener("click", function () {
                showTab(el.dataset.tab);
            });
        });
    }

    async function loadBacktest() {
        const container = document.getElementById("backtest-summary");
        if (!container) return;
        if (!backtestLoaded) container.innerHTML = '<div class="backtest-empty">Loading…</div>';
        try {
            const resp = await fetch("/api/backtest");
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const data = await resp.json();
            renderBacktest(data);
            backtestLoaded = true;
        } catch (err) {
            container.innerHTML = '<div class="backtest-empty">Failed to load backtest: ' + err.message + '</div>';
        }
    }

    function fmtPnl(v) {
        if (v == null) return "—";
        const sign = v >= 0 ? "+" : "";
        return sign + "$" + Number(v).toFixed(2);
    }

    function fmtPct(v) {
        if (v == null) return "—";
        return (Number(v) * 100).toFixed(1) + "%";
    }

    function renderBacktest(data) {
        const container = document.getElementById("backtest-summary");
        const s = data.summary || {};

        let html = "";

        // KPI grid
        html += '<div class="backtest-kpis">';
        html += '<div class="backtest-kpi"><div class="label">Closed</div><div class="value">' + (s.total_closed ?? 0) + '</div></div>';
        html += '<div class="backtest-kpi"><div class="label">Resolved</div><div class="value">' + (s.total_resolved ?? 0) + '</div></div>';
        const pnlClass = (s.total_pnl ?? 0) >= 0 ? "text-green" : "text-red";
        html += '<div class="backtest-kpi"><div class="label">Realized PnL</div><div class="value ' + pnlClass + '">' + fmtPnl(s.total_pnl) + '</div></div>';
        html += '<div class="backtest-kpi"><div class="label">Avg Realized Return</div><div class="value">' + fmtPct(s.avg_realized_ret) + '</div></div>';
        html += '<div class="backtest-kpi"><div class="label">Wins</div><div class="value text-green">' + (s.wins ?? 0) + '</div></div>';
        html += '<div class="backtest-kpi"><div class="label">Losses</div><div class="value text-red">' + (s.losses ?? 0) + '</div></div>';
        html += '<div class="backtest-kpi"><div class="label">Avg EV Predicted</div><div class="value">' + (s.avg_ev_predicted != null ? "+" + Number(s.avg_ev_predicted).toFixed(2) : "—") + '</div></div>';
        const hit = s.total_closed ? (s.wins || 0) / s.total_closed : null;
        html += '<div class="backtest-kpi"><div class="label">Hit Rate</div><div class="value">' + (hit != null ? fmtPct(hit) : "—") + '</div></div>';
        html += '</div>';

        // By forecast source
        html += '<div class="backtest-section-title">By Forecast Source</div>';
        const bySrc = data.by_source || {};
        const srcKeys = Object.keys(bySrc);
        if (srcKeys.length === 0) {
            html += '<div class="backtest-empty">No closed trades yet.</div>';
        } else {
            html += '<table class="backtest-table"><thead><tr>';
            html += '<th>Source</th><th class="num">N</th><th class="num">Hit</th><th class="num">Avg EV</th><th class="num">Avg Return</th><th class="num">Total PnL</th>';
            html += '</tr></thead><tbody>';
            srcKeys.sort((a, b) => (bySrc[b].total_pnl || 0) - (bySrc[a].total_pnl || 0));
            for (const k of srcKeys) {
                const row = bySrc[k];
                const rowPnlClass = (row.total_pnl || 0) >= 0 ? "text-green" : "text-red";
                html += '<tr>';
                html += '<td>' + k.toUpperCase() + '</td>';
                html += '<td class="num">' + row.n + '</td>';
                html += '<td class="num">' + (row.hit_rate != null ? fmtPct(row.hit_rate) : "—") + '</td>';
                html += '<td class="num">' + (row.avg_ev != null ? "+" + row.avg_ev.toFixed(2) : "—") + '</td>';
                html += '<td class="num">' + (row.avg_realized_ret != null ? fmtPct(row.avg_realized_ret) : "—") + '</td>';
                html += '<td class="num ' + rowPnlClass + '">' + fmtPnl(row.total_pnl) + '</td>';
                html += '</tr>';
            }
            html += '</tbody></table>';
        }

        // By close reason
        html += '<div class="backtest-section-title">By Close Reason</div>';
        const byR = data.by_reason || {};
        const rKeys = Object.keys(byR);
        if (rKeys.length === 0) {
            html += '<div class="backtest-empty">No closed trades yet.</div>';
        } else {
            html += '<table class="backtest-table"><thead><tr>';
            html += '<th>Reason</th><th class="num">N</th><th class="num">Hit</th><th class="num">Avg PnL</th><th class="num">Total PnL</th>';
            html += '</tr></thead><tbody>';
            rKeys.sort((a, b) => (byR[b].total_pnl || 0) - (byR[a].total_pnl || 0));
            for (const k of rKeys) {
                const row = byR[k];
                const rowPnlClass = (row.total_pnl || 0) >= 0 ? "text-green" : "text-red";
                html += '<tr>';
                html += '<td>' + k.replace(/_/g, " ") + '</td>';
                html += '<td class="num">' + row.n + '</td>';
                html += '<td class="num">' + (row.hit_rate != null ? fmtPct(row.hit_rate) : "—") + '</td>';
                html += '<td class="num">' + fmtPnl(row.avg_pnl) + '</td>';
                html += '<td class="num ' + rowPnlClass + '">' + fmtPnl(row.total_pnl) + '</td>';
                html += '</tr>';
            }
            html += '</tbody></table>';
        }

        // Calibration (only once we have resolved markets)
        if (data.calibration && data.calibration.length > 0) {
            html += '<div class="backtest-section-title">Calibration (resolved only)</div>';
            html += '<table class="backtest-table"><thead><tr>';
            html += '<th>p bin</th><th class="num">N</th><th class="num">Predicted</th><th class="num">Observed</th>';
            html += '</tr></thead><tbody>';
            for (const row of data.calibration) {
                html += '<tr>';
                html += '<td>' + row.bin_lo.toFixed(1) + '–' + row.bin_hi.toFixed(1) + '</td>';
                html += '<td class="num">' + row.n + '</td>';
                html += '<td class="num">' + fmtPct(row.avg_p) + '</td>';
                html += '<td class="num">' + fmtPct(row.observed) + '</td>';
                html += '</tr>';
            }
            html += '</tbody></table>';
        } else if ((s.total_resolved || 0) === 0) {
            html += '<div class="backtest-empty">Calibration curve unlocks once markets fully resolve (not stop_loss / forecast_changed).</div>';
        }

        container.innerHTML = html;
    }

    // =========================================================================
    // Balance History collapse toggle (persisted in localStorage)
    // =========================================================================
    function initBalanceCollapse() {
        const grid = document.querySelector(".main-grid");
        const btn  = document.getElementById("balance-toggle");
        if (!grid || !btn) return;

        const STORAGE_KEY = "wbet.balance-collapsed";
        if (localStorage.getItem(STORAGE_KEY) === "1") {
            grid.classList.add("chart-collapsed");
        }

        btn.addEventListener("click", function () {
            const collapsed = grid.classList.toggle("chart-collapsed");
            localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
            // Chart.js needs a resize kick when it becomes visible again.
            if (!collapsed) {
                setTimeout(function () { balanceChart.resize(); }, 50);
            }
        });
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
    initBalanceCollapse();
    initAdminButtons();
    initTableSorting();
    initPanelTabs();
    updateDashboard(DATA);
    connectWebSocket();

    // Keep WebSocket alive with pings
    setInterval(function () {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send("ping");
        }
    }, 30000);

})();
