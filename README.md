# 远程 DSH（OpenSSH）· dsh-remote-panel-openssh

把一台远程 Linux 机器上的 DeepSeek Harness（DSH）**完整嵌进桌面应用的面板**：侧边栏「远程 DSH」入口，主机直接来自 `~/.ssh/config`，连接后远端的会话 / 工作区 / 文件就在面板里，就像本地的一样。

这是一个**安全优先的 fork**：只接管、不破坏。远端已有的 DSH 进程绝不会被静默结束或重启；无法安全接管时，插件会把原因和处理建议摆在你面前，由你决定。

> 仓库说明：本仓库是 [1583477320/remote-dsh](https://github.com/1583477320/remote-dsh) 的 fork，发布在 [jyshangguan/remote-dsh](https://github.com/jyshangguan/remote-dsh)，工作分支 `openssh-safe-panel`。包名 `dsh-remote-panel-openssh` 与上游 `dsh-remote-panel-ssh` 区分，可共存。

## 来源与许可

- 上游：[1583477320/remote-dsh](https://github.com/1583477320/remote-dsh)，基线为 npm 包 `dsh-remote-panel-ssh@0.3.0`（上游 GitHub `main` 当时为 0.1.1；本 fork 以**发布的 0.3.0 tarball** 为基线，SHA1 校验后逐字导入，再在其上修改）。
- 本 fork 在其基础上做了安全化重写，沿用 **Apache-2.0** 许可（见 `LICENSE`）。

## 与上游原版的差异

### 行为对照

| 方面 | 上游 `dsh-remote-panel-ssh@0.3.0` | 本 fork `dsh-remote-panel-openssh` |
| --- | --- | --- |
| 主机来源 | `dsh-ssh.json` 条目 + 面板内**密码添加**主机 | 仅 `~/.ssh/config` 别名（Include 感知，只读）；无密码、无主机增删按钮（面板内可隐藏/恢复显示） |
| 认证 | 密码或私钥路径（读 `privateKeyPath`，与 dsh-ssh 写的 `keyPath` 不兼容） | OpenSSH 公钥 / ssh-agent；`ssh -G` 解析有效配置，多 IdentityFile 顺序回退，`IdentitiesOnly` 尊重 |
| 主机指纹 | 未见 `known_hosts` 校验 | `ssh-keygen -F` 校验 `known_hosts`（普通/hashed 均可）；未知 / 变更 / 撤销 / CA 一律 **fail-closed**，不写 known_hosts、不做静默 TOFU |
| 远端进程 | 旧进程**自动 kill 重启**、无 token **自动重启取回** | 自动路径**绝不 kill / restart / signal**；**唯一例外**：用户点「重启」时，对端口上同 uid 的 dsh web 复核 PID 后发 SIGTERM 再重新拉起（绝不 SIGKILL）；无法安全接管 → 「需人工处理」卡片 |
| 安装位置 | `npm i -g --prefix "$HOME/.local"`（覆盖 `~/.local/bin/dsh`） | 侧装到 `~/.local/share/dsh-remote-panel-openssh/runtime/<版本>/`（`npm i --prefix`），不碰全局 prefix 与已有 `dsh` |
| Node 选择 | 远端默认 PATH 的 node/npm | 默认 PATH 不满足时**自动搜索** nvm/fnm/asdf/volta/n 并记住（只找不装）；也可手动 **`nodeBin`** 前置；**不自动安装 Node** |
| 启动语法 | `--profile <p> web --host …`（0.2.1 世代语法） | **rc.3 语法** `--profile <p> --host … --port … --no-open`（`web` 位置参数在 rc.3 会被拒绝） |
| 进程检测 | pgrep 仅匹配 `web` 位置参数 | 同时匹配 rc.3 形态（`--host`/`--port` 跟随 `--profile`），同 profile 冲突保护与 PID 报告继续有效 |
| 版本判定 | 浏览器可传版本，fallback `0.2.1-rc.3` | **宿主侧**从 `profileContext.installAnchor` 解析真实版本，钉死 `0.2.2-rc.3`，不符返回 409 |
| token 处理 | 无 token 时重启服务取回 | 候选 token 经**真实 303 + Set-Cookie 交换**验证；401 重读重试一次；不可读 → 人工处理，不重启 |
| 配置同步 | 把本机插件 / provider / API Key 同步到远端 profile 与 `.env` | **删除**；远端复用服务器自己的 `~/.dsh`、profile、模型与插件 |
| 主题 | 硬编码白底 + `inherit` 文字（深色主题下白底浅字不可读） | 全部改用 `--dsw-alias-*` 主题 token，深 / 浅色自适应 |
| 会话策略 | 每主机一条会话 | **多会话并发**：各主机独立保活，经主机列表切换；每主机 generation 计数防连接竞态 |
| 本机存储 | `remote-dsh.json`（密码明文，0600） | `remote-dsh-openssh.json`（0600 原子写入，**仅非敏感字段**） |
| 启动日志 | 复用 / 截断 `~/.dsh/logs/dsh-web.log` | 写入自有 logs 目录下**全新唯一**文件（`umask 077`），绝不截断已有日志 |
| 并发启动 | 无锁 | 远端原子 `mkdir` 启动锁，防并发拉起两个实例；锁不自动清除 |

### 试点中修复的基线缺陷

在 kiaa206 真机验收中发现并修复，**每项均含回归测试**（全套 121 个测试通过）：

1. **webLog 空值被拒**：设置编辑器把空的「自动」输入框作为 `''` 发送，服务端契约要求 `null` → 客户端 trim 后送 `null`，服务端也防御性归一化。
2. **attach 误检 Node**：接管已有实例时错误地检查远端默认 Node 版本（系统 node 过旧但运行中的 DSH 用 nvm）→ Node 检查移到 install-and-start 分支，attach 不再探测默认 node。
3. **重挂载后 ssh2 加载失败**：插件禁用/启用重挂载后 bare `import('ssh2')` 解析到不可用的命名空间 → 改为 `createRequire` 多路径回退（模块路径 → profile node_modules → ESM import）。
4. **`command -v` 内建失效**：`env PATH=… command -v npm` 把 shell 内建 `command` 当外部程序执行而静默返回空 → 包进 `sh -c`。
5. **rc.3 启动语法**：`--profile <p> web …` 被 rc.3 拒绝（"too many arguments"）→ 去掉 `web` 位置参数，并更新进程检测正则以匹配 rc.3 形态。
6. **深色主题不可读**：面板硬编码白底而文字继承应用浅色 → 全部改用主题 token。

### 保留自上游

iframe 嵌入 + 本机网关（cookie 换取、HTTP / WebSocket 转发、Host/Origin/Referer 重写、Esc 桥接、401 单次重试、**每主机固定回环端口**使嵌入 origin 跨重连/重启不变——远端 web 的 localStorage 得以保留，重连后恢复上次的远端会话而非新开）、SFTP 双列文件传输（上传 / 下载 / 改名 / 删除 / 新建 / 文本编辑）、放大 / 在新窗口打开 / 重启（SIGTERM + 重新拉起远端 dsh web）、阶段化连接进度与耗时显示。

## 安全模型

| 承诺 | 做法 |
| --- | --- |
| 主机指纹 fail-closed | 复用 OpenSSH `known_hosts`；未知或变更的主机指纹一律拒绝连接，绝不自动接受 |
| 不存任何凭据 | 不接受密码、不落盘私钥；认证完全复用你的公钥 / ssh-agent |
| 不 kill / 不 restart | 任何情况下都不会结束或重启远端进程；端口被占、旧服务无法安全接管、token 不可读等情况一律进入「需人工处理」，给出原因、建议与涉及的 PID |
| 侧装隔离 | 需要安装时，把匹配版本的 DSH 运行时侧装到远端 `~/.local/share/dsh-remote-panel-openssh/runtime/<版本>/`（`npm i --prefix`），不写 `~/.local/bin/dsh`、不碰全局 npm prefix，与远端已有 DSH 安装完全隔离；远端数据仍用服务器自己的 `~/.dsh` 与 profile |
| 日志 0600 | 本插件启动的实例写入 `~/.local/share/dsh-remote-panel-openssh/logs/` 下全新的唯一日志文件（`umask 077`），绝不截断已有日志；已有实例的日志只读 |
| 启动锁 | 启动前在远端 `~/.local/share/dsh-remote-panel-openssh/locks/` 原子 `mkdir` 加锁，防止并发拉起两个实例；锁不自动清除，残留时提示人工处理 |
| 只走 loopback | 远端 `dsh web` 只绑 `127.0.0.1`；桌面经 SSH 隧道 + 本机网关访问，不暴露局域网，也不需要远端 helper |
| token 自愈不重启 | 网关遇到 401 会重读远端 token 并重试；token 实在不可读时提示人工处理，而不是重启服务 |
| 版本宿主侧钉死 | DSH 版本由宿主进程解析并与 `0.2.2-rc.3` 比对，浏览器传什么都不算数 |

## 支持范围

- **DSH 版本**：首版仅支持 `0.2.2-rc.3`。版本不符时「测试 / 连接」直接返回 409 并说明当前版本。
- **远端系统**：Linux（其它系统未测试，Windows / macOS 远端不在首版支持范围内）。
- **SSH 形态**：仅支持直连 SSH。**不支持** `ProxyJump` / `ProxyCommand`、SSH 证书、CA、KRL。
- **认证**：公钥 / ssh-agent。带口令的私钥请先 `ssh-add`。

## 安装

**从 npm 安装（推荐）**：

```sh
dsh plugin --profile desktop add dsh-remote-panel-openssh
```

或在桌面应用 **插件（Plugins）→ 添加插件** 里输入 npm 包名 `dsh-remote-panel-openssh`。依赖 `ssh2` 由安装器一并装好。

**从本地目录安装（开发 / 未发布改动）**：

```sh
git clone <本仓库地址> dsh-remote-panel-ssh
cd dsh-remote-panel-ssh
dsh plugin --profile desktop add link:$(pwd)
```

装完**完全退出 DSH 桌面应用**（托盘也要退）再打开，左侧出现「远程 DSH」。`link:` 方式改代码后同样需要完全重启应用才会刷新客户端 bundle。

开发 / 续作请先读 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)（架构、保活覆盖层的不变量、复现与测试、发布流程）。

## 使用

1. 在 `~/.ssh/config` 里配置 `Host` 条目（插件直接复用 OpenSSH 的公钥 / agent / `known_hosts`）；
2. 新机器先在终端跑一次 `ssh <alias>`，确认并接受主机指纹（插件不会替你接受）；
3. 打开面板「远程 DSH」，主机列表会自动出现这些别名；
4. 点 **测试** 看环境（只探测，不安装不启动）：

   ```
   SSH 正常 · Node v22.19.0 · 侧装运行时 0.2.2-rc.3 · dsh web 运行中 · 可直接接管 · 128ms
   ```

   动作含义：`可直接接管` / `将侧装并启动` / `需人工处理：<原因>`；
5. 点 **连接**，阶段依次为：`SSH → 检查环境 →（默认 Node 不满足时）查找可用 Node → 侧装（如需，首次可能几分钟）→ 启动 dsh web → 建立通道`，每一步都有文字与耗时；
6. 连上后：**文件**（SFTP 双列传输）/ **重启**（终止远端 dsh web 并重新拉起——远端装了插件/改了配置后用它生效，会打断进行中的远端任务）/ **放大**（`Esc` 退出）/ **在新窗口打开** / **断开**；每台主机还有 **隐藏**（见下）；
7. 远端 DSH 是独立登录态，第一次需要在那套界面里登录一次。

**会话保活**：切回本地会话或别的面板不会断开远端——SSH 会话与内嵌画面都保留，回到「远程 DSH」面板即恢复离开时的画面（正在进行的对话、滚动位置、未发送的输入都在），无需重新连接；连接/侧装进行中切走再回来，进度同样恢复。刷新整个页面后也会自动接管仍在运行的远端会话（画面会重新加载一次，但 SSH 会话不重建）。

**重连恢复上次远端会话**：每台主机的网关固定使用同一个回环端口（按别名派生，冲突时向后顺延），嵌入页面的 origin 因此跨重连、跨「重启」保持不变。远端 DSH web 把「当前会话」等状态存在按 origin 隔离的 localStorage 里，origin 稳定后：重新连接会直接打开**上次用的那个远端会话**（而不是新开一个）；全新服务器首次连接会停在 DSH 的初始界面（空白会话 + 选择工作区/文件夹），之后再连接也始终复用它，不会每次堆积新的空白会话。

**多会话并发**：可同时连接多台服务器。面板顶部有**标签栏**：每台已连接的服务器一个标签（带绿点），点标签即切到该主机的实时画面（会话保持、不重连、不重载）；末尾的 **「+」** 打开服务器列表以添加新服务器。列表里已连接的主机标 **已连接**，提供 **进入**（切换，非重连）与 **断开**；未连接的主机显示 **连接**。连接新主机不会断开已连接的主机。

**隐藏/恢复主机**：点主机行的 **隐藏** 可把它从面板列表移除（仅影响面板显示，保存在插件自己的设置文件里，`~/.ssh/config` 完全不改动）；右上角 **已隐藏 (N)** 展开后可 **恢复**。已连接或正在连接的主机需先 **断开** 才能隐藏。

出现「需人工处理」时，面板会显示原因、处理建议与涉及的进程 PID；按提示人工处理后点 **重试**。连接失败同样提供 **重试**。插件不会自动重连。

### 设置字段（每台主机，点「设置」）

| 字段 | 说明 |
| --- | --- |
| `webPort` | 远端 `dsh web` 监听端口，1–65535，默认 `18080` |
| `profile` | 远端 DSH profile 名称，默认 `web`（复用服务器该 profile 的插件与模型配置） |
| `webLog` | 已有实例的日志路径，可选（绝对路径或 `~/` 开头）；用于从外部启动的实例读取 token。留空时按顺序尝试：本插件自己的日志目录、`~/.dsh/logs/dsh-web.log`、`~/.dsh/dsh-web.log` |
| `nodeBin` | 远端 Node bin 目录，可选（如 `~/.nvm/versions/node/v24.13.0/bin`）。设置后，安装/启动/版本探测都用该目录的 node/npm（PATH 前置）。留空时先用远端默认 PATH：nvm 等版本管理器只随交互式 shell 加载，非交互 SSH 往往只看到旧的系统 node，因此默认 Node 缺失或过旧时会**自动**在 nvm/fnm/asdf/volta/n 与 `~/.local/bin` 中查找满足要求的 Node（只查找，绝不安装），找到后本次即用并自动写入本字段，下次直接使用（nvm 升级后旧路径失效也会同样自愈）；找不到时错误信息会提示手动填写。不会自动安装 Node |
| `installProxy` | 侧装时使用的 HTTP 代理，可选（如 `http://127.0.0.1:7890`） |

设置保存在 `$DSH_HOME/remote-dsh-openssh.json`（0600，原子写入），只含上述非敏感字段；不会改动 `~/.ssh/config`、`dsh-ssh.json` 或任何凭据。

### 文件传输

连接后点 **文件**：左列本机、右列服务器，勾选文件后按中间按钮互传；支持改名、删除、新建目录与文本在线编辑（写入上限 2 MB，更大文件用传输）。远端走同一条 SSH 连接的 SFTP 通道，不开额外端口。暂不支持整目录传输。

## 限制

- **真正断开后不自动重连**：会话断开后显示「远端连接已断开，请重新连接」，需手动重试。切换面板不算断开——远端画面与会话保活，回到面板即恢复（见「使用」）。
- **多会话并发**：可同时连接多台服务器，各自保持独立的 SSH 会话与内嵌画面；顶部标签栏点标签即切换（不重建、不重载），**「+」** 打开服务器列表添加新服务器，列表里已连接主机点 **进入** 切换。每台已连接主机占用一条 SSH 连接 + 一个本机网关 + 一个保活内嵌画面，资源随连接数线性增长，用 **断开** 管理数量。对已连接主机重复点「进入/连接」直接接管现有会话。
- **首次侧装依赖远端环境**：远端需要有满足 DSH engines 要求的 Node（在默认 PATH 或 nvm/fnm/asdf/volta/n 等常见版本管理器中任一处即可，插件会自动查找，但不会代为安装）与 npm；侧装过程可能需要几分钟。
- 首版不做配置同步；主机完全由 `~/.ssh/config` 管理（只读）。面板内可隐藏/恢复主机（仅影响面板显示，存于插件设置文件）；连接中的主机需先断开才能隐藏。
- 在线编辑写入上限 2 MB；目录传输暂不支持。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 主机指纹未知 / 校验失败 | 在终端跑一次 `ssh <alias>`，人工确认指纹后重试（插件 fail-closed，不会自动接受） |
| 私钥带口令，连接失败 | `ssh-add ~/.ssh/id_ed25519` 把钥匙交给 agent，再连接 |
| 需人工处理：端口被非 DSH 进程占用 | 按卡片给出的 PID 人工确认并处理该进程，再点重试 |
| 需人工处理：已有 dsh web 无法安全接管 / token 不可读 | 人工检查远端服务与日志（卡片会给出建议），处理后重试；插件不会替你重启 |
| 远端装了插件 / 改了配置要生效 | 面板里点 **重启**：远端 dsh web 会被 SIGTERM 后重新拉起（进行中的远端任务会被打断，有确认提示） |
| 远端 Node 版本不满足要求 | 连接时会自动在 nvm/fnm/asdf/volta/n 中查找可用 Node 并记住；若仍报错，在主机「设置」的 `nodeBin` 手动填远端 Node bin 目录（如 `~/.nvm/versions/node/v24.22.2/bin`） |
| 409「本插件首版仅支持 DSH 0.2.2-rc.3」 | 本机 DSH 版本不符；切换到受支持版本后再用 |
| 列表为空 | 在 `~/.ssh/config` 里配置 `Host` 条目后点「刷新」 |
| 连接中断、页面卡住 | 点「重试」手动重连；反复出现时检查远端 `dsh web` 日志 |

## English summary

A security-focused fork of [1583477320/remote-dsh](https://github.com/1583477320/remote-dsh) (baseline: npm `dsh-remote-panel-ssh@0.3.0`, Apache-2.0). It embeds the **full remote DSH web GUI** in the Desktop app over a direct OpenSSH connection. Hosts come from `~/.ssh/config` and reuse your keys, ssh-agent and `known_hosts` — unknown host keys fail closed, and no passwords or credentials are ever stored. A healthy remote `dsh web` is attached as-is; otherwise a matching runtime is **side-installed** into an isolated directory. The plugin **never kills or restarts remote processes on its own**: unsafe takeovers surface a manual-action card with the reason, hint and PIDs, plus a retry button. The single deliberate exception is the user-pressed **重启** button: SIGTERM the port-matching, uid-scoped `dsh web` (PID re-verified just before the signal, never SIGKILL) and boot it again — for applying newly installed remote plugins without SSH-ing in. The gateway heals its own auth token on 401 without restarting anything; dropped sessions require a manual reconnect; and every host's gateway keeps a stable derived loopback port, so the embedded origin — and the remote web app's localStorage session selection — survives reconnects and restarts: relogging in reopens the previously used remote session instead of creating a new blank one. Scope: DSH `0.2.2-rc.3` only (host-side version gate), Linux remotes, direct SSH only — no ProxyJump/ProxyCommand, certificates, CA or KRL; Windows/macOS remotes are untested. Install from npm (`dsh plugin --profile desktop add dsh-remote-panel-openssh`, or Plugins → Add plugin → the npm name); for local development use `link:$(pwd)`. See `docs/DEVELOPMENT.md` for architecture and release notes. Configure `Host` entries in `~/.ssh/config`, run `ssh <alias>` once to accept the host key, then Test / Connect in the "远程 DSH" panel. Multiple servers stay connected concurrently, each with its own kept-alive embedded view; a top tab bar switches between them (one tab per connected server, no reload), and a "+" tab opens the server list to add another (connected hosts are marked and offer 进入/enter, never a repeat connection). The two-pane SFTP transfer view is kept from upstream. Switching to another panel keeps every remote session AND its exact embedded view alive (returning restores it without reconnecting; a full page refresh re-adopts the live sessions), and hosts can be hidden/restored in the panel without ever touching `~/.ssh/config` (connected hosts must be disconnected first). Published as the fork [jyshangguan/remote-dsh](https://github.com/jyshangguan/remote-dsh) (branch `openssh-safe-panel`).

**Versus upstream 0.3.0**, this fork additionally: resolves the effective SSH config via `ssh -G` and verifies host keys against `known_hosts` (fail-closed); adds an optional per-host `nodeBin`, plus auto-discovery of a usable Node in nvm/fnm/asdf/volta/n when the default PATH node is missing or too old (nvm only loads in interactive shells) — the find is used for the session and persisted to the host's settings, self-healing a stale path the same way — while never auto-installing Node; launches with rc.3-correct syntax (`--profile <p> --host … --port …`, no `web` positional) and detects both process forms; resolves the DSH version host-side from `profileContext.installAnchor`; validates launch tokens with a real 303+cookie exchange; styles the panel with `--dsw-alias-*` theme tokens (readable in dark theme); and removes config sync, password hosts, and every auto-kill/restart path. The full comparison table and the six bugs fixed during the real-server pilot (each with a regression test, 121 tests total) are in the Chinese section 「与上游原版的差异」 above.

## 许可

Apache-2.0，见 `LICENSE`。上游版权归上游作者所有；本 fork 的修改同样以 Apache-2.0 发布。