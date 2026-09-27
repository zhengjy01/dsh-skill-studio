#!/usr/bin/env node
/**
 * dsh-release-kit / portability.mjs — 把「能不能移植到别人的电脑」变成脚本门禁。
 *
 * 本地开发时，`link:` 挂载 + 你自己的 profile + 你自己的 `~/.dsh` 会掩盖一堆问题：
 * 绝对路径、写死 `~/.dsh`、只在 macOS 成立的假设、包里漏发包内文件、客户端半根本没被
 * shell 收进 boot payload……这些只在别人机器上炸，而且常常是「装上了但什么都没发生」。
 *
 * 本脚本用「别人电脑」的方式验证一遍：
 *
 *   1. 静态体检   —— 源码里的本机绝对路径 / 裸用的平台专有命令 / 不认 DSH_HOME 的家目录
 *   2. 打包       —— npm pack，并核对声明过的入口真的进了包
 *   3. 干净安装   —— 新建空 profile，用 tarball 安装（不走 link:）
 *   4. 启动       —— 空闲端口跑起来
 *   5. 宿主半验证 —— 打健康路由，确认插件真的挂载
 *   6. 客户端半验证 —— 确认 bundle 进了 __DSH_BOOT__.entries 且能取到
 *   7. 真实动作   —— 可选：POST 真实重启，确认服务带着新 pid 回来
 *   8. 清理       —— 停实例、删 profile、删 tarball（--keep 保留）
 *
 * 零依赖，Node ≥ 20（用内置 fetch / getSetCookie）。
 *
 *   node scripts/portability.mjs
 *   node scripts/portability.mjs --health /api/foo/probe --restart-route /api/foo/restart
 *   node scripts/portability.mjs --no-isolate   # 共享本机 ~/.dsh（默认是隔离的临时 home）
 *   node scripts/portability.mjs --json         # 机器可读报告
 *   node scripts/portability.mjs --stability 30 # 就绪后多守一会儿（默认 15 秒）
 *   node scripts/portability.mjs --cwd <插件目录>
 *
 * 退出码：0 = 通过（可以发布），1 = 未通过，2 = 用法/环境错误。
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2)
const flag = (name, fallback = undefined) => {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value !== undefined && !value.startsWith('--') ? value : fallback
}
const has = (name) => argv.includes(name)

const options = {
  cwd: path.resolve(flag('--cwd', process.cwd())),
  dsh: flag('--dsh', 'dsh'),
  health: flag('--health', ''),
  restartRoute: flag('--restart-route', ''),
  pluginId: flag('--plugin-id', ''),
  port: Number(flag('--port', '0')) || 0,
  bootTimeoutSec: Number(flag('--timeout', '90')) || 90,
  keep: has('--keep'),
  // 默认隔离：同机第二个实例会抢 `~/.dsh/.credentials.yaml` 的写锁并启动失败，
  // 而且用开发者的 home 会掩盖「全新机器」的问题。--no-isolate 才共享 home。
  isolate: !has('--no-isolate'),
  json: has('--json'),
  skipAudit: has('--skip-audit'),
  /** 就绪后不再做稳定性观察（默认做）。 */
  skipStability: has('--skip-stability'),
}

/* ------------------------------------------------------------------ 输出 */

const results = []
let failed = 0

function record(level, title, detail = '') {
  results.push({ level, title, detail })
  if (options.json) return
  const mark = level === 'pass' ? '✔' : level === 'fail' ? '✘' : level === 'warn' ? '!' : '·'
  const line = `  ${mark} ${title}${detail === '' ? '' : ' — ' + detail}`
  if (level === 'fail') console.error(line)
  else console.log(line)
}
const pass = (title, detail) => record('pass', title, detail)
const fail = (title, detail) => {
  failed++
  record('fail', title, detail)
}
const warn = (title, detail) => record('warn', title, detail)
const info = (title, detail) => record('info', title, detail)
const section = (title) => {
  if (!options.json) console.log(`\n${title}`)
}

/* ------------------------------------------------------------------ 小工具 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 弹一个空闲端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

/** 该端口上有人应答吗。 */
function probePort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 同步跑一条命令，失败不抛。 */
function run(file, args, runOptions = {}) {
  try {
    const stdout = execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...runOptions })
    return { ok: true, stdout, stderr: '' }
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message ?? error) }
  }
}

/** 递归列出源码文件（跳过 node_modules / .git / lib 产物）。 */
function listSources(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listSources(full, out)
    else if (/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/* ---------------------------------------------------------- 1. 静态体检 */

const USER_PATH = /(\/(?:Users|home)\/[A-Za-z0-9._-]+|C:\\Users\\[A-Za-z0-9._-]+)/
const PLATFORM_ONLY = /\b(launchctl|plutil|launchd)\b/
const PLATFORM_GUARD = /darwin|process\.platform/
const DSH_HOME_USE = /DSH_HOME/
const DOT_DSH = /\.dsh(?![\w-])/

function auditSources(cwd) {
  const files = ['src', 'helper', 'bin', 'scripts']
    .flatMap((dir) => listSources(path.join(cwd, dir)))
    // 浏览器半不会 shell out、也不会解析 home：扫它只会造成假阳性
    .filter((file) => !file.endsWith('.min.js') && !file.includes(`${path.sep}client${path.sep}`))
  const hits = { absolute: [], platform: [], home: [] }
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const relative = path.relative(cwd, file)
    text.split('\n').forEach((line, index) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return // 注释不算
      const absolute = USER_PATH.exec(line)
      if (absolute !== null) hits.absolute.push(`${relative}:${index + 1} → ${absolute[1]}`)
      if (PLATFORM_ONLY.test(line) && !PLATFORM_GUARD.test(text)) {
        hits.platform.push(`${relative}:${index + 1}`)
      }
    })
    // 写 ~/.dsh 却不认 DSH_HOME：搬迁过 home 的机器会写到错的地方。
    // 只看非注释行，且 `.dsh` 后面不能紧跟词字符（否则 .dshwx-ball 之类会误报）。
    const homeHit = text
      .split('\n')
      .some((line) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return false
        return DOT_DSH.test(line)
      })
    if (homeHit && !DSH_HOME_USE.test(text)) hits.home.push(relative)
  }
  return { count: files.length, hits }
}

/* ------------------------------------------------------------------ 入口 */

const pkgPath = path.join(options.cwd, 'package.json')
if (!existsSync(pkgPath)) {
  console.error(`找不到 package.json：${pkgPath}（用 --cwd <插件目录> 指定）`)
  process.exit(2)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const id = options.pluginId !== '' ? options.pluginId : pkg.name
const hasClient = pkg.dsh?.client !== undefined
const bundlePatch = pkg.dsh?.bundle?.patch

if (!options.json) {
  console.log(`\n可移植性验证：${id}@${pkg.version ?? '?'}`)
  console.log(`  目录：${options.cwd}`)
  console.log(`  客户端半：${hasClient ? '有' : '无'}　bundle patch：${bundlePatch ?? '无'}`)
}

let tarball
let isolatedHome = ''
let child
let port = 0
/** 验证用 profile 名（先声明：cleanup/finish 可能在它赋值前就被调用）。 */
let profile = ''
const dshEnv = { ...process.env }

/** 收尾：停验证实例、删 profile、删 tarball。 */
function cleanup() {
  try {
    if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
    try {
      closeSync(bootLogFd)
    } catch {
      /* 已关闭 */
    }
  } catch {
    /* 已经退了 */
  }
  // 真实动作（重启）之后，监听端口的是助手拉起的新进程，与 child 无关。
  if (port !== 0) {
    const found = run('/usr/sbin/lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    for (const pid of found.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        /* 已经退了 */
      }
    }
  }
  if (options.keep) return
  const rm = (target) => {
    if (target === '') return
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
    } catch {
      /* 文件系统还在回收，留给系统清理临时目录 */
    }
  }
  rm(path.join(dshHome(), 'profiles', profile))
  if (tarball !== undefined) rm(tarball)
  rm(isolatedHome)
}

const dshHome = () => dshEnv.DSH_HOME ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')

let finished = false
function finish() {
  if (finished) return
  finished = true
  cleanup()
  if (options.json) {
    console.log(JSON.stringify({ id, version: pkg.version ?? null, port, failed, tarball: tarball ?? null, results }, null, 2))
  } else {
    section('结论')
    if (failed === 0) {
      console.log(`\n  ✅ 通过：${id}@${pkg.version ?? '?'} 已按「别人的电脑」方式验证，可以发布\n`)
    } else {
      console.error(`\n  ❌ 未通过：${failed} 项失败 —— 修完再发布\n`)
    }
    if (options.keep) console.log('  （--keep：已保留验证 profile 与 tarball 供排查）\n')
    if (isolatedHome !== '' && !options.keep) console.log('  （验证跑在临时 DSH_HOME 里，已删除；用 --keep 可保留）\n')
  }
  process.exit(failed === 0 ? 0 : 1)
}

/* ----------------------------------------------------------- 1. 静态体检 */

if (!options.skipAudit) {
  section('1. 静态体检')
  const audit = auditSources(options.cwd)
  info(`扫描 ${audit.count} 个源文件`)
  if (audit.hits.absolute.length === 0) pass('没有本机绝对路径')
  else fail('源码里有本机绝对路径（别人装上必坏）', audit.hits.absolute.slice(0, 5).join('；'))
  if (audit.hits.platform.length === 0) pass('没有裸用的平台专有命令')
  else warn('平台专有命令疑似未加平台守卫', audit.hits.platform.slice(0, 4).join('，'))
  if (audit.hits.home.length === 0) pass('配置目录按约定解析（认 DSH_HOME）')
  else warn('写 .dsh 但不认 DSH_HOME（搬迁过 home 的机器会写错家）', audit.hits.home.slice(0, 4).join('，'))
}

/* --------------------------------------------------------------- 2. 打包 */

section('2. 打包')
// --ignore-scripts：`prepare` 会把构建日志打进 stdout，污染 --json 输出（构建由调用方自己负责）
const pack = run('npm', ['pack', '--json', '--ignore-scripts'], { cwd: options.cwd })
if (!pack.ok) {
  fail('npm pack 失败', pack.stderr.trim().slice(0, 300))
  finish()
}
let packed = null
try {
  packed = JSON.parse(pack.stdout)[0]
} catch {
  // 仍然兜底：抓 stdout 里最后一个 JSON 数组（构建脚本可能插了别的输出）
  const start = pack.stdout.lastIndexOf('[')
  const end = pack.stdout.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      packed = JSON.parse(pack.stdout.slice(start, end + 1))[0]
    } catch {
      packed = null
    }
  }
}
if (packed === null) {
  fail('无法解析 npm pack 输出')
  finish()
}

tarball = path.join(options.cwd, packed.filename)
const inside = new Set((packed.files ?? []).map((entry) => entry.path))
pass('打包成功', `${packed.filename}（${(packed.size / 1024).toFixed(0)} kB / ${inside.size} 个文件）`)

const declared = [
  ...(typeof pkg.main === 'string' ? [pkg.main] : []),
  ...Object.values(pkg.exports ?? {}).filter((value) => typeof value === 'string'),
  ...(typeof bundlePatch === 'string' ? [bundlePatch] : []),
  ...(pkg.files ?? []).filter((value) => value.includes('.')),
]
const missing = [...new Set(declared.map((entry) => entry.replace(/^\.\//, '')))].filter((entry) => !inside.has(entry))
if (missing.length === 0) pass('声明过的入口都在包里', declared.slice(0, 4).join(', '))
else fail('声明的入口没进包（别人装上是坏的）', missing.join(', '))
if (inside.has('package.json')) pass('package.json 在包里')
else fail('package.json 没进包')

/* --------------------------------------------------------- 3. 干净安装 */

profile = `verify-${String(id).replace(/[^a-zA-Z0-9._-]/g, '-')}`
if (options.isolate) {
  isolatedHome = mkdtempSync(path.join(tmpdir(), 'dsh-verify-home-'))
  dshEnv.DSH_HOME = isolatedHome
}
section('3. 干净安装（全新 profile + tarball，不走 link:）')
info(`profile：${profile}${options.isolate ? `　DSH_HOME：${isolatedHome}` : ''}`)

const dump = run(options.dsh, ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], { env: dshEnv })
if (dump.ok) pass('验证用 profile 就绪')
else fail('无法创建验证用 profile', dump.stderr.trim().slice(0, 300))

const add = run(options.dsh, ['plugin', '--profile', profile, 'add', `file:${tarball}`], { env: dshEnv })
if (!add.ok) {
  fail('tarball 安装失败', (add.stderr || add.stdout).trim().slice(0, 400))
} else {
  pass('tarball 安装成功')
  try {
    const composed = JSON.parse(readFileSync(path.join(dshHome(), 'profiles', profile, 'package.json'), 'utf8'))
    const bundles = composed.dsh?.profile?.bundles ?? []
    if (bundles.includes(id)) pass('已进入 profile bundles（宿主会加载它）', id)
    else fail('装上了但没进 bundles（不会加载）', bundles.slice(-3).join(', '))
  } catch (error) {
    warn('读不到 profile 的 package.json', String(error.message ?? error))
  }
}

/* ------------------------------------------------------------- 4. 启动 */

section('4. 启动验证实例')
port = options.port !== 0 ? options.port : await freePort()
info(`端口：${port}`)

// stdout/stderr 走文件而不是 pipe：`dsh web` 会 fork 出真正的服务进程，
// wrapper 一退出 pipe 就关闭，之后 fork 出去那半写的 token 全部丢失。
const bootLogPath = path.join(tmpdir(), `dsh-verify-${String(id).replace(/[^a-zA-Z0-9._-]/g, '-')}-boot.log`)
const bootLogFd = openSync(bootLogPath, 'w')
const readBootLog = () => {
  try {
    return readFileSync(bootLogPath, 'utf8')
  } catch {
    return ''
  }
}
child = spawn(options.dsh, ['--profile', profile, '--port', String(port), '--no-open'], {
  env: dshEnv,
  stdio: ['ignore', bootLogFd, bootLogFd],
})

const deadline = Date.now() + options.bootTimeoutSec * 1000
let listening = false
while (Date.now() < deadline) {
  if (await probePort(port)) {
    listening = true
    break
  }
  if (child.exitCode !== null) break
  await sleep(300)
}
/** 从启动输出里挑出报错行（这是给「别人装不上」用的第一手证据）。 */
function bootErrors(text) {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => /Error|error:|EADDRINUSE|MODULE_NOT_FOUND|Cannot find|failed to load|timeout|lock/i.test(line))
    .slice(0, 6)
}

if (options.keep) {
  const dump = path.join(tmpdir(), `dsh-verify-${String(id).replace(/[^a-zA-Z0-9._-]/g, '-')}-boot.log`)
  try {
    writeFileSync(dump, readBootLog())
    info(`启动输出已留存：${dump}`)
  } catch {
    /* 尽力而为 */
  }
}
if (listening) pass('验证实例已监听', `http://127.0.0.1:${port}`)
else fail('验证实例没有起来', readBootLog().split('\n').filter(Boolean).slice(-5).join(' | ').slice(0, 400))

// 端口活着不等于启动成功：插件树可能在绑定端口之后才失败。
{
  const errors = bootErrors(readBootLog())
  if (errors.length > 0) fail('启动输出里有报错', errors.join(' ｜ ').slice(0, 500))
  else if (listening) pass('启动输出没有报错')
}

// 客户端半的静态校验（不依赖实例是否起得来）
let clientEntry = ''
if (typeof pkg.exports?.['./client'] === 'string') clientEntry = pkg.exports['./client']
else if (typeof pkg.exports?.['./client'] === 'object') clientEntry = pkg.exports['./client'].default ?? ''
if (hasClient) {
  if (clientEntry === '') fail('声明了 dsh.client 但 exports["./client"] 缺失')
  else {
    const clientFile = path.join(options.cwd, clientEntry)
    if (!existsSync(clientFile)) fail('exports["./client"] 指向的文件不存在', clientEntry)
    else {
      const source = readFileSync(clientFile, 'utf8')
      const declaredId = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(source)?.[1] ?? ''
      if (declaredId === '') fail('客户端 bundle 里找不到 __ModuleLoader__.load({ id })，shell 不会注册它')
      else if (declaredId !== id) fail('bundle 注册 id 与包名不一致（会让整批插件加载失败）', `bundle=${declaredId} 包名=${id}`)
      else pass('bundle 注册 id 与包名一致', declaredId)
      if (typeof pkg.dsh.client.platform === 'string') pass('客户端平台已声明', pkg.dsh.client.platform)
      else warn('dsh.client 没声明 platform（web 面板插件应为 "web"）')
      if (Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0) pass('客户端 inject 已声明', `${pkg.dsh.client.inject.length} 项`)
      else warn('dsh.client.inject 为空（依赖解析可能失败）')
      if (inside.size > 0 && ![...inside].some((entry) => entry === clientEntry.replace(/^\.\//, ''))) {
        fail('客户端 bundle 没进 npm 包', clientEntry)
      }
    }
  }
}

const base = `http://127.0.0.1:${port}`

/**
 * 拿到 URL 行的 token —— 这是唯一能进 Web 界面的凭据（DSH 会在启动时把
 * `dsh web: http://…/?token=…` 打到 stdout）。
 *
 * 注意时序：端口在插件加载早期就 LISTEN 了，而这行 URL 要等应用全部就绪才打印，
 * 中间可能差十几秒。所以必须「等这一行」，不能一到端口就取。
 */
async function waitForToken(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = /token=([A-Za-z0-9_-]+)/.exec(readBootLog())
    if (found !== null) return found[1]
    if (child.exitCode !== null) return ''
    await sleep(300)
  }
  return ''
}

let token = await waitForToken(30_000)
if (token !== '') pass('拿到界面 token（启动输出正常）')
else warn('30 秒内没等到带 token 的 URL 行（界面校验会跳过；可用 --token 手动给）')
const healthPath = options.health !== '' ? options.health : `/api/${id}/probe`

/** 带 Cookie 抓取；index 需要先用 token 换 Cookie（303 → 再抓一次）。 */
const jar = new Map()
async function browse(url, depth = 0) {
  const response = await fetch(url, {
    redirect: 'manual',
    headers: jar.size === 0 ? {} : { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
  })
  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const [pair] = entry.split(';')
    const index = pair.indexOf('=')
    jar.set(pair.slice(0, index), pair.slice(index + 1))
  }
  if (response.status >= 300 && response.status < 400 && depth < 3) {
    const location = response.headers.get('location')
    if (location !== null) return browse(new URL(location, url).toString(), depth + 1)
  }
  return response
}

// 端口 ≠ 界面：webServer 先绑定端口，index/dist 的兜底处理是后注册的。
if (listening && token !== '') {
  const readyBy = Date.now() + 30_000
  let ready = false
  while (Date.now() < readyBy) {
    try {
      const response = await browse(`${base}/?token=${token}`)
      if (response.status === 200) {
        ready = true
        break
      }
      if (response.status !== 404 && response.status !== 502 && response.status !== 503) break
    } catch {
      /* 还在起 */
    }
    await sleep(500)
  }
  if (ready) pass('Web 界面已就绪（index 200）')
  else warn('Web 界面未能就绪（index 不是 200）')
}

/* --------------------------------------------------------- 5. 宿主半 */

section('5. 宿主半')
if (!listening) {
  warn('实例没起来，跳过宿主半验证')
} else {
  try {
    const response = await fetch(`${base}${healthPath}`)
    const text = await response.text()
    if (response.ok) pass('健康路由可用', `${healthPath} → ${response.status} ${text.slice(0, 70)}`)
    else fail('健康路由返回非 2xx', `${healthPath} → ${response.status} ${text.slice(0, 120)}`)
  } catch (error) {
    fail('健康路由打不通', `${healthPath}: ${String(error.message ?? error)}`)
    warn('如果路径不对，用 --health <路径> 指定插件自己的健康路由')
  }
}

/* ------------------------------------------------------- 6. 客户端半 */

section('6. 客户端半')
if (!hasClient) {
  info('该插件没有客户端半（dsh.client 未声明），跳过')
} else if (!listening) {
  warn('实例没起来，跳过')
} else {
  try {
    const index = await browse(token === '' ? `${base}/` : `${base}/?token=${token}`)
    const html = await index.text()
    // 交付地址的形态随 DSH 版本变过，两种都要认：
    //   - 旧版：绝对路径 `/plugins/??<id>/client.js,…&rev=…`
    //   - 0.1.7 起：**文档相对**（核心 dsh-client-modules 的 comboReference =
    //     comboUrl.slice(1)，见 core note web-document-relative-app-routes），
    //     即 `plugins/??<id>/client.js,…&rev=…`，index 里**没有**前导斜杠。
    //     2026-09-27 实测：0.1.7-rc.2 的 index 里 `/plugins/` 绝对引用出现 0 次，
    //     旧正则因此对**每一个带客户端半的插件**都误报「客户端半没注册」。
    // 只放宽前缀，语义断言不变（清单里必须能找到本插件）。
    const urls = [...html.matchAll(/\/?plugins\/\?\?[^"\\\s]+/g)].map((match) => match[0].replaceAll('&amp;', '&'))
    // 启动清单按阶段分片（多条 combo），最长那条未必含本插件——在**全部** combo 里找。
    const bundleUrl = urls.find((url) => url.includes(`${id}/client.js`)) ?? ''
    const toAbsolute = (path) => (path.startsWith('/') ? `${base}${path}` : `${base}/${path}`)
    if (index.status === 401) {
      warn('抓 index 被拒（没有 token），跳过运行时界面校验（静态校验已通过）')
    } else if (urls.length === 0) fail('index 里找不到客户端 bundle 交付地址（客户端半没注册）', `HTTP ${index.status}${bootErrors(readBootLog()).length > 0 ? '｜' + bootErrors(readBootLog())[0] : ''}`)
    else if (bundleUrl === '') fail('bundle 没进启动清单（面板/入口不会出现）', urls.join(' ｜ ').slice(0, 150))
    else pass('bundle 已被 shell 收进启动清单', `${id}/client.js`)
    if (bundleUrl !== '') {
      const bundle = await (await fetch(toAbsolute(bundleUrl))).text()
      if (bundle.includes(id)) pass('bundle 可下载且含插件标记', `${(bundle.length / 1024).toFixed(0)} kB`)
      else fail('bundle 内容里找不到插件 id')
    }
  } catch (error) {
    fail('客户端半验证失败', String(error.message ?? error))
  }
}

/* --------------------------------------------------- 7. 真实动作（可选） */

if (options.restartRoute !== '') {
  section('7. 真实动作（重启）')
  if (!listening) {
    warn('实例没起来，跳过')
  } else {
    try {
      const before = await (await fetch(`${base}${healthPath}`)).json().catch(() => null)
      const response = await fetch(`${base}${options.restartRoute}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'portability check', source: 'portability' }),
      })
      if (response.status !== 202 && !response.ok) {
        fail('重启请求被拒绝', `${options.restartRoute} → ${response.status}`)
      } else {
        pass('重启请求已接受', `HTTP ${response.status}`)
        const limit = Date.now() + 120_000
        let newPid = null
        while (Date.now() < limit) {
          try {
            const live = await (await fetch(`${base}${healthPath}`)).json()
            if (before === null || live.pid !== before.pid) {
              newPid = live.pid
              break
            }
          } catch {
            /* 正在重启，端口暂时不可用 */
          }
          await sleep(1000)
        }
        if (newPid === null) fail('重启后服务没回来（这就是别人装上的样子）', '120s 内没等到新进程')
        else pass('重启后服务回来了', `新 pid ${newPid}（旧 ${before?.pid ?? '?'}）`)
      }
    } catch (error) {
      fail('真实动作失败', String(error.message ?? error))
    }
  }
}

/* ------------------------------------------------- 8. 稳定性观察（迟到崩溃） */

// 这次真的栽过：`dsh web` 先绑端口、后加载插件树，于是「端口应答 / 界面 200」可能只是
// 一段**临时**状态——新宿主几秒后死于 `plugin tree failed to load … writer lock`，
// 而门禁在它死之前就宣布通过了。所以就绪之后必须再守一段时间，确认它没在背后死掉。
if (listening && !options.skipStability) {
  section('8. 稳定性观察（就绪之后是否仍活着）')
  const watchSec = Number(flag('--stability', '15')) || 15
  const deadline2 = Date.now() + watchSec * 1000
  let alive = true
  let lastPid = null
  let checks = 0
  let firstError = ''
  while (Date.now() < deadline2) {
    try {
      const response = await fetch(`${base}${healthPath}`)
      if (!response.ok) {
        alive = false
        firstError = `健康路由 ${response.status}`
        break
      }
      const body = await response.json().catch(() => null)
      const pid = body?.pid ?? null
      if (lastPid !== null && pid !== null && pid !== lastPid) {
        alive = false
        firstError = `进程被替换（${lastPid} → ${pid}）`
        break
      }
      lastPid = pid
      checks += 1
    } catch (error) {
      alive = false
      firstError = String(error.message ?? error)
      break
    }
    await sleep(2_000)
  }
  // 顺手再看一眼启动输出里有没有新的致命行
  const fatal = bootErrors(readBootLog())
  if (alive && fatal.length === 0) {
    pass(`就绪后 ${watchSec}s 内保持稳定`, `${checks} 次探测，pid ${lastPid ?? '?'}`)
  } else {
    fail('就绪后没撑住（迟到崩溃 = 假成功）', firstError !== '' ? firstError : fatal.join(' ｜ ').slice(0, 300))
  }
}

finish()

finish()
