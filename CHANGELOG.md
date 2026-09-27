# Changelog

> `dsh-skill-studio` 的全部版本变更。本文件由 `scripts/release.mjs` 在发布时自动补写。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
> 说明：0.2.0 及更早的条目依据 git 历史与 npm 发布时间回填。

## [Unreleased]

### 新增 (Added)

- **skill 分组展示（第一期，只读）**：读取 SKILL.md frontmatter 的 `metadata.group` / `metadata.tags`（DSH 官方支持的 `metadata` 载体），Web 面板「Skill 工作台」按分组折叠展示，带筛选框、「按分组 / 平铺」视图切换与未分组区；`skillmgr_list` / `skillmgr_get` 输出新增 `group` / `tags` 字段。**纯展示层，不改变模型加载哪些 skill**。
- `lib/scanner.js` 的 frontmatter 解析器支持**一层嵌套对象**（此前 `metadata:` 的缩进子键会被直接丢弃），并支持内联数组 `[a, b]` 与 `- item` 块列表；解析仍为零依赖、行级。
- 测试新增：嵌套 frontmatter 解析（含 dedent 后继续解析顶层键）、扫描器与详情的分组字段、面板分组渲染冒烟（fake React 驱动真实客户端组件：分组视图 / 平铺视图 / 折叠态）。

## [0.2.2] - 2026-09-27

### 修复 (Fixed)

- **会话扫描判据漏 v3/v4，约 60% 会话日志被静默跳过**：`lib/extractor.js` 此前只认字面量 `session.jsonl.zstd`，而 DSH 现网写入 `session.v3.jsonl.zstd`（0.1.5）/ `session.v4.jsonl.zstd`（0.1.7）——本机 945 个日志里 v3 501 + v4 75 被跳过（≈61%），「会话提取」候选系统性偏少且**不报错**。判据改为与核心 `@deepseek-ai/dsh-session-format` 同源的 `/^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/`，v0/v3/v4… 通吃，版本再升也不会失明。
- **桌面端最小 PATH 下 `zstd` spawn ENOENT**：Finder 启动的 Electron 宿主继承 launchd 的 `/usr/bin:/bin:/usr/sbin:/sbin`，裸调 `zstd` 会失败并被逐文件 catch 静默吞掉。改为 `resolveExecutable()` 解析绝对路径（PATH + `DSH_EXTRA_BIN_DIRS` + `/opt/homebrew/bin` / `/usr/local/bin` / `~/.local/bin`）。
- 非 `.zstd` 的裸 `.jsonl` 直接读，不再无条件过 zstd。

### 其它 (Changed)

- 接入发布前门禁：仓库新增 `scripts/portability.mjs` + `PORTABILITY-SOP.md`，`package.json` 新增 `verify` / `verify:full` / `verify:quick`（健康路由 `/api/dsh-skill-studio/list`）；`scripts/release.mjs` 升级到 dsh-release-kit 版（`files` 覆盖检查改为布局自适应、npm 凭据认 `DSH_HOME`）。

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- DSH peer：`^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1`
- 发布前可移植性验证：✅ 通过（隔离 `DSH_HOME` + tarball 安装 + 15s 稳定性观察）

## [0.2.1] - 2026-09-11

### 修复 (Fixed)

- fix(release): dry-run 不再触发真实 registry 校验；CHANGELOG peer 摘要只列 dsh 包

### 其它 (Changed)

- chore(release): 版本纪律工具链（release.mjs / RELEASE.md / CHANGELOG）+ 补 dsh.engines.dsh
- DSH 0.1.5-rc.1 对齐：devDeps 升级 + 客户端类型改由 cordis/renderer 提供

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`
- DSH peer：^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1

### 其它 (Changed)

- DSH 0.1.5-rc.1 对齐：devDependencies 升级，客户端类型改由 `cordis` / renderer 提供

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`

## [0.2.0] - 2026-08-29

### 新增 (Added)

- 合并「会话提取」能力：用 LLM 从会话日志提取候选 skill（`skillmgr_extract_*` 工具 + 面板待确认卡片）
- 接受的候选 skill 双写：写入 agent 自动加载根（`~/.agents/skills`）+ Obsidian 镜像目录
- 面板扫描支持 per-user 镜像目录（Obsidian skill 库）

### 其它 (Changed)

- 设置面板显示名改为「Skill 工作台」，提取候选卡片置顶
- 语义澄清：agent 根是必需的默认库，镜像目录是可选项
- 可移植性：按用户解析 agent skill 根，去掉硬编码用户路径
- 面板去重：高优先级根已收录时不再重复展示 custom/mirror 副本

### 兼容性 (Compatibility)

- Node：`^22.19.0 || >=24.0.0`
- 注：本版本尚未声明 `dsh.engines.dsh`（下一个版本补）

### 迁移说明 (Migration)

- 无破坏性变更：`0.1.x → 0.2.0` 为纯能力新增，原有 `skillmgr_*` 工具与面板行为不变。

## [0.1.2] - 2026-08-23

### 修复 (Fixed)

- `fix(tools)`：把 null 字段归一为空值，使 `skillmgr_*` 的输出通过 schema 校验

## [0.1.1] - 2026-08-23

### 新增 (Added)

- 首个发布
- 文件系统 skill 扫描器：frontmatter 解析 + 嵌套 bundle 展开
- `skillmgr_*` 宿主工具 + loopback 路由 + 系统提示公告
- 「Skill 工作台」设置面板：列出 / 查看 / 编辑 / 启用禁用 skill
- 测试：启动模拟 + 扫描与读写覆盖
- 双语 README（`README.md` / `README.zh.md`）

### 兼容性 (Compatibility)

- Node：`^22.19.0 || >=24.0.0`
