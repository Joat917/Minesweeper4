/**
 * probability.js —— 概率计算模块（当前只有接口，算法待实现）
 *
 * 这是一个**纯计算模块**：不引用 DOM，不引用 Minesweeper，不持有任何状态。
 * 输入是"当前翻开情况的快照"，输出是概率。同一份输入必须得到同一份输出。
 *
 * ==================================================================
 * 数学定义（接口的契约，实现必须满足）
 * ==================================================================
 *
 * 设 S 为所有满足下列两条的布雷方案集合：
 *   (1) 恰好 mineCount 颗雷；
 *   (2) 与全部已知信息一致 —— 已翻开的每一格自身不是雷，
 *       且它周围 8 格中的雷数恰好等于该格显示的数字 adjacent[i]。
 *
 * 则某未知格 c 的含雷概率定义为：
 *
 *     p(c) = |{ L ∈ S : c ∈ L }| / |S|
 *
 * 注意这是**条件概率**，不是"局部推算"：分母是全部一致方案的等权计数，
 * 所以远场格（不接触任何已翻开格）的概率会受前沿约束的影响，反之亦然。
 *
 * 几个直接推论，实现时必须保住：
 *
 *   · p(c) = 0  ⟺ c 在所有一致方案里都不是雷（该格绝对安全）
 *   · p(c) = 1  ⟺ c 在所有一致方案里都是雷（该格被逻辑强制）
 *                 也等价于：不存在让 c 无雷的一致方案
 *                 —— 这正是"辅助模式踩到 p=1 才会死"的数学依据，
 *                    因为那种情况下"重排布雷且不改动已翻开数字"无解。
 *   · Σ_{c 未知} p(c) = mineCount  （概率之和守恒，可作为实现的校验项）
 *
 * ==================================================================
 * 接口一：算概率
 * ==================================================================
 *
 * @param {AnalysisView} view
 * @param {Object} [options]
 * @param {number} [options.sampleCount]  采样法的样本数上限（精确解可忽略）
 * @param {Function} [options.rng]        注入的随机源，默认 Math.random；注入它才能复现
 * @returns {ProbabilityResult}
 *
 * ==================================================================
 * 接口二：抽一份布雷方案（"踩雷不死"的重排要用）
 * ==================================================================
 *
 * 在 S 之上再叠加一个约束：forbidden 格必须是空的。即从
 *     S' = { L ∈ S : forbidden ∉ L }
 * 中**等概率**抽一份返回。
 *
 * 调用方（内核）会拿这个结果去 relayout() 并校验，
 * 所以实现只需保证结果落在 S' 里，不需要自己检查已翻开的数字。
 *
 * 前置条件：调用方必须已经确认 |S'| > 0（也就是 p(forbidden) < 1）。
 * 若 |S'| = 0，返回 { ok:false, reason:'empty-set' } 即可。
 *
 * @param {AnalysisView} view
 * @param {number} forbidden              必须无雷的格子下标
 * @param {Object} [options]
 * @returns {LayoutResult}
 *
 * ==================================================================
 * 实现时的难点（提前记下，免得接算法时踩坑）
 * ==================================================================
 *
 * 1. 精确解是 #P-hard：|S| 随前沿规模指数增长。
 *    可行的做法是把前沿按"约束连通块"分解 —— 两个不相邻的已翻开格所约束的
 *    未知格集合互不相交时，可以分别枚举再卷积合并，规模就下来了。
 *    连通块内用 DP（逐列状态压缩）或直接枚举，单块能到 20~25 个未知格。
 *
 * 2. 远场格不能各算各的：设前沿消耗的雷数为 k，则远场的联合概率服从
 *    "剩余雷数 (mineCount - k) 随机撒在剩余 H 个未知格里"，单格边际概率
 *    是 Σ_k P(k) · (mineCount - k) / H。所以必须先得到 k 的分布，
 *    不能拿"平均 k"去近似——那会让远场概率之和偏掉。
 *
 * 3. 采样法（简单可靠，可先上）：在满足 S 的约束下重复随机布雷取频率。
 *    要均匀，不能"按行扫、能放就放"——那会改变分布。
 *    可行做法是带约束的拒绝采样 + 局部重排（MCMC），并做混合性检查。
 *    样本数要够：概率 0.01 的格子在 1 万样本下误差约 ±0.3%，量级够用。
 *
 * 4. 数值统一走 Float64；已翻开格的概率不是 0 而是"不适用"，
 *    约定填 NaN，别用 0 —— 前端要靠这个区分"安全"和"已开"。
 *
 * 5. **被逻辑强制的格子必须返回精确的 1.0（以及绝对安全的格子精确的 0.0）。**
 *    调用方用 p >= 1 判断"没有合法重排、只能认命"，用 p === 0 判断"这步无风险"。
 *    采样法在样本里从没出现过雷的格子会得到 0，这没问题；
 *    但如果一个真·强制雷因为估计误差得到 0.9999999，调用方就会去要一份
 *    重排方案、拿到空集、然后仍然按踩雷处理 —— 结果对，但路径和提示都错了。
 *    所以求精确解时要在最后做一次"约束传播"来钉死 0/1，
 *    采样法也要把频率达到 0 或 1 的格子直接吸附到端点。
 */

/** 引擎状态码，UI 直接拿去决定怎么显示 */
export const EngineStatus = Object.freeze({
  OK: 'ok',
  UNIMPLEMENTED: 'unimplemented',   // 算法还没写
  INCONSISTENT: 'inconsistent',     // 输入自相矛盾（不该发生，说明调用方有 bug）
  NO_SOLUTION: 'no-solution',       // |S| 或 |S'| 为空
  TIMEOUT: 'timeout',               // 预算用尽
});

/**
 * @typedef {Object} AnalysisView
 * @property {number}     rows
 * @property {number}     cols
 * @property {number}     size            rows * cols
 * @property {number}     mineCount       整盘雷数
 * @property {number}     revealedCount   已翻开格数
 * @property {Uint8Array} revealed        1 = 已翻开
 * @property {Uint8Array} adjacent        已翻开格的数字；未翻开格的值无意义
 *
 * 刻意不包含旗子/问号等标记 —— 按需求，标记不参与计算，它们只是玩家自己的备忘。
 * 也不包含任何雷的位置：这是"给玩家看的概率"，不是上帝视角。
 */

/**
 * @typedef {Object} ProbabilityResult
 * @property {boolean}           ok
 * @property {string}            [reason]        失败原因（EngineStatus 或自由文本）
 * @property {Float64Array|null} probabilities   长度 size；未翻开格为 [0,1]，
 *                                               已翻开格为 NaN
 * @property {Uint8Array|null}   frontier        1 = 未翻开且与某个已翻开格相邻
 * @property {number|null}       farField        非前沿未知格的单格概率
 * @property {boolean}           exact           true = 精确枚举，false = 采样估计
 * @property {number}            samples         实际样本数（精确解填 0）
 * @property {string}            engine          引擎标识，便于 UI 显示来源
 */

/**
 * @typedef {Object} LayoutResult
 * @property {boolean}          ok
 * @property {string}           [reason]
 * @property {Uint8Array|null}  mines   长度 size，1 = 有雷
 */

/* ==================================================================
 * 实现
 *
 * 一条约束就是一行：terms 是「格子 → 系数」，要求 Σ 系数 × 取值 = target。
 *
 * 全流程只有一件事：把问题化简、拆小、递归，然后在回来的路上合并。
 *
 *   solve(rows):
 *       化简（约 gcd、删空行、用短行抵消长行里的变量）
 *       断成几块         → 各自 solve，按「方式数相乘、雷数相加」合并
 *       只剩一行         → 直接枚举（一行最多 8 格，见下）
 *       没有约束         → 常数
 *       否则             → 挑一格定值，两条路各自 solve，
 *                          按「方式数相加、分支 1 的雷数平移一格」合并
 *
 * 为什么一行最多 8 格：初始的每一行来自一个已翻开格子的 8 邻域；而化简里
 * 只在「抵消之后这一行变短」时才保留，所以任何一行都不增长。于是"只剩一行"
 * 这个终止条件最多枚举 2^8 次，不需要额外算法。
 *
 * 全局那条「总雷数 = M」不进这个递归：它只在最后收口时出现，形式是把
 * 「前沿用掉 k 颗」乘上自由格子的组合数 C(|F|, M−k)。这样递归里的各块
 * 是"给定总量"下独立，合并就是对雷数做加法。
 *
 * 每个子问题交出来的东西形状统一：
 *     dist[k]     这批格子用掉 k 颗雷的合法方案数
 *     nums[c][k]  其中 c 被取 1 的方案数
 * ================================================================== */

/* ---------------- 小工具 ---------------- */

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** 并查集，键是任意值 */
function makeDSU() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) {
      parent.set(x, x);
      return x;
    }
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  return { find, union };
}

function makeRow(terms, target) {
  return { terms, target };
}

function collectCells(rows) {
  const cells = new Set();
  for (const row of rows) for (const c of row.terms.keys()) cells.add(c);
  return cells;
}

/* ---------------- 建约束 ---------------- */

/** 每个已翻开的格子给出一条等式：周围未翻开格子的取值之和 = 它显示的数字 */
function buildRows(view) {
  const { rows, cols, size, revealed, adjacent } = view;
  const out = [];

  for (let i = 0; i < size; i++) {
    if (!revealed[i]) continue;

    const r = (i / cols) | 0;
    const c = i - r * cols;
    const terms = new Map();

    for (let dr = -1; dr <= 1; dr++) {
      const nr = r + dr;
      if (nr < 0 || nr >= rows) continue;
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nc = c + dc;
        if (nc < 0 || nc >= cols) continue;
        const j = nr * cols + nc;
        if (!revealed[j]) terms.set(j, 1);
      }
    }

    // 注意：显示 0 的格子也要建。旗子会挡住连锁展开，它周围未必都翻开了，
    // 那条「这些格子全是 0」是很有力的一条约束。
    out.push(makeRow(terms, adjacent[i]));
  }

  return out;
}

/* ---------------- 化简 ---------------- */

/** 每行约 gcd、丢掉 0 = 0 的行。返回 false 表示这一支无解 */
function normalizeRows(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];

    let g = 0;
    for (const k of row.terms.values()) g = gcd(g, k);

    if (g === 0) {
      if (row.target !== 0) return false; // 0 = 非零
      rows.splice(i, 1); // 0 = 0，没有信息
      continue;
    }
    if (row.target % g !== 0) return false; // 整数上无解
    if (g > 1) {
      for (const [c, k] of row.terms) row.terms.set(c, k / g);
      row.target /= g;
    }
  }
  return true;
}

/** 用行 a 抵消行 b 里的格子 v。返回新行；v 不在两行里就返回 null */
function cancel(a, b, v) {
  const ka = a.terms.get(v);
  const kb = b.terms.get(v);
  if (!ka || !kb) return null;

  const g = gcd(ka, kb);
  const ma = kb / g; // 新行 = ma·a − mb·b，v 的系数正好抵消成 0
  const mb = ka / g;

  const terms = new Map();
  for (const [c, k] of b.terms) terms.set(c, -mb * k);
  for (const [c, k] of a.terms) terms.set(c, (terms.get(c) || 0) + ma * k);
  terms.delete(v);
  for (const [c, k] of [...terms]) if (k === 0) terms.delete(c);

  return makeRow(terms, ma * a.target - mb * b.target);
}

/** 找一次「用短行抵消长行、且长行变短」的消元，做掉它并返回 true */
function eliminateOnce(rows) {
  const index = new Map(); // 格子 → 含它的行下标
  for (let i = 0; i < rows.length; i++) {
    for (const c of rows[i].terms.keys()) {
      let list = index.get(c);
      if (!list) index.set(c, (list = []));
      list.push(i);
    }
  }

  const order = rows.map((_, i) => i).sort((x, y) => rows[x].terms.size - rows[y].terms.size);

  for (const bi of order) {
    const b = rows[bi];
    for (const v of b.terms.keys()) {
      for (const ai of index.get(v)) {
        if (ai === bi) continue;
        const a = rows[ai];
        if (a.terms.size >= b.terms.size) continue; // 只让短的消长的
        const nb = cancel(a, b, v);
        if (nb && nb.terms.size < b.terms.size) {
          rows[bi] = nb; // 每次严格变短，所以这个循环必然结束
          return true;
        }
      }
    }
  }
  return false;
}

/** 反复化简到没有进展。返回 false 表示这一支无解 */
function simplify(rows) {
  for (;;) {
    if (!normalizeRows(rows)) return false;
    if (!eliminateOnce(rows)) return true;
  }
}

/* ---------------- 拆块 ---------------- */

/** 按「是否共享格子」把行分成互不相干的若干组 */
function splitPieces(rows) {
  const dsu = makeDSU();

  for (const row of rows) {
    let first = null;
    for (const c of row.terms.keys()) {
      if (first === null) first = c;
      else dsu.union(first, c);
    }
  }

  const groups = new Map();
  for (const row of rows) {
    const firstCell = row.terms.keys().next().value;
    const key = firstCell === undefined ? Symbol('empty') : dsu.find(firstCell);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(row);
  }
  return [...groups.values()];
}

/* ---------------- 挑定值的那一格 ---------------- */

/** 去掉 v 之后，剩下的格子连成的最大一块有多大（越小说明切得越开） */
function separation(rows, v) {
  const dsu = makeDSU();
  const touched = new Set();

  for (const row of rows) {
    let prev = null;
    for (const c of row.terms.keys()) {
      if (c === v) continue;
      touched.add(c);
      if (prev !== null) dsu.union(prev, c);
      prev = c;
    }
  }

  const sizes = new Map();
  let worst = 0;
  for (const c of touched) {
    const root = dsu.find(c);
    const size = (sizes.get(root) || 0) + 1;
    sizes.set(root, size);
    if (size > worst) worst = size;
  }
  return worst;
}

function chooseBranch(rows) {
  const cells = [...collectCells(rows)];

  const degree = new Map();
  for (const row of rows) {
    for (const c of row.terms.keys()) degree.set(c, (degree.get(c) || 0) + 1);
  }

  // 小问题试算不值得，直接挑出现在最多行里的那格
  if (cells.length <= 14) {
    let best = cells[0];
    for (const c of cells) if (degree.get(c) > degree.get(best)) best = c;
    return best;
  }

  // 大问题才试算「去掉它之后断得多开」，只在度数最高的十几格里挑
  const candidates = cells
    .slice()
    .sort((a, b) => degree.get(b) - degree.get(a))
    .slice(0, 12);

  let best = candidates[0];
  let bestSep = Infinity;
  let bestDegree = -1;
  for (const c of candidates) {
    const sep = separation(rows, c);
    const deg = degree.get(c);
    if (sep < bestSep || (sep === bestSep && deg > bestDegree)) {
      bestSep = sep;
      bestDegree = deg;
      best = c;
    }
  }
  return best;
}

/** 把 v 定为 w：含它的行目标减去 k·w，v 从行里消失 */
function substitute(rows, v, w) {
  const out = [];
  for (const row of rows) {
    const k = row.terms.get(v);
    if (k === undefined) {
      out.push(makeRow(new Map(row.terms), row.target));
      continue;
    }
    const terms = new Map(row.terms);
    terms.delete(v);
    out.push(makeRow(terms, row.target - k * w));
  }
  return out;
}

/* ---------------- 结果与合并 ---------------- */

/*
 * 每个节点除了 dist / nums，还带一个 sample(k, rng, out)：
 * 「在本节点恰好用掉 k 颗雷的前提下，把一组合法取值写进 out」。
 *
 * 有了它，抽一份布局只需要「一次求解 + 一次下行」，而不是原来那样
 * 对每个格子重解两次（前沿 40 格就是 80 次完整求解，会把主线程卡死）。
 * 每个节点的 sample 只在合并处做一次按权重的抽样，然后递归下去，很便宜。
 */

function zeroResult(cells, n) {
  const nums = new Map();
  for (const c of cells) nums.set(c, new Float64Array(n + 1));
  return { dist: new Float64Array(n + 1), nums, cells: [...cells], sample: () => false };
}

/** 两条路互斥覆盖同一批格子：方式数相加，分支 1 的雷数整体平移一格 */
function mergeBranches(v, r0, r1) {
  const n = r0.dist.length; // 分支比父问题少一格，所以分支的 dist 长度就是父格子数
  const dist = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) dist[k] += r0.dist[k];
  for (let k = 0; k < n; k++) dist[k + 1] += r1.dist[k];

  const nums = new Map();
  for (const [c, num0] of r0.nums) {
    const num1 = r1.nums.get(c);
    const num = new Float64Array(n + 1);
    for (let k = 0; k < n; k++) num[k] += num0[k];
    for (let k = 0; k < n; k++) num[k + 1] += num1[k];
    nums.set(c, num);
  }

  const numV = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) numV[k + 1] += r1.dist[k]; // v 只在分支 1 里为 1
  nums.set(v, numV);

  // 两条路互斥：按 dist 的权重挑走哪条，v 的取值随之确定
  const sample = (k, rng, out) => {
    const w0 = k >= 0 && k < n ? r0.dist[k] : 0;
    const w1 = k >= 1 && k - 1 < n ? r1.dist[k - 1] : 0;
    const total = w0 + w1;
    if (!(total > 0)) return false;
    if (rng() * total < w1) {
      out[v] = 1;
      return r1.sample(k - 1, rng, out);
    }
    out[v] = 0;
    return r0.sample(k, rng, out);
  };

  return { dist, nums, cells: [...r0.cells, v], sample };
}

/** 两块互不相干、各选各的：方式数相乘、雷数相加 */
function combine(A, B) {
  const na = A.dist.length - 1;
  const nb = B.dist.length - 1;
  const size = na + nb + 1;

  const dist = new Float64Array(size);
  for (let a = 0; a <= na; a++) {
    if (A.dist[a] === 0) continue;
    for (let b = 0; b <= nb; b++) dist[a + b] += A.dist[a] * B.dist[b];
  }

  const nums = new Map();
  for (const [c, numA] of A.nums) {
    const num = new Float64Array(size);
    for (let a = 0; a <= na; a++) {
      if (numA[a] === 0) continue;
      for (let b = 0; b <= nb; b++) num[a + b] += numA[a] * B.dist[b];
    }
    nums.set(c, num);
  }
  for (const [c, numB] of B.nums) {
    const num = new Float64Array(size);
    for (let b = 0; b <= nb; b++) {
      if (numB[b] === 0) continue;
      for (let a = 0; a <= na; a++) num[a + b] += numB[b] * A.dist[a];
    }
    nums.set(c, num);
  }

  // 两块独立：按 Pi dist 的权重把 k 颗雷分给两边
  const sample = (k, rng, out) => {
    let total = 0;
    for (let a = Math.max(0, k - nb); a <= Math.min(na, k); a++) total += A.dist[a] * B.dist[k - a];
    if (!(total > 0)) return false;
    let roll = rng() * total;
    for (let a = Math.max(0, k - nb); a <= Math.min(na, k); a++) {
      roll -= A.dist[a] * B.dist[k - a];
      if (roll <= 0) {
        return A.sample(a, rng, out) && B.sample(k - a, rng, out);
      }
    }
    return false;
  };

  return { dist, nums, cells: [...A.cells, ...B.cells], sample };
}

/* ---------------- 只剩一行 ---------------- */

/** 一行最多 8 个格子（见文件头说明），直接枚举 */
function solveRow(row) {
  const cells = [...row.terms.keys()];
  const coeffs = cells.map((c) => row.terms.get(c));
  const n = cells.length;

  if (n > 20) return null; // 结构上不该发生，发生了说明化简有 bug

  const nums = new Map();
  for (const c of cells) nums.set(c, new Float64Array(n + 1));
  const dist = new Float64Array(n + 1);

  const total = 1 << n;
  for (let mask = 0; mask < total; mask++) {
    let sum = 0;
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        sum += coeffs[i];
        k++;
      }
    }
    if (sum !== row.target) continue;
    dist[k]++;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) nums.get(cells[i])[k]++;
  }

  // 在这一行的合法取值里，均匀挑一个恰好用 k 颗雷的
  const sample = (k, rng, out) => {
    const hits = [];
    for (let mask = 0; mask < total; mask++) {
      let sum = 0;
      let cnt = 0;
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) {
          sum += coeffs[i];
          cnt++;
        }
      }
      if (sum === row.target && cnt === k) hits.push(mask);
    }
    if (hits.length === 0) return false;
    const pick = hits[Math.floor(rng() * hits.length)];
    for (let i = 0; i < n; i++) out[cells[i]] = pick & (1 << i) ? 1 : 0;
    return true;
  };

  return { dist, nums, cells, sample };
}

/* ---------------- 递归主体 ---------------- */

function solve(rows, ctx) {
  if (++ctx.nodes > ctx.budget) return null;

  const cells = collectCells(rows);
  const n = cells.size;

  if (!simplify(rows)) return zeroResult(cells, n);

  const pieces = splitPieces(rows);
  if (pieces.length > 1) {
    const parts = [];
    for (const piece of pieces) {
      const r = solve(piece, ctx);
      if (!r) return null;
      parts.push(r);
    }
    let acc = parts[0];
    for (let i = 1; i < parts.length; i++) acc = combine(acc, parts[i]);
    return acc;
  }

  if (rows.length === 0) {
    return { dist: Float64Array.of(1), nums: new Map(), cells: [], sample: (k) => k === 0 };
  }

  if (rows.length === 1) return solveRow(rows[0]);

  const v = chooseBranch(rows);
  const r0 = solve(substitute(rows, v, 0), ctx);
  if (!r0) return null;
  const r1 = solve(substitute(rows, v, 1), ctx);
  if (!r1) return null;
  return mergeBranches(v, r0, r1);
}

/* ---------------- 收口 ---------------- */

/**
 * C(free, j) 的相对值表，归一化到最大为 1。
 * 用对数累加再取指数：棋盘大时组合数能到 10^480，直接乘会溢出。
 */
function binomialTable(free, maxJ) {
  const logC = new Float64Array(maxJ + 1);
  for (let j = 1; j <= maxJ; j++) {
    logC[j] = j <= free ? logC[j - 1] + Math.log(free - j + 1) - Math.log(j) : -Infinity;
  }
  let peak = -Infinity;
  for (let j = 0; j <= maxJ; j++) if (logC[j] > peak) peak = logC[j];

  const out = new Float64Array(maxJ + 1);
  for (let j = 0; j <= maxJ; j++) out[j] = logC[j] === -Infinity ? 0 : Math.exp(logC[j] - peak);
  return out;
}

/* ================================================================== */
/* 公开接口                                                            */
/* ================================================================== */

export function computeProbabilities(view, options = {}) {
  // budget 计的是 solve 被调用的次数。它是粗略的兜底，不是精确的成本模型：
  // 小问题的单次调用很便宜，大问题很少出现。超过就如实报告这次不精确。
  const budget = options.budget || 200000;
  const failed = (reason) => ({
    ok: false,
    reason,
    probabilities: null,
    frontier: null,
    farField: null,
    exact: false,
    samples: 0,
    engine: 'recursive',
  });

  const rows = buildRows(view);
  const frontierCells = collectCells(rows);
  const freeCount = view.size - view.revealedCount - frontierCells.size;
  const hiddenCount = view.size - view.revealedCount;

  if (view.revealedCount === 0) {
    // 一个数字都没有（还没开局）：只受「总雷数 = M」支配，处处相同
    const p = view.mineCount / hiddenCount;
    const probabilities = new Float64Array(view.size).fill(NaN);
    const frontier = new Uint8Array(view.size);
    for (let i = 0; i < view.size; i++) if (!view.revealed[i]) probabilities[i] = p;
    return {
      ok: true, probabilities, frontier, farField: p,
      exact: true, samples: 0, engine: 'trivial',
    };
  }

  const result = solve(rows, { nodes: 0, budget });
  if (!result) return failed(EngineStatus.TIMEOUT);

  const maxK = result.dist.length - 1;
  const binom = binomialTable(freeCount, view.mineCount); // binom[M − k]
  const weight = (k) => (k >= 0 && k <= view.mineCount ? binom[view.mineCount - k] : 0);

  let total = 0;
  for (let k = 0; k <= maxK; k++) if (result.dist[k]) total += result.dist[k] * weight(k);
  if (!(total > 0)) return failed(EngineStatus.INCONSISTENT);

  const probabilities = new Float64Array(view.size).fill(NaN);
  for (const [c, num] of result.nums) {
    let hit = 0;
    for (let k = 0; k < num.length; k++) if (num[k]) hit += num[k] * weight(k);
    probabilities[c] = hit / total;
  }

  const frontier = new Uint8Array(view.size);
  for (const c of frontierCells) frontier[c] = 1;

  let farField = null;
  if (freeCount > 0) {
    let hit = 0;
    for (let k = 0; k <= maxK; k++) {
      if (!result.dist[k]) continue;
      hit += result.dist[k] * weight(k) * ((view.mineCount - k) / freeCount);
    }
    farField = hit / total;
    for (let i = 0; i < view.size; i++) {
      if (!view.revealed[i] && !frontier[i]) probabilities[i] = farField;
    }
  }

  // Σp 必须精确等于总雷数。任何一步写错（合并方式搞混、分支平移错位、
  // 自由格子组合数取反）都会在这里偏掉，是整套实现最强的整体自检。
  let sum = 0;
  for (let i = 0; i < view.size; i++) if (!view.revealed[i]) sum += probabilities[i];
  if (Math.abs(sum - view.mineCount) > 1e-6 * Math.max(1, view.mineCount)) {
    return failed(EngineStatus.INCONSISTENT);
  }

  return { ok: true, probabilities, frontier, farField, exact: true, samples: 0, engine: 'recursive' };
}

/**
 * 在与已知信息一致、且 forbidden 无雷的方案里等概率抽一份。
 *
 * 两次随机化，一次求解：
 *   1. 先按「方案数 × 自由格子组合数」抽前沿一共用几颗雷
 *   2. 再让 solve 留下的 sample() 沿递归树下行，把前沿的取值定下来 ——
 *      每个节点只做一次按权重的抽样，不重算
 *   3. 自由格子从剩下的里均匀抽
 *
 * forbidden 是作为一条强制约束加进去的，不是"抽完发现是雷再重抽"，
 * 所以 p 很高时也不会退化成拒绝采样。
 *
 * 早先的实现是逐格条件抽样，每格要重解两次；前沿 40 格就是 80 次完整求解，
 * 全在主线程上同步跑，重排时界面会整个冻住。现在是一次求解 + 一次下行。
 */
export function sampleLayout(view, forbidden, options = {}) {
  const budget = options.budget || 200000;
  const random = options.rng || Math.random;

  const rows = buildRows(view);
  rows.push(makeRow(new Map([[forbidden, 1]]), 0));

  const frontierCells = [...collectCells(rows)];
  const freeCount = view.size - view.revealedCount - frontierCells.length;
  const M = view.mineCount;

  const result = solve(rows, { nodes: 0, budget });
  if (!result) return { ok: false, reason: EngineStatus.TIMEOUT, mines: null };

  const binom = binomialTable(freeCount, M);
  const weight = (k) => (k >= 0 && k <= M ? binom[M - k] : 0);

  let total = 0;
  for (let k = 0; k < result.dist.length; k++) total += result.dist[k] * weight(k);
  if (!(total > 0)) return { ok: false, reason: EngineStatus.NO_SOLUTION, mines: null };

  let roll = random() * total;
  let frontierMines = 0;
  for (let k = 0; k < result.dist.length; k++) {
    roll -= result.dist[k] * weight(k);
    frontierMines = k;
    if (roll <= 0) break;
  }

  const picked = {};
  if (!result.sample(frontierMines, random, picked)) {
    return { ok: false, reason: EngineStatus.NO_SOLUTION, mines: null };
  }

  const mines = new Uint8Array(view.size);
  for (const key of Object.keys(picked)) if (picked[key]) mines[key] = 1;

  // 自由格子：从没被占用的里均匀抽 M − 前沿雷数 个
  const frontierSet = new Set(frontierCells);
  const pool = [];
  for (let i = 0; i < view.size; i++) {
    if (view.revealed[i] || frontierSet.has(i) || i === forbidden) continue;
    pool.push(i);
  }
  const need = M - frontierMines;
  if (need < 0 || need > pool.length) {
    return { ok: false, reason: EngineStatus.NO_SOLUTION, mines: null };
  }

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
  }
  for (let i = 0; i < need; i++) mines[pool[i]] = 1;

  return { ok: true, mines };
}

export default { computeProbabilities, sampleLayout, EngineStatus };
