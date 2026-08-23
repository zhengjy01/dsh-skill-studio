# dsh-skill-studio

> [**English**](README.md) | **中文**

在 Web 设置面板中可视化、编辑和管理 DeepSeek Harness 的 **skill（技能）**：列出 DSH 发现到的全部 skill，查看完整 `SKILL.md`，直接编辑正文，一键启用/禁用模型与用户调用。

## 功能

- **Skill 管理器设置面板** — 设置 → Skill 管理器：列出全部 skill（名称、描述、来源根、嵌套标记、模型/用户可调用状态）；点开任意 skill 查看完整正文、就地编辑 SKILL.md 文件；用开关切换 启用 / 模型可调用 / 用户可调用。
- **skillmgr_list** — 列出全部已发现 skill（含来源、嵌套标记与调用状态）。
- **skillmgr_get** — 查看单个 skill 的完整详情（正文 + 路径 + 策略）。
- **skillmgr_save** — 保存全文编辑（frontmatter + Markdown）写回文件。
- **skillmgr_policy** — 设置启用/禁用（`enabled` 总开关，或按接口单独设 `modelInvocable` / `userInvocable`）。
- **双源合并**：① 直接扫描标准 skill 根目录（项目 `.dsh/skills` / `.agents/skills`、用户 `~/.dsh/skills` / `~/.agents/skills`），并展开一层嵌套 bundle（如 `~/.agents/skills/superpowers/<name>`），面板上标记为「嵌套」；② 合并官方注册表（`ctx.skills`）里的 runtime / bundled skill。因此面板能看到磁盘上全部 skill —— 即使宿主层的 filesystem 提供方被禁用（web 架构按设计将本地发现放在 agent preset 层）。
- 启用/禁用通过对 frontmatter 的 `disable-model-invocation` / `user-invocable` 两行做行级精确修改实现；其余 frontmatter 行原样保留。保存后 DSH 自动重新发现。
- 只读安全：只有带真实文件路径（文件系统来源）的 skill 可编辑；runtime / bundled skill 显示为只读。路由仅限回环访问。

## 安装

```sh
# 本地开发
dsh plugin --profile web add link:/path/to/dsh-skill-studio

# GitHub 发布后（仓库带 dsh-plugin topic）
dsh plugin --profile web add github:zhengjy01/dsh-skill-studio
```

重启 `dsh web` 生效。插件无需构建 —— `lib/` 是纯 ESM。

## 使用

在 Web 设置页（设置 → Skill 管理器）你可以：

- 浏览完整 skill 目录（来源徽章 + 调用状态）；
- 点开 skill 阅读正文并编辑（textarea），点「保存」写回文件；
- 切换 启用 / 模型可调用 / 用户可调用 开关。

也可以直接对 Agent 说：

```text
列出所有 skill，并告诉我哪些被禁用了
帮我禁用 session-knowledge 技能
```

Agent 会使用 `skillmgr_*` 工具完成。

## 说明

- frontmatter 的 `name` 字段必须与 skill 名一致（kebab-case）；破坏 frontmatter 格式可能导致该 skill 在重新发现时被跳过。
- 编辑范围严格限于 skill 注册表返回的文件；插件不接受任意路径写入。
- 除 DSH peer 包外零运行时依赖。

## License

MIT
