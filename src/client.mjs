/**
 * DSH 助理 —— 浏览器端。
 *
 * 侧边栏挂一个图标，点开整页就是画布：一张无限大的浅色底，上面铺着便签。
 *   · 双击空白处新建便签
 *   · 便签左上角复选框勾一下就算做完（卡片变淡、划线）
 *   · 没做完的可以在便签里补「进展」
 *   · 拖动便签移动，拖到右下角垃圾桶删除
 *
 * 数据走宿主挂的同源路由 /workbench/api/*（见 src/http.mjs）。
 * 写操作带 X-Workbench-Token，令牌由宿主注入页面。
 *
 * 约束：浏览器半区没有 JSX 编译，用 React.createElement 手写；样式用内联对象。
 */

const NS = 'secretary';
const PANEL_ID = 'secretary';
const API = '/workbench/api';

/**
 * 客户端插件的服务依赖声明：cordis 只把声明过的服务挂到 ctx 上。
 * 少了这一行，apply 里的 ctx.slots 不是服务对象，会抛 TypeError，
 * 整个条目状态变 failed —— 而 DSH 的 web boot 会因此终止启动。
 */
const inject = ['slots'];

const runtime = { React: null };
/** 画布组件的回调出口：便签子组件通过它把最新看板推回画布。 */
const boardSink = { fn: null };

const NOTE_W = 248;
/** 排布避让用的估算高度（实际卡片会随进展条数变高，这里取一个偏大的值）。 */
const NOTE_H = 200;
/** 新便签之间、以及和已有便签之间留的空隙。 */
const NOTE_GAP = 16;

/** 画布基准尺寸与页边距；纵向不够时会自动加高。 */
const CANVAS_W = 2600;
/** 画布最小宽度（窗口很窄时兜底）。 */
const CANVAS_W_MIN = 520;
const CANVAS_H = 1800;
const MARGIN = 40;
/**
 * 统一配色（参考苹果备忘录）：不再有六色便签。
 * 卡片一律是「浅色面板 + 发丝线 + 极轻投影」，强调色只有品牌色一种，
 * 状态色只用来标"需要你出手 / 失败"，不参与装饰。
 */
/**
 * 强调色写死成 iOS 蓝：主题的 brand-primary 在部分主题里接近白色，
 * 直接用它会出现「白底白字」的过曝按钮/链接。
 */
const ACCENT = '#0a84ff';
const HAIRLINE = 'var(--dsw-alias-border-l1, rgba(60,60,67,.12))';
const TEXT_1 = 'var(--dsw-alias-label-primary, #1c1c1e)';
const TEXT_2 = 'var(--dsw-alias-label-secondary, #6e6e73)';
const CARD = 'var(--dsw-alias-bg-layer-1, #ffffff)';
const INSET = 'var(--dsw-alias-bg-layer-2, #f2f2f7)';

const S = {
  /* 容器：一整页浅灰底，像备忘录的列表背景 */
  root: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
    color: TEXT_1,
    background: 'var(--dsw-alias-bg-base, #f2f2f7)',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
    WebkitFontSmoothing: 'antialiased',
  },

  /* 顶栏：细线分隔 + 极简按钮，参考备忘录工具栏 */
  topbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '0 18px',
    height: '54px',
    flex: 'none',
    boxSizing: 'border-box',
    background: 'var(--dsw-alias-bg-layer-1, #fff)',
    borderBottom: `0.5px solid ${HAIRLINE}`,
  },
  title: { fontSize: '17px', fontWeight: 700, letterSpacing: '-0.02em' },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    height: '26px',
    padding: '0 10px',
    borderRadius: '7px',
    fontSize: '12px',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    background: INSET,
    color: TEXT_2,
  },

  /* 工具栏按钮：备忘录那种大一号的胶囊按钮 */
  toolBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '30px',
    padding: '0 14px',
    borderRadius: '8px',
    border: `0.5px solid ${HAIRLINE}`,
    background: 'transparent',
    color: TEXT_1,
    fontSize: '13px',
    fontFamily: 'inherit',
    lineHeight: '30px',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  iconBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '30px', height: '30px', borderRadius: '8px', flex: 'none',
    border: `0.5px solid ${HAIRLINE}`, background: 'transparent', color: TEXT_2,
    fontSize: '15px', lineHeight: '28px', cursor: 'pointer', fontFamily: 'inherit',
  },
  toolBtnOn: {
    background: 'var(--dsw-alias-bg-layer-2, rgba(120,120,128,.14))',
    borderColor: 'transparent',
    fontWeight: 600,
  },
  toolBtnPrimary: {
    border: `0.5px solid ${ACCENT}`,
    background: ACCENT,
    color: '#fff',
    fontWeight: 600,
    boxShadow: '0 1px 2px rgba(10,132,255,.28)',
  },
  toolBtnOff: { opacity: 0.45, cursor: 'default' },
  spacer: { flex: '1' },
  hint: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #8e8e93)' },

  canvasWrap: { position: 'relative', flex: '1', minHeight: 0, overflow: 'hidden' },
  canvasScroll: { position: 'absolute', inset: 0, overflow: 'auto', outline: 'none' },
  /* 画布：干净的浅灰，不再铺彩色点阵 */
  canvas: {
    position: 'relative',
    background: 'transparent',
  },

  /* 便签卡：白底、10px 圆角、发丝线、轻投影 */
  note: {
    position: 'absolute',
    boxSizing: 'border-box',
    padding: '12px 14px 10px',
    borderRadius: '12px',
    background: CARD,
    border: `0.5px solid ${HAIRLINE}`,
    boxShadow: '0 1px 2px rgba(0,0,0,.06), 0 6px 18px rgba(0,0,0,.05)',
    userSelect: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    overflow: 'hidden', // 只裁圆角，不设高度上限：内容多高卡片就多高
    transition: 'box-shadow .15s, opacity .2s',
  },
  noteDragging: {
    boxShadow: '0 10px 28px rgba(0,0,0,.18)',
    zIndex: 50,
    cursor: 'grabbing',
  },
  // 已完成的卡不再整体透明（叠在一起会像一层半透明纸），改成浅底 + 灰字
  noteDone: {
    background: 'var(--dsw-alias-bg-layer-2, #f2f2f7)',
    boxShadow: 'none',
    borderColor: 'transparent',
  },

  /* 复选：备忘录/提醒事项那种圆角方框，勾上变品牌色 */
  noteHead: { display: 'flex', alignItems: 'flex-start', gap: '9px' },
  checkbox: {
    flex: 'none',
    width: '18px',
    height: '18px',
    marginTop: '1px',
    borderRadius: '50%',
    border: `1.5px solid var(--dsw-alias-border-l2, rgba(60,60,67,.3))`,
    background: 'transparent',
    cursor: 'pointer',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    transition: 'background .15s, border-color .15s',
  },
  checkboxOn: { background: ACCENT, borderColor: ACCENT },

  noteText: {
    flex: '1',
    minWidth: 0,
    fontSize: '13px',
    lineHeight: '19px',
    letterSpacing: '-0.01em',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: TEXT_1,
    cursor: 'text',
  },
  noteTextDone: { textDecoration: 'line-through', color: 'var(--dsw-alias-label-secondary, #8e8e93)' },
  noteTextInput: {
    flex: '1',
    minWidth: 0,
    fontSize: '13px',
    lineHeight: '19px',
    fontFamily: 'inherit',
    color: TEXT_1,
    background: INSET,
    border: `0.5px solid ${HAIRLINE}`,
    borderRadius: '7px',
    padding: '6px 8px',
    outline: 'none',
    resize: 'none',
    minHeight: '64px',
  },

  /* 底部：只留最必要的操作，发丝线分隔 */
  noteFoot: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    borderTop: `0.5px solid ${HAIRLINE}`,
    paddingTop: '6px',
    fontSize: '11px',
    color: 'var(--dsw-alias-label-secondary, #8e8e93)',
  },
  footBtn: {
    border: '0',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary, #8e8e93)',
    cursor: 'pointer',
    fontSize: '11px',
    padding: '2px 5px',
    borderRadius: '5px',
    lineHeight: '16px',
    fontFamily: 'inherit',
  },

  /* 待办清单（会话导入） */
  todos: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    borderTop: `0.5px solid ${HAIRLINE}`,
    paddingTop: '6px',
  },
  todoRow: { display: 'flex', gap: '6px', alignItems: 'flex-start', fontSize: '11.5px', lineHeight: '16px', color: TEXT_2 },
  todoMark: { flex: 'none', width: '11px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
  todoSummary: {
    marginTop: '3px', fontSize: '10.5px', color: TEXT_2, cursor: 'pointer',
    padding: '2px 0 0 16px', userSelect: 'none',
  },
  todoDone: { textDecoration: 'line-through', opacity: 0.55 },
  todoLink: {
    flex: '1', minWidth: 0, textAlign: 'left', padding: 0, margin: 0,
    border: '0', background: 'transparent', font: 'inherit', cursor: 'pointer',
    color: ACCENT, textDecoration: 'none',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  actionBtn: {
    border: `0.5px solid ${HAIRLINE}`, background: 'transparent', color: TEXT_2,
    cursor: 'pointer', fontSize: '10.5px', lineHeight: '16px', padding: '1px 7px',
    borderRadius: '999px', fontFamily: 'inherit', whiteSpace: 'nowrap',
  },
  actionBtnPrimary: { color: ACCENT, borderColor: ACCENT },
  actionBtnDanger: { color: 'var(--dsw-alias-state-error-primary, #ff3b30)', borderColor: 'var(--dsw-alias-state-error-primary, #ff3b30)' },
  reviewBadge: {
    display: 'inline-flex', alignItems: 'center', gap: '3px',
    fontSize: '10px', padding: '1px 6px', borderRadius: '999px',
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #34c759) 16%, transparent)',
    color: 'var(--dsw-alias-state-success-primary, #34c759)',
    cursor: 'pointer',
  },
  cancelledBadge: {
    fontSize: '10px', padding: '1px 6px', borderRadius: '999px',
    background: INSET, color: 'var(--dsw-alias-label-secondary, #8e8e93)',
  },
  sourceLink: {
    fontSize: '10.5px', padding: 0, margin: 0, border: '0', background: 'transparent',
    font: 'inherit', cursor: 'pointer', color: ACCENT,
    maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  todoDoing: { fontWeight: 600, color: TEXT_1 },

  /* 进展记录 */
  updates: { display: 'flex', flexDirection: 'column', gap: '2px' },
  historyBox: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    borderTop: `0.5px solid ${HAIRLINE}`, paddingTop: '5px', maxHeight: '150px', overflowY: 'auto',
  },
  historyLine: { display: 'flex', gap: '6px', fontSize: '10.5px', lineHeight: '15px', color: 'var(--dsw-alias-label-secondary, #8e8e93)' },
  stageRow: {
    display: 'flex', gap: '6px', alignItems: 'baseline',
    fontSize: '10.5px', lineHeight: '15px', color: 'var(--dsw-alias-label-primary, #1c1c1e)',
    paddingBottom: '3px', marginBottom: '3px', borderBottom: `0.5px dashed ${HAIRLINE}`,
  },
  historyTime: { flex: 'none', fontVariantNumeric: 'tabular-nums', opacity: 0.75 },
  updateLine: { display: 'flex', gap: '6px', fontSize: '11px', lineHeight: '16px', color: TEXT_2 },
  updateDot: { flex: 'none', width: '3px', height: '3px', borderRadius: '50%', background: 'var(--dsw-alias-border-l2, #c7c7cc)', marginTop: '6px' },
  updateText: { flex: '1', minWidth: 0, wordBreak: 'break-word' },
  updateInput: {
    width: '100%',
    boxSizing: 'border-box',
    fontSize: '11.5px',
    fontFamily: 'inherit',
    color: TEXT_1,
    background: INSET,
    border: `0.5px solid ${HAIRLINE}`,
    borderRadius: '7px',
    padding: '5px 8px',
    outline: 'none',
  },

  /* 来源标记 */
  sourceLine: {
    fontSize: '10.5px',
    color: 'var(--dsw-alias-label-secondary, #8e8e93)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '150px',
  },

  /* 空状态 */
  empty: {
    position: 'absolute',
    left: '50%',
    top: '44%',
    transform: 'translate(-50%, -50%)',
    textAlign: 'center',
    color: 'var(--dsw-alias-label-secondary, #8e8e93)',
    fontSize: '12.5px',
    lineHeight: '22px',
    pointerEvents: 'none',
  },
  emptyTitle: { fontSize: '15px', fontWeight: 600, color: TEXT_2, marginBottom: '4px', letterSpacing: '-0.01em' },

  /* 右下角新建 */
  fab: {
    position: 'absolute',
    right: '20px',
    bottom: '20px',
    width: '46px',
    height: '46px',
    borderRadius: '23px',
    border: '0',
    background: ACCENT,
    color: '#fff',
    fontSize: '24px',
    lineHeight: '43px',
    cursor: 'pointer',
    boxShadow: '0 4px 16px rgba(0,0,0,.18)',
    zIndex: 20,
  },
  trash: {
    position: 'absolute',
    right: '20px',
    bottom: '20px',
    width: '46px',
    height: '46px',
    borderRadius: '23px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: `1.5px dashed var(--dsw-alias-border-l2, rgba(60,60,67,.3))`,
    background: CARD,
    zIndex: 21,
    transition: 'transform .12s, background .12s',
  },
  trashHot: {
    background: 'var(--dsw-alias-state-error-primary, #ff3b30)',
    borderColor: 'var(--dsw-alias-state-error-primary, #ff3b30)',
    transform: 'scale(1.08)',
  },

  error: {
    position: 'absolute',
    left: '50%',
    top: '12px',
    transform: 'translateX(-50%)',
    padding: '6px 12px',
    borderRadius: '8px',
    background: 'var(--dsw-alias-bg-overlay, #fff)',
    color: 'var(--dsw-alias-state-error-primary, #ff3b30)',
    fontSize: '11.5px',
    boxShadow: '0 4px 14px rgba(0,0,0,.12)',
    zIndex: 30,
  },
  loading: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--dsw-alias-label-secondary, #8e8e93)', fontSize: '12.5px',
  },

  /* 出错兜底 */
  crash: {
    height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: '10px', padding: '24px', boxSizing: 'border-box', textAlign: 'center',
    color: TEXT_1, background: 'var(--dsw-alias-bg-base, #f2f2f7)',
  },
  crashTitle: { fontSize: '14px', fontWeight: 600 },
  crashMsg: {
    fontSize: '12px', lineHeight: '18px', maxWidth: '520px', wordBreak: 'break-word',
    color: TEXT_2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  crashBtn: {
    height: '30px', padding: '0 14px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px',
    border: `0.5px solid ${HAIRLINE}`, background: CARD, color: TEXT_1, fontFamily: 'inherit',
  },

  /* 简报卡：同一种卡片语言，靠层次区分，不用彩色描边 */
  brief: {
    position: 'absolute', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '10px',
    padding: '14px 16px 14px', borderRadius: '14px',
    background: CARD,
    border: `0.5px solid ${HAIRLINE}`,
    boxShadow: '0 1px 2px rgba(0,0,0,.06), 0 8px 22px rgba(0,0,0,.06)',
    color: TEXT_1,
    cursor: 'grab', userSelect: 'none',
  },
  briefHead: { display: 'flex', alignItems: 'baseline', gap: '8px' },
  briefTitle: { fontSize: '14px', fontWeight: 700, letterSpacing: '-0.01em' },
  briefMeta: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #8e8e93)' },
  briefScroll: { display: 'flex', flexDirection: 'column', gap: '2px' },
  briefSection: { display: 'flex', flexDirection: 'column', gap: '3px', padding: '9px 0', borderTop: `0.5px solid ${HAIRLINE}` },
  briefSectionTitle: {
    fontSize: '11px', fontWeight: 600, letterSpacing: '0',
    color: 'var(--dsw-alias-label-secondary, #8e8e93)',
  },
  briefLine: { fontSize: '12.5px', lineHeight: '18px', wordBreak: 'break-word' },
  briefItem: {
    display: 'flex', flexDirection: 'column', gap: '1px',
    padding: '4px 0 4px 9px', borderLeft: `2px solid var(--dsw-alias-border-l2, rgba(60,60,67,.18))`,
    marginTop: '3px',
  },
  briefItemTitle: { fontSize: '12.5px', fontWeight: 600, lineHeight: '18px' },
  briefItemLink: {
    padding: 0, margin: 0, border: '0', background: 'transparent', font: 'inherit',
    fontSize: '12.5px', fontWeight: 600, lineHeight: '18px', textAlign: 'left',
    color: ACCENT, cursor: 'pointer',
  },
  briefItemLine: { fontSize: '11.5px', lineHeight: '16px', color: TEXT_2 },

  /* 设置面板：像系统弹层 */
  settingsPanel: {
    position: 'absolute', right: '16px', top: '52px', zIndex: 60, width: '280px',
    display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px 16px',
    borderRadius: '12px', background: 'var(--dsw-alias-bg-overlay, #fff)',
    border: `0.5px solid ${HAIRLINE}`,
    boxShadow: '0 12px 40px rgba(0,0,0,.18)', fontSize: '12px',
    fontFamily: 'inherit',
  },
  settingsRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' },
  settingsLabel: { color: TEXT_2, fontSize: '12px' },
  settingsInput: {
    width: '112px', height: '26px', padding: '0 8px', boxSizing: 'border-box',
    borderRadius: '7px', border: `0.5px solid ${HAIRLINE}`,
    background: INSET, color: TEXT_1, fontSize: '12px', fontFamily: 'inherit',
  },
  settingsHint: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-secondary, #8e8e93)' },

  tabs: {
    display: 'flex', gap: '2px', padding: '3px', borderRadius: '10px',
    background: 'var(--dsw-alias-bg-layer-2, rgba(120,120,128,.10))', flex: 'none',
  },
  tab: {
    height: '30px', padding: '0 16px', border: '0', borderRadius: '8px', cursor: 'pointer',
    background: 'transparent', color: 'var(--dsw-alias-label-secondary, #8e8e93)',
    fontSize: '13px', fontFamily: 'inherit', lineHeight: '30px', fontWeight: 500,
  },
  tabActive: {
    background: CARD, color: TEXT_1, fontWeight: 600,
    boxShadow: '0 1px 2px rgba(0,0,0,.10)',
  },
  pageScroll: { position: 'relative', flex: '1', minHeight: 0, overflowY: 'auto' },
  pageInner: {
    maxWidth: '780px', margin: '0 auto', padding: '28px 28px 90px',
    display: 'flex', flexDirection: 'column', gap: '14px',
  },
  pageHead: { display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap', marginBottom: '4px' },
  pageKicker: { fontSize: '11px', letterSpacing: '.3px', color: 'var(--dsw-alias-label-secondary, #8e8e93)', marginBottom: '2px' },
  pageTitle: { margin: 0, fontSize: '22px', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: '28px' },
  pageMeta: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary, #8e8e93)' },
  pageSelect: {
    height: '28px', padding: '0 8px', borderRadius: '7px', border: `0.5px solid ${HAIRLINE}`,
    background: INSET, color: TEXT_1, fontSize: '12px', fontFamily: 'inherit',
  },
  pageSection: { display: 'flex', flexDirection: 'column', gap: '5px', paddingTop: '14px', borderTop: `0.5px solid ${HAIRLINE}` },
  pageSectionTitle: { fontSize: '11.5px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary, #8e8e93)' },
  pageLine: { fontSize: '13.5px', lineHeight: '21px', wordBreak: 'break-word' },
  pageItem: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    padding: '7px 0 7px 12px', borderLeft: `2px solid var(--dsw-alias-border-l2, rgba(60,60,67,.18))`,
    marginTop: '4px',
  },
  pageItemTitle: { fontSize: '13.5px', fontWeight: 600, lineHeight: '20px' },
  pageItemLine: { fontSize: '12.5px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #6e6e73)' },
  pageEmpty: {
    flex: '1', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: '6px', textAlign: 'center',
  },
  /* 诊断抽屉 */
  diagPanel: {
    position: 'absolute', top: '56px', right: '14px', zIndex: 42, width: '420px', maxHeight: '70%',
    display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 14px',
    borderRadius: '12px', background: CARD, border: `0.5px solid ${HAIRLINE}`,
    boxShadow: '0 12px 32px rgba(0,0,0,.18)', overflow: 'hidden',
  },
  diagPre: {
    margin: 0, padding: '10px', borderRadius: '8px', background: INSET,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '10.5px',
    lineHeight: '15px', color: TEXT_1, overflow: 'auto', whiteSpace: 'pre-wrap',
  },

  /* 功能菜单 */
  menuOverlay: { position: 'fixed', inset: '0', zIndex: 40 },
  menu: {
    position: 'absolute', top: '56px', left: '14px', zIndex: 41,
    width: '280px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '2px',
    borderRadius: '12px', background: CARD, border: `0.5px solid ${HAIRLINE}`,
    boxShadow: '0 12px 32px rgba(0,0,0,.18)',
  },
  menuTitle: { fontSize: '10.5px', color: TEXT_2, padding: '4px 8px 6px', letterSpacing: '.04em' },
  menuRow: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px',
    padding: '7px 8px', borderRadius: '8px', border: '0', background: 'transparent',
    textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', width: '100%',
  },
  menuRowOn: { background: 'var(--dsw-alias-bg-layer-2, rgba(120,120,128,.12))' },
  menuRowLabel: { fontSize: '12.5px', color: TEXT_1, fontWeight: 500 },
  menuRowHint: { fontSize: '10.5px', color: TEXT_2 },
  menuSep: { height: '0.5px', background: HAIRLINE, margin: '4px 6px' },

  /* 本周页 */
  weekScroll: { position: 'relative', flex: '1', minHeight: 0, overflowY: 'auto' },
  weekInner: { maxWidth: '780px', margin: '0 auto', padding: '26px 28px 80px', display: 'flex', flexDirection: 'column', gap: '18px' },
  weekHead: { display: 'flex', alignItems: 'baseline', gap: '10px' },
  weekTitle: { fontSize: '22px', fontWeight: 700, letterSpacing: '-0.02em' },
  weekRange: { fontSize: '11.5px', color: TEXT_2 },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px' },
  tile: {
    display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px 16px',
    borderRadius: '14px', background: CARD, border: `0.5px solid ${HAIRLINE}`,
    boxShadow: '0 1px 2px rgba(0,0,0,.05)',
  },
  tileLabel: { fontSize: '11.5px', color: TEXT_2 },
  tileValue: { fontSize: '26px', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: '32px', fontVariantNumeric: 'tabular-nums' },
  tileDelta: { fontSize: '11px', color: TEXT_2 },
  tileTrack: { height: '6px', borderRadius: '3px', background: 'var(--dsw-alias-bg-layer-2, rgba(120,120,128,.16))', overflow: 'hidden' },
  tileFill: { height: '100%', borderRadius: '3px', transition: 'width .5s cubic-bezier(.22,.61,.36,1)' },
  chartCard: {
    display: 'flex', flexDirection: 'column', gap: '10px', padding: '16px 18px 12px',
    borderRadius: '14px', background: CARD, border: `0.5px solid ${HAIRLINE}`,
  },
  chartTitle: { fontSize: '12px', fontWeight: 600 },
  chart: { display: 'flex', alignItems: 'flex-end', gap: '10px', height: '112px' },
  chartCol: { flex: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', height: '100%', justifyContent: 'flex-end' },
  chartBar: { width: '100%', maxWidth: '34px', borderRadius: '6px 6px 3px 3px', background: 'var(--dsw-alias-fill-l2, rgba(120,120,128,.22))', transition: 'height .5s cubic-bezier(.22,.61,.36,1)' },
  chartBarToday: { background: ACCENT },
  chartLabel: { fontSize: '10.5px', color: TEXT_2 },
  cheer: {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px',
    borderRadius: '14px', background: 'color-mix(in srgb, ' + ACCENT + ' 10%, transparent)',
    color: TEXT_1, fontSize: '13px',
  },
  doneList: { display: 'flex', flexDirection: 'column', gap: '2px' },
  doneRow: { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '12px', color: TEXT_1 },
  doneWhen: { fontSize: '10.5px', color: TEXT_2, flex: 'none', fontVariantNumeric: 'tabular-nums' },
  progress: {
    position: 'absolute', left: '50%', top: '14px', transform: 'translateX(-50%)',
    display: 'flex', flexDirection: 'column', gap: '5px', minWidth: '260px',
    padding: '8px 14px', borderRadius: '10px', zIndex: 45,
    background: 'var(--dsw-alias-bg-overlay, #fff)', color: TEXT_1,
    border: `0.5px solid ${HAIRLINE}`, boxShadow: '0 8px 26px rgba(0,0,0,.16)',
    fontSize: '11.5px',
  },
  progressRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  progressTrack: {
    height: '3px', borderRadius: '2px', overflow: 'hidden',
    background: 'var(--dsw-alias-bg-layer-2, rgba(120,120,128,.16))',
  },
  progressFill: {
    height: '100%', background: ACCENT, borderRadius: '2px',
    transition: 'width .2s ease-out',
  },
  spinner: {
    width: '10px', height: '10px', borderRadius: '50%', flex: 'none',
    border: `1.5px solid ${HAIRLINE}`, borderTopColor: ACCENT,
    animation: 'wb-spin .8s linear infinite',
  },
  draftModal: {
    position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 70,
    width: '460px', maxWidth: '86%', display: 'flex', flexDirection: 'column', gap: '10px',
    padding: '14px 16px', borderRadius: '12px', background: 'var(--dsw-alias-bg-overlay, #fff)',
    border: `0.5px solid ${HAIRLINE}`, boxShadow: '0 16px 48px rgba(0,0,0,.22)', color: TEXT_1,
  },
  draftArea: {
    width: '100%', height: '220px', resize: 'vertical', boxSizing: 'border-box',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11.5px', lineHeight: '17px',
    padding: '8px 10px', borderRadius: '8px', border: `0.5px solid ${HAIRLINE}`,
    background: INSET, color: TEXT_1, outline: 'none',
  },
  toast: {
    position: 'absolute', left: '50%', bottom: '26px', transform: 'translateX(-50%)',
    padding: '8px 14px', borderRadius: '10px', zIndex: 40,
    background: 'var(--dsw-alias-bg-overlay, #fff)', color: TEXT_1,
    boxShadow: '0 8px 26px rgba(0,0,0,.16)', fontSize: '12px', whiteSpace: 'nowrap',
    border: `0.5px solid ${HAIRLINE}`,
  },
};

/* ── API ───────────────────────────────────────────────── */

function createApi() {
  const token = (typeof globalThis !== 'undefined' && globalThis.__WORKBENCH_TOKEN__) || '';
  const rawHeaders = () => (token ? { 'X-Workbench-Token': token } : {});

  async function req(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Workbench-Token'] = token;
    const res = await fetch(`${API}${path}`, body === undefined
      ? { method: 'GET', headers, cache: 'no-store' }
      : { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }

  return {
    get: () => req('/board'),
    importSessions: () => req('/import', {}),
    refreshSession: (sessionId) => req('/import', { sessionIds: [sessionId] }),
    sessions: () => req('/sessions'),
    generateBrief: (sinceHours) => req('/brief', { sinceHours: sinceHours || 24 }),
    getSettings: () => req('/settings'),
    getCumulative: () => req('/cumulative'),
    getWeekly: () => req('/weekly'),
    getDiag: () => req('/diag'),
    getBriefs: () => req('/briefs'),
    getBrief: (date) => req(`/brief?date=${encodeURIComponent(date)}`),
    exportNote: async (id) => {
      const res = await fetch(`${API}/note/export?id=${encodeURIComponent(id)}`, { headers: rawHeaders(), cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    layout: (positions) => req('/layout', { positions }),
    adoptSession: (id, cwd) => req('/session/adopt', { id, cwd }),
    progress: () => req('/progress'),
    saveSettings: (patch) => req('/settings', patch),
    addNote: (input) => req('/note', input),
    updateNote: (input) => req('/note/update', input),
    setDone: (id, done) => req('/note/done', { id, done }),
    deleteNote: (id) => req('/note/delete', { id }),
    addProgress: (id, text) => req('/note/update-log', { id, text }),
    deleteProgress: (id, updateId) => req('/note/update-log', { id, updateId, delete: true }),
  };
}

/** 简报里每种语气对应的颜色。 */
const TONE = {
  strong: { fontWeight: 600 },
  ok: { color: 'var(--dsw-alias-state-success-primary, #34c759)' },
  warn: { color: 'var(--dsw-alias-state-warn-primary, #ff9f0a)' },
  bad: { color: 'var(--dsw-alias-state-error-primary, #ff3b30)' },
  muted: { color: 'var(--dsw-alias-label-secondary, #8e8e93)' },
  normal: {},
};

/**
 * 问宿主：这个会话 id 的哪种写法是真的？（返回 null = 会话不存在）
 * 跳转前用它换成宿主/UI 认的写法，避免开出空白线程。
 */
async function resolveSessionIdViaHost(id) {
  const token = (typeof globalThis !== 'undefined' && globalThis.__WORKBENCH_TOKEN__) || '';
  const res = await fetch(`${API}/session/resolve?id=${encodeURIComponent(id)}`, {
    headers: token ? { 'X-Workbench-Token': token } : {},
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.id) return null;
  return {
    id: String(data.id),
    listed: data.listed === true,
    workspace: String(data.workspace ?? ''),
    cwd: String(data.cwd ?? ''),
    title: String(data.title ?? ''),
  };
}

/* ── 工具 ──────────────────────────────────────────────── */

/** token 缩写：12.3k / 1.24M */
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()}`;
}

/* ── 复选框对勾图标 ───────────────────────────────────── */

function checkSvg(React, size = 11) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true',
  }, React.createElement('path', {
    d: 'M2 6.2 4.6 8.8 10 3.2',
    stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round',
  }));
}

function trashSvg(React, color) {
  return React.createElement('svg', {
    width: 18, height: 18, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
  },
  React.createElement('path', {
    d: 'M3 4.5h10M6.3 4.5V3.2h3.4v1.3M4.4 4.5l.6 8.2h6l.6-8.2M6.6 7v3.4M9.4 7v3.4',
    stroke: color, strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
  }));
}

/** 侧边栏小图标：一张贴了便签的板。 */
function makeIcon(React) {
  const h = React.createElement;
  return function WorkbenchIcon({ size = 16 }) {
    return h('svg', {
      width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
    },
    h('rect', { x: 1.8, y: 2.6, width: 12.4, height: 10.8, rx: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
    h('rect', { x: 4, y: 5, width: 3.4, height: 3.4, rx: 0.8, fill: 'currentColor', opacity: 0.75 }),
    h('rect', { x: 8.6, y: 5, width: 3.4, height: 3.4, rx: 0.8, fill: 'currentColor', opacity: 0.45 }),
    h('path', { d: 'M4 10.9h7.9', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', opacity: 0.6 }));
  };
}

/* ── 单张便签 ──────────────────────────────────────────── */

function makeNote(React, api, onBoard) {
  const h = React.createElement;

  return function Note({ note, drag, onDragStart, onDelete, dragHot, autoEdit, onOpenSession, onRefresh, onCancel, onContinue, onExport }) {
    const [editing, setEditing] = React.useState(false);
    const [draft, setDraft] = React.useState(note.text);
    const [addingProgress, setAddingProgress] = React.useState(false);
    const [progressDraft, setProgressDraft] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [hover, setHover] = React.useState(false);
    const [showHistory, setShowHistory] = React.useState(false);
    /** 待办默认只铺开未完成的 3 条，点「展开」才看全部。 */
    const [showAllTodos, setShowAllTodos] = React.useState(false);

    const run = React.useCallback(async (fn) => {
      setBusy(true);
      try {
        const data = await fn();
        if (data?.board) onBoard(data);
      } finally {
        setBusy(false);
      }
    }, [onBoard]);

    const dragging = drag?.id === note.id;

    // 刚新建的便签直接进编辑态，省一次双击
    React.useEffect(() => {
      if (!autoEdit) return;
      setDraft(note.text === '新便签' ? '' : note.text);
      setEditing(true);
    }, [autoEdit]);

    const toggleDone = (e) => {
      e.stopPropagation();
      if (busy) return;
      run(() => api.setDone(note.id, !note.done));
    };

    const saveText = () => {
      const text = draft.trim();
      setEditing(false);
      if (!text) {
        // 新建后啥也没写就点走：别留一张叫“新便签”的空卡，直接丢掉
        if (autoEdit) { run(() => api.deleteNote(note.id)); return; }
        setDraft(note.text);
        return;
      }
      if (text === note.text) { setDraft(note.text); return; }
      run(() => api.updateNote({ id: note.id, text }));
    };

    const submitProgress = () => {
      const text = progressDraft.trim();
      if (!text) { setAddingProgress(false); return; }
      setProgressDraft('');
      setAddingProgress(false);
      run(() => api.addProgress(note.id, text));
    };

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      if (editing || addingProgress) return;
      const target = e.target;
      if (target && (target.closest?.('button') || target.closest?.('textarea') || target.closest?.('input'))) return;
      onDragStart(e, note.id);
    };

    const lastUpdate = note.updates[note.updates.length - 1];

    const pos = dragging ? { x: drag.x, y: drag.y } : { x: note.x, y: note.y };

    return h('div', {
      'data-note-id': note.id,
      style: {
        ...S.note,
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        width: `${NOTE_W}px`,
        minHeight: '96px',
        ...(dragging ? S.noteDragging : {}),
        ...(note.done || note.cancelled ? S.noteDone : {}),
        ...(note.cancelled ? { opacity: 0.75 } : {}),
        ...(dragHot && dragging ? { outline: '2px solid var(--dsw-alias-state-error-primary, #ff3b30)' } : {}),
      },
      onPointerDown,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
    },
    ((note.stages ?? []).length > 1 && !note.cancelled)
      ? h('span', {
        style: { ...S.cancelledBadge, alignSelf: 'flex-start' },
        title: `这个线程里连着做了 ${note.stages.length} 个任务；点「历史」看每个阶段的清单`,
      }, `第 ${note.stages.length} 个任务`)
      : null,
    (note.review && !note.done && !note.cancelled)
      ? h('button', {
        type: 'button',
        style: { ...S.reviewBadge, alignSelf: 'flex-start' },
        title: '这个线程刚跑完一轮，点一下标记验收完成',
        onPointerDown: (e) => e.stopPropagation(),
        onClick: (e) => { e.stopPropagation(); run(() => api.setDone(note.id, true)); },
      }, '● 待验收')
      : null,
    h('div', { style: S.noteHead },
      h('button', {
        type: 'button',
        style: { ...S.checkbox, ...(note.done ? S.checkboxOn : {}) },
        title: note.done ? '取消完成' : '做完，勾掉',
        'aria-label': note.done ? '取消完成' : '标记为完成',
        disabled: busy,
        onClick: toggleDone,
      }, note.done && !note.cancelled ? checkSvg(React) : null),
      editing
        ? h('textarea', {
          style: S.noteTextInput,
          value: draft,
          autoFocus: true,
          onChange: (e) => setDraft(e.target.value),
          onBlur: saveText,
          onKeyDown: (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') { setDraft(note.text); setEditing(false); }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveText(); }
          },
        })
        : h('div', {
          style: { ...S.noteText, ...(note.done ? S.noteTextDone : {}) },
          role: 'textbox',
          tabIndex: 0,
          title: '双击改内容 · 按住拖动整张卡',
          onDoubleClick: () => { setDraft(note.text); setEditing(true); },
          onKeyDown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); setDraft(note.text); setEditing(true); }
          },
        }, note.text)),

    (note.todos ?? []).length
      ? (() => {
        const allTodos = note.todos ?? [];
        const openTodos = allTodos.filter((t) => t.status !== 'completed');
        const shownTodos = showAllTodos ? allTodos : openTodos.slice(0, 3);
        const doneCount = allTodos.length - openTodos.length;
        const rest = Math.max(0, openTodos.length - shownTodos.length);
        return h('div', { style: S.todos },
          shownTodos.map((t, i) => {
            const openable = Boolean(note.source?.id) && t.status !== 'completed';
            const done = t.status === 'completed';
            const label = h('span', {
              style: {
                flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                ...(done ? S.todoDone : {}),
                ...(t.status === 'in_progress' ? S.todoDoing : {}),
              },
            }, t.content);
            return h('div', { key: `${note.id}-t${i}`, style: S.todoRow },
              h('span', { style: S.todoMark }, done ? '✓' : t.status === 'in_progress' ? '◐' : '○'),
              openable
                ? h('button', {
                  type: 'button',
                  style: S.todoLink,
                  title: `打开对应线程：${note.source?.title ?? ''}`,
                  onPointerDown: (e) => e.stopPropagation(),
                  onClick: (e) => { e.stopPropagation(); onOpenSession?.(note.source.id); },
                }, label)
                : label);
          }),
          (rest > 0 || doneCount > 0)
            ? h('div', {
              'data-todo-summary': '1',
              style: S.todoSummary,
              title: showAllTodos ? '收起已完成的条目' : '展开全部待办（含已完成）',
              onPointerDown: (e) => e.stopPropagation(),
              onClick: (e) => { e.stopPropagation(); setShowAllTodos((v) => !v); },
            }, [
              rest > 0 ? `还有 ${rest} 项没做` : '',
              doneCount > 0 ? `已完成 ${doneCount}` : '',
              showAllTodos ? '收起 ▴' : '展开 ▾',
            ].filter(Boolean).join(' · '))
            : null);
      })()
      : null,

    note.updates.length
      ? h('div', { style: S.updates },
        note.updates.slice(-4).map((u) => h('div', { key: u.id, style: S.updateLine },
          h('span', { style: S.updateDot }),
          h('span', { style: S.updateText },
            h('span', { style: { opacity: 0.65, marginRight: '4px' } }, fmtTime(u.at)),
            u.text))))
      : null,

    addingProgress
      ? h('input', {
        style: S.updateInput,
        value: progressDraft,
        autoFocus: true,
        placeholder: '记一笔进展，回车保存',
        onChange: (e) => setProgressDraft(e.target.value),
        onBlur: submitProgress,
        onKeyDown: (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); submitProgress(); }
          if (e.key === 'Escape') { setProgressDraft(''); setAddingProgress(false); }
        },
        onPointerDown: (e) => e.stopPropagation(),
      })
      : null,

    showHistory
      ? h('div', { style: S.historyBox, onPointerDown: (e) => e.stopPropagation() },
        (note.stages ?? []).length > 1
          ? (note.stages ?? []).map((st, i) => {
            const done = (st.items ?? []).filter((it) => it.status === 'completed').length;
            const total = (st.items ?? []).length;
            return h('div', { key: `st${i}`, style: S.stageRow },
              h('span', { style: S.historyTime }, fmtTime(st.at)),
              h('span', { style: { fontWeight: 600 } }, `第 ${i + 1} 个任务 · ${done}/${total}`),
              h('span', { style: { opacity: 0.85 } }, (st.items?.[0]?.content ?? '').slice(0, 24)));
          })
          : null,
        (note.history ?? []).length
          ? (note.history ?? []).slice(-12).reverse().map((h, i) => h('div', { key: `h${i}`, style: S.historyLine },
            h('span', { style: S.historyTime }, fmtTime(h.at)),
            h('span', null, h.text || h.kind)))
          : h('div', { style: S.historyLine }, '还没有变更记录'),
        note.historyTruncated ? h('div', { style: { ...S.historyLine, opacity: 0.6 } }, '（更早的记录已丢弃）') : null)
      : null,

    h('div', { style: S.noteFoot, onPointerDown: (e) => e.stopPropagation() },
      h('button', {
        type: 'button',
        style: S.footBtn,
        title: '追加一条进展',
        disabled: busy,
        onClick: () => setAddingProgress(true),
      }, note.updates.length ? '＋ 进展' : '＋ 记进展'),
      h('span', { style: S.spacer }),
      (note.source
        ? h('button', {
          type: 'button',
          style: S.sourceLink,
          title: `打开对应线程：${note.source.title}${note.source.workspace ? ` · ${note.source.workspace}` : ''}`,
          onPointerDown: (e) => e.stopPropagation(),
          onClick: (e) => { e.stopPropagation(); onOpenSession?.(note.source.id); },
        }, `${note.source.workspace || note.source.title}`)
        : h('span', { style: { opacity: 0.85 } }, note.done ? `完成于 ${fmtTime(note.doneAt)}` : (lastUpdate ? '' : `建于 ${fmtTime(note.createdAt)}`))),
      note.source
        ? (note.cancelled
          ? h('button', {
            type: 'button',
            style: S.actionBtn,
            title: '把这个任务恢复到看板',
            onPointerDown: (e) => e.stopPropagation(),
            onClick: (e) => { e.stopPropagation(); onCancel?.(note, false); },
          }, '恢复')
          : h('span', { style: { display: 'flex', gap: '4px' }, onPointerDown: (e) => e.stopPropagation() },
            h('button', {
              type: 'button',
              style: { ...S.actionBtn, ...S.actionBtnPrimary },
              title: '打开这个线程的对话',
              onClick: (e) => { e.stopPropagation(); onOpenSession?.(note.source.id); },
            }, '打开线程'),
            h('button', {
              type: 'button',
              style: S.actionBtn,
              title: '复制续做草稿（目标/未完成/进展/产出）并打开这个线程',
              onClick: (e) => { e.stopPropagation(); onContinue?.(note); },
            }, '继续'),
            h('button', {
              type: 'button',
              style: S.actionBtn,
              title: '重新拉取这个线程的待办',
              disabled: busy,
              onClick: (e) => { e.stopPropagation(); onRefresh?.(note); },
            }, '刷新'),
            h('button', {
              type: 'button',
              style: { ...S.actionBtn, ...S.actionBtnDanger },
              title: '放弃这个任务（不计入没做完，以后拉取也不会回来）',
              disabled: busy,
              onClick: (e) => { e.stopPropagation(); onCancel?.(note, true); },
            }, '取消')))
        : null,
      h('button', {
        type: 'button',
        style: S.footBtn,
        title: '看这张卡改过什么',
        onClick: (e) => { e.stopPropagation(); setShowHistory((v) => !v); },
      }, showHistory ? '收起历史' : `历史 ${(note.history ?? []).length}`),
      h('button', {
        type: 'button',
        style: S.footBtn,
        title: '导出这张卡（Markdown，含历史）',
        onClick: (e) => { e.stopPropagation(); onExport?.(note); },
      }, '导出'),
      h('button', {
        type: 'button',
        style: S.footBtn,
        title: '删除这张便签',
        disabled: busy,
        onClick: () => run(() => api.deleteNote(note.id)),
      }, '×')));
  };
}

/* ── 错误边界：面板出错时显示原因，而不是让整页黑掉 ────── */

function makeBoundary(React) {
  const h = React.createElement;
  return class Boundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
      return { error };
    }

    componentDidCatch(error, info) {
      // 带上组件栈，方便出问题时定位
      console.error('[workbench] 面板渲染出错', error, info?.componentStack ?? '');
    }

    render() {
      if (this.state.error) {
        return h('div', { style: S.crash },
          h('div', { style: S.crashTitle }, 'DSH 助理出错了'),
          h('div', { style: S.crashMsg }, String(this.state.error?.message ?? this.state.error)),
          h('button', {
            type: 'button',
            style: S.crashBtn,
            onClick: () => this.setState({ error: null }),
          }, '重试'));
      }
      return this.props.children;
    }
  };
}

/* ── 简报页（和便签画布分开的两个页面） ─────────────── */

/**
 * 简报不再放画布：它是一整页可读的报告，便签铺在另一页。
 * 这样永远不会出现「便签压住汇总」。
 */
function makeBriefPage(React) {
  const h = React.createElement;

  function renderItem(item, j, openable) {
    return h('div', { key: `i${j}`, style: S.pageItem },
      openable && item.sessionId
        ? h('button', {
          type: 'button',
          style: { ...S.briefItemLink, fontSize: '13.5px', lineHeight: '20px' },
          title: `打开对应线程：${item.title}`,
          onClick: () => openable(item.sessionId),
        }, item.title)
        : h('div', { style: S.pageItemTitle }, item.title),
      (item.lines ?? []).map((line, k) => h('div', {
        key: `il${k}`,
        style: { ...S.pageItemLine, ...(TONE[line.tone] ?? {}) },
      }, line.text)));
  }

  function renderSection(section, i, openable) {
    const titleTone = section.tone === 'warn'
      ? { color: 'var(--dsw-alias-state-warn-primary, #ff9f0a)' }
      : section.tone === 'ok'
        ? { color: 'var(--dsw-alias-state-success-primary, #34c759)' }
        : {};
    return h('section', { key: `s${i}`, style: S.pageSection },
      h('div', { style: { ...S.pageSectionTitle, ...titleTone } }, section.title),
      (section.lines ?? []).map((line, j) => h('div', {
        key: `l${j}`,
        style: { ...S.pageLine, ...(TONE[line.tone] ?? {}) },
      }, line.text)),
      (section.items ?? []).map((item, j) => renderItem(item, j, openable)));
  }

  return function BriefPage({ brief, history, onPick, onGenerate, busy, onOpenSession }) {
    if (!brief) {
      return h('div', { style: S.pageEmpty },
        h('div', { style: { fontSize: '15px', fontWeight: 600 } }, '还没有简报'),
        h('div', { style: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary, #8e8e93)' } }, '点右上角「生成简报」，或等每天到点自动生成。'),
        h('button', {
          type: 'button',
          style: { ...S.crashBtn, marginTop: '10px' },
          disabled: busy,
          onClick: onGenerate,
        }, busy ? '生成中…' : '生成简报'));
    }

    const gen = brief.generatedAt ? fmtTime(brief.generatedAt) : '';
    const totals = brief.totals;

    return h('div', { 'data-page': 'brief', style: S.pageScroll },
      h('div', { style: S.pageInner },
        h('div', { style: S.pageHead },
          h('div', null,
            h('div', { style: S.pageKicker }, '助理简报'),
            h('h1', { style: S.pageTitle }, brief.date ?? ''),
            h('div', { style: S.pageMeta }, gen ? `生成于 ${gen}` : '')),
          h('span', { style: S.spacer }),
          history?.length
            ? h('select', {
              style: S.pageSelect,
              value: brief.date ?? '',
              onChange: (e) => onPick?.(e.target.value),
            }, history.map((b) => h('option', { key: b.date, value: b.date }, b.date)))
            : null,
          h('button', {
            type: 'button',
            style: { ...S.crashBtn, height: '28px', fontSize: '12px' },
            disabled: busy,
            onClick: onGenerate,
          }, busy ? '生成中…' : '重新生成')),

        (brief.sections ?? []).map((section, i) => renderSection(
          section,
          i,
          onOpenSession ? (id) => { if (id) void onOpenSession(id); } : null,
        )),

        totals
          ? h('div', { style: { ...S.pageMeta, paddingTop: '10px' } },
            `${totals.sessions} 个会话 · ${totals.doing ?? 0} 个在推进 · ${totals.done ?? 0} 个完成 · `
            + `${totals.tokens ? `${fmtTokens(totals.tokens.input + totals.tokens.output + (totals.tokens.cached || 0))} tokens` : ''}`)
          : null));
  };
}

/** 本周看板：三个大数字 + 进度条 + 一周柱状图，给点情绪价值。 */
function makeWeekPage(React) {
  const h = React.createElement;

  /** 本周相对上周的比例，用来画进度条（上周为 0 时：本周有量就算满）。 */
  const ratio = (now, prev) => {
    if (!prev) return now > 0 ? 1 : 0;
    return Math.min(1.6, now / prev);
  };

  function tile({ label, value, unit, now, prev, color }) {
    const pct = ratio(now, prev);
    const delta = prev > 0 ? Math.round(((now - prev) / prev) * 100) : (now > 0 ? 100 : 0);
    const sign = delta > 0 ? '+' : '';
    return h('div', { style: S.tile },
      h('div', { style: S.tileLabel }, label),
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '4px' } },
        h('span', { style: S.tileValue }, value),
        unit ? h('span', { style: { fontSize: '11.5px', color: TEXT_2 } }, unit) : null),
      h('div', { style: { ...S.tileTrack } },
        h('div', { style: { ...S.tileFill, width: `${Math.min(100, Math.round(pct * 100))}%`, background: color } })),
      h('div', { style: S.tileDelta }, prev > 0 ? `较上周 ${sign}${delta}%` : (now > 0 ? '本周新开始' : '本周还没有动静')));
  }

  return function WeekPage({ data, onOpenSession }) {
    if (!data) {
      return h('div', { style: S.pageEmpty }, h('div', { style: { fontSize: '13px', color: TEXT_2 } }, '正在统计本周…'));
    }
    const maxTokens = Math.max(1, ...data.days.map((d) => d.tokens));
    const todayKey = data.days.find((d) => !d.future && d.date === data.days.filter((x) => !x.future).slice(-1)[0]?.date)?.date;
    const deltaDone = data.totals.done - data.lastWeek.done;
    const cheer = data.totals.done > 0
      ? `本周完成了 ${data.totals.done} 个任务${deltaDone > 0 ? `，比上周多 ${deltaDone} 个` : deltaDone < 0 ? `，比上周少 ${Math.abs(deltaDone)} 个` : '，和上周持平'}。`
      : '本周还稳着，动一动第一张卡就有进度了。';

    return h('div', { style: S.weekScroll },
      h('div', { style: S.weekInner },
        h('div', { style: S.weekHead },
          h('div', null,
            h('div', { style: S.pageKicker }, `第 ${data.weekNo} 周`),
            h('div', { style: S.weekTitle }, '本周进度')),
          h('span', { style: S.spacer }),
          h('span', { style: S.weekRange }, `${data.weekStart} → ${data.weekEnd}`)),

        h('div', { style: S.tiles },
          tile({ label: '会话', value: data.totals.sessions, unit: '个', now: data.totals.sessions, prev: data.lastWeek.sessions, color: ACCENT }),
          tile({ label: 'Token', value: fmtTokens(data.totals.tokens), unit: '', now: data.totals.tokens, prev: data.lastWeek.tokens, color: '#34c759' }),
          tile({ label: '完成任务', value: data.totals.done, unit: '个', now: data.totals.done, prev: data.lastWeek.done, color: '#ff9f0a' })),

        h('div', { style: S.cheer }, h('span', null, cheer),
          h('span', { style: S.spacer }),
          h('span', { style: { fontSize: '11.5px', color: TEXT_2 } }, `还有 ${data.totals.open} 张没做完`)),

        h('div', { style: S.chartCard },
          h('div', { style: S.chartTitle }, '每天消耗的 token'),
          h('div', { style: S.chart },
            data.days.map((d) => h('div', { key: d.date, style: S.chartCol },
              h('div', {
                title: `${d.date} · ${fmtTokens(d.tokens)} tokens · ${d.sessions} 个会话`,
                style: {
                  ...S.chartBar,
                  ...(d.date === todayKey ? S.chartBarToday : {}),
                  height: d.future ? '4px' : `${Math.max(3, Math.round((d.tokens / maxTokens) * 100))}%`,
                  opacity: d.future ? 0.35 : 1,
                },
              }),
              h('div', { style: S.chartLabel }, d.weekday)))),
        ),

        data.doneCards?.length
          ? h('div', { style: S.chartCard },
            h('div', { style: S.chartTitle }, '本周完成的任务'),
            h('div', { style: S.doneList },
              data.doneCards.map((c) => h('div', { key: c.id, style: S.doneRow },
                h('span', { style: S.doneWhen }, fmtTime(c.doneAt)),
                h('button', {
                  type: 'button',
                  style: { ...S.briefItemLink, fontSize: '12px', fontWeight: 400 },
                  onClick: () => onOpenSession?.(c.id),
                  title: '在画布上找到这张卡',
                }, c.text)))))
          : null));
  };
}

/** 菜单里的一行：左边文案，右边一句说明，带开/关状态。 */
function makeMenuItem(React) {
  const h = React.createElement;
  return function menuItem(label, active, onClick, hint) {
    return h('button', {
      type: 'button',
      style: { ...S.menuRow, ...(active ? S.menuRowOn : {}) },
      onClick,
    },
    h('span', { style: S.menuRowLabel }, label),
    h('span', { style: S.menuRowHint }, hint ?? ''));
  };
}

function makeWorkspace(React, openSession, ctxRef) {
  const h = React.createElement;
  const menuItem = makeMenuItem(React);
  const api = createApi();
  const Note = makeNote(React, api, (data) => boardSink.fn?.(data));
  const BriefPage = makeBriefPage(React);
  const WeekPage = makeWeekPage(React);

  return function Workspace() {
    /** 看板对象 { version, notes }；null = 还没加载回来。 */
    const [board, setBoard] = React.useState(null);
    const [error, setError] = React.useState('');
    const [drag, setDrag] = React.useState(null); // { id, dx, dy, x, y }
    const [dragHot, setDragHot] = React.useState(false);
    /** 拖拽会话是否在进行：用 ref 值镜像成 state，effect 只依赖它。 */
    const [dragActive, setDragActive] = React.useState(false);
    /** 刚新建的便签 id：让那张卡自动进编辑态。 */
    const [autoEditId, setAutoEditId] = React.useState(null);
    /** 只看没做完：默认开——画布第一眼只该看见"还没做的事"，勾完的收起来但仍计数。 */
    const [hideDone, setHideDone] = React.useState(true);
    /** 排布算出来的画布高度（卡片高度不一，靠它撑开）。 */
    const [layoutH, setLayoutH] = React.useState(0);
    /** 自动排列进行中（写回期间禁掉按钮，避免连点）。 */
    const [busyArranging, setBusyArranging] = React.useState(false);
    /** 拉取会话任务进行中。 */
    const [busyImporting, setBusyImporting] = React.useState(false);
    /** 生成简报进行中。 */
    const [busyBrief, setBusyBrief] = React.useState(false);
    /** 长期累计（tokens / 线程数），不随 90 天快照清理。 */
    const [cumulative, setCumulative] = React.useState(null);
    /** 长任务的进度（扫描/解析中显示）。 */
    const [progress, setProgress] = React.useState(null);
    /** 剪贴板不可用时的兜底：把草稿显示出来让人手动复制。 */
    const [draftFallback, setDraftFallback] = React.useState(null);
    /** 会话所在目录没登记为工作区时（侧边栏里没有它）的提示。 */
    const [unlisted, setUnlisted] = React.useState(null);
    /** 左侧固定的「菜单」：功能开关都收在这里，顶栏不再堆按钮。 */
    const [menuOpen, setMenuOpen] = React.useState(false);
    /** 诊断抽屉：能力面 + 数据规模 + 最近一次跳转结果。 */
    const [showDiag, setShowDiag] = React.useState(false);
    const [diag, setDiag] = React.useState(null);
    /** 两个页面：便签画布 / 助理简报。 */
    const [tab, setTab] = React.useState('notes');
    /** 本周看板数据（会话/token/完成任务）。 */
    const [weekly, setWeekly] = React.useState(null);
    /** 简报历史（日期列表）与正在看的那一份。 */
    const [briefHistory, setBriefHistory] = React.useState([]);
    const [briefView, setBriefView] = React.useState(null);
    /** 设置面板：打开状态 + 本地编辑中的值。 */
    const [showSettings, setShowSettings] = React.useState(false);
    const [settings, setSettings] = React.useState(null);
    const [settingsDraft, setSettingsDraft] = React.useState(null);
    const [savingSettings, setSavingSettings] = React.useState(false);
    /** 一次性提示（导入结果之类），几秒后自动消失。 */
    const [toast, setToast] = React.useState('');
    const scrollRef = React.useRef(null);
    const canvasRef = React.useRef(null);
    const dragRef = React.useRef(null);

    // 接口给的是 { version, notes }；这里统一取出便签数组，并兼容直接给数组的形态。
    // 必须放在下面的 useCallback 之前：依赖数组会在渲染时立刻求值。
    const notes = Array.isArray(board) ? board : (board?.notes ?? []);

    const onBoard = React.useCallback((data) => {
      setBoard(data.board);
      setError('');
    }, []);
    boardSink.fn = onBoard;
    React.useEffect(() => () => { boardSink.fn = null; }, []);

    React.useEffect(() => {
      let alive = true;
      api.get()
        .then((data) => { if (alive) setBoard(data.board); })
        .catch((e) => { if (alive) setError(`看板加载失败：${e.message}`); });
      api.getSettings()
        .then((data) => { if (alive && data?.settings) { setSettings(data.settings); setSettingsDraft(data.settings); } })
        .catch(() => { /* 设置读不到不挡画布 */ });
      api.getCumulative()
        .then((data) => { if (alive && data?.totals) setCumulative(data.totals); })
        .catch(() => { /* 没有账本就先不显示 */ });
      api.getWeekly()
        .then((data) => { if (alive && data) setWeekly(data); })
        .catch(() => { /* 统计不到就先空着 */ });
      api.getBriefs()
        .then((data) => { if (alive && Array.isArray(data?.briefs)) setBriefHistory(data.briefs); })
        .catch(() => { /* 历史读不到不影响 */ });
      return () => { alive = false; };
    }, []);

    /** 画布高度：便签多了自动加高，不把最后一行截掉。 */
    /** 两两之间是否有压盖（含简报卡）。 */
    const anyOverlap = () => {
      const hs = measureHeights(notes.map((n) => n.id));
      for (let i = 0; i < notes.length; i += 1) {
        for (let j = i + 1; j < notes.length; j += 1) {
          const a = notes[i];
          const b = notes[j];
          const wA = widthOf(a);
          const wB = widthOf(b);
          const hA = hs.get(a.id) || heightOf(a);
          const hB = hs.get(b.id) || heightOf(b);
          if (a.x < b.x + wB && a.x + wA > b.x && a.y < b.y + hB && a.y + hA > b.y) return true;
        }
      }
      return false;
    };

    /**
     * 打开画布时自检一次：如果卡片互相压住了（旧数据、宿主按固定网格摆的），
     * 自动按真实高度排开。只跑一次，不会一直动你的布局。
     */
    const autoPackOnce = React.useRef(false);
    React.useEffect(() => {
      if (autoPackOnce.current || board == null || dragActive) return;
      autoPackOnce.current = true;
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
      raf(() => {
        if (!anyOverlap()) return;
        const tasks = notes.filter((n) => n.kind !== 'brief');
        if (!tasks.length) return;
        const { positions, height } = packLayout(readingOrder(tasks));
        setLayoutH(height);
        void applyLayout(positions, tasks);
      });
    }, [board, dragActive]);

    // 长任务跑的时候问一次宿主「到哪一步了」，好让界面有反馈
    React.useEffect(() => {
      if (!busyBrief && !busyImporting) { setProgress(null); return undefined; }
      let alive = true;
      const tick = async () => {
        try {
          const d = await api.progress();
          if (alive) setProgress(d?.progress ?? null);
        } catch { /* 拿不到就不显示 */ }
      };
      void tick();
      const timer = setInterval(tick, 400);
      return () => { alive = false; clearInterval(timer); };
    }, [busyBrief, busyImporting]);

    /** 可见区域宽度：换行边界就取它。 */
    const [visibleW, setVisibleW] = React.useState(0);

    React.useEffect(() => {
      const measure = () => {
        const w = Number(scrollRef.current?.clientWidth) || 0;
        if (w > 0) setVisibleW(w);
      };
      measure();
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }, [tab]);

    // 窗口变宽/变窄后重新铺一次：保证一行能放几张就放几张，不出现横向滚动
    const lastWrapW = React.useRef(0);
    React.useEffect(() => {
      if (!visibleW) return;
      if (!lastWrapW.current) { lastWrapW.current = visibleW; return; }
      if (Math.abs(visibleW - lastWrapW.current) < 40) return;
      lastWrapW.current = visibleW;
      const list = notes.filter((n) => n.kind !== 'brief');
      if (!list.length) return;
      const { positions, height } = packLayout(newestFirst(list));
      setLayoutH(height);
      void applyLayout(positions, list);
    }, [visibleW]);

    // 点「只看没做完」这类筛选后自动重排：可见的排在最上面，不用手动点自动排列
    const firstFilterRun = React.useRef(true);
    React.useEffect(() => {
      if (firstFilterRun.current) { firstFilterRun.current = false; return; }
      const list = notes.filter((n) => n.kind !== 'brief');
      if (!list.length) return;
      const { positions, height } = packLayout(sortForBoard(list));
      setLayoutH(height);
      void applyLayout(positions, list);
    }, [hideDone]);

    /** 拖拽中不轮询，免得把正在拖的卡片位置覆盖掉。 */
    const draggingRef = React.useRef(false);
    draggingRef.current = dragActive;

    // 实时钉卡要能自己冒出来：面板可见时每 15 秒拉一次看板
    React.useEffect(() => {
      let alive = true;
      const timer = setInterval(async () => {
        if (!alive) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        if (draggingRef.current) return;
        try {
          const data = await api.get();
          if (alive && data?.board) onBoard(data);
        } catch { /* 拉不到就下次再说 */ }
      }, 15_000);
      return () => { alive = false; clearInterval(timer); };
    }, [onBoard]);

    /** 卡片占位（画布上只有便签了）。 */
    const widthOf = () => NOTE_W;
    const heightOf = () => NOTE_H;

    /** 画布高度：排布算出来的高度优先，其次按最低那张卡估，卡片长高不会被截断。 */
    const tallest = notes.reduce((m, n) => Math.max(m, n.y + heightOf(n)), 0);
    const canvasH = Math.max(CANVAS_H, layoutH, tallest + MARGIN + 120);
    /** 画布宽度 = 可见宽度（内容永远不超出屏幕，不需要横向滚动）。 */
    const canvasW = Math.max(CANVAS_W_MIN, visibleW);

    /** 卡片实际高度：能测到就测，测不到用估算值。 */
    const measureHeights = (ids) => {
      const map = new Map();
      for (const id of ids) {
        const el = canvasRef.current?.querySelector?.(`[data-note-id="${id}"]`);
        const h = el ? Number(el.getBoundingClientRect?.().height) || 0 : 0;
        map.set(id, h);
      }
      return map;
    };

    /**
     * 换行边界 = 当前**可见区域**的右边界（不是写死的 2600 画布）。
     * 这样一行铺到窗口右边就会回到左边、换到下一行，不用横向滚动。
     */
    const wrapWidth = () => {
      const visible = Number(scrollRef.current?.clientWidth) || 0;
      return Math.max(MARGIN * 2 + NOTE_W, visible || CANVAS_W);
    };

    /**
     * 装箱：按传入顺序从左往右铺，撞到可见边界就回到左边换行；
     * 每行的行高取该行最高的一张，所以高卡片不会压到下一行。
     */
    const packLayout = (list) => {
      const heights = measureHeights(list.map((n) => n.id));
      const positions = new Map();
      const limit = wrapWidth() - MARGIN;

      let x = MARGIN;
      let y = MARGIN;
      let rowH = 0;
      for (const n of list) {
        const w = widthOf(n);
        const h = heights.get(n.id) || heightOf(n);
        if (x > MARGIN && x + w > limit) {
          x = MARGIN;
          y += rowH + NOTE_GAP;
          rowH = 0;
        }
        positions.set(n.id, { x, y });
        x += w + NOTE_GAP;
        rowH = Math.max(rowH, h);
      }
      const bottom = y + rowH + MARGIN;
      return { positions, height: Math.max(CANVAS_H, bottom) };
    };

    /**
     * 把位置写回宿主，然后重新拉一次看板。
     * 这里**总是写全部**：两个窗口同时开着时，只写"本地认为变了"的会留下错位。
     */
    const applyLayout = async (positions, list = notes) => {
      const patches = [];
      for (const n of list) {
        const p = positions.get(n.id);
        if (!p) continue;
        patches.push({ id: n.id, x: p.x, y: p.y });
      }
      // 一次请求写回全部位置：以前是每张卡一个请求，排 15 张就要 15 次整板读写
      if (patches.length) await api.layout(patches);
      const data = await api.get();
      onBoard(data);
    };

    /** 除了简报卡（结论面板，固定在自己位置）之外的便签。 */
    const taskNotes = () => notes.filter((n) => n.kind !== 'brief');

    /**
     * 便签在视觉上的先后，跟人读一行字一样：
     * 上下差得不多就算同一行，同一行里按 x 从左往右，否则按 y 从上往下。
     */
    const ROW_TOLERANCE = 60;
    const readingOrder = (list) => [...list].sort((a, b) => {
      if (Math.abs(a.y - b.y) > ROW_TOLERANCE) return a.y - b.y;
      if (Math.abs(a.x - b.x) > 1) return a.x - b.x;
      return a.createdAt - b.createdAt;
    });

    /** 组：未完成 0 / 已完成 1 / 已放弃 2。 */
    const groupOf = (n) => (n.cancelled ? 2 : n.done ? 1 : 0);

    /**
     * 默认排列：未完成的在最上面，其次已完成，最后已放弃；
     * 组内按创建时间倒序（最新的靠前）。
     */
    const sortForBoard = (list) => [...list].sort((a, b) => (
      groupOf(a) - groupOf(b)
      || (b.createdAt || 0) - (a.createdAt || 0)
      || String(b.id).localeCompare(String(a.id))
    ));

    /** 兼容旧名。 */
    const newestFirst = sortForBoard;

    /** 一键重排：未完成的在最上面，从左到右铺满一行再换行。 */
    const autoArrange = async () => {
      if (!notes.length) return;
      setBusyArranging(true);
      try {
        const { positions, height } = packLayout(sortForBoard(taskNotes()));
        setLayoutH(height);
        await applyLayout(positions);
      } catch (e) {
        setError(`排列失败：${e.message}`);
      } finally {
        setBusyArranging(false);
      }
    };

    /**
     * 继续一个任务：把续做草稿放进剪贴板，再打开对应会话。
     * 这个 DSH 版本没有「把文本放进输入框」的接口，所以草稿交给剪贴板；
     * 剪贴板也不可用时，弹出来让人手动复制。
     */
    const continueTask = async (note) => {
      const sessionId = note?.source?.id;
      if (!sessionId) return;
      const draft = buildDraft(note);
      const copied = await copyText(draft);
      const verdict = await openSession?.(sessionId);
      if (verdict === 'not-found') setToast('续做草稿已复制 · 但这个会话已不存在');
      else if (verdict === 'unavailable') setToast('续做草稿已复制 · 当前环境不支持跳转');
      if (copied) setToast('续做草稿已复制 · 在会话输入框粘贴即可');
      else setDraftFallback(draft);
    };

    /** 重新拉取某张卡对应线程的最新待办。 */
    const refreshCard = async (note) => {
      const sessionId = note?.source?.id;
      if (!sessionId) return;
      try {
        const data = await api.refreshSession(sessionId);
        if (data?.board) onBoard(data);
        const matched = data?.matched ?? 0;
        setToast(matched ? '已刷新这张卡' : '没在最近会话里找到它（可能太旧了）');
      } catch (e) {
        setError(`刷新失败：${e.message}`);
      }
    };

    /** 放弃 / 恢复一个任务。放弃后不计入「没做完」，以后拉取也不会复活。 */
    const cancelCard = async (note, cancelled) => {
      if (!note?.id) return;
      try {
        const data = await api.updateNote({ id: note.id, cancelled });
        if (data?.board) onBoard(data);
        setToast(cancelled ? '已放弃这个任务（可随时恢复）' : '已恢复到看板');
      } catch (e) {
        setError(`${cancelled ? '放弃' : '恢复'}失败：${e.message}`);
      }
    };

    /**
     * 会话所在目录还没登记成工作区时：注册它，然后打开这个会话。
     * （DSH 的工作区按完整目录精确匹配，子目录不会自动归属。）
     */
    const registerAndOpen = async () => {
      const pending = unlisted;
      if (!pending?.sessionId) return;
      const uiWorkspace = typeof ctxRef.current?.get === 'function' ? ctxRef.current.get('uiWorkspace') : undefined;
      try {
        // 宿主负责：按 cwd 找到/创建工作区，并把会话 attach 进去
        const adopted = await api.adoptSession(pending.sessionId, pending.cwd);
        setUnlisted(null);
        // 注意：不要调 openWorkspace——它的语义是「连接工作区并打开它的空白会话」，
        // 会先开出一个新会话，把后面的 openSession 顶掉。会话已经 attach 过了，
        // 这里只需要直接选中它。
        if (uiWorkspace?.openSession) uiWorkspace.openSession(adopted?.sessionId || pending.sessionId);
        setToast(`已注册工作区${adopted?.title ? `「${adopted.title}」` : ''}并打开会话`);
      } catch (e) {
        setError(`注册失败：${e.message}`);
      }
    };

    /** 导出单卡（Markdown，含历史）。 */
    const exportCard = async (note) => {
      if (!note?.id) return;
      try {
        const md = await api.exportNote(note.id);
        const name = `note-${String(note.text || 'untitled').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40)}.md`;
        if (saveFile(md, name)) setToast('已导出 Markdown 文件');
        else if (await copyText(md)) setToast('浏览器不支持下载，已复制到剪贴板');
        else setDraftFallback(md);
      } catch (e) {
        setError(`导出失败：${e.message}`);
      }
    };

    /** 打开诊断时现取一份宿主事实。 */
    const loadDiag = React.useCallback(async () => {
      try {
        const data = await api.getDiag();
        setDiag({ ...data, lastNav: globalThis.__SECRETARY_LAST_NAV__ ?? null, at: Date.now() });
      } catch (e) {
        setDiag({ error: e.message, lastNav: globalThis.__SECRETARY_LAST_NAV__ ?? null, at: Date.now() });
      }
    }, []);

    /** 重新取一次本周统计（导入/生成简报之后调用）。 */
    const refreshWeekly = React.useCallback(async () => {
      try { const data = await api.getWeekly(); if (data) setWeekly(data); } catch { /* 忽略 */ }
    }, []);

    /** 切到历史里的某一天。 */
    const pickBrief = async (date) => {
      if (!date) return;
      const onBoard = (notes ?? []).find((n) => n.kind === 'brief' && n.brief?.date === date);
      if (onBoard) { setBriefView(onBoard.brief); return; }
      try {
        const data = await api.getBrief(date);
        if (data?.brief) setBriefView(data.brief);
      } catch (e) {
        setError(`读取 ${date} 的简报失败：${e.message}`);
      }
    };

    /** 生成助理简报：扫会话 → 拼简报 → 存快照 → 切到简报页。 */
    const generateBrief = async () => {
      if (busyBrief) return;
      const startedAt = Date.now();
      setBusyBrief(true);
      setProgress({ phase: '准备中', done: 0, total: 0, startedAt });
      try {
        const data = await api.generateBrief(24);
        if (data?.board) onBoard(data);
        if (data?.brief?.cumulative) setCumulative(data.brief.cumulative);
        void refreshWeekly();
        if (data?.brief) { setBriefView(data.brief); setTab('brief'); }
        try {
          const h2 = await api.getBriefs();
          if (Array.isArray(h2?.briefs)) setBriefHistory(h2.briefs);
        } catch { /* 历史刷新失败无所谓 */ }
        const r = data?.report ?? {};
        const parts = [`扫描 ${r.scan?.sessions ?? 0} 个会话`];
        parts.push(r.created ? '已放上简报卡' : '简报已更新');
        parts.push(`用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
        setToast(parts.join(' · '));
      } catch (e) {
        const raw = String(e.message);
        setError(/未知路由|404/.test(raw)
          ? '宿主还没加载简报接口：重启一次 DSH 后再试'
          : /unauthorized|403/.test(raw)
            ? '没有权限：刷新页面（或重启一次 DSH）'
            : `生成简报失败：${raw}`);
      } finally {
        setBusyBrief(false);
      }
    };

    /** 保存设置（时间/保留天数/开关）。 */
    const saveSettings = async () => {
      if (!settingsDraft || savingSettings) return;
      setSavingSettings(true);
      try {
        const data = await api.saveSettings(settingsDraft);
        if (data?.settings) {
          setSettings(data.settings);
          setSettingsDraft(data.settings);
          setToast(`已保存：每天 ${data.settings.dailyTime} 生成简报，保留 ${data.settings.retentionDays} 天`);
        }
        setShowSettings(false);
      } catch (e) {
        setError(`保存设置失败：${e.message}`);
      } finally {
        setSavingSettings(false);
      }
    };

    /** 扫所有工作区的会话，把每个会话最后的待办清单拉成便签。 */
    const importSessions = async () => {
      if (busyImporting) return;
      const startedAt = Date.now();
      setBusyImporting(true);
      setProgress({ phase: '准备中', done: 0, total: 0, startedAt });
      try {
        const data = await api.importSessions();
        if (data?.board) onBoard(data);
        const r = data?.report ?? { created: 0, updated: 0, skipped: 0 };
        const spent = ((Date.now() - startedAt) / 1000).toFixed(1);

        // 宿主是按固定网格摆的，卡片高矮不一会贴在一起：导完自动按真实高度排一次
        if (r.created || r.updated) {
          await new Promise((resolve) => {
            const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
            raf(() => resolve());
          });
          const fresh = (data?.board?.notes ?? []).filter((n) => n.kind !== 'brief');
          const { positions, height } = packLayout(newestFirst(fresh));
          setLayoutH(height);
          await applyLayout(positions, fresh);
        }
        const parts = [`扫描 ${data?.scanned ?? 0} 个会话`];
        if (r.created) parts.push(`新增 ${r.created}`);
        if (r.updated) parts.push(`刷新 ${r.updated}`);
        if (r.skipped) parts.push(`跳过 ${r.skipped}（你改过）`);
        if (r.cleaned?.length) parts.push(`清掉 ${r.cleaned.length} 张子代理遗留卡`);
        if (!r.created && !r.updated && !r.skipped) parts.push('没找到带任务清单的会话');
        if (data?.truncated) parts.push('（时间到，未扫完）');
        parts.push(`用时 ${spent}s`);
        void refreshWeekly();
        setToast(parts.join(' · '));
      } catch (e) {
        const msg = /未知路由|404/.test(String(e.message))
          ? '宿主还没加载拉取接口：重启一次 DSH 后再试'
          : `拉取失败：${e.message}`;
        setError(msg);
      } finally {
        setBusyImporting(false);
      }
    };

    // 提示条 4 秒后自己消失
    React.useEffect(() => {
      if (!toast) return undefined;
      const timer = setTimeout(() => setToast(''), 4000);
      return () => clearTimeout(timer);
    }, [toast]);

    const createNote = React.useCallback(async () => {
      const before = new Set(notes.map((n) => n.id));
      try {
        // 先落在左上角，随后整块重排；这样旧卡片会被推到右边
        const data = await api.addNote({ text: '新便签', x: MARGIN, y: MARGIN });
        const created = (data?.board?.notes ?? []).find((n) => !before.has(n.id));
        if (created) setAutoEditId(created.id);
        onBoard(data);

        // 等一帧让新卡片进 DOM，才能量到真实高度
        await new Promise((resolve) => {
          const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
          raf(() => resolve());
        });

        const fresh = (data?.board?.notes ?? []).filter((n) => n.kind !== 'brief');
        // 最新的在最左上，其余依次往右、撞边换行
        const ordered = newestFirst(fresh);
        const { positions, height } = packLayout(ordered);
        setLayoutH(height);
        await applyLayout(positions, fresh);
      } catch (e) {
        setError(`新建失败：${e.message}`);
      }
    }, [notes]);

    // 拖拽：pointermove / pointerup 挂在 window 上，指针移出便签也不丢。
    // hot 状态同时写进 ref，pointerup 里读 ref 而不是 state，避免拖完第一帧拿不到。
    React.useEffect(() => {
      if (!dragActive) return undefined;
      const move = (e) => {
        const d = dragRef.current;
        if (!d) return;
        // 便签是绝对定位在画布里的，必须用画布坐标：
        // 直接拿 clientX 当 left 会让卡片整体偏移一个滚动距离。
        const canvas = canvasRef.current;
        const rect = canvas?.getBoundingClientRect();
        const left = rect?.left ?? 0;
        const top = rect?.top ?? 0;
        const maxX = Math.max(0, (canvas?.offsetWidth || 2600) - NOTE_W);
        const maxY = Math.max(0, (canvas?.offsetHeight || 1800) - NOTE_H);
        d.x = Math.min(Math.max(0, Math.round(e.clientX - left - d.grabX)), maxX);
        d.y = Math.min(Math.max(0, Math.round(e.clientY - top - d.grabY)), maxY);
        d.hot = isOverTrash(e.clientX, e.clientY);
        setDrag({ id: d.id, x: d.x, y: d.y });
        setDragHot(d.hot);
      };
      const up = () => {
        const d = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        setDragActive(false);
        setDragHot(false);
        if (!d) return;
        if (d.hot) {
          api.deleteNote(d.id).then(onBoard).catch((e) => setError(`删除失败：${e.message}`));
          return;
        }
        if (d.x === d.startX && d.y === d.startY) return;
        api.updateNote({ id: d.id, x: d.x, y: d.y })
          .then(onBoard)
          .catch((e) => setError(`移动失败：${e.message}`));
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      return () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
    }, [dragActive, onBoard]);

    const onDragStart = (e, id) => {
      const note = notes.find((n) => n.id === id);
      if (!note) return;
      const noteRect = e.currentTarget.getBoundingClientRect();
      dragRef.current = {
        id,
        // 指针在卡片内部的偏移：保证拖起来不跳
        grabX: e.clientX - noteRect.left,
        grabY: e.clientY - noteRect.top,
        x: note.x,
        y: note.y,
        startX: note.x,
        startY: note.y,
        hot: false,
      };
      setDragActive(true);
      setDrag({ id, x: note.x, y: note.y });
    };

    /** 指针是否落在垃圾桶上（垃圾桶只在拖拽时渲染）。 */
    const isOverTrash = (cx, cy) => {
      const el = document.getElementById('workbench-trash');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    };

    // 简报卡不算待办；已放弃的不算「没做完」
    const tasks = notes.filter((n) => n.kind !== 'brief' && !n.cancelled);
    const cancelledCount = notes.filter((n) => n.kind !== 'brief' && n.cancelled).length;
    const reviewCount = notes.filter((n) => n.kind !== 'brief' && n.review && !n.done && !n.cancelled).length;
    // 简报不在画布上了（单独一页），这里只放便签
    const shown = notes.filter((n) => {
      if (n.kind === 'brief') return false;
      if (n.cancelled) return true; // 放弃的仍然看得见，可随时恢复
      return hideDone ? !n.done : true;
    });
    // 看板上保存的那份简报（画布不再渲染它）：有多张时取日期最新的
    const boardBrief = notes
      .filter((n) => n.kind === 'brief' && n.brief)
      .sort((a, b) => String(b.brief.date).localeCompare(String(a.brief.date)))[0]?.brief ?? null;
    const total = tasks.length;
    const done = tasks.filter((n) => n.done).length;
    const open = total - done;
    const pct = total ? Math.round((done / total) * 100) : 0;

    return h('div', { style: S.root },
      h('style', { dangerouslySetInnerHTML: { __html: '@keyframes wb-spin{to{transform:rotate(360deg)}}' } }),
      h('div', { style: S.topbar },
        /* 最左、永远固定：功能菜单（所有开关都在这里） */
        h('button', {
          type: 'button',
          style: { ...S.toolBtn, ...(menuOpen ? S.toolBtnOn : {}), flex: 'none' },
          onClick: () => setMenuOpen((v) => !v),
          title: '功能：只看没做完、自动排列、拉取线程、生成简报、设置',
        }, '☰ 菜单'),
        h('div', { style: S.tabs },
          h('button', {
            type: 'button',
            style: { ...S.tab, ...(tab === 'notes' ? S.tabActive : {}) },
            onClick: () => setTab('notes'),
          }, `便签 ${total}`),
          h('button', {
            type: 'button',
            style: { ...S.tab, ...(tab === 'week' ? S.tabActive : {}) },
            onClick: () => { setTab('week'); void refreshWeekly(); },
          }, '本周'),
          h('button', {
            type: 'button',
            style: { ...S.tab, ...(tab === 'brief' ? S.tabActive : {}) },
            onClick: () => setTab('brief'),
          }, '简报')),

        /* 中间：只留当前页真正需要看的状态 */
        tab === 'notes' && open
          ? h('span', { style: { ...S.chip, color: '#b83b38', background: 'rgba(217,83,79,.12)' } }, `${open} 未完成`)
          : null,
        tab === 'notes' && reviewCount
          ? h('span', {
            style: { ...S.chip, background: 'rgba(52,199,89,.14)', color: 'var(--dsw-alias-state-success-primary, #34c759)' },
            title: '有线程刚跑完一轮，等你验收（点卡片上的「待验收」即可）',
          }, `${reviewCount} 待验收`)
          : null,
        tab !== 'notes' && cumulative
          ? h('span', {
            style: S.chip,
            title: `长期累计：${cumulative.sessions} 个线程 · 覆盖 ${cumulative.days} 天`,
          }, `累计 ${fmtTokens(cumulative.tokens)}`)
          : null,
        h('span', { style: S.spacer }),

        /* 右边：只留最常用的新建 */
        tab === 'notes'
          ? h('button', {
            type: 'button',
            onClick: createNote,
            title: '新建一张便签',
            style: { ...S.toolBtn, ...S.toolBtnPrimary },
          }, '＋ 新建')
          : null),



      tab === 'week'
        ? h(WeekPage, {
          data: weekly,
          // 点「本周完成的任务」时回到画布并定位那张卡（简单做法：切到便签页）
          onOpenSession: () => { setTab('notes'); },
        })
        : null,
      tab === 'brief'
        ? h(BriefPage, {
          brief: briefView ?? boardBrief,
          history: briefHistory,
          onPick: pickBrief,
          onGenerate: generateBrief,
          busy: busyBrief,
          onOpenSession: openSession,
        })
        : null,
      showDiag
        ? h('div', { style: S.diagPanel },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('span', { style: { fontSize: '12.5px', fontWeight: 600 } }, '诊断'),
            h('span', { style: S.spacer }),
            h('button', { type: 'button', style: S.crashBtn, onClick: () => { void loadDiag(); } }, '刷新'),
            h('button', { type: 'button', style: S.crashBtn, onClick: () => setShowDiag(false) }, '关闭')),
          h('pre', { style: S.diagPre }, diag ? JSON.stringify(diag, null, 2) : '加载中…'))
        : null,
      menuOpen
        ? h('div', { style: S.menuOverlay, onClick: () => setMenuOpen(false) })
        : null,
      menuOpen
        ? h('div', { style: S.menu, onPointerDown: (e) => e.stopPropagation() },
          h('div', { style: S.menuTitle }, '功能'),
          menuItem('☑ 只看没做完', hideDone, () => { setHideDone((v) => !v); setMenuOpen(false); },
            hideDone ? '当前：只显示没做完的' : '当前：全部显示'),
          menuItem('▦ 自动排列', false, () => { setMenuOpen(false); void autoArrange(); },
            `把 ${total} 张便签重新铺开：未完成在上`),
          menuItem('↓ 拉取线程任务', false, () => { setMenuOpen(false); void importSessions(); },
            '把每个线程最后的待办清单拉成便签'),
          menuItem('✎ 生成简报', false, () => { setMenuOpen(false); void generateBrief(); },
            '扫一遍所有会话，出今天的简报'),
          h('div', { style: S.menuSep }),
          menuItem('⚙ 设置', showSettings, () => { setShowSettings((v) => !v); setMenuOpen(false); },
            `每天 ${settings?.dailyTime ?? '08:00'} 生成 · 保留 ${settings?.retentionDays ?? 90} 天`))
        : null,
      tab === 'notes'
        ? h('div', { 'data-page': 'notes', style: S.canvasWrap },
        h('div', {
          ref: scrollRef,
          style: S.canvasScroll,
          onDoubleClick: (e) => {
            // 只有双击在空白画布底上才新建
            if (e.target !== canvasRef.current) return;
            createNote();
          },
        },
        h('div', {
          ref: canvasRef,
          style: { ...S.canvas, width: `${canvasW}px`, height: `${canvasH}px` },
        },
          shown.map((n) => h(Note, {
            key: n.id,
            note: n,
            drag: drag && drag.id === n.id ? drag : null,
            dragHot,
            autoEdit: autoEditId === n.id,
            onOpenSession: async (id) => {
              const result = await openSession?.(id);
              if (!result) return;
              if (result.verdict === 'not-found') setToast('这个会话已不存在（可能被删除）');
              else if (result.verdict === 'unavailable') setToast('当前环境不支持跳转');
              else if (result.verdict === 'unlisted') {
                setToast('这个会话不在任何工作区里，先注册目录再打开');
                setUnlisted({ sessionId: id, cwd: result.cwd });
              }
            },
            onRefresh: refreshCard,
            onCancel: cancelCard,
            onContinue: continueTask,
            onExport: exportCard,
            onDragStart,
            onDelete: () => api.deleteNote(n.id).then(onBoard).catch((e) => setError(`删除失败：${e.message}`)),
          })))),
        board == null && !error ? h('div', { style: S.loading }, '加载看板…') : null,
        board != null && total > 0 && shown.length === 0
          ? h('div', { style: S.empty },
            h('div', { style: S.emptyTitle }, '没有没做完的了'),
            h('div', null, `已完成的 ${done} 张都收起来了，点顶栏「只看没做完」可以再展开`))
          : null,
        board != null && total === 0
          ? h('div', { style: S.empty },
            h('div', { style: S.emptyTitle }, '画布是空的'),
            h('div', null, '双击空白处，或点右下角 ＋ 放上第一张便签'),
            h('div', null, '做完直接勾掉，没做完就继续往上补进展'))
          : null,
        (busyBrief || busyImporting) && progress
          ? h('div', { style: S.progress },
            h('div', { style: S.progressRow },
              h('span', { style: S.spinner }),
              h('span', null, progress.phase || '处理中'),
              progress.total
                ? h('span', { style: { marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', opacity: 0.75 } }, `${progress.done}/${progress.total}`)
                : null,
              h('span', { style: { marginLeft: progress.total ? '6px' : 'auto', fontVariantNumeric: 'tabular-nums', opacity: 0.6 } },
                `${Math.max(0, (Date.now() - (progress.startedAt || Date.now())) / 1000).toFixed(1)}s`)),
            h('div', { style: S.progressTrack },
              h('div', {
                style: {
                  ...S.progressFill,
                  width: progress.total ? `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%` : '35%',
                },
              })))
          : null,
        showSettings
          ? h('div', { style: S.settingsPanel },
            h('div', { style: { fontSize: '12px', fontWeight: 600 } }, 'DSH 助理'),
            h('div', { style: S.settingsRow },
              h('span', { style: S.settingsLabel }, '每天生成时间'),
              h('input', {
                type: 'time',
                style: S.settingsInput,
                value: settingsDraft?.dailyTime ?? '08:00',
                onChange: (e) => setSettingsDraft({ ...(settingsDraft ?? {}), dailyTime: e.target.value }),
              })),
            h('div', { style: S.settingsRow },
              h('span', { style: S.settingsLabel }, '快照保留天数'),
              h('input', {
                type: 'number',
                min: 1,
                max: 3650,
                style: S.settingsInput,
                value: settingsDraft?.retentionDays ?? 90,
                onChange: (e) => setSettingsDraft({ ...(settingsDraft ?? {}), retentionDays: Number(e.target.value) }),
              })),
            h('div', { style: S.settingsRow },
              h('span', { style: S.settingsLabel }, '每天自动生成'),
              h('input', {
                type: 'checkbox',
                checked: settingsDraft?.enabled !== false,
                onChange: (e) => setSettingsDraft({ ...(settingsDraft ?? {}), enabled: e.target.checked }),
              })),
            h('div', { style: S.settingsHint }, '按本机时区。到点且今天还没出过简报时生成；开机时若已过点会补一份。'),
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '2px' } },
              h('button', {
                type: 'button',
                onClick: saveSettings,
                disabled: savingSettings,
                style: { ...S.crashBtn, flex: '1', height: '26px', fontSize: '11.5px' },
              }, savingSettings ? '保存中…' : '保存'),
              h('button', {
                type: 'button',
                onClick: () => { setSettingsDraft(settings); setShowSettings(false); },
                style: { ...S.crashBtn, flex: '1', height: '26px', fontSize: '11.5px' },
              }, '取消')))
          : null,
        unlisted
          ? h('div', { style: S.draftModal },
            h('div', { style: { fontSize: '12.5px', fontWeight: 600 } }, '这个会话不在任何工作区里'),
            h('div', { style: { fontSize: '11.5px', lineHeight: '17px', color: TEXT_2 } },
              `它的目录是 ${unlisted.cwd || '（未知）'}，DSH 的工作区按完整目录精确匹配，所以侧边栏里没有这个会话——直接跳转会开出一个空白会话。`),
            h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
              h('button', { type: 'button', style: S.crashBtn, onClick: () => setUnlisted(null) }, '算了'),
              h('button', {
                type: 'button',
                style: { ...S.crashBtn, background: ACCENT, color: '#fff', borderColor: ACCENT },
                onClick: registerAndOpen,
              }, '注册目录并打开')))
          : null,
        draftFallback
          ? h('div', { style: S.draftModal },
            h('div', { style: { fontSize: '12.5px', fontWeight: 600 } }, '续做草稿（剪贴板不可用，手动复制）'),
            h('textarea', {
              style: S.draftArea,
              readOnly: true,
              value: draftFallback,
              autoFocus: true,
              onFocus: (e) => e.target.select(),
            }),
            h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
              h('button', { type: 'button', style: S.crashBtn, onClick: () => setDraftFallback(null) }, '关闭')))
          : null,
        toast ? h('div', { style: S.toast }, toast) : null,
        error ? h('div', { style: S.error }, error) : null,
        drag
          ? h('div', {
            id: 'workbench-trash',
            style: { ...S.trash, ...(dragHot ? S.trashHot : {}) },
          }, trashSvg(React, dragHot ? '#d9534f' : '#8a8a8a'))
          : h('button', {
            type: 'button',
            style: S.fab,
            title: '新建便签',
            onClick: createNote,
          }, '＋'))
        : null);
  };
}

/**
 * 把一张卡的目标/未完成待办/最近进展/产出拼成「续做草稿」。
 * 这个 DSH 版本没有把文本放进输入框的能力，所以草稿走剪贴板，由你粘贴。
 */
function buildDraft(note) {
  const lines = [];
  lines.push('接着上面的进度继续这个任务。');
  lines.push('');
  if (note.goal) lines.push(`【目标】${note.goal}`);
  const open = (note.todos ?? []).filter((t) => t.status !== 'completed');
  if (open.length) {
    lines.push('【还没做完】');
    for (const t of open.slice(0, 8)) lines.push(`- ${t.content}${t.status === 'in_progress' ? '（进行中）' : ''}`);
  }
  const recent = (note.updates ?? []).slice(-3);
  if (recent.length) {
    lines.push('【最近进展】');
    for (const u of recent) lines.push(`- ${u.text}`);
  }
  const files = note.deliverables ?? [];
  if (files.length) {
    lines.push('【已有产出】');
    for (const f of files.slice(0, 6)) lines.push(`- ${f}`);
  }
  if (note.text) lines.push('', `（来自「${note.text}」这条线程）`);
  return lines.join('\n').trim();
}

/** 触发浏览器下载；不支持时返回 false（调用方退回复制）。 */
function saveFile(text, filename, mime = 'text/markdown;charset=utf-8') {
  try {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* 忽略 */ } }, 2000);
    return true;
  } catch {
    return false;
  }
}

/** 复制到剪贴板；失败返回 false，由调用方退化到弹层。 */
async function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 落到 execCommand */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    document.body.removeChild(ta);
    return ok !== false;
  } catch {
    return false;
  }
}

/**
 * 跳到某个会话：DSH 的 uiWorkspace.openSession 会「选中会话并打开对话」，
 * 正好是一次界面导航。服务不存在时退化成提示，不报错。
 */
/** 一个会话 id 的两种历史写法：裸 uuid 与 session- 前缀。 */
function idVariants(id) {
  const raw = String(id ?? '').trim();
  if (!raw) return [];
  const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw;
  return raw.startsWith('session-') ? [raw, bare] : [raw, `session-${raw}`];
}

/**
 * 跳到一个会话。返回 'ok' | 'unavailable' | 'not-found'。
 *
 * 为什么先问宿主：DSH 的会话 id 有「裸 uuid」和「session- 前缀」两种存量写法，
 * 把不认识的那种交给 openSession 会被当成新会话、打开一个空白线程。
 * 客户端自己探测不可靠（sessions.binding 对没打开过的冷会话就是空的），
 * 所以由宿主的会话存储来判定哪个写法真的存在。
 */
function makeNavigator(ctx, resolveId) {
  const grab = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined);

  return async (sessionId) => {
    const done = (result) => {
      try { globalThis.__SECRETARY_LAST_NAV__ = { at: Date.now(), sessionId: String(sessionId), ...result }; } catch { /* 忽略 */ }
      return result;
    };
    if (!sessionId) return done({ verdict: 'not-found' });
    const uiWorkspace = grab('uiWorkspace');

    let target = String(sessionId);
    let cwd = '';
    if (typeof resolveId === 'function') {
      try {
        const resolved = await resolveId(String(sessionId));
        if (resolved === null) return done({ verdict: 'not-found' });  // 宿主说：这个会话不存在
        if (resolved) {
          target = resolved.id;
          cwd = resolved.cwd || '';
        }
      } catch {
        // 解析失败：按原样尝试（老版本宿主没有这个接口）
      }
    }

    try {
      if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
        // openSession 内部是 sessions.retain(target) → 认不出的 id 会直接抛错，
        // 也就是说它**不会**凭空造一个空白会话；真的失败才降级到「收编」。
        uiWorkspace.openSession(target);
        return done({ verdict: 'ok', target });
      }
      const layout = grab('layout');
      if (layout && typeof layout.selectPanel === 'function') {
        layout.selectPanel('conversation');
        return { verdict: 'ok' };
      }
    } catch (error) {
      console.error('[secretary] 打开会话失败', error);
      if (cwd) return done({ verdict: 'unlisted', cwd, error: String(error?.message ?? error) });
      return done({ verdict: 'not-found', error: String(error?.message ?? error) });
    }
    return done({ verdict: 'unavailable' });
  };
}

function apply(ctx) {
  const React = runtime.React;
  const Icon = makeIcon(React);
  const openSession = makeNavigator(ctx, resolveSessionIdViaHost);
  const Workspace = makeWorkspace(React, openSession, { current: ctx });
  const Boundary = makeBoundary(React);

  // 包一层错误边界：以后再出渲染异常，面板里会显示原因和「重试」。
  function Panel(props) {
    return React.createElement(Boundary, null, React.createElement(Workspace, props));
  }

  // 侧边栏入口
  ctx.effect(() =>
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 15, label: () => 'DSH 助理', locale: NS },
        Icon,
      )));

  // 主面板：key 必须和侧边栏 id 一致，否则点开是空白
  ctx.effect(() =>
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        { name: 'main', key: PANEL_ID, locale: NS },
        Panel,
      )));
}

window.__ModuleLoader__.load({
  id: 'dsh-secretary/client',
  factory: (require) => {
    runtime.React = require('react');
    const module = { exports: {} };
    Object.assign(module.exports, { apply, inject, NS, PANEL_ID });
    return module.exports;
  },
});
