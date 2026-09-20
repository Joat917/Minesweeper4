/**
 * minesweeper.js —— 扫雷的纯计算内核
 *
 * 设计约束（这就是"完全分离"的含义）：
 *   1. 不引用 DOM / window / document / 任何浏览器 API。
 *   2. 不引用 setTimeout / requestAnimationFrame，时间由外部注入的 clock() 提供。
 *   3. 不主动渲染、不订阅事件。外部读快照、外部驱动状态变化。
 *   4. 随机数由可注入的 rng 提供 → 给定 seed 时整局完全可复现。
 *
 * 因此它可以直接在 Node / 测试框架里 import 运行，不需要任何页面环境。
 *
 * 关于可复现性（重要）：
 *   雷图不是 seed 的函数，而是 (seed, 首点下标) 的函数。
 *   因为"首点必定开出 0"要求落雷时避开首点的 3×3 邻域，候选池随之依赖首点位置，
 *   后面那串随机数抽出来的下标含义也就变了。
 *   也就是说：同一 seed 换个位置先点，得到的就是另一张图。
 *   想复现同一张图，必须同时复用 seed 和 firstIndex（见 firstIndex getter）。
 *
 * 关于辅助模式（assist）：
 *   传入 assist = { analyze, resample } 即开启。两个函数都由外部注入，
 *   内核不认识任何具体算法，只按契约调用：
 *     analyze(view)         -> { ok, probabilities, frontier, farField, ... }
 *     resample(view, forbid) -> { ok, mines }
 *   开启后：翻开有风险的格子会按 (1 - p) 折扣综合胜率；
 *   若该格确实是雷且 p < 1，则先重排布雷把它变空（已翻开的数字不变）再翻开；
 *   p = 1 时不存在合法重排，正常踩雷结束。详见 _applyAssist。
 *
 *   下划线开头的成员是内部/受保护成员，子类和同模块可以访问，外部请走公开接口。
 *
 * 对外接口一览
 *   构造：new Minesweeper({ rows, cols, mines, seed, allowQuestion, safeNeighborhood, autoFlagOnWin, debug, clock, assist })
 *   变更：reveal(r,c) / revealIndex(i) / toggleFlag(r,c) / toggleFlagIndex(i) / chord(r,c) / chordIndex(i) / reset() / relayout(mines)
 *   读取：cellAt(r,c) / cellAtIndex(i) / snapshot() / analysisView() / analysis / probabilityAt(i)
 *         firstIndex / winRate / assistEnabled / 各种 getter
 *   返回值：{ ok, changed: number[], status, exploded, reason?, assist? }
 *           changed 是"可见状态发生变化"的格子下标，UI 只需重画这些格子。
 *           assist 只在辅助模式下、且这次操作有风险时出现。
 *
 *   reason 是**给 i18n 用的消息键**（如 'reason.flagged'），不是给人看的文本 ——
 *   内核不认识任何语言，界面拿到之后用 i18n.js 的 t() 翻译。
 *   需要填参数的键，参数放在同级的 detail 字段里。
 */

/** 单元格可见状态 */
export const CellState = Object.freeze({
  HIDDEN: 'hidden',
  REVEALED: 'revealed',
  FLAGGED: 'flagged',
  QUESTION: 'question',
});

/** 一局游戏的状态 */
export const GameStatus = Object.freeze({
  READY: 'ready',     // 还没落雷（等待首点）
  PLAYING: 'playing',
  WON: 'won',
  LOST: 'lost',
});

/** 内置难度。只有数据，展示用的名字由 UI 层按语言拼（见 i18n.js） */
export const DIFFICULTIES = Object.freeze({
  beginner: { rows: 9, cols: 9, mines: 10 },
  intermediate: { rows: 16, cols: 16, mines: 40 },
  expert: { rows: 16, cols: 30, mines: 99 },
});

/** 内部用数字表示状态，省内存也省比较开销 */
const S_HIDDEN = 0;
const S_REVEALED = 1;
const S_FLAGGED = 2;
const S_QUESTION = 3;
const STATE_NAMES = [CellState.HIDDEN, CellState.REVEALED, CellState.FLAGGED, CellState.QUESTION];

/* ------------------------------------------------------------------ */
/* 随机数                                                              */
/* ------------------------------------------------------------------ */

/** 32 位确定性 PRNG（mulberry32），同 seed 必得同一序列 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把任意字符串折成 32 位整数（FNV-1a） */
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createRandom(seed) {
  if (seed === null || seed === undefined || seed === '') return Math.random;
  const numeric = typeof seed === 'number' && Number.isFinite(seed) ? seed : hashString(String(seed));
  return mulberry32(numeric);
}

/* ------------------------------------------------------------------ */
/* 内核                                                                */
/* ------------------------------------------------------------------ */

export class Minesweeper {
  constructor(options = {}) {
    const {
      rows = 9,
      cols = 9,
      mines = 10,
      seed = null,
      allowQuestion = false,   // 插旗后是否进入"?"中间态
      safeNeighborhood = true, // 首点周围 3×3 也不落雷（保证开局能展开一片）
      autoFlagOnWin = true,    // 胜利时自动把剩余的雷插上旗
      debug = false,           // true 时快照始终暴露雷的位置（调试/测试用）
      assist = null,           // { analyze, resample }，传了就是辅助模式
      clock = () => Date.now(),
    } = options;

    if (!Number.isInteger(rows) || rows < 1) throw new RangeError('rows 必须是正整数');
    if (!Number.isInteger(cols) || cols < 1) throw new RangeError('cols 必须是正整数');
    if (!Number.isInteger(mines) || mines < 0) throw new RangeError('mines 必须是非负整数');

    this.rows = rows;
    this.cols = cols;
    this.size = rows * cols;
    this.mineCount = mines;
    if (mines >= this.size) throw new RangeError('雷数必须小于格子总数');

    this.allowQuestion = !!allowQuestion;
    this.safeNeighborhood = !!safeNeighborhood;
    this.autoFlagOnWin = !!autoFlagOnWin;
    this.debug = !!debug;
    this.assist = assist && typeof assist.analyze === 'function' ? assist : null;
    this.clock = clock;
    this.seed = seed;

    this._mine = new Uint8Array(this.size);     // 1 = 有雷
    this._adjacent = new Uint8Array(this.size); // 0..8
    this._state = new Uint8Array(this.size);    // 内部状态码
    this._nb = new Int32Array(8);               // 邻格 scratch buffer

    this._initRun();
  }

  /* ---------------- 生命周期 ---------------- */

  /** 回到未开局状态，布局参数不变 */
  reset() {
    this._mine.fill(0);
    this._adjacent.fill(0);
    this._state.fill(0);
    this._initRun();
    return this;
  }

  _initRun() {
    this._nb = new Int32Array(8);
    this._placed = false;
    this._flagCount = 0;
    this._exploded = -1;
    this._firstIndex = -1;        // 落雷时为哪一格做的安全区，也就是本局的首点
    this._startedAt = 0;
    this._endedAt = 0;
    this.safeAreaRelaxed = false; // 雷太密时首点安全区被放宽过
    this._winRate = 1;            // 辅助模式的综合胜率，经典模式恒为 1
    this._analysis = null;        // 概率分析缓存
    this._analysisDirty = true;
    this._status = GameStatus.READY;
    this._rand = createRandom(this.seed);
  }

  /* ---------------- getter ---------------- */

  get status() { return this._status; }
  get isOver() { return this._status === GameStatus.WON || this._status === GameStatus.LOST; }
  get isWon() { return this._status === GameStatus.WON; }
  get flagCount() { return this._flagCount; }
  /**
   * 本局的首点下标；还没落雷（READY）时为 -1。
   * 由于雷图取决于 (seed, 该下标)，复现同一局必须把它一起带上。
   */
  get firstIndex() { return this._firstIndex; }

  /** 是否处于辅助模式 */
  get assistEnabled() { return this.assist !== null; }

  /**
   * 综合胜率，1 = 100%。
   * 经典模式恒为 1；辅助模式下每翻开一个概率为 p > 0 的格子就乘上 (1 - p)，
   * 也就是"一个没有保命机制、纯靠运气的玩家走到现在还能活着的概率"。
   */
  get winRate() { return this._winRate; }
  /** 剩余雷数 = 总雷数 - 已插旗数（过度插旗时会是负数，交给 UI 决定怎么显示） */
  get remainingMines() { return this.mineCount - this._flagCount; }
  get explodedIndex() { return this._exploded; }

  /** 已用时（毫秒）。READY 为 0，进行中走注入的 clock，结束后冻结。 */
  get elapsedMs() {
    if (this._status === GameStatus.READY) return 0;
    if (this._status === GameStatus.PLAYING) return Math.max(0, this.clock() - this._startedAt);
    return Math.max(0, this._endedAt - this._startedAt);
  }

  /* ---------------- 读取单元格 ---------------- */

  cellAt(row, col) {
    return this.cellAtIndex(this._index(row, col));
  }

  /**
   * 返回某个格子的只读快照。
   * mine 字段只在整局结束（或 debug）时才是 true/false，进行中恒为 null ——
   * 这样"未公开信息"不会通过快照泄漏给视图层。
   */
  cellAtIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) return null;
    const row = (index / this.cols) | 0;
    return {
      index,
      row,
      col: index - row * this.cols,
      state: STATE_NAMES[this._state[index]],
      adjacent: this._adjacent[index],
      mine: (this.isOver || this.debug) ? this._mine[index] === 1 : null,
      exploded: index === this._exploded,
    };
  }

  /** 整盘快照，适合一次性渲染或调试打印 */
  snapshot() {
    const cells = new Array(this.size);
    for (let i = 0; i < this.size; i++) cells[i] = this.cellAtIndex(i);
    return {
      rows: this.rows,
      cols: this.cols,
      size: this.size,
      mineCount: this.mineCount,
      flagCount: this._flagCount,
      remainingMines: this.remainingMines,
      status: this._status,
      elapsedMs: this.elapsedMs,
      explodedIndex: this._exploded,
      cells,
    };
  }

  /* ---------------- 概率分析接口 ---------------- */

  /**
   * 给概率引擎的输入：只包含"已翻开"和"已翻开的数字"。
   *
   * 刻意不含旗子、问号，也不含任何雷的位置 ——
   * 标记只是玩家备忘，不参与计算；雷的位置是上帝视角，算概率时更不能看。
   * 于是这个对象可以安全地交给外部算法，甚至打日志。
   */
  analysisView() {
    const revealed = new Uint8Array(this.size);
    const adjacent = new Uint8Array(this.size);
    let revealedCount = 0;

    for (let i = 0; i < this.size; i++) {
      if (this._state[i] !== S_REVEALED) continue;
      revealed[i] = 1;
      adjacent[i] = this._adjacent[i];
      revealedCount++;
    }

    return {
      rows: this.rows,
      cols: this.cols,
      size: this.size,
      mineCount: this.mineCount,
      revealedCount,
      revealed,
      adjacent,
    };
  }

  /**
   * 概率分析结果（惰性计算 + 缓存）。
   * 只有"已翻开情况"变化才会失效；插旗不触发重算，因为引擎根本不吃旗子。
   */
  get analysis() {
    if (!this.assist) return null;
    if (!this._analysisDirty && this._analysis) return this._analysis;

    let result;
    try {
      result = this.assist.analyze(this.analysisView());
    } catch (error) {
      result = {
        ok: false,
        reason: 'reason.analyzeThrew',
        detail: { message: String(error && error.message) },
      };
    }
    this._analysis = result || { ok: false, reason: 'reason.analyzeEmpty' };
    this._analysisDirty = false;
    return this._analysis;
  }

  /** 某格的含雷概率；未知（未翻开）返回 null，已翻开或引擎不可用也返回 null */
  probabilityAt(index) {
    const analysis = this.analysis;
    if (!analysis || !analysis.ok || !analysis.probabilities) return null;
    const p = analysis.probabilities[index];
    return Number.isFinite(p) ? p : null;
  }

  _markAnalysisDirty() {
    this._analysisDirty = true;
    this._analysis = null;
  }

  /**
   * 用外部算好的方案替换当前布雷。
   *
   * 这是辅助模式"踩雷不死"的落点：先把雷挪开，再照常翻开。
   * 校验不通过就**原样拒绝**，绝不写入 —— 宁可这一步失败，
   * 也不能让一个坏方案把已翻开的数字悄悄改掉。
   *
   * @param {Uint8Array|number[]} mines 长度 size，真值 = 有雷
   */
  relayout(mines) {
    if (!mines || mines.length !== this.size) {
      return { ok: false, reason: 'reason.relayoutLength', detail: { expected: this.size } };
    }
    if (!this._placed) {
      return { ok: false, reason: 'reason.relayoutNotPlaced' };
    }

    let count = 0;
    for (let i = 0; i < this.size; i++) if (mines[i]) count++;
    if (count !== this.mineCount) {
      return {
        ok: false,
        reason: 'reason.relayoutMineCount',
        detail: { expected: this.mineCount, actual: count },
      };
    }

    for (let i = 0; i < this.size; i++) {
      if (this._state[i] === S_REVEALED && mines[i]) {
        return { ok: false, reason: 'reason.relayoutRevealed', detail: { index: i } };
      }
    }

    // 先试着装上去算邻雷数，逐格比对已翻开的数字；对不上就整体回滚
    const prevMine = this._mine;
    const prevAdjacent = this._adjacent;

    this._mine = Uint8Array.from(mines, (v) => (v ? 1 : 0));
    this._adjacent = new Uint8Array(this.size);
    this._computeAdjacent();

    for (let i = 0; i < this.size; i++) {
      if (this._state[i] !== S_REVEALED) continue;
      if (this._adjacent[i] !== prevAdjacent[i]) {
        this._mine = prevMine;
        this._adjacent = prevAdjacent;
        return { ok: false, reason: 'reason.relayoutNumber', detail: { index: i } };
      }
    }

    this._exploded = -1;
    this._markAnalysisDirty();
    return { ok: true, changed: [] };
  }

  /* ---------------- 操作 ---------------- */

  reveal(row, col) { return this.revealIndex(this._index(row, col)); }

  /** 翻开一格。首次翻开时才落雷，因此第一下永远不会踩雷。 */
  revealIndex(index) {
    if (!this._isValidIndex(index)) return this._reject('reason.outOfRange');
    if (this.isOver) return this._reject('reason.gameOver');

    const st = this._state[index];
    if (st === S_REVEALED) return this._reject('reason.alreadyRevealed');
    if (st === S_FLAGGED) return this._reject('reason.flagged');

    // 辅助模式：先记账（可能要扣胜率、可能要把雷挪走），再照常翻开。
    // 放在这里而不是 _revealNow 里，是为了让"被拒绝的操作不计分"——上面的校验已经先筛掉了。
    const assist = this._applyAssist(index);

    const result = this._revealNow(index);
    if (assist) result.assist = assist;
    return result;
  }

  /** 真正的翻开逻辑；调用前必须已完成全部校验 */
  _revealNow(index) {
    const changed = [];

    if (!this._placed) {
      this._placeMines(index);
      this._status = GameStatus.PLAYING;
      this._startedAt = this.clock();
    }

    if (this._mine[index]) {
      this._state[index] = S_REVEALED;
      this._exploded = index;
      changed.push(index);
      this._revealAllMines(changed);
      this._end(GameStatus.LOST);
      this._markAnalysisDirty();
      return { ok: true, changed, status: this._status, exploded: true };
    }

    this._floodReveal(index, changed);
    this._checkWin(changed);
    this._markAnalysisDirty();
    return { ok: true, changed, status: this._status, exploded: false };
  }

  /**
   * 辅助模式的风险记账与保命重排。
   *
   * 返回 null 表示这次翻牌无风险（首点、概率为 0、或引擎给不出概率），
   * 否则返回 { probability, winRateBefore, winRate, relaid, saved, reason? }。
   *
   * 注意 p >= 1 时这里不做任何挽救：那种情况下"重排布雷且不改动已翻开数字"
   * 在数学上无解（该格在所有一致方案里都是雷），所以胜率归零、照常踩死。
   */
  _applyAssist(index) {
    if (!this.assist) return null;
    if (!this._placed) return null; // 首点：内核保证必开 0，风险为 0

    const p = this.probabilityAt(index);
    if (p === null || !(p > 0)) return null;

    const winRateBefore = this._winRate;
    this._winRate = winRateBefore * (1 - p);

    const info = {
      probability: p,
      winRateBefore,
      winRate: this._winRate,
      relaid: false,
      saved: false,
    };

    if (p >= 1) return info; // 没有合法重排，交给正常流程踩死

    if (this._mine[index]) {
      const applied = this._tryRelayout(index);
      info.relaid = applied.ok;
      info.saved = applied.ok;
      if (!applied.ok) {
        // detail 是消息键要用的参数，必须一起带上，否则界面上会显示成 {expected} 这种
        info.reason = applied.reason;
        info.detail = applied.detail;
      }
    }
    return info;
  }

  /** 请引擎抽一份"这格无雷"的合法布雷方案，校验后装上 */
  _tryRelayout(forbidden) {
    if (typeof this.assist.resample !== 'function') {
      return { ok: false, reason: 'reason.noResampler' };
    }

    let sampled;
    try {
      sampled = this.assist.resample(this.analysisView(), forbidden);
    } catch (error) {
      return {
        ok: false,
        reason: 'reason.resampleThrew',
        detail: { message: String(error && error.message) },
      };
    }

    if (!sampled || !sampled.ok || !sampled.mines) {
      // 引擎自己的 reason 是给调用方看的机器码，不透传给界面 ——
      // 玩家只需要知道"这次没能重排"
      return { ok: false, reason: 'reason.relayoutEngine' };
    }
    return this.relayout(sampled.mines);
  }

  toggleFlag(row, col) { return this.toggleFlagIndex(this._index(row, col)); }

  /** 插旗 / 取消 /（可选）问号，三态循环 */
  toggleFlagIndex(index) {
    if (!this._isValidIndex(index)) return this._reject('reason.outOfRange');
    if (this.isOver) return this._reject('reason.gameOver');

    const st = this._state[index];
    if (st === S_REVEALED) return this._reject('reason.flagRevealed');

    let next;
    if (st === S_HIDDEN) next = S_FLAGGED;
    else if (st === S_FLAGGED) next = this.allowQuestion ? S_QUESTION : S_HIDDEN;
    else next = S_HIDDEN;

    this._state[index] = next;
    if (st === S_FLAGGED) this._flagCount--;
    if (next === S_FLAGGED) this._flagCount++;

    return { ok: true, changed: [index], status: this._status, exploded: false };
  }

  chord(row, col) { return this.chordIndex(this._index(row, col)); }

  /**
   * 和弦展开：已翻开的数字格，若周围旗数等于数字，则掀开周围所有未插旗的格。
   * 旗插错了就会踩雷。
   */
  chordIndex(index) {
    if (!this._isValidIndex(index)) return this._reject('reason.outOfRange');
    if (this.isOver) return this._reject('reason.gameOver');
    if (this._state[index] !== S_REVEALED) return this._reject('reason.chordNeedsRevealed');

    const need = this._adjacent[index];
    if (need === 0) return this._reject('reason.chordEmpty');

    let flags = 0;
    let n = this._neighborsOf(index);
    for (let k = 0; k < n; k++) {
      if (this._state[this._nb[k]] === S_FLAGGED) flags++;
    }
    if (flags !== need) return this._reject('reason.chordFlagMismatch');

    // 先把目标收进普通数组：_nb 是复用的 scratch buffer，不能跨调用持有
    const targets = [];
    n = this._neighborsOf(index);
    for (let k = 0; k < n; k++) {
      const nb = this._nb[k];
      if (this._state[nb] === S_HIDDEN) targets.push(nb);
    }
    if (targets.length === 0) return this._reject('reason.chordNothing');

    return this.assist ? this._assistedChord(targets) : this._plainChord(targets);
  }

  /** 原版和弦展开：一次掀开全部目标，中途有雷就判负 */
  _plainChord(targets) {
    const changed = [];
    let exploded = false;
    for (const t of targets) {
      if (this._mine[t]) {
        this._state[t] = S_REVEALED;
        if (!exploded) this._exploded = t; // 只标记第一个踩中的雷
        changed.push(t);
        exploded = true;
      } else if (this._state[t] === S_HIDDEN) {
        this._floodReveal(t, changed);
      }
    }

    if (exploded) {
      this._revealAllMines(changed);
      this._end(GameStatus.LOST);
    } else {
      this._checkWin(changed);
    }
    this._markAnalysisDirty();
    return { ok: true, changed, status: this._status, exploded };
  }

  /**
   * 辅助模式下的和弦展开：一次掀开的多格按"逐格点击"计价。
   *
   * 完全模拟一个最优玩家会走的路径：
   *   每轮从还没翻开的待开格里挑当前概率**最低**的那个 -> 按 (1 - p) 计入胜率
   *   -> 翻开它（可能连锁展开、可能因此拿到新约束）-> **重新评估**剩下的格子 -> 重复。
   *
   * 为什么不直接把各格的当前概率连乘：那些是**边缘概率**，彼此并不独立。
   * 直接连乘会显著高估总风险 —— 现实里翻开第一格带来的新约束，
   * 经常把后面几格的概率直接压到 0，而连乘会老老实实把 0.3 一路乘下去。
   * 逐格重估拿到的才是真实玩家会经历的路径。
   *
   * 代价是每一轮都要重算一次概率，和弦掀开 k 格就是 k 次引擎调用。
   */
  _assistedChord(targets) {
    // 引擎给不出概率就老老实实退回原版，不假装算过
    const analysis = this.analysis;
    if (!analysis || !analysis.ok) return this._plainChord(targets);

    const changed = [];
    const steps = [];
    let relaidCount = 0;
    let reason = null;

    // 每轮至少翻掉一个目标格，所以循环次数天然被 targets.length 卡住
    for (let round = 0; round < targets.length; round++) {
      let best = -1;
      let bestP = Infinity;

      for (const t of targets) {
        if (this._state[t] !== S_HIDDEN) continue; // 已被上一轮的连锁展开翻掉
        const p = this.probabilityAt(t);
        const value = p === null ? 0 : p;
        if (value < bestP) {
          bestP = value;
          best = t;
        }
      }
      if (best < 0) break; // 待开格子都被展开翻完了

      const winRateBefore = this._winRate;
      this._winRate = winRateBefore * (1 - bestP);
      steps.push({ index: best, probability: bestP, winRateBefore, winRate: this._winRate });

      // p = 1 或者救不回来：只能按原版规则踩死
      let fatal = bestP >= 1;
      if (!fatal && this._mine[best]) {
        const applied = this._tryRelayout(best);
        if (applied.ok) {
          relaidCount++;
        } else {
          fatal = true;
          reason = applied.reason;
        }
      }

      if (fatal) {
        this._state[best] = S_REVEALED;
        this._exploded = best;
        changed.push(best);
        this._revealAllMines(changed);
        this._end(GameStatus.LOST);
        this._markAnalysisDirty();
        const info = this._chordAssist(steps, relaidCount, true);
        if (reason) info.reason = reason;
        return { ok: true, changed, status: this._status, exploded: true, assist: info };
      }

      this._floodReveal(best, changed);
      this._markAnalysisDirty(); // 关键：让下一轮的概率基于新信息重算
      this._checkWin(changed);
      if (this.isOver) break;
    }

    this._markAnalysisDirty();
    return {
      ok: true,
      changed,
      status: this._status,
      exploded: false,
      assist: this._chordAssist(steps, relaidCount, false),
    };
  }

  /** 把逐格计价的过程打包成 UI 能直接播报的形状 */
  _chordAssist(steps, relaidCount, fatal) {
    const first = steps[0] || null;
    return {
      chord: true,
      steps,
      count: steps.length,
      relaidCount,
      relaid: relaidCount > 0,
      saved: relaidCount > 0,
      fatal,
      probability: first ? first.probability : 0,
      winRateBefore: first ? first.winRateBefore : this._winRate,
      winRate: this._winRate,
    };
  }

  /* ---------------- 内部实现 ---------------- */

  _index(row, col) {
    if (!Number.isInteger(row) || !Number.isInteger(col)) return -1;
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return -1;
    return row * this.cols + col;
  }

  _isValidIndex(index) {
    return Number.isInteger(index) && index >= 0 && index < this.size;
  }

  /** 拒绝一次操作。reason 是 i18n 的消息键，不是文本 */
  _reject(reason) {
    return { ok: false, changed: [], status: this._status, exploded: false, reason };
  }

  _end(status) {
    this._status = status;
    this._endedAt = this.clock();
  }

  /** 把 index 的 8 邻格写进 this._nb，返回邻格个数（结果必须立即使用） */
  _neighborsOf(index) {
    const row = (index / this.cols) | 0;
    const col = index - row * this.cols;
    const buf = this._nb;
    let n = 0;
    for (let dr = -1; dr <= 1; dr++) {
      const nr = row + dr;
      if (nr < 0 || nr >= this.rows) continue;
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nc = col + dc;
        if (nc < 0 || nc >= this.cols) continue;
        buf[n++] = nr * this.cols + nc;
      }
    }
    return n;
  }

  /**
   * 落雷。safeIndex 及其 3×3 邻域尽量避开；
   * 若雷太密以致候选池不够，逐级放宽（先只保首点安全，再完全放开）。
   */
  _placeMines(safeIndex) {
    const { size, mineCount } = this;
    this._firstIndex = safeIndex; // 记下这张图是为哪个首点生成的
    const banned = new Set([safeIndex]);

    if (this.safeNeighborhood) {
      const n = this._neighborsOf(safeIndex);
      for (let k = 0; k < n; k++) banned.add(this._nb[k]);
    }

    let pool = [];
    for (let i = 0; i < size; i++) if (!banned.has(i)) pool.push(i);

    if (pool.length < mineCount) {
      pool = [];
      for (let i = 0; i < size; i++) if (i !== safeIndex) pool.push(i);
      this.safeAreaRelaxed = true; // 记录实际生效行为，便于 UI 提示；不改写配置
    }
    if (pool.length < mineCount) {
      pool = [];
      for (let i = 0; i < size; i++) pool.push(i);
    }

    // 部分 Fisher–Yates：只洗前 mineCount 个，取用前缀
    for (let i = 0; i < mineCount; i++) {
      const j = i + Math.floor(this._rand() * (pool.length - i));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
      this._mine[pool[i]] = 1;
    }

    // 预算邻雷数，避免每次点击现算
    this._computeAdjacent();

    this._placed = true;
  }

  /** 按当前 _mine 重算全部邻雷数（落雷和重排都要用） */
  _computeAdjacent() {
    for (let i = 0; i < this.size; i++) {
      if (this._mine[i]) {
        this._adjacent[i] = 0;
        continue;
      }
      let count = 0;
      const n = this._neighborsOf(i);
      for (let k = 0; k < n; k++) if (this._mine[this._nb[k]]) count++;
      this._adjacent[i] = count;
    }
  }

  /** 从 start 开始连锁翻开；用显式队列，几十万格也不会爆栈 */
  _floodReveal(start, changed) {
    const queue = [start];
    this._state[start] = S_REVEALED;
    changed.push(start);

    for (let qi = 0; qi < queue.length; qi++) {
      const idx = queue[qi];
      if (this._adjacent[idx] !== 0) continue; // 有数字的格子不再向外扩散

      const n = this._neighborsOf(idx);
      for (let k = 0; k < n; k++) {
        const nb = this._nb[k];
        if (this._state[nb] !== S_HIDDEN) continue; // 旗子/问号挡路
        this._state[nb] = S_REVEALED;
        changed.push(nb);
        queue.push(nb);
      }
    }
  }

  /** 输局时亮出所有没插旗的雷；已插旗的雷保持旗子，交给 UI 显示对错 */
  _revealAllMines(changed) {
    for (let i = 0; i < this.size; i++) {
      if (!this._mine[i]) continue;
      const st = this._state[i];
      if (st === S_HIDDEN || st === S_QUESTION) {
        this._state[i] = S_REVEALED;
        changed.push(i);
      }
    }
  }

  _checkWin(changed) {
    let revealed = 0;
    for (let i = 0; i < this.size; i++) if (this._state[i] === S_REVEALED) revealed++;
    if (revealed !== this.size - this.mineCount) return;

    if (this.autoFlagOnWin) {
      for (let i = 0; i < this.size; i++) {
        if (!this._mine[i] || this._state[i] === S_FLAGGED) continue;
        this._state[i] = S_FLAGGED;
        changed.push(i);
      }
      this._flagCount = this.mineCount;
    }
    this._end(GameStatus.WON);
  }
}

export default Minesweeper;
