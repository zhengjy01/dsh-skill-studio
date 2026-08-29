// 模拟 boot 加载测试 + 扫描器/合并/编辑逻辑单测（检查清单第 2 条）
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const m = await import(path.join(pluginRoot, "lib/index.js"));
const scanner = await import(path.join(pluginRoot, "lib/scanner.js"));

const { splitFrontmatter, applyPolicy, assembleFile, saveSkill, savePolicy, listSkills, getSkillDetail } = m;
const { parseSkillFile, scanSkills, findSkillByName } = scanner;

let failures = 0;
const assert = (cond, label) => {
  if (cond) console.log("  ✅", label);
  else { console.error("  ❌", label); failures++; }
};

// ---------- 1. frontmatter 解析与行编辑 ----------
console.log("\n[1] frontmatter 解析与行编辑");
{
  const p = parseSkillFile("---\ntype: skill\nname: demo-skill\ndescription: 演示\n# 注释\n---\n# 正文\n内容");
  assert(p.fields.name === "demo-skill", "解析 name");
  assert(p.fields.description === "演示", "解析 description");
  assert(p.body.startsWith("# 正文"), "正文分离");
  assert(p.fields.disableModelInvocation === null && p.fields.userInvocable === null, "默认策略为空");
}
{
  const p = parseSkillFile("---\nname: x\nuser-invocable: false\ndisable-model-invocation: true\n---\nbody");
  assert(p.fields.userInvocable === false && p.fields.disableModelInvocation === true, "解析调用策略布尔");
}
{
  const p = parseSkillFile("---\ndescription: |\n  多行\n  描述\nname: block-skill\n---\nbody");
  assert(p.fields.description === "多行\n描述", "解析块值描述: " + JSON.stringify(p.fields.description));
}
{
  const src = "---\ntype: skill\nname: demo-skill\ndescription: 演示\n# 用户注释\n---\n# 正文\n内容";
  const fm = splitFrontmatter(src).frontmatter;
  const out = assembleFile(src, applyPolicy(fm, { modelInvocable: false, userInvocable: false }));
  assert(out.includes("disable-model-invocation: true") && out.includes("user-invocable: false"), "禁用 → 写入两个键");
  assert(out.includes("# 用户注释") && out.includes("type: skill"), "其他行保留");
  const out2 = assembleFile(out, applyPolicy(splitFrontmatter(out).frontmatter, { modelInvocable: true, userInvocable: true }));
  assert(!out2.includes("disable-model-invocation") && !out2.includes("user-invocable"), "启用 → 移除两个键");
}
{
  const src = "# 平铺 skill";
  const out = assembleFile(src, applyPolicy(null, { userInvocable: false }));
  assert(out.startsWith("---\nuser-invocable: false\n---\n"), "无 frontmatter 时创建块");
}

// ---------- 2. 扫描器（临时目录：顶层 + 嵌套展开） ----------
console.log("\n[2] 扫描器");
const tmp = mkdtempSync(path.join(tmpdir(), "dsh-sm-test-"));
const agentsRoot = path.join(tmp, ".agents", "skills");
const projDshRoot = path.join(tmp, ".dsh", "skills");
// 顶层 skill（project-agents 源）
mkdirSync(path.join(agentsRoot, "demo-skill"), { recursive: true });
writeFileSync(path.join(agentsRoot, "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: 演示技能\n---\n# 正文\n你好", "utf8");
// 嵌套 skill（模拟 superpowers）
mkdirSync(path.join(agentsRoot, "superpowers", "brainstorming"), { recursive: true });
writeFileSync(path.join(agentsRoot, "superpowers", "brainstorming", "SKILL.md"), "---\nname: brainstorming\ndescription: 头脑风暴\n---\n# 风暴", "utf8");
mkdirSync(path.join(agentsRoot, "superpowers", "writing-plans"), { recursive: true });
writeFileSync(path.join(agentsRoot, "superpowers", "writing-plans", "SKILL.md"), "---\nname: writing-plans\ndescription: 写计划\n---\n# 计划", "utf8");
// 平铺 .md skill（project-dsh 源）
mkdirSync(projDshRoot, { recursive: true });
writeFileSync(path.join(projDshRoot, "flat-skill.md"), "---\nname: flat-skill\ndescription: 平铺\n---\n# 平铺", "utf8");

const scanned = await scanSkills(tmp);
const names = scanned.map((s) => s.name);
assert(names.includes("demo-skill"), "顶层 skill 被发现: " + names.join(","));
assert(names.includes("brainstorming") && names.includes("writing-plans"), "嵌套 skill 被发现");
const nested = scanned.find((s) => s.name === "brainstorming");
assert(nested && nested.nested === true && nested.parent === "superpowers", "嵌套标记 + parent 正确");
assert(scanned.find((s) => s.name === "flat-skill").source === "project-dsh", "平铺 .md 发现 + 来源 project-dsh");
const found = await findSkillByName("brainstorming", tmp);
assert(found && found.path.endsWith("brainstorming/SKILL.md"), "findSkillByName 命中嵌套");

// ---------- 3. 模拟 boot apply + 合并 ----------
console.log("\n[3] 模拟 boot apply + 合并");
const registered = { tools: [], routes: [], sections: [] };
const ctx = {
  skills: {
    // registry 视角：一个 runtime skill；无 filesystem provider
    list: async () => [
      { name: "vision-tools", description: "视觉工具", whenToUse: null, source: "runtime", provider: "runtime",
        invocation: { modelInvocable: true, userInvocable: true } }
    ],
    get: async () => undefined
  },
  tools: { register: (t) => { registered.tools.push(t.name); return () => {}; } },
  webServer: { register: (r) => { registered.routes.push(r.path); return () => {}; } },
  systemPrompt: { section: (s) => { registered.sections.push(s.name); return () => {}; } },
  effect: (fn) => { const d = fn(); return () => (typeof d === "function" ? d() : undefined); },
  get: () => null,
  logger: { info: () => {} },
  interval: () => () => {}
};
m.apply(ctx, {});
assert(registered.tools.length === 10 && registered.tools.slice(0, 4).join(",") === "skillmgr_list,skillmgr_get,skillmgr_save,skillmgr_policy", "4 个 skill 工具 + 6 个提取工具注册");
assert(registered.tools.includes("skillmgr_extract_run") && registered.tools.includes("skillmgr_extract_accept"), "提取工具已注册");
assert(registered.routes.length === 10, "10 条路由注册（3 skill + 7 提取）");
assert(registered.sections.length === 1, "系统提示段落注册");

const merged = await listSkills(ctx, tmp);
const mergedNames = merged.map((s) => s.name);
assert(mergedNames.includes("demo-skill") && mergedNames.includes("brainstorming"), "合并含文件系统 skill");
assert(mergedNames.includes("vision-tools"), "合并含 runtime skill");
const vt = merged.find((s) => s.name === "vision-tools");
assert(vt && vt.editable === false && vt.provider === "runtime", "runtime skill 只读标记");

// ---------- 4. 真实文件读写（编辑 + 开关） ----------
console.log("\n[4] 真实文件读写");
const detail = await getSkillDetail(ctx, "demo-skill", tmp);
assert(detail && detail.editable === true && detail.content.includes("# 正文"), "getSkillDetail 返回正文 + editable");

const saved = await saveSkill(ctx, { name: "demo-skill", content: "---\nname: demo-skill\ndescription: 改过的描述\n---\n# 新正文" }, tmp);
assert(saved.ok && readFileSync(path.join(agentsRoot, "demo-skill", "SKILL.md"), "utf8").includes("# 新正文"), "saveSkill 写回文件");

const pol = await savePolicy(ctx, { name: "demo-skill", enabled: false }, tmp);
const after = readFileSync(path.join(agentsRoot, "demo-skill", "SKILL.md"), "utf8");
assert(pol.ok && pol.modelInvocable === false && after.includes("disable-model-invocation: true"), "savePolicy 禁用（模型侧）");

const pol2 = await savePolicy(ctx, { name: "demo-skill", enabled: true }, tmp);
const after2 = readFileSync(path.join(agentsRoot, "demo-skill", "SKILL.md"), "utf8");
assert(!after2.includes("disable-model-invocation") && !after2.includes("user-invocable"), "重新启用后键被移除");

const pol3 = await savePolicy(ctx, { name: "brainstorming", userInvocable: false }, tmp);
const after3 = readFileSync(path.join(agentsRoot, "superpowers", "brainstorming", "SKILL.md"), "utf8");
assert(pol3.ok && after3.includes("user-invocable: false"), "嵌套 skill 开关写入");

// 只读 skill（runtime）拒绝编辑
let threw = false;
try { await saveSkill(ctx, { name: "vision-tools", content: "x" }, tmp); } catch (e) { threw = true; }
assert(threw, "runtime 只读 skill 拒绝编辑");

console.log(failures === 0 ? "\n🎉 全部通过" : `\n💥 ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
