/**
 * dsh-skill-studio — skill extraction core (merged from dsh-skill-extractor).
 *
 * Pure, no DSH-runtime dependency. Handles: extractor config store, session-log
 * scanning/digesting, LLM candidate extraction, the candidate queue, dedup, and
 * writing SKILL.md into the Obsidian personal skill library (2️⃣ AI/Skill/).
 */
import { readdir, readFile, writeFile, mkdir, stat, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_TARGET_DIR = "/Users/zhengjunyao/Documents/Obsidian Vault/2️⃣ AI/Skill";
export const DEFAULT_CONFIG_FILE = join(homedir(), ".dsh", "dsh-skill-studio", "extractor.json");
export const DEFAULT_CANDIDATE_FILE = join(homedir(), ".dsh", "dsh-skill-studio", "candidates.json");
export const DEFAULT_SESSIONS_ROOT = join(homedir(), ".dsh", "sessions");

function configPath() {
	const o = process.env.DSH_SKILL_EXTRACTOR_CONFIG;
	return o !== void 0 && o !== "" ? o : DEFAULT_CONFIG_FILE;
}
function candidatePath() {
	const o = process.env.DSH_SKILL_EXTRACTOR_CANDIDATES;
	return o !== void 0 && o !== "" ? o : DEFAULT_CANDIDATE_FILE;
}
function sessionsRoot() {
	const o = process.env.DSH_SKILL_EXTRACTOR_SESSIONS;
	return o !== void 0 && o !== "" ? o : DEFAULT_SESSIONS_ROOT;
}

export function defaults() {
	return {
		enabled: true,
		intervalMinutes: 1440,
		windowDays: 7,
		maxCandidatesPerRun: 3,
		skillLanguage: "zh",
		llmBaseUrl: "",
		llmApiKey: "",
		llmModel: "",
		targetDir: DEFAULT_TARGET_DIR,
		lastRunAt: "",
		lastRunSummary: ""
	};
}

function clampInt(v, min, max) {
	if (typeof v !== "number" || !Number.isFinite(v)) return null;
	return Math.min(max, Math.max(min, Math.floor(v)));
}

export function parse(raw) {
	const r = typeof raw === "object" && raw !== null ? raw : {};
	const num = (v, f, min, max) => clampInt(v, min, max) ?? f;
	const str = (v, f = "") => typeof v === "string" ? v : f;
	const bool = (v, f) => typeof v === "boolean" ? v : f;
	const d = defaults();
	const lang = str(r.skillLanguage, d.skillLanguage).toLowerCase();
	return {
		enabled: bool(r.enabled, d.enabled),
		intervalMinutes: num(r.intervalMinutes, d.intervalMinutes, 0, 10080),
		windowDays: num(r.windowDays, d.windowDays, 1, 365),
		maxCandidatesPerRun: num(r.maxCandidatesPerRun, d.maxCandidatesPerRun, 1, 20),
		skillLanguage: lang === "en" ? "en" : "zh",
		llmBaseUrl: str(r.llmBaseUrl, d.llmBaseUrl),
		llmApiKey: str(r.llmApiKey, d.llmApiKey),
		llmModel: str(r.llmModel, d.llmModel),
		targetDir: str(r.targetDir, d.targetDir),
		lastRunAt: str(r.lastRunAt, d.lastRunAt),
		lastRunSummary: str(r.lastRunSummary, d.lastRunSummary)
	};
}

/** File-backed extractor config store (mode 0600). */
export class ExtractorStore {
	async load() {
		try {
			return parse(JSON.parse(await readFile(configPath(), "utf8")));
		} catch {
			return defaults();
		}
	}
	async save(cfg) {
		await mkdir(dirname(configPath()), { recursive: true });
		const tmp = configPath() + ".tmp";
		await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
		await rename(tmp, configPath());
		return cfg;
	}
	async patch(args) {
		const cur = await this.load();
		const merged = { ...cur };
		if (args !== void 0 && typeof args === "object") {
			for (const k of Object.keys(merged)) {
				if (k in args) merged[k] = args[k];
			}
		}
		const view = parse(merged);
		await this.save(view);
		return view;
	}
	async view() {
		const v = await this.load();
		return {
			...v,
			llmKeyMasked: v.llmApiKey ? v.llmApiKey.slice(0, 2) + "…" + v.llmApiKey.slice(-2) : "",
			llmApiKey: "",
			configured: v.llmBaseUrl !== "" && v.llmApiKey !== "" && v.llmModel !== "",
			configPath: configPath(),
			candidatePath: candidatePath()
		};
	}
}

async function findSessionFiles(root) {
	const out = [];
	async function walk(dir) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) await walk(p);
			else if (e.name === "session.jsonl.zstd") out.push(p);
		}
	}
	await walk(root);
	return out;
}

async function readSessionLog(file) {
	try {
		const { stdout } = await execFileAsync("zstd", ["-d", "-c", file], { maxBuffer: 512 * 1024 * 1024 });
		const session = {};
		const msgs = [];
		let toolCalls = 0;
		let toolResults = 0;
		for (const l of stdout.split("\n")) {
			if (!l) continue;
			let o;
			try {
				o = JSON.parse(l);
			} catch {
				continue;
			}
			if (o === null || typeof o !== "object") continue;
			if (o.type === "session") {
				session.id = o.id;
				session.createdAt = o.createdAt;
				session.cwd = o.cwd;
			} else if (o.type === "agent/inbox/spliced") {
				const ins = o.data && o.data.inserted;
				if (Array.isArray(ins)) {
					for (const item of ins) {
						const role = item && item.role;
						const content = item && Array.isArray(item.content) ? item.content : [];
						const text = content.map((c) => (c && c.type === "text" ? c.text : "")).join(" ").trim();
						if (text) msgs.push({ role, text });
					}
				}
			} else if (o.type && o.type.startsWith("tool/")) {
				if (o.type === "tool/call") toolCalls++;
				else if (o.type === "tool/result") toolResults++;
			}
		}
		return { session, msgs, toolCalls, toolResults };
	} catch {
		return null;
	}
}

function truncate(s, n) {
	return s.length > n ? s.slice(0, n) + "…" : s;
}

export function buildDigest(log, maxMsgs = 20, maxMsgLen = 200) {
	const { session, msgs, toolCalls, toolResults } = log;
	const at = new Date(session.createdAt || Date.now());
	const title = session.cwd ? basename(session.cwd) : session.id || "unknown";
	const lines = [];
	lines.push(`## 会话「${title}」（${at.toISOString()}）`);
	if (session.cwd) lines.push(`工作区：${session.cwd}`);
	lines.push(`工具调用 ${toolCalls} 次 / 工具结果 ${toolResults} 次`);
	for (const m of msgs.slice(-maxMsgs)) {
		const role = m.role === "user" ? "用户" : "助手";
		lines.push(`- ${role}：${truncate(m.text, maxMsgLen)}`);
	}
	return lines.join("\n");
}

/** Collect recent session digests within `windowDays`, most recent first. */
export async function collectSessionDigests(root, windowDays, maxSessions = 12) {
	const files = await findSessionFiles(root);
	const cutoff = Date.now() - windowDays * 86400000;
	const found = [];
	for (const f of files) {
		let st;
		try {
			st = await stat(f);
		} catch {
			continue;
		}
		if (st.mtimeMs < cutoff) continue;
		const log = await readSessionLog(f);
		if (!log || log.msgs.length === 0) continue;
		found.push({ file: f, mtime: st.mtimeMs, log });
	}
	found.sort((a, b) => b.mtime - a.mtime);
	return found.slice(0, maxSessions);
}

export function buildPrompt(digestTexts, cfg) {
	const body = digestTexts.length ? digestTexts.join("\n\n") : "（没有近期会话）";
	const langLine =
		cfg.skillLanguage === "en"
			? "- 正文（body）用英文写；description 也用英文 Use when... 开头。"
			: "- 正文（body）用中文写；当且仅当正文是英文句子时例外。description 用英文 Use when... 开头（这是 agent 判断何时加载的依据）。";
	return [
		"以下是从 DSH 会话日志里提取的摘要。请从中找出可复用的技术、模式、工作流或参考，把它们写成个人 skill。",
		"",
		"只考虑：跨项目、可复用、agent 以后能反复照做的内容。",
		"不考虑：一次性解决、项目专属约定、已被文档覆盖的标准做法、能用自动化替代的机械约束。",
		"",
		"每个 skill 给出：",
		"- name：kebab-case 英文名",
		"- description：一句话「何时使用」（用 Use when... 开头，不要概括流程）",
		"- rationale：为什么可复用（一句话）",
		"- body：markdown 正文（概述、何时用、核心模式、示例、常见错误），要简洁可复用，不要写成某次解决过程的叙事",
		langLine,
		"",
		`最多 ${cfg.maxCandidatesPerRun} 个。只输出 JSON（不要任何额外文字），格式：`,
		'{"candidates":[{"name":"","description":"","rationale":"","body":""}]}',
		"",
		"会话摘要：",
		body
	].join("\n");
}

export async function callLLM(cfg, prompt, { maxTokens = 4000 } = {}) {
	const base = (cfg.llmBaseUrl || "").replace(/\/+$/, "");
	const res = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.llmApiKey}` },
		body: JSON.stringify({
			model: cfg.llmModel,
			messages: [
				{ role: "system", content: "你从会话日志摘要中提取可复用的个人 skill。只输出 JSON。" },
				{ role: "user", content: prompt }
			],
			temperature: 0.2,
			max_tokens: maxTokens,
			response_format: { type: "json_object" }
		}),
		signal: AbortSignal.timeout(120000)
	});
	if (!res.ok) throw new Error("LLM API responded " + res.status);
	const data = await res.json();
	const text =
		data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
	if (!text) throw new Error("LLM API empty completion");
	return text;
}

export function normalizeName(n) {
	return String(n)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function parseLlmCandidates(rawText) {
	const text = String(rawText || "").trim();
	let obj;
	try {
		obj = JSON.parse(text);
	} catch {
		const m = text.match(/\{[\s\S]*\}/);
		if (!m) throw new Error("LLM response is not JSON");
		obj = JSON.parse(m[0]);
	}
	const arr = Array.isArray(obj)
		? obj
		: obj && Array.isArray(obj.candidates)
			? obj.candidates
			: [];
	return arr
		.map((c) => ({
			name: normalizeName(String((c && c.name) || "")),
			description: String((c && c.description) || "").trim(),
			rationale: String((c && c.rationale) || "").trim(),
			body: String((c && c.body) || "").trim()
		}))
		.filter((c) => c.name && c.description && c.body);
}

export async function loadCandidates() {
	try {
		const arr = JSON.parse(await readFile(candidatePath(), "utf8"));
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

export async function saveCandidates(arr) {
	await mkdir(dirname(candidatePath()), { recursive: true });
	await writeFile(candidatePath(), JSON.stringify(arr, null, 2), { mode: 0o600 });
	return arr;
}

/**
 * Update one pending candidate's draft fields in the queue (by id). Accepts
 * `{ name, description, rationale, body }`; the name is re-normalized to
 * kebab-case. Returns the updated candidate or null when not found.
 */
export async function updateCandidate(id, patch) {
	const queue = await loadCandidates();
	const target = queue.find((c) => c.id === id && c.status === "pending");
	if (!target) return null;
	if (patch && typeof patch.body === "string") target.body = patch.body.trim();
	if (patch && typeof patch.rationale === "string") target.rationale = patch.rationale.trim();
	if (patch && typeof patch.description === "string") target.description = patch.description.trim();
	if (patch && typeof patch.name === "string") {
		const norm = normalizeName(patch.name);
		if (norm) target.name = norm;
	}
	await saveCandidates(queue);
	return target;
}

export async function existingSkillNames(targetDir) {
	try {
		const entries = await readdir(targetDir, { withFileTypes: true });
		const names = [];
		for (const e of entries) {
			if (e.isDirectory()) names.push(e.name);
			else if (e.name.endsWith(".md")) names.push(basename(e.name, ".md"));
		}
		return names;
	} catch {
		return [];
	}
}

export async function writeSkill(targetDir, cand, { force = false } = {}) {
	if (!cand || !cand.name) return { ok: false, message: "candidate 缺少 name" };
	const names = await existingSkillNames(targetDir);
	if (names.includes(cand.name) && !force) {
		return { ok: false, message: `已存在同名 skill ${cand.name}` };
	}
	const dir = join(targetDir, cand.name);
	await mkdir(dir, { recursive: true });
	const frontmatter = `---\nname: ${cand.name}\ndescription: ${cand.description}\n---\n`;
	const body = cand.body.startsWith("#") ? cand.body : `# ${cand.name}\n\n${cand.body}`;
	const file = join(dir, "SKILL.md");
	await writeFile(file, frontmatter + "\n" + body + "\n", { encoding: "utf8" });
	return { ok: true, message: `已写入 ${file}`, path: file };
}

export function shortenSummary(s) {
	return s.length > 400 ? s.slice(0, 400) + "…" : s;
}

/** Build the full SKILL.md text (frontmatter + body) for a candidate. */
export function assembleCandidateFile(cand) {
	const frontmatter = `---\nname: ${cand.name}\ndescription: ${cand.description}\n---\n`;
	const body = cand.body.startsWith("#") ? cand.body : `# ${cand.name}\n\n${cand.body}`;
	return frontmatter + "\n" + body + "\n";
}

/**
 * Run one extraction pass: scan recent logs, prompt the LLM, stage the fresh
 * candidates into the queue (dedup against existing skills and queued names).
 * Returns a result; caller persists lastRunAt/lastRunSummary.
 */
export async function runExtraction(cfg, root = sessionsRoot(), { now = Date.now() } = {}) {
	if (!cfg.enabled) return { ok: false, message: "提取已禁用" };
	if (!(cfg.llmBaseUrl && cfg.llmApiKey && cfg.llmModel)) {
		return { ok: false, message: "LLM 未配置：请先设置 baseUrl/apiKey/model" };
	}
	const digs = await collectSessionDigests(root, cfg.windowDays);
	if (digs.length === 0) return { ok: true, message: "近期无会话可提取", candidates: [], digests: 0 };
	const digestsText = digs.map((d) => buildDigest(d.log));
	const raw = await callLLM(cfg, buildPrompt(digestsText, cfg));
	const cands = parseLlmCandidates(raw).slice(0, cfg.maxCandidatesPerRun);
	const existing = new Set(await existingSkillNames(cfg.targetDir));
	const queue = await loadCandidates();
	const queuedNames = new Set(queue.map((c) => c.name));
	const fresh = cands.filter((c) => !existing.has(c.name) && !queuedNames.has(c.name));
	const staged = fresh.map((c, i) => ({
		id: `${now}-${i}`,
		status: "pending",
		created: now,
		sourceCount: digs.length,
		...c
	}));
	const nextQueue = [...queue, ...staged];
	await saveCandidates(nextQueue);
	return {
		ok: true,
		message: `扫描 ${digs.length} 个会话，产出 ${staged.length} 个候选（跳过 ${cands.length - staged.length} 个重复/已存在）`,
		candidates: staged,
		digests: digs.length,
		queued: nextQueue.length,
		site: { lastRunAt: new Date(now).toISOString(), lastRunSummary: shortenSummary(`扫描 ${digs.length} 个会话，产出 ${staged.length} 个候选`) }
	};
}

export const _internal = { configPath, candidatePath, sessionsRoot };
