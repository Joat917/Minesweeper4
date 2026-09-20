/**
 * solver.test.js —— 求解器的正确性测试与性能基准
 *
 * 这个文件只在控制台里跑，不参与游戏运行。
 *
 * 用法（在页面控制台里跑）：
 *     import('./js/solver.test.js')
 *     solverTest.runAll()
 *
 * 五节：
 *   1. 锚点：手算就能得出答案的小局面，验证基本语义
 *   2. 对拍：随机小棋盘上，用「直接枚举全部布局」的独立实现交叉验证。
 *      对拍用的实现不走任何约束求解，是对概率定义的直译，所以它能抓出
 *      求解器里"合并方式搞混""分支平移错位"这类不报错、只算错的 bug。
 *   3. 采样：sampleLayout 的合法性与分布正确性
 *   4. 基准：computeProbabilities 的耗时
 *   5. 重排：sampleLayout 的耗时。单独一节是因为**正确性全过也可能卡死** ——
 *      卡的是时间不是结果，而第 4 节测的是另一条代码路径。
 *
 * 注意：下面 import 的 ?v=N 要和 index.html 里的版本号保持一致，
 * 否则测试跑的可能是缓存里的旧代码，结果没有意义。
 */

import { computeProbabilities, sampleLayout } from './probability.js?v=28';

/* ================================================================== */
/* 基础设施                                                            */
/* ================================================================== */

const passes = [];
const failures = [];

function ok(name, detail = '') {
  passes.push(name);
  console.log(`  \u2713 ${name}${detail ? '   ' + detail : ''}`);
}

function bad(name, detail = '') {
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
  console.log(`  \u2717 ${name}${detail ? '   ' + detail : ''}`);
}

function close(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}

function section(title) {
  console.log(`\n${'─'.repeat(70)}\n${title}\n${'─'.repeat(70)}`);
}

function fmt(x, digits = 2) {
  return Number.isFinite(x) ? x.toFixed(digits) : String(x);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padLeft(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

/** 固定种子的随机源，保证每次跑出同一批棋盘 */
function makeRng(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ================================================================== */
/* 造局面：从随机布局出发，选几格做连锁翻开                            */
/* ================================================================== */

function neighborIndexes(i, rows, cols) {
  const r = (i / cols) | 0;
  const c = i - r * cols;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    const nr = r + dr;
    if (nr < 0 || nr >= rows) continue;
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nc = c + dc;
      if (nc < 0 || nc >= cols) continue;
      out.push(nr * cols + nc);
    }
  }
  return out;
}

function mineCounts(mines, rows, cols) {
  const size = rows * cols;
  const counts = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    if (mines[i]) continue;
    let n = 0;
    for (const j of neighborIndexes(i, rows, cols)) if (mines[j]) n++;
    counts[i] = n;
  }
  return counts;
}

function makeLayout(rows, cols, mineCount, random) {
  const size = rows * cols;
  const order = Array.from({ length: size }, (_, i) => i);
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const mines = new Uint8Array(size);
  for (let i = 0; i < mineCount; i++) mines[order[i]] = 1;
  return mines;
}

/** 从 start 连锁翻开：0 格向邻格扩散，和游戏里的行为一致 */
function floodReveal(revealed, counts, rows, cols, start) {
  if (revealed[start]) return;
  const queue = [start];
  revealed[start] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    if (counts[cur] !== 0) continue;
    for (const j of neighborIndexes(cur, rows, cols)) {
      if (revealed[j]) continue;
      revealed[j] = 1;
      queue.push(j);
    }
  }
}

/** 造一个 view：随机布局 + 若干次连锁翻开。不经过 Minesweeper 内核 */
function randomView(rows, cols, mineCount, seeds, random) {
  const size = rows * cols;
  const mines = makeLayout(rows, cols, mineCount, random);
  const counts = mineCounts(mines, rows, cols);
  const revealed = new Uint8Array(size);

  for (let s = 0; s < seeds; s++) {
    let pick = -1;
    for (let tries = 0; tries < 80; tries++) {
      const i = Math.floor(random() * size);
      if (!revealed[i] && !mines[i]) {
        pick = i;
        break;
      }
    }
    if (pick < 0) break;
    floodReveal(revealed, counts, rows, cols, pick);
  }

  let revealedCount = 0;
  for (let i = 0; i < size; i++) if (revealed[i]) revealedCount++;

  return {
    view: { rows, cols, size, mineCount, revealedCount, revealed, adjacent: counts },
    mines,
    counts,
  };
}

/* ================================================================== */
/* 对拍用的独立实现：直接枚举全部布局                                   */
/* ================================================================== */

/**
 * 直译概率定义：把所有「恰好 M 颗雷、且与已翻开数字一致」的布局列出来，
 * 数每格是雷的比例。慢，但不需要任何推导，是最好的参照物。
 *
 * forbid 给定时，只在「该格无雷」的布局里统计 —— 采样器返回的正是这个条件下的分布。
 */
function bruteForce(view, forbid = -1, limit = 8e6) {
  const { size, mineCount, revealed, adjacent } = view;

  const hidden = [];
  for (let i = 0; i < size; i++) {
    if (!revealed[i] && i !== forbid) hidden.push(i);
  }

  const hits = new Float64Array(size);
  let total = 0;
  let visited = 0;

  const isMine = new Uint8Array(size);

  const consistent = () => {
    for (let i = 0; i < size; i++) {
      if (!revealed[i]) continue;
      let n = 0;
      for (const j of neighborIndexes(i, view.rows, view.cols)) if (isMine[j]) n++;
      if (n !== adjacent[i]) return false;
    }
    return true;
  };

  const recurse = (start, depth) => {
    if (++visited > limit) throw new Error('brute force 超出上限');
    if (depth === mineCount) {
      if (!consistent()) return;
      total++;
      for (let i = 0; i < size; i++) if (isMine[i]) hits[i]++;
      return;
    }
    for (let i = start; i <= hidden.length - (mineCount - depth); i++) {
      const cell = hidden[i];
      isMine[cell] = 1;
      recurse(i + 1, depth + 1);
      isMine[cell] = 0;
    }
  };

  if (hidden.length >= mineCount) recurse(0, 0);

  const probabilities = new Float64Array(size).fill(NaN);
  if (total === 0) return { probabilities, total: 0 };
  for (const i of hidden) probabilities[i] = hits[i] / total;
  if (forbid >= 0) probabilities[forbid] = 0;
  return { probabilities, total };
}

/* ================================================================== */
/* 一、锚点                                                            */
/* ================================================================== */

function anchorTests() {
  section('一、锚点（手算得出答案）');

  // 一个已翻开的「1」邻着三格，整盘 1 颗雷 → 三格各 1/3
  {
    const view = {
      rows: 2, cols: 2, size: 4, mineCount: 1, revealedCount: 1,
      revealed: Uint8Array.from([1, 0, 0, 0]),
      adjacent: Uint8Array.from([1, 0, 0, 0]),
    };
    const r = computeProbabilities(view);
    if (!r.ok) bad('1-of-3', `求解失败：${r.reason}`);
    else {
      const ps = [r.probabilities[1], r.probabilities[2], r.probabilities[3]];
      if (ps.every((p) => close(p, 1 / 3, 1e-12))) {
        ok('一个「1」邻三格 → 每格 1/3', `p = ${fmt(ps[0], 6)}`);
      } else {
        bad('1-of-3', `期望 1/3，实得 ${ps.map((p) => fmt(p, 6)).join(', ')}`);
      }
    }
  }

  // 已翻开的「0」邻着三格 → 那三格必为 0；剩下 5 个自由格子平分 1 颗雷
  {
    const view = {
      rows: 3, cols: 3, size: 9, mineCount: 1, revealedCount: 1,
      revealed: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0]),
      adjacent: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    };
    const r = computeProbabilities(view);
    if (!r.ok) bad('0 格邻域', `求解失败：${r.reason}`);
    else {
      const zeros = [1, 3, 4].every((i) => close(r.probabilities[i], 0, 1e-12));
      const fifths = [2, 5, 6, 7, 8].every((i) => close(r.probabilities[i], 0.2, 1e-12));
      if (zeros && fifths) ok('「0」格邻域全 0，远场各 1/5');
      else {
        bad('0-cell 邻域',
          `前沿 ${[1, 3, 4].map((i) => fmt(r.probabilities[i], 4)).join(',')}，` +
          `远场 ${fmt(r.probabilities[2], 4)}`);
      }
    }
  }

  // 1×3 中线是一颗雷 → 两侧各 1/2
  {
    const view = {
      rows: 1, cols: 3, size: 3, mineCount: 1, revealedCount: 1,
      revealed: Uint8Array.from([0, 1, 0]),
      adjacent: Uint8Array.from([0, 1, 0]),
    };
    const r = computeProbabilities(view);
    if (!r.ok) bad('1×3 中线', `求解失败：${r.reason}`);
    else if (close(r.probabilities[0], 0.5, 1e-12) && close(r.probabilities[2], 0.5, 1e-12)) {
      ok('1×3 中线两侧各 1/2');
    } else {
      bad('1×3 中线', `实得 ${fmt(r.probabilities[0], 6)}, ${fmt(r.probabilities[2], 6)}`);
    }
  }

  // 矛盾局面：一个「0」要求周围全空，但总雷数逼着其中一格必须放雷
  {
    const view = {
      rows: 2, cols: 2, size: 4, mineCount: 1, revealedCount: 1,
      revealed: Uint8Array.from([1, 0, 0, 0]),
      adjacent: Uint8Array.from([0, 0, 0, 0]),
    };
    const r = computeProbabilities(view);
    if (!r.ok) ok('矛盾局面被如实拒绝', `reason = ${r.reason}`);
    else bad('矛盾局面', '本该报错却给了结果');
  }
}

/* ================================================================== */
/* 二、对拍                                                            */
/* ================================================================== */

function crossCheckTests() {
  section('二、对拍（与「直接枚举全部布局」逐格比对）');

  const cases = [
    { rows: 3, cols: 3, mineCount: 2, seeds: 2, rounds: 40 },
    { rows: 4, cols: 4, mineCount: 3, seeds: 3, rounds: 40 },
    { rows: 4, cols: 4, mineCount: 4, seeds: 4, rounds: 30 },
    { rows: 5, cols: 4, mineCount: 5, seeds: 5, rounds: 24 },
  ];

  for (const spec of cases) {
    const random = makeRng(0x9e3779b9 ^ (spec.rows * 131 + spec.cols * 17 + spec.mineCount));
    let worst = 0;
    let done = 0;
    let skipped = 0;
    let firstBad = null;

    for (let round = 0; round < spec.rounds; round++) {
      const { view } = randomView(spec.rows, spec.cols, spec.mineCount, spec.seeds, random);

      let truth;
      try {
        truth = bruteForce(view);
      } catch (e) {
        skipped++;
        continue;
      }
      if (truth.total === 0) { skipped++; continue; }

      const got = computeProbabilities(view);
      if (!got.ok) {
        firstBad = firstBad || `求解失败（${got.reason}）`;
        continue;
      }

      let diff = 0;
      for (let i = 0; i < view.size; i++) {
        if (view.revealed[i]) continue;
        const a = truth.probabilities[i];
        const b = got.probabilities[i];
        if (!Number.isFinite(a) || !Number.isFinite(b)) { diff = Infinity; break; }
        if (Math.abs(a - b) > diff) diff = Math.abs(a - b);
      }
      if (diff > worst) worst = diff;
      if (diff > 1e-9 && !firstBad) firstBad = `第 ${round} 局偏差 ${diff.toExponential(3)}`;
      done++;
    }

    const label = `${spec.rows}×${spec.cols} / ${spec.mineCount} 雷 / 翻开 ${spec.seeds} 处`;
    if (firstBad) bad(label, `${done} 局之后出现：${firstBad}`);
    else ok(label, `${done} 局全部一致，最大偏差 ${worst.toExponential(2)}${skipped ? `（跳过 ${skipped} 局）` : ''}`);
  }
}

/* ================================================================== */
/* 三、采样                                                            */
/* ================================================================== */

function samplingTests(samples = 300) {
  section(`三、重排采样（sampleLayout，${samples} 次采样）`);

  const random = makeRng(20240117);
  const { view } = randomView(5, 5, 5, 4, random);
  const exact = computeProbabilities(view);
  if (!exact.ok) {
    bad('采样测试的前置求解', exact.reason);
    return;
  }

  // 挑一个「还有可能不是雷」的格子：p = 1 时本来就不存在合法重排，
  // 那种情况失败是正确行为，不该拿来测正常路径
  let forbidden = -1;
  for (let i = 0; i < view.size; i++) {
    if (!view.revealed[i] && exact.probabilities[i] < 1 - 1e-9) { forbidden = i; break; }
  }
  if (forbidden < 0) {
    bad('找不到可用的 forbidden 格');
    return;
  }

  const freq = new Float64Array(view.size);
  let failed = 0;
  let wrongCount = 0;
  let illegal = 0;

  for (let s = 0; s < samples; s++) {
    const laid = sampleLayout(view, forbidden);
    if (!laid.ok) { failed++; continue; }

    let count = 0;
    for (let i = 0; i < view.size; i++) {
      if (!laid.mines[i]) continue;
      count++;
      freq[i]++;
      if (view.revealed[i]) illegal++;
    }
    if (count !== view.mineCount) wrongCount++;
    if (laid.mines[forbidden]) illegal++;
  }

  if (failed === 0) ok('每次都能产出布局');
  else bad('采样失败', `${failed}/${samples} 次`);

  if (illegal === 0) ok('布局不违反已翻开信息，forbidden 处无雷');
  else bad('布局不合法', `${illegal} 次违规`);

  if (wrongCount === 0) ok('每次布局的雷数都正确');
  else bad('雷数不对', `${wrongCount}/${samples} 次`);

  // 频率应当逼近「给定 forbidden 无雷」条件下的概率 —— 注意是条件概率，
  // 不是无条件概率：采样器的输出就是这个条件下的均匀分布
  const truth = bruteForce(view, forbidden);
  if (truth.total > 0) {
    let worst = 0;
    let worstCell = -1;
    for (let i = 0; i < view.size; i++) {
      if (view.revealed[i]) continue;
      const d = Math.abs(freq[i] / samples - truth.probabilities[i]);
      if (d > worst) { worst = d; worstCell = i; }
    }
    if (worst <= 0.1) {
      ok('采样频率与条件概率吻合', `${samples} 次采样，最大偏差 ${fmt(worst, 4)}（第 ${worstCell} 格）`);
    } else {
      bad('采样频率偏离条件概率', `最大偏差 ${fmt(worst, 4)}（第 ${worstCell} 格）`);
    }
  }
}

/* ================================================================== */
/* 四、基准                                                            */
/* ================================================================== */

const PRESETS = [
  { name: '初级', rows: 9, cols: 9, mines: 10 },
  { name: '中级', rows: 16, cols: 16, mines: 40 },
  { name: '高级', rows: 16, cols: 30, mines: 99 },
];

const PROGRESS = [
  { label: '开局', seeds: 1 },
  { label: '早期', seeds: 4 },
  { label: '中期', seeds: 10 },
  { label: '后期', seeds: 25 },
];

function percentile(sorted, q) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function benchmark(options = {}) {
  const rounds = options.rounds || 20;
  const budget = options.budget || 30000;
  const capMs = options.capMs || 25000;

  section(`四、基准（每格 ${rounds} 局随机棋盘，节点预算 ${budget}）`);
  console.log(
    `  ${pad('难度', 6)}${pad('阶段', 6)}${padLeft('前沿格', 8)}${padLeft('已翻开', 8)}` +
    `${padLeft('中位', 9)}${padLeft('p90', 9)}${padLeft('最慢', 9)}${padLeft('超预算', 8)}`
  );

  const random = makeRng(1234567);
  const started = performance.now();
  let aborted = false;

  for (const preset of PRESETS) {
    for (const prog of PROGRESS) {
      const times = [];
      let frontierSum = 0;
      let revealedSum = 0;
      let timeouts = 0;
      let errors = 0;

      for (let r = 0; r < rounds; r++) {
        if (performance.now() - started > capMs) { aborted = true; break; }

        const { view } = randomView(preset.rows, preset.cols, preset.mines, prog.seeds, random);

        let frontier = 0;
        for (let i = 0; i < view.size; i++) {
          if (view.revealed[i]) continue;
          for (const j of neighborIndexes(i, view.rows, view.cols)) {
            if (view.revealed[j]) { frontier++; break; }
          }
        }
        frontierSum += frontier;
        revealedSum += view.revealedCount;

        const t0 = performance.now();
        const got = computeProbabilities(view, { budget });
        const t1 = performance.now();

        times.push(t1 - t0);
        if (!got.ok) {
          if (got.reason === 'timeout') timeouts++;
          else errors++;
        }
      }

      if (times.length === 0) break;

      times.sort((a, b) => a - b);
      const n = times.length;
      console.log(
        `  ${pad(preset.name, 6)}${pad(prog.label, 6)}` +
        `${padLeft((frontierSum / n).toFixed(0), 8)}` +
        `${padLeft((revealedSum / n).toFixed(0), 8)}` +
        `${padLeft(fmt(percentile(times, 0.5), 1) + 'ms', 9)}` +
        `${padLeft(fmt(percentile(times, 0.9), 1) + 'ms', 9)}` +
        `${padLeft(fmt(times[n - 1], 1) + 'ms', 9)}` +
        `${padLeft(timeouts + (errors ? `+${errors}错` : ''), 8)}`
      );
    }
    if (aborted) break;
  }

  if (aborted) {
    console.log(`\n  （总耗时超过 ${capMs}ms，基准提前收尾，未跑完的组合见上）`);
  }
  console.log('\n  说明：单次求解的上限由节点预算决定；「超预算」表示该局面这次没算出精确值。');
}

/* ================================================================== */
/* 五、重排耗时                                                        */
/* ================================================================== */

/**
 * 专门盯着"辅助模式踩到雷之后重新排布"这条路径。
 *
 * 为什么单列一节：正确性测试全过，也完全可能 UI 卡死 —— 卡的是时间不是结果。
 * 而基准那一节测的是 computeProbabilities，重排走的是 sampleLayout，
 * 是另一条路径，之前的测试根本没碰过它。
 *
 * 最关键的判据是「相对求解」这一列：
 *   重排应该只比一次普通求解略贵（≈ 1 倍），因为它就是"一次求解 + 一次下行"。
 *   如果它变成十几二十倍，说明又退回了"逐格重解两次"的老路。
 */
function relayoutBenchmark(options = {}) {
  const rounds = options.relayoutRounds || 12;
  const budget = options.budget || 30000;
  const capMs = options.capMs || 25000;

  section(`五、重排耗时（踩雷后重新排布，每格 ${rounds} 局）`);
  console.log(
    `  ${pad('难度', 6)}${pad('阶段', 6)}${padLeft('前沿格', 8)}` +
    `${padLeft('一次求解', 10)}${padLeft('重排', 10)}${padLeft('相对求解', 11)}${padLeft('跳过', 6)}`
  );

  const random = makeRng(987654321);
  const started = performance.now();
  let aborted = false;

  for (const preset of PRESETS) {
    for (const prog of PROGRESS) {
      const solveTimes = [];
      const relayoutTimes = [];
      const ratios = [];
      let frontierSum = 0;
      let skipped = 0;

      for (let r = 0; r < rounds; r++) {
        if (performance.now() - started > capMs) { aborted = true; break; }

        const { view } = randomView(preset.rows, preset.cols, preset.mines, prog.seeds, random);

        const t0 = performance.now();
        const prob = computeProbabilities(view, { budget });
        const t1 = performance.now();
        if (!prob.ok) { skipped++; continue; }

        // 挑一个还有可能不是雷的格子：p = 1 时本来就不存在合法重排
        let forbidden = -1;
        for (let i = 0; i < view.size; i++) {
          if (!view.revealed[i] && prob.probabilities[i] > 0 && prob.probabilities[i] < 1) {
            forbidden = i;
            break;
          }
        }
        if (forbidden < 0) { skipped++; continue; }

        let frontier = 0;
        for (let i = 0; i < view.size; i++) if (prob.frontier[i]) frontier++;
        frontierSum += frontier;

        const t2 = performance.now();
        const laid = sampleLayout(view, forbidden, { budget });
        const t3 = performance.now();
        if (!laid.ok) { skipped++; continue; }

        const solveMs = t1 - t0;
        const relayoutMs = t3 - t2;
        solveTimes.push(solveMs);
        relayoutTimes.push(relayoutMs);
        ratios.push(relayoutMs / Math.max(0.01, solveMs));
      }

      if (relayoutTimes.length === 0) {
        console.log(`  ${pad(preset.name, 6)}${pad(prog.label, 6)}  没有可测的局面`);
        continue;
      }

      solveTimes.sort((a, b) => a - b);
      relayoutTimes.sort((a, b) => a - b);
      ratios.sort((a, b) => a - b);

      console.log(
        `  ${pad(preset.name, 6)}${pad(prog.label, 6)}` +
        `${padLeft((frontierSum / relayoutTimes.length).toFixed(0), 8)}` +
        `${padLeft(fmt(percentile(solveTimes, 0.5), 1) + 'ms', 10)}` +
        `${padLeft(fmt(percentile(relayoutTimes, 0.5), 1) + 'ms', 10)}` +
        `${padLeft('x' + fmt(percentile(ratios, 0.5), 2), 11)}` +
        `${padLeft(skipped || '', 6)}`
      );
    }
    if (aborted) break;
  }

  if (aborted) console.log(`\n  （总耗时超过 ${capMs}ms，提前收尾）`);

  console.log('\n  判读：');
  console.log('    「相对求解」≈ 1      重排和一次普通求解同量级，界面不会卡');
  console.log('    「相对求解」≫ 1      又退回逐格重解的老路，越大的盘越卡');
  console.log('    「重排」超过 100ms  会感到迟疑；超过 500ms 会明显卡住');
}

/* ================================================================== */
/* 收尾                                                                */
/* ================================================================== */

export function runAll(options = {}) {
  // 这两个是模块级数组，反复调用会累积，每次开始前清空
  passes.length = 0;
  failures.length = 0;

  const t0 = performance.now();
  console.log('\n扫雷求解器 · 测试与基准');
  console.log('锚点 + 与暴力枚举对拍 + 采样合法性 + 性能基准 + 重排耗时');

  const stages = [
    ['锚点', anchorTests],
    ['对拍', crossCheckTests],
    ['采样', () => samplingTests(options.samples)],
    ['基准', () => benchmark(options)],
    ['重排', () => relayoutBenchmark(options)],
  ];

  for (const [name, fn] of stages) {
    try {
      fn();
    } catch (e) {
      bad(`${name}测试抛异常`, (e && e.message) || String(e));
    }
  }

  section('汇总');
  console.log(`  通过 ${passes.length} 项，失败 ${failures.length} 项，总用时 ${fmt(performance.now() - t0, 0)}ms`);
  if (failures.length) {
    console.log('\n  失败项：');
    for (const f of failures) console.log(`    · ${f}`);
  } else {
    console.log('  全部通过。');
  }

  return { passes: passes.length, failures: failures.slice() };
}

/* ------------------------------------------------------------------ */
/* 挂到全局，方便反复调用                                              */
/* ------------------------------------------------------------------ */

/**
 * ES module 按 URL 缓存：import() 第二次拿到的是缓存，模块体不会再执行。
 * 所以这里不自动跑，而是把入口挂到全局，你想跑几次跑几次。
 *
 *      import('./js/solver.test.js')     ← 只需一次
 *      solverTest.runAll()
 *      solverTest.runAll({ samples: 50, rounds: 8, budget: 8000 })   ← 快速档
 *
 * 改了这个测试文件本身之后，模块缓存还在，用带时间戳的地址强制重新加载：
 *
 *      await import('./js/solver.test.js?t=' + Date.now())
 */

const api = { runAll };

if (typeof globalThis !== 'undefined') globalThis.solverTest = api;

console.log(
  '%c[solver.test] 已就绪 —— 执行 solverTest.runAll() 开始测试，可反复执行。',
  'color:#0a0;font-weight:bold'
);

export default api;
