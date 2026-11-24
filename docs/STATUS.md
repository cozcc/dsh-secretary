# 状态 · dsh-secretary

> 更新：2026-11-24 · 对应 IT-002 · 版本 0.1.0 @ 5d44a0e
> **这是快照，不是记事本。** 超过一屏就精简，细节挪进 ITERATIONS.md。

## 现在是什么状态（≤3 行）

可用，已挂进 desktop profile 日常使用。三页（便签 / 线程 / 本周）+ 简报自动生成 + 永久 token 台账 + 待验收徽章均已实现，测试 44 passed，工作区无未提交改动（本次新增文档除外）。

## 接口面现状

与 CHARTER 第 5 节一致：8 个 `secretary_*` 工具、配置键仅 `dataDir`、依赖宿主 client-ui-layout / client-ui-sidebar 与 sessionQuery、数据落在 `~/.dsh/secretary/`。

## 进行中

- 无。（最近一次提交 `5d44a0e` 已收尾：便签外隐藏画布、工具栏收敛为固定的「菜单」按钮 + 三个页签）

## 下一步（新会话从这里接）

1. 无排期任务；有新需求时先判断是否落在 CHARTER N1–N5（尤其 N2：不改宿主）。
2. 若要动 `src/client.mjs`，记得 `node build-client.mjs` 重建，否则面板不更新。
3. 若要改数据结构（board/cumulative/digest），先按 CHARTER 第 5 节判断是否属于接口面破坏性变更。

## 已知坑 / 红线

- 数据目录默认 `~/.dsh/secretary/`；改 `dataDir` 后**必须重启 DSH** 才生效。
- `briefs/` 快照会被清理（默认 90 天），`cumulative.json` 永不清理——不要把长期统计塞进 briefs。
- 拉取会话卡不能覆盖用户手改文本；系统字段只回填缺失值（CHARTER C2）。
- 便签长文本走显式报错，不要改成静默截断（CHARTER N4）。

## 最近一次验证

- 文档检查：`node ~/.agents/skills/project-lifecycle/scripts/check.mjs .` → 通过（2 条 IT，0 错误）@ 2026-11-24
- 代码测试：`node --test test/*.test.mjs` → 44 passed / 0 failed @ 2026-11-22（HEAD 5d44a0e，此后无代码变更）
- 手动：未在本轮执行（面板交互验证留待下次改动时一并做）
