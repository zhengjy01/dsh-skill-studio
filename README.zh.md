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

1. 把插件装进你的 profile：

   ```sh
   # 从 npm 安装
   dsh plugin --profile web add dsh-skill-studio

   # 或从 GitHub 安装（仓库带 dsh-plugin topic）
   dsh plugin --profile web add github:zhengjy01/dsh-skill-studio
   ```

   **预期结果**：命令打印解析到的包名，并把它写进该 profile 的
   `dsh.profile.bundles`（宿主只加载这个清单里的插件）。

   > **截图位 1 —— 安装输出。** 怎么截：命令执行完立刻截终端最后约 10 行（解析到的
   > 包名 + profile 路径）。要不要打码：出现你的用户名 / 家目录路径就打码。
   > 文件名建议 `docs/images/dsh-skill-studio-1-install.png`，补图后把本段替换成
   > `![安装输出](docs/images/dsh-skill-studio-1-install.png)`。

2. 重启 `dsh web`（装了 `dsh-restart` 插件时，也可直接点侧边栏 **重启**）。

   **预期结果**：宿主启动后插件列表里有 `dsh-skill-studio`。无需构建 —— `lib/`
   是纯 ESM。

3. 打开 Web 界面 → **设置** → **Skill 工作台**。

   **预期结果**：设置导航里出现「Skill 工作台」，面板列出所有已发现的 skill，
   每条带来源徽章与调用状态。

   > **截图位 2 —— 面板已就绪。** 怎么截：设置导航（露出入口）+ 面板标题与列表
   > 一起截。要不要打码：你觉得私密的 skill 名打码。文件名建议
   > `docs/images/dsh-skill-studio-2-panel.png`。

## 使用

1. 点列表里的任意一个 skill。

   **预期结果**：详情页显示该 skill 的正文、来源与文件路径。

2. 在文本框里编辑正文，点 **保存**。

   **预期结果**：面板提示写入成功，磁盘上该 skill 的 `SKILL.md` 已是新内容。

   > **截图位 3 —— 编辑生效。** 怎么截：详情页 + 编辑框打开的状态；建议挑一个
   > 不敏感的 skill（或把内容模糊掉）。文件名建议
   > `docs/images/dsh-skill-studio-3-edit.png`。

3. 切换 **启用 / 模型可调用 / 用户可调用** 三个开关。

   **预期结果**：该行状态立即变化，刷新页面后仍然保持（开关会把
   `disable-model-invocation` / `user-invocable` 写进 frontmatter）。

   > **截图位 4 —— 开关真的写进去了。** 怎么截：同一行「关掉某个开关」与「刷新后
   > 仍是关的」两张。文件名建议 `docs/images/dsh-skill-studio-4-switches.png`。

4. 也可以直接对 Agent 说：

   ```text
   列出所有 skill，并告诉我哪些被禁用了
   帮我禁用 session-knowledge 技能
   ```

   **预期结果**：Agent 通过 `skillmgr_*` 工具回答。

### 补图清单

| # | 放在哪 | 展示什么 | 怎么截 | 建议文件名 |
| --- | --- | --- | --- | --- |
| 1 | 安装 | 安装命令的输出（包名 + profile） | 第 1 步执行后立刻截终端最后约 10 行；家目录打码 | `docs/images/dsh-skill-studio-1-install.png` |
| 2 | 安装 | 设置页里打开的面板与 skill 列表 | 设置 → Skill 工作台，带上导航入口 | `docs/images/dsh-skill-studio-2-panel.png` |
| 3 | 使用 | 编辑 skill 正文并保存 | 详情页 + 编辑框打开；挑不敏感的 skill | `docs/images/dsh-skill-studio-3-edit.png` |
| 4 | 使用 | 三个开关刷新后仍生效 | 同一行刷新前后各一张 | `docs/images/dsh-skill-studio-4-switches.png` |

补图后请重跑 `npm pack --dry-run` 与可移植性门禁（`npm run verify`）——README 属于
发布物。

## 说明

- frontmatter 的 `name` 字段必须与 skill 名一致（kebab-case）；破坏 frontmatter 格式可能导致该 skill 在重新发现时被跳过。
- 编辑范围严格限于 skill 注册表返回的文件；插件不接受任意路径写入。
- 除 DSH peer 包外零运行时依赖。

## License

MIT
