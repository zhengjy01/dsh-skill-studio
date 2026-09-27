# 可移植性验证 SOP（插件仓库模板）

> **把本文件连同 `scripts/portability.mjs` 一起复制进插件仓库**
> **本机 kit 位置：`DSH /DSH-test/dsh-release-kit/`**（含 `portability.mjs` / `release.mjs` / 本模板 / `RELEASE-SOP.md`）。，然后按第 1 步接一条 npm script。
> 规则来源：`~/.dsh/AGENTS.md` 第 10 节（无条件生效）；判定标准：`2️⃣ AI/Standards/DSH插件可移植性验证清单.md`；背景与踩坑：`2️⃣ AI/Sop/DSH插件可移植性验证-SOP.md`。
> **门禁：`✅ 通过` 之前不得发布。**

## 为什么需要它

`link:` 挂载 + 你自己机器的 profile + 你自己的 `~/.dsh` 会**同时掩盖两类问题**：

1. **别人装不上**：包漏文件、`exports` 写错、`dsh.client` 清单不对、写死了本机绝对路径、写死 `~/.dsh` 而不认 `DSH_HOME`、只在 macOS 成立的假设。
2. **装上也是坏的**：客户端 bundle 注册 id ≠ 包名（会让整批插件加载失败）、装上了但没进 `dsh.profile.bundles`（宿主不加载）、起来了又死。

## 0. 一次性接线

```bash
cp <kit>/portability.mjs <repo>/scripts/
cp <kit>/PORTABILITY-SOP.template.md <repo>/PORTABILITY-SOP.md   # 本文档
```

`package.json` 的 scripts 里加（把 `<插件id>` 换成自己的路由前缀，通常等于包名去掉 scope）：

```json
"verify": "node scripts/portability.mjs --health /api/<插件id>/probe",
"verify:full": "node scripts/portability.mjs --health /api/<插件id>/probe --restart-route /api/<插件id>/restart",
"verify:quick": "node scripts/portability.mjs --skip-audit --stability 5 --health /api/<插件id>/probe"
```

> 有「主功能接口」的插件（重启 / 导出 / 同步…）**一定要用 `verify:full`**：真实动作那一格是唯一能证明「点了之后真的能用」的地方。

## 1. 标准动作（每次发布前）

```bash
npm run verify:full          # 或 node scripts/portability.mjs --health … --restart-route …
```

八步，全自动，退出码即结论：

| # | 步骤 | 在防什么 |
| --- | --- | --- |
| 1 | 静态体检 | 本机绝对路径 / 未加守卫的平台专有命令 / 写 `.dsh` 却不认 `DSH_HOME` |
| 2 | `npm pack` + 入口核对 | 声明过的入口（`main`、`exports["./client"]`、`dsh.bundle.patch`、`files` 里的文件）**没进包** |
| 3 | 干净安装 | `link:` 之外的安装路径：**空 profile + tarball**；以及**装上了有没有进 `dsh.profile.bundles`** |
| 4 | 启动 | 在**隔离的 `DSH_HOME`** 里起实例，并**检出启动输出里的报错行** |
| 5 | 宿主半 | 健康路由是否真的应答（插件是否真的挂载） |
| 6 | 客户端半 | `dsh.client` 声明、bundle 注册 id **是否等于包名**、`__DSH_BOOT__.entries` 里有没有它 |
| 7 | 真实动作（可选） | 主功能跑一次后服务是否带着新 pid 回来 |
| 8 | **稳定性观察** | **就绪之后是否还活着**（迟到崩溃 = 假成功） |

常用参数：

| 参数 | 用途 |
| --- | --- |
| `--health <路径>` | 插件自己的健康路由（默认猜 `/api/<包名>/probe`） |
| `--restart-route <路径>` | 顺带跑一次真实动作 |
| `--stability <秒>` | 第 8 步观察窗口（默认 15） |
| `--keep` | 保留验证 profile / tarball / 启动输出，便于排查 |
| `--json` | 机器可读报告（CI 用） |
| `--no-isolate` | 共享本机 `~/.dsh`（**不推荐**，见坑 1） |
| `--skip-stability` / `--skip-audit` | 跳过对应步骤（快速迭代时用） |

## 2. 手动复核（工具报失败、或想逐步确认）

```bash
npm pack                                                   # → <name>-<ver>.tgz
export DSH_HOME=$(mktemp -d)/dsh-home                      # ① 必须隔离
dsh --profile verify-<id> --from-default-profile web --dump-config
dsh plugin --profile verify-<id> add "file:$PWD/<name>-<ver>.tgz"   # ② 不要用 link:
python3 -c "import json;print(json.load(open('$DSH_HOME/profiles/verify-<id>/package.json'))['dsh']['profile']['bundles'])"
dsh --profile verify-<id> --port 3456 --no-open > /tmp/verify.log 2>&1 &
grep -n "Error\|error:" /tmp/verify.log                    # ③ 端口 LISTEN ≠ 启动成功
curl -s http://127.0.0.1:3456/api/<id>/probe               # ④ 宿主半
TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' /tmp/verify.log | head -1 | cut -d= -f2)
curl -s -L -c /tmp/ck -b /tmp/ck "http://127.0.0.1:3456/?token=$TOKEN" -o /tmp/idx.html
grep -c "<包名>/client.js" /tmp/idx.html                   # ⑤ 客户端半
sleep 15 && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3456/api/<id>/probe   # ⑥ 还活着吗
lsof -ti tcp:3456 -sTCP:LISTEN | xargs -r kill; rm -rf "$DSH_HOME" <name>-<ver>.tgz
```

## 3. 四个必须知道的坑

1. **必须隔离 `DSH_HOME`。** 同机第二个 DSH 实例会等 `~/.dsh/.credentials.yaml` 的写锁直到超时（`atomic-write: timed out waiting for the writer lock`）而**启动失败**——不隔离的话，验证结果全是假的（看起来像插件坏了）。隔离后还顺便变成更真实的「全新机器」模拟。
2. **端口 LISTEN ≠ 启动成功。** `dsh web` **先绑定端口、后加载插件树**，插件树可能在端口已经应答之后才失败；凭证写锁超时这类失败要 **~30 秒**才爆。所以：①要看启动输出的报错行；②**报了就绪还要再守一段**（第 8 步）——「起来了又死」不得报成功。
3. **带 token 的 URL 行来得晚，且不能靠 pipe 抓。** `dsh web` 会 fork 出真正的服务进程，**wrapper 退出后 pipe 就关闭**，fork 出去那半写的 token 会全部丢失——所以工具用**文件**做 stdio。等它出现（可长达十几秒）再去抓 index，否则会误判「客户端半没注册」。
4. **真实动作后进程换人，清理要按端口杀。** 重启类动作由助手/launchd 拉起**新进程**，已不是脚本的子进程，`child.kill()` 杀不到，会留下实例与临时 profile。

## 4. 一票否决（任一出现即不得发布）

1. 源码里有本机绝对路径。
2. 声明的入口 / 运行时按路径加载的文件没进包。
3. tarball 装进空 profile 后没进 `dsh.profile.bundles`。
4. 启动输出里有报错（哪怕端口能探到）。
5. 客户端 bundle 注册 id 与包名不一致。
6. `__DSH_BOOT__.entries` 里没有 `<包名>/client.js`。
7. 真实动作后服务没能恢复。
8. **就绪后没守住**（观察窗口内健康路由掉线 / 进程被替换 / 冒出新的启动致命行）。

## 5. 通过之后

1. `npm run verify:full` 输出 `✅ 通过`。
2. 把结论写进项目档案（通过 / 未通过 + 失败项）。
3. 再走 `release.mjs`（版本纪律）→ git tag → npm publish → 聚合平台。

> 顺序很重要：**可移植性验证在版本纪律之前**。版本号错了可以再发一版；别人装不上是「发出去就是坏的」。
