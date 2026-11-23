# Development Notes · 开发笔记

Audience: anyone (human or agent) continuing work on `dsh-remote-panel-openssh`.
Read this before touching `lib/client.js` — the keep-alive overlay has a subtle,
recurring failure mode ("the remote window does not switch / stays frozen over the
local session") that is easy to re-introduce. The invariants in §4 are load-bearing.

Companion docs: `README.md` (user-facing, Chinese + English summary),
`docs/DETAIL.md` (plugin detail page). Project memory lives in Hindsight
(pages: *Core concepts*, *Component map*, *Conventions and patterns*,
*Key decisions and rationale*, *Remote panel keep-alive + host hide/restore*,
*Concurrent multi-session remote connections*).

---

## 1. Identity & shape

- Package name: `dsh-remote-panel-openssh` (npm). Repo dir: `dsh-remote-panel-ssh`.
  Cordis plugin id / panel key: `remote-dsh-openssh` (`PANEL_ID` in `lib/client.js`).
- Security-first fork of upstream `1583477320/remote-dsh` (npm baseline
  `dsh-remote-panel-ssh@0.3.0`), Apache-2.0. Published fork:
  `github.com/jyshangguan/remote-dsh`, branch `openssh-safe-panel`.
- **Dual-face Cordis/DSH plugin**, plain ESM JavaScript, **no build step / no bundler /
  no TypeScript**:
  - Host half: `lib/index.js` (`exports["."]`), runs in the desktop host process.
    OpenSSH sessions, tunnel, gateway, `/api/remote-dsh-openssh/*` routes.
  - Browser half: `lib/client.js` (`exports["./client"]`), a
    `window.__ModuleLoader__.load({ id, factory })` closure. React comes from the
    browser module table (`require('react')`); elements built with
    `React.createElement` aliased `h()`. **Do not add JSX or a build pipeline.**
- `cordis.patch.yml` inserts the roster row; `package.json#dsh` declares
  `engines.dsh`, `bundle.patch`, and `client.inject` / `client.platform`.

### Module map (`lib/`)

| File | Responsibility |
|---|---|
| `index.js` | cordis plugin (`inject ['webServer']`); version gate (`SUPPORTED_DSH`); `createApp(deps)` route table (DI for tests); **concurrent** sessions Map + jobs Map + **per-host** `generations` Map + `sessionSeq`; routes `hosts/connect/restart/disconnect/state/test/hide/fs/local`; `apply()` wires + disposes. |
| `client.js` | React panel: `frameStore` + `viewStates` + `lastActiveId`; `FrameHost` (shell.overlay); `TabBar`; `RemoteDshPage` (picker shell); `SessionView` (keyed per host); `TransferView`; settings editor. |
| `hosts.js` | Settings store ONLY: `$DSH_HOME/remote-dsh-openssh.json` (schema v2, atomic tmp+rename, dir 0700 / file 0600). Top-level `hidden: [alias…]` list. Never touches `~/.ssh/*`. |
| `openssh.js` | Read-only `~/.ssh/config` enumeration (Include-aware), `ssh -G` effective config, `ssh-keygen -F` known_hosts verification (fail-closed). `SshError` stable codes. |
| `remote.js` | `openSession()` / `probeHost()`; attach-only lifecycle; side-install runtime; rc.3 spawn syntax; **uid-scoped** `pgrep` process scan; launch lock; 0600 logs; token validation via real 303+cookie; `stopRemoteWeb()` — the 重启-only SIGTERM path (see §4b). |
| `gateway.js` | Per-session loopback HTTP+WS gateway; holds the remote auth cookie (solves SameSite=Strict for the `dsh-app://` shell); 401 self-heal; Esc bridge injection; **stable per-host preferred port** (`remote.gatewayPortFor(alias)`, 41000..41899, EADDRINUSE scans forward) so the iframe ORIGIN — and with it the remote web app's localStorage session selection (`dsh.sessions.current`) — survives reconnects and remote restarts. |
| `sftp.js` / `localfs.js` | One fs protocol, two backends (remote SFTP over the same SSH conn; desktop fs) for the two-pane transfer view. |

---

## 2. Keep-alive overlay architecture (client)

The DSH shell's `main` slot is **keyed**: it renders only the entry whose
`options.key === activePanelId` (or the conversation when `activePanelId === null`).
So `RemoteDshPage` **unmounts** when the user navigates to a local session.
Removing an `<iframe>` from the DOM **discards its browsing context** (verified in
Chromium: `contentDocument` becomes `null`; re-appending reloads it). Therefore the
remote iframe must **never leave the DOM** while its session lives.

Design:

- `FrameHost` is registered into **`shell.overlay`** — a slot the shell renders
  *unconditionally* (wildcard entry, no key), above all columns, click-through
  (`pointer-events:none` on the layer; entries opt back in). It survives panel switches.
- `frameStore` (module-level, `useSyncExternalStore`): `{ frames: Map<hostId,{proxyUrl,
  sessionId,epoch,loaded}>, activeId, visible, panelActive, hint, error, measure }`.
  `frames` is cloned on every write so snapshots change identity.
- `FrameHost` renders **one iframe per live session**, all kept in the DOM; only the
  active one paints. Iframe key = `hostId:sessionId:proxyUrl:epoch` → switching the
  active host never remounts any frame (keep-alive); reload/death/new-session replaces
  only its own iframe.
- A single positioned container (`boxRef`, `position:absolute` inside the overlay layer)
  tracks the active `SessionView`'s stage rect via a rAF loop, in **layer-relative**
  coordinates (`offsetParent`), correct even if an ancestor creates a containing block.
  `place()` writes `left/top/width/height` **imperatively** on the DOM node.
- `SessionView` is **keyed by hostId** (cheap chrome remount per host) and owns per-host
  chrome state (`stage/failure/expanded/filesOpen`) persisted in module-level
  `viewStates`; `lastActiveId` restores the selected host on panel remount.
- `TabBar` (one tab per connected non-hidden host + a `+` that opens the picker) sits
  above both the session view and the picker.
- **Panel-active gating**: `apply()` injects the `layout` service and subscribes to
  `ctx.layout.panelInfo` (`HostObservable{getSnapshot,subscribe}`, shape
  `{activePanelId}`). `syncPanelActive()` sets `panelActive` and, when inactive, clears
  `visible/hint/measure`. `FrameHost` paints only when `show = visible && panelActive`.

Host-side concurrency: `sessions`/`jobs` are per-host Maps; `generations` is a
**per-host** counter so connecting B never supersedes A's in-flight job; same-host
`/connect` is **idempotent** (200 `alreadyConnected`, no teardown) and doubles as the
"switch to live session" primitive. `remote.js` scans processes with
`pgrep -f -u "$(id -u)"` so **another user's** `dsh web` (own `DSH_HOME`) is not a
same-profile conflict.

---

## 3. Historical bugs (do not regress)

Pilot fixes (each has a regression test): webLog `''`→`null`; attach must not probe the
remote default Node; ssh2 loading via `createRequire` multi-path across HMR remounts;
`command -v` wrapped in `sh -c`; rc.3 spawn syntax + dual-form process detection;
dark-theme `--dsw-alias-*` tokens. Later: cross-user false same-profile conflict
(uid-scoped pgrep); navigation freeze (see §4).

---

## 4. THE RECURRING BUG: "remote window does not switch / stays over local session"

**Symptom.** Connect to a remote host, click back to a local session: the remote DSH
window stays painted (and click-blocking) over the local conversation. Only 断开
(disconnect) makes it go away. Reconnecting / switching tabs appears "frozen".

**Root causes (all three mattered; verified against the CSS spec and Chromium):**

1. **CSS `visibility` child-override.** Per the CSS spec, a descendant with
   `visibility: visible` **is drawn even inside an ancestor with
   `visibility: hidden`**. The child iframe had
   `visibility: id === snap.activeId ? 'visible' : 'hidden'`. On navigating away,
   `activeId` still pointed at the host, so the iframe kept `visibility: visible` and
   **overrode the parent container's `hidden`** → stayed on screen.
2. **Imperative dimensions never reset.** `place()` writes `width/height` (e.g.
   1000×720) directly on the container DOM node. When hidden, those were left at full
   size, so the (still-visible) iframe kept covering the conversation and swallowing
   pointer events.
3. **`activePanelId === null` mis-read as active.** `syncPanelActive` had
   `active = info === null ? true : …`. In the DSH shell `activePanelId === null`
   **is the local Conversation**, so this falsely kept the panel "active".

**The fix (commit `4f2c9bf`) — INVARIANTS to preserve:**

- **I1.** Every child iframe: `visibility: (show && id === snap.activeId) ? 'visible' :
  'hidden'` **and** `pointerEvents: (show && id === snap.activeId) ? 'auto' : 'none'`.
  Never gate on `id === activeId` alone. When `show` is false, *all* iframes are hidden.
- **I2.** When `!show`, and in the layout-effect **cleanup**, imperatively collapse the
  container: `left/top/width/height = 0px`, `visibility='hidden'`,
  `pointerEvents='none'`. (React's style prop alone is not enough because `place()`
  writes dims imperatively.)
- **I3.** `syncPanelActive`: `active = info != null && info.activePanelId === PANEL_ID`.
  `null` (local conversation) ⇒ inactive.
- **I4.** Hide-on-unmount uses **`useLayoutEffect` cleanup** (synchronous, pre-paint),
  not passive `useEffect` (async after paint; a heavy conversation mount delays it and
  re-creates the freeze).
- **I5.** Iframe keys stay stable across active-host switches (keep-alive). Do not
  remount frames on tab/panel switch; only reload/death/new-session changes a key.

**How to verify a change here:** run the Chromium harness (§5) and assert, after
switching to local: container `getBoundingClientRect().width === 0`,
`getComputedStyle(container).visibility === 'hidden'`, and every iframe
`visibility === 'hidden'`; the local view is interactable. Then switch back: container
restored to the stage rect, active iframe `visible`, per-host text/scroll preserved.

**Window-chrome seat (2026-11-23, "sidebar-collapsed buttons under the remote
window").** On macOS desktop a collapsed sidebar hides its column entirely and the
frame mounts the `shell.leading` seat (reopen + New Session, `left: 88px`,
y ≈ 11..39, z 15) — *below* `shell.overlay` (z 20). The shell publishes the
inherited `--dsh-frame-leading-clearance` (160px darwin / 84px fullscreen /
48px web drawer) for main panels that reach the top-left corner. Mirroring the
local conversation's `.titleRow` pattern, only the plugin's TOP row steps aside:
the TabBar pads its start by the var (tabs line up after those controls) and is
40px tall, so every row below starts under the seat band; the session chrome, the
remote stage and the picker keep the FULL width — the overlay tracks the stage
rect, so the remote view spans x=0 while collapsed. The maximized (Esc) stage has
no row of its own below the band, so it keeps `left: var(…)` while collapsed and
the buttons stay reachable over the zoomed remote view. Any future full-bleed
surface that reaches y < 40 must respect the same var, or it will cover the seat
buttons again.

**§4b. The 重启 exception to "never signal" (2026-11-23).** The fork's rule is
still "no automatic path ever signals a remote process". The ONE deliberate
exception is `openSession({ restart: true })` — reachable only through
`POST /restart`, which only the panel's 重启 button calls (after a confirm):
`stopRemoteWeb` SIGTERMs the `dsh web` processes that (a) the uid-scoped pgrep
scan found, (b) parse to OUR webPort, and (c) still match DSH_WEB_PATTERN in
`/proc/<pid>/cmdline` re-read immediately before the signal (PID-reuse guard).
Never SIGKILL; a process that ignores SIGTERM for 20 s becomes
ManualActionRequired. Afterwards our OWN lock dir is dropped only when its pid
file points at a terminated (or gone) pid, then the normal install-and-start
path boots the server again. `kill`/`kill -0` may therefore appear ONLY in
commands issued by that path — every other flow must keep passing
`assertNoKill`. Tests: three restart cases + one "no restart ⇒ no signal"
guard in `test/remote.test.mjs`; route wiring in `test/api.test.mjs`.

---

## 5. Testing

- **Unit / API:** `node --test test/*.test.mjs` (always the glob; bare
  `node --test test/` misbehaves on Node 24). Host half exercised via `createApp(deps)`
  with injected fakes (no ssh2, no real fs); `openssh`/`remote` effects injected via
  `deps`. Baseline 149 tests. Add a regression test for every bug fix.
- **Client / visual:** no client unit harness in-repo (plain factory, no build). Use a
  local Chromium harness: serve `lib/client.js` over http with a mock
  `window.__ModuleLoader__`, a mock slot registry (`main` keyed, `shell.overlay`
  wildcard, `sidebar.panellist`), a mock `ctx.layout.panelInfo` observable, and a fake
  `/api/remote-dsh-openssh/*` + a fake remote SPA page (counter + input + scroll) that
  `postMessage`s its state. Drive: connect → switch local → assert hidden/collapsed →
  switch back → assert restored & state preserved; tab switch A→B→A zero remounts;
  non-active death prunes frame; hide/restore; reload; maximize/Esc; collapse the
  sidebar → assert the first tab sits right of the `[data-shell-leading]` seat,
  the container spans the full width from x=0 with its top below the seat band,
  and `document.elementFromPoint(seatButtonCenter)` returns the button; magnified
  keeps the container's left ≥ the seat's right; reopen → container returns to
  the open-sidebar baseline.
- **Manual (real app):** `link:` install requires a **full quit (tray too) + reopen** to
  refresh the client bundle. Checklist: switch away/back keeps exact view; mid-install
  switch/back resumes; real drop shows failure card + retry; refresh re-adopts live
  session; hide/restore; concurrent tabs; app menus render above the frame.

---

## 6. Release / npm install

- npm name `dsh-remote-panel-openssh` is unscoped and was free at first publish.
  `package.json` must **not** set `"private": true`. `files` is a whitelist
  (`lib`, `cordis.patch.yml`, `README.md`, `LICENSE`, `locale`, `icon.svg`, `docs`) —
  tests and node_modules are excluded. `docs/DEVELOPMENT.md` ships with the package.
- Bump `version`, then `npm pack --dry-run` to inspect the tarball, then `npm publish`
  (unscoped ⇒ public). Consumers install with:
  `dsh plugin --profile desktop add dsh-remote-panel-openssh`
  (or Plugins → Add plugin → npm name). The installer pulls `ssh2`.
- **Dev workflow:** `dsh plugin --profile desktop add link:$(pwd)`; after editing
  `lib/client.js` fully quit + reopen the app (HMR of a `link:` client bundle is not
  reliable). Host-half edits also need a restart.
- Keep `dsh.engines.dsh` in sync with the supported DSH release; the host-side gate
  (`SUPPORTED_DSH`) must match.

## 7. Known limitations

Linux remotes only; direct SSH only (no ProxyJump/ProxyCommand/certs/CA/KRL);
passphrase keys need `ssh-add`; no whole-directory transfer; online edit ≤2 MB;
no config sync; hosts authoritative in `~/.ssh/config` (read-only) with panel-level
hide/restore; no auto-reconnect after a *real* drop (panel/tab switching is not a drop);
one SSH conn + gateway + kept-alive iframe per connected host (linear resource cost).