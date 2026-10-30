# DSH Edge Bridge

让任意本地 agent（DSH、Claude、Codex、你自己的脚本）**直接驱动 Edge / Chrome**。
零依赖、纯 Node + 一个 MV3 扩展，两种后端：

- **CDP 直连**：浏览器自己开调试端口，持久、稳定、毫秒级
- **扩展桥**：给"你正在用的那个浏览器"用，不用重启、不用重登

```bash
node src/bcli.mjs '{"op":"tabs"}'
```

```json
{"ok": true, "backend": "cdp", "value": [{"tabId": "8AD6...", "title": "供应链管理", "url": "https://..."}]}
```

---

## 为什么需要它

agent 操作浏览器只有三条路：

| 方式 | 问题 |
|---|---|
| 截图 + 坐标点击（computer use） | 慢（每步 1–3 秒）、脆（改版、缩放、动画都会点偏） |
| 浏览器调试端口（CDP） | 必须带参数启动，且不能用默认配置目录 |
| 浏览器扩展 | 能用你当前的浏览器，但 MV3 后台会被系统回收，容易掉线 |

这个项目把后两条都实现了，并让它们自动切换。

## 两个关键坑（实测 Edge 156 / Chromium 156）

**1. 默认配置目录不能开调试端口**

```
msedge.exe --remote-debugging-port=9222
→ 进程参数里有，端口不监听
```

Chromium 136 起直接忽略这个开关（安全策略：防止恶意程序接管日常浏览器）。必须用 `--user-data-dir` 指向另一个目录。

**2. 复制配置目录搬不走登录态**

即使把整个 profile 复制过去（507 MB、3359 条 cookie、Local State 一起），新实例也只能解出 **43** 条 cookie —— 因为 Chrome/Edge 从 127 版起使用 **App-Bound Encryption**，密钥绑定在原始安装上，复制出来的密文解不开，浏览器会直接丢弃。

**结论**：想要"用你现在的浏览器登录态"，只能用扩展桥；想要"永不断线"，只能给自动化一个独立 profile 并登录一次。两者无法兼得。

## 架构

```
agent / CLI ──HTTP──▶ relay :9311 ──long-poll──▶ extension (MV3) ──chrome.debugger──▶ tab
agent / CLI ──WS────▶ CDP   :9222 ───────────────────────────────────────────────────▶ tab
```

CDP 在线时优先走 CDP（`bcli.mjs` 自动判断），否则回退到扩展。

扩展侧的关键设计：**长轮询放在 offscreen document 里**，不放 service worker。MV3 的 SW 空闲 30 秒就被回收，放里面必然掉线；offscreen 文档是普通扩展页面，不受这个定时器影响，再由它把命令转发给 SW。

## 快速开始

要求：Node ≥ 22（用到全局 `fetch` / `WebSocket`），Windows（脚本用 PowerShell；协议本身跨平台）。

### 方式 A：CDP（推荐，持久）

```powershell
.\scripts\start-edge.ps1          # 用独立 profile 启动，端口 9222
node src/bcli.mjs '{"op":"tabs"}'
```

第一次需要在这个浏览器里登录一次你要用的站点，之后 profile 会记住。

### 方式 B：扩展桥（接管你当前开着的浏览器）

1. 打开 `edge://extensions` → 打开「开发人员模式」→「加载解压缩的扩展」→ 选 `extension/` 目录
2. 直接调用，中继会自动拉起：

```bash
node src/bcli.mjs '{"op":"tabs"}'
```

浏览器顶部会出现「已开始调试此浏览器」的黄条，这是 `chrome.debugger` 的固定提示。

## CLI

```bash
node src/bcli.mjs '{"op":"eval","args":{"tabId":"<id>","code":"document.title"}}'
'{"op":"tabs"}' | node src/bcli.mjs -          # 从 stdin 传，避免 PowerShell 吃掉引号
```

| op | args | 说明 |
|---|---|---|
| `ping` | — | 连通性 |
| `tabs` | — | `tabId, title, url, status` |
| `open` | `url, active?` | 新标签页，返回 `tabId` |
| `activate` | `tabId` | 切到前台 |
| `close` | `tabId` | 关闭 |
| `eval` | `tabId, code` | `Runtime.evaluate`（`awaitPromise`，返回可序列化值） |
| `shot` | `tabId, out` | PNG 截图（含后台标签页） |
| `click` | `tabId, x, y` | 真实鼠标事件 |
| `type` | `tabId, text` | 插入文本 |
| `key` | `tabId, key` | 原始 `Input.dispatchKeyEvent` 参数 |
| `cdp` | `tabId, method, params` | 任意 CDP 方法 |

扩展后端额外支持 `status`（查看 offscreen 文档、已附加标签页）。

环境变量：`BRIDGE_CDP_PORT`（默认 9222）、`BRIDGE_RELAY_PORT`（默认 9311）。
改中继端口时记得同步改 `extension/manifest.json` 的 `host_permissions`。

## 给别的 agent 用

把这段丢进任何有 shell 权限的 agent 的 prompt 里：

```
本机有浏览器桥：'{"op":"tabs"}' | node <path>/src/bcli.mjs -
返回 JSON，op: tabs/eval/shot/click/type/open/activate/close/cdp。
用 stdin 传参，单条命令 60s 超时，多个 agent 别抢同一个 tabId。
```

它本质上是个本地 HTTP 服务（`POST /cmd`），不用 Node 也能接。

## 已知限制

- **canvas 页面读不到结构化数据**：飞书多维表格的表格区是 2 个 canvas，`querySelectorAll('[role=gridcell]')` 返回 0 —— 这种情况只能截图，或者走站点自己的 OpenAPI
- **同一个标签页不能和 F12 共存**：一个 tab 同时只允许一个调试器
- **扩展会在浏览器重启后掉**：需要去 `edge://extensions` 点一次重新加载
- **只支持 Chromium 系**：Firefox 不走 CDP
- **端口只绑 127.0.0.1**：这是刻意的，别改成 0.0.0.0

## 安全

调试端口等于完整控制权：能读 cookie、能发任意请求、能注入脚本。请只在本机使用，并给自动化单独一个 profile，不要拿它登录银行之类的高价值账号。

## License

MIT
