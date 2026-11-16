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

const boardCode = inline('boardMod', 'src/board.mjs',
  'DEFAULT_BOARD, normalizeBoard, stats, addNote, updateNote, setDone, addUpdate, removeUpdate, removeNote, findNote, summaryText, COLORS, newId, importSessions, upsertBriefNote, nextFreeSlot, applyPositions, pushHistory, noteToMarkdown, removeNotesBySources, LIMITS');
const storeCode = inline('storeMod', 'src/store.mjs', 'BoardStore, defaultDataDir');
const logsCode = inline('logsMod', 'src/logs.mjs', 'dshHome, decodeFrames, decodeSessionFile, listSessionLogs, readWorkspaces, readCachedGoal, digestEvents, loadDigestCache, saveDigestCache');
const insightsCode = inline('insightsMod', 'src/insights.mjs', 'collectPortraits');
const sessionsCode = inline('sessionsMod', 'src/sessions.mjs', 'scanSessions, parseTodoArguments');
const cumulativeCode = inline('cumulativeMod', 'src/cumulative.mjs', 'emptyLedger, loadLedger, saveLedger, isIngested, ingest, totals, dailySeries');
const pricingCode = inline('pricingMod', 'src/pricing.mjs', 'fmtTokens, sumUsage');
const briefCode = inline('briefMod', 'src/brief.mjs', 'composeBrief, briefText, dateKey, saveBrief, pruneBriefs, listBriefs, readBrief');
const settingsCode = inline('settingsMod', 'src/settings.mjs', 'DEFAULT_SETTINGS, readSettings, writeSettings, sanitize');
const briefingCode = inline('briefingMod', 'src/briefing.mjs', 'runBrief, runScheduledBrief');
const httpCode = inline('httpMod', 'src/http.mjs', 'registerHttpRoutes');

const indexBody = read('src/index.mjs')
  .replace(/^import\s[\s\S]*?from\s+'[^']+';?\n/gm, '');

const bundled = `/* dsh-secretary host bundle — 由 build-client.mjs 生成，勿手改 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

${boardCode}

${storeCode}

${logsCode}

${insightsCode}

${sessionsCode}

${cumulativeCode}

${pricingCode}

${briefCode}

${settingsCode}

${briefingCode}

${httpCode}

const { DEFAULT_BOARD, normalizeBoard, stats, addNote, updateNote, setDone, addUpdate, removeUpdate, removeNote, findNote, summaryText, COLORS, newId, importSessions, upsertBriefNote, nextFreeSlot, applyPositions, pushHistory, noteToMarkdown, removeNotesBySources, LIMITS } = boardMod;
const { BoardStore, defaultDataDir } = storeMod;
const { dshHome, decodeFrames, decodeSessionFile, listSessionLogs, readWorkspaces, readCachedGoal, digestEvents, loadDigestCache, saveDigestCache } = logsMod;
const { collectPortraits } = insightsMod;
const { scanSessions, parseTodoArguments } = sessionsMod;
const { emptyLedger, loadLedger, saveLedger, isIngested, ingest, totals: ledgerTotals, dailySeries } = cumulativeMod;
const { fmtTokens, sumUsage } = pricingMod;
const { composeBrief, briefText, dateKey, saveBrief, pruneBriefs, listBriefs, readBrief } = briefMod;
const { DEFAULT_SETTINGS, readSettings, writeSettings, sanitize } = settingsMod;
const { runBrief, runScheduledBrief } = briefingMod;
const { registerHttpRoutes } = httpMod;

${indexBody}
`;

fs.writeFileSync(path.join(root, 'lib/index.js'), bundled, 'utf8');
console.log('✓ 已生成 lib/client.js、lib/index.js');
