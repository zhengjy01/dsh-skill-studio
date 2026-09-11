# Changelog

> `dsh-skill-studio` 的全部版本变更。本文件由 `scripts/release.mjs` 在发布时自动补写。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
> 说明：0.2.0 及更早的条目依据 git 历史与 npm 发布时间回填。

## [Unreleased]

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
