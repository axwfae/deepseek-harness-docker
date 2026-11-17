# dsh-lightpanda-cdp

用 CDP 驅動**遠端 [Lightpanda](https://github.com/lightpanda-io/browser) 無頭瀏覽器**的
DeepSeek Harness 外掛。零依賴：只用 `node:http`、`node:crypto`、`node:fs`、`node:path`。

## 為什麼要自己寫 CDP 客戶端

兩個 Lightpanda 特性讓現成方案直接失敗：

1. **Host 標頭白名單。** Lightpanda 的 JSON 端點與 WebSocket upgrade 只接受 loopback 形式的
   `Host`。從另一個容器用 `lightpanda:9222` 存取會得到 `403 Host not allowed`。
   Node 全域 `WebSocket`（undici）無法覆寫 `Host`，所以本外掛直接驅動 `node:http` 自行設定
   （預設 `hostHeader: 127.0.0.1:9222`）。
2. **target 生命週期綁在連線上。** CDP socket 關閉時，該連線開的分頁一併銷毀；`/json/new`
   回 404。因此本外掛維持**一條常駐連線**並快取 `targetId -> sessionId`，
   `lp_open` 回傳的 target id 在下一次工具呼叫仍然有效。

工具優先走 Lightpanda 自家的 `LP` domain（`LP.dump`、`LP.getInteractiveElements`、
`LP.clickNode`、`LP.fillNode`、`LP.waitForSelector`、`LP.waitUntil`、`LP.getPageStatus`），
因為它們回傳的是適合 agent 消費的結構；通用 `Runtime`/`Input`/`Page` 呼叫是後備路徑。

## 安裝

```bash
dsh plugin --profile web add file:/home/node/workspace/system/lightpanda/dsh-lightpanda-cdp
```

或在 DSH 工作階段內用 `plugin_manager`，`action: install_bundle`，target 指向本目錄。
重啟 Web GUI 或開新工作階段後可見到 `lp_*` 工具。

## 圖形設定介面

設定卡片長在 **側邊欄 → Plugins（外掛）頁**，不在 Settings：DSH 的 Settings 只列內建外掛
清單（唯讀），第三方外掛的設定頁一律掛在 Plugins 頁。路徑：

**Plugins → 找到 `dsh-lightpanda-cdp` → 點開詳情頁 → 說明文字下方的「Lightpanda 端點」卡片**

卡片有主機、連接埠、Host 標頭、請求預算四個欄位，可直接儲存／恢復預設，並即時顯示
可達性（`可達 · 1.0.4` 或 `不可達 · 原因`）與每個欄位目前取值來源。

卡片本身是 `client.js`，註冊到 slot `plugins.bundle.config`（key = 套件名），資料來自
host 半區的 `GET/POST /lightpanda-cdp/config`。boot graph 在頁面載入時組合，所以**第一次
安裝外掛後要重新載入一次頁面**，之後才由 HMR 跟隨。

## 隨時改端點（不必重啟）

每次呼叫都重新解析端點，優先序由高到低：

1. 單次呼叫參數 —— 任一工具上的 `host` / `port` / `hostHeader`
2. 環境變數 —— `LIGHTPANDA_CDP_URL=http://lightpanda:9222`，或
   `LIGHTPANDA_CDP_HOST` / `LIGHTPANDA_CDP_PORT` / `LIGHTPANDA_CDP_HOST_HEADER`
3. 設定檔，由 `lp_config` 寫入：
   `$DSH_PROFILE_DIR/plugins-data/lightpanda-cdp/config.json`
4. `cordis.patch.yml` 裡的 plugin config
5. 內建預設 —— `lightpanda:9222`，Host 標頭 `127.0.0.1`

DSH 持續運行時有兩種改法：

```text
lp_config({ action: "set", host: "lightpanda", port: 9223 })
lp_config({ action: "show" })     # 解析後的值 + 各欄位來源 + 可達性探測
lp_config({ action: "reset" })    # 刪除設定檔，回落 env/config/預設
```

或直接編輯 JSON；下一次呼叫就重讀，存檔即生效：

```json
{ "host": "lightpanda", "port": 9223 }
```

`hostHeader` 只需 loopback 主機名（`127.0.0.1`）。實測 Lightpanda 只檢查主機名、任何
port 都放行，所以改 `port` 不必同時改它。

## 設定

| 欄位 | 預設 | 意義 |
| --- | --- | --- |
| `host` | `lightpanda` | 從 DSH 容器連出的 CDP 主機。 |
| `port` | `9222` | CDP 埠。 |
| `hostHeader` | `127.0.0.1` | 送給 Lightpanda 的 `Host` 標頭，只需 loopback 主機名。 |
| `timeoutMs` | `30000` | 預設 CDP 請求預算。 |
| `configPath` | profile 的 `plugins-data/lightpanda-cdp/config.json` | `lp_config` 寫入的位置，可改。 |

每個工具也接受單次呼叫的 `host` / `port` / `hostHeader` 覆寫。

## 工具

| 工具 | 作用 |
| --- | --- |
| `lp_config` | 讀取或變更端點：`show` / `set` / `reset`，附可達性探測。 |
| `lp_status` | Lightpanda 版本 + 目前分頁；給 `targetId` 時回報該頁 HTTP 狀態、JS 錯誤與失敗請求。 |
| `lp_open` | 開網址、等載入完成，回傳 `targetId` + 最終網址 + 標題。 |
| `lp_read` | 讀頁面為 `markdown`（預設）/ `html` / `text`；`selector` 限定子樹、`maxChars` 限長。 |
| `lp_eval` | 執行 JS（`returnByValue`，可選 `awaitPromise`）。 |
| `lp_elements` | 依文件順序列出可見可互動元素，每個帶 `lp_act` 要用的 `backendNodeId`。 |
| `lp_act` | `click` / `fill` / `scroll` / `wait`，可用 `nodeId`（真實指標事件）或 `selector`。 |
| `lp_shot` | PNG 截圖寫入磁碟，回傳絕對路徑。 |
| `lp_close` | 關閉分頁（預設關最後使用的那個）。 |

典型流程：

```text
lp_open({ url: "https://news.ycombinator.com/" })
lp_read({ format: "markdown", maxChars: 4000 })
lp_elements({ max: 20, tag: "a" })
lp_act({ action: "click", nodeId: 15 })
lp_shot({ path: "shots/hn.png" })
```

## 已知限制（實測於 Lightpanda 1.0.4）

- `Page.captureScreenshot` 只吃 `png`，`jpeg` 會回 `unsupported screenshot format`。
- `LP.dump` 只支援 `markdown` 與 `html`，沒有 `text`（本外掛改用 `innerText` 產生）。
  其 `maxBytes` 是近似值，並會附加 `[truncated]`。
- 頁面內的 `fetch()` 會失敗（`TypeError: fetch error`），但頁面本身的網路載入正常。
- `DOM.querySelector` 不可靠（對真實 root 回 node-not-found）；元素查找走
  `Runtime.evaluate` 或 `LP.getInteractiveElements`。
- `Runtime.callFunctionOn` 需要 `objectId`；單純函式求值請用 `Runtime.evaluate`。
- `lp_shot` 回傳路徑而非像素；要看圖請讀取該 PNG。

## 其他客戶端對 Lightpanda 的實測

Playwright/Puppeteer 系客戶端預設先抓 `/json/version`，再連它回傳的
`webSocketDebuggerUrl`。Lightpanda 回的是 `ws://127.0.0.1:9222/`，於是從另一個容器連
時，客戶端會去連自己的 loopback 並以 `ECONNREFUSED 127.0.0.1:9222` 失敗。
明確指定 WebSocket 端點則可行：

```js
const browser = await chromium.connectOverCDP('ws://lightpanda:9222', {
  headers: { Host: '127.0.0.1:9222' },
})
```

以 `playwright-core` 1.56 實測：`goto`、`title`、`evaluate`、`screenshot`、`click`、
`fill` 對 Lightpanda 全部成功。因此 Playwright MCP server 也是可行替代方案
（`--cdp-endpoint ws://lightpanda:9222 --cdp-header "Host: 127.0.0.1:9222"`），
代價是要 spawn 一個 Node 行程，且工具面大得多。

## 驗證紀錄

在 DSH 容器內對 `lightpanda:9222` 實測（Lightpanda 1.0.4，protocol 1.3）：

- HTTP `/json/version` 帶 `Host: 127.0.0.1:9222` → 200；不帶 → 403。
- `Target.createTarget` + `attachToTarget(flatten)` + `Page.navigate` +
  `Runtime.evaluate` + `Page.captureScreenshot(png)` 全部成功。
- `LP.dump(markdown)` 對 `news.ycombinator.com` 產出 22 KB markdown；
  `maxBytes: 100` → 114 字元並以 `[truncated]` 結尾。
- `LP.getInteractiveElements` → 227 筆；`LP.clickNode` 於新聞連結成功導航到
  `item?id=...`；`Input.dispatchMouseEvent` 後備路徑同樣導航成功。
- 一條 socket 上建立的 target，在該 socket 關閉後消失 — 這正是需要常駐連線的原因。
- `node test/smoke.mjs` 的 14 項檢查全部 PASS（涵蓋開頁、讀取、求值、列元素、
  點擊導航、填表、截圖、關閉，以及跨呼叫沿用同一 target）。
