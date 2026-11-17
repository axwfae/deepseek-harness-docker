# dsh-lightpanda-cdp

DeepSeek Harness plugin that drives a **remote [Lightpanda](https://github.com/lightpanda-io/browser)**
headless browser over the Chrome DevTools Protocol. Zero dependencies: `node:http`,
`node:crypto`, `node:zlib`-free PNG handling is not needed (Lightpanda returns base64 PNG),
`node:fs`, `node:path`.

## Why a custom CDP client

Two Lightpanda-specific facts make the stock approaches fail:

1. **Host-header allow-list.** Lightpanda only accepts loopback `Host` values on its JSON
   endpoints and its WebSocket upgrade. Reaching it as `lightpanda:9222` from another
   container returns `403 Host not allowed`. Node's global `WebSocket` (undici) cannot set
   `Host`, so this plugin drives `node:http` and sets the header itself
   (`hostHeader: 127.0.0.1:9222` by default).
2. **Target lifetime follows the connection.** Closing the CDP socket destroys the tabs
   opened on it, and `/json/new` answers 404. The plugin therefore keeps one warm
   connection and caches `targetId -> sessionId`, so a target id returned by `lp_open`
   still works in the next tool call.

The tools prefer Lightpanda's own `LP` domain (`LP.dump`, `LP.getInteractiveElements`,
`LP.clickNode`, `LP.fillNode`, `LP.waitForSelector`, `LP.waitUntil`, `LP.getPageStatus`)
because those return agent-sized structures; generic `Runtime`/`Input`/`Page` calls are
the fallback.

## Install

```bash
dsh plugin --profile web add file:/home/node/workspace/system/lightpanda/dsh-lightpanda-cdp
```

Or, inside a DSH session, `plugin_manager` with `action: install_bundle` and this directory
as `target`. Restart the Web GUI (or open a new session) and the `lp_*` tools appear.

## Settings page

The card lives on the sidebar's **Plugins** page, not in Settings: Settings only lists the
built-in inventory (read-only), while every third-party plugin configuration page is
contributed to Plugins. Path:

**Plugins → find `dsh-lightpanda-cdp` → open its detail page → the "Lightpanda endpoint" card
under the description**

It edits host, port, Host header and request budget, saves or restores defaults, and shows
live reachability plus which layer supplies each value.

The card is `client.js`, registered into the `plugins.bundle.config` slot (key = package
name) and fed by the host route `GET/POST /lightpanda-cdp/config`. The boot graph is composed
when the page loads, so **reload the page once after installing the plugin**; later changes
follow HMR.

## Changing the endpoint (no restart needed)

The endpoint resolves per call, most specific first:

1. per-call arguments — `host` / `port` / `hostHeader` on any tool
2. environment — `LIGHTPANDA_CDP_URL=http://lightpanda:9222`, or
   `LIGHTPANDA_CDP_HOST` / `LIGHTPANDA_CDP_PORT` / `LIGHTPANDA_CDP_HOST_HEADER`
3. the settings file, written by `lp_config`:
   `$DSH_PROFILE_DIR/plugins-data/lightpanda-cdp/config.json`
4. the plugin config block in `cordis.patch.yml`
5. the built-in default — `lightpanda:9222`, Host header `127.0.0.1`

Two ways to change it while DSH keeps running:

```text
lp_config({ action: "set", host: "lightpanda", port: 9223 })
lp_config({ action: "show" })     # resolved values + which layer supplied each + reachability probe
lp_config({ action: "reset" })    # delete the settings file, fall back to env/config/default
```

Or edit the JSON file directly; it is re-read on the next call, so a save takes effect
immediately:

```json
{ "host": "lightpanda", "port": 9223 }
```

```bash
$EDITOR "$DSH_PROFILE_DIR/plugins-data/lightpanda-cdp/config.json"
```

`hostHeader` only needs a loopback hostname (`127.0.0.1`); measured: Lightpanda checks the
hostname and accepts any port, so changing `port` does not require changing it.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `host` | `lightpanda` | CDP host to connect to from the DSH container. |
| `port` | `9222` | CDP port. |
| `hostHeader` | `127.0.0.1` | `Host` header sent to Lightpanda. Keep a loopback hostname. |
| `timeoutMs` | `30000` | Default CDP request budget. |
| `configPath` | profile `plugins-data/lightpanda-cdp/config.json` | Where `lp_config` saves; override to relocate it. |

Every tool also accepts per-call `host` / `port` / `hostHeader` overrides.

## Tools

| Tool | What it does |
| --- | --- |
| `lp_config` | Read or change the endpoint: `show` / `set` / `reset`, with a reachability probe. |
| `lp_status` | Lightpanda version + open tabs; with `targetId`, the page's HTTP status, JS errors and failed requests. |
| `lp_open` | Open a URL, wait for load, return `targetId` + final url + title. |
| `lp_read` | Read the page as `markdown` (default), `html`, or `text`; scope with `selector`, bound with `maxChars`. |
| `lp_eval` | Evaluate JS (`returnByValue`, optional `awaitPromise`). |
| `lp_elements` | Visible interactive elements in document order, each with the `backendNodeId` used by `lp_act`. |
| `lp_act` | `click` / `fill` / `scroll` / `wait`, by `nodeId` (trusted pointer events) or `selector`. |
| `lp_shot` | PNG screenshot written to disk; returns the absolute path. |
| `lp_close` | Close a tab (defaults to the last used one). |

Typical flow:

```text
lp_open({ url: "https://news.ycombinator.com/" })
lp_read({ format: "markdown", maxChars: 4000 })
lp_elements({ max: 20, tag: "a" })
lp_act({ action: "click", nodeId: 15 })
lp_shot({ path: "shots/hn.png" })
```

## Limitations (verified against Lightpanda 1.0.4)

- `Page.captureScreenshot` accepts `png` only — `jpeg` fails with
  `unsupported screenshot format`.
- `LP.dump` supports `markdown` and `html`; `text` is not an enum value (this plugin
  produces `text` from `innerText` instead). Its `maxBytes` is approximate and appends
  `[truncated]`.
- Page-level `fetch()` fails inside the page (`TypeError: fetch error`); page network
  loading itself works normally.
- `DOM.querySelector` is unreliable (returns node-not-found for a real root); element
  lookup goes through `Runtime.evaluate` or `LP.getInteractiveElements`.
- `Runtime.callFunctionOn` requires an `objectId` — plain function evaluation uses
  `Runtime.evaluate`.
- No `--dump`-style CLI is used here; everything goes over the CDP socket.
- `lp_shot` returns a path, not pixels. Read the PNG to look at it.

## Other clients against Lightpanda (measured)

Playwright/Puppeteer-based clients default to fetching `/json/version` and then dialing the
`webSocketDebuggerUrl` it returns. Lightpanda answers with `ws://127.0.0.1:9222/`, so from
another container those clients dial their own loopback and fail with
`ECONNREFUSED 127.0.0.1:9222`. Passing the WebSocket endpoint explicitly works:

```js
const browser = await chromium.connectOverCDP('ws://lightpanda:9222', {
  headers: { Host: '127.0.0.1:9222' },
})
```

Measured with `playwright-core` 1.56: `goto`, `title`, `evaluate`, `screenshot`, `click`
and `fill` all succeed against Lightpanda. That makes a Playwright MCP server a workable
alternative (`--cdp-endpoint ws://lightpanda:9222 --cdp-header "Host: 127.0.0.1:9222"`),
at the cost of a spawned Node process and a much broader tool surface.

## Verification

Verified from the DSH container against the `lightpanda:9222` service
(Lightpanda 1.0.4, protocol 1.3):

- HTTP `/json/version` with `Host: 127.0.0.1:9222` → 200; without it → 403.
- `Target.createTarget` + `attachToTarget(flatten)` + `Page.navigate` +
  `Runtime.evaluate` + `Page.captureScreenshot(png)` all succeed.
- `LP.dump(markdown)` on `news.ycombinator.com` → 22 KB of markdown;
  `maxBytes: 100` → 114 chars ending in `[truncated]`.
- `LP.getInteractiveElements` → 227 entries; `LP.clickNode` on a story link navigated to
  `item?id=...`; `Input.dispatchMouseEvent` fallback also navigated.
- Targets created on one socket disappear after that socket closes — the reason for the
  warm connection.
