# 发布流程 · dsh-secretary

> 维护者操作手册。目标：**任何一次发布都能复现，且发布物在装机前已被验证。**

## 0. 前置

```bash
node --version          # 需要 >= 22
npm whoami              # 必须是能发 @cozcc 作用域外包（本包无 scope）的账号
gh auth status          # 需要 repo + workflow（CI 文件在 .github/）
```

未登录时：`npm login`（浏览器/终端一次性动作，无法由代理代做）。

## 1. 版本与记录

```bash
# 1) 改 package.json 的 version（语义化版本）
# 2) CHANGELOG.md 顶部加一节，写清 新增 / 变更 / 修复 / 工程
# 3) docs/ITERATIONS.md 追加一条 IT，更新 docs/STATUS.md
```

## 2. 本地验证（缺一不可）

```bash
node build-client.mjs                      # 必须出现「✓ 宿主自检通过」
node --test test/*.test.mjs                # 宿主测试全绿
cd /tmp/wb-run && cp <repo>/test/panel.render.mjs ./probe.mjs \
  && WB_BUNDLE=<repo>/lib/client.js node probe.mjs   # 面板回归全绿
```

`lib/` 必须与 `src/` 同步提交；CI 会用 `git diff --exit-code -- lib/` 拦截忘记重建的情况。

## 3. 打包自检（发前最后一道门）

```bash
npm pack                      # 生成 dsh-secretary-<version>.tgz
mkdir -p /tmp/pkgtest && cd /tmp/pkgtest
npm i ./dsh-secretary-<version>.tgz
node --input-type=module -e "import * as m from 'dsh-secretary'; console.log(typeof m.apply)"
```

检查点：

- `lib/index.js`、`lib/client.js`、`cordis.patch.yml`、`icon.svg`、`locale/*.json`、`docs/`、`CHANGELOG.md` 都在包里
- 主入口能 import，且 `apply` 是函数
- `package.json` 里没有 `private: true`

## 4. 发布

```bash
npm publish --access public          # prepublishOnly 会自动 build + 跑宿主测试
git push && gh run list --limit 1    # 确认 CI 绿
```

## 5. 发布后

```bash
dsh plugin add dsh-secretary         # 用发布物真装一次（会落到 desktop profile）
```

装完在面板里确认：便签页能开、`菜单 → 诊断` 版本号与发布版本一致、`/board` 返回 200。

## 回滚

```bash
npm deprecate dsh-secretary@<bad> "改用 <good>"
npm publish                            # 用更高 patch 版本发修复
```
