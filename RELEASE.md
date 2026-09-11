# DSH 插件发布 SOP（版本纪律 · 分档 · 弃用）

> 适用：本机所有 `dsh-*` 插件仓库（`~/Documents/DSH /DSH-test/<repo>`）。
> 配套工具：`scripts/release.mjs`（本 SOP 的纪律部分已写成脚本硬门禁）。
> 知识库镜像：`2️⃣ AI/Sop/dsh插件发布-SOP.md`（npm/GitHub/聚合平台全流程）+ `2️⃣ AI/Deepseek harness/主题知识/DSH 插件版本与兼容策略.md`。

---

## 0. 一句话结论

npm **永久保留旧版本**，「保留旧版本」是免费的、不需要任何策略。
真正要补的只有三件事：**版本纪律**（别把 breaking 当 patch 发）+ **分发分档**（dist-tag）+ **破坏性变更沟通**（CHANGELOG / Release 迁移说明）。

按版本 fork 包名、为每个版本预先建维护分支、指望「旧包还在」当兼容方案 —— **都不做**。

---

## 1. 唯一真会坑到人的场景

> 把破坏性变更当 patch 发：`0.2.0` → `0.2.1`（其实是 breaking）
> → 所有依赖写 `^0.2.0` 的用户自动升到坏版本。

原因（semver 的 0.x 规则）：

| 依赖范围 | 实际等价 | 会不会自动跨 minor |
|---|---|---|
| `^0.2.0` | `>=0.2.0 <0.3.0` | **不会**（0.x 阶段 `^` 不跨 minor） |
| `^0.2.1` | `>=0.2.1 <0.3.0` | 不会 |
| `^1.2.3` | `>=1.2.3 <2.0.0` | 会跨 minor，不跨 major |

**推论：0.x 阶段把破坏性变更放进 minor（`0.2.x` → `0.3.0`），就天然兼顾了还在用旧版的人** —— 他们的 `^0.2.0` 根本不会自动跨到 `0.3.0`。

**铁律：patch 只装修复，绝不装 breaking。**
`release.mjs` 会扫描提交，检测到 `feat!:` / `BREAKING CHANGE:` 时直接拒绝任何 patch 档发布。

---

## 2. 版本纪律（写进 checklist 的硬规则）

| 变更性质 | 0.x 阶段（当前所有插件） | 1.x+ 阶段 | 例子 |
|---|---|---|---|
| 破坏性变更（BREAKING） | **minor** `0.2.0 → 0.3.0` | **major** `1.4.2 → 2.0.0` | 改工具名/删配置字段/改路由前缀 |
| 新功能 | minor `0.2.0 → 0.3.0` | minor `1.4.0 → 1.5.0` | 新增 `dispatcher_report` |
| 修复 / 内部重构 | patch `0.2.0 → 0.2.1` | patch `1.4.2 → 1.4.3` | 修 ENOENT、修 401 |
| 预发布 | `0.3.0-rc.1`（dist-tag **next**） | 同 | 大改先发 rc 给人试 |

判定 breaking 的信号（脚本按这套识别）：
- 提交标题里 `type!:`，如 `feat!: drop skillmgr_mirror`
- 提交正文含 `BREAKING CHANGE:` / `BREAKING-CHANGE:`

> 补充：**语义上的破坏性变更即使没写 `!` 也算 breaking**。改名、删字段、改默认值、改工具名，提交时务必带 `!`，否则纪律门禁认不出来。

---

## 3. dist-tag 分档

现状问题：两个包都**只有 `latest` 一个 dist-tag**，没有分档。补法：

| dist-tag | 指向 | 谁来装 | 发布命令 |
|---|---|---|---|
| `latest` | 稳定线最新正式版 | 普通用户（默认） | `release.mjs --bump auto --publish --yes` |
| `next` | 预发布（rc/beta） | 愿意试新的人 | `release.mjs --pre rc --bump minor --publish --yes` |
| `0-1`（维护线标签，`<major>-<minor>`） | `0.1.x` 线上最新的补丁 | 明确要留在旧 minor 的人 | `release.mjs --line 0.1 --bump patch --publish --yes` |

用户侧的对应装法：

```bash
# 默认拿 latest
dsh plugin --profile web add dsh-task-dispatcher

# 留在旧 minor 线上（拿该线最新补丁，不会被卷进 0.2/0.3 的破坏性变更）
dsh plugin --profile web add dsh-task-dispatcher@0-1     # dist-tag
dsh plugin --profile web add dsh-task-dispatcher@0.1.x   # 等价的范围写法

# 试预发布
dsh plugin --profile web add dsh-task-dispatcher@next

# 钉死精确版本
dsh plugin --profile web add dsh-task-dispatcher@0.1.4
```

> ⚠️ **profile 里写进去的范围是 `^x.y.z`，不是精确版本** —— 详见 §7。

---

## 4. 旧版本维护 = 按需开分支，不预先维护

- **不**给每个历史版本开分支。
- 有人反馈 bug / 有安全问题时，才从对应 tag 开一条维护线：
  ```bash
  git checkout -b release/0.1 v0.1.4
  # cherry-pick 修复
  git cherry-pick <fix-sha>
  node scripts/release.mjs --line 0.1 --bump patch --publish --yes
  ```
- 维护线发布只允许 **patch 档**（`--line` 模式下脚本仍会拒绝 breaking）。
- 没人反馈的旧版本就静静躺在 npm 上，成本为零。

---

## 5. 只弃不删

坏版本（发出去才发现有坑）的处理：

| 动作 | 做不做 | 说明 |
|---|---|---|
| `npm deprecate <pkg>@<ver> "<原因>"` | ✅ 做 | 版本仍可安装，安装时显示弃用警告；这是标准做法 |
| `npm unpublish` | ❌ 不做 | 破坏别人的 lockfile、npm 也有 72h 限制，属于核选项 |
| 发一个修复版 patch | ✅ 做 | 弃用 + 新版本一起上，让 `^` 用户自然升到修好的版本 |

```bash
node scripts/release.mjs --deprecate 0.2.1 "有严重 bug（#12），请升 0.2.2" --publish
```

> 注意：`--deprecate` 也要 `--publish`，否则只预演。

---

## 6. 兼容性声明前置（让不兼容在安装时报错，而不是静默坏）

三层都要写，各管一段：

| 字段 | 谁读它 | 作用 |
|---|---|---|
| `engines.node` | npm / pnpm | Node 版本不匹配时安装报错 |
| `dsh.engines.dsh` | 生态惯例（人 / 部分工具） | 声明支持的 DSH 区间 |
| `peerDependencies` 里所有 `@deepseek-ai/dsh*` | **dshmarket（插件市场）** | 市场显示的兼容范围，**实际生效的兼容判定** |

实证结论（2026-09-11）：`dshmarket` 读的是所有 `@deepseek-ai/dsh*` 的 peer **并集**，`dsh.engines.dsh` 它完全看不见。所以要让市场显示「兼容最新版」，**必须改 peer 范围**：

```json
"peerDependencies": {
  "@deepseek-ai/dsh-tools": "^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1"
}
```

> 退役包（`@deepseek-ai/dsh-client-runtime` / `dsh-client-ui-slots`）要清掉 peer，只在 devDependencies 保留。
> `release.mjs --check` 会检查这三层是否齐备。

---

## 7. 【已确证】`dsh plugin add` 写进 profile 的依赖范围

**答案：默认写 `^x.y.z`（caret），不是精确钉版；只有加 `-E/--save-exact` 才精确。**

证据链（2026-09-11 本机实测）：

1. `dsh plugin` 是 **pnpm 的薄转发器**。`@deepseek-ai/dsh/lib/plugin-Ddi42qoW.js`：
   ```js
   spawnSync("pnpm", args.map(a => anchorPathSpec(a, process.cwd())), { cwd: profileDir, ... })
   ```
   即 `dsh plugin --profile web add <pkg>` ≡ 在 `$DSH_HOME/profiles/web` 里跑 `pnpm add <pkg>`。
   写进 `package.json` 的 **范围字符串完全由 pnpm 决定**，dsh 不参与。`~/.npmrc` / profile `.npmrc` 都没有 `save-prefix`/`save-exact`，所以走 pnpm 默认值 `^`。

2. 实测（临时目录 `pnpm add`，pnpm 11.21.0）：

   | 命令 | 写进 package.json 的 |
   |---|---|
   | `pnpm add dsh-skill-studio` | `^0.2.0` |
   | `pnpm add dsh-task-dispatcher@0.1.3` | `^0.1.3` |
   | `pnpm add dsh-task-dispatcher@=0.1.2` | `^0.1.2`（`=` 没用） |
   | `pnpm add dsh-task-dispatcher@~0.1.1` | `^0.1.2`（被归一化成 `^`） |
   | `pnpm add dsh-task-dispatcher@0.1.2 -E` | `0.1.2`（**只有 `-E` 精确**） |

3. **对老用户重装的直接结论**：
   - profile 里写的是 `^0.x.y` → **重装会在同一 minor 内自动吃到后续 patch**。
   - 所以 `0.2.0 → 0.2.1` 的 breaking patch 一定会命中所有 `^0.2.0` 用户；而 `0.2.0 → 0.3.0` 的 breaking 不会（`^` 在 0.x 不跨 minor）。
   - profile 有 `pnpm-lock.yaml` 钉住精确版本：**不重装就不动**；一旦重装 / 换机 / 重新 `dsh plugin add`，就按 `^` 重新解析。

4. **额外发现（pnpm 11 的供应链默认值，会影响"什么时候吃到新版"）**：
   pnpm 11 起 `minimumReleaseAge` 默认 **1440 分钟（1 天）**，新发布的版本不满 24h 不会被选中：

   | 场景 | 实测结果 |
   |---|---|
   | 范围内有「成熟」版本 | 选**最新成熟版**，不发警告（例：`^0.1.0` 在 0.1.1–0.1.4 均 <24h 时解析到 `0.1.0`） |
   | 范围内全是新鲜版本 | 回退到**区间下界**并写入 `minimumReleaseAgeExclude`（例：`^0.1.2` 解析到 `0.1.2`，profile 的 `pnpm-workspace.yaml` 自动追加 `dsh-task-dispatcher@0.1.2`） |

   → **这不构成保护**：breaking patch 发布满 24h 后，`^` 用户下次重装照样吃到。它只是把「立刻中招」变成「第二天中招」，纪律不能省。
   → 发布后要验证「用户装得到」，别在发布后 24h 内就断言"装不上=没发成功"。

---

## 8. 发布 checklist

### 8.0 前置（代码侧）

- [ ] 提交信息用 conventional commits；**破坏性变更一定带 `!`** 或正文写 `BREAKING CHANGE:`
- [ ] `package.json`：`engines.node` / `dsh.engines.dsh` / `@deepseek-ai/dsh*` peer 并集 三层齐备
- [ ] `files` 含 `lib`、`cordis.patch.yml`、`CHANGELOG.md`
- [ ] `cordis.patch.yml` 的 `name:` 与包名一致（改名最易漏这里）
- [ ] README 双语（`README.md` / `README.zh.md`），Compatibility 小节写清最低 + 实测通过版本
- [ ] 工作区干净（`git status` 无改动）

一条命令跑完：

```bash
node scripts/release.mjs --check
```

### 8.1 预演

```bash
node scripts/release.mjs --bump auto          # 默认就是 dry-run，不写任何东西
```
看它推出来的目标版本与 dist-tag 是否符合预期。

### 8.2 正式发布（**需用户明确说「发布」**）

```bash
node scripts/release.mjs --bump auto --publish --yes
```

脚本按序执行：纪律校验 → 拒绝已存在的版本 → `CHANGELOG.md` 补写 → bump `package.json` → 构建 → `git commit/tag/push --follow-tags` → `npm publish --tag <分档>` → 聚合同步。

### 8.3 发布后（必做）

- [ ] **验证真发出去**：`curl -s https://registry.npmjs.org/<pkg> | node -e "…"` 看 `dist-tags`；注意可能返回 202「being processed」，等 2–3 分钟，别急着重发（会 409）
- [ ] **破坏性版本**：GitHub Release 写迁移说明（用户要改什么），内容与 CHANGELOG 的「迁移说明」段落一致
- [ ] 校验用户装法：`dsh plugin --profile web add <pkg>@<ver>` / `@next` / `@0-1`
- [ ] 同步聚合平台（见 `Standards/DSH插件发布标准清单.md` 阶段 3）
- [ ] 回填 Obsidian 项目档案 + 日报；同步滴答清单待办
- [ ] 本机 profile 升级（可选）：`dsh plugin --profile web add <pkg>@<ver>`，**重启 dsh web 需用户同意**

---

## 9. 回滚流程

| 情况 | 处置 |
|---|---|
| 发布物本身坏了（tarball 缺文件） | 弃用该版本 + 立刻发 patch |
| 功能有坑但可用 | 发 patch 修；坑较大则先 `deprecate` 再修 |
| 破坏性变更放错档位（危机） | ① `deprecate` 该版本；② 0.x 把修复（或回滚）作为 **minor** 发；③ README/Release 写明 |
| 已经发成 `latest` 且很严重 | `npm deprecate <pkg>@<ver> "<原因>，请装 <pkg>@<好版本>"`；**不要** unpublish |
| 想临时把 latest 指回旧版 | `npm dist-tag add <pkg>@<好版本> latest`（dist-tag 可移动，版本不可删） |

---

## 10. 不做清单

- ❌ 按版本 fork 包名（`dsh-foo-v2`）
- ❌ 为每个版本预先建维护分支
- ❌ 只靠「旧包还在 npm 上」当兼容方案
- ❌ 用 `unpublish` 处理坏版本
- ❌ 让别人 `-E` 精确钉版来获得安全感（范围该由我们保证语义正确）

---

## 11. 现状快照（2026-09-11）

| 包 | 已发布版本 | dist-tag | 缺什么 |
|---|---|---|---|
| `dsh-skill-studio`（源码目录 `dsh-skill-manager`） | 0.1.1 / 0.1.2 / 0.2.0 | `latest` 0.2.0 | 缺 `dsh.engines.dsh`、CHANGELOG、分档 |
| `dsh-task-dispatcher` | 0.1.0 / 0.1.1 / 0.1.2 / 0.1.3 / 0.1.4 | `latest` 0.1.4 | 缺 CHANGELOG、分档 |

> 两个仓库都还没有 git tag —— 建议从下一个版本起由 `release.mjs` 自动打 `vX.Y.Z` tag，
> 这样「自上次发布以来的提交」才准确（无 tag 时脚本按全量历史分析，会保守地要求 minor）。
