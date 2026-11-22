/**
 * 助理侧测试：官方计价（峰谷/缓存）、简报拼装、简报卡落盘、设置与快照保留。
 *
 * 跑法：node --test test/brief.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sumUsage, fmtTokens } from '../src/pricing.mjs';
import { composeBrief, briefText, dateKey, saveBrief, listBriefs, pruneBriefs } from '../src/brief.mjs';
import { upsertBriefNote, normalizeBoard, stats } from '../src/board.mjs';
import { sanitize, readSettings, writeSettings } from '../src/settings.mjs';
import { emptyLedger, ingest, totals, isIngested, dailySeries, saveLedger } from '../src/cumulative.mjs';
import { buildWeekly, weekStartOf, dayKey } from '../src/weekly.mjs';
import { BoardStore } from '../src/store.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-brief-'));

test('token 汇总：总 = 未命中 + 输出 + 命中，并给出命中率', () => {
  const total = sumUsage([
    { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60 },
    { inputTokens: 200, outputTokens: 20, cacheReadTokens: 100 },
  ]);
  assert.equal(total.totalTokens, 490);
  assert.equal(total.calls, 2);
  assert.ok(Math.abs(total.cacheHitRate - 160 / 460) < 1e-9);
});

test('token 缩写：k / M / B', () => {
  assert.equal(fmtTokens(112331911), '112.33M');
  assert.equal(fmtTokens(1_450_000_000), '1.45B');
  assert.equal(fmtTokens(12345), '12.3k');
  assert.equal(fmtTokens(42), '42');
});

test('简报：需要你出手排在最前，消耗按工作区拆分', () => {
  const portraits = [
    { sessionId: 's1', title: '卡住的', workspace: 'Play', status: 'stalled', activeInWindow: false, idleDays: 5,
      todos: [{ content: '修 bug', status: 'pending' }], goal: null, recentTools: ['bash'], deliverables: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 } },
    { sessionId: 's2', title: '推进中', workspace: 'Play', status: 'active', activeInWindow: true, idleDays: 0,
      todos: [{ content: '写测试', status: 'pending' }, { content: '写文档', status: 'completed' }],
      goal: { objective: '做成秘书', status: 'active' }, recentTools: ['bash', 'edit'], deliverables: ['/tmp/a.md'],
      usage: { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 600_000, totalTokens: 1_200_000 } },
    { sessionId: 's3', title: '等你回答', workspace: 'Finance', status: 'waiting', activeInWindow: true, idleDays: 0,
      todos: [], goal: null, recentTools: ['read'], deliverables: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 } },
  ];
  const brief = composeBrief(portraits, { sinceMs: Date.now() - 24 * 3600e3 });
  const keys = brief.sections.map((s) => s.key);
  assert.ok(keys.includes('attention'));
  assert.ok(keys.indexOf('attention') < keys.indexOf('doing'));
  const attention = brief.sections.find((s) => s.key === 'attention');
  assert.equal(attention.items.length, 2); // 卡住 + 等你回答
  // 每个条目都要带会话 id，客户端才能点着跳过去
  assert.ok(attention.items.every((it) => typeof it.sessionId === 'string' && it.sessionId));
  const doing = brief.sections.find((s) => s.key === 'doing');
  assert.ok(doing.items.every((it) => it.sessionId === 's2'));
  assert.equal(brief.totals.waiting, 1);
  assert.equal(brief.totals.stalled, 1);

  const text = briefText(brief);
  assert.match(text, /需要你出手/);
  assert.match(text, /Play：1\.20M tokens/);
});

test('简报卡：同一天只保留一张，重复生成就地更新', () => {
  const board = normalizeBoard({});
  const brief = composeBrief([], { sinceMs: Date.now() - 3600e3 });
  const first = upsertBriefNote(board, brief, 1000);
  assert.equal(first.created, true);
  assert.equal(board.notes.length, 1);
  assert.equal(board.notes[0].kind, 'brief');

  const second = upsertBriefNote(board, { ...brief, generatedAt: 2000 }, 3000);
  assert.equal(second.created, false);
  assert.equal(board.notes.length, 1);
  assert.equal(board.notes[0].brief.generatedAt, 2000);

  // 简报卡不算待办
  assert.deepEqual(stats(board), { total: 0, done: 0, open: 0, cancelled: 0, briefs: 1 });

  // 换一天生成：旧的简报卡应当被清掉，画布上只留一份
  const other = upsertBriefNote(board, { ...brief, date: '2030-01-01', generatedAt: 5000 }, 6000);
  assert.equal(other.created, true);
  assert.equal(board.notes.filter((n) => n.kind === 'brief').length, 1);
  assert.equal(board.notes.find((n) => n.kind === 'brief').brief.date, '2030-01-01');
});

test('快照：保存、按日期列历史、超过保留期清理', () => {
  const dir = tmpDir();
  const now = Date.parse('2026-11-15T09:00:00+08:00');
  const brief = composeBrief([], { sinceMs: now - 3600e3, now });

  // 先按很长的保留期存一份 1 月的，再存今天的
  saveBrief(dir, { ...brief, date: '2026-01-01' }, { retentionDays: 3650, now });
  saveBrief(dir, brief, { retentionDays: 3650, now });
  assert.equal(listBriefs(dir).length, 2);

  // 改成 90 天保留：2026-01-01 会被删掉，今天的留着
  const removed = pruneBriefs(dir, { retentionDays: 90, now });
  assert.equal(removed, 1);
  const left = listBriefs(dir);
  assert.equal(left.length, 1);
  assert.equal(left[0].date, brief.date);
});

test('设置：时间格式校验、天数夹取、落盘可读', () => {
  assert.equal(sanitize({ dailyTime: '8:5' }).dailyTime, '08:00'); // 非法回落默认
  assert.equal(sanitize({ dailyTime: '23:59' }).dailyTime, '23:59');
  assert.equal(sanitize({ retentionDays: 0 }).retentionDays, 1);
  assert.equal(sanitize({ retentionDays: 99999 }).retentionDays, 3650);
  assert.equal(sanitize({ enabled: false }).enabled, false);

  const dir = tmpDir();
  assert.equal(readSettings(dir).dailyTime, '08:00'); // 没有文件时给默认
  const saved = writeSettings(dir, { dailyTime: '07:30', retentionDays: 30 });
  assert.equal(saved.dailyTime, '07:30');
  assert.equal(readSettings(dir).retentionDays, 30);
});

test('dateKey 用本地日期', () => {
  assert.equal(dateKey(Date.parse('2026-11-15T09:00:00+08:00')), '2026-11-15');
});


test('长期累计：按会话整段记账，重复读不会翻倍', () => {
  const ledger = emptyLedger();
  const days = { '2026-11-14': { input: 100, output: 10, cached: 900 } };
  ingest(ledger, 's1', 111, days);
  assert.deepEqual(totals(ledger).tokens, 1010);

  // 同一会话、同一版本再记一次：结果不变
  ingest(ledger, 's1', 111, days);
  assert.equal(totals(ledger).tokens, 1010);

  // 另一个会话另一个天
  ingest(ledger, 's2', 222, { '2026-11-15': { input: 5, output: 5, cached: 0 } });
  const t = totals(ledger);
  assert.equal(t.sessions, 2);
  assert.equal(t.days, 2);
  assert.equal(t.firstDay, '2026-11-14');
  assert.equal(t.lastDay, '2026-11-15');
  assert.equal(t.tokens, 1020);

  // 会话更新后重读：整段替换，不会把旧的再加一遍
  ingest(ledger, 's1', 333, { '2026-11-14': { input: 100, output: 10, cached: 900 }, '2026-11-15': { input: 1, output: 1, cached: 0 } });
  assert.equal(totals(ledger).tokens, 1022); // s1: 1010+2, s2: 10

  // 记账判断
  assert.equal(isIngested(ledger, 's1', 333), true);
  assert.equal(isIngested(ledger, 's1', 444), false);

  // 趋势
  const series = dailySeries(ledger);
  assert.equal(series.length, 2);
  assert.equal(series[0].day, '2026-11-14');
});

test('长期累计：简报里出现「长期累计」块', () => {
  const brief = composeBrief([], {
    sinceMs: Date.now() - 3600e3,
    cumulative: { tokens: 1_450_000_000, sessions: 150, days: 30, firstDay: '2026-10-16', lastDay: '2026-11-15' },
  });
  const block = brief.sections.find((s) => s.key === 'cumulative');
  assert.ok(block, '缺累计块');
  assert.match(block.lines[0].text, /累计 1\.45B tokens/);
  assert.match(block.lines[1].text, /150 个线程 · 覆盖 30 天/);
});


test('子代理线程不进简报、不计入本期消耗', () => {
  const portraits = [
    { sessionId: 'w1', isSubagent: true, title: 'You are a READ-ONLY evidence', workspace: 'P', status: 'active',
      activeInWindow: true, todos: [], todosOpen: 0, recentTools: ['read'], deliverables: [],
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, totalTokens: 1100 }, idleDays: 0 },
    { sessionId: 'm1', isSubagent: false, title: '真实线程', workspace: 'P', status: 'active',
      activeInWindow: true, todos: [], todosOpen: 0, recentTools: ['bash'], deliverables: [],
      usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, totalTokens: 550 }, idleDays: 0 },
  ];
  const brief = composeBrief(portraits, { sinceMs: Date.now() - 3600e3 });
  assert.equal(brief.totals.sessions, 1, '子代理不算一个会话');
  const text = briefText(brief);
  assert.ok(!text.includes('READ-ONLY'), '子代理不该出现在简报里');
});


test('本周看板：按周一为界统计 token / 会话 / 完成任务，并给出上周对比', async () => {
  const dir = tmpDir();
  const store = new BoardStore(dir);
  // 固定一个周三作为“现在”
  const now = new Date('2026-11-18T10:00:00+08:00').getTime(); // 周三
  const start = weekStartOf(now);
  assert.equal(dayKey(start), '2026-11-16', '周一应当是 11-16');

  const ledger = emptyLedger();
  // 本周两天有消耗，两个会话
  ingest(ledger, 's1', 1, { '2026-11-16': { input: 100, output: 10, cached: 0 }, '2026-11-18': { input: 50, output: 5, cached: 0 } });
  ingest(ledger, 's2', 2, { '2026-11-17': { input: 200, output: 20, cached: 0 } });
  // 上周一天
  ingest(ledger, 's3', 3, { '2026-11-10': { input: 400, output: 40, cached: 0 } });
  saveLedger(dir, ledger, now);
  // 用真实 store 写一份带完成时间的看板
  await store.mutate((b) => {
    b.notes.push(
      { id: 'a', text: '本周完成', done: true, x: 0, y: 0, color: 'yellow', createdAt: 1, updatedAt: 1, doneAt: start + 3600e3, updates: [], todos: [], source: null },
      { id: 'b', text: '上周完成', done: true, x: 0, y: 0, color: 'yellow', createdAt: 1, updatedAt: 1, doneAt: start - 86400e3, updates: [], todos: [], source: null },
      { id: 'c', text: '还没做', done: false, x: 0, y: 0, color: 'yellow', createdAt: 2, updatedAt: 2, doneAt: null, updates: [], todos: [], source: null },
    );
  });

  const w = buildWeekly({ dataDir: dir, store, now });
  assert.equal(w.weekStart, '2026-11-16');
  assert.equal(w.totals.tokens, 385, `本周 token 应为 100+10+50+5+200+20=385，实际 ${w.totals.tokens}`);
  assert.equal(w.totals.sessions, 3, '本周活跃会话：s1 两天 + s2 一天');
  assert.equal(w.totals.done, 1);
  assert.equal(w.totals.open, 1);
  assert.equal(w.lastWeek.tokens, 440);
  assert.equal(w.lastWeek.done, 1);
  assert.equal(w.days.length, 7);
  assert.equal(w.days[0].date, '2026-11-16');
  assert.equal(w.days[2].tokens, 55, '周三应为 50+5');
  assert.equal(w.doneCards[0].text, '本周完成');
});
