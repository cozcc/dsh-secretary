# 迭代记录 · dsh-secretary

> 规则：**只追加，不改历史条目；最新在最下面；编号全局递增不回收。**
> 一条 IT = 一次可验收的交付（不是一次提问、不是一次会话）。一条 ≤20 行。
> 七个字段缺一不可：版本 / 目标 / 改动 / 决策 / 接口面 / 验证 / 遗留。
> 立项前的历史不回填（`git log` 负责），从立项后开始记。

<!-- ↓↓↓ 复制下面这段，编号 +1，放在文件末尾 ↓↓↓

## IT-002 · YYYY-MM-DD · <一句话标题>

- 版本：dsh-secretary <x.y.z> @ <commit>
- 目标：<解决什么问题，对应 CH 的哪条目标/验收>
- 改动：<文件或模块清单>
- 决策：<关键取舍 + 理由；没有写"无">
- 接口面：无变化 / <具体变化，已同步 CHARTER 第 5 节>
- 验证：`<命令>` → <结果>；<手动验证>
- 遗留：<没做完的、新发现的坑；没有写"无">

-->

## IT-001 · 2026-11-22 · 立项

- 版本：dsh-secretary 0.1.0 @ 5d44a0e
- 目标：为长期迭代建立合同、状态快照与台账，让后续会话不读历史也能接手（对应 skill `project-lifecycle`）
- 改动：新增 `AGENTS.md`、`docs/CHARTER.md`、`docs/STATUS.md`、`docs/ITERATIONS.md`
- 决策：文档只保留三个文件（合同 / 快照 / 台账）——多文件维护成本高，且 STATUS 与 ITERATIONS 职责不同，合一会导致"要么丢历史、要么每次读全文"
- 接口面：首次登记 8 个工具 + `dataDir` + 数据文件 + 宿主依赖，见 CHARTER 第 5 节；**未改任何代码**
- 验证：`node --test test/*.test.mjs` → 44 passed / 0 failed @ HEAD 5d44a0e；`ls docs/` 三文件齐备
- 遗留：无

## IT-002 · 2026-11-24 · 对齐分层读取（纯文档迭代，无代码变更）

- 版本：dsh-secretary 0.1.0 @ 5d44a0e（无代码变更，仅 AGENTS.md 与 STATUS）
- 目标：与全局标准一致——例行接手只读 L1（STATUS + 最后 2 条 IT），不再每次必读 CHARTER；
  同时把三条红线提进 L0，保证"降级读取"不丢约束
- 改动：AGENTS.md（读取层级与红线）、docs/STATUS.md
- 决策：红线必须常驻 L0。L2 改为按需后，不变量若只写在 CHARTER 里，新会话可能在看它之前就动手
- 接口面：无变化
- 验证：`node ~/.agents/skills/project-lifecycle/scripts/check.mjs .` → 通过（2 条 IT，0 错误）；
  实测 L0+L1 = 3925 字符，旧规则 4598 字符（-15%），且 CHARTER（2491 字符）移出例行路径
- 遗留：其余 4 个已立项项目还没做红线前置，等各自下次迭代顺带做

## IT-003 · 2026-11-26 · 交接复盘：把"跳转"从猜改成可验证，并加诊断

- 版本：dsh-secretary 0.2.0 @ HEAD
- 目标：持有者复盘整个项目后重排优先级；修掉反复返工的跳转问题；建立"承诺可自证"的机制（CHARTER G6）
- 改动：`src/http.mjs`（新增 `GET /diag`、`PLUGIN_VERSION`）；`src/client.mjs`（跳转改为 openSession 优先、失败才收编；菜单加「? 诊断」抽屉；记录最近一次跳转结果）；`test/http.test.mjs`、`test/panel.render.mjs`；`docs/CHARTER.md`（新增 G6/A5/N6 与「宿主事实」节）；版本 0.2.0
- 决策：
  1. 跳转先调 `uiWorkspace.openSession`，**不再预先用 `sessions.binding()` 判断**——该接口对冷会话为空，是我们连续误判的根源；
  2. 读 DSH 源码确认 `openSession` = `retain()`，未知 id 抛错、不造空白会话；造空白会话的是 `openWorkspace/connectBlank`，上一版在 openSession 前调它是真凶；
  3. 面板加「诊断」抽屉，把能力面/数据规模/最近一次跳转结果一次取全，替代"口述现象"；
  4. 放弃在无头环境里证明真机导航，改为结构与诊断可证据 + 用户一次点击确认。
- 接口面：新增只读路由 `GET /diag`（新增，不改既有路由语义）；版本 minor bump 到 0.2.0；CHARTER 第 2/3/4 节新增条目已按改版流程记录
- 验证：`node --test test/*.test.mjs` → 45 passed；面板无头 → 86 passed；线上 `/diag` 返回版本与 counts
- 遗留：跳转两条路径未在真机确认（用户点击后方可收口）；R3 归档页、R4 npm 发布未开工
