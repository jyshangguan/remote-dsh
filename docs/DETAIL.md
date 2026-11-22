# 远程 DSH（OpenSSH）

通过 OpenSSH 直连，把远端完整的 DSH Web 界面嵌进桌面端面板。这是 dsh-remote-panel-ssh 的安全优先 fork：只接管、不破坏。

## 功能

- 主机列表直接来自 `~/.ssh/config`，复用 OpenSSH 公钥、ssh-agent 与 `known_hosts`；未知主机指纹一律拒绝（fail-closed），不存任何密码或凭据。
- 「测试」只探测不改动：SSH 连通性、Node 版本、侧装运行时版本、远端 `dsh web` 状态，并给出结论——可直接接管 / 将侧装并启动 / 需人工处理。
- 「连接」按阶段推进：SSH → 检查环境 → 侧装匹配版本运行时（如需）→ 启动 `dsh web` → 建立通道。健康的远端服务原样接管；否则侧装到远端 `~/.local/share/dsh-remote-panel-openssh/runtime/<版本>/`，不覆盖已有 `dsh` 命令；远端数据仍用服务器自己的 `~/.dsh` 与 profile。
- 绝不静默 kill / restart 远端进程。无法安全接管时显示「需人工处理」卡片：原因、处理建议、涉及 PID，人工处理后点「重试」。
- 远端 `dsh web` 只绑 127.0.0.1，经 SSH 隧道 + 本机网关访问；网关 401 时自动重读 token 自愈，不重启远端服务。日志权限 0600。
- 会话内嵌支持重新加载、放大（Esc 退出）、在新窗口打开、断开；双列 SFTP 文件传输（上传 / 下载 / 改名 / 删除 / 新建 / 文本编辑）。

## 使用

1. 在 `~/.ssh/config` 配置 `Host` 条目；新机器先在终端 `ssh <alias>` 一次以确认主机指纹。
2. 打开侧边栏「远程 DSH」，先「测试」再「连接」。
3. 每台主机可「设置」：webPort（1–65535，默认 18080）、profile（默认 web）、webLog（已有实例的日志路径，可选）、nodeBin（远端 Node bin 目录，可选，如 nvm 的 bin；留空用默认 PATH）、installProxy（可选）。本插件启动的实例日志写入自己的 logs 目录（0600，绝不截断已有日志）。
4. 连接后点「文件」进入双列传输视图；「断开」结束会话。

## 限制

- 首版仅支持 DSH 0.2.2-rc.3（宿主侧版本门禁，不符返回 409）；远端仅限 Linux；仅直连 SSH，不支持 ProxyJump / ProxyCommand、SSH 证书、CA、KRL；Windows / macOS 远端未测试。
- 不自动重连：断开后需手动重试。单活会话：连接主机 B 会先断开主机 A。
- 首次侧装需要远端已有 Node.js（满足 DSH engines 要求）与 npm，可能耗时几分钟。
- 不做配置同步；主机增删完全由 `~/.ssh/config` 管理。在线编辑写入上限 2 MB；暂不支持整目录传输。

## 常见问题

- 指纹未知：终端跑一次 `ssh <alias>` 人工接受后重试。
- 私钥带口令：先 `ssh-add`。
- 需人工处理：按卡片提示人工确认进程 / 服务后重试，插件不会替你结束或重启。

来源：fork 自 1583477320/remote-dsh（基线 npm dsh-remote-panel-ssh@0.3.0），Apache-2.0。