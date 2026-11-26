# 状态 · dsh-secretary

> 更新：2026-11-26 · 对应 IT-003 · 版本 0.2.0
> **这是快照，不是记事本。** 超过一屏就精简，细节挪进 ITERATIONS.md。

## 现在是什么状态（≤3 行）

0.2.0：三页（便签 / 本周 / 简报）+ 固定「☰ 菜单」+ 简报自动生成 + 永久 token 台账 + 待验收徽章 + **诊断抽屉**。
宿主测试 45 passed、面板 86 passed。日常在用，画布 39 张卡。

## 持有者的判断（谁接手都按这个来）

- 产品只服务「本人 + 本机 + 本会话历史」，不扩成团队工具。
- **承诺必须可自证**：插件看不到真实浏览器，任何"跳转/写入"类功能都要给出可复制的诊断证据（CHARTER G6/A5）。
- UI 改动一律先过无头挂载（只证明结构），**真机行为由用户一次点击确认**，不要再靠猜。

## 接口面现状

工具 8 个、配置键仅 `dataDir`、数据落 `~/.dsh/secretary/`；新增只读路由 `GET /diag`（诊断，不含用户数据实体）。
会话解析 POST `/session/adopt`（建/找工作区 + attach）与 GET `/session/resolve` 属于**内部辅助接口**，不进 CHARTER 第 5 节的对外契约。

## 进行中

- 无代码改动未提交。

## 下一步（新会话从这里接）

1. **R3 画布收敛**：完成超过 14 天的卡自动进「归档」，画布只留在办与近期完成。
2. **R4 发布**：npm 发布 0.2.0、CI 落地（.github/workflows/ci.yml 已有，缺 push 权限的 token）、补 CHANGELOG。
3. 真机回归：跳转（有序工作区 / 未登记工作区两条路径）由用户各点一次确认。

## 已知坑 / 红线

- 数据目录默认 `~/.dsh/secretary/`；改 `dataDir` 后必须重启 DSH。
- `briefs/` 会清理（90 天），`cumulative.json` 永不清理。
- 拉取会话卡不覆盖用户手改文本（C2）；长文本显式报错（N4）。
- **`uiWorkspace.openSession` 语义**：内部是 `sessions.retain()`，未知 id 会抛错、不会造空白会话；会造空白会话的是 `openWorkspace()`（nv 里叫 connectBlank）。改跳转前先看 `docs/CHARTER.md` 第 10 节「宿主事实」。

## 最近一次验证

- `node --test test/*.test.mjs` → 45 passed / 0 failed
- 面板无头挂载 → 86 passed（`/tmp/wb-run` + `WB_BUNDLE=lib/client.js`）
- 线上：`/board` `/weekly` `/cumulative` `/briefs` 全部 200，均在 5ms 内
