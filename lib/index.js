/**
 * dsh-skill-studio — skill (技能) 可视化与编辑器. Host half.
 *
 * Mounts the skillmgr_* tools, the /api/dsh-skill-studio route family the
 * web settings panel talks to, and a system-prompt announcement.
 *
 * The panel shows TWO merged catalogs:
 *   1. Filesystem skills — scanned directly by ./scanner.js from the standard
 *      roots (project .dsh/skills & .agents/skills, user ~/.dsh/skills &
 *      ~/.agents/skills), including one level of nested bundles such as
 *      ~/.agents/skills/superpowers/<name>. This is necessary because on the
 *      web host plane the registry's filesystem provider is disabled by
 *      design (per-agent presets own local discovery), so `ctx.skills` alone
 *      would show only runtime/bundled skills.
 *   2. Registry skills — everything `ctx.skills.list()` reports that is not
 *      the filesystem provider (runtime contributions, bundled skills, other
 *      providers), so the panel stays consistent with what DSH actually
 *      loads.
 *
 * Editing and toggling write back to the underlying SKILL.md (or <name>.md)
 * file reported by the scanner / registry:
 *   - full-body edit: save the whole file verbatim (frontmatter + body)
 *   - enable/disable: line-level frontmatter surgery on the two invocation
 *     keys (`disable-model-invocation`, `user-invocable`), preserving every
 *     other line of the user's frontmatter untouched.
 *
 * The filesystem provider (where active) watches the skill roots and
 * invalidates itself on file changes, so a save is picked up by DSH without
 * a restart. The scanner itself re-reads the files on every request.
 *
 * Safety: this plugin never accepts an arbitrary file path. All writes are
 * resolved from the scanner / registry's own candidate; only skills that
 * carry a real `path` are editable — runtime / bundled skills are read-only.
 * All routes are loopback-only and same-origin checked.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { findSkillByName, parseSkillFile, scanSkills } from "./scanner.js";

/** Stable cordis plugin name. */
const name = "skill-manager";
/** Services required before the skill manager surfaces can mount. */
const inject = ["skills", "tools", "systemPrompt", "webServer"];
/** Route family prefix. */
const API = {
	list: "/api/dsh-skill-studio/list",
	skill: "/api/dsh-skill-studio/skill",
	policy: "/api/dsh-skill-studio/policy"
};
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150;
/** Cap on JSON request bodies (skill bodies can be long). */
const MAX_JSON_BODY_BYTES = 1024 * 1024;
/** Model-facing announcement: plugin presence and capabilities. */
const GUIDANCE = "本机已安装 dsh-skill-studio 插件（skill 技能管理器）：可用 skillmgr_list 列出全部已发现 skill（名称/描述/来源/嵌套标记/模型与用户可调用状态）、skillmgr_get 查看正文、skillmgr_save 保存全文编辑、skillmgr_policy 设置启用/禁用（modelInvocable / userInvocable）。也可以在 Web 设置页「Skill 管理器」面板中可视化查看、编辑与开关 skill。用户提到「管理 skill / 技能 / skill 列表 / 查看技能」时即指本插件，请据此协作。";
/** Frontmatter block matcher: leading `---` fence pair. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** The two invocation keys this plugin toggles. */
const KEY_MODEL = "disable-model-invocation";
const KEY_USER = "user-invocable";
/** One text content block (the only render shape these tools emit). */
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
/**
 * Split a skill file into { frontmatter, body }. `frontmatter` is the raw
 * YAML text between the fences (no fences), or null when there is no block.
 */
function splitFrontmatter(fileText) {
	const match = FRONTMATTER_RE.exec(fileText);
	if (!match) return { frontmatter: null, body: fileText };
	return { frontmatter: match[1], body: fileText.slice(match[0].length) };
}
/** Index of the first line whose key is `key:` (top-level YAML key), else -1. */
function findKeyLine(lines, key) {
	const re = new RegExp("^" + key + "\\s*:");
	for (let i = 0; i < lines.length; i++) {
		if (re.test(lines[i])) return i;
	}
	return -1;
}
/**
 * Apply invocation-policy changes to a frontmatter text (line-level surgery):
 * set → upsert the key line, unset → delete the key line. `changes` carries
 * only the keys that should change; everything else is preserved verbatim.
 * Returns the new frontmatter text (may be "" when all lines were removed).
 */
function applyPolicy(frontmatter, changes) {
	const lines = frontmatter === null ? [] : frontmatter.split("\n");
	const setKey = (key, value) => {
		const idx = findKeyLine(lines, key);
		if (idx >= 0) lines[idx] = key + ": " + value;
		else lines.push(key + ": " + value);
	};
	const unsetKey = (key) => {
		const idx = findKeyLine(lines, key);
		if (idx >= 0) lines.splice(idx, 1);
	};
	if (changes.modelInvocable === true) unsetKey(KEY_MODEL);
	else if (changes.modelInvocable === false) setKey(KEY_MODEL, "true");
	if (changes.userInvocable === true) unsetKey(KEY_USER);
	else if (changes.userInvocable === false) setKey(KEY_USER, "false");
	return lines.join("\n");
}
/**
 * Rebuild a skill file from its original text and an (optional) new frontmatter
 * text. Creates a frontmatter block only when the file had none and the new
 * frontmatter is non-empty; keeps the block when it already existed.
 */
function assembleFile(fileText, nextFrontmatter) {
	const parsed = splitFrontmatter(fileText);
	const fm = nextFrontmatter === null ? null : nextFrontmatter.trim();
	if (parsed.frontmatter === null) {
		if (fm) return "---\n" + fm + "\n---\n" + parsed.body;
		return parsed.body;
	}
	return "---\n" + (fm ?? "") + "\n---\n" + parsed.body;
}
/** Normalize a cwd query value (empty/undefined → undefined = process cwd). */
function resolveCwd(value) {
	const raw = typeof value === "string" ? value.trim() : "";
	if (!raw) return void 0;
	return resolve(raw);
}
/** Project a filesystem-scanned skill to the plain summary shape. */
function fsToSummary(skill) {
	return {
		name: skill.name,
		description: skill.description,
		whenToUse: skill.whenToUse ?? null,
		source: skill.source,
		provider: skill.provider,
		modelInvocable: skill.modelInvocable === true,
		userInvocable: skill.userInvocable === true,
		editable: true,
		nested: skill.nested === true,
		parent: skill.parent ?? null
	};
}
/** Project a registry summary to the plain summary shape (read-only here). */
function registryToSummary(skill) {
	return {
		name: skill.name,
		description: skill.description,
		whenToUse: typeof skill.whenToUse === "string" ? skill.whenToUse : null,
		source: skill.source,
		provider: skill.provider,
		modelInvocable: skill.invocation.modelInvocable === true,
		userInvocable: skill.invocation.userInvocable === true,
		editable: false,
		nested: false,
		parent: null
	};
}
/**
 * List every visible skill for a workspace: filesystem scan (authoritative
 * for disk skills) merged with registry skills that are not the filesystem
 * provider (runtime / bundled / other providers).
 */
async function listSkills(ctx, cwd) {
	const fsSkills = await scanSkills(cwd);
	const summaries = new Map();
	for (const skill of fsSkills) {
		const summary = fsToSummary(skill);
		summaries.set(summary.name, summary);
	}
	const registrySkills = await ctx.skills.list({ cwd });
	for (const skill of registrySkills) {
		if (skill.provider === "filesystem") continue; // covered by our scan
		const summary = registryToSummary(skill);
		if (!summaries.has(summary.name)) summaries.set(summary.name, summary);
	}
	return [...summaries.values()].sort((a, b) => a.name.localeCompare(b.name));
}
/** Load one skill's full detail (body + path), or null. */
async function getSkillDetail(ctx, skillName, cwd) {
	// filesystem first (has real content + path)
	const fsSkill = await findSkillByName(skillName, cwd);
	if (fsSkill) {
		return {
			...fsToSummary(fsSkill),
			path: fsSkill.path,
			dir: fsSkill.dir ?? null,
			content: fsSkill.content,
			metadata: null
		};
	}
	// registry fallback (runtime / bundled / other providers)
	const skill = await ctx.skills.get(skillName, { cwd });
	if (!skill) return null;
	return {
		...registryToSummary(skill),
		path: typeof skill.path === "string" ? skill.path : null,
		dir: null,
		editable: typeof skill.path === "string" && skill.path.length > 0,
		content: typeof skill.content === "string" ? skill.content : "",
		metadata: skill.metadata ?? null
	};
}
/** Registry/scanner-backed, path-safe write guard: resolve the file for `name`. */
async function editableFile(ctx, skillName, cwd, action) {
	const fsSkill = await findSkillByName(skillName, cwd);
	if (fsSkill) return fsSkill;
	const skill = await ctx.skills.get(skillName, { cwd });
	if (!skill) throw new Error("skill 不存在: " + skillName);
	if (typeof skill.path !== "string" || !skill.path) {
		throw new Error("skill \"" + skillName + "\"（" + skill.source + "/" + skill.provider + "）没有可写文件，" + action + "不可用（内置/bundled 或运行时 skill 为只读）");
	}
	return { name: skill.name, path: skill.path, source: skill.source, provider: skill.provider };
}
/** Save a full file edit (frontmatter + body) for a skill. */
async function saveSkill(ctx, args, cwd) {
	const skill = await editableFile(ctx, args.name, cwd, "编辑");
	if (typeof args.content !== "string" || args.content.length === 0) {
		throw new Error("content 不能为空");
	}
	await writeFile(skill.path, args.content, "utf8");
	return {
		ok: true,
		message: "已保存 " + skill.name + "（" + skill.path + "）",
		path: skill.path,
		bytes: Buffer.byteLength(args.content, "utf8")
	};
}
/**
 * Apply an invocation-policy change to a skill's frontmatter.
 * `enabled: true/false` is the convenience master switch (both interfaces);
 * `modelInvocable` / `userInvocable` override one side independently.
 */
async function savePolicy(ctx, args, cwd) {
	const skill = await editableFile(ctx, args.name, cwd, "设置启用状态");
	const changes = {};
	if (args.enabled === true) {
		changes.modelInvocable = true;
		changes.userInvocable = true;
	} else if (args.enabled === false) {
		changes.modelInvocable = false;
		changes.userInvocable = false;
	}
	if (typeof args.modelInvocable === "boolean") changes.modelInvocable = args.modelInvocable;
	if (typeof args.userInvocable === "boolean") changes.userInvocable = args.userInvocable;
	if (Object.keys(changes).length === 0) {
		throw new Error("没有可应用的策略变更（请提供 enabled / modelInvocable / userInvocable 之一）");
	}
	const raw = await readFile(skill.path, "utf8");
	const parsed = splitFrontmatter(raw);
	const next = assembleFile(raw, applyPolicy(parsed.frontmatter, changes));
	await writeFile(skill.path, next, "utf8");
	const current = parseSkillFile(raw);
	return {
		ok: true,
		message: "已更新 " + skill.name + " 的调用策略",
		path: skill.path,
		modelInvocable: changes.modelInvocable ?? current.fields.disableModelInvocation !== true,
		userInvocable: changes.userInvocable ?? current.fields.userInvocable !== false
	};
}
/** The list tool. */
function skillmgrListTool(ctx) {
	return defineTool({
		name: "skillmgr_list",
		description: "列出当前工作区全部已发现的 skill（技能）：名称、描述、来源（user-agents/user-dsh/project-dsh/...）、嵌套标记、以及模型可调用与用户可调用状态。",
		parameters: {
			cwd: {
				type: "string",
				description: "可选：工作区目录（默认当前进程 cwd）；只影响项目级 skill 的发现范围"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					cwd: { type: "string" },
					skills: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string" },
								description: { type: "string" },
								whenToUse: { type: "string" },
								source: { type: "string" },
								provider: { type: "string" },
								modelInvocable: { type: "boolean" },
								userInvocable: { type: "boolean" },
								editable: { type: "boolean" },
								nested: { type: "boolean" },
								parent: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const items = (value.skills ?? []).map((s) => {
					const flags = (s.modelInvocable ? "模型✓" : "模型✗") + "/" + (s.userInvocable ? "用户✓" : "用户✗");
					const nested = s.nested ? "（嵌套）" : "";
					return "- " + s.name + nested + " [" + flags + "]（" + (s.source ?? "?") + "）: " + (s.description ?? "");
				});
				return text("[ok] 共 " + items.length + " 个 skill\n" + items.join("\n"));
			}
		},
		async execute(args) {
			return {
				ok: true,
				cwd: resolveCwd(args.cwd) ?? process.cwd(),
				skills: await listSkills(ctx, resolveCwd(args.cwd))
			};
		}
	});
}
/** The get-detail tool. */
function skillmgrGetTool(ctx) {
	return defineTool({
		name: "skillmgr_get",
		description: "查看一个 skill 的完整详情：描述、来源、模型/用户可调用状态、文件路径（有则说明可编辑）、以及正文全文（frontmatter + Markdown 内容）。",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "skill 名称（kebab-case，如 obsidian-project-kb；嵌套 skill 可用 parent/child 形式）"
			},
			cwd: {
				type: "string",
				description: "可选：工作区目录（默认当前进程 cwd）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					skill: {
						type: "object",
						additionalProperties: true,
						properties: {
							name: { type: "string" },
							description: { type: "string" },
							whenToUse: { type: "string" },
							source: { type: "string" },
							provider: { type: "string" },
							modelInvocable: { type: "boolean" },
							userInvocable: { type: "boolean" },
							editable: { type: "boolean" },
							nested: { type: "boolean" },
							path: { type: "string" },
							content: { type: "string" },
							metadata: { type: "object", additionalProperties: true }
						}
					}
				}
			},
			render: (_args, value) => {
				const s = value.skill;
				if (!s) return text("[failed] skill 不存在");
				const head = [
					s.name + (s.nested ? "（嵌套）" : "") + "（" + (s.source ?? "?") + "/" + (s.provider ?? "?") + "）",
					"调用策略: 模型" + (s.modelInvocable ? "✓" : "✗") + " / 用户" + (s.userInvocable ? "✓" : "✗"),
					"路径: " + (s.path ?? "（只读，无文件）"),
					"描述: " + (s.description ?? ""),
					"正文:"
				].join("\n");
				return text(head + "\n" + (s.content ?? ""));
			}
		},
		async execute(args) {
			const detail = await getSkillDetail(ctx, args.name, resolveCwd(args.cwd));
			return { ok: detail !== null, skill: detail };
		}
	});
}
/** The save-edit tool. */
function skillmgrSaveTool(ctx) {
	return defineTool({
		name: "skillmgr_save",
		description: "保存一个 skill 的全文编辑（frontmatter + 正文一起写回 SKILL.md 文件）。只对文件系统来源的 skill 可用（有 path）；保存后 DSH 会自动重新发现，无需重启。注意：frontmatter 的 name 需与 skill 名一致，格式错误可能导致该 skill 被跳过。",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "skill 名称（kebab-case）"
			},
			content: {
				type: "string",
				required: true,
				description: "新的完整文件内容（含 --- frontmatter --- 与正文）"
			},
			cwd: {
				type: "string",
				description: "可选：工作区目录（默认当前进程 cwd）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: { type: "string" },
					path: { type: "string" },
					bytes: { type: "number" }
				}
			},
			render: (_args, value) => text((value.ok ? "[ok] " : "[failed] ") + (value.message ?? ""))
		},
		async execute(args) {
			return saveSkill(ctx, args, resolveCwd(args.cwd));
		}
	});
}
/** The enable/disable tool. */
function skillmgrPolicyTool(ctx) {
	return defineTool({
		name: "skillmgr_policy",
		description: "设置一个 skill 的启用/调用策略：enabled=true 启用（模型与用户都可调用，移除 frontmatter 的 disable-model-invocation / user-invocable 行），enabled=false 禁用（两者都关闭）；也可单独用 modelInvocable / userInvocable 只改一侧。修改写入 SKILL.md frontmatter，DSH 自动重新发现。",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "skill 名称（kebab-case）"
			},
			enabled: {
				type: "boolean",
				description: "总开关：true 同时启用模型与用户调用；false 同时禁用"
			},
			modelInvocable: {
				type: "boolean",
				description: "可选：单独设置模型是否可调用（true 启用 / false 禁用）"
			},
			userInvocable: {
				type: "boolean",
				description: "可选：单独设置用户是否可调用（true 启用 / false 禁用）"
			},
			cwd: {
				type: "string",
				description: "可选：工作区目录（默认当前进程 cwd）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: { type: "string" },
					path: { type: "string" },
					modelInvocable: { type: "boolean" },
					userInvocable: { type: "boolean" }
				}
			},
			render: (_args, value) => {
				if (!value.ok) return text("[failed] " + (value.message ?? ""));
				return text("[ok] " + value.message + "（模型" + (value.modelInvocable ? "✓" : "✗") + " / 用户" + (value.userInvocable ? "✓" : "✗") + "）");
			}
		},
		async execute(args) {
			return savePolicy(ctx, args, resolveCwd(args.cwd));
		}
	});
}
/** Loopback-only fence plus browser same-origin markers (mirrors dsh-ssh / dsh-flomo). */
function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/** One JSON response. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}
/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > MAX_JSON_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** Read a query value from a request URL. */
function queryValue(req, key) {
	try {
		const url = new URL(req.url ?? "", "http://127.0.0.1");
		return url.searchParams.get(key) ?? void 0;
	} catch {
		return void 0;
	}
}
/** Wrap an async route handler with uniform error → JSON mapping. */
function handle(ctx, fn) {
	return async (req, res) => {
		try {
			await fn(req, res);
		} catch (error) {
			writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}
/**
 * Build every /api/dsh-skill-studio route (exact paths).
 * @param ctx - host plugin context.
 * @returns the route list.
 */
function makeRoutes(ctx) {
	const guard = (req, res, method) => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: "method not allowed: " + req.method });
			return false;
		}
		return true;
	};
	return [
		{
			kind: "exact",
			path: API.list,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "GET")) return;
				const cwd = resolveCwd(queryValue(req, "cwd"));
				writeJson(res, 200, {
					ok: true,
					cwd: cwd ?? process.cwd(),
					skills: await listSkills(ctx, cwd)
				});
			})
		},
		{
			kind: "exact",
			path: API.skill,
			handler: handle(ctx, async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					const name = queryValue(req, "name");
					if (!name) {
						writeJson(res, 400, { error: "name query is required" });
						return;
					}
					const cwd = resolveCwd(queryValue(req, "cwd"));
					const detail = await getSkillDetail(ctx, name, cwd);
					if (!detail) {
						writeJson(res, 404, { error: "skill not found: " + name });
						return;
					}
					writeJson(res, 200, { ok: true, skill: detail });
					return;
				}
				if (method === "POST") {
					if (!guard(req, res, "POST")) return;
					const body = await readJsonBody(req);
					if (body === void 0 || typeof body.name !== "string") {
						writeJson(res, 400, { error: "invalid JSON body (name required)" });
						return;
					}
					writeJson(res, 200, await saveSkill(ctx, {
						name: body.name,
						content: body.content
					}, resolveCwd(typeof body.cwd === "string" ? body.cwd : void 0)));
					return;
				}
				writeJson(res, 405, { error: "method not allowed: " + method });
			})
		},
		{
			kind: "exact",
			path: API.policy,
			handler: handle(ctx, async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0 || typeof body.name !== "string") {
					writeJson(res, 400, { error: "invalid JSON body (name required)" });
					return;
				}
				writeJson(res, 200, await savePolicy(ctx, {
					name: body.name,
					enabled: typeof body.enabled === "boolean" ? body.enabled : void 0,
					modelInvocable: typeof body.modelInvocable === "boolean" ? body.modelInvocable : void 0,
					userInvocable: typeof body.userInvocable === "boolean" ? body.userInvocable : void 0
				}, resolveCwd(typeof body.cwd === "string" ? body.cwd : void 0)));
			})
		}
	];
}
/**
 * Mount the skill-manager tools, routes, and announcement.
 * @param ctx - host plugin context carrying skills/tools/systemPrompt/webServer.
 * @param config - plugin config from the composition row.
 */
function apply(ctx, config) {
	const announceToAgent = config?.announceToAgent !== false;
	const enabled = config?.enabled !== false;
	let disposeTools;
	let disposeRoutes;
	let disposeSection;
	const sync = () => {
		if (disposeTools !== void 0) {
			disposeTools();
			disposeTools = void 0;
		}
		if (disposeRoutes !== void 0) {
			disposeRoutes();
			disposeRoutes = void 0;
		}
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		if (!enabled) return;
		const tools = [
			skillmgrListTool(ctx),
			skillmgrGetTool(ctx),
			skillmgrSaveTool(ctx),
			skillmgrPolicyTool(ctx)
		];
		disposeTools = ctx.effect(() => {
			const disposers = tools.map((tool) => ctx.tools.register(tool));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-skill-studio: tools");
		disposeRoutes = ctx.effect(() => {
			const disposers = makeRoutes(ctx).map((route) => ctx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-skill-studio: routes");
		if (announceToAgent) disposeSection = ctx.systemPrompt.section({
			name: "plugin:dsh-skill-studio",
			order: SECTION_ORDER,
			text: GUIDANCE
		});
	};
	sync();
}

export { API, GUIDANCE, apply, applyPolicy, assembleFile, getSkillDetail, inject, listSkills, makeRoutes, name, savePolicy, saveSkill, splitFrontmatter };
