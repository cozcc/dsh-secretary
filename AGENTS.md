# dsh-secretary · 项目约定

**已立项**：L0（本文件）已自动加载。默认先看 **L1**：`docs/STATUS.md` 全文 +
`docs/ITERATIONS.md` 最后 2 条（省得问人；任务跟项目无关可跳过）。要改目标 / 接口面 / 发布时
再翻 `docs/CHARTER.md` 第 2/3/5 节（L2）。

## 身份

DSH 插件（不是独立应用）：便签画布 + 线程任务卡 + 简报/周报 + token 累计台账。UI 在 DSH 侧边栏，服务挂在 DSH 自有 web server 上，**不新开进程和端口**。

## 边界

- 红线（CHARTER）：**N1 不新开进程/端口**、**N2 不改宿主与其他插件**、**N4 不静默截断长文本**。
- 跨插件问题只上报，不顺手改。
- 数据只写 `dataDir`（默认 `~/.dsh/secretary/`），不改不读其他插件的数据目录。
- 不读凭据文件；发布/安装动作要用户明确同意。

## 入口

- `src/index.mjs` 工具注册（8 个 `secretary_*`）
- `src/http.mjs` 路由 · `src/board.mjs` 画布 · `src/briefing.mjs` 简报 · `src/weekly.mjs` 周报 · `src/cumulative.mjs` 台账
- `src/client.mjs` 前端（构建产物 `lib/client.js`）· `cordis.patch.yml` 宿主插件行

## 验证

```bash
node --test test/*.test.mjs   # 当前基线：44 passed
node build-client.mjs         # 改了 src/client.mjs 之后必须重建，否则面板不更新
```

## 记录（可选）

改完项目文件可顺手按 `project-lifecycle` 补一条 IT 并更新 `docs/STATUS.md`；
不记也不影响交付——记忆是给下次省事的，不是完成条件。
