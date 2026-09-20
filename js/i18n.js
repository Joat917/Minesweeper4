/**
 * i18n.js —— 中英双语
 *
 * 不做语言切换入口：跟随浏览器的首选语言，取第一个能识别的就定下来。
 * 所以这里没有"当前语言"的状态管理，也没有持久化。
 *
 * 用法：
 *
 *     import { t } from './i18n.js';
 *     t('tools.start')                        -> '开始' / 'Start'
 *     t('diff.frame', { name: '高级', rows: 16, cols: 30, mines: 99 })
 *
 * 占位符写成 {name}。取不到键时逐级回退：当前语言 -> 英文 -> 键本身。
 * 最后那层回退是有意的：界面上直接出现一个原始键，比静默显示空白更容易发现漏译。
 */

export const LANGUAGES = ['zh', 'en'];

const DICT = {
  /* ================================================================ */
  zh: {
    'app.title': '扫雷',
    'app.boardLabel': '扫雷棋盘',
    'app.noscript': '这个页面需要启用 JavaScript 才能运行。',

    'hud.mines': '剩余雷数',
    'hud.time': '已用时间（秒）',
    'hud.rate': '综合胜率',
    'hud.rateOff': '综合胜率只在辅助模式下计分',
    'hud.rateNoEngine': '概率引擎尚未接入（js/probability.js）',
    'hud.restart': '重开一局',

    'tools.difficulty': '难度',
    'tools.mode': '模式',
    'tools.custom': '自定义',
    'tools.rows': '行',
    'tools.cols': '列',
    'tools.mines': '雷',
    'tools.seed': '种子',
    'tools.seedPlaceholder': '随机',
    'tools.start': '开始',

    'diff.beginner': '初级',
    'diff.intermediate': '中级',
    'diff.expert': '高级',
    'diff.frame': '{name} {rows}×{cols} · {mines} 雷',

    'mode.classic': '经典',
    'mode.assisted': '辅助 · 显概率',
    'mode.customOption': '自定义…',

    'key.left': '左键',
    'key.right': '右键',
    'key.middle': '中键',
    'key.tap': '单击',
    'key.longPress': '长按',
    'key.arrows': '方向键',
    'key.space': '空格',
    'key.f': 'F',
    'key.r': 'R',
    'key.shift': 'Shift',
    'act.reveal': '翻开',
    'act.flag': '插旗',
    'act.chordViaNumber': '／点数字 和弦展开',
    'act.flagOnTouch': '插旗（触摸端）',
    'act.revealOnTouch': '翻开（触摸端）',
    'act.moveOrReveal': '移动／翻开',
    'act.flagOrRestart': '插旗／重开',
    'act.replay': '＋笑脸 复现上一局',

    'msg.won': '扫雷完成，用时 {seconds} 秒',
    'msg.lost': '踩雷了，点笑脸重开',
    'msg.lostForced': '踩中概率 100% 的雷，无处可躲',
    'msg.relayoutFailed': '重排失败（{reason}）',
    'msg.rateSuffix': ' · 综合胜率 {rate}',

    'assist.risk': '踩中 {risk} 风险',
    'assist.relaid': '该格是雷，已重排布雷（已翻开的数字未变）',
    'assist.rateChange': '综合胜率 {from} → {to}',
    'assist.zero': '该格含雷概率 {risk}，没有可回避的余地 —— 综合胜率归零',
    'assist.chord': '和弦展开 {count} 格 · 逐格计价 {from} → {to}',
    'assist.chordRelaid': '{count} 格是雷，已重排布雷',
    'assist.chordFatal': '和弦展开到第 {count} 格被拦下 —— 综合胜率归零',

    'msg.replay': '复现上一局 · 首点 第 {row} 行第 {col} 列',
    'msg.nothingToReplay': '上一局还没开局，没有可复现的首点，已换一张新图',
    'msg.noEngine': '概率引擎尚未接入（js/probability.js），本模式暂时等同经典玩法',

    'warn.rows': '行数需在 1–40 之间',
    'warn.cols': '列数需在 1–40 之间',
    'warn.cells': '格子总数请控制在 1600 以内',
    'warn.mines': '雷数必须是非负整数',
    'warn.minesTooMany': '雷数必须小于格子总数',
    'warn.dense': '雷太密，首点安全区无法完全避开，已自动放宽',

    'cell.label': '第 {row} 行，第 {col} 列{suffix}',
    'cell.flagged': '，已插旗',
    'cell.wrongFlag': '，插错的旗',
    'cell.question': '，问号',
    'cell.mine': '，地雷',
    'cell.adjacent': '，周围有 {n} 颗雷',
    'cell.empty': '，空地',
    'cell.hidden': '，未翻开',
    'cell.exploded': '（就是它炸的）',
    'cell.odds': '，含雷概率 {p}',

    /* 内核返回的消息键（见 minesweeper.js 里 _reject 的说明） */
    'reason.outOfRange': '下标越界',
    'reason.gameOver': '本局已结束',
    'reason.alreadyRevealed': '该格已翻开',
    'reason.flagged': '该格已插旗，请先取消旗子',
    'reason.flagRevealed': '已翻开的格子不能插旗',
    'reason.chordNeedsRevealed': '只能对已翻开的格子做和弦展开',
    'reason.chordEmpty': '空白格无需和弦展开',
    'reason.chordFlagMismatch': '周围旗数与数字不符',
    'reason.chordNothing': '周围没有可翻开的格子',
    'reason.relayoutLength': '布雷方案长度应为 {expected}',
    'reason.relayoutNotPlaced': '还没落雷，首点之后才谈得上重排',
    'reason.relayoutMineCount': '雷数应为 {expected}，实得 {actual}',
    'reason.relayoutRevealed': '第 {index} 格已经翻开，不能是雷',
    'reason.relayoutNumber': '新方案会改动第 {index} 格已翻开的数字',
    'reason.noResampler': '没有可用的重排引擎',
    'reason.relayoutEngine': '重排引擎未能给出方案',
    'reason.analyzeThrew': '概率引擎出错：{message}',
    'reason.resampleThrew': '重排引擎出错：{message}',
    'reason.analyzeEmpty': '概率引擎没有返回结果',
  },

  /* ================================================================ */
  en: {
    'app.title': 'Minesweeper',
    'app.boardLabel': 'Minesweeper board',
    'app.noscript': 'This page needs JavaScript enabled.',

    'hud.mines': 'Mines remaining',
    'hud.time': 'Elapsed time (seconds)',
    'hud.rate': 'Overall win rate',
    'hud.rateOff': 'Win rate is only scored in assisted mode',
    'hud.rateNoEngine': 'Probability engine not loaded (js/probability.js)',
    'hud.restart': 'New game',

    'tools.difficulty': 'Difficulty',
    'tools.mode': 'Mode',
    'tools.custom': 'Custom',
    'tools.rows': 'Rows',
    'tools.cols': 'Cols',
    'tools.mines': 'Mines',
    'tools.seed': 'Seed',
    'tools.seedPlaceholder': 'random',
    'tools.start': 'Start',

    'diff.beginner': 'Beginner',
    'diff.intermediate': 'Intermediate',
    'diff.expert': 'Expert',
    'diff.frame': '{name} {rows}×{cols} · {mines} mines',

    'mode.classic': 'Classic',
    'mode.assisted': 'Assisted · odds',
    'mode.customOption': 'Custom…',

    'key.left': 'Left',
    'key.right': 'Right',
    'key.middle': 'Middle',
    'key.tap': 'Tap',
    'key.longPress': 'Hold',
    'key.arrows': 'Arrows',
    'key.space': 'Space',
    'key.f': 'F',
    'key.r': 'R',
    'key.shift': 'Shift',
    'act.reveal': 'reveal',
    'act.flag': 'flag',
    'act.chordViaNumber': '/ number to chord',
    'act.flagOnTouch': 'flag (touch)',
    'act.revealOnTouch': 'reveal (touch)',
    'act.moveOrReveal': 'move / reveal',
    'act.flagOrRestart': 'flag / restart',
    'act.replay': '+ face to replay',

    'msg.won': 'Cleared in {seconds}s',
    'msg.lost': 'Boom. Tap the face to restart.',
    'msg.lostForced': 'Hit a mine at 100% — no way around it',
    'msg.relayoutFailed': 'Re-lay failed ({reason})',
    'msg.rateSuffix': ' · win rate {rate}',

    'assist.risk': '{risk} risk taken',
    'assist.relaid': 'mine re-laid, numbers unchanged',
    'assist.rateChange': 'win rate {from} → {to}',
    'assist.zero': 'Mine odds {risk} — no way around it. Win rate now zero.',
    'assist.chord': 'chorded {count} cells · {from} → {to}',
    'assist.chordRelaid': '{count} mines re-laid',
    'assist.chordFatal': 'Chord stopped at cell {count} — win rate now zero',

    'msg.replay': 'Replaying — first click row {row}, col {col}',
    'msg.nothingToReplay': 'Nothing to replay — fresh board',
    'msg.noEngine': 'No probability engine — assisted mode plays like classic',

    'warn.rows': 'Rows must be 1–40',
    'warn.cols': 'Cols must be 1–40',
    'warn.cells': 'Keep total cells under 1600',
    'warn.mines': 'Mines must be a non-negative integer',
    'warn.minesTooMany': 'Mines must be fewer than the total cells',
    'warn.dense': 'Too many mines to keep the first click clear; rule relaxed',

    'cell.label': 'Row {row}, column {col}{suffix}',
    'cell.flagged': ', flagged',
    'cell.wrongFlag': ', wrong flag',
    'cell.question': ', question mark',
    'cell.mine': ', mine',
    'cell.adjacent': ', {n} adjacent',
    'cell.empty': ', empty',
    'cell.hidden': ', hidden',
    'cell.exploded': ' (this one blew up)',
    'cell.odds': ', {p} mine odds',

    'reason.outOfRange': 'Index out of range',
    'reason.gameOver': 'This game is over',
    'reason.alreadyRevealed': 'Already revealed',
    'reason.flagged': 'Flagged — clear the flag first',
    'reason.flagRevealed': 'Cannot flag a revealed cell',
    'reason.chordNeedsRevealed': 'Chording only works on a revealed number',
    'reason.chordEmpty': 'Nothing to chord around an empty cell',
    'reason.chordFlagMismatch': 'Flags around it do not match the number',
    'reason.chordNothing': 'No hidden cells around it',
    'reason.relayoutLength': 'Layout must have length {expected}',
    'reason.relayoutNotPlaced': 'Mines are not placed yet',
    'reason.relayoutMineCount': 'Expected {expected} mines, got {actual}',
    'reason.relayoutRevealed': 'Cell {index} is revealed and cannot be a mine',
    'reason.relayoutNumber': 'New layout would change the number at cell {index}',
    'reason.noResampler': 'No re-lay engine available',
    'reason.relayoutEngine': 'Re-lay engine returned no layout',
    'reason.analyzeThrew': 'Odds engine failed: {message}',
    'reason.resampleThrew': 'Re-lay engine failed: {message}',
    'reason.analyzeEmpty': 'Odds engine returned nothing',
  },
};

/* ------------------------------------------------------------------ */
/* 语言识别                                                            */
/* ------------------------------------------------------------------ */

/**
 * 取浏览器首选语言里第一个能识别的。
 * zh 系全部归到 zh，en 系归到 en；都不是就用英文。
 */
export function detectLanguage() {
  let tags = [];
  if (typeof navigator !== 'undefined') {
    if (Array.isArray(navigator.languages) && navigator.languages.length) {
      tags = navigator.languages;
    } else if (navigator.language) {
      tags = [navigator.language];
    }
  }

  for (const raw of tags) {
    const code = String(raw).toLowerCase();
    if (code.startsWith('zh')) return 'zh';
    if (code.startsWith('en')) return 'en';
  }
  return 'en';
}

const current = detectLanguage();

/** 当前语言代码 */
export function language() {
  return current;
}

/**
 * 取文案。params 用 {name} 占位。
 * 回退链：当前语言 -> 英文 -> 键本身。
 */
export function t(key, params) {
  let text = DICT[current][key];
  if (text === undefined) text = DICT.en[key];
  if (text === undefined) return key; // 漏译时让键露出来，比静默空白好查

  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    params[name] === undefined ? whole : String(params[name])
  );
}

export default { t, language, detectLanguage, LANGUAGES };
