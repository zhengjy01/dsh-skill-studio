/**
 * dsh-skill-studio — filesystem skill scanner.
 *
 * The host skill registry (`ctx.skills`) only sees providers registered in
 * the viewing layer: on the web host plane the filesystem provider is disabled
 * by design (per-agent presets own local discovery), so a host-side panel
 * would see only runtime/bundled skills. This scanner re-implements the
 * standard discovery contract directly on the filesystem so the panel can
 * visualize (and edit/toggle) every skill the user actually keeps on disk:
 *
 *   - project roots: <projectRoot>/.dsh/skills, <projectRoot>/.agents/skills
 *   - user roots:    <dshHome>/skills,        <agentsHome>/skills
 *   - one level of nesting: a directory without its own SKILL.md whose child
 *     directories carry SKILL.md files (e.g. ~/.agents/skills/superpowers/…)
 *     is expanded so nested skills are still visible and manageable. Nested
 *     skills are flagged `nested: true` — DSH itself only auto-discovers the
 *     top level, so the panel marks them accordingly.
 *
 * Frontmatter is parsed with a small line-level YAML reader (scalar + block
 * values for the fields the manager needs: name, description, whenToUse and
 * the two invocation keys). No third-party dependency.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { configuredExtraSkillDirs } from "./extractor.js";

/** Extra custom skill dirs to scan on top of the standard roots (env, ":"-separated). */
function customSkillDirs() {
	const o = process.env.DSH_SKILL_MANAGER_SKILL_DIRS;
	return typeof o === "string" && o !== "" ? o.split(":") : [];
}

/** Frontmatter block matcher (leading fence pair). */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** kebab-case skill-name grammar (mirrors @deepseek-ai/dsh-skill). */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Invocation key aliases (frontmatter → canonical). */
const KEY_ALIASES = {
	"disable-model-invocation": "disableModelInvocation",
	"disable-model-invocable": "disableModelInvocation",
	"user-invocable": "userInvocable"
};
/** Scalar value parse: quoted strings, booleans, numbers, plain text. */
function parseScalar(raw) {
	const value = raw.trim();
	if (value === "") return "";
	// strip trailing comment (" # …") only when preceded by whitespace
	const hash = value.indexOf(" #");
	const clean = hash >= 0 ? value.slice(0, hash).trimEnd() : value;
	if (
		(clean.startsWith('"') && clean.endsWith('"') && clean.length >= 2) ||
		(clean.startsWith("'") && clean.endsWith("'") && clean.length >= 2)
	) {
		return clean.slice(1, -1);
	}
	const low = clean.toLowerCase();
	if (low === "true" || low === "yes" || low === "on" || low === "1") return true;
	if (low === "false" || low === "no" || low === "off" || low === "0") return false;
	return clean;
}
/**
 * Parse frontmatter text into the fields the manager consumes.
 * Returns { fields, raw } where fields is the canonical view and raw keeps
 * every parsed key→value for display.
 */
function parseFrontmatterText(fmText) {
	const fields = { name: null, description: null, whenToUse: null, disableModelInvocation: null, userInvocable: null };
	const raw = {};
	const lines = fmText.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
		if (!match) continue;
		const key = match[1];
		const rest = match[2].trim();
		// literal / folded block value
		if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-" || rest === "|+" || rest === ">+") {
			const block = [];
			i += 1;
			while (i < lines.length) {
				const line = lines[i];
				if (line.trim() === "") {
					block.push("");
					i += 1;
					continue;
				}
				if (line.startsWith(" ") || line.startsWith("\t")) {
					block.push(line.replace(/^[ \t]+/, ""));
					i += 1;
					continue;
				}
				break;
			}
			i -= 1;
			const value = block.join("\n").trimEnd();
			raw[key] = value;
			const canonical = KEY_ALIASES[key] ?? key;
			if (canonical in fields) fields[canonical] = value;
			continue;
		}
		const value = parseScalar(rest);
		raw[key] = value;
		const canonical = KEY_ALIASES[key] ?? key;
		if (canonical in fields) fields[canonical] = value;
	}
	return { fields, raw };
}
/** Split a skill file into { fmText, body, fields } (fmText null when absent). */
export function parseSkillFile(fileText) {
	const match = FRONTMATTER_RE.exec(fileText);
	if (!match) {
		return {
			fmText: null,
			body: fileText,
			fields: { name: null, description: null, whenToUse: null, disableModelInvocation: null, userInvocable: null }
		};
	}
	const fmText = match[1];
	const parsed = parseFrontmatterText(fmText);
	return { fmText, body: fileText.slice(match[0].length), fields: parsed.fields, raw: parsed.raw };
}
/** Resolve project root: nearest ancestor containing a .git entry, else cwd. */
export async function findProjectRoot(cwd) {
	let current = resolve(cwd ?? process.cwd());
	for (;;) {
		try {
			await stat(join(current, ".git"));
			return current;
		} catch {
			// continue walking up
		}
		const parent = dirname(current);
		if (parent === current) return resolve(cwd ?? process.cwd());
		current = parent;
	}
}
/** Ordered skill roots for a workspace: project first, then user roots. */
export async function skillRoots(cwd) {
	const projectRoot = await findProjectRoot(cwd);
	const userRoots = [
		{ path: join(homedir(), ".dsh", "skills"), source: "user-dsh", projectRoot },
		{ path: join(homedir(), ".agents", "skills"), source: "user-agents", projectRoot }
	];
	// When the project root IS the home directory (no .git ancestor), the
	// project's `<root>/.agents/skills` is the same directory as the user's —
	// scan it once under its user-root identity.
	const userPaths = new Set(userRoots.map((root) => root.path));
	const roots = [];
	for (const rel of [".dsh/skills", ".agents/skills"]) {
		const rootPath = join(projectRoot, rel);
		if (userPaths.has(rootPath)) continue;
		roots.push({ path: rootPath, source: rel.startsWith(".dsh") ? "project-dsh" : "project-agents", projectRoot });
	}
	roots.push(...userRoots);
	// Extra custom dirs (env) + the per-user configured mirror dir (e.g. the
	// Obsidian skill library), so the panel also sees/edits those skills.
	for (const dir of customSkillDirs()) {
		roots.push({ path: dir, source: "custom", projectRoot });
	}
	for (const dir of await configuredExtraSkillDirs()) {
		roots.push({ path: dir, source: "custom", projectRoot });
	}
	return roots;
}
/** Whether `path` points to an existing file (or a symlink resolving to one). */
async function fileExists(path) {
	try {
		const info = await stat(path);
		return info.isFile();
	} catch {
		return false;
	}
}
/** List one directory's direct child names (resilient). */
async function listDir(path) {
	try {
		const entries = await readdir(path, { withFileTypes: true });
		return entries;
	} catch {
		return [];
	}
}
/**
 * Scan one root for skills: top-level <name>/SKILL.md or <name>.md, plus one
 * level of nesting for directories that have no SKILL.md themselves.
 * Pushes raw candidates (name/path/source/nested/parent) into `out`.
 */
async function scanRoot(rootPath, source, out) {
	const entries = await listDir(rootPath);
	for (const entry of entries) {
		const entryPath = join(rootPath, entry.name);
		if (entry.isDirectory() || entry.isSymbolicLink()) {
			const ownSkill = join(entryPath, "SKILL.md");
			if (await fileExists(ownSkill)) {
				out.push({ name: entry.name, path: ownSkill, dir: entryPath, source, nested: false, parent: null });
				continue;
			}
			// nested expansion (one level)
			const subs = await listDir(entryPath);
			for (const sub of subs) {
				if (!sub.isDirectory() && !sub.isSymbolicLink()) continue;
				const subSkill = join(entryPath, sub.name, "SKILL.md");
				if (await fileExists(subSkill)) {
					out.push({ name: sub.name, path: subSkill, dir: join(entryPath, sub.name), source, nested: true, parent: entry.name });
				}
			}
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			out.push({ name: entry.name.slice(0, -3), path: entryPath, dir: rootPath, source, nested: false, parent: null });
		}
	}
}
/**
 * Scan every standard root for a workspace and return normalized skill
 * candidates (frontmatter name preferred; duplicates disambiguated with a
 * parent prefix; sorted by final name).
 */
export async function scanSkills(cwd) {
	const roots = await skillRoots(cwd);
	const raw = [];
	const seenRoots = new Set();
	for (const root of roots) {
		if (seenRoots.has(root.path)) continue;
		seenRoots.add(root.path);
		await scanRoot(root.path, root.source, raw);
	}
	const usedNames = new Set();
	const skills = [];
	for (const candidate of raw) {
		let text;
		try {
			text = await readFile(candidate.path, "utf8");
		} catch {
			continue; // unreadable → skip (mirrors provider behavior)
		}
		const parsed = parseSkillFile(text);
		const fmName = typeof parsed.fields.name === "string" ? parsed.fields.name.trim() : "";
		// A skill requires a frontmatter `name`; a top-level note like README.md
		// (or any Markdown without a name) is not a skill and is not shown/edited.
		if (!fmName) continue;
		let displayName = NAME_RE.test(fmName) ? fmName : candidate.name;
		if (usedNames.has(displayName)) {
			// duplicate → qualify with parent (or full dir name) to stay unique
			displayName = candidate.parent ? candidate.parent + "/" + displayName : basename(dirname(candidate.path)) + "/" + displayName;
		}
		usedNames.add(displayName);
		skills.push({
			name: displayName,
			description: typeof parsed.fields.description === "string" ? parsed.fields.description : "",
			whenToUse: typeof parsed.fields.whenToUse === "string" ? parsed.fields.whenToUse : null,
			modelInvocable: parsed.fields.disableModelInvocation !== true,
			userInvocable: parsed.fields.userInvocable !== false,
			source: candidate.source,
			provider: "filesystem",
			path: candidate.path,
			dir: candidate.dir,
			nested: candidate.nested === true,
			parent: candidate.parent,
			content: text,
			metadata: null
		});
	}
	skills.sort((a, b) => a.name.localeCompare(b.name));
	return skills;
}
/** Find one filesystem skill by exact name (or parent/child path form). */
export async function findSkillByName(name, cwd) {
	const skills = await scanSkills(cwd);
	return skills.find((skill) => skill.name === name) ?? null;
}
