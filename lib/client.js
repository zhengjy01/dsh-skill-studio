window.__ModuleLoader__.load({
	id: "dsh-skill-studio",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");
		//#region src/client/api.ts
		/** Error carrying the route's JSON error message. */
		var ApiError = class extends Error {
			constructor(message) {
				super(message);
				this.name = "SkillManagerApiError";
			}
		};
		/** Parse a JSON response or throw an ApiError. */
		async function readJson(response) {
			let body;
			try {
				body = await response.json();
			} catch {
				throw new ApiError("HTTP " + response.status + ": invalid JSON response");
			}
			if (!response.ok) {
				throw new ApiError(typeof body === "object" && body !== null && typeof body.error === "string" ? body.error : "HTTP " + response.status);
			}
			return body;
		}
		/** Plain fetch helper with an error wrapper. */
		async function request(path, init) {
			let response;
			try {
				response = await fetch(path, init);
			} catch (error) {
				throw new ApiError("网络请求失败: " + String(error instanceof Error ? error.message : error));
			}
			return readJson(response);
		}
		/** The skill-manager panel API. */
		var Api = class {
			async list() {
				return request("/api/dsh-skill-studio/list");
			}
			async get(name) {
				return request("/api/dsh-skill-studio/skill?name=" + encodeURIComponent(name));
			}
			async save(name, content) {
				return request("/api/dsh-skill-studio/skill", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name, content })
				});
			}
			async setPolicy(name, patch) {
				return request("/api/dsh-skill-studio/policy", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(Object.assign({ name }, patch))
				});
			}
			async extractStatus() {
				return request("/api/dsh-skill-studio/extract-status");
			}
			async extractConfig(patch) {
				return request("/api/dsh-skill-studio/extract-config", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(patch)
				});
			}
			async extractRun() {
				return request("/api/dsh-skill-studio/extract-run", { method: "POST" });
			}
			async extractCandidates() {
				return request("/api/dsh-skill-studio/extract-candidates");
			}
			async extractCandidate(id, patch) {
				return request("/api/dsh-skill-studio/extract-candidate", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(Object.assign({ id }, patch))
				});
			}
			async extractAccept(ids) {
				return request("/api/dsh-skill-studio/extract-accept", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ids })
				});
			}
			async extractReject(ids) {
				return request("/api/dsh-skill-studio/extract-reject", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ids })
				});
			}
		};
		//#endregion
		//#region src/client/SkillManagerPanel.tsx
		/**
		 * Skill 管理器 settings panel — rendered inside the web settings page
		 * (settings.section entry). Lists every discovered skill with its
		 * invocation state, lets the user view/edit the full SKILL.md body, and
		 * toggle enable/disable (model / user invocation). Plain React with
		 * inline styles — no external UI package.
		 */
		/** Module-level API client (stateless; the component closes over it). */
		const api = new Api();
		/** Shortcut for React.createElement. */
		const h = React.createElement;
		/** One shared style sheet (theme-agnostic, mirrors dsh-flomo). */
		const s = {
			card: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				maxWidth: "760px",
				padding: "14px 16px",
				borderRadius: "10px",
				border: "1px solid rgba(128,128,128,0.3)",
				fontSize: "13px",
				color: "inherit"
			},
			title: { fontWeight: 600, fontSize: "13px", margin: 0 },
			status: { fontSize: "12px", opacity: 0.85 },
			statusWarn: { fontSize: "12px", opacity: 0.9, color: "#c9763a" },
			row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
			item: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				padding: "8px 10px",
				borderRadius: "8px",
				border: "1px solid rgba(128,128,128,0.25)",
				background: "rgba(128,128,128,0.05)",
				cursor: "pointer"
			},
			itemSel: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				padding: "8px 10px",
				borderRadius: "8px",
				border: "1px solid rgba(90,140,220,0.6)",
				background: "rgba(90,140,220,0.08)",
				cursor: "pointer"
			},
			itemBody: { flex: 1, minWidth: 0 },
			itemName: { fontWeight: 600, fontSize: "12.5px", margin: 0, wordBreak: "break-all" },
			itemDesc: {
				fontSize: "11.5px",
				opacity: 0.75,
				margin: "2px 0 0",
				overflow: "hidden",
				textOverflow: "ellipsis",
				display: "-webkit-box",
				WebkitLineClamp: 2,
				WebkitBoxOrient: "vertical"
			},
			badge: {
				fontSize: "10.5px",
				padding: "1px 6px",
				borderRadius: "999px",
				border: "1px solid rgba(128,128,128,0.35)",
				whiteSpace: "nowrap"
			},
			badgeOn: {
				fontSize: "10.5px",
				padding: "1px 6px",
				borderRadius: "999px",
				border: "1px solid rgba(90,170,110,0.5)",
				color: "#4c9a63",
				whiteSpace: "nowrap"
			},
			badgeOff: {
				fontSize: "10.5px",
				padding: "1px 6px",
				borderRadius: "999px",
				border: "1px solid rgba(190,110,90,0.5)",
				color: "#b06a55",
				whiteSpace: "nowrap"
			},
			check: { margin: 0, accentColor: "#3b82f6" },
			label: { fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "5px", cursor: "pointer" },
			button: {
				padding: "4px 10px",
				borderRadius: "6px",
				cursor: "pointer",
				border: "1px solid rgba(128,128,128,0.4)",
				background: "rgba(128,128,128,0.14)",
				color: "inherit",
				fontSize: "12px"
			},
			textarea: {
				width: "100%",
				boxSizing: "border-box",
				minHeight: "280px",
				resize: "vertical",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: "12px",
				lineHeight: 1.5,
				padding: "8px 10px",
				borderRadius: "8px",
				border: "1px solid rgba(128,128,128,0.35)",
				background: "rgba(128,128,128,0.08)",
				color: "inherit"
			},
			meta: {
				fontSize: "11.5px",
				opacity: 0.8,
				margin: 0,
				wordBreak: "break-all",
				whiteSpace: "pre-wrap"
			},
			msg: { fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-all", opacity: 0.9 },
			msgErr: { fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#c9763a" },
			flex: { flex: 1 }
		};
		/** Source label map (fall back to the raw source). */
		function sourceLabel(source) {
			const map = {
				"user-agents": "用户 ~/.agents/skills",
				"user-dsh": "用户 ~/.dsh/skills",
				"project-dsh": "项目 .dsh/skills",
				"project-agents": "项目 .agents/skills",
				custom: "自定义目录",
				runtime: "运行时注入",
				bundled: "内置 bundled"
			};
			return map[source] ?? source;
		}
		/** Invocation badge. */
		function InvBadge({ ok, children }) {
			return h("span", { style: ok ? s.badgeOn : s.badgeOff }, children);
		}
		/** Master + per-interface checkboxes for one skill. */
		function PolicyRow({ skill, disabled, onToggle }) {
			const checked = skill.modelInvocable && skill.userInvocable;
			return h(
				"div",
				{ style: s.row },
				h(
					"label",
					{ style: s.label },
					h("input", {
						type: "checkbox",
						style: s.check,
						checked,
						disabled,
						onChange: (event) => onToggle({ enabled: event.target.checked })
					}),
					"启用"
				),
				h(
					"label",
					{ style: s.label },
					h("input", {
						type: "checkbox",
						style: s.check,
						checked: skill.modelInvocable,
						disabled,
						onChange: (event) => onToggle({ modelInvocable: event.target.checked })
					}),
					"模型可调用"
				),
				h(
					"label",
					{ style: s.label },
					h("input", {
						type: "checkbox",
						style: s.check,
						checked: skill.userInvocable,
						disabled,
						onChange: (event) => onToggle({ userInvocable: event.target.checked })
					}),
					"用户可调用"
				)
			);
		}
		/** One skill row in the list view. */
		function SkillRow({ skill, selected, onSelect, onToggle }) {
			const body = [
				h("p", { style: s.itemName, key: "n" }, skill.name),
				h("p", { style: s.itemDesc, key: "d" }, skill.description || "（无描述）")
			];
			const badges = [
				h(InvBadge, { ok: skill.modelInvocable, key: "m" }, "模型" + (skill.modelInvocable ? "✓" : "✗")),
				h(InvBadge, { ok: skill.userInvocable, key: "u" }, "用户" + (skill.userInvocable ? "✓" : "✗")),
				h("span", { style: s.badge, key: "src" }, sourceLabel(skill.source))
			];
			if (skill.nested) {
				badges.push(h("span", { style: s.badge, key: "nest" }, "嵌套（" + (skill.parent ?? "?") + "）"));
			}
			const editable = skill.editable === true;
			return h(
				"div",
				{
					style: selected ? s.itemSel : s.item,
					onClick: onSelect
				},
				h(
					"label",
					{
						style: s.label,
						onClick: (event) => event.stopPropagation()
					},
					h("input", {
						type: "checkbox",
						style: s.check,
						checked: skill.modelInvocable && skill.userInvocable,
						disabled: !editable,
						onChange: (event) => onToggle({ enabled: event.target.checked })
					})
				),
				h("div", { style: s.itemBody }, body),
				h("div", { style: s.row }, badges),
				editable
					? h("span", { style: s.badge }, "可编辑")
					: h("span", { style: s.badgeOff }, "只读")
			);
		}
		/** Inline style for compact single-line inputs in the extractor panel. */
		function smallInput(extra) {
			return Object.assign(
				{ boxSizing: "border-box", padding: "5px 8px", borderRadius: "6px", border: "1px solid rgba(128,128,128,0.35)", background: "rgba(128,128,128,0.08)", color: "inherit", fontSize: "12px" },
				extra || {}
			);
		}
		/** Skill extraction candidates panel (merged from dsh-skill-extractor). */
		function ExtractorPanel() {
			const [view, setView] = React.useState(null);
			const [enabled, setEnabled] = React.useState(true);
			const [intervalMinutes, setIntervalMinutes] = React.useState("1440");
			const [windowDays, setWindowDays] = React.useState("7");
			const [maxCandidatesPerRun, setMaxCandidatesPerRun] = React.useState("3");
			const [skillLanguage, setSkillLanguage] = React.useState("zh");
			const [llmBaseUrl, setLlmBaseUrl] = React.useState("https://api.deepseek.com/v1");
			const [llmApiKey, setLlmApiKey] = React.useState("");
			const [llmModel, setLlmModel] = React.useState("deepseek-chat");
			const [targetDir, setTargetDir] = React.useState("");
			const [candidates, setCandidates] = React.useState([]);
			const [editingId, setEditingId] = React.useState(null);
			const [draft, setDraft] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [msg, setMsg] = React.useState("");
			const [err, setErr] = React.useState("");
			/** Assemble the full SKILL.md text for a candidate (frontmatter + body). */
			const assemble = (c) => {
				const front = "---\nname: " + c.name + "\ndescription: " + (c.description || "") + "\n---\n";
				const body = (c.body || "").startsWith("#") ? c.body : "# " + c.name + "\n\n" + (c.body || "");
				return front + "\n" + body + "\n";
			};
			const load = React.useCallback(async () => {
				try {
					const v = await api.extractStatus();
					setView(v);
					setEnabled(v.enabled !== false);
					setIntervalMinutes(String(v.intervalMinutes ?? "1440"));
					setWindowDays(String(v.windowDays ?? "7"));
					setMaxCandidatesPerRun(String(v.maxCandidatesPerRun ?? "3"));
					setSkillLanguage(v.skillLanguage || "zh");
					setLlmBaseUrl(v.llmBaseUrl || "https://api.deepseek.com/v1");
					setLlmModel(v.llmModel || "deepseek-chat");
					setTargetDir(v.targetDir || "");
					const c = await api.extractCandidates();
					setCandidates((c && c.candidates) || []);
					setErr("");
				} catch (error) {
					setErr("读取提取状态失败: " + String(error instanceof Error ? error.message : error));
				}
			}, []);
			React.useEffect(() => {
				load();
			}, [load]);
			const run = async (action) => {
				setBusy(true);
				setMsg("");
				setErr("");
				try {
					return await action();
				} catch (error) {
					setErr("操作失败: " + String(error instanceof Error ? error.message : error));
					return null;
				} finally {
					setBusy(false);
				}
			};
			const saveConfig = () =>
				run(async () => {
					const patch = {
						enabled,
						intervalMinutes: Number(intervalMinutes) || 0,
						windowDays: Number(windowDays) || 7,
						maxCandidatesPerRun: Number(maxCandidatesPerRun) || 3,
						skillLanguage,
						llmBaseUrl: llmBaseUrl.trim(),
						llmModel: llmModel.trim(),
						targetDir: targetDir.trim()
					};
					if (llmApiKey.trim() !== "") patch.llmApiKey = llmApiKey.trim();
					await api.extractConfig(patch);
					setLlmApiKey("");
					setMsg("配置已保存。");
					await load();
				});
			const runExtract = () =>
				run(async () => {
					const r = await api.extractRun();
					setMsg(r.ok ? r.message : "提取失败: " + r.message);
					await load();
				});
			const openEdit = (c) => {
				setEditingId(c.id);
				setDraft(assemble(c));
				setMsg("编辑候选 " + c.name);
			};
			const saveDraft = () =>
				run(async () => {
					const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(draft);
					let name = "";
					let description = "";
					if (m) {
						const n = /^name\s*:\s*(.+)$/m.exec(m[1]);
						const d = /^description\s*:\s*(.+)$/m.exec(m[1]);
						if (n) name = n[1].trim();
						if (d) description = d[1].trim();
					}
					const body = m ? draft.slice(m[0].length).trim() : draft.trim();
					if (!name) {
						setErr("frontmatter 缺少 name，无法保存草稿。");
						return null;
					}
					const r = await api.extractCandidate(editingId, {
						name: name.replace(/\s+/g, "-").toLowerCase(),
						description,
						body
					});
					setMsg(r.ok ? "草稿已保存。" : "保存草稿失败。");
					setEditingId(null);
					await load();
				});
			const acceptCand = (c) =>
				run(async () => {
					const r = await api.extractAccept([c.id]);
					setMsg("已接受: " + ((r && r.written && r.written.length) ? r.written.join(", ") : "（无写入）"));
					await load();
				});
			const rejectCand = (c) =>
				run(async () => {
					await api.extractReject([c.id]);
					setMsg("已拒绝该候选。");
					await load();
				});
			const status = view
				? "插件" + (view.enabled ? "已启用" : "已禁用") +
					" · " + (view.intervalMinutes === 0 ? "已关闭定时" : "每 " + view.intervalMinutes + " 分钟") +
					" · 窗口 " + view.windowDays + " 天 · LLM " + (view.configured ? "已配置" : "未配置") +
					" · 待确认 " + (view.queued ?? 0) + " 个 · 上次 " + (view.lastRunAt ? view.lastRunAt.replace(/T.*/, "") : "未运行")
				: "加载中…";
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "8px", marginTop: "10px", paddingTop: "10px", borderTop: "1px solid rgba(128,128,128,0.25)" } },
				[
					h("p", { style: s.title, key: "t" }, "会话提取候选（从对话沉淀个人 skill）"),
					h("div", { style: s.status, key: "st" }, status),
					h("div", { style: s.row, key: "cfg1" }, [
						h("label", { style: s.label }, h("input", { type: "checkbox", style: s.check, checked: enabled, onChange: (e) => setEnabled(e.target.checked) }), "启用"),
						h("input", { style: smallInput({ width: "110px" }), placeholder: "间隔(分钟)", value: intervalMinutes, onChange: (e) => setIntervalMinutes(e.target.value) }),
						h("input", { style: smallInput({ width: "100px" }), placeholder: "窗口(天)", value: windowDays, onChange: (e) => setWindowDays(e.target.value) }),
						h("input", { style: smallInput({ width: "110px" }), placeholder: "每次候选数", value: maxCandidatesPerRun, onChange: (e) => setMaxCandidatesPerRun(e.target.value) }),
						h("select", { style: smallInput({ width: "100px" }), value: skillLanguage, onChange: (e) => setSkillLanguage(e.target.value) }, [
							h("option", { value: "zh", key: "zh" }, "正文中文"),
							h("option", { value: "en", key: "en" }, "正文英文")
						])
					]),
					h("div", { style: s.row, key: "cfg2" }, [
						h("input", { style: smallInput({ flex: 1 }), placeholder: "LLM Base URL", value: llmBaseUrl, onChange: (e) => setLlmBaseUrl(e.target.value) }),
						h("input", { style: smallInput({ width: "150px" }), placeholder: "模型", value: llmModel, onChange: (e) => setLlmModel(e.target.value) })
					]),
					h("input", { style: smallInput({ width: "100%" }), key: "key", type: "password", placeholder: "LLM API Key" + (view && view.llmKeyMasked ? "（已保存 " + view.llmKeyMasked + "，留空不变）" : ""), value: llmApiKey, onChange: (e) => setLlmApiKey(e.target.value) }),
					h("input", { style: smallInput({ width: "100%" }), key: "dir", placeholder: "目标 skill 库目录", value: targetDir, onChange: (e) => setTargetDir(e.target.value) }),
					h("div", { style: s.row, key: "btns" }, [
						h("button", { style: s.button, onClick: () => void saveConfig(), disabled: busy }, "保存配置"),
						h("button", { style: s.button, onClick: () => void runExtract(), disabled: busy }, "立即提取"),
						h("button", { style: s.button, onClick: () => void load(), disabled: busy }, "刷新")
					]),
					err !== "" && h("div", { style: s.msgErr, key: "e" }, err),
					msg !== "" && h("div", { style: s.msg, key: "m" }, msg),
					h("p", { style: s.title, key: "chead" }, "待确认候选（" + candidates.length + "）"),
					candidates.length === 0 && h("p", { style: s.status, key: "cempty" }, "暂无候选。点「立即提取」扫描近期会话，LLM 产出的候选会在此列出，可编辑后接受。"),
					candidates.map((c) =>
						editingId === c.id
							? h("div", { key: c.id, style: { display: "flex", flexDirection: "column", gap: "6px" } }, [
									h("p", { style: s.itemName }, c.name),
									h("textarea", { style: s.textarea, value: draft, spellCheck: false, onChange: (e) => setDraft(e.target.value) }),
									h("div", { style: s.row }, [
										h("button", { style: s.button, onClick: () => void saveDraft(), disabled: busy }, "保存草稿"),
										h("button", { style: s.button, onClick: () => setEditingId(null), disabled: busy }, "取消")
									])
								])
							: h("div", { key: c.id, style: { display: "flex", alignItems: "flex-start", gap: "8px", padding: "8px 10px", borderRadius: "8px", border: "1px solid rgba(128,128,128,0.25)", background: "rgba(128,128,128,0.05)" } }, [
									h("div", { style: { flex: 1, minWidth: 0 } }, [
										h("p", { style: s.itemName }, c.name),
										h("p", { style: s.itemDesc }, c.description || ""),
										c.rationale ? h("p", { style: s.meta }, "可复用： " + c.rationale) : null
									]),
									h("button", { style: s.button, onClick: () => openEdit(c), disabled: busy }, "编辑"),
									h("button", { style: s.button, onClick: () => void acceptCand(c), disabled: busy }, "接受"),
									h("button", { style: s.button, onClick: () => void rejectCand(c), disabled: busy }, "拒绝")
								])
					)
				]
			);
		}
		/** The settings panel component. */
		function SkillManagerPanel() {
			const [skills, setSkills] = React.useState(null);
			const [cwd, setCwd] = React.useState("");
			const [selected, setSelected] = React.useState(null);
			const [draft, setDraft] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [msg, setMsg] = React.useState("");
			const [err, setErr] = React.useState("");
			const refresh = React.useCallback(async () => {
				try {
					const result = await api.list();
					setSkills(result.skills ?? []);
					setCwd(result.cwd ?? "");
					setErr("");
				} catch (error) {
					setErr("读取 skill 列表失败: " + String(error instanceof Error ? error.message : error));
				}
			}, []);
			React.useEffect(() => {
				refresh();
			}, [refresh]);
			/** Run one async action with busy/message bookkeeping. */
			const run = async (action) => {
				setBusy(true);
				setMsg("");
				setErr("");
				try {
					return await action();
				} catch (error) {
					setErr("操作失败: " + String(error instanceof Error ? error.message : error));
					return null;
				} finally {
					setBusy(false);
				}
			};
			const open = (skill) => {
				run(async () => {
					const result = await api.get(skill.name);
					setSelected(result.skill);
					setDraft(result.skill ? result.skill.content : "");
					setMsg("已加载 " + skill.name);
				});
			};
			const back = () => {
				setSelected(null);
				setDraft("");
				setMsg("");
			};
			const reload = () => {
				if (!selected) return;
				run(async () => {
					const result = await api.get(selected.name);
					setSelected(result.skill);
					setDraft(result.skill ? result.skill.content : "");
					setMsg("已从磁盘重新加载");
				});
			};
			const save = () => {
				if (!selected) return;
				run(async () => {
					const result = await api.save(selected.name, draft);
					setMsg((result.ok ? "[ok] " : "[failed] ") + (result.message ?? ""));
					refresh();
				});
			};
			const toggle = (patch) => {
				if (!selected) return;
				run(async () => {
					const result = await api.setPolicy(selected.name, patch);
					if (!result.ok) return;
					// Optimistic local update, then a background refresh.
					const next = Object.assign({}, selected, {
						modelInvocable: result.modelInvocable,
						userInvocable: result.userInvocable
					});
					setSelected(next);
					setMsg("[ok] " + (result.message ?? ""));
					refresh();
				});
			};
			const editable = Boolean(selected && selected.editable);
			const count = skills === null ? "…" : skills.length;
			return h(
				"div",
				{ style: s.card },
				h("p", { style: s.title }, "Skill 工作台"),
				h(
					"div",
					{ style: s.row },
					h(
						"span",
						{ style: s.status },
						cwd ? "工作区: " + cwd + " · 共 " + count + " 个 skill" : "共 " + count + " 个 skill"
					),
					h("div", { style: s.flex }),
					h(
						"button",
						{ style: s.button, onClick: refresh, disabled: busy },
						"刷新"
					)
				),
				selected === null
					? h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
							(skills ?? []).map((skill) =>
								h(SkillRow, {
									key: skill.name,
									skill,
									selected: false,
									onSelect: () => open(skill),
									onToggle: (patch) => {
										// List-level toggle without opening detail.
										run(async () => {
											const result = await api.setPolicy(skill.name, patch);
											if (!result.ok) return;
											setMsg("[ok] " + (result.message ?? ""));
											refresh();
										});
									}
								})
							)
						)
					: h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "10px" } },
							h(
								"div",
								{ style: s.row },
								h(
									"button",
									{ style: s.button, onClick: back, disabled: busy },
									"← 返回列表"
								),
								h("span", { style: s.itemName }, selected.name),
								h(InvBadge, { ok: editable, key: "e" }, editable ? "可编辑" : "只读")
							),
							h(
								"p",
								{ style: s.meta },
								"来源: " + sourceLabel(selected.source) + "（" + selected.provider + "）\n路径: " + (selected.path || "（无文件，只读）") + (selected.nested ? "\n⚠ 嵌套 skill（位于 " + (selected.parent ?? "子目录") + "/ 下）：DSH 默认只自动发现顶层，如需自动加载请移动到 ~/.agents/skills 顶层或加入 customSkillDirs" : "")
							),
							h(PolicyRow, { skill: selected, disabled: !editable || busy, onToggle: toggle }),
							editable
								? h(
										"div",
										{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
										h(
											"p",
											{ style: s.meta },
											"全文编辑（--- frontmatter --- + 正文，保存即写回文件；frontmatter 的 name 应与 skill 名一致）"
										),
										h("textarea", {
											style: s.textarea,
											value: draft,
											spellCheck: false,
											onChange: (event) => setDraft(event.target.value)
										}),
										h(
											"div",
											{ style: s.row },
											h(
												"button",
												{ style: s.button, onClick: save, disabled: busy || draft.trim() === "" },
												"保存"
											),
											h(
												"button",
												{ style: s.button, onClick: reload, disabled: busy },
												"重新加载"
											)
										)
									)
								: h(
										"p",
										{ style: s.statusWarn },
										"该 skill 来自内置/运行时提供方，无独立文件，只读。"
									)
						),
				err !== "" && h("div", { style: s.msgErr, key: "e" }, err),
				msg !== "" && h("div", { style: s.msg, key: "m" }, msg),
				h(ExtractorPanel, { key: "extract" })
			);
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services. */
		const inject = ["slots"];
		/**
		 * Register the Skill 管理器 settings page.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			try {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "skill-manager",
							order: 300,
							label: () => "Skill 工作台"
						},
						SkillManagerPanel
					)
				);
			} catch (error) {
				console.warn("[dsh-skill-studio] settings panel registration failed:", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
