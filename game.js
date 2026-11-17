/*
 * Minesweeper 掃海図 — interface.
 * All rules, generation and analysis live in engine.js (MSEngine); this file
 * draws the board on a canvas and turns pointer / keyboard input into moves.
 */
(function () {
    'use strict';

    const E = window.MSEngine;
    const { HIDDEN, OPEN, FLAG } = E;

    const PRESETS = {
        easy: { name: '初級', rows: 9, cols: 9, mines: 10 },
        normal: { name: '中級', rows: 16, cols: 16, mines: 40 },
        hard: { name: '上級', rows: 16, cols: 30, mines: 99 },
        extreme: { name: '極限', rows: 50, cols: 50, mines: 500 }
    };
    const REVEAL_MS = 200;
    const LONG_PRESS_MS = 350;
    const GEN_TIME_LIMIT = 6000;

    const $ = (id) => document.getElementById(id);
    const store = {
        get(key, fallback) {
            try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
            catch (e) { return fallback; }
        },
        set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode etc. */ } }
    };
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    // ------------------------------------------------------------------ state

    const cfg = Object.assign(
        { preset: 'easy', rows: 9, cols: 9, mines: 10, noGuess: true, theme: 'auto' },
        store.get('ms2.settings', {})
    );
    if (PRESETS[cfg.preset]) Object.assign(cfg, pick(PRESETS[cfg.preset]));
    if (!validConfig(cfg.rows, cfg.cols, cfg.mines)) Object.assign(cfg, { preset: 'easy' }, pick(PRESETS.easy));

    let game = null;
    let animStart = null;          // per cell: time its reveal animation starts (0 = none)
    let flagTime = null;           // per cell: time a flag was planted
    let probs = null;              // Float64Array from analysis, or null
    let hintOn = false, hintUsed = false, retried = false, guaranteed = false;
    let busy = false, paused = false, flagMode = false;
    let generator = null;
    let boomTime = 0, winTime = 0, animUntil = 0, frameQueued = false;
    let timerBase = 0, timerStart = 0, timerRunning = false;
    let cursor = -1, cursorVisible = false, hoverCell = -1, pressCell = -1;

    const canvas = $('board');
    const ctx = canvas.getContext('2d');
    const view = { x: 0, y: 0, s: 32, w: 0, h: 0, dpr: 1 };
    let C = {};                    // colours read from CSS
    let probRamp = [];

    function pick(p) { return { rows: p.rows, cols: p.cols, mines: p.mines }; }
    function validConfig(r, c, m) {
        return Number.isInteger(r) && Number.isInteger(c) && Number.isInteger(m) &&
            r >= 4 && r <= 100 && c >= 4 && c <= 100 && m >= 1 && m <= r * c - 9;
    }
    function bestKey() { return `${cfg.rows}x${cfg.cols}x${cfg.mines}${cfg.noGuess ? '-ng' : ''}`; }
    function fmtTime(ms, tenths) {
        const t = Math.max(0, ms);
        const m = Math.floor(t / 60000), s = Math.floor(t / 1000) % 60;
        let out = m + ':' + String(s).padStart(2, '0');
        if (tenths) out += '.' + Math.floor(t / 100) % 10;
        return out;
    }
    function setStatus(text) { $('status').textContent = text; }

    // ------------------------------------------------------------------ theme

    function applyTheme() {
        if (cfg.theme === 'auto') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', cfg.theme);
        readColors();
        requestDraw();
    }

    function hexToRgb(h) {
        h = h.trim().replace('#', '');
        if (h.length === 3) h = h.split('').map(x => x + x).join('');
        const v = parseInt(h, 16);
        return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }

    function readColors() {
        const cs = getComputedStyle(document.documentElement);
        const v = (n) => cs.getPropertyValue(n).trim();
        C = {
            sea: v('--sea'), paper: v('--paper'), water: v('--water'), waterLit: v('--water-lit'),
            ink: v('--ink'), inkSoft: v('--ink-soft'), magenta: v('--magenta'), buff: v('--buff'), rule: v('--rule'),
            num: [null, v('--n1'), v('--n2'), v('--n3'), v('--n4'), v('--n5'), v('--n6'), v('--n7'), v('--n8')],
            serif: v('--serif'), sans: v('--sans')
        };
        const a = hexToRgb(C.water), b = hexToRgb(C.magenta);
        probRamp = [];
        for (let i = 0; i <= 100; i++) {
            const t = Math.pow(i / 100, 1.6) * 0.9;
            probRamp.push(`rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`);
        }
    }

    // ------------------------------------------------------------------- view

    function resize() {
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const first = view.w === 0;
        view.w = rect.width; view.h = rect.height; view.dpr = dpr;
        canvas.width = Math.max(1, Math.round(rect.width * dpr));
        canvas.height = Math.max(1, Math.round(rect.height * dpr));
        if (first) fitView(); else clampView();
        requestDraw();
    }

    function fitScale() {
        const pad = 14, frame = 0.6;
        return Math.min((view.w - pad * 2) / (cfg.cols + frame * 2), (view.h - pad * 2) / (cfg.rows + frame * 2));
    }
    function minScale() { return Math.max(2.5, Math.min(fitScale(), 14)); }
    const MAX_SCALE = 72;

    /** Show the whole board; if that would make cells too small to tap, start zoomed in on the middle. */
    function fitView(forceWhole) {
        let s = Math.min(fitScale(), 46);
        if (!forceWhole && s < 17) s = 26;
        view.s = Math.max(s, 2.5);
        view.x = (view.w - cfg.cols * view.s) / 2;
        view.y = (view.h - cfg.rows * view.s) / 2;
        clampView();
    }

    function clampView() {
        view.s = Math.min(MAX_SCALE, Math.max(minScale(), view.s));
        const bw = cfg.cols * view.s, bh = cfg.rows * view.s;
        const m = Math.min(60, view.w / 3, view.h / 3);
        if (bw + 2 * m <= view.w) view.x = (view.w - bw) / 2;
        else view.x = Math.min(m, Math.max(view.w - m - bw, view.x));
        if (bh + 2 * m <= view.h) view.y = (view.h - bh) / 2;
        else view.y = Math.min(m, Math.max(view.h - m - bh, view.y));
    }

    function zoomAt(px, py, factor) {
        const ns = Math.min(MAX_SCALE, Math.max(minScale(), view.s * factor));
        const f = ns / view.s;
        view.x = px - (px - view.x) * f;
        view.y = py - (py - view.y) * f;
        view.s = ns;
        clampView();
        requestDraw();
    }

    function cellAt(px, py) {
        const c = Math.floor((px - view.x) / view.s), r = Math.floor((py - view.y) / view.s);
        if (r < 0 || r >= cfg.rows || c < 0 || c >= cfg.cols) return -1;
        return r * cfg.cols + c;
    }

    function ensureVisible(i) {
        const r = Math.floor(i / cfg.cols), c = i % cfg.cols, s = view.s, pad = s * 0.8;
        const x = view.x + c * s, y = view.y + r * s;
        if (x < pad) view.x += pad - x; else if (x + s > view.w - pad) view.x -= x + s - (view.w - pad);
        if (y < pad) view.y += pad - y; else if (y + s > view.h - pad) view.y -= y + s - (view.h - pad);
        clampView();
    }

    // ---------------------------------------------------------------- drawing

    function requestDraw() {
        if (frameQueued) return;
        frameQueued = true;
        requestAnimationFrame(frame);
    }
    function animate(until) {
        if (until > animUntil) animUntil = until;
        requestDraw();
    }
    function frame() {
        frameQueued = false;
        const now = performance.now();
        draw(now);
        if (now < animUntil) requestDraw();
    }

    function draw(now) {
        const { w, h, dpr, s, x: ox, y: oy } = view;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = C.sea;
        ctx.fillRect(0, 0, w, h);
        if (!game) return;

        const rows = cfg.rows, cols = cfg.cols;
        const bw = cols * s, bh = rows * s;
        const c0 = Math.max(0, Math.floor(-ox / s)), c1 = Math.min(cols, Math.ceil((w - ox) / s));
        const r0 = Math.max(0, Math.floor(-oy / s)), r1 = Math.min(rows, Math.ceil((h - oy) / s));

        drawFrame(ox, oy, bw, bh, s, c0, c1, r0, r1);

        // sounded ground: paper with a fine grid
        ctx.fillStyle = C.paper;
        ctx.fillRect(ox, oy, bw, bh);
        if (s >= 6) {
            ctx.strokeStyle = C.rule;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let c = c0; c <= c1; c++) { const px = Math.round(ox + c * s) + 0.5; ctx.moveTo(px, oy + r0 * s); ctx.lineTo(px, oy + r1 * s); }
            for (let r = r0; r <= r1; r++) { const py = Math.round(oy + r * s) + 0.5; ctx.moveTo(ox + c0 * s, py); ctx.lineTo(ox + c1 * s, py); }
            ctx.stroke();
        }

        const st = game.state, mine = game.mine, cnt = game.cnt;
        const lost = game.over && !game.won;
        const gap = s >= 14 ? 1 : (s >= 6 ? 0.5 : 0);
        const showText = s >= 9;
        const showProb = hintOn && probs && !game.over;
        const numFont = `italic 600 ${Math.round(s * 0.64)}px ${C.serif}`;
        const probFont = `600 ${Math.max(8, Math.round(s * 0.3))}px ${C.sans}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let r = r0; r < r1; r++) {
            const py = oy + r * s;
            for (let c = c0; c < c1; c++) {
                const i = r * cols + c;
                const px = ox + c * s;
                const state = st[i];
                const t0 = animStart[i];
                // a mine shown after losing behaves like an opened cell
                const shownMine = lost && mine[i] && state !== FLAG;
                const opened = state === OPEN || shownMine;
                let coverAlpha = 1;
                if (opened) {
                    if (t0 && now < t0) coverAlpha = 1;
                    else if (t0 && now < t0 + REVEAL_MS) coverAlpha = 1 - (now - t0) / REVEAL_MS;
                    else coverAlpha = 0;
                }

                if (coverAlpha < 1) {
                    // what is underneath
                    if (mine && mine[i]) {
                        if (i === game.boom) { ctx.fillStyle = C.magenta; ctx.fillRect(px, py, s, s); }
                        drawMine(px, py, s, i === game.boom ? C.paper : C.ink);
                    } else if (cnt[i] > 0 && showText) {
                        ctx.font = numFont;
                        ctx.fillStyle = C.num[cnt[i]];
                        ctx.fillText(cnt[i], px + s / 2, py + s * 0.53);
                    } else if (cnt[i] > 0) {
                        ctx.fillStyle = C.num[cnt[i]];
                        ctx.fillRect(px + s * 0.3, py + s * 0.3, s * 0.4, s * 0.4);
                    }
                }
                if (coverAlpha > 0) {
                    // uncharted water; while opening, the tile shrinks away
                    const k = coverAlpha < 1 ? (1 - coverAlpha) * s * 0.28 : 0;
                    let fill = C.water;
                    if (showProb && state !== FLAG && probs[i] >= 0) {
                        const p = probs[i];
                        fill = p === 0 ? C.buff : probRamp[Math.round(p * 100)];
                    } else if (i === hoverCell || i === pressCell) fill = C.waterLit;
                    ctx.globalAlpha = coverAlpha;
                    ctx.fillStyle = fill;
                    ctx.fillRect(px + gap + k, py + gap + k, s - 2 * gap - 2 * k, s - 2 * gap - 2 * k);
                    if (state === FLAG) {
                        const ft = flagTime[i];
                        const pop = ft && now < ft + 160 ? 1 + 0.45 * (1 - (now - ft) / 160) : 1;
                        drawFlag(px, py, s, pop);
                        if (lost && !mine[i]) drawCross(px, py, s);
                    } else if (showProb && showText) {
                        const p = probs[i];
                        if (p === 0) {
                            ctx.strokeStyle = C.ink; ctx.lineWidth = Math.max(1, s * 0.05);
                            ctx.beginPath(); ctx.arc(px + s / 2, py + s / 2, s * 0.17, 0, Math.PI * 2); ctx.stroke();
                        } else if (p === 1) {
                            drawMine(px, py, s, C.paper);
                        } else if (s >= 20) {
                            ctx.font = probFont;
                            ctx.fillStyle = p > 0.45 ? C.paper : C.ink;
                            ctx.fillText(Number.isNaN(p) ? '?' : (p < 0.01 ? '<1' : p > 0.99 ? '>99' : String(Math.round(p * 100))), px + s / 2, py + s * 0.53);
                        }
                    }
                    ctx.globalAlpha = 1;
                }
            }
        }

        // shock rings where the mine went off
        if (lost && boomTime && now < boomTime + 900 && game.boom >= 0) {
            const bx = ox + (game.boom % cols + 0.5) * s, by = oy + (Math.floor(game.boom / cols) + 0.5) * s;
            for (let k = 0; k < 2; k++) {
                const t = (now - boomTime - k * 180) / 720;
                if (t <= 0 || t >= 1) continue;
                ctx.globalAlpha = 1 - t;
                ctx.strokeStyle = C.magenta;
                ctx.lineWidth = Math.max(1.5, s * 0.1);
                ctx.beginPath(); ctx.arc(bx, by, s * (0.5 + 3.2 * t), 0, Math.PI * 2); ctx.stroke();
            }
            ctx.globalAlpha = 1;
        }
        // one sweep of light across the chart on a win
        if (game.won && winTime && now < winTime + 800) {
            const t = (now - winTime) / 800;
            const bx = ox - bw * 0.3 + bw * 1.6 * t;
            const g = ctx.createLinearGradient(bx - bw * 0.25, 0, bx + bw * 0.25, 0);
            g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, bw, bh); ctx.clip();
            ctx.fillStyle = g; ctx.fillRect(ox, oy, bw, bh); ctx.restore();
        }

        if (cursorVisible && cursor >= 0) {
            const px = ox + (cursor % cols) * s, py = oy + Math.floor(cursor / cols) * s;
            ctx.strokeStyle = C.paper; ctx.lineWidth = 4; ctx.strokeRect(px + 1, py + 1, s - 2, s - 2);
            ctx.strokeStyle = C.ink; ctx.lineWidth = 2; ctx.strokeRect(px + 1, py + 1, s - 2, s - 2);
        }
    }

    /** The chart's neatline: a graduated border, one division per cell. */
    function drawFrame(ox, oy, bw, bh, s, c0, c1, r0, r1) {
        const f = Math.max(3, Math.min(8, s * 0.24));
        const g = 2;
        const unit = s >= 7 ? 1 : 5;
        ctx.fillStyle = C.paper;
        ctx.fillRect(ox - f - g, oy - f - g, bw + 2 * (f + g), bh + 2 * (f + g));
        ctx.fillStyle = C.ink;
        for (let c = Math.floor(c0 / unit) * unit; c < c1; c += unit) {
            if ((c / unit) % 2) continue;
            const x = ox + c * s, wd = Math.min(unit, cfg.cols - c) * s;
            ctx.fillRect(x, oy - f - g, wd, f);
            ctx.fillRect(x, oy + bh + g, wd, f);
        }
        for (let r = Math.floor(r0 / unit) * unit; r < r1; r += unit) {
            if ((r / unit) % 2) continue;
            const y = oy + r * s, ht = Math.min(unit, cfg.rows - r) * s;
            ctx.fillRect(ox - f - g, y, f, ht);
            ctx.fillRect(ox + bw + g, y, f, ht);
        }
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(ox - f - g) - 0.5, Math.round(oy - f - g) - 0.5, Math.round(bw + 2 * (f + g)) + 1, Math.round(bh + 2 * (f + g)) + 1);
        ctx.strokeRect(Math.round(ox) - 0.5, Math.round(oy) - 0.5, Math.round(bw) + 1, Math.round(bh) + 1);
    }

    function drawFlag(px, py, s, pop) {
        if (s < 9) {
            ctx.fillStyle = C.magenta;
            ctx.fillRect(px + s * 0.25, py + s * 0.25, s * 0.5, s * 0.5);
            return;
        }
        ctx.save();
        ctx.translate(px + s / 2, py + s / 2);
        ctx.scale(pop, pop);
        ctx.translate(-s / 2, -s / 2);
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = Math.max(1.2, s * 0.07);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(s * 0.38, s * 0.2); ctx.lineTo(s * 0.38, s * 0.8);
        ctx.moveTo(s * 0.26, s * 0.8); ctx.lineTo(s * 0.52, s * 0.8);
        ctx.stroke();
        ctx.fillStyle = C.magenta;
        ctx.beginPath();
        ctx.moveTo(s * 0.38, s * 0.19); ctx.lineTo(s * 0.77, s * 0.34); ctx.lineTo(s * 0.38, s * 0.5);
        ctx.closePath(); ctx.fill();
        ctx.restore();
    }

    function drawMine(px, py, s, color) {
        const cx = px + s / 2, cy = py + s / 2;
        ctx.fillStyle = color;
        if (s < 9) { ctx.fillRect(cx - s * 0.22, cy - s * 0.22, s * 0.44, s * 0.44); return; }
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.2, s * 0.07);
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let k = 0; k < 8; k++) {
            const a = k * Math.PI / 4, r = k % 2 ? s * 0.29 : s * 0.35;
            ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        }
        ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, s * 0.21, 0, Math.PI * 2); ctx.fill();
    }

    function drawCross(px, py, s) {
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = Math.max(1.5, s * 0.09);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(px + s * 0.2, py + s * 0.2); ctx.lineTo(px + s * 0.8, py + s * 0.8);
        ctx.moveTo(px + s * 0.8, py + s * 0.2); ctx.lineTo(px + s * 0.2, py + s * 0.8);
        ctx.stroke();
    }

    // ------------------------------------------------------------------ timer

    function elapsed() { return timerBase + (timerRunning ? performance.now() - timerStart : 0); }
    function startTimer() { if (!timerRunning) { timerStart = performance.now(); timerRunning = true; } }
    function stopTimer() { if (timerRunning) { timerBase += performance.now() - timerStart; timerRunning = false; } }
    function resetTimer() { timerBase = 0; timerRunning = false; }
    function updateHud() {
        $('timer').textContent = fmtTime(elapsed(), false);
        $('mines-left').textContent = game ? String(cfg.mines - game.flags) : String(cfg.mines);
    }
    setInterval(() => { if (timerRunning) $('timer').textContent = fmtTime(elapsed(), false); }, 200);

    // ------------------------------------------------------------- game flow

    function levelLabel() {
        const p = PRESETS[cfg.preset];
        $('level-name').textContent = (p ? p.name : 'カスタム') + (cfg.noGuess ? '・推測なし' : '');
        $('level-size').textContent = `${cfg.cols}×${cfg.rows}、地雷 ${cfg.mines}`;
    }

    function newGame() {
        generator = null; busy = false;
        canvas.classList.remove('busy');
        game = new E.Game(cfg.rows, cfg.cols, cfg.mines);
        animStart = new Float64Array(game.n);
        flagTime = new Float64Array(game.n);
        probs = null; hintUsed = hintOn; retried = false; guaranteed = false;
        boomTime = 0; winTime = 0;
        cursor = Math.floor(cfg.rows / 2) * cfg.cols + Math.floor(cfg.cols / 2);
        resetTimer();
        setPaused(false);
        $('result').hidden = true;
        levelLabel();
        updateHud();
        fitView();
        setStatus(cfg.noGuess
            ? '好きなマスを開いて始めます。最初の一手は必ず安全で、推測なしで解ける盤面を用意します。'
            : '好きなマスを開いて始めます。最初の一手は必ず安全です。');
        requestDraw();
    }

    function retryGame() {
        if (!game || !game.ready || busy) return;
        game.reset();
        animStart.fill(0); flagTime.fill(0);
        probs = null; hintUsed = hintOn; retried = true;
        boomTime = 0; winTime = 0;
        resetTimer();
        setPaused(false);
        $('result').hidden = true;
        updateHud();
        setStatus('同じ盤面をもう一度。この回はベストタイムに記録されません。');
        requestDraw();
    }

    /** First click: build the board around it (in time slices, so the page never freezes). */
    function generateThenOpen(i) {
        busy = true;
        canvas.classList.add('busy');
        const t0 = performance.now();
        generator = new E.Generator(cfg.rows, cfg.cols, cfg.mines, i, { noGuess: cfg.noGuess, timeLimit: GEN_TIME_LIMIT });
        const g = generator;
        const tick = () => {
            if (generator !== g) return;                      // a new game was started meanwhile
            if (!g.step(12)) {
                if (performance.now() - t0 > 250) setStatus('推測なしで解ける盤面を作っています…');
                setTimeout(tick, 0);
                return;
            }
            generator = null; busy = false;
            canvas.classList.remove('busy');
            game.setBoard(g.mine);
            guaranteed = g.guaranteed;
            if (!cfg.noGuess) setStatus('通常の盤面です。推測が必要になる場合があります。');
            else if (guaranteed) setStatus('この盤面は推測なしで最後まで解けます。');
            else setStatus('時間内に推測なしの盤面を作れませんでした。この盤面は推測が必要になる場合があります。');
            startTimer();
            applyOpen(game.open(i));
        };
        tick();
    }

    function canPlay() { return game && !game.over && !busy && !paused; }

    function openCell(i) {
        if (!canPlay() || i < 0) return;
        if (!game.ready) {
            if (game.state[i] === FLAG) return;
            generateThenOpen(i);
            return;
        }
        if (game.state[i] === OPEN) applyOpen(game.chord(i));
        else if (game.state[i] === HIDDEN) { startTimer(); applyOpen(game.open(i)); }
    }

    function chordCell(i) {
        if (!canPlay() || i < 0 || !game.ready) return;
        applyOpen(game.chord(i));
    }

    function flagCell(i) {
        if (!canPlay() || i < 0) return;
        if (game.toggleFlag(i)) {
            flagTime[i] = game.state[i] === FLAG && !reducedMotion.matches ? performance.now() : 0;
            if (flagTime[i]) animate(flagTime[i] + 180);
            updateHud();
            requestDraw();
        }
    }

    function applyOpen(out) {
        if (!out.cells.length) return;
        const now = performance.now();
        if (!reducedMotion.matches) {
            let maxD = 0;
            for (let k = 0; k < out.dist.length; k++) if (out.dist[k] > maxD) maxD = out.dist[k];
            const stepMs = maxD ? Math.min(26, 420 / maxD) : 0;
            for (let k = 0; k < out.cells.length; k++) animStart[out.cells[k]] = now + 1 + out.dist[k] * stepMs;
            animate(now + maxD * stepMs + REVEAL_MS + 30);
        }
        if (game.over) finish(now);
        else if (hintOn) scheduleHint();
        updateHud();
        requestDraw();
    }

    function finish(now) {
        stopTimer();
        const time = elapsed();
        const result = $('result');
        probs = null;
        if (game.won) {
            winTime = reducedMotion.matches ? 0 : now;
            if (winTime) animate(now + 850);
            const key = bestKey();
            const best = store.get('ms2.best', {});
            let detail = `タイム ${fmtTime(time, true)}`;
            if (hintUsed) detail += '（確率表示を使ったため記録なし）';
            else if (retried) detail += '（やり直しのため記録なし）';
            else if (!(key in best) || time < best[key]) {
                detail += key in best ? `、ベスト更新（これまで ${fmtTime(best[key], true)}）` : '、初めての記録です';
                best[key] = Math.round(time);
                store.set('ms2.best', best);
            } else detail += `、ベストは ${fmtTime(best[key], true)}`;
            $('result-title').textContent = '掃海完了';
            $('result-detail').textContent = detail;
            result.classList.remove('lost');
            setStatus('すべての安全なマスを開きました。');
        } else {
            const cols = cfg.cols, bx = game.boom % cols, by = Math.floor(game.boom / cols);
            if (!reducedMotion.matches) {
                boomTime = now;
                let maxD = 1;
                const ds = [];
                for (let i = 0; i < game.n; i++) {
                    if (!game.mine[i] || i === game.boom || game.state[i] === FLAG) continue;
                    const d = Math.hypot(i % cols - bx, Math.floor(i / cols) - by);
                    ds.push(i, d);
                    if (d > maxD) maxD = d;
                }
                const stepMs = Math.min(34, 900 / maxD);
                for (let k = 0; k < ds.length; k += 2) animStart[ds[k]] = now + 140 + ds[k + 1] * stepMs;
                animate(now + 140 + maxD * stepMs + REVEAL_MS + 60);
            }
            const left = game.n - game.mines - game.opened;
            $('result-title').textContent = '触雷';
            $('result-detail').textContent = `安全なマスが ${left} 個残っていました（${fmtTime(time, true)}）`;
            result.classList.add('lost');
            setStatus('地雷を開いてしまいました。');
        }
        result.hidden = false;
    }

    // ------------------------------------------------------------------- hint

    let hintTimer = 0;
    function scheduleHint() {
        clearTimeout(hintTimer);
        hintTimer = setTimeout(computeHint, 0);
    }
    function computeHint() {
        if (!hintOn || !game || game.over) return;
        if (!game.ready) {
            probs = null;
            setStatus('最初のマスを開くと、各マスの地雷の確率を表示します。');
            requestDraw();
            return;
        }
        hintUsed = true;
        const res = game.analyze();
        if (res.error) { probs = null; setStatus('確率を計算できませんでした。'); requestDraw(); return; }
        probs = res.prob;
        let safe = 0, best = 2;
        for (let i = 0; i < game.n; i++) {
            const p = probs[i];
            if (game.state[i] === OPEN || !(p >= 0)) continue;
            if (p === 0) safe++;
            if (p < best) best = p;
        }
        let msg;
        if (safe) msg = `確実に安全なマスが ${safe} 個あります（淡い黄色に丸印）。`;
        else if (best <= 1) msg = `確実に安全なマスはありません。いちばん安全なマスの地雷率は ${best < 0.01 ? '1% 未満' : Math.round(best * 100) + '%'} です。`;
        else msg = '確率を表示しています。';
        if (!res.complete) msg += ' 一部の領域は複雑すぎるため「?」と表示しています。';
        setStatus(msg);
        requestDraw();
    }
    function setHint(on) {
        hintOn = on;
        $('hint-toggle').setAttribute('aria-pressed', String(on));
        if (on) computeHint();
        else { probs = null; if (game && !game.over) setStatus('確率表示を消しました。'); requestDraw(); }
    }

    // ------------------------------------------------------------------ pause

    function setPaused(p) {
        if (p && (!game || game.over || !game.ready)) p = false;
        paused = p;
        $('pause-cover').hidden = !p;
        if (p) stopTimer();
        else if (game && game.ready && !game.over && game.opened > 0) startTimer();
        if (p) $('resume').focus();
    }

    // ---------------------------------------------------------------- pointer

    const pointers = new Map();
    let tap = null;       // the single active press
    let pinch = null;
    let longTimer = 0;

    function localPos(e) {
        const r = canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    canvas.addEventListener('pointerdown', (e) => {
        canvas.focus({ preventScroll: true });
        cursorVisible = false;
        const p = localPos(e);
        pointers.set(e.pointerId, p);
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

        if (pointers.size === 2) {
            clearTimeout(longTimer);
            const [a, b] = [...pointers.values()];
            pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
            if (tap) tap.cancelled = true;
            pressCell = -1;
            requestDraw();
            return;
        }
        if (pointers.size > 2) return;

        const cell = cellAt(p.x, p.y);
        if (e.pointerType === 'mouse' && e.button === 2) {
            // right button: flag at once (on an open number with the left button held it is a chord, see mousedown)
            if (!(e.buttons & 1)) flagCell(cell);
            tap = null;
            return;
        }
        if (e.pointerType === 'mouse' && e.button === 1) {
            e.preventDefault();
            chordCell(cell);
            tap = null;
            return;
        }
        tap = { id: e.pointerId, x: p.x, y: p.y, vx: view.x, vy: view.y, cell, moved: false, cancelled: false, type: e.pointerType };
        pressCell = canPlay() && cell >= 0 && game.state[cell] === HIDDEN ? cell : -1;
        clearTimeout(longTimer);
        longTimer = setTimeout(() => {
            if (!tap || tap.moved || tap.cancelled) return;
            tap.cancelled = true;
            pressCell = -1;
            if (canPlay() && tap.cell >= 0 && game.state[tap.cell] !== OPEN) {
                flagCell(tap.cell);
                if (navigator.vibrate) { try { navigator.vibrate(30); } catch (err) { /* ignore */ } }
            }
            requestDraw();
        }, LONG_PRESS_MS);
        requestDraw();
    });

    // a second mouse button pressed while the first is held does not fire pointerdown
    canvas.addEventListener('mousedown', (e) => {
        if ((e.buttons & 3) === 3) {
            const p = localPos(e);
            clearTimeout(longTimer);
            if (tap) tap.cancelled = true;
            pressCell = -1;
            chordCell(cellAt(p.x, p.y));
        }
    });

    canvas.addEventListener('pointermove', (e) => {
        const p = localPos(e);
        if (!pointers.has(e.pointerId)) {
            if (e.pointerType === 'mouse') {
                const hc = canPlay() ? cellAt(p.x, p.y) : -1;
                const nh = hc >= 0 && game.state[hc] === HIDDEN ? hc : -1;
                if (nh !== hoverCell) { hoverCell = nh; requestDraw(); }
            }
            return;
        }
        pointers.set(e.pointerId, p);
        if (pinch && pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            view.x += mx - pinch.mx; view.y += my - pinch.my;
            zoomAt(mx, my, d / pinch.d);
            pinch = { d, mx, my };
            return;
        }
        if (!tap || tap.id !== e.pointerId) return;
        const dx = p.x - tap.x, dy = p.y - tap.y;
        if (!tap.moved && Math.hypot(dx, dy) > (tap.type === 'mouse' ? 6 : 10)) {
            tap.moved = true;
            clearTimeout(longTimer);
            pressCell = -1; hoverCell = -1;
            canvas.classList.add('panning');
        }
        if (tap.moved) {
            view.x = tap.vx + dx; view.y = tap.vy + dy;
            clampView();
            requestDraw();
        }
    });

    function endPointer(e, fire) {
        if (!pointers.has(e.pointerId)) return;
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = null;
        if (tap && tap.id === e.pointerId) {
            clearTimeout(longTimer);
            const t = tap;
            tap = null; pressCell = -1;
            canvas.classList.remove('panning');
            if (fire && !t.moved && !t.cancelled) {
                const p = localPos(e);
                const cell = cellAt(p.x, p.y);
                if (cell === t.cell && cell >= 0) {
                    cursor = cell;
                    if (flagMode && game && game.state[cell] !== OPEN) flagCell(cell);
                    else openCell(cell);
                }
            }
            requestDraw();
        } else if (pointers.size === 1 && tap) {
            // one finger of a pinch lifted: continue as a pan from here
            const rest = [...pointers.values()][0];
            tap.x = rest.x; tap.y = rest.y; tap.vx = view.x; tap.vy = view.y; tap.moved = true;
        }
    }
    canvas.addEventListener('pointerup', (e) => endPointer(e, true));
    canvas.addEventListener('pointercancel', (e) => endPointer(e, false));
    canvas.addEventListener('pointerleave', () => { if (hoverCell !== -1) { hoverCell = -1; requestDraw(); } });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('auxclick', (e) => e.preventDefault());
    canvas.addEventListener('dragstart', (e) => e.preventDefault());

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const p = localPos(e);
        const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
        if (e.ctrlKey && !e.metaKey && Math.abs(dy) >= 50) { view.y -= Math.sign(dy) * 40; clampView(); requestDraw(); }
        else if (e.shiftKey) { view.x -= Math.sign(dy || e.deltaX) * 40; clampView(); requestDraw(); }
        else zoomAt(p.x, p.y, Math.exp(-Math.max(-120, Math.min(120, dy)) * (e.ctrlKey ? 0.01 : 0.0016)));
    }, { passive: false });

    // --------------------------------------------------------------- keyboard

    document.addEventListener('keydown', (e) => {
        if ($('settings').open) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = e.target && e.target.tagName;
        const onButton = tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'SUMMARY';
        const k = e.key;
        if (k === 'Escape') { if (paused) setPaused(false); else setPaused(true); e.preventDefault(); return; }
        if (k === 'n' || k === 'N') { newGame(); e.preventDefault(); return; }
        if (k === 'r' || k === 'R') { retryGame(); e.preventDefault(); return; }
        if (k === 'p' || k === 'P') { setHint(!hintOn); e.preventDefault(); return; }
        if (k === '0') { fitView(true); requestDraw(); e.preventDefault(); return; }
        if (k === '+' || k === ';') { zoomAt(view.w / 2, view.h / 2, 1.25); return; }
        if (k === '-') { zoomAt(view.w / 2, view.h / 2, 0.8); return; }
        if (!game || paused) return;
        const cols = cfg.cols, rows = cfg.rows;
        let r = Math.floor(cursor / cols), c = cursor % cols, moved = true;
        if (k === 'ArrowLeft') c = Math.max(0, c - 1);
        else if (k === 'ArrowRight') c = Math.min(cols - 1, c + 1);
        else if (k === 'ArrowUp') r = Math.max(0, r - 1);
        else if (k === 'ArrowDown') r = Math.min(rows - 1, r + 1);
        else moved = false;
        if (moved) {
            cursor = r * cols + c; cursorVisible = true;
            ensureVisible(cursor);
            requestDraw(); e.preventDefault();
            return;
        }
        if (onButton) return;
        if (k === ' ' || k === 'Enter') { cursorVisible = true; openCell(cursor); e.preventDefault(); }
        else if (k === 'f' || k === 'F') { cursorVisible = true; flagCell(cursor); e.preventDefault(); }
    });

    // --------------------------------------------------------------- settings

    const dialog = $('settings');
    const form = $('settings-form');

    function renderBest() {
        const best = store.get('ms2.best', {});
        const dl = $('best-list');
        dl.textContent = '';
        let any = false;
        const add = (label, key) => {
            if (!(key in best)) return;
            any = true;
            const dt = document.createElement('dt'); dt.textContent = label;
            const dd = document.createElement('dd'); dd.textContent = fmtTime(best[key], true);
            dl.append(dt, dd);
        };
        const known = new Set();
        for (const id of Object.keys(PRESETS)) {
            const p = PRESETS[id], base = `${p.rows}x${p.cols}x${p.mines}`;
            known.add(base); known.add(base + '-ng');
            add(`${p.name}（推測なし）`, base + '-ng');
            add(p.name, base);
        }
        for (const key of Object.keys(best)) {
            if (known.has(key)) continue;
            const m = /^(\d+)x(\d+)x(\d+)(-ng)?$/.exec(key);
            if (m) add(`${m[2]}×${m[1]}、地雷 ${m[3]}${m[4] ? '（推測なし）' : ''}`, key);
        }
        if (!any) {
            const dd = document.createElement('dd');
            dd.className = 'none';
            dd.textContent = 'まだ記録がありません。クリアすると、ここにタイムが残ります。';
            dl.append(dd);
        }
    }

    function syncCustomFields() {
        const preset = form.elements.preset.value;
        const p = PRESETS[preset];
        if (p) {
            $('rows-input').value = p.rows; $('cols-input').value = p.cols; $('mines-input').value = p.mines;
        }
        $('custom-fields').hidden = !!p;
        $('settings-error').hidden = true;
    }

    function openSettings() {
        if (game && game.ready && !game.over) setPaused(true);
        form.elements.preset.value = cfg.preset;
        $('rows-input').value = cfg.rows; $('cols-input').value = cfg.cols; $('mines-input').value = cfg.mines;
        $('noguess-input').checked = cfg.noGuess;
        $('theme-input').value = cfg.theme;
        syncCustomFields();
        renderBest();
        if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
        const checked = form.querySelector('input[name=preset]:checked');
        if (checked) checked.focus();
    }
    function closeSettings() {
        if (dialog.close) dialog.close(); else dialog.removeAttribute('open');
    }

    form.addEventListener('change', (e) => {
        if (e.target.name === 'preset') syncCustomFields();
        if (e.target.id === 'theme-input') { cfg.theme = e.target.value; store.set('ms2.settings', cfg); applyTheme(); }
    });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const preset = form.elements.preset.value;
        const rows = Number($('rows-input').value), cols = Number($('cols-input').value), mines = Number($('mines-input').value);
        const err = $('settings-error');
        let msg = '';
        if (![rows, cols, mines].every(Number.isInteger)) msg = '行・列・地雷には整数を入力してください。';
        else if (rows < 4 || rows > 100 || cols < 4 || cols > 100) msg = '行と列は 4 から 100 の間で指定してください。';
        else if (mines < 1 || mines > rows * cols - 9) msg = `この大きさでは、地雷は 1 から ${rows * cols - 9} の間で指定してください。`;
        if (msg) { err.textContent = msg; err.hidden = false; return; }
        Object.assign(cfg, { preset, rows, cols, mines, noGuess: $('noguess-input').checked, theme: $('theme-input').value });
        store.set('ms2.settings', cfg);
        closeSettings();
        newGame();
    });
    $('settings-cancel').addEventListener('click', closeSettings);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) closeSettings(); });

    // ---------------------------------------------------------------- buttons

    $('open-settings').addEventListener('click', openSettings);
    $('new-game').addEventListener('click', newGame);
    $('result-new').addEventListener('click', newGame);
    $('result-retry').addEventListener('click', retryGame);
    $('hint-toggle').addEventListener('click', () => setHint(!hintOn));
    $('pause').addEventListener('click', () => setPaused(!paused));
    $('resume').addEventListener('click', () => { setPaused(false); canvas.focus({ preventScroll: true }); });
    $('fit-view').addEventListener('click', () => { fitView(true); requestDraw(); });
    $('flag-mode').addEventListener('click', () => {
        flagMode = !flagMode;
        $('flag-mode').setAttribute('aria-pressed', String(flagMode));
        setStatus(flagMode ? '旗モード：タップで旗を立てます。数字のタップは今までどおり周りを開きます。' : '旗モードを終了しました。');
    });

    document.addEventListener('visibilitychange', () => { if (document.hidden && game && game.ready && !game.over) setPaused(true); });
    window.addEventListener('resize', resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe($('sea'));
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

    // ------------------------------------------------------------------ start

    applyTheme();
    resize();
    newGame();

    // handle for debugging / automated checks
    window.__ms = { get game() { return game; }, cfg, view, openCell, flagCell, newGame, setHint, cellAt };
})();
