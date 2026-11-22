# 远程 DSH（OpenSSH）· dsh-remote-panel-openssh

把一台远程 Linux 机器上的 DeepSeek Harness（DSH）**完整嵌进桌面应用的面板**：侧边栏「远程 DSH」入口，主机直接来自 `~/.ssh/config`，连接后远端的会话 / 工作区 / 文件就在面板里，就像本地的一样。

这是一个**安全优先的 fork**：只接管、不破坏。远端已有的 DSH 进程绝不会被静默结束或重启；无法安全接管时，插件会把原因和处理建议摆在你面前，由你决定。

> 仓库说明：`jyshangguan/dsh-remote-panel-ssh` 目前是 fork 的临时落脚点，后续可能迁移；以实际发布地址为准。

## 来源与许可

- 上游：[1583477320/remote-dsh](https://github.com/1583477320/remote-dsh)，基线为 npm 包 `dsh-remote-panel-ssh@0.3.0`。
- 本 fork 在其基础上做了安全化重写，沿用 **Apache-2.0** 许可（见 `LICENSE`）。
- 与上游的主要差异：
  - **删除**配置同步（插件 / provider / API Key 同步）、密码添加主机、删除主机按钮；
  - **删除**一切自动 kill / restart 远端进程的路径（包括上游的「旧进程自愈重启」「无 token 重启取回」）；
  - 主机唯一来源是 `~/.ssh/config`，认证只走 OpenSSH 公钥 / agent；
  - 新增版本门禁（首版仅支持 DSH `0.2.2-rc.3`，宿主侧判定）与单活会话策略。

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

本 fork 未发布到 npm，从本地目录安装：

```sh
git clone <本仓库地址> dsh-remote-panel-ssh
cd dsh-remote-panel-ssh
dsh plugin --profile desktop add link:$(pwd)
```

或在桌面应用 **插件（Plugins）→ 添加插件** 里选择本仓库目录。依赖 `ssh2` 由安装器一并装好。

装完**完全退出 DSH 桌面应用**（托盘也要退）再打开，左侧出现「远程 DSH」。`link:` 方式改代码后同样需要完全重启应用才会刷新客户端 bundle。

## 使用

1. 在 `~/.ssh/config` 里配置 `Host` 条目（插件直接复用 OpenSSH 的公钥 / agent / `known_hosts`）；
2. 新机器先在终端跑一次 `ssh <alias>`，确认并接受主机指纹（插件不会替你接受）；
3. 打开面板「远程 DSH」，主机列表会自动出现这些别名；
4. 点 **测试** 看环境（只探测，不安装不启动）：

   ```
   SSH 正常 · Node v22.19.0 · 侧装运行时 0.2.2-rc.3 · dsh web 运行中 · 可直接接管 · 128ms
   ```

   动作含义：`可直接接管` / `将侧装并启动` / `需人工处理：<原因>`；
5. 点 **连接**，阶段依次为：`SSH → 检查环境 → 侧装（如需，首次可能几分钟）→ 启动 dsh web → 建立通道`，每一步都有文字与耗时；
6. 连上后：**文件**（SFTP 双列传输）/ **重新加载** / **放大**（`Esc` 退出）/ **在新窗口打开** / **断开**；
7. 远端 DSH 是独立登录态，第一次需要在那套界面里登录一次。

出现「需人工处理」时，面板会显示原因、处理建议与涉及的进程 PID；按提示人工处理后点 **重试**。连接失败同样提供 **重试**。插件不会自动重连。

### 设置字段（每台主机，点「设置」）

| 字段 | 说明 |
| --- | --- |
| `webPort` | 远端 `dsh web` 监听端口，1–65535，默认 `18080` |
| `profile` | 远端 DSH profile 名称，默认 `web`（复用服务器该 profile 的插件与模型配置） |
| `webLog` | 已有实例的日志路径，可选（绝对路径或 `~/` 开头）；用于从外部启动的实例读取 token。留空时按顺序尝试：本插件自己的日志目录、`~/.dsh/logs/dsh-web.log`、`~/.dsh/dsh-web.log` |
| `nodeBin` | 远端 Node bin 目录，可选（如 `~/.nvm/versions/node/v24.13.0/bin`）。设置后，安装/启动/版本探测都用该目录的 node/npm（PATH 前置），解决远端默认 node 过旧但 nvm 里有合适版本的情况；留空用远端默认 PATH。不会自动安装 Node |
| `installProxy` | 侧装时使用的 HTTP 代理，可选（如 `http://127.0.0.1:7890`） |

设置保存在 `$DSH_HOME/remote-dsh-openssh.json`（0600，原子写入），只含上述非敏感字段；不会改动 `~/.ssh/config`、`dsh-ssh.json` 或任何凭据。

### 文件传输

连接后点 **文件**：左列本机、右列服务器，勾选文件后按中间按钮互传；支持改名、删除、新建目录与文本在线编辑（写入上限 2 MB，更大文件用传输）。远端走同一条 SSH 连接的 SFTP 通道，不开额外端口。暂不支持整目录传输。

## 限制

- **不自动重连**：会话断开后显示「远端连接已断开，请重新连接」，需手动重试。
- **单活会话**：同一时刻只保留一个远端会话；连接主机 B 会先断开主机 A。
- **首次侧装依赖远端环境**：远端需要已安装 Node.js（满足 DSH 的 engines 要求）与 npm；侧装过程可能需要几分钟。
- 首版不做配置同步、不做主机增删（主机完全由 `~/.ssh/config` 管理）。
- 在线编辑写入上限 2 MB；目录传输暂不支持。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 主机指纹未知 / 校验失败 | 在终端跑一次 `ssh <alias>`，人工确认指纹后重试（插件 fail-closed，不会自动接受） |
| 私钥带口令，连接失败 | `ssh-add ~/.ssh/id_ed25519` 把钥匙交给 agent，再连接 |
| 需人工处理：端口被非 DSH 进程占用 | 按卡片给出的 PID 人工确认并处理该进程，再点重试 |
| 需人工处理：已有 dsh web 无法安全接管 / token 不可读 | 人工检查远端服务与日志（卡片会给出建议），处理后重试；插件不会替你重启 |
| 409「本插件首版仅支持 DSH 0.2.2-rc.3」 | 本机 DSH 版本不符；切换到受支持版本后再用 |
| 列表为空 | 在 `~/.ssh/config` 里配置 `Host` 条目后点「刷新」 |
| 连接中断、页面卡住 | 点「重试」手动重连；反复出现时检查远端 `dsh web` 日志 |

## English summary

A security-focused fork of [1583477320/remote-dsh](https://github.com/1583477320/remote-dsh) (baseline: npm `dsh-remote-panel-ssh@0.3.0`, Apache-2.0). It embeds the **full remote DSH web GUI** in the Desktop app over a direct OpenSSH connection. Hosts come from `~/.ssh/config` and reuse your keys, ssh-agent and `known_hosts` — unknown host keys fail closed, and no passwords or credentials are ever stored. A healthy remote `dsh web` is attached as-is; otherwise a matching runtime is **side-installed** into an isolated directory. The plugin **never kills or restarts remote processes**: unsafe takeovers surface a manual-action card with the reason, hint and PIDs, plus a retry button. The gateway heals its own auth token on 401 without restarting anything; dropped sessions require a manual reconnect. Scope: DSH `0.2.2-rc.3` only (host-side version gate), Linux remotes, direct SSH only — no ProxyJump/ProxyCommand, certificates, CA or KRL; Windows/macOS remotes are untested. Install from a local directory (`dsh plugin --profile desktop add link:$(pwd)` or Plugins → Add plugin), configure `Host` entries in `~/.ssh/config`, run `ssh <alias>` once to accept the host key, then Test / Connect in the "远程 DSH" panel. One active session at a time; the two-pane SFTP transfer view is kept from upstream. The repository URL is a placeholder fork home and may move.

## 许可

Apache-2.0，见 `LICENSE`。上游版权归上游作者所有；本 fork 的修改同样以 Apache-2.0 发布。