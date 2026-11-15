/**
 * dsh-secretary —— DSH 助理的宿主入口。
 *
 * 两件事：
 *   1. 把 ~/.dsh/workbench/board.json 的读写挂到 webServer 上，给画布面板用
 *   2. 注册 secretary_* 工具，Agent 也能帮你看板里加便签、勾完成
 */

import { BoardStore, defaultDataDir } from './store.mjs';
import { registerHttpRoutes } from './http.mjs';
import { scanSessions } from './sessions.mjs';
import { readSettings } from './settings.mjs';
import { runBrief, runScheduledBrief } from './briefing.mjs';
import { dateKey } from './brief.mjs';
import {
  summaryText,
  stats,
  addNote,
  updateNote,
  setDone,
  addUpdate,
  removeNote,
  importSessions,
} from './board.mjs';

export const name = 'secretary';

export const inject = ['tools'];

export function apply(ctx, rawConfig = {}) {
  const dataDir = rawConfig && typeof rawConfig.dataDir === 'string' && rawConfig.dataDir
    ? rawConfig.dataDir
    : defaultDataDir();
  const log = (msg) => console.log(`[workbench] ${msg}`);
  const store = new BoardStore(dataDir);

  ctx.effect(() => {
    const routes = registerHttpRoutes(ctx, { store, log, scanOptions: { limit: 60, budgetMs: 12000 } });
    log(`数据目录 ${dataDir}`);
    return () => {
      // 路由生命周期由 webCtx.effect 自己回收
      void routes;
    };
  }, 'secretary: routes');

  // ── 每日简报定时器 ─────────────────────────────────
  // 每分钟看一眼：到点且今天还没出过简报就生成。开机时如果已经过了今天的点，
  // 补一份（助理不该因为你 9 点才打开电脑就漏掉今天的简报）。
  ctx.effect(() => {
    let lastKey = '';
    let timer = null;
    const pad = (n) => String(n).padStart(2, '0');
    const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const fire = async (why) => {
      try {
        const result = await runScheduledBrief({ ctx, store, dataDir, log });
        if (result.skipped) log(`跳过每日简报：${result.reason}`);
        else log(`已生成 ${result.date} 的简报（${why}）：扫描 ${result.scan.sessions} 个会话`);
      } catch (error) {
        log(`生成简报失败：${error?.message ?? error}`);
      }
    };

    const tick = async () => {
      const settings = readSettings(dataDir);
      if (!settings.enabled) return;
      const now = new Date();
      const today = dateKey(now.getTime());
      if (hhmm(now) !== settings.dailyTime) return;
      if (lastKey === today) return;
      lastKey = today;
      await fire('到点');
    };

    // 开机补跑：今天已经过了设置的时间，但还没有今天的简报
    const boot = setTimeout(async () => {
      const settings = readSettings(dataDir);
      if (!settings.enabled) return;
      const now = new Date();
      const today = dateKey(now.getTime());
      if (hhmm(now) < settings.dailyTime) return;
      const board = store.read();
      const has = board.notes.some((n) => n.kind === 'brief' && n.brief?.date === today);
      if (has) return;
      lastKey = today;
      await fire('开机补跑');
    }, 8000);
    boot.unref?.();

    timer = setInterval(() => { void tick(); }, 60_000);
    timer.unref?.();
    log(`每日简报已安排：${readSettings(dataDir).dailyTime}（本机时区）`);

    return () => {
      clearTimeout(boot);
      if (timer) clearInterval(timer);
    };
  }, 'secretary: daily brief timer');

  // ── 实时钉卡：一轮跑完就标「待验收」 ───────────────
  // 不依赖扫描是否在跑，也不改 updatedAt（那是"你动过"的判据，别混）。
  try {
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return;
      const reason = event?.data?.reason?.kind;
      if (reason !== 'completed') return; // 出错/中断的不算"干完了等你验收"
      const sessionId = String(session?.id ?? event?.sessionId ?? '');
      if (!sessionId) return;
      const at = Number(event?.time) || Date.now();
      const seq = Number(event?.seq) || 0;
      void store.mutate((board) => {
        const note = board.notes.find((n) => n.kind !== 'brief'
          && n.source?.kind === 'session' && String(n.source.id) === sessionId);
        if (!note || note.done || note.cancelled) return null;
        note.review = { at, seq };
        return note.id;
      }).catch((error) => log(`标记待验收失败：${error?.message ?? error}`));
    }, 'secretary: turn/end review');
  } catch (error) {
    log(`挂接 turn/end 失败（实时钉卡不可用）：${error?.message ?? error}`);
  }

  const tools = ctx.get('tools');
  if (!tools) {
    log('没有 tools 服务，跳过工具注册（画布本身不受影响）');
    return;
  }

  // ToolDefinition 硬性要求 output { schema, render }，缺了会抛错并中断 apply。
  const register = (definition) => {
    const tool = {
      ...definition,
      output: definition.output ?? {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: value?.content?.[0]?.text ?? JSON.stringify(value) }],
      },
    };
    try {
      tools.register(tool);
    } catch (error) {
      log(`工具注册失败 ${definition.name}: ${error?.message ?? error}`);
    }
  };

  register({
    name: 'secretary_list',
    description: '查看便签画布看板：总数、已完成、未完成，以及每张便签的 id、内容和最新进展。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const board = store.read();
      return { content: [{ type: 'text', text: summaryText(board) }], total: stats(board) };
    },
  });

  register({
    name: 'secretary_add_note',
    description: '在看板画布上新建一张便签（也就是一个待办）。text 是便签内容，color 可选：yellow/pink/green/blue/purple/orange。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '便签内容' },
        color: { type: 'string', description: '便签颜色，默认自动轮换' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args) {
      const board = store.read();
      const note = addNote(board, args);
      store.write(board);
      return { content: [{ type: 'text', text: `已新建便签 [${note.id}] ${note.text}` }], noteId: note.id };
    },
  });

  register({
    name: 'secretary_complete_note',
    description: '把某张便签勾完成（done=true）或取消完成（done=false）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '便签 id' },
        done: { type: 'boolean', description: 'true 勾完成，false 取消勾选，默认 true' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args) {
      const board = store.read();
      const note = setDone(board, args.id, args.done !== false);
      store.write(board);
      return { content: [{ type: 'text', text: `便签 [${note.id}] 已${note.done ? '完成' : '取消完成'}` }] };
    },
  });

  register({
    name: 'secretary_add_progress',
    description: '给某张便签追加一条进展记录（没做完时记一笔）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '便签 id' },
        text: { type: 'string', description: '进展内容' },
      },
      required: ['id', 'text'],
      additionalProperties: false,
    },
    async execute(args) {
      const board = store.read();
      addUpdate(board, args.id, args.text);
      store.write(board);
      return { content: [{ type: 'text', text: `已给便签 [${args.id}] 追加进展：${args.text}` }] };
    },
  });

  register({
    name: 'secretary_update_note',
    description: '修改便签内容或颜色。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '便签 id' },
        text: { type: 'string', description: '新的便签内容' },
        color: { type: 'string', description: 'yellow/pink/green/blue/purple/orange' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args) {
      const board = store.read();
      const note = updateNote(board, args.id, args);
      store.write(board);
      return { content: [{ type: 'text', text: `已更新便签 [${note.id}]` }] };
    },
  });

  register({
    name: 'secretary_delete_note',
    description: '删除某张便签（真的删掉，不是勾完成）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '便签 id' } },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args) {
      const board = store.read();
      removeNote(board, args.id); // 不存在会抛错
      store.write(board);
      return { content: [{ type: 'text', text: `已删除便签 [${args.id}]` }] };
    },
  });

  register({
    name: 'secretary_import_sessions',
    description: '扫描 DSH 里所有工作区的会话，把每个会话最后的待办清单（todo_write）作为一张便签导入看板；按会话去重，你手改过的卡不会被覆盖。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多扫描多少个最近会话，默认 60' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const scan = await scanSessions({ ctx, log, limit: Number(args?.limit) || 60 });
      if (scan.error) throw new Error(scan.error);
      const board = store.read();
      const report = importSessions(board, scan.sessions);
      store.write(board);
      const lines = [
        `扫描 ${scan.scanned} 个会话，其中 ${scan.sessions.length} 个有任务清单${scan.truncated ? '（时间到，未扫完）' : ''}。`,
        `新建 ${report.created} 张，刷新 ${report.updated} 张，跳过 ${report.skipped} 张（你手动改过）。`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }], report };
    },
  });

  register({
    name: 'secretary_daily_brief',
    description: '扫一遍 DSH 所有工作区的会话，生成一份「助理简报」（任务目标/进展/待办/消耗/需要你出手的事），并在画布上放一张简报卡。',
    parameters: {
      type: 'object',
      properties: {
        sinceHours: { type: 'number', description: '回溯多少小时，默认 24' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const result = await runBrief({ ctx, store, dataDir, log, sinceHours: Number(args?.sinceHours) || 24 });
      return { content: [{ type: 'text', text: result.text }], brief: result.brief };
    },
  });

  log('secretary_* 工具已注册');
}
