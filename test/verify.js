// Node verification for engine.js:  node test/verify.js
const E = require('../engine.js');
const rng = E.makeRng(12345);
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } };

// 1. probabilities vs brute force on small boards
function brute(rows, cols, total, rev, cnt) {
  const n = rows * cols, nb = E.getNeighbors(rows, cols);
  const unk = []; for (let i = 0; i < n; i++) if (!rev[i]) unk.push(i);
  const hit = new Float64Array(n); let Z = 0; const m = new Uint8Array(n);
  for (let mask = 0; mask < (1 << unk.length); mask++) {
    let pc = 0; for (let x = mask; x; x &= x - 1) pc++;
    if (pc !== total) continue;
    m.fill(0); for (let b = 0; b < unk.length; b++) if (mask >> b & 1) m[unk[b]] = 1;
    let good = true;
    for (let i = 0; i < n && good; i++) if (rev[i]) {
      let c = 0; for (let p = nb.start[i]; p < nb.start[i + 1]; p++) c += m[nb.list[p]];
      if (c !== cnt[i]) good = false;
    }
    if (!good) continue;
    Z++; for (const u of unk) if (m[u]) hit[u]++;
  }
  return { unk, p: unk.map(u => hit[u] / Z), Z };
}
let cases = 0, maxErr = 0, certChecked = 0;
for (let it = 0; it < 4000; it++) {
  const rows = 3 + Math.floor(rng() * 3), cols = 3 + Math.floor(rng() * 4), n = rows * cols;
  const total = 1 + Math.floor(rng() * Math.min(n - 2, 9));
  const mine = new Uint8Array(n); let k = 0;
  while (k < total) { const i = Math.floor(rng() * n); if (!mine[i]) { mine[i] = 1; k++; } }
  const cnt = E.adjacentCounts(rows, cols, mine);
  const rev = new Uint8Array(n); const want = Math.floor(rng() * (n - total));
  for (let t = 0; t < want; t++) { const i = Math.floor(rng() * n); if (!mine[i]) rev[i] = 1; }
  let u = 0; for (let i = 0; i < n; i++) if (!rev[i]) u++;
  if (u > 20 || u === 0) continue;
  const b = brute(rows, cols, total, rev, cnt);
  const a = E.analyze(rows, cols, total, rev, cnt, null);
  ok(!a.error && a.complete, 'analyze error');
  cases++;
  b.unk.forEach((c, q) => {
    const e = Math.abs(a.prob[c] - b.p[q]); if (e > maxErr) maxErr = e;
    ok(e < 1e-9, `prob mismatch ${rows}x${cols} cell ${c}: ${a.prob[c]} vs ${b.p[q]}`);
    if (b.p[q] === 0) { certChecked++; ok(a.safe.includes(c), 'missed certain safe'); }
    else ok(!a.safe.includes(c), 'false safe');
    if (b.p[q] === 1) { certChecked++; ok(a.mine.includes(c), 'missed certain mine'); }
    else ok(!a.mine.includes(c), 'false mine');
  });
}
console.log(`[prob] ${cases} positions vs brute force, max abs error ${maxErr.toExponential(2)}, ${certChecked} certain cells checked`);

// 2. no-guess generation: time + independent proof with a fresh solver
function gen(name, rows, cols, mines, N, limit) {
  const times = []; let guaranteed = 0, proven = 0, attempts = 0, perturbs = 0, zoneOk = 0, countOk = 0;
  for (let it = 0; it < N; it++) {
    const first = Math.floor(rng() * rows * cols);
    const t0 = process.hrtime.bigint();
    const g = new E.Generator(rows, cols, mines, first, { noGuess: true, rng, timeLimit: limit || 8000 }).run();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    attempts += g.attempts; perturbs += g.totalPerturbs;
    if (g.guaranteed) { guaranteed++; if (E.isSolvable(rows, cols, g.mine, first)) proven++; }
    let c = 0; for (const x of g.mine) c += x; if (c === mines) countOk++;
    const nb = E.getNeighbors(rows, cols); let z = !g.mine[first];
    for (let p = nb.start[first]; p < nb.start[first + 1]; p++) if (g.mine[nb.list[p]]) z = false;
    if (z) zoneOk++;
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / N;
  console.log(`[gen] ${name} ${cols}x${rows}/${mines}: ${N} boards, guaranteed ${guaranteed}, re-proven ${proven}, mineCount ok ${countOk}, safe zone ok ${zoneOk}, avg ${avg.toFixed(1)}ms, median ${times[N >> 1].toFixed(1)}ms, max ${times[N - 1].toFixed(1)}ms, attempts/board ${(attempts / N).toFixed(2)}, perturbs/board ${(perturbs / N).toFixed(1)}`);
  ok(proven === guaranteed, 'guaranteed board not solvable');
  ok(countOk === N && zoneOk === N, 'mine count / safe zone');
}
const quick = process.argv.includes('--quick');
gen('easy', 9, 9, 10, quick ? 50 : 300);
gen('normal', 16, 16, 40, quick ? 30 : 200);
gen('hard', 16, 30, 99, quick ? 20 : 100);
gen('extreme', 50, 50, 500, quick ? 3 : 10, 20000);
if (!quick) gen('max', 100, 100, 2000, 3, 60000);

// 3. plain random boards: how many are solvable without guessing (for reference)
for (const [name, r, c, m, N] of [['easy', 9, 9, 10, 300], ['normal', 16, 16, 40, 200], ['hard', 16, 30, 99, 200]]) {
  let s = 0;
  for (let it = 0; it < N; it++) { const f = Math.floor(rng() * r * c); if (E.isSolvable(r, c, E.placeMines(r, c, m, f, rng), f)) s++; }
  console.log(`[ref] plain random ${name}: ${s}/${N} solvable without guessing`);
}

// 4. game: flood fill, chord, win; analysis time on a big mid-game position
{
  const g = new E.Game(100, 100, 1500); const f = 5050;
  g.setBoard(E.placeMines(100, 100, 1500, f, rng));
  const t0 = Date.now(); const o = g.open(f); const dt = Date.now() - t0;
  ok(o.cells.length >= 9, 'first click opens >= 9'); ok(new Set(o.cells).size === o.cells.length, 'flood duplicates');
  // (a) pathological: scattered single cells -> must give up within a bounded time, never claim a wrong certainty
  for (let i = 0; i < 3000; i++) { const c = Math.floor(rng() * g.n); if (!g.mine[c]) g.open(c); }
  const t1 = Date.now(); const a = g.analyze(); const dt2 = Date.now() - t1;
  let bad = 0; for (const c of a.safe) if (g.mine[c]) bad++; for (const c of a.mine) if (!g.mine[c]) bad++;
  ok(bad === 0, 'wrong certainty on big board');
  console.log(`[game] 100x100 flood ${o.cells.length} cells in ${dt}ms; analyze scattered position: ${dt2}ms, complete=${a.complete}, wrong ${bad}`);
  // (b) realistic: positions reached by actually playing (solver with repair), analysed at many stages
  for (const [rows, cols, mines] of [[16, 30, 99], [50, 50, 500], [100, 100, 2000]]) {
    const first = Math.floor(rows * cols / 2 + cols / 2);
    const s = new E.Solver(rows, cols, E.placeMines(rows, cols, mines, first, rng), mines, rng); s.reveal(first);
    let maxT = 0, sum = 0, cnt = 0, incomplete = 0, wrong = 0, steps = 0, r;
    do {
      r = s.advance(true);
      if (++steps % 3 === 0 || r === 'solved') {
        const t = process.hrtime.bigint();
        const an = E.analyze(rows, cols, mines, s.rev, s.cnt, null);
        const ms = Number(process.hrtime.bigint() - t) / 1e6;
        maxT = Math.max(maxT, ms); sum += ms; cnt++;
        if (!an.complete) incomplete++;
        for (const c of an.safe) if (s.mine[c]) wrong++; for (const c of an.mine) if (!s.mine[c]) wrong++;
      }
    } while (r === 'progress' && steps < 5000);
    ok(wrong === 0, 'wrong certainty in played position');
    console.log(`[hint] ${cols}x${rows}/${mines}: ${cnt} played positions analysed, avg ${(sum / cnt).toFixed(1)}ms, max ${maxT.toFixed(1)}ms, incomplete ${incomplete}, wrong certainties ${wrong}`);
  }
  const g2 = new E.Game(9, 9, 10); g2.setBoard(E.placeMines(9, 9, 10, 40, rng)); g2.open(40);
  for (let i = 0; i < 81; i++) if (g2.mine[i]) g2.toggleFlag(i);
  for (let pass = 0; pass < 20 && !g2.over; pass++) for (let i = 0; i < 81; i++) g2.chord(i);
  ok(g2.won, 'chording with correct flags wins');
}
console.log(fails ? `${fails} FAILURES` : 'ALL OK');
process.exit(fails ? 1 : 0);
