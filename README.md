# dsh-skill-studio

> **English** | [**中文**](README.zh.md)

Visualize, edit and manage DeepSeek Harness **skills** right from the web settings panel — list every skill DSH discovered, view its full `SKILL.md`, edit the body, and enable/disable model & user invocation with a switch.

## Features

- **Skill 管理器 settings panel** — 设置 → Skill 管理器: list every skill (name, description, source root, nested flag, model/user invocation state), open any skill to see its full body, edit the `SKILL.md` file in place, and toggle enable / model-invocable / user-invocable.
- **skillmgr_list** — list all skills with source, nested flag and invocation state.
- **skillmgr_get** — view one skill's full detail (body + path + policy).
- **skillmgr_save** — save a full-body edit (frontmatter + markdown) back to the file.
- **skillmgr_policy** — enable/disable a skill (`enabled` master switch, or per-interface `modelInvocable` / `userInvocable`).
- **Two merged catalogs**: ① direct filesystem scan of the standard roots (project `.dsh/skills` / `.agents/skills`, user `~/.dsh/skills` / `~/.agents/skills`), expanding one level of nested bundles (e.g. `~/.agents/skills/superpowers/<name>` — flagged 嵌套/nested), plus ② the official registry (`ctx.skills`) for runtime / bundled skills. The panel therefore shows every skill on disk even when the host-plane filesystem provider is disabled (the web architecture deliberately moves local discovery to per-agent presets).
- Enable/disable is implemented with line-level frontmatter surgery on `disable-model-invocation` / `user-invocable`; all other frontmatter lines are preserved verbatim. Saves are picked up by DSH on rediscovery.
- Read-only safety: only skills with a real file path (filesystem sources) are editable; runtime / bundled skills are shown as read-only. Routes are loopback-only.

## Install

```sh
# local development
dsh plugin --profile web add link:/path/to/dsh-skill-studio

# after publishing to GitHub (repo tagged with the `dsh-plugin` topic)
dsh plugin --profile web add github:zhengjy01/dsh-skill-studio
```

Restart `dsh web` to activate. No build step — `lib/` is plain ESM.

## Usage

In the web settings page (设置 → Skill 管理器) you can:

- browse the full skill catalog with source badges and invocation state;
- click a skill to read its body and edit it (textarea) → 保存 writes the file back;
- flip 启用 / 模型可调用 / 用户可调用 switches.

You can also just tell your agent:

```text
列出所有 skill，并告诉我哪些被禁用了
帮我禁用 session-knowledge 技能
```

The agent will use the `skillmgr_*` tools.

## Notes

- The frontmatter `name` key must match the skill name (kebab-case); breaking the frontmatter format may cause DSH to skip the skill on rediscovery.
- Editing is scoped to files the skill registry reports; the plugin never accepts arbitrary paths.
- Zero runtime dependencies beyond the DSH peer packages.

## License

MIT
