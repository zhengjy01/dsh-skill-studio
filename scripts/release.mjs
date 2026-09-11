#!/usr/bin/env node
/**
 * DSH 插件发布脚本（零依赖，Node >= 22）
 * ---------------------------------------------------------------------------
 * 目标：把「版本纪律」变成脚本里的硬门禁，而不是靠人记住。
 *
 *   semver 校验/推档  →  git tag  →  npm publish --tag  →  聚合同步  →  写 CHANGELOG
 *
 * 核心铁律（脚本会拒绝执行不合规的发布）：
 *   - patch 只装修复，绝不装破坏性变更
 *   - 0.x 阶段：breaking → minor（^0.2.0 == >=0.2.0 <0.3.0，不跨 minor）
 *   1.x+ 阶段：breaking → major
 *   功能 → minor；修复 → patch
 *
 * 用法（默认 dry-run，只有显式 --publish 才会真的写 registry）：
 *   node scripts/release.mjs --bump auto                 # 预演
 *   node scripts/release.mjs --bump auto --publish       # 真发
 *   node scripts/release.mjs --version 0.3.0 --publish
 *   node scripts/release.mjs --pre rc --bump minor --publish   # 发 0.3.0-rc.1（dist-tag next）
 *   node scripts/release.mjs --line 0.1 --bump patch --publish # 维护线：dist-tag 0-1
 *   node scripts/release.mjs --deprecate 0.2.1 "有严重 bug，请升 0.2.2"
 *   node scripts/release.mjs --check                     # CI/发布前只做校验
 *
 * 退出码：0 成功 / 1 失败（含纪律违规、校验未过）
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// 0. 基础设施
// ---------------------------------------------------------------------------

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[2m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', d: '', x: '' };

const log = (...a) => process.stdout.write(a.join(' ') + '\n');
const info = (m) => log(`${C.b}▸${C.x} ${m}`);
const ok = (m) => log(`${C.g}✓${C.x} ${m}`);
const warn = (m) => log(`${C.y}!${C.x} ${m}`);
const bad = (m) => log(`${C.r}✗${C.x} ${m}`);
const dim = (m) => log(`${C.d}  ${m}${C.x}`);

class Abort extends Error {}
const die = (m) => {
  throw new Abort(m);
};

/** 跑命令；throwOnFail=false 时返回 {code, stdout, stderr} 不抛。 */
function sh(cmd, args, { cwd = process.cwd(), env = {}, throwOnFail = true, quiet = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) {
    if (throwOnFail) die(`无法执行 \`${cmd}\`：${r.error.message}`);
    return { code: 127, stdout: '', stderr: r.error.message };
  }
  const out = { code: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
  if (out.code !== 0 && throwOnFail) die(`\`${cmd} ${args.join(' ')}\` 失败（exit ${out.code}）\n${out.stderr || out.stdout}`);
  return out;
}
const trySh = (cmd, args, opts) => sh(cmd, args, { ...opts, throwOnFail: false });

// ---------------------------------------------------------------------------
// 1. 最小 semver 实现（不引依赖）
// ---------------------------------------------------------------------------

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v || '').trim());
  if (!m) return null;
  return {
    raw: String(v).trim(),
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

const cmpPre = (a, b) => {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // 正式版 > 预发布
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
};

function compareSemver(a, b) {
  const A = parseSemver(a), B = parseSemver(b);
  if (!A || !B) die(`无法比较非法版本：${a} / ${b}`);
  for (const k of ['major', 'minor', 'patch']) if (A[k] !== B[k]) return A[k] < B[k] ? -1 : 1;
  return cmpPre(A.prerelease, B.prerelease);
}

function incSemver(v, kind) {
  const p = parseSemver(v);
  if (!p) die(`当前版本非法：${v}`);
  if (kind === 'major') return `${p.major + 1}.0.0`;
  if (kind === 'minor') return `${p.major}.${p.minor + 1}.0`;
  if (kind === 'patch') return `${p.major}.${p.minor}.${p.patch + 1}`;
  die(`未知的 bump 类型：${kind}`);
}

/** base 形如 0.3.0；current 形如 0.3.0-rc.2 → rc.3，否则 rc.1。 */
const nextPreNumber = (current, base) => {
  const p = parseSemver(current);
  if (p && `${p.major}.${p.minor}.${p.patch}` === base && p.prerelease.length >= 2) {
    const n = Number(p.prerelease[p.prerelease.length - 1]);
    if (Number.isFinite(n)) return n + 1;
  }
  return 1;
};

// ---------------------------------------------------------------------------
// 2. 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    bump: null, version: null, pre: null, tag: null, line: null,
    publish: false, check: false, yes: false, json: false,
    skipGit: false, skipNpm: false, skipAggregates: false, skipChangelog: false,
    deprecate: null, allowDirty: false, branch: null, remote: 'origin',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined) die(`参数 ${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case '--bump': o.bump = need(); break;
      case '--version': case '-v': o.version = need(); break;
      case '--pre': case '--prerelease': o.pre = need(); break;
      case '--tag': o.tag = need(); break;
      case '--line': o.line = need(); break;
      case '--publish': o.publish = true; break;
      case '--dry-run': o.publish = false; break;
      case '--check': case '--verify': o.check = true; break;
      case '--yes': case '-y': o.yes = true; break;
      case '--json': o.json = true; break;
      case '--skip-git': o.skipGit = true; break;
      case '--skip-npm': o.skipNpm = true; break;
      case '--skip-aggregates': o.skipAggregates = true; break;
      case '--skip-changelog': o.skipChangelog = true; break;
      case '--allow-dirty': o.allowDirty = true; break;
      case '--branch': o.branch = need(); break;
      case '--remote': o.remote = need(); break;
      case '--deprecate': {
        const v = need();
        const m = argv[++i];
        if (m === undefined) die('--deprecate 需要两个参数：<版本> "<原因>"');
        o.deprecate = { version: v, message: m };
        break;
      }
      case '--help': case '-h': o.help = true; break;
      default:
        if (a.startsWith('--')) die(`未知参数：${a}（用 --help 看用法）`);
    }
  }
  return o;
}

const HELP = `
DSH 插件发布脚本（默认 dry-run，需 --publish 才真发）

  版本
    --bump <auto|patch|minor|major>   按提交推档（auto = 读 conventional commits）
    --version <x.y.z>                 直接指定目标版本
    --pre <rc|beta|alpha>             发预发布，如 --pre rc → 0.2.1-rc.1（dist-tag 默认 next）
    --line <x.y>                      维护线发布（如 0.1），dist-tag 默认 0-1

  分档
    --tag <name>                      npm dist-tag（默认：正式 → latest，预发布 → next）

  动作
    --publish                         真正执行（默认只预演）
    --check                           只做发布前校验（CI 用）
    --deprecate <ver> "<msg>"         弃用某个已发布版本（不发布新版本）
    --yes                             跳过交互确认

  跳过
    --skip-git / --skip-npm / --skip-aggregates / --skip-changelog / --allow-dirty
    --branch <name>                   指定发布分支（默认当前分支）
    --remote <name>                   git remote（默认 origin）
    --json                            输出机器可读结果
`;

// ---------------------------------------------------------------------------
// 3. 仓库上下文
// ---------------------------------------------------------------------------

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { die(`无法解析 ${p}：${e.message}`); }
}

function loadContext(cwd) {
  const root = resolve(cwd);
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) die(`当前目录没有 package.json：${root}`);
  const pkg = readJson(pkgPath);

  const cfgPath = join(root, 'release.config.json');
  const cfg = existsSync(cfgPath) ? readJson(cfgPath) : {};

  const changelogPath = join(root, 'CHANGELOG.md');
  const gitReady = existsSync(join(root, '.git')) && trySh('git', ['rev-parse', '--git-dir'], { cwd: root }).code === 0;

  return { root, pkg, pkgPath, cfg, changelogPath, gitReady };
}

const git = (ctx, args, opts = {}) => trySh('git', args, { cwd: ctx.root, ...opts }).stdout;

// ---------------------------------------------------------------------------
// 4. 提交分析与版本纪律
// ---------------------------------------------------------------------------

/** 取自 since 起的提交（since 为空 → 全量历史）。 */
function collectCommits(ctx, since) {
  const range = since ? `${since}..HEAD` : 'HEAD';
  const raw = git(ctx, ['log', range, '--no-merges', '--pretty=format:%s%x1f%b%x1e']);
  if (!raw) return [];
  return raw
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((block) => {
      const [subject = '', body = ''] = block.split('\x1f');
      return { subject: subject.trim(), body: body.trim() };
    });
}

const HEADER_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<desc>.+)$/i;

function classifyCommits(commits) {
  const breaking = [], feat = [], fix = [], other = [];
  for (const c of commits) {
    const m = HEADER_RE.exec(c.subject);
    const isBreaking = Boolean(m?.groups?.bang) || /^BREAKING[ -]CHANGE:/im.test(c.body);
    if (isBreaking) breaking.push(c);
    else if (m?.groups?.type?.toLowerCase() === 'feat') feat.push(c);
    else if (m?.groups?.type?.toLowerCase() === 'fix') fix.push(c);
    else other.push(c);
  }
  return { breaking, feat, fix, other };
}

/**
 * 版本纪律：从「当前版本 + 变更性质」推出**最低允许**的 bump。
 *   breaking: 0.x → minor；>=1.x → major
 *   feat:     minor
 *   其它:     patch
 */
function requiredBump(currentVersion, changes) {
  const cur = parseSemver(currentVersion);
  if (!cur) die(`package.json version 非法：${currentVersion}`);
  if (changes.breaking.length > 0) return cur.major === 0 ? 'minor' : 'major';
  if (changes.feat.length > 0) return 'minor';
  return 'patch';
}

const RANK = { patch: 0, minor: 1, major: 2 };

/**
 * 校验目标版本满足纪律：
 *  - 目标 bump 档位不得低于 required（0.x 的 breaking 必须走 minor）
 *  - patch 档位一律不允许含 breaking —— 这是唯一真会坑到 ^x.y.z 用户的场景
 */
function assertDiscipline(currentVersion, targetVersion, changes) {
  const cur = parseSemver(currentVersion);
  const tgt = parseSemver(targetVersion);
  if (!cur || !tgt) die('版本号非法，无法做纪律校验');
  if (compareSemver(targetVersion, currentVersion) <= 0) die(`目标版本 ${targetVersion} 不大于当前版本 ${currentVersion}`);

  const req = requiredBump(currentVersion, changes);
  const curBase = `${cur.major}.${cur.minor}.${cur.patch}`;
  const tgtBase = `${tgt.major}.${tgt.minor}.${tgt.patch}`;

  // 预发布：base 相同或按 required 递增即可
  if (tgt.prerelease.length > 0) {
    const sameBase = tgtBase === curBase;
    const bumped = { major: tgt.major > cur.major, minor: tgt.major === cur.major && tgt.minor > cur.minor, patch: tgtBase === incSemver(curBase, 'patch') };
    if (sameBase) {
      // 同 base 的预发布视为「演练下一个版本的补丁档」，不允许在其中夹带 breaking
      if (changes.breaking.length > 0) {
        die([
          `不允许在「同 base 的预发布」里夹带破坏性变更（${curBase} → ${targetVersion}）。`,
          `0.x 阶段破坏性变更必须走 minor：${incSemver(curBase, 'minor')}-${(tgt.prerelease[0] || 'rc')}.1 起。`,
        ].join('\n'));
      }
      return { required: req, level: 'patch' };
    }
    if (req === 'major' && !bumped.major) die(`存在破坏性变更，${cur.major >= 1 ? '必须走 major' : '必须走 minor'}：目标 ${targetVersion} 不够`);
    if (req === 'minor' && !bumped.major && !bumped.minor) die(`存在${changes.breaking.length ? '破坏性变更' : '新功能'}，必须走 minor：目标 ${targetVersion} 不够`);
    return { required: req, level: bumped.major ? 'major' : bumped.minor ? 'minor' : 'patch' };
  }

  if (changes.breaking.length > 0) {
    if (cur.major === 0 && !(tgt.major === 0 && tgt.minor > cur.minor)) {
      die([
        `破坏性变更必须走 minor（0.x 阶段）：当前 ${currentVersion}。`,
        `  原因：^${cur.major}.${cur.minor}.${cur.patch} 等价于 >=${cur.major}.${cur.minor}.${cur.patch} <${cur.major}.${cur.minor + 1}.0，`,
        `  不跨 minor。破坏性变更放进 minor，留在旧 minor 的用户不会被自动升级。`,
        `  推荐目标：${incSemver(currentVersion, 'minor')}`,
      ].join('\n'));
    }
    if (cur.major >= 1 && tgt.major === cur.major) {
      die(`破坏性变更必须走 major：当前 ${currentVersion} → 推荐 ${incSemver(currentVersion, 'major')}（目标 ${targetVersion} 仍在 ${cur.major}.x）`);
    }
  }
  if (changes.feat.length > 0 && tgt.major === cur.major && tgt.minor === cur.minor) {
    die(`存在新功能，必须走 minor：当前 ${currentVersion} → 推荐 ${incSemver(currentVersion, 'minor')}（目标 ${targetVersion} 只是 patch）`);
  }

  const level = tgt.major > cur.major ? 'major' : tgt.minor > cur.minor ? 'minor' : 'patch';
  if (RANK[level] < RANK[req]) die(`目标版本 ${targetVersion} 的档位（${level}）低于纪律要求（${req}）`);
  return { required: req, level };
}

// ---------------------------------------------------------------------------
// 5. 发布前校验
// ---------------------------------------------------------------------------

function npmView(pkgName, field) {
  const r = trySh('npm', ['view', `${pkgName}@${field}`, '--json'], { quiet: true });
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return r.stdout || null; }
}

function checkCompatDeclarations(ctx) {
  const issues = [];
  const notes = [];
  const pkg = ctx.pkg;

  if (!pkg.dsh?.engines?.dsh) {
    issues.push('缺少 `dsh.engines.dsh`（生态惯例声明；dshmarket 实际读 peer 并集，但两者都要有）');
  } else {
    notes.push(`dsh.engines.dsh = ${pkg.dsh.engines.dsh}`);
  }

  const peers = Object.entries(pkg.peerDependencies || {}).filter(([n]) => n.startsWith('@deepseek-ai/dsh'));
  if (peers.length === 0) issues.push('缺少 `@deepseek-ai/dsh*` 的 peerDependencies（插件市场靠它算兼容范围）');
  else notes.push(`peer 兼容声明 ${peers.length} 条：${peers.map(([n, v]) => `${n}@${v}`).join('、')}`);

  if (!pkg.engines?.node) issues.push('缺少 `engines.node`（Node 版本不兼容应在安装时报错，而不是静默坏）');

  const files = pkg.files || [];
  if (!files.includes('CHANGELOG.md')) issues.push('`files` 未包含 CHANGELOG.md（变更记录不会进 tarball）');
  if (!files.includes('lib')) issues.push('`files` 未包含 lib');

  // cordis.patch.yml 的 name 必须与包名一致（改名最易漏这里）
  const patchRel = pkg.dsh?.bundle?.patch;
  if (patchRel) {
    const patchPath = join(ctx.root, patchRel);
    if (!existsSync(patchPath)) issues.push(`dsh.bundle.patch 指向的文件不存在：${patchRel}`);
    else {
      const m = /^name:\s*(.+)$/m.exec(readFileSync(patchPath, 'utf8'));
      const declared = m?.[1]?.trim().replace(/^['"]|['"]$/g, '');
      if (declared && declared !== pkg.name) issues.push(`cordis.patch.yml 的 name(${declared}) ≠ package.json name(${pkg.name})`);
      else if (declared) notes.push(`cordis bundle name 一致：${declared}`);
    }
  } else {
    issues.push('缺少 `dsh.bundle.patch`');
  }

  if (!pkg.repository?.url) issues.push('缺少 `repository.url`');
  return { issues, notes };
}

function checkChangelog(ctx) {
  const issues = [];
  if (!existsSync(ctx.changelogPath)) {
    issues.push('缺少 CHANGELOG.md（每个破坏性版本都要有迁移说明）');
    return { issues, notes: [] };
  }
  const text = readFileSync(ctx.changelogPath, 'utf8');
  const notes = [];
  if (!/\[Unreleased\]/i.test(text)) issues.push('CHANGELOG.md 缺少 `## [Unreleased]` 段落');
  const cur = ctx.pkg.version;
  if (!text.includes(`[${cur}]`)) notes.push(`CHANGELOG.md 尚无 [${cur}] 段落（发布时会自动补写）`);
  else notes.push(`CHANGELOG.md 已含 [${cur}] 段落`);
  return { issues, notes };
}

function runChecks(ctx, { strict = true, allowDirty = false } = {}) {
  info(`发布前校验：${ctx.pkg.name}@${ctx.pkg.version}（${ctx.root}）`);
  const issues = [];
  const notes = [];

  if (!ctx.gitReady) issues.push('不是 git 仓库（或 git 不可用）');
  else {
    const dirty = git(ctx, ['status', '--porcelain']);
    if (dirty && !allowDirty) issues.push(`工作区不干净（${dirty.split('\n').length} 个改动），先提交再发布`);
    else if (dirty) notes.push(`工作区不干净（${dirty.split('\n').length} 个改动）—— --allow-dirty 已放行`);
    const branch = git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD']);
    notes.push(`分支：${branch}`);
  }

  const comp = checkCompatDeclarations(ctx);
  issues.push(...comp.issues);
  notes.push(...comp.notes);

  const cl = checkChangelog(ctx);
  issues.push(...cl.issues);
  notes.push(...cl.notes);

  // 目录名 ≠ 包名 是这些仓库的历史坑，明确提示
  const dirName = ctx.root.split('/').pop();
  if (dirName !== ctx.pkg.name) notes.push(`注意：目录名 ${dirName} ≠ 包名 ${ctx.pkg.name}（脚本一律以 package.json 为准）`);

  for (const n of notes) dim(n);
  if (issues.length > 0) {
    for (const i of issues) bad(i);
    if (strict) die(`${issues.length} 项校验未通过`);
    return { ok: false, issues, notes };
  }
  ok('校验全部通过');
  return { ok: true, issues: [], notes };
}

// ---------------------------------------------------------------------------
// 6. CHANGELOG 生成
// ---------------------------------------------------------------------------

const CHANGELOG_HEADER = (name) => `# Changelog

> ${name} 的全部版本变更。本文件由 \`scripts/release.mjs\` 在发布时自动补写。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

`;

function categorize(changes) {
  const sec = [];
  if (changes.breaking.length) sec.push(['⚠️ 破坏性变更 (BREAKING)', changes.breaking]);
  if (changes.feat.length) sec.push(['新增 (Added)', changes.feat]);
  if (changes.fix.length) sec.push(['修复 (Fixed)', changes.fix]);
  if (changes.other.length) sec.push(['其它 (Changed)', changes.other]);
  return sec;
}

function renderEntry(ctx, version, date, changes, extraNotes = []) {
  const pkg = ctx.pkg;
  const lines = [`## [${version}] - ${date}`, ''];
  for (const [title, items] of categorize(changes)) {
    lines.push(`### ${title}`, '');
    for (const c of items) lines.push(`- ${c.subject}`);
    lines.push('');
  }
  const dshRange = pkg.dsh?.engines?.dsh;
  lines.push('### 兼容性 (Compatibility)', '');
  if (dshRange) lines.push(`- DSH：\`${dshRange}\``);
  const nodeRange = pkg.engines?.node;
  if (nodeRange) lines.push(`- Node：\`${nodeRange}\``);
  const dshPeers = [...new Set(
    Object.entries(pkg.peerDependencies || {})
      .filter(([n]) => n.startsWith('@deepseek-ai/dsh'))
      .map(([, v]) => v),
  )];
  if (dshPeers.length) lines.push(`- DSH peer：${dshPeers.join(' || ')}`);
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
    lines.push(`- 运行时依赖：${Object.entries(pkg.dependencies).map(([n, v]) => `\`${n}@${v}\``).join('、')}`);
  }
  for (const n of extraNotes) lines.push(`- ${n}`);
  lines.push('');
  if (changes.breaking.length) {
    lines.push('### 迁移说明 (Migration)', '');
    lines.push('> 破坏性版本必须在这里写清「用户要改什么」。发布后在 GitHub Release 同步一份。', '');
    for (const c of changes.breaking) lines.push(`- ${c.subject}`);
    lines.push('');
  }
  return lines.join('\n');
}

function writeChangelog(ctx, version, changes, { dryRun }) {
  const text = existsSync(ctx.changelogPath)
    ? readFileSync(ctx.changelogPath, 'utf8')
    : CHANGELOG_HEADER(ctx.pkg.name);
  const date = new Date().toISOString().slice(0, 10);
  const entry = renderEntry(ctx, version, date, changes);

  if (text.includes(`## [${version}]`)) {
    warn(`CHANGELOG.md 已存在 [${version}] 段落，跳过写入`);
    return false;
  }
  let next;
  const anchor = /^##\s*\[Unreleased\][^\n]*\n/m.exec(text);
  if (anchor) {
    const at = anchor.index + anchor[0].length;
    next = text.slice(0, at) + '\n' + entry + text.slice(at);
  } else {
    // 插到第一个版本段之前，或文件末尾
    const first = /^##\s*\[/m.exec(text);
    next = first ? text.slice(0, first.index) + entry + text.slice(first.index) : `${text.trimEnd()}\n\n${entry}`;
  }
  if (dryRun) {
    info('将写入 CHANGELOG.md 的段落：');
    dim(entry.split('\n').slice(0, 12).join('\n  '));
    return true;
  }
  writeFileSync(ctx.changelogPath, next);
  ok(`CHANGELOG.md 已写入 [${version}]`);
  return true;
}

// ---------------------------------------------------------------------------
// 7. 发布动作
// ---------------------------------------------------------------------------

function npmAuthEnv() {
  // 凭据优先级：本机 ~/.dsh/dsh-npm.json 的 token（npm 自身未登录）
  const dshNpm = join(process.env.HOME || '', '.dsh', 'dsh-npm.json');
  const env = {};
  const cleanups = [];
  if (existsSync(dshNpm)) {
    const cfg = readJson(dshNpm);
    if (cfg.token) {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-rel-rc-'));
      const rc = join(dir, '.npmrc');
      writeFileSync(rc, `//registry.npmjs.org/:_authToken=${cfg.token}\n`, { mode: 0o600 });
      chmodSync(rc, 0o600);
      env.NPM_CONFIG_USERCONFIG = rc;
      env.NPM_CONFIG_CACHE = mkdtempSync(join(tmpdir(), 'dsh-rel-cache-'));
      cleanups.push(dir, env.NPM_CONFIG_CACHE);
      env.__usedToken = 'yes';
    }
  }
  return { env, cleanups };
}

function doPublish(ctx, version, tag, { dryRun, env }) {
  const args = ['publish', '--tag', tag, '--access', 'public'];
  if (dryRun) {
    // dry-run 不能真的调 `npm publish --dry-run`：此时 package.json 尚未 bump，
    // 它会拿**旧版本号**去 registry 校验并报 "cannot publish over previously published versions"。
    // 改用 `npm pack --dry-run` 验证分发物内容（不查 registry），再打印将要执行的命令。
    info('npm pack --dry-run（验证分发物）');
    const pack = trySh('npm', ['pack', '--dry-run', '--json'], { cwd: ctx.root, quiet: true });
    if (pack.code === 0) {
      try {
        const j = JSON.parse(pack.stdout)[0];
        dim(`tarball: ${j.filename} · ${j.entryCount} files · ${(j.size / 1024).toFixed(1)} kB`);
        for (const f of j.files.map((f) => f.path)) dim(`  ${f}`);
      } catch { dim('（无法解析 pack 输出）'); }
    } else {
      warn(`npm pack --dry-run 失败：${pack.stderr || pack.stdout}`);
    }
    info(`[dry-run] 将执行：npm ${args.join(' ')}`);
    return { processing: false };
  }
  info(`npm ${args.join(' ')}`);
  const r = trySh('npm', args, { cwd: ctx.root, env, quiet: true });
  if (r.code !== 0) {
    bad(`npm publish 失败（exit ${r.code}）`);
    dim(r.stderr || r.stdout);
    die('npm publish 失败');
  }
  // 202 = being processed：不是失败，但版本不会立刻可见
  const processing = /202|being processed/i.test(r.stdout + r.stderr);
  if (processing) warn('registry 返回 202「being processed」：版本需 2–3 分钟才可见，**不要**急着重发同版本（会 409）');
  else ok(`npm publish 完成（tag=${tag}）`);
  return { processing };
}

function doGit(ctx, version, { dryRun, branch, remote, tag }) {
  const tagName = `v${version}`;
  const b = branch || git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';

  const existing = git(ctx, ['tag', '-l', tagName]);
  if (existing) die(`git tag ${tagName} 已存在（重发请先确认该版本未发布过）`);

  if (!dryRun) {
    git(ctx, ['add', '-A']);
    trySh('git', ['commit', '-m', `chore(release): ${version}`], { cwd: ctx.root });
    git(ctx, ['tag', '-a', tagName, '-m', `Release ${version}`]);
    ok(`已打 tag ${tagName}`);
    const push = trySh('git', ['push', remote, b, '--follow-tags'], { cwd: ctx.root, quiet: true });
    if (push.code !== 0) {
      warn(`git push 失败：${push.stderr}`);
      warn(`可稍后手动：git push ${remote} ${b} --follow-tags`);
    } else ok(`已 push ${remote}/${b} + tag ${tagName}`);
  } else {
    info(`[dry-run] 将 commit / tag ${tagName} / push ${remote} ${b} --follow-tags`);
  }
  return tagName;
}

function doAggregates(ctx, version, { dryRun }) {
  const aggs = ctx.cfg.aggregates || [];
  if (aggs.length === 0) {
    info('未配置聚合同步（release.config.json 的 aggregates 为空）');
    return [];
  }
  const results = [];
  for (const a of aggs) {
    if (!a.command) {
      results.push({ name: a.name, status: 'skipped', note: a.note || '无需手动同步' });
      dim(`${a.name}：跳过（${a.note || '自动扫描/无需手动同步'}）`);
      continue;
    }
    const command = a.command.replaceAll('${VERSION}', version).replaceAll('${PKG}', ctx.pkg.name);
    if (dryRun) {
      results.push({ name: a.name, status: 'planned', command });
      info(`[dry-run] 聚合同步 ${a.name}：${command}`);
      continue;
    }
    const r = trySh('sh', ['-c', command], { cwd: ctx.root, quiet: true });
    results.push({ name: a.name, status: r.code === 0 ? 'ok' : 'failed', note: (r.stdout || r.stderr).slice(0, 400) });
    if (r.code === 0) ok(`聚合同步 ${a.name} 完成`);
    else warn(`聚合同步 ${a.name} 失败（不阻塞发布）：${(r.stderr || r.stdout).slice(0, 200)}`);
  }
  return results;
}

function doDeprecate(ctx, { version, message }, { dryRun }) {
  const { env, cleanups } = npmAuthEnv();
  try {
    if (!/^\d+\.\d+\.\d+/.test(version)) die(`--deprecate 的版本非法：${version}`);
    const args = ['deprecate', `${ctx.pkg.name}@${version}`, message];
    info(`npm ${args.join(' ')}`);
    if (dryRun) { dim('[dry-run] 不执行'); return; }
    const r = trySh('npm', args, { cwd: ctx.root, env, quiet: true });
    if (r.code !== 0) die(`npm deprecate 失败：${r.stderr || r.stdout}`);
    ok(`已弃用 ${ctx.pkg.name}@${version}（版本仍可安装，只是安装时会看到警告）`);
  } finally {
    for (const d of cleanups) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 8. 主流程
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const o = parseArgs(argv);
  if (o.help) { log(HELP); return 0; }

  const ctx = loadContext(process.cwd());

  if (o.deprecate) {
    doDeprecate(ctx, o.deprecate, { dryRun: !o.publish });
    return 0;
  }

  if (o.check) {
    const res = runChecks(ctx, { allowDirty: o.allowDirty });
    if (o.json) log(JSON.stringify({ ok: res.ok, issues: res.issues, notes: res.notes }, null, 2));
    return res.ok ? 0 : 1;
  }

  const current = ctx.pkg.version;
  if (!parseSemver(current)) die(`package.json 的 version 非法：${current}`);

  // 上一次发布的 tag（用于限定提交范围与推档）
  const lastTagRaw = git(ctx, ['describe', '--tags', '--abbrev=0', '--match', 'v*']);
  const lastTag = lastTagRaw || null;
  const commits = collectCommits(ctx, lastTag);
  const changes = classifyCommits(commits);

  info(`当前版本 ${current}${lastTag ? `（上个 tag ${lastTag}）` : '（无历史 tag，按全量历史分析）'}`);
  dim(`自上次发布共 ${commits.length} 个提交：breaking ${changes.breaking.length} / feat ${changes.feat.length} / fix ${changes.fix.length} / 其它 ${changes.other.length}`);

  const req = requiredBump(current, changes);
  info(`纪律要求的最低档位：${req}${changes.breaking.length ? '（检测到破坏性变更）' : ''}`);

  // 解析目标版本
  let target = o.version;
  if (!target) {
    const bump = o.bump || 'auto';
    let kind;
    if (bump === 'auto') kind = req;
    else if (['patch', 'minor', 'major'].includes(bump)) {
      if (RANK[bump] < RANK[req]) {
        die([
          `--bump ${bump} 违反版本纪律：检测到${changes.breaking.length ? '破坏性变更' : changes.feat.length ? '新功能' : '变更'}，最低要求 ${req}。`,
          changes.breaking.length
            ? `  铁律：patch 只装修复，绝不装 breaking（否则所有 ^${current} 用户自动升到坏版本）。`
            : '',
        ].filter(Boolean).join('\n'));
      }
      kind = bump;
    } else die(`--bump 只接受 auto|patch|minor|major，收到 ${bump}`);
    target = incSemver(current, kind);
  }

  if (o.pre) {
    const base = target.split('-')[0];                 // 0.3.0
    if (!/^(rc|beta|alpha|next)$/i.test(o.pre)) {
      // 允许自定义预发布标识：--pre canary.1
      target = `${base}-${o.pre}`;
    } else {
      const label = o.pre.toLowerCase() === 'next' ? 'rc' : o.pre.toLowerCase();
      target = `${base}-${label}.${nextPreNumber(current, base)}`;
    }
  }

  // 纪律校验（含 patch 不得含 breaking）
  const discipline = assertDiscipline(current, target, changes);
  ok(`版本推档合规：${current} → ${target}（档位 ${discipline.level}，纪律要求 ${discipline.required}）`);

  // dist-tag 分档
  const isPre = parseSemver(target).prerelease.length > 0;
  let tag = o.tag;
  if (!tag) {
    if (o.line) tag = o.line.replace(/\./g, '-');        // 0.1 → 0-1（维护线分档）
    else if (isPre) tag = 'next';                        // rc/beta → next
    else tag = 'latest';                                 // 稳定线 → latest
  }
  info(`dist-tag：${tag}${o.line ? `（维护线 ${o.line}）` : ''}`);

  // 目标版本不得已存在
  if (!o.skipNpm) {
    const exists = trySh('npm', ['view', `${ctx.pkg.name}@${target}`, 'version'], { quiet: true });
    if (exists.code === 0 && exists.stdout) die(`${ctx.pkg.name}@${target} 已存在于 registry，不能重复发布（要覆盖只能 force，属高危操作，本脚本不提供）`);
    else ok(`registry 中 ${ctx.pkg.name}@${target} 尚不存在`);
  }

  const dryRun = !o.publish;
  if (dryRun) {
    warn('DRY-RUN：不会写 registry / 不会 commit / 不会 push。加 --publish 才真发。');
  } else if (!o.yes) {
    die('真发布需要同时加 --publish --yes（避免误触）');
  }

  runChecks(ctx, { strict: true, allowDirty: o.allowDirty });

  // 1) 写 CHANGELOG（先写，让 commit 里带上）
  const extraNotes = o.line ? [`维护线发布（release/${o.line}）：仅修 bug / 安全问题的 cherry-pick`] : [];
  if (!o.skipChangelog) writeChangelog(ctx, target, changes, { dryRun });

  // 2) bump package.json version
  if (!dryRun) {
    const pkgRaw = readFileSync(ctx.pkgPath, 'utf8');
    const bumped = pkgRaw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${target}$2`);
    writeFileSync(ctx.pkgPath, bumped);
    ok(`package.json version → ${target}`);
  } else {
    info(`[dry-run] package.json version → ${target}`);
  }

  // 3) 构建（有 build 脚本才跑）
  const buildCmd = ctx.cfg.build ?? (ctx.pkg.scripts?.build ? 'npm run build' : null);
  if (buildCmd && !/^none$/i.test(buildCmd)) {
    if (dryRun) info(`[dry-run] 构建：${buildCmd}`);
    else {
      info(`构建：${buildCmd}`);
      const r = trySh('sh', ['-c', buildCmd], { cwd: ctx.root, quiet: true });
      if (r.code !== 0) { dim(r.stdout || r.stderr); die('构建失败，发布中止'); }
      ok('构建通过');
    }
  }

  let tagName = null;
  if (!o.skipGit) tagName = doGit(ctx, target, { dryRun, branch: o.branch, remote: o.remote, tag });

  if (!o.skipNpm) {
    const { env, cleanups } = npmAuthEnv();
    try {
      doPublish(ctx, target, tag, { dryRun, env });
    } finally {
      for (const d of cleanups) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  const aggregates = o.skipAggregates ? [] : doAggregates(ctx, target, { dryRun });

  const result = {
    package: ctx.pkg.name,
    from: current,
    to: target,
    distTag: tag,
    gitTag: tagName,
    dryRun,
    discipline,
    changes: { breaking: changes.breaking.length, feat: changes.feat.length, fix: changes.fix.length, other: changes.other.length },
    aggregates,
    installHint: `dsh plugin --profile web add ${ctx.pkg.name}@${target}`,
  };

  if (o.json) log(JSON.stringify(result, null, 2));
  else {
    log('');
    ok(`${dryRun ? '[DRY-RUN] 计划' : '发布'}完成：${ctx.pkg.name}@${target}（tag=${tag}）`);
    dim(`用户安装：dsh plugin --profile web add ${ctx.pkg.name}@${target}`);
    if (isPre) dim(`预发布分档：npm i ${ctx.pkg.name}@next`);
    if (o.line) dim(`维护线分档：npm i ${ctx.pkg.name}@${tag}`);
    if (!dryRun) dim('别忘了：GitHub Release 写迁移说明（破坏性版本必填）、回填 Obsidian、同步聚合平台');
  }
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  if (e instanceof Abort) {
    bad(e.message);
    process.exit(1);
  }
  bad(`未预期错误：${e?.stack || e}`);
  process.exit(1);
}
