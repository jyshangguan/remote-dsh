# Remote DSH Panel

把一台远程 Linux 机器上的 DeepSeek Harness **直接嵌进桌面应用的侧边栏面板**：左侧一个「远程 DSH」入口，点开选主机，远端那套会话 / 工作区 / 文件都在面板里，就像本地的一样。

> A DeepSeek Harness (DSH) plugin that runs a **remote** harness inside the desktop app's own window: SSH bootstrap, on-demand remote `dsh` install, loopback tunnel, and a same-machine gateway that serves the remote UI to a panel iframe.

---

## 为什么需要这层网关

DSH 桌面壳的页面来自自定义 scheme `dsh-app://app`，而远端 `dsh web` 是 `http://127.0.0.1:<port>`。直接把远端塞进 iframe 会遇到两个死结：

1. **登录 cookie 跨不过去**：远端的鉴权 cookie 是 `SameSite=Strict`，在 `dsh-app://` 的第三方上下文里根本不会被发送 → 页面 401；
2. **cookie 还绑定 authority**：`Set-Cookie` 的 payload 里写着 `127.0.0.1:<远端端口>`，端口一变就失效。

所以本插件不让浏览器碰 cookie：

```
桌面壳 (dsh-app://app)
  └─ iframe → http://127.0.0.1:<网关端口>/         ← 本机 http，无需任何 cookie
        └─ 网关（插件宿主进程内）
              ├─ 自己完成 ?token= → Set-Cookie 的换取
              ├─ 转发 HTTP（重写 Host/Origin/Referer，带上远端 cookie）
              ├─ 转发 WebSocket（/api/remote.mux，原样升级）
              └─ 注入 Esc 桥接脚本（见下）
                    └─ 本地隧道 127.0.0.1:<随机> → 远端 127.0.0.1:<dsh web 端口>
                          └─ SSH 连接 → ssh2.forwardOut()
```

所有远程操作都走 SSH，因此**远端只需要把 `dsh web` 绑在 127.0.0.1**，不需要暴露到局域网，也不需要额外装任何 helper。

## 功能

| 能力 | 说明 |
| --- | --- |
| 主机列表 | 自动复用 `~/.dsh/dsh-ssh.json` 里已配置的 SSH 主机（标记「SSH 插件」），也可以在面板里自己添加（标记「本面板」） |
| 添加主机 | 名称、主机/IP、SSH 端口、用户名、密码、远端 `dsh web` 端口、安装用代理（可选） |
| 连接测试 | 只探测、不安装不启动：SSH 是否通、Node 版本、远端 dsh 版本是否与本地一致、远端 dsh web 是否在跑，并给出耗时 |
| 删除主机 | 本面板添加的直接删除；来自 SSH 插件的会在确认后同时从 `~/.dsh/dsh-ssh.json` 移除 |
| 自动安装 | 远端没有 dsh 或版本不一致时，自动 `npm i -g --prefix "$HOME/.local" @deepseek-ai/dsh@<本地版本>`，安装过程有阶段提示与耗时 |
| 自动启动 | 确保远端 `dsh web` 在跑；没跑就 `nohup ... --host 127.0.0.1 --port <webPort> --no-open` 拉起来（最多等 40 秒） |
| 会话内嵌 | 面板里直接是远端 DSH，可重新加载 / 断开 |
| 放大 | 面板铺满整个窗口（保留 Windows 三个窗口按钮与任务栏），按 `Esc` 退出 |
| 剪贴板 | iframe 显式委派 `clipboard-read; clipboard-write`，远端「复制链接」可用；另外提供「在新窗口打开」作为兜底 |
| 自动恢复 | 远端 401（例如重启换了 token）时网关自动重读 token 并重试一次 |
| 旧进程自愈 | 连接时若远端 `dsh web` 的启动时间早于当前 dsh 包的安装时间（典型场景：刚自动升级完版本，或有人升级了包却没重启服务），自动结束旧进程并用新版本重启。旧进程会一直沿用启动时打包的插件清单，新客户端用它会大面积 pending（缺 `contextMenus` / `fileDrag` 等），重启是唯一解法 |
| 启动防重 | 端口被占用时只等待、绝不再拉第二个 `dsh web`：重复启动会 `EADDRINUSE` 并把写着 token 的日志整个截断，连接随即报「远端日志里没有 token」 |
| token 自愈 | 日志里确实没有 launch token 时（历史上的截断、或服务是有人手工起的），自动重启远端服务一次以取回 token，且只重试一次，不会在 401 循环里反复重启 |
| 配置同步 | 把本地 profile 已安装的插件、`llm-pi-ai` 模型 provider、默认模型和 API Key 同步到远端 profile，支持预演、备份与重启 |
| 文件管理 | 连接后点面板上的 **文件**，进入双列传输视图：左列本机、右列服务器，勾选文件即可互传（上传 / 下载），并支持改名、删除、新建目录与文本编辑。远端走同一条 SSH 连接，不需要额外开端口或装服务 |

## 安装

### 从 npm 安装（推荐）

```sh
dsh plugin --profile desktop add dsh-remote-panel-ssh
```

装完**完全退出 DSH 桌面应用**（托盘也要退）再打开，左侧出现「远程 DSH」。依赖 `ssh2` 由安装器一并装好。

> 名字是 `dsh-remote-panel-ssh`：registry 上的 `dsh-remote-panel` 属于另一位作者的另一个项目，`dsh-remote-ssh` / `dsh-remote-desktop` 也都已被占用。

### 从 GitHub 安装（备选）

```sh
dsh plugin --profile desktop add github:1583477320/remote-dsh
```

国内网络直连 GitHub 可能超时；这种情况下优先用上面的 npm 方式。

### 从本地克隆安装（开发 / 离线）

```sh
git clone https://github.com/1583477320/remote-dsh.git
cd remote-dsh
dsh plugin --profile desktop add link:$(pwd)
```

`link:` 会建软链指向仓库目录：改代码后**完全退出应用再打开**即生效（客户端 bundle 带 rev，必须重启才会刷新）。

### 手动安装（等价做法）

1. 把本仓库放到 profile 的 `node_modules` 下：

   ```sh
   cp -r . ~/.dsh/profiles/desktop/node_modules/dsh-remote-panel-ssh
   ```

2. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: remote-dsh
         name: dsh-remote-panel-ssh
   ```

3. 完全退出 DSH 桌面应用（托盘也要退）后重新打开，左侧出现「远程 DSH」。

> 插件依赖 `ssh2`。若手动拷贝，请确认 profile 的 `node_modules` 里能解析到 `ssh2`（`dsh plugin add` 会自己装依赖）。

## 使用

1. 左侧点「远程 DSH」；
2. 选一台主机，先点 **测试** 看环境（推荐，尤其新机器）：

   ```
   SSH 正常 · Node v24.18.0 · dsh 未安装（连接时会自动安装） · 远端 dsh web 未运行（连接时会启动） · 842ms
   ```

3. 点 **连接**，首次会经历：`SSH → 检查环境 → 安装 dsh（如需）→ 启动 dsh web → 建立通道`，面板会在每一步显示阶段与已用秒数；
4. 连上后：**文件**（SFTP 文件管理，见下）/ **重新加载** / **放大**（`Esc` 退出）/ **在新窗口打开** / **断开**；
5. 远端 DSH 是独立登录态，第一次需要在那套界面里登录一次 DeepSeek 账号（或用 API key）。

## 文件传输（SFTP ⇄ 本机）

连接成功后，面板头部多一个 **文件** 按钮，切换出双列传输视图（远端界面保持挂载，切回来不会重新加载）：

```
┌─ 本地 ───────────────┐   ┌─ 服务器 ─────────────┐
│ [路径] ↑ 刷新   新建  │   │ [路径] ↑ 刷新   新建  │
│ ☐ 📁 Desktop         │   │ ☐ 📁 projects        │
│ ☑ 📄 notes.txt  2 KB │ → │ ☐ 📄 server.log 900B │
│                      │ ← │                      │
└──────────────────────┘   └──────────────────────┘
```

- 两列各自有路径栏：回车跳到任意绝对路径，`↑` 回上一级，`刷新` 重读；
- 勾选一侧的文件，按中间 **上传 →** / **← 下载** 传到另一侧当前目录；同名文件会先确认再覆盖；
- 点目录名进入目录，点文件名打开文本编辑（两侧都支持，改完可直接 **保存**）；二进制只提示大小；
- 每行有 **改名** / **删除**（删除目录会递归删除，需要确认）；
- 传输是流式的：读一侧的下载流直接灌进另一侧的写入流，不经过浏览器内存；大文件也不会撑爆页面。

本地面默认是本机用户的家目录；远端走 `sshd` 自带的 sftp 子系统，默认远端登录用户的家目录。两边的权限就是各自登录用户的权限。

## 同步本地配置到远端

主机列表里每个主机多了一个 **同步** 入口，流程是「读取计划 → 勾选 → 预演/开始」：

1. 点 **同步**，插件会同时读取本地 profile（默认 `desktop`）与远端 profile（默认 `web`）；
2. 勾选要同步的插件和模型 provider，决定是否同步默认模型、API Key、是否重启远端；
3. 可以先勾 **只预演，不写入远端**，确认将安装的版本、将写入的 provider 和默认模型；
4. 点 **开始同步**，页面会显示阶段和实时日志。

同步做四件事：

| 步骤 | 行为 |
| --- | --- |
| 插件 | 对每个勾选的插件执行 `dsh plugin --profile <profile> add <name>@<本地精确版本>`；远端已装同版本且已启用时跳过 |
| 模型配置 | 在远端 profile 的 `cordis.patch.yml` 末尾写一段带标记的托管块，包含 `llm-pi-ai` 的 provider 和 `agent-default-model`；每次同步整块替换，托管块之外的文本原样保留 |
| API Key | 用本机 `credentials` 服务解析 `apiKeyEnv` 引用的值，合并写入远端 `~/.dsh/.env`（0600），不落日志、不回传页面 |
| 校验 / 重启 | 用 `dsh --profile <profile> --dump-config` 校验；失败会恢复 patch 备份。勾选重启时杀掉远端旧的 `dsh web` 并按原端口重新拉起 |

注意：

- 第一次同步前，远端需要已有可用的 `dsh`；没有就先点 **连接** 让插件安装；
- 模型 provider 是**整组替换**：远端有、本地没有的 provider 会被移除；每次改写前会生成 `cordis.patch.yml.bak-remote-dsh-<时间>` 备份；
- 不勾选「默认模型」时远端默认模型保持不变；如果它指向本次被移除的 provider，远端会出现模型不可用。
- 只同步本插件能识别的部分：插件包、`llm-pi-ai` provider、默认模型、`.env` 里的 API Key；MCP 条目、会话、账号登录态、其他插件配置不在范围内；
- 标注「仅支持 Windows」的插件会显示为不可选（例如 `dsh-screenshot-plugin`）；
- 重启远端 `dsh web` 会让当前已连接的远端面板断开，需要重新连接；
- 远端 profile 名称默认为 `web`；如果远端用的是别的 profile，在同步页里改名称后点「读取此 profile」。

## 主机字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `label` | 主机地址 | 列表里显示的名称 |
| `host` / `sshPort` | — / `22` | SSH 目标 |
| `user` / `password` | — | SSH 凭据（也支持复用 dsh-ssh 的密钥条目） |
| `webPort` | `18080` | 远端 `dsh web` 监听端口（仅 127.0.0.1） |
| `installProxy` | 空 | 自动安装时使用的 HTTP 代理；留空会尝试探测远端 `127.0.0.1:7890` |
| `dshBin` | `~/.local/bin/dsh` | 远端 dsh 可执行文件（环境变量 `DSH_BIN` 可覆盖探测） |
| `webLog` | `~/.dsh/logs/dsh-web.log` | 远端 `dsh web` 日志（token 从这里读） |

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_REMOTE_HOST` / `DSH_REMOTE_PORT` | 覆盖内置示例主机（仅调试用） |
| `DSH_REMOTE_STATE_URL` | 覆盖远端 helper 地址（兼容早期的 `/state` 模式） |
| `DSH_BIN` | 远端 dsh 路径 |

## 数据与安全

- 面板添加的主机保存在 `~/.dsh/remote-dsh.json`，权限 **0600**，密码为明文（与 dsh-ssh 的 `~/.dsh/dsh-ssh.json` 同一套信任模型）；
- 远端 `dsh web` 只监听 `127.0.0.1`，不暴露到局域网；
- 网关只监听 `127.0.0.1:<随机端口>`，且**自身持有**远端 session cookie：访问该端口的本机进程等价于“已登录远端”，插件卸载/断开时随会话关闭；
- 启动令牌（`?token=`）只在宿主进程内使用，从不下发到浏览器；
- 远端 401 时网关自动重新换取 cookie；
- 文件传输走 SFTP，权限就是 SSH 登录用户的权限；面板**不做路径沙箱**，能在这个账号下读写的文件都能操作。`/api/remote-dsh/fs/*` 与其它面板接口一样只在本机 loopback 上可达；
- 左列的「本地」通过 `/api/remote-dsh/local/*` 读写**本机磁盘**，权限就是当前 DSH 宿主进程的用户；这个接口同样只监听 loopback、只对同源页面开放，但它确实能读写本机任意可访问路径——在你信任本机进程的前提下使用；

## 已知限制

- 远端必须是 Linux（Windows/macOS 未验证），需要 Node `^22.19 || >=24` 与 `npm`；
- **远端 dsh 版本必须与本地 client 完全一致**：client 的 Remote 能力集合是构建期固定的，跨版本连不通，所以插件安装时会 pin 到本地版本；升级后不需要手动重启远端 `dsh web`，连接时会自动结束旧进程再拉起；
- `npm` 默认跳过 install scripts 时，远端 DSH 的**终端**可能不可用（`node-pty` 原生模块未编译），Web UI 本身不受影响；
- 每个主机同一时刻只保留一条会话；断开只关本地隧道与网关，不杀远端进程；
- 剪贴板依赖 iframe 的权限委派；若桌面壳的安全策略仍拒绝，请用「在新窗口打开」或手动选中 + `Ctrl+C`；
- 放大模式的退出方式为 `Esc`（网关注入的桥接会把远端页面里的 Esc 传回外层）；远端弹窗打开时 Esc 归弹窗使用；
- 同步只覆盖本插件认识的配置：插件版本、`llm-pi-ai` provider、默认模型与 API Key；远端独有的 provider 会被整组替换，改写前有备份但没有自动合并；
- 本地用 `link:` / `file:` 装的插件（开发中的源码目录）**不会被同步**：远端没有那份源码，同名 npm 版本通常是另一个构建，装过去等于装错代码。这类条目在同步页里会标灰并写明原因；
- 同步要求远端已装 `dsh` 且版本与本地一致；不一致时请先「连接」让插件升级远端；
- 文件编辑只在面板内预览前 **512 KB**，更大请下载；在线保存上限 2 MB，超过请用上传；下载与上传都是流式的，不受这两个限制。

## 源码地图

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 宿主入口：`/api/remote-dsh/{hosts,connect,disconnect,state,test,sync,sync/plan,sync/state}` 与 `fs/*`、`local/*` 路由、连接/同步任务与阶段状态 |
| `lib/hosts.js` | 主机存储（`remote-dsh.json`）与 `dsh-ssh.json` 的读取/删除 |
| `lib/remote.js` | 一次会话：SSH 连接 → 环境检查 → 自动安装 → 启动/复用 `dsh web` → 读 token → 隧道 → 网关；也提供同步用的远端重启 |
| `lib/sftp.js` | 远端文件操作：懒开 SFTP 通道、列目录、读写文本、上传/下载流、mkdir/rename/递归删除 |
| `lib/localfs.js` | 本机文件操作：同一套协议的本机实现，供传输视图左列使用 |
| `lib/gateway.js` | 本机网关：cookie 换取、HTTP/WebSocket 转发、HTML 注入（Esc 桥接）、gzip 处理、401 自愈 |
| `lib/plan.js` | 读取本地 profile 的插件清单、`llm-pi-ai` provider、默认模型，生成同步计划 |
| `lib/patch.js` | 纯函数：YAML 托管块渲染/合并、`.env` 合并、provider 选取、插件版本比较 |
| `lib/sync.js` | 同步任务：SSH 检查 → 安装 pnpm/插件 → 写 patch → 合并 `.env` → `--dump-config` 校验 → 可选重启 |
| `lib/client.js` | 浏览器半区：侧边栏入口、主机列表/表单、连接阶段轮询、iframe 内嵌、放大与 Esc、同步表单与日志、SFTP 文件视图 |

## 开发提示

- 客户端 bundle 是**经典脚本**，用 `window.__ModuleLoader__.load({ id, factory })` 包装，`factory` 里 `require('react')`，返回带 `apply` / `inject` 的 `module.exports`；
- 改了 `lib/client.js` 或宿主文件都需要**完全退出应用**再打开（客户端 bundle 带 rev，宿主在启动时加载插件）；
- 面板注册使用官方扩展点：`ctx.slots.inject('sidebar.panellist', …)` 与 `ctx.slots.inject('main', …)`。

## License

Apache-2.0
