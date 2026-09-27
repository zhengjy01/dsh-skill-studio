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

1. Add the plugin to your profile:

   ```sh
   # from npm
   dsh plugin --profile web add dsh-skill-studio

   # or from GitHub (the repo carries the `dsh-plugin` topic)
   dsh plugin --profile web add github:zhengjy01/dsh-skill-studio
   ```

   Expected: the command prints the resolved package and records it in that
   profile's `dsh.profile.bundles` (the host only loads plugins listed there).

   > **Screenshot slot 1 — install output.** Capture the terminal right after the
   > command, last ~10 lines (resolved package + profile path). Redact your
   > username / home path if it appears. Save as
   > `docs/images/dsh-skill-studio-1-install.png`, then replace this block with
   > `![Install output](docs/images/dsh-skill-studio-1-install.png)`.

2. Restart `dsh web` (or use the sidebar **重启 / Restart** entry if the
   `dsh-restart` plugin is installed).

   Expected: the host boots with `dsh-skill-studio` in its plugin list. There is
   no build step — `lib/` is plain ESM.

3. Open the Web GUI → **设置 (Settings)** → **Skill 工作台**.

   Expected: the settings nav shows the "Skill 工作台" entry, and the panel lists
   every discovered skill with a source badge and its invocation state.

   > **Screenshot slot 2 — panel is live.** Capture the settings nav (entry
   > visible) plus the panel header and list. Redact any skill names you consider
   > private. Save as `docs/images/dsh-skill-studio-2-panel.png`.

## Usage

1. Click a skill in the list.

   Expected: the detail view shows that skill's body plus its source and path.

2. Edit the body in the textarea, then click **保存 / Save**.

   Expected: the panel reports a successful write, and the skill's `SKILL.md` on
   disk now contains your text.

   > **Screenshot slot 3 — editing works.** Capture the detail view with the
   > editor open; use a non-sensitive skill (or blur its content). Save as
   > `docs/images/dsh-skill-studio-3-edit.png`.

3. Flip the **启用 / 模型可调用 / 用户可调用** switches.

   Expected: the row's state changes immediately and stays changed after a
   refresh (the switch writes `disable-model-invocation` /
   `user-invocable` into the frontmatter).

   > **Screenshot slot 4 — switches take effect.** Capture the list row with one
   > switch off, then the same row after a page refresh. Save as
   > `docs/images/dsh-skill-studio-4-switches.png`.

4. Or just tell your agent:

   ```text
   列出所有 skill，并告诉我哪些被禁用了
   帮我禁用 session-knowledge 技能
   ```

   Expected: the agent answers through the `skillmgr_*` tools.

### Screenshots to add

| # | Where | What it shows | How to capture | Suggested filename |
| --- | --- | --- | --- | --- |
| 1 | Install | The install command's output (package + profile) | Terminal right after step 1, last ~10 lines; redact home path | `docs/images/dsh-skill-studio-1-install.png` |
| 2 | Install | The panel open in Settings with the skill list | Settings → Skill 工作台; include the nav entry | `docs/images/dsh-skill-studio-2-panel.png` |
| 3 | Usage | Editing a skill body and saving | Detail view with the textarea open; use a non-sensitive skill | `docs/images/dsh-skill-studio-3-edit.png` |
| 4 | Usage | The three switches after a refresh | Same row before/after refresh | `docs/images/dsh-skill-studio-4-switches.png` |

After adding the images, re-run `npm pack --dry-run` and the portability gate
(`npm run verify`) — the README is part of the published tarball.

## Notes

- The frontmatter `name` key must match the skill name (kebab-case); breaking the frontmatter format may cause DSH to skip the skill on rediscovery.
- Editing is scoped to files the skill registry reports; the plugin never accepts arbitrary paths.
- Zero runtime dependencies beyond the DSH peer packages.

## License

MIT
