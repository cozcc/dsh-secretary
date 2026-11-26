/**
 * 生成浏览器端 bundle：lib/index.js、lib/client.js。
 *
 * DSH 把 `exports["./client"]` 指向的文件当原始脚本文本塞进页面执行，
 * 不走 ESM 解析，所以产物必须是自执行 IIFE；src/client.mjs 本身已经不写
 * import/export，这里只外包一层。
 *
 * 宿主半区 lib/index.js 是普通 ESM，这里连同 src/*.mjs 一起内联成一个文件，
 * 免得 profile 里要跟着安装一堆相对路径模块。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ── 浏览器半区 ──────────────────────────────────────
const clientSrc = read('src/client.mjs');
const forbidden = /^\s*(import|export)\s/m.exec(clientSrc);
if (forbidden) {
  console.error(`✗ src/client.mjs 含 ESM 语句，不能作为浏览器 bundle：${forbidden[0].trim()}`);
  process.exit(1);
}
fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'lib/client.js'),
  `/* dsh-secretary client bundle — 由 build-client.mjs 生成，勿手改 */\n;(function () {\n${clientSrc}\n})();\n`,
  'utf8',
);

// ── 宿主半区 ────────────────────────────────────────
// board / store / http 三个模块内联进一个 lib/index.js：profile 里只链接本目录，
// 少一个相对路径模块就少一类「装上了但没生效」的可能。
// 内联条件：这三个文件只用 node: 内置模块，互不循环依赖。
const inline = (name, file, exports) => {
  // 校验：这里声明的导出必须真的在源文件里 export 过，否则运行时会 TDZ/undefined
  const source = read(file);
  for (const raw of exports.split(',')) {
    const symbol = raw.trim();
    if (!symbol) continue;
    const declared = new RegExp(`export\\s+(async\\s+)?(function|const|let|class)\\s+${symbol}\\b`).test(source)
      || new RegExp(`export\\s*\\{[^}]*\\b${symbol}\\b`).test(source);
    if (!declared) {
      console.error(`✗ ${file} 没有导出 ${symbol}（build-client.mjs 的清单过期了）`);
      process.exit(1);
    }
  }
  const body = read(file)
    .replace(/^import\s[\s\S]*?from\s+'[^']+';?\n/gm, '')
    .split('\n')
    .filter((line) => !/^\} from\s/.test(line))
    .map((line) => line
      .replace(/^export\s+(async\s+)?function\s/, '$1function ')
      .replace(/^export\s+(const|class)\s/, '$1 '))
    .join('\n');
  return `const ${name} = (() => {\n${body}\nreturn { ${exports} };\n})();`;
};

/** 模块清单：这里声明的导出 = IIFE 的 return = 下面自动生成的解构，三者不会再漂移。 */
const MODULES = [
  ['boardMod', 'src/board.mjs', 'DEFAULT_BOARD, normalizeBoard, stats, addNote, updateNote, setDone, addUpdate, removeUpdate, removeNote, findNote, summaryText, COLORS, newId, importSessions, upsertBriefNote, nextFreeSlot, applyPositions, pushHistory, noteToMarkdown, removeNotesBySources, isArchived, setPinned, ARCHIVE_AFTER_DAYS, sanitizeTitle, LIMITS'],
  ['storeMod', 'src/store.mjs', 'BoardStore, defaultDataDir'],
  ['logsMod', 'src/logs.mjs', 'dshHome, decodeFrames, decodeSessionFile, listSessionLogs, readWorkspaces, readCachedGoal, readSessionCwd, digestEvents, loadDigestCache, saveDigestCache'],
  ['insightsMod', 'src/insights.mjs', 'collectPortraits'],
  ['sessionsMod', 'src/sessions.mjs', 'scanSessions, parseTodoArguments'],
  ['cumulativeMod', 'src/cumulative.mjs', 'emptyLedger, loadLedger, saveLedger, isIngested, ingest, totals, dailySeries'],
  ['pricingMod', 'src/pricing.mjs', 'fmtTokens, sumUsage'],
  ['briefMod', 'src/brief.mjs', 'composeBrief, briefText, dateKey, saveBrief, pruneBriefs, listBriefs, readBrief'],
  ['settingsMod', 'src/settings.mjs', 'DEFAULT_SETTINGS, readSettings, writeSettings, sanitize'],
  ['weeklyMod', 'src/weekly.mjs', 'buildWeekly, weekStartOf, dayKey'],
  ['briefingMod', 'src/briefing.mjs', 'runBrief, runScheduledBrief'],
  ['httpMod', 'src/http.mjs', 'registerHttpRoutes'],
];

/** 生成解构语句：totals → totals: ledgerTotals 这种重命名在这里声明过一次。 */
const RENAMES = { cumulativeMod: { totals: 'ledgerTotals' } };

const codes = MODULES.map(([name, file, exports]) => {
  const code = inline(name, file, exports);
  return { name, exports, code };
});
const destructure = codes.map(({ name, exports }) => {
  const names = exports.split(',').map((x) => x.trim()).filter(Boolean).map((sym) => {
    const as = RENAMES[name]?.[sym];
    return as ? `${sym}: ${as}` : sym;
  });
  return `const { ${names.join(', ')} } = ${name};`;
}).join('\n');
const codeBlock = codes.map((c) => c.code).join('\n\n');

const indexBody = read('src/index.mjs')
  .replace(/^import\s[\s\S]*?from\s+'[^']+';?\n/gm, '');

const bundled = `/* dsh-secretary host bundle — 由 build-client.mjs 生成，勿手改 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

${codeBlock}

${destructure}

${indexBody}
`;

fs.writeFileSync(path.join(root, 'lib/index.js'), bundled, 'utf8');
console.log('✓ 已生成 lib/client.js、lib/index.js');

// 构建后自检：宿主半边必须能 apply，且解构出来的符号不能是 undefined。
// （曾经因为清单没同步，isArchived 在运行时才炸——这里让它在构建时就炸。）
const smoke = await import(`file://${path.join(root, 'lib/index.js')}?t=${Date.now()}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-secretary-smoke-'));
const injected = [];
smoke.apply({
  effect: (fn) => fn(),
  on: () => {},
  inject: (_deps, cb) => injected.push(cb),
  get: (key) => (key === 'tools' ? { register: () => {} } : undefined),
}, { dataDir: tmp });
for (const cb of injected) cb({ effect: (fn) => fn(), webServer: { register: () => ({}) } });
fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ 宿主自检通过（apply + 路由注册）');
