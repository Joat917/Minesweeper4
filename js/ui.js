/**
 * ui.js —— 视图 + 交互控制器
 *
 * 这一层只做三件事：
 *   1. 把 DOM 事件翻译成内核调用；
 *   2. 把内核返回的 { changed, status } 翻译成 class / 文本；
 *   3. 管计时器、计数器、难度选择这些"外围"状态。
 *
 * 它不包含任何游戏规则：什么时候算赢、连锁展开到哪、旗数够不够，
 * 全部由 minesweeper.js 决定。这里唯一"聪明"的地方是决定画什么。
 */

// ?v=N 与 index.html 里 script 标签的版本号保持一致，用来绕开启发式缓存
import { Minesweeper, DIFFICULTIES, GameStatus } from './minesweeper.js?v=27';
import { computeProbabilities, sampleLayout } from './probability.js?v=27';
import { t, language } from './i18n.js?v=27';

const DIGITS = ['', '1', '2', '3', '4', '5', '6', '7', '8'];
const LONG_PRESS_MS = 420;

/** 辅助模式：把概率引擎按内核约定的接口注入进去 */
function makeAssist() {
  const options = { sampleCount: 20000 };
  return {
    analyze: (view) => computeProbabilities(view, options),
    resample: (view, forbidden) => sampleLayout(view, forbidden, options),
  };
}

/**
 * 概率引擎是否已接入。
 * 拿一个最小的合法局面探一次并缓存结果，这样等 probability.js 实现之后
 * 不用改这里任何代码，界面会自动从"未接入"切到正常显示。
 */
let engineProbe = null;
function isEngineReady() {
  if (engineProbe === null) {
    const probe = computeProbabilities({
      rows: 3, cols: 3, size: 9, mineCount: 1, revealedCount: 1,
      revealed: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0]),
      adjacent: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    }, { sampleCount: 200 });
    engineProbe = !!(probe && probe.ok);
  }
  return engineProbe;
}

/* ------------------------------------------------------------------ */
/* DOM 引用                                                            */
/* ------------------------------------------------------------------ */

const el = {
  app: document.querySelector('.app'),
  board: document.getElementById('board'),
  boardWrap: document.getElementById('boardWrap'),
  panel: document.querySelector('.panel'),
  face: document.getElementById('face'),
  timer: document.getElementById('timer'),
  mineCounter: document.getElementById('mineCounter'),
  winRate: document.getElementById('winRate'),
  mode: document.getElementById('mode'),
  difficulty: document.getElementById('difficulty'),
  custom: document.getElementById('custom'),
  rows: document.getElementById('customRows'),
  cols: document.getElementById('customCols'),
  mines: document.getElementById('customMines'),
  seed: document.getElementById('customSeed'),
  customStart: document.getElementById('customStart'),
  status: document.getElementById('status'),
};

/* 元素自检：脚本和标记对不上时（最典型的原因是浏览器缓存了旧版 ui.js），
   在这里就给出人话提示，而不是等到某个属性的 null 上报一个看不懂的 TypeError */
for (const [key, node] of Object.entries(el)) {
  if (!node) {
    throw new Error(
      `ui.js 找不到必需的页面元素 el.${key}。` +
      '通常说明浏览器用的是缓存的旧脚本，请强制刷新（Ctrl/Cmd + Shift + R）。'
    );
  }
}

/**
 * 把 index.html 里标记过的静态文本填上。
 *
 *   data-i18n="key"         填 textContent
 *   data-i18n-aria="key"    填 aria-label
 *   data-i18n-title="key"   填 title
 *
 * 属性和文本分成三个标记，是因为有些元素两种都要、但内容又是动态的
 * —— 计数器里是数字，只该改它的 aria-label，不能把数字覆盖掉。
 */
function applyStaticText() {
  document.documentElement.lang = language() === 'zh' ? 'zh-CN' : 'en';
  document.title = t('app.title');

  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll('[data-i18n-aria]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nAria));
  }
  for (const node of document.querySelectorAll('[data-i18n-title]')) {
    node.setAttribute('title', t(node.dataset.i18nTitle));
  }

  el.seed.placeholder = t('tools.seedPlaceholder');
}

/* ------------------------------------------------------------------ */
/* 模块内状态                                                          */
/* ------------------------------------------------------------------ */

let game = null;
let cellEls = [];
let cursor = 0;
let timerId = null;
let press = null;            // 长按：{ index, timer }
let pressPointer = 'mouse';  // 最近一次按下来自哪种输入设备
let suppressUntil = 0;       // 长按刚处理完的一小段时间里，吞掉浏览器补发的事件
let suppressIndex = -1;
let statusTimer = null;
let currentMode = 'classic';
let rotated = false;         // 窄屏上把宽扁的棋盘转 90°（见 computeRotation）
let currentConfig = { rows: 9, cols: 9, mines: 10, seed: null };

/* 旋转判据用到的两个阈值 */
const ROTATE_MAX_WIDTH = 640; // 超过这个宽度算"宽屏"，不转
const ROTATE_MIN_COLS = 30;   // 列数达到高级（16×30）才值得转

/**
 * 窄屏上把宽扁的棋盘转 90°。
 *
 * 手机是竖长的，而高级盘是 16 行 × 30 列这种"宽扁"形状：横着塞进竖屏只能
 * 压到 MIN_CELL 下限，然后横向滚动。转过来变成 30 行 × 16 列，正好贴着手机的
 * 长边，能完整放下而且格子更大。
 *
 * 三个条件缺一不可：
 *   窄屏            宽屏上转过来反而塞不下
 *   列数 > 行数     已经是竖长的盘再转就横了
 *   列数 >= 30      高级及以上才值得
 *
 * 刻意用 innerWidth 而不是 orientation：手机横屏时 innerWidth 很大，
 * 于是不转 —— 这是对的，横屏本来就装得下宽扁的盘。
 */
function computeRotation() {
  if (!game) return false;
  return (
    window.innerWidth <= ROTATE_MAX_WIDTH &&
    game.cols > game.rows &&
    game.cols >= ROTATE_MIN_COLS
  );
}

/* ------------------------------------------------------------------ */
/* 开局                                                                */
/* ------------------------------------------------------------------ */

function startGame({ rows, cols, mines, seed = null, firstIndex = null, mode = currentMode }) {
  // 没给种子就随机发一个。种子只在这里被记录和使用，界面上不再额外展示。
  const usedSeed = seed === null || seed === '' ? Math.floor(Math.random() * 1e9) : seed;

  currentMode = mode;
  el.mode.value = mode;

  game = new Minesweeper({
    rows: Number(rows),
    cols: Number(cols),
    mines: Number(mines),
    seed: usedSeed,
    allowQuestion: false,
    safeNeighborhood: true,
    autoFlagOnWin: true,
    assist: mode === 'assisted' ? makeAssist() : null,
  });

  currentConfig = { rows: Number(rows), cols: Number(cols), mines: Number(mines), seed: usedSeed };

  buildBoard();
  renderAll();
  fitBoard();
  syncTimer();
  updateFace();
  setStatus('');

  // 种子输入框跟着实际用的种子走，自定义开局时可以直接改
  if (document.activeElement !== el.seed) el.seed.value = String(usedSeed);

  // 复现上一局：必须补做同一次首点，雷图才会逐位一致
  if (firstIndex !== null) replayFirstClick(firstIndex);

  if (mode === 'assisted' && !isEngineReady()) {
    setStatus(t('msg.noEngine'), 'warn');
  }
}

/**
 * 复现时把上一局的首点重新点一次。
 * 走 act() 这条正常路径，所以计时、笑脸、播报的行为和玩家自己点完全一致
 * —— 计时器从这一刻起跑，和上一局也是同一口径。
 */
function replayFirstClick(index) {
  const cell = game.cellAtIndex(index);
  if (!cell) return;

  act(() => game.revealIndex(index));
  setStatus(t('msg.replay', { row: cell.row + 1, col: cell.col + 1 }));
}

function buildBoard() {
  const { rows, cols } = game;
  const frag = document.createDocumentFragment();

  rotated = computeRotation();

  // 视觉上的行列数：正常就是逻辑行列，旋转后互换
  const visualRows = rotated ? cols : rows;
  const visualCols = rotated ? rows : cols;

  el.board.textContent = '';
  el.board.style.setProperty('--cols', String(visualCols));
  el.board.setAttribute('aria-rowcount', String(visualRows));
  el.board.setAttribute('aria-colcount', String(visualCols));

  cellEls = new Array(rows * cols);

  // 按"视觉行"分组。ARIA 的 row 必须是视觉上的一行，
  // 所以旋转后每一条 role=row 装的是逻辑上的一整列。
  for (let vr = 0; vr < visualRows; vr++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    rowEl.setAttribute('role', 'row');

    for (let vc = 0; vc < visualCols; vc++) {
      // 视觉位置换回逻辑坐标
      const r = rotated ? vc : vr;
      const c = rotated ? vr : vc;
      const i = r * cols + c;

      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.id = `cell-${i}`;
      cell.dataset.index = String(i);
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-rowindex', String(vr + 1));
      cell.setAttribute('aria-colindex', String(vc + 1));
      cellEls[i] = cell;
      rowEl.appendChild(cell);
    }
    frag.appendChild(rowEl);
  }
  el.board.appendChild(frag);

  el.boardWrap.scrollLeft = 0;
  el.boardWrap.scrollTop = 0;
  cursor = 0;
  applyCursor();
}

/* ------------------------------------------------------------------ */
/* 尺寸自适应                                                          */
/* ------------------------------------------------------------------ */

/* 这几个常量必须和 style.css 里 .board 的 gap / padding 保持一致 */
const GAP = 2;
const BOARD_PAD = 6;
const MIN_CELL = 12;
const MAX_CELL = 40;

/* 百分比角标的字号是 CSS 里的 calc(var(--cell) * .3)。
   字号小于 MIN_PROB_FONT 就读不出来，于是"显不显示数字"这件事
   归结为"格子够不够大" —— 阈值是从字号反推出来的，不是拍脑袋定的。 */
const PROB_FONT_RATIO = 0.3;   // 与 style.css 里 ::after 的字号比例一致
const MIN_PROB_FONT = 7.2;     // px，再小就看不清
const ROOMY_CELL = MIN_PROB_FONT / PROB_FONT_RATIO; // = 24px

/**
 * 按可用空间反算格子边长，让整盘刚好放得下 —— 这样就不会出现滚动条。
 *
 * 链条是单向的，不要插别的东西进来：
 *
 *     屏幕尺寸 + 棋盘行列数  →  格子边长  →  显不显示百分比数字
 *
 * 格子边长完全由「屏幕上放得下」决定（再被 MIN_CELL / MAX_CELL 夹一下）；
 * 数字显不显示只看格子边长，不看别的。想调数字的可见性就调阈值，
 * 不要去动格子边长的算法。
 *
 * 宽度的约束来自 .app（它是 min(100%, 1000px) 的定宽，不随棋盘变化），
 * 高度则用「app 总高 - 棋盘区高」反推出除棋盘之外的所有竖直占用，
 * 因此改格子大小不会影响这个差值，不会来回震荡。
 */
function fitBoard() {
  if (!game) return;

  // 按视觉行列数算：旋转后棋盘是"转过来"的样子，装得下装不下由它决定
  const cols = rotated ? game.rows : game.cols;
  const rows = rotated ? game.cols : game.rows;

  const panelStyle = getComputedStyle(el.panel);
  const bodyStyle = getComputedStyle(document.body);

  // 除棋盘之外，这个页面竖直方向已经占掉的高度
  // （标题、HUD、面板内边距、工具条、提示、状态行、各段间距）
  const chromeHeight = el.app.scrollHeight - el.boardWrap.offsetHeight;

  const availW = el.app.clientWidth
    - parseFloat(panelStyle.paddingLeft) - parseFloat(panelStyle.paddingRight)
    - parseFloat(panelStyle.borderLeftWidth) - parseFloat(panelStyle.borderRightWidth);

  const availH = window.innerHeight
    - parseFloat(bodyStyle.paddingTop) - parseFloat(bodyStyle.paddingBottom)
    - chromeHeight - 4;

  const byWidth = (availW - BOARD_PAD * 2 - (cols - 1) * GAP) / cols;
  const byHeight = (availH - BOARD_PAD * 2 - (rows - 1) * GAP) / rows;

  const cell = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(Math.min(byWidth, byHeight))));
  el.board.style.setProperty('--cell', `${cell}px`);

  el.board.classList.toggle('board--roomy', cell >= ROOMY_CELL);
}

/* 窗口尺寸变了就重算；用 rAF 合并连续的 resize 事件 */
let fitPending = false;
function scheduleFit() {
  if (fitPending) return;
  fitPending = true;
  requestAnimationFrame(() => {
    fitPending = false;
    // 转屏可能改变"要不要旋转棋盘"的判断，变了就得重建格子
    if (game && computeRotation() !== rotated) {
      buildBoard();
      renderAll();
    }
    fitBoard();
  });
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function renderAll() {
  for (let i = 0; i < game.size; i++) renderCell(i);
  updateHud();
}

function applyChanges(indices) {
  for (const i of indices) renderCell(i);
  updateHud();
}

/** 把一个格子的内核状态翻译成 class + 文本 + 无障碍标签 */
function renderCell(index) {
  const cell = game.cellAtIndex(index);
  const node = cellEls[index];
  if (!cell || !node) return;

  const cls = ['cell'];
  let text = '';
  let suffix = '';

  switch (cell.state) {
    case 'flagged':
      cls.push('cell--flag');
      if (game.isOver && cell.mine === false) {
        cls.push('cell--wrong');   // 输局后标出插错的旗
        text = '✗';
        suffix = t('cell.wrongFlag');
      } else {
        text = '🚩';
        suffix = t('cell.flagged');
      }
      break;

    case 'question':
      cls.push('cell--question');
      text = '?';
      suffix = t('cell.question');
      break;

    case 'revealed':
      cls.push('cell--revealed');
      if (cell.mine) {
        cls.push('cell--mine');
        text = '💣';
        suffix = t('cell.mine');
      } else if (cell.adjacent > 0) {
        cls.push(`cell--n${cell.adjacent}`);
        text = DIGITS[cell.adjacent];
        suffix = t('cell.adjacent', { n: cell.adjacent });
      } else {
        cls.push('cell--empty');
        suffix = t('cell.empty');
      }
      break;

    default:
      suffix = t('cell.hidden');
      break;
  }

  if (cell.exploded) {
    cls.push('cell--boom');
    suffix += t('cell.exploded');
  }
  if (index === cursor) cls.push('cell--cursor');

  // 辅助模式：给未翻开的格子染上风险色
  const risk = readRisk(cell, index);
  if (risk) {
    cls.push('cell--risk');
    suffix += t('cell.odds', { p: formatPercent(risk.probability) });
  }

  const label = t('cell.label', { row: cell.row + 1, col: cell.col + 1, suffix });

  node.className = cls.join(' ');
  if (node.textContent !== text) node.textContent = text;
  node.setAttribute('aria-label', label);

  if (risk) {
    // 只写色相：格子背景是拿它直接算出的实体渐变，没有半透明层可叠。
    // 概率数字每格都写：颜色既然已经铺满，数字就没理由只给前沿格。
    // 远场格子的值全都一样（它们彼此可交换），会看到一片相同的数字，这是对的。
    node.style.setProperty('--risk-hue', riskHue(risk.probability).toFixed(1));
    node.dataset.prob = formatPercent(risk.probability);
  } else {
    node.style.removeProperty('--risk-hue');
    delete node.dataset.prob;
  }
}

/**
 * 取某格的风险信息，取不到就返回 null。
 * 只对未翻开的格子有意义；已翻开格的概率约定为 NaN，会被这里滤掉。
 */
function readRisk(cell, index) {
  if (!game.assistEnabled || cell.state === 'revealed') return null;

  const analysis = game.analysis;
  if (!analysis || !analysis.ok || !analysis.probabilities) return null;

  const probability = analysis.probabilities[index];
  if (!Number.isFinite(probability)) return null;

  return {
    probability,
    frontier: !!(analysis.frontier && analysis.frontier[index]),
  };
}

/**
 * 概率/胜率的统一显示格式：小数位随数量级调整。
 *
 * 两条底线：
 *   · 只有**真的** 100% 才写 100%。99.7% 也不能进位成 100% ——
 *     在这个模式里 p = 1 是个有特殊含义的门槛（必然有雷、没有合法重排），
 *     把它和"几乎必然"混在一起显示会误导。
 *   · 非零的概率绝不显示成 0%，同理。
 */
function formatPercent(value) {
  const pct = value * 100;
  if (pct >= 100 - 1e-9) return '100%';
  if (pct >= 10) return `${Math.min(99, Math.round(pct))}%`;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  if (pct > 0.05) return '<1%';
  return '0%';
}

/**
 * 综合胜率专用格式。
 *
 * 低于 1% 时改用科学计数法，而且**换成概率本身、不带百分号** ——
 * 胜率是连乘出来的，一盘里点几次有风险的格子就能掉到 1e-6 甚至更小，
 * 全挤在"<1%"里等于没有信息。
 *
 * 不带 % 是有意的：对百分数做科学计数法会得到 "5.0e-1%" 这种读不出量级的东西，
 * 而对概率本身取科学计数法，指数直接就是量级。
 */
function formatRate(value) {
  if (value > 0 && value < 0.01) return value.toExponential(1);
  return formatPercent(value);
}

/**
 * 概率 → 色相。
 *
 *   0    → 150° 绿   （绝对安全）
 *   0.5  →  55° 黄   （五五开）
 *   1    →   5° 红   （必然有雷）
 *
 * 只输出色相：饱和度、亮度都由 CSS 的令牌固定，所以整盘是同一套柔和质感，
 * 变化只在颜色本身。格子的背景不是"叠一层半透明色"，而是拿这个色相直接
 * 算出的实体渐变，因此没有任何透明度。
 *
 * 用色相而不是"加不同深浅的红"：这样一眼就能分辨安全格和危险格，
 * 而不是要盯着红色的浓度去比。
 */
function riskHue(p) {
  const x = p < 0 ? 0 : p > 1 ? 1 : p;
  return x <= 0.5 ? 150 - 190 * x : 55 - 100 * (x - 0.5);
}

function updateHud() {
  el.mineCounter.textContent = formatCounter(game.remainingMines);
  el.mineCounter.classList.toggle('hud__num--warn', game.remainingMines < 0);

  // 胜率槽位只在辅助模式下存在。经典模式整个不占位 —— 整行 flex 居中，
  // 少了这个槽位，剩下的三个组件自然还是一行居中。
  const showRate = game.assistEnabled;
  el.winRate.hidden = !showRate;

  if (showRate) {
    if (!isEngineReady()) {
      el.winRate.textContent = '—';
      el.winRate.classList.add('hud__num--idle');
      el.winRate.classList.remove('hud__num--sci');
      el.winRate.title = t('hud.rateNoEngine');
    } else {
      const rate = game.winRate;
      // 低于 1% 换科学计数法，字号随之收小，否则 "1.0e-20" 撑不进槽位
      const sci = rate > 0 && rate < 0.01;
      el.winRate.textContent = sci ? rate.toExponential(1) : formatPercent(rate);
      el.winRate.classList.remove('hud__num--idle');
      el.winRate.classList.toggle('hud__num--sci', sci);
      // 胜率 100% → 色相按"风险 0"算（绿）；0% → 按"风险 1"算（红）
      el.winRate.style.setProperty('--risk-hue', riskHue(1 - rate).toFixed(1));
      el.winRate.title = `${t('hud.rate')} ${rate.toExponential(3)}`;
    }
  }

  tickTimer();
}

function updateFace() {
  const faces = {
    [GameStatus.WON]: '😎',
    [GameStatus.LOST]: '💀',
  };
  el.face.textContent = faces[game.status] || '🙂';
  el.face.setAttribute('aria-label', t('hud.restart'));
}

/** 三位数码管风格计数（负数占一位符号位） */
function formatCounter(value) {
  const n = Math.trunc(value) || 0;
  if (n < 0) return '-' + String(Math.min(99, -n)).padStart(2, '0');
  return String(Math.min(999, n)).padStart(3, '0');
}

/* ------------------------------------------------------------------ */
/* 计时器                                                              */
/* ------------------------------------------------------------------ */

function syncTimer() {
  const running = game.status === GameStatus.PLAYING;
  if (running && timerId === null) {
    timerId = window.setInterval(tickTimer, 200);
  } else if (!running && timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
  tickTimer();
}

function tickTimer() {
  const seconds = Math.floor(game.elapsedMs / 1000);
  el.timer.textContent = formatCounter(seconds);
}

/* ------------------------------------------------------------------ */
/* 动作包装：统一处理"渲染哪些格子"和"什么时候结算"                     */
/* ------------------------------------------------------------------ */

function act(fn, silent = false) {
  if (!game || game.isOver) return;

  const before = game.status;
  const result = fn();

  if (!result || !result.ok) {
    if (!silent && result && result.reason) warn(result.reason);
    return;
  }

  const assist = result.assist || null;

  if (result.status !== before) {
    // 结算：地雷、错旗都要重画，整盘刷新最省心（也就几百个格子）
    renderAll();
    syncTimer();   // syncTimer 会在非 PLAYING 时顺手停掉定时器
    updateFace();
    announceResult(result.status, assist);  // 结算语里带上本次的胜率变化
  } else {
    // 辅助模式必须整盘重画：概率是**整盘耦合**的 —— 全局那条「总雷数 = M」
    // 把所有未翻开格子绑在一起，翻开任何一格拿到新数字，都会改变其余每一格
    // 的条件概率（前沿格重算，自由格子的组合数也跟着变）。
    // 只重画 changed 那几格的话，旁边的百分比和热力色会停在旧局面上。
    if (game.assistEnabled) renderAll();
    else applyChanges(result.changed);
    if (assist) announceAssist(assist);
  }
}

/** 辅助模式这次翻牌的反馈：扣了多少胜率、有没有靠重排保命 */
function announceAssist(info) {
  if (info.chord) {
    const before = formatPercent(info.winRateBefore);
    const after = formatPercent(info.winRate);

    if (info.fatal) {
      setStatus(t('assist.chordFatal', { count: info.count }), 'lose');
      return;
    }

    const parts = [t('assist.chord', { count: info.count, from: before, to: after })];
    if (info.relaidCount > 0) {
      parts.push(t('assist.chordRelaid', { count: info.relaidCount }));
    }
    setStatus(parts.join(' · '), info.relaidCount > 0 ? 'warn' : '');
    return;
  }

  const risk = formatPercent(info.probability);

  if (info.winRate <= 0) {
    setStatus(t('assist.zero', { risk }), 'lose');
    return;
  }

  const parts = [t('assist.risk', { risk })];
  if (info.relaid) parts.push(t('assist.relaid'));
  else if (info.reason) parts.push(t('msg.relayoutFailed', { reason: t(info.reason, info.detail) }));
  parts.push(t('assist.rateChange', {
    from: formatPercent(info.winRateBefore),
    to: formatPercent(info.winRate),
  }));

  setStatus(parts.join(' · '), info.relaid ? 'warn' : '');
}

function announceResult(status, assist = null) {
  const rate = assist ? t('msg.rateSuffix', { rate: formatPercent(game.winRate) }) : '';

  if (status === GameStatus.WON) {
    setStatus(t('msg.won', { seconds: (game.elapsedMs / 1000).toFixed(1) }) + rate, 'win');
    return;
  }
  if (status !== GameStatus.LOST) return;

  if (!assist) {
    setStatus(t('msg.lost'), 'lose');
    return;
  }
  // 辅助模式下输只有两种原因：被逻辑强制的雷拦住，或者重排引擎没给出方案
  const why = assist.reason
    ? t('msg.relayoutFailed', { reason: t(assist.reason, assist.detail) })
    : t('msg.lostForced');
  setStatus(why + rate, 'lose');
}

/**
 * 状态行：平时是空的，只在结算或报错时出现。
 * tone 决定颜色：win 绿 / lose 红 / warn 红（校验失败）。
 */
function setStatus(text, tone = '') {
  window.clearTimeout(statusTimer);
  el.status.textContent = text;
  el.status.className = text ? `status status--${tone || 'plain'}` : 'status';
  if (!text) return;

  // 结算信息留 4 秒，报错信息自己消失，免得变成常驻噪音
  statusTimer = window.setTimeout(() => {
    if (el.status.textContent === text) setStatus('');
  }, tone === 'warn' ? 2000 : 4000);
}

function warn(text) {
  setStatus(text, 'warn');
}

/* ------------------------------------------------------------------ */
/* 鼠标 / 触摸                                                         */
/* ------------------------------------------------------------------ */

function indexFromEvent(event) {
  const node = event.target.closest('.cell');
  if (!node || !node.dataset.index) return -1;
  return Number(node.dataset.index);
}

/**
 * 长按插旗之后，浏览器还可能补发 contextmenu 和 click。
 * 用一个小时间窗统一忽略它们，避免同一格被插旗又取消。
 */
function isSuppressed(index) {
  return performance.now() < suppressUntil && index === suppressIndex;
}

/** 翻开：点在已翻开的数字上做和弦展开，否则翻开这一格 */
function revealAt(index) {
  const cell = game.cellAtIndex(index);
  if (!cell) return;
  if (cell.state === 'revealed') act(() => game.chordIndex(index), true);
  else act(() => game.revealIndex(index));
}

el.board.addEventListener('click', (event) => {
  const index = indexFromEvent(event);
  if (index < 0) return;
  if (isSuppressed(index)) return; // 这一下已经由长按处理过了

  setCursor(index);
  el.board.focus({ preventScroll: true });

  const cell = game.cellAtIndex(index);
  if (!cell) return;

  // 触摸端单击 = 插旗；点在已翻开的数字上仍然是和弦展开
  // （已翻开的格子本来就插不了旗，两者不冲突）
  if (pressPointer !== 'mouse') {
    if (cell.state === 'revealed') act(() => game.chordIndex(index), true);
    else act(() => game.toggleFlagIndex(index));
    return;
  }

  // 鼠标端沿用桌面习惯：左键翻开／点数字和弦
  revealAt(index);
});

el.board.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const index = indexFromEvent(event);
  if (index < 0) return;
  if (isSuppressed(index)) return; // 触摸长按：不要再处理一次
  setCursor(index);
  act(() => game.toggleFlagIndex(index));
});

// 中键和弦展开
el.board.addEventListener('auxclick', (event) => {
  if (event.button !== 1) return;
  event.preventDefault();
  const index = indexFromEvent(event);
  if (index < 0) return;
  act(() => game.chordIndex(index));
});

/*
 * 触摸端的操作分工是**和鼠标反过来**的：
 *
 *     单击  → 插旗（安全、随时可撤销）；点在已翻开的数字上 → 和弦展开
 *     长按  → 翻开
 *
 * 把"翻开"放到长按上，是因为它是这一局里唯一不可撤销的动作 ——
 * 点歪一格就可能直接踩雷。插旗反过来随时可以取消，放单击上最合适。
 * 长按要有明确的震动反馈，否则玩家不知道这一次到底生效了没有。
 */
el.board.addEventListener('pointerdown', (event) => {
  pressPointer = event.pointerType || 'mouse';
  if (pressPointer === 'mouse') return;

  const index = indexFromEvent(event);
  if (index < 0) return;

  const timer = window.setTimeout(() => {
    suppressIndex = index;
    suppressUntil = performance.now() + 600;
    if (navigator.vibrate) navigator.vibrate(12);
    revealAt(index);
  }, LONG_PRESS_MS);

  press = { index, timer };
});

for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  el.board.addEventListener(type, () => {
    if (press) {
      window.clearTimeout(press.timer);
      press = null;
    }
  });
}

/* ------------------------------------------------------------------ */
/* 键盘                                                                */
/* ------------------------------------------------------------------ */

el.board.addEventListener('keydown', (event) => {
  const { rows, cols } = game;

  // 方向键按**视觉**方向走：棋盘转过 90° 时，视觉上的"右"
  // 对应的其实是逻辑上的"下一行"。直接把视觉位移翻译成逻辑位移。
  const move = (dRowVisual, dColVisual) => {
    event.preventDefault();
    let row = (cursor / cols) | 0;
    let col = cursor - row * cols;
    row = Math.max(0, Math.min(rows - 1, row + (rotated ? dColVisual : dRowVisual)));
    col = Math.max(0, Math.min(cols - 1, col + (rotated ? dRowVisual : dColVisual)));
    setCursor(row * cols + col);
  };

  switch (event.key) {
    case 'ArrowUp':    move(-1, 0); return;
    case 'ArrowDown':  move(1, 0); return;
    case 'ArrowLeft':  move(0, -1); return;
    case 'ArrowRight': move(0, 1); return;

    case ' ':
    case 'Enter':
      event.preventDefault();
      revealAt(cursor);
      return;

    case 'f':
    case 'F':
      event.preventDefault();
      act(() => game.toggleFlagIndex(cursor));
      return;

    case 'r':
    case 'R':
      event.preventDefault();
      restart();
      return;

    default:
  }
});

function setCursor(index) {
  cursor = index;
  applyCursor();
}

function applyCursor() {
  el.board.setAttribute('aria-activedescendant', `cell-${cursor}`);
  for (let i = 0; i < cellEls.length; i++) {
    const on = i === cursor;
    if (cellEls[i].classList.contains('cell--cursor') !== on) {
      cellEls[i].classList.toggle('cell--cursor', on);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 难度与重开                                                          */
/* ------------------------------------------------------------------ */

el.mode.addEventListener('change', () => {
  // 换模式等于换一套规则，胜率和概率都要从头开始，所以直接重开一局
  currentMode = el.mode.value;
  restart();
});

el.difficulty.addEventListener('change', () => {
  const value = el.difficulty.value;
  setCustomEnabled(value === 'custom');
  if (value === 'custom') return; // 等用户点"开始"，别拿旧的自定义参数开局
  startGame(DIFFICULTIES[value]);
});

/** 自定义栏一直显示，非自定义难度下整组标灰并禁用 */
function setCustomEnabled(on) {
  el.custom.classList.toggle('group--off', !on);
  for (const node of [el.rows, el.cols, el.mines, el.seed, el.customStart]) {
    node.disabled = !on;
  }
}

el.customStart.addEventListener('click', () => {
  const rows = Number(el.rows.value);
  const cols = Number(el.cols.value);
  const mines = Number(el.mines.value);
  const seed = el.seed.value.trim();

  const error = validateCustom(rows, cols, mines);
  if (error) {
    warn(error);
    return;
  }
  startGame({ rows, cols, mines, seed: seed === '' ? null : seed });
  if (mines > rows * cols - 9) {
    warn(t('warn.dense'));
  }
});

function validateCustom(rows, cols, mines) {
  if (!Number.isInteger(rows) || rows < 1 || rows > 40) return t('warn.rows');
  if (!Number.isInteger(cols) || cols < 1 || cols > 40) return t('warn.cols');
  if (rows * cols > 1600) return t('warn.cells');
  if (!Number.isInteger(mines) || mines < 0) return t('warn.mines');
  if (mines >= rows * cols) return t('warn.minesTooMany');
  return null;
}

/**
 * 重开一局。
 *
 * reuseSeed = true 时复现上一局：既要同一颗种子，也要同一次首点。
 * 因为内核落雷要避开首点的 3×3 邻域，雷图是 (seed, 首点) 的函数而不是 seed 的函数
 * —— 只带种子、不补首点，同一颗种子照样会长出另一张图。
 * 所以这里从内核读回 firstIndex 一起带上；上一局还没开局（firstIndex < 0）就无从复现。
 */
function restart(reuseSeed = false) {
  const replayable = reuseSeed && game && game.firstIndex >= 0;

  startGame({
    rows: currentConfig.rows,
    cols: currentConfig.cols,
    mines: currentConfig.mines,
    seed: replayable ? currentConfig.seed : null,
    firstIndex: replayable ? game.firstIndex : null,
    mode: currentMode,
  });

  // 必须放在 startGame 之后：它内部会 setStatus('')，先发的提示会被立刻擦掉
  if (reuseSeed && !replayable) {
    warn(t('msg.nothingToReplay'));
  }
}

el.face.addEventListener('click', (event) => restart(event.shiftKey));

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

// 静态文本先填，免得刷新时闪一下原文
applyStaticText();

/** 难度名和行列雷数都在别处，这里按当前语言拼成一行 */
function presetLabel(key, preset) {
  return t('diff.frame', {
    name: t(`diff.${key}`),
    rows: preset.rows,
    cols: preset.cols,
    mines: preset.mines,
  });
}

for (const [key, preset] of Object.entries(DIFFICULTIES)) {
  const option = document.createElement('option');
  option.value = key;
  option.textContent = presetLabel(key, preset);
  el.difficulty.appendChild(option);
}
const customOption = document.createElement('option');
customOption.value = 'custom';
customOption.textContent = t('mode.customOption');
el.difficulty.appendChild(customOption);

el.difficulty.value = 'beginner';
setCustomEnabled(false);
startGame(DIFFICULTIES.beginner);

window.addEventListener('resize', scheduleFit);
window.addEventListener('orientationchange', scheduleFit);
window.addEventListener('load', scheduleFit);
