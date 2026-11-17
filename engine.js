/*
 * Minesweeper engine — board generation, exact probability analysis, logic solver.
 * No DOM access. Works as a <script> (global MSEngine) and as a Node module.
 *
 * Cell index = row * cols + col.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.MSEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const TINY = 5e-324;

    // ---------------------------------------------------------------- utils

    function makeRng(seed) {
        let a = (seed >>> 0) || 0x9e3779b9;
        return function () {
            a = (a + 0x6d2b79f5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    const nbCache = new Map();
    /** Flat neighbour table: neighbours of i are list[start[i] .. start[i+1]). */
    function getNeighbors(rows, cols) {
        const key = rows + 'x' + cols;
        let t = nbCache.get(key);
        if (t) return t;
        const n = rows * cols;
        const start = new Int32Array(n + 1);
        const list = new Int32Array(n * 8);
        let p = 0;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                start[r * cols + c] = p;
                for (let dr = -1; dr <= 1; dr++) {
                    const nr = r + dr;
                    if (nr < 0 || nr >= rows) continue;
                    for (let dc = -1; dc <= 1; dc++) {
                        const nc = c + dc;
                        if ((dr || dc) && nc >= 0 && nc < cols) list[p++] = nr * cols + nc;
                    }
                }
            }
        }
        start[n] = p;
        t = { start, list: list.slice(0, p) };
        if (nbCache.size > 8) nbCache.clear();
        nbCache.set(key, t);
        return t;
    }

    let logFact = new Float64Array([0, 0]);
    function ensureLogFact(n) {
        if (logFact.length > n) return;
        const nf = new Float64Array(n + 2);
        nf.set(logFact);
        for (let i = logFact.length; i < nf.length; i++) nf[i] = nf[i - 1] + Math.log(i);
        logFact = nf;
    }
    function logChoose(n, k) {
        return logFact[n] - logFact[k] - logFact[n - k];
    }

    const BINOM = [];
    for (let n = 0; n <= 8; n++) {
        BINOM.push([1]);
        for (let k = 1; k <= n; k++) BINOM[n].push(BINOM[n][k - 1] * (n - k + 1) / k);
    }

    /** Number of adjacent mines for every cell (also for mine cells). */
    function adjacentCounts(rows, cols, mine) {
        const { start, list } = getNeighbors(rows, cols);
        const n = rows * cols;
        const cnt = new Int8Array(n);
        for (let i = 0; i < n; i++) {
            if (!mine[i]) continue;
            for (let p = start[i]; p < start[i + 1]; p++) cnt[list[p]]++;
        }
        return cnt;
    }

    /** Random mines; the first cell and (if there is room) its neighbours stay clear. */
    function placeMines(rows, cols, mines, first, rng) {
        const n = rows * cols;
        const { start, list } = getNeighbors(rows, cols);
        const blocked = new Uint8Array(n);
        blocked[first] = 1;
        let free = n - 1;
        const zone = start[first + 1] - start[first];
        if (n - 1 - zone >= mines) {
            for (let p = start[first]; p < start[first + 1]; p++) blocked[list[p]] = 1;
            free -= zone;
        }
        const pool = new Int32Array(free);
        let k = 0;
        for (let i = 0; i < n; i++) if (!blocked[i]) pool[k++] = i;
        const mine = new Uint8Array(n);
        const m = Math.min(mines, free);
        for (let i = 0; i < m; i++) {
            const j = i + Math.floor(rng() * (free - i));
            const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
            mine[pool[i]] = 1;
        }
        return mine;
    }

    // ------------------------------------------------- exact probabilities

    function normalize(arr) {
        let mx = 0;
        for (let i = 0; i < arr.length; i++) if (arr[i] > mx) mx = arr[i];
        if (mx === 0 || (mx < 1e100 && mx > 1e-100)) return arr;
        const inv = 1 / mx;
        for (let i = 0; i < arr.length; i++) {
            const v = arr[i];
            if (v !== 0) { const s = v * inv; arr[i] = s === 0 ? TINY : s; }
        }
        return arr;
    }

    /** Convolution that never lets a positive product underflow to exactly 0. */
    function conv(a, b) {
        const out = new Float64Array(a.length + b.length - 1);
        for (let i = 0; i < a.length; i++) {
            const x = a[i];
            if (x === 0) continue;
            for (let j = 0; j < b.length; j++) {
                const y = b[j];
                if (y === 0) continue;
                const p = x * y;
                out[i + j] += p === 0 ? TINY : p;
            }
        }
        return normalize(out);
    }

    /**
     * Exact analysis of one connected component of the constraint graph.
     * Cells sharing the same constraints are merged into groups; a transfer-matrix
     * DP runs over the groups (state = partial sums of the constraints crossing the
     * cut), forwards then backwards, which yields for every possible mine total K
     * of the component: the number of solutions W[K] and each group's mine share.
     * Equivalent to full enumeration, but polynomial along a long frontier.
     */
    function solveComponent(gIds, G, ctx) {
        const { groupCons, groupSize, consNeed, consGroups, consRem, consCap, consStamp, consSeen, gPos, budget } = ctx;

        // ---- ordering: keep few constraints open at any cut
        const order = [];
        const cand = [];
        const inCand = ctx.inCand;
        let first = gIds[0];
        for (const g of gIds) if (groupCons[g].length < groupCons[first].length) first = g;
        cand.push(first); inCand[first] = 1;
        while (cand.length) {
            let bi = 0, bs = Infinity;
            for (let i = 0; i < cand.length; i++) {
                const cs = groupCons[cand[i]];
                let s = 0;
                for (let q = 0; q < cs.length; q++) {
                    const c = cs[q];
                    if (consRem[c] === consGroups[c].length) s += 16;
                    if (consRem[c] === 1) s -= 1;
                }
                if (s < bs) { bs = s; bi = i; }
            }
            const g = cand[bi];
            cand.splice(bi, 1);
            gPos[g] = order.length;
            order.push(g);
            const cs = groupCons[g];
            for (let q = 0; q < cs.length; q++) {
                const c = cs[q];
                consRem[c]--;
                const gs = consGroups[c];
                for (let u = 0; u < gs.length; u++) {
                    const g2 = gs[u];
                    if (!inCand[g2]) { inCand[g2] = 1; cand.push(g2); }
                }
            }
        }

        // ---- per-layer transition tables
        const layers = new Array(G);
        let open = [];
        for (let t = 0; t < G; t++) {
            const g = order[t];
            const size = groupSize[g];
            const cs = groupCons[g];
            const stamp = ++ctx.stampCounter;
            for (let q = 0; q < cs.length; q++) { consStamp[cs[q]] = stamp; consCap[cs[q]] -= size; }
            const closeSrc = [], closeNeed = [];
            const nextOpen = [], src = [], add = [], need = [], cap = [];
            for (let i = 0; i < open.length; i++) {
                const c = open[i];
                const has = consStamp[c] === stamp;
                if (has && consCap[c] === 0) { closeSrc.push(i); closeNeed.push(consNeed[c]); }
                else { nextOpen.push(c); src.push(i); add.push(has ? 1 : 0); need.push(consNeed[c]); cap.push(consCap[c]); }
            }
            for (let q = 0; q < cs.length; q++) {
                const c = cs[q];
                if (consSeen[c]) continue;
                consSeen[c] = 1;
                if (consCap[c] === 0) { closeSrc.push(-1); closeNeed.push(consNeed[c]); }
                else { nextOpen.push(c); src.push(-1); add.push(1); need.push(consNeed[c]); cap.push(consCap[c]); }
            }
            layers[t] = { size, closeSrc, closeNeed, src, add, need, cap };
            open = nextOpen;
        }

        const codes = [];
        function transition(L, key, j) {
            const { closeSrc, closeNeed, src, add, need, cap } = L;
            for (let i = 0; i < closeSrc.length; i++) {
                const s = closeSrc[i];
                if ((s >= 0 ? key.charCodeAt(s) : 0) + j !== closeNeed[i]) return null;
            }
            const n = src.length;
            codes.length = n;
            for (let i = 0; i < n; i++) {
                const s = src[i];
                const v = (s >= 0 ? key.charCodeAt(s) : 0) + (add[i] ? j : 0);
                const nd = need[i];
                if (v > nd || nd - v > cap[i]) return null;
                codes[i] = v;
            }
            return n === 0 ? '' : String.fromCharCode.apply(null, codes);
        }

        // ---- forward
        const F = new Array(G + 1);
        F[0] = [{ key: '', lo: 0, v: new Float64Array([1]) }];
        for (let t = 0; t < G; t++) {
            const L = layers[t];
            const bin = BINOM[L.size];
            const cur = F[t];
            const map = new Map();
            let base = Infinity;
            for (let i = 0; i < cur.length; i++) if (cur[i].lo < base) base = cur[i].lo;
            for (let i = 0; i < cur.length; i++) {
                const st = cur[i];
                const v = st.v, len = v.length;
                for (let j = 0; j <= L.size; j++) {
                    const nk = transition(L, st.key, j);
                    if (nk === null) continue;
                    let tg = map.get(nk);
                    if (!tg) { tg = { key: nk, a: [], min: Infinity, max: -1 }; map.set(nk, tg); }
                    const off = st.lo + j - base;
                    const a = tg.a;
                    while (a.length < off + len) a.push(0);
                    const w = bin[j];
                    for (let k = 0; k < len; k++) {
                        const x = v[k];
                        if (x !== 0) { const p = x * w; a[off + k] += p === 0 ? TINY : p; }
                    }
                    if (off < tg.min) tg.min = off;
                    if (off + len - 1 > tg.max) tg.max = off + len - 1;
                    budget.ops += len + 24;
                }
                if (budget.ops > budget.limit || map.size > budget.maxStates) return null;
            }
            const next = [];
            let mx = 0;
            for (const tg of map.values()) {
                const arr = Float64Array.from(tg.a.slice(tg.min, tg.max + 1));
                for (let k = 0; k < arr.length; k++) if (arr[k] > mx) mx = arr[k];
                next.push({ key: tg.key, lo: base + tg.min, v: arr });
            }
            if (mx > 1e100) {
                const inv = 1 / mx;
                for (const st of next) {
                    const v = st.v;
                    for (let k = 0; k < v.length; k++) if (v[k] !== 0) { const s = v[k] * inv; v[k] = s === 0 ? TINY : s; }
                }
            }
            F[t + 1] = next;
            if (next.length === 0) return { inconsistent: true };
        }

        const fin = F[G][0];
        const Klo = fin.lo, W = Float64Array.from(fin.v), KN = W.length;
        normalize(W);

        // ---- backward, accumulating each group's share
        const pm = new Array(G), canMine = new Array(G), canSafe = new Array(G);
        let Bn = new Map();
        Bn.set('', { lo: 0, v: new Float64Array([1]) });
        const entJ = [], entB = [];
        for (let t = G - 1; t >= 0; t--) {
            const L = layers[t];
            const bin = BINOM[L.size];
            const cur = F[t];
            const Bc = new Map();
            const mineK = new Float64Array(KN), safeK = new Float64Array(KN);
            let mx = 0;
            for (let i = 0; i < cur.length; i++) {
                const st = cur[i];
                entJ.length = 0; entB.length = 0;
                let lo = Infinity, hi = -1;
                for (let j = 0; j <= L.size; j++) {
                    const nk = transition(L, st.key, j);
                    if (nk === null) continue;
                    const b = Bn.get(nk);
                    if (!b) continue;
                    entJ.push(j); entB.push(b);
                    if (b.lo + j < lo) lo = b.lo + j;
                    if (b.lo + j + b.v.length - 1 > hi) hi = b.lo + j + b.v.length - 1;
                }
                if (hi < 0) continue;
                const len = hi - lo + 1;
                const bs = new Float64Array(len), dm = new Float64Array(len), ds = new Float64Array(len);
                for (let e = 0; e < entJ.length; e++) {
                    const j = entJ[e], b = entB[e], w = bin[j];
                    const off = b.lo + j - lo, bv = b.v;
                    const wm = j, wsafe = L.size - j;
                    for (let k = 0; k < bv.length; k++) {
                        const x = bv[k];
                        if (x === 0) continue;
                        let p = x * w; if (p === 0) p = TINY;
                        bs[off + k] += p;
                        if (wm) dm[off + k] += p * wm;
                        if (wsafe) ds[off + k] += p * wsafe;
                    }
                }
                // F ⊗ D
                const fv = st.v, shift = st.lo + lo - Klo;
                for (let a = 0; a < fv.length; a++) {
                    const x = fv[a];
                    if (x === 0) continue;
                    const o = shift + a;
                    for (let k = 0; k < len; k++) {
                        const K = o + k;
                        if (K < 0 || K >= KN) continue;
                        const m = dm[k], s = ds[k];
                        if (m !== 0) { const p = x * m; mineK[K] += p === 0 ? TINY : p; }
                        if (s !== 0) { const p = x * s; safeK[K] += p === 0 ? TINY : p; }
                    }
                }
                budget.ops += fv.length * len + len * 3 + 24 * (L.size + 1);
                if (budget.ops > budget.limit) return null;
                for (let k = 0; k < len; k++) if (bs[k] > mx) mx = bs[k];
                Bc.set(st.key, { lo, v: bs });
            }
            if (mx > 1e100) {
                const inv = 1 / mx;
                for (const b of Bc.values()) {
                    const v = b.v;
                    for (let k = 0; k < v.length; k++) if (v[k] !== 0) { const s = v[k] * inv; v[k] = s === 0 ? TINY : s; }
                }
            }
            const p = new Float64Array(KN), cm = new Uint8Array(KN), csf = new Uint8Array(KN);
            for (let K = 0; K < KN; K++) {
                const m = mineK[K], s = safeK[K];
                cm[K] = m > 0 ? 1 : 0; csf[K] = s > 0 ? 1 : 0;
                // m/(m+s) written so that neither huge nor tiny totals break it
                p[K] = m > 0 ? (s > 0 ? 1 / (1 + s / m) : 1) : 0;
            }
            pm[t] = p; canMine[t] = cm; canSafe[t] = csf;
            F[t] = null;
            Bn = Bc;
        }
        return { order, Klo, W, pm, canMine, canSafe };
    }

    /**
     * Exact mine probability for every unknown cell, given the revealed numbers.
     *   rev[i]    1 if cell i is revealed
     *   counts[i] adjacent-mine number of revealed cells
     *   known[i]  optional: 1 if cell i is already proven to be a mine
     * Returns { prob, safe[], mine[], complete, error }.
     *   prob[i] = P(mine) for unknown cells, -1 for revealed, 1 for known.
     *   safe/mine list the unknown cells that are certain (logically forced).
     *   complete=false means a component was too large for the work budget; its
     *   cells get prob NaN and nothing is reported as certain.
     */
    function analyze(rows, cols, totalMines, rev, counts, known, opts) {
        opts = opts || {};
        const n = rows * cols;
        const { start, list } = getNeighbors(rows, cols);
        const prob = new Float64Array(n).fill(-1);
        let knownCount = 0, unknownCount = 0;
        for (let i = 0; i < n; i++) {
            if (rev[i]) continue;
            if (known && known[i]) { knownCount++; prob[i] = 1; } else unknownCount++;
        }
        const R = totalMines - knownCount;
        const res = { prob, safe: [], mine: [], complete: true, error: false };
        if (unknownCount === 0) return res;
        if (R < 0 || R > unknownCount) { res.error = true; return res; }

        // ---- constraints
        const consNeed = [], consCells = [];
        const consOfCell = new Map();
        const active = opts.active;
        const total = active ? active.length : n;
        for (let a = 0; a < total; a++) {
            const i = active ? active[a] : a;
            if (!rev[i]) continue;
            let need = counts[i], cells = null;
            for (let p = start[i]; p < start[i + 1]; p++) {
                const j = list[p];
                if (rev[j]) continue;
                if (known && known[j]) need--;
                else (cells || (cells = [])).push(j);
            }
            if (!cells) { if (need !== 0) { res.error = true; return res; } continue; }
            if (need < 0 || need > cells.length) { res.error = true; return res; }
            const id = consNeed.length;
            consNeed.push(need); consCells.push(cells);
            for (let q = 0; q < cells.length; q++) {
                const arr = consOfCell.get(cells[q]);
                if (arr) arr.push(id); else consOfCell.set(cells[q], [id]);
            }
        }
        const frontier = consOfCell.size;
        const U = unknownCount - frontier;

        // ---- groups of cells with identical constraint sets
        const groupOf = new Map();
        const groupCells = [], groupCons = [];
        for (const [cell, cs] of consOfCell) {
            const key = cs.join(',');
            let g = groupOf.get(key);
            if (g === undefined) { g = groupCells.length; groupOf.set(key, g); groupCells.push([]); groupCons.push(cs); }
            groupCells[g].push(cell);
        }
        const NG = groupCells.length, NC = consNeed.length;
        const groupSize = groupCells.map(c => c.length);
        const consGroups = new Array(NC);
        for (let c = 0; c < NC; c++) consGroups[c] = [];
        for (let g = 0; g < NG; g++) for (const c of groupCons[g]) consGroups[c].push(g);

        const ctx = {
            groupCons, groupSize, consNeed, consGroups,
            consRem: new Int32Array(NC), consCap: new Int32Array(NC), consStamp: new Int32Array(NC), consSeen: new Uint8Array(NC),
            gPos: new Int32Array(NG), inCand: new Uint8Array(NG), stampCounter: 0,
            budget: { ops: 0, limit: 0, maxStates: 30000 }
        };
        for (let c = 0; c < NC; c++) {
            ctx.consRem[c] = consGroups[c].length;
            let cap = 0;
            for (const g of consGroups[c]) cap += groupSize[g];
            ctx.consCap[c] = cap;
        }

        // ---- components
        const compOf = new Int32Array(NG).fill(-1);
        const comps = [];
        for (let g0 = 0; g0 < NG; g0++) {
            if (compOf[g0] >= 0) continue;
            const id = comps.length, gs = [g0];
            compOf[g0] = id;
            for (let h = 0; h < gs.length; h++) {
                for (const c of groupCons[gs[h]]) for (const g2 of consGroups[c]) {
                    if (compOf[g2] < 0) { compOf[g2] = id; gs.push(g2); }
                }
            }
            comps.push(gs);
        }

        const solved = [];
        const totalBudget = opts.budget || 1.5e7;
        let spent = 0;
        for (const gs of comps) {
            // each component may use what is left of the total budget, at most half of it
            ctx.budget.limit = Math.min(totalBudget - spent, totalBudget / 2);
            ctx.budget.ops = 0;
            let r = ctx.budget.limit > 0 ? solveComponent(gs, gs.length, ctx) : null;
            spent += ctx.budget.ops;
            if (r && r.inconsistent) { res.error = true; return res; }
            if (!r) {
                res.complete = false;
                let cells = 0;
                for (const g of gs) cells += groupSize[g];
                const est = Math.max(0, Math.min(cells, Math.round(cells * R / unknownCount)));
                r = { order: gs, Klo: est, W: new Float64Array([1]), failed: true };
            }
            solved.push(r);
        }

        // ---- combine components with the global mine count
        ensureLogFact(n + 1);
        const m = solved.length;
        let Lsum = 0, S = 0;
        for (const r of solved) { Lsum += r.Klo; S += r.W.length - 1; }
        const T = new Float64Array(S + 1);
        let best = -Infinity, anyFeasible = false;
        for (let t = 0; t <= S; t++) {
            const left = R - Lsum - t;
            if (left >= 0 && left <= U) { const l = logChoose(U, left); if (l > best) best = l; anyFeasible = true; }
        }
        if (!anyFeasible) { res.error = true; return res; }
        for (let t = 0; t <= S; t++) {
            const left = R - Lsum - t;
            if (left >= 0 && left <= U) { const e = Math.exp(logChoose(U, left) - best); T[t] = e === 0 ? TINY : e; }
        }
        const prefix = new Array(m + 1), suffix = new Array(m + 1);
        prefix[0] = new Float64Array([1]);
        for (let i = 0; i < m; i++) prefix[i + 1] = conv(prefix[i], solved[i].W);
        suffix[m] = new Float64Array([1]);
        for (let i = m - 1; i >= 0; i--) suffix[i] = conv(suffix[i + 1], solved[i].W);

        const certain = res.complete;
        for (let i = 0; i < m; i++) {
            const r = solved[i];
            const oth = conv(prefix[i], suffix[i + 1]);
            const KN = r.W.length;
            const post = new Float64Array(KN);
            let Z = 0;
            for (let x = 0; x < KN; x++) {
                const w = r.W[x];
                if (w === 0) continue;
                let s = 0;
                for (let q = 0; q < oth.length; q++) {
                    const o = oth[q], tt = T[x + q];
                    if (o !== 0 && tt !== 0) { const p = o * tt; s += p === 0 ? TINY : p; }
                }
                if (s !== 0) { const p = w * s; post[x] = p === 0 ? TINY : p; }
                Z += post[x];
            }
            if (Z === 0) { res.error = true; return res; }
            for (let t = 0; t < r.order.length; t++) {
                const cells = groupCells[r.order[t]];
                if (r.failed) { for (const c of cells) prob[c] = NaN; continue; }
                const pmv = r.pm[t], cm = r.canMine[t], cs = r.canSafe[t];
                let p = 0, mineOk = false, safeOk = false;
                for (let x = 0; x < KN; x++) {
                    if (post[x] === 0) continue;
                    p += post[x] / Z * pmv[x];
                    if (cm[x]) mineOk = true;
                    if (cs[x]) safeOk = true;
                }
                if (!mineOk) p = 0; else if (!safeOk) p = 1;
                else p = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
                for (const c of cells) {
                    prob[c] = p;
                    if (certain) { if (!mineOk) res.safe.push(c); else if (!safeOk) res.mine.push(c); }
                }
            }
        }

        if (U > 0) {
            const all = prefix[m];
            let Z = 0, E = 0, allZero = true, allFull = true;
            for (let t = 0; t <= S; t++) {
                if (all[t] === 0 || T[t] === 0) continue;
                let p = all[t] * T[t]; if (p === 0) p = TINY;
                const left = R - Lsum - t;
                Z += p; E += p * left;
                if (left !== 0) allZero = false;
                if (left !== U) allFull = false;
            }
            if (Z === 0) { res.error = true; return res; }
            let p = E / Z / U;
            if (allZero) p = 0; else if (allFull) p = 1;
            else p = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
            for (let i = 0; i < n; i++) {
                if (rev[i] || prob[i] !== -1) continue;
                prob[i] = p;
                if (certain) { if (allZero) res.safe.push(i); else if (allFull) res.mine.push(i); }
            }
        }
        return res;
    }

    // --------------------------------------------------------- logic solver

    /**
     * Plays a board using only certain deductions:
     *   1. single-number rule, 2. subset rule between two numbers,
     *   3. exact analysis (components + global mine count).
     * With perturbation enabled it repairs the board whenever it would have to
     * guess, by moving a frontier mine somewhere else.
     */
    class Solver {
        constructor(rows, cols, mine, totalMines, rng) {
            this.rows = rows; this.cols = cols; this.n = rows * cols;
            this.mine = mine;
            this.total = totalMines;
            this.rng = rng || Math.random;
            this.nb = getNeighbors(rows, cols);
            this.cnt = adjacentCounts(rows, cols, mine);
            this.rev = new Uint8Array(this.n);
            this.km = new Uint8Array(this.n);
            this.unknown = this.n;
            this.revealed = 0;
            this.queue = [];
            this.inQ = new Uint8Array(this.n);
            this.active = [];
            this.perturbs = 0;
            this.stats = { simple: 0, subset: 0, engine: 0, engineCalls: 0 };
        }

        _enqueue(i) { if (!this.inQ[i]) { this.inQ[i] = 1; this.queue.push(i); } }

        reveal(i0) {
            const { start, list } = this.nb;
            const stack = [i0];
            while (stack.length) {
                const i = stack.pop();
                if (this.rev[i] || this.km[i]) continue;
                if (this.mine[i]) throw new Error('solver revealed a mine at ' + i);
                this.rev[i] = 1; this.revealed++; this.unknown--;
                this.active.push(i);
                this._enqueue(i);
                const zero = this.cnt[i] === 0;
                for (let p = start[i]; p < start[i + 1]; p++) {
                    const j = list[p];
                    if (this.rev[j]) this._enqueue(j);
                    else if (zero && !this.km[j]) stack.push(j);
                }
            }
        }

        markMine(i) {
            if (this.rev[i] || this.km[i]) return;
            if (!this.mine[i]) throw new Error('solver flagged a safe cell at ' + i);
            const { start, list } = this.nb;
            this.km[i] = 1; this.unknown--;
            for (let p = start[i]; p < start[i + 1]; p++) if (this.rev[list[p]]) this._enqueue(list[p]);
        }

        get solved() { return this.revealed === this.n - this.total; }

        runSimple() {
            const { start, list } = this.nb;
            const q = this.queue;
            while (q.length) {
                const i = q.pop();
                this.inQ[i] = 0;
                if (!this.rev[i]) continue;
                let need = this.cnt[i], unk = 0;
                for (let p = start[i]; p < start[i + 1]; p++) {
                    const j = list[p];
                    if (this.rev[j]) continue;
                    if (this.km[j]) need--; else unk++;
                }
                if (unk === 0) continue;
                if (need === 0) {
                    for (let p = start[i]; p < start[i + 1]; p++) {
                        const j = list[p];
                        if (!this.rev[j] && !this.km[j]) { this.reveal(j); this.stats.simple++; }
                    }
                } else if (need === unk) {
                    for (let p = start[i]; p < start[i + 1]; p++) {
                        const j = list[p];
                        if (!this.rev[j] && !this.km[j]) { this.markMine(j); this.stats.simple++; }
                    }
                }
            }
        }

        _unknownOf(i, out) {
            const { start, list } = this.nb;
            let need = this.cnt[i];
            out.length = 0;
            for (let p = start[i]; p < start[i + 1]; p++) {
                const j = list[p];
                if (this.rev[j]) continue;
                if (this.km[j]) need--; else out.push(j);
            }
            return need;
        }

        _compactActive() {
            const a = this.active;
            const { start, list } = this.nb;
            let w = 0;
            for (let r = 0; r < a.length; r++) {
                const i = a[r];
                let keep = false;
                for (let p = start[i]; p < start[i + 1]; p++) {
                    const j = list[p];
                    if (!this.rev[j] && !this.km[j]) { keep = true; break; }
                }
                if (keep) a[w++] = i;
            }
            a.length = w;
        }

        /** If the unknown cells of A are a subset of B's, the difference is constrained on its own. */
        runSubset() {
            this._compactActive();
            const cols = this.cols, rows = this.rows;
            const ua = [], ub = [];
            const snapshot = this.active.slice();
            let progress = false;
            for (const a of snapshot) {
                const needA = this._unknownOf(a, ua);
                if (ua.length === 0) continue;
                const ar = (a / cols) | 0, ac = a - ar * cols;
                for (let dr = -2; dr <= 2; dr++) {
                    const br = ar + dr;
                    if (br < 0 || br >= rows) continue;
                    for (let dc = -2; dc <= 2; dc++) {
                        const bc = ac + dc;
                        if ((!dr && !dc) || bc < 0 || bc >= cols) continue;
                        const b = br * cols + bc;
                        if (!this.rev[b]) continue;
                        const needB = this._unknownOf(b, ub);
                        if (ub.length <= ua.length) continue;
                        let sub = true;
                        for (let q = 0; q < ua.length; q++) if (ub.indexOf(ua[q]) < 0) { sub = false; break; }
                        if (!sub) continue;
                        const diff = needB - needA, rest = ub.length - ua.length;
                        if (diff === 0) {
                            for (const x of ub.slice()) if (ua.indexOf(x) < 0) { this.reveal(x); this.stats.subset++; }
                            progress = true;
                        } else if (diff === rest) {
                            for (const x of ub.slice()) if (ua.indexOf(x) < 0) { this.markMine(x); this.stats.subset++; }
                            progress = true;
                        }
                        if (progress) { this._unknownOf(a, ua); if (ua.length === 0) break; }
                    }
                    if (ua.length === 0) break;
                }
            }
            return progress;
        }

        runEngine() {
            this._compactActive();
            this.stats.engineCalls++;
            const res = analyze(this.rows, this.cols, this.total, this.rev, this.cnt, this.km, { active: this.active });
            if (res.error) throw new Error('inconsistent solver state');
            if (!res.complete) return false;
            for (const i of res.safe) { this.reveal(i); this.stats.engine++; }
            for (const i of res.mine) { this.markMine(i); this.stats.engine++; }
            return res.safe.length + res.mine.length > 0;
        }

        /** Move one undetermined frontier mine to another unknown cell. */
        perturb() {
            const { start, list } = this.nb;
            const n = this.n;
            const src = [], inner = [], outer = [];
            for (let i = 0; i < n; i++) {
                if (this.rev[i] || this.km[i]) continue;
                let front = false;
                for (let p = start[i]; p < start[i + 1]; p++) if (this.rev[list[p]]) { front = true; break; }
                if (this.mine[i]) { if (front) src.push(i); }
                else if (front) outer.push(i); else inner.push(i);
            }
            let s, d;
            if (src.length && inner.length) {
                // usual case: push a frontier mine into the unexplored interior
                s = src[Math.floor(this.rng() * src.length)];
                d = inner[Math.floor(this.rng() * inner.length)];
            } else if (outer.length) {
                // no interior left (typically a 50/50 at the very end): fill an undecidable
                // safe cell with a mine taken from somewhere already resolved
                const kms = [];
                for (let i = 0; i < n; i++) if (this.km[i]) kms.push(i);
                d = outer[Math.floor(this.rng() * outer.length)];
                if (kms.length) {
                    s = kms[Math.floor(this.rng() * kms.length)];
                    this.km[s] = 0; this.unknown++;
                } else if (src.length) s = src[Math.floor(this.rng() * src.length)];
                else return false;
            } else return false;
            this.mine[s] = 0; this.mine[d] = 1;
            for (let p = start[s]; p < start[s + 1]; p++) { const j = list[p]; this.cnt[j]--; if (this.rev[j]) this._enqueue(j); }
            for (let p = start[d]; p < start[d + 1]; p++) { const j = list[p]; this.cnt[j]++; if (this.rev[j]) this._enqueue(j); }
            this.perturbs++;
            return true;
        }

        /** One unit of work. Returns 'solved' | 'progress' | 'stuck' | 'fail'. */
        advance(allowPerturb) {
            this.runSimple();
            if (this.solved) return 'solved';
            if (this.runSubset()) return 'progress';
            if (this.runEngine()) return 'progress';
            if (!allowPerturb) return 'stuck';
            return this.perturb() ? 'progress' : 'fail';
        }

        run() {
            for (;;) {
                const r = this.advance(false);
                if (r !== 'progress') return r === 'solved';
            }
        }
    }

    /** True if the board can be cleared from `first` without ever guessing. */
    function isSolvable(rows, cols, mine, first) {
        let total = 0;
        for (let i = 0; i < mine.length; i++) total += mine[i];
        const s = new Solver(rows, cols, Uint8Array.from(mine), total);
        s.reveal(first);
        return s.run();
    }

    /**
     * Board generator that can be driven in time slices so the page stays responsive.
     *   const g = new Generator(rows, cols, mines, first, { noGuess: true });
     *   while (!g.step(12)) await nextFrame();
     *   g.mine, g.guaranteed
     */
    class Generator {
        constructor(rows, cols, mines, first, opts) {
            opts = opts || {};
            this.rows = rows; this.cols = cols; this.mines = mines; this.first = first;
            this.rng = opts.rng || Math.random;
            this.noGuess = opts.noGuess !== false;
            this.timeLimit = opts.timeLimit || 8000;
            this.maxPerturb = opts.maxPerturb || Math.max(60, rows * cols);
            this.attempts = 0; this.verifyRounds = 0; this.totalPerturbs = 0;
            this.elapsed = 0;
            this.done = false; this.guaranteed = false;
            this.mine = null;
            this._newAttempt();
            if (!this.noGuess) { this.done = true; }
        }

        _newAttempt() {
            this.attempts++;
            this.mine = placeMines(this.rows, this.cols, this.mines, this.first, this.rng);
            this._startSolver();
        }

        _startSolver() {
            this.solver = new Solver(this.rows, this.cols, Uint8Array.from(this.mine), this.mines, this.rng);
            this.solver.reveal(this.first);
        }

        /** Work for about `ms` milliseconds. Returns true when finished. */
        step(ms) {
            if (this.done) return true;
            const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
            const t0 = now();
            for (;;) {
                const r = this.solver.advance(true);
                if (r === 'solved') {
                    if (this.solver.perturbs === 0) {
                        // solved from scratch with pure logic: this board is proven
                        this.done = true; this.guaranteed = true;
                        break;
                    }
                    // the board was repaired on the way: prove the repaired board from scratch
                    this.totalPerturbs += this.solver.perturbs;
                    this.mine = this.solver.mine;
                    this.verifyRounds++;
                    this._startSolver();
                } else if (r === 'fail' || this.solver.perturbs > this.maxPerturb) {
                    this.totalPerturbs += this.solver.perturbs;
                    this._newAttempt();
                }
                const t = now();
                if (t - t0 >= ms) break;
            }
            this.elapsed += now() - t0;
            if (!this.done && this.elapsed > this.timeLimit) {
                // give up: hand out a plain random board, honestly marked as not proven
                this.mine = placeMines(this.rows, this.cols, this.mines, this.first, this.rng);
                this.done = true; this.guaranteed = false;
            }
            return this.done;
        }

        run() { while (!this.step(50)); return this; }
    }

    // ----------------------------------------------------------- game state

    const HIDDEN = 0, OPEN = 1, FLAG = 2;

    class Game {
        constructor(rows, cols, mines) {
            this.rows = rows; this.cols = cols; this.n = rows * cols; this.mines = mines;
            this.nb = getNeighbors(rows, cols);
            this.state = new Uint8Array(this.n);
            this.mine = null; this.cnt = null;
            this.opened = 0; this.flags = 0;
            this.over = false; this.won = false; this.boom = -1;
        }

        get ready() { return this.mine !== null; }

        setBoard(mine) {
            this.mine = mine;
            this.cnt = adjacentCounts(this.rows, this.cols, mine);
        }

        /** Same mines, fresh cover. */
        reset() {
            this.state.fill(0);
            this.opened = 0; this.flags = 0; this.over = false; this.won = false; this.boom = -1;
        }

        toggleFlag(i) {
            if (this.over || this.state[i] === OPEN) return false;
            if (this.state[i] === FLAG) { this.state[i] = HIDDEN; this.flags--; }
            else { this.state[i] = FLAG; this.flags++; }
            return true;
        }

        /**
         * Open cell i (iterative breadth-first flood through zeros).
         * Returns { cells, dist } in opening order, dist = flood distance from i.
         */
        open(i0, out) {
            out = out || { cells: [], dist: [] };
            if (this.over || this.state[i0] !== HIDDEN) return out;
            if (this.mine[i0]) {
                this.state[i0] = OPEN; this.over = true; this.boom = i0;
                out.cells.push(i0); out.dist.push(0);
                return out;
            }
            const { start, list } = this.nb;
            const queue = out.cells, dist = out.dist;
            let head = queue.length;
            this.state[i0] = OPEN; this.opened++;
            queue.push(i0); dist.push(0);
            while (head < queue.length) {
                const i = queue[head], d = dist[head]; head++;
                if (this.cnt[i] !== 0) continue;
                for (let p = start[i]; p < start[i + 1]; p++) {
                    const j = list[p];
                    if (this.state[j] === HIDDEN) {
                        this.state[j] = OPEN; this.opened++;
                        queue.push(j); dist.push(d + 1);
                    }
                }
            }
            this._checkWin();
            return out;
        }

        /** Chord: on an open number whose flags match, open every other neighbour. */
        chord(i) {
            const out = { cells: [], dist: [] };
            if (this.over || this.state[i] !== OPEN || this.cnt[i] === 0) return out;
            const { start, list } = this.nb;
            let flags = 0;
            for (let p = start[i]; p < start[i + 1]; p++) if (this.state[list[p]] === FLAG) flags++;
            if (flags !== this.cnt[i]) return out;
            // a wrong flag means a mine among the rest: open safe cells first, the mine last
            let mineHit = -1;
            for (let p = start[i]; p < start[i + 1]; p++) {
                const j = list[p];
                if (this.state[j] !== HIDDEN) continue;
                if (this.mine[j]) mineHit = j; else this.open(j, out);
            }
            if (mineHit >= 0 && !this.over) this.open(mineHit, out);
            return out;
        }

        _checkWin() {
            if (this.opened === this.n - this.mines) {
                this.over = true; this.won = true;
                for (let i = 0; i < this.n; i++) if (this.mine[i] && this.state[i] !== FLAG) { this.state[i] = FLAG; this.flags++; }
            }
        }

        revealedMask() {
            const m = new Uint8Array(this.n);
            for (let i = 0; i < this.n; i++) m[i] = this.state[i] === OPEN ? 1 : 0;
            return m;
        }

        /** Exact mine probabilities from what is visible (flags are not trusted). */
        analyze(budget) {
            return analyze(this.rows, this.cols, this.mines, this.revealedMask(), this.cnt, null, { budget });
        }
    }

    return {
        HIDDEN, OPEN, FLAG,
        makeRng, getNeighbors, adjacentCounts, placeMines,
        analyze, Solver, isSolvable, Generator, Game
    };
});
