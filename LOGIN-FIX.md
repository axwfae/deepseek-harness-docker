# DSH Docker 登入修正：`upstream-token.js`

適用於 `axwfae/deepseek-harness-docker`（`@deepseek-ai/dsh` 0.2.x，含 admin 變體）。
修正日期：2026-11-05；**2026-11-11 追加「自簽 cookie」根治方案（見 §0）**。

---

## 0. 2026-11-11 追加：不再依賴 launch token

### 0.1 仍會 401 的真正原因

§2 的模型決定了 launch token **只存在於 DSH 進程記憶體**、只在啟動時印一行。舊版代理從
`/app/.dsh-web.log` 打撈 token；一旦打撈到的值不是「當前進程」的 token，`GET /?token=…`
就永遠 401，且每次重試都用同一個錯值。實測線上症狀：

```sh
curl -sS -i 'http://<主機>:53080/index.html'   # 302 → /?token=<43字元>
curl -sS -i 'http://<主機>:53080/?token=<同上>'  # 直接 401（token 無效，不是交換機制壞）
```

常見成因：

| 成因 | 說明 |
|---|---|
| DSH 被 `docker exec`／手動重啟 | 新的 `dsh web:` 行沒寫進代理讀的日誌檔，日誌裡只剩舊進程的 token |
| 舊進程 token 留在日誌尾部 | 重啟競態、切換版本失敗留下的進程先印了 token 後退出 |
| `DSH_TOKEN`／`DSH_TOKEN_FILE` 殘留 | 硬指定優先於日誌，DSH 重啟後永久失效 |

### 0.2 新機制：代理自簽 DSH 會話 cookie

DSH 的 cookie 簽名密鑰持久化在 `$DSH_HOME/.credentials.yaml`：

```yaml
version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: <base64url 32 bytes>
```

代理（與 DSH 同一容器、同一使用者）讀出 `secret`，照上游格式自行簽發：

- cookie 名稱：`dsh-auth-` + `base64url(sha256(authority))`，authority = 上游看到的 Host
  （代理 `changeOrigin`，固定 `127.0.0.1:<DSH_PORT>`）；
- cookie 值：`v1.<base64url(JSON{version,authority,issuedAt,expiresAt})>.<base64url(HMAC-SHA256)>`。

然後把這個 cookie **注入每一個轉給 DSH 的請求**（HTTP 與 WebSocket），並在首頁回應時
`Set-Cookie` 給瀏覽器。效果：

- 不需要 launch token、不需要讀日誌；
- DSH 重啟／切換版本（密鑰不變）後使用者的瀏覽器**不會**再被踢回 401；
- 瀏覽器裡的舊／無效 cookie 會被代理剝離替換，不再出現「舊 cookie 導致 401」；
- 密鑰被換掉（資料卷重建）時，代理在 1 秒內自動換用新密鑰並重新簽發。

讀不到密鑰（路徑不對、權限不足、檔案尚未生成）時，才回退到 §3 的 launch token 流程。

### 0.3 新環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `DSH_CREDENTIALS_FILE` | 空 | 明確指定 `.credentials.yaml`；不設則依序探測 `$DSH_HOME/.credentials.yaml`、`~/.dsh/…`、`/home/node/.dsh/…`、`/root/.dsh/…` |
| `DSH_COOKIE_MAX_AGE_DAYS` | `30` | 自簽 cookie 有效期；必須 ≤ DSH 的 `cookieMaxAgeDays`（預設 30），否則上游會拒收 |

### 0.4 驗證

```sh
# 容器內：確認密鑰存在且可讀
docker exec dsh-harness sh -c 'ls -l "$HOME/.dsh/.credentials.yaml" && grep -c "browser-session" "$HOME/.dsh/.credentials.yaml"'

# 外部：根目錄應直接 200（並帶 Set-Cookie），不再 401
curl -sS -o /dev/null -w '%{http_code}\n' http://<主機>:3080/
curl -sS -i http://<主機>:3080/ | grep -i 'set-cookie'

# 容器日誌應出現（而不是「自動登入失敗」）
docker logs dsh-harness 2>&1 | grep '簽名密鑰'
```

排錯：

| 日誌／現象 | 判定 |
|---|---|
| `找不到可讀的 DSH 簽名密鑰` | 路徑或權限問題；用 `DSH_CREDENTIALS_FILE` 明確指定 |
| `自簽會話 cookie 被上游拒絕` | `DSH_COOKIE_MAX_AGE_DAYS` 大於 DSH `cookieMaxAgeDays`，或密鑰不屬於該 DSH（多個 DSH_HOME） |
| 仍見 `自動登入失敗 … 重送仍 401` | 密鑰不可用且日誌 token 也是舊的；先解決密鑰 |

---

## 1. 問題現象

瀏覽器開啟 `http://<主機>:3080/`，只得到一行純文字：

```
dsh web authentication required; reopen the URL printed by dsh web.
```

這是 **DSH 自己的 401**，不是代理的 Basic Auth（代理回的是 `401 Unauthorized`），也不是 `/api` 的信任柵欄（那是 403）。

出處：`packages/client/connection/src/browser-auth.ts` 的 `writeUnauthorized()`，只有一個意思：

> 這個 `GET /`（或 `/index.html`）既沒有帶有效的 `?token=`，也沒有帶有效的簽名 cookie。

---

## 2. DSH 的瀏覽器認證模型

| 憑證 | 生命週期 | 說明 |
|---|---|---|
| **launch token** | **每個 process 一顆**，只存在記憶體、不落盤 | 重啟即失效；`dsh web` 啟動時印在 `dsh web: http://127.0.0.1:3079/?token=…` |
| **簽名 cookie** | 綁定 **authority（Host，含 port）**，`Path=/; HttpOnly; SameSite=Strict`，預設 30 天 | 名稱 `dsh-auth-` + `base64url(sha256(authority))` |
| **HMAC 密鑰** | `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` | 容器內 `$DSH_HOME` = `/home/node/.dsh`（執行身分為 `node`） |

三個關鍵規則：

1. 只有 `GET /?token=<當前 process token>` 會把 token 換成 cookie，而且 query 中必須**恰好一個** `token`。
2. `/index.html` 只驗 cookie，**不做 token 交換**。
3. 只有換 cookie 會續期；一般訪問不會。

docker 版的作法：代理把上游 `Host` 改寫成 `127.0.0.1:3079`（`changeOrigin: true`），所以 cookie 的 authority 固定，LAN／反向代理都能用；遇到 401 時由代理去日誌抓 token、自動幫瀏覽器換 cookie。

---

## 3. 本次修改

### 3.1 檔案

| 檔案 | 修改 |
|---|---|
| `proxy/upstream-token.js` | 主要修正（token 快取、重送網址、cookie 屬性、非根入口引導） |
| `proxy/index.js` | 讓 `/index.html` 也走 `serveIndex`（否則第 4 項修正不會生效） |
| `manager/index.js` | admin 變體同上 |

### 3.2 六個修正

| # | 修正 | 對應的失敗情境 |
|---|---|---|
| 1 | token 快取改由**日誌 mtime** 驅動，移除永久 `state.done` | DSH 重啟／admin 版切換版本後，新 token 永遠抓不到，所有沒有 cookie 的瀏覽器卡 401 |
| 2 | 重送時**取代**既有 `token`，不再附加 | 網址殘留舊 `?token=`（書籤、歷史紀錄、貼給同事的連結）時，舊版會組成 `?token=old&token=new`；上游要求恰好一個，因此永遠 401 |
| 3 | 重送仍 401 → `invalidateToken()` 作廢快取 | DSH 已換 token 但日誌尚未刷新時，下一個請求重新掃描，不再永久卡死 |
| 4 | 非 `/` 的首頁入口（`/index.html`、舊深連結）302 導回 `/?token=…`，帶 `__dsh_auth` 標記防重導環 | 上游只認 `GET /` 做交換，`/index.html` 只會得到裸 401 |
| 5 | `Set-Cookie` 的 `SameSite=Strict` 改寫為 `Lax`（可關閉） | 手機主畫面 App、從其他 App／連結跨站開啟時，第一跳不帶 Strict cookie → 401 或重導環（上游 discussion #5362、#9096） |
| 6 | 外部鏈路為 HTTPS 時補 `Secure` | 反向代理終止 TLS 時 cookie 缺少 `Secure`；純 HTTP 內網不補，避免瀏覽器丟棄 cookie |

行為細節：

- 保留原始 query 參數：`/index.html?session=abc` → `/?session=abc&token=…&__dsh_auth=1`。
- `__dsh_auth` 已存在仍 401 時，直接透傳 401，不再重導。
- `Cache-Control` 只在不存在時補 `no-store`，不再重複輸出。
- 新增 `invalidateToken()` 匯出，供管理服務在重啟 DSH 後主動清快取（目前靠 mtime 已可自動恢復，非必要）。

---

## 4. 環境變數

### 4.1 本次新增

| 變數 | 預設 | 功能 | 備註 |
|---|---|---|---|
| `DSH_COOKIE_SAMESITE` | `lax` | `lax`：把上游 `Set-Cookie` 的 `SameSite=Strict` 改寫為 `Lax`；`strict`：保持上游原樣 | 設為 `strict` 後，安裝版 App／跨站開啟的 401 問題會回來 |
| `DSH_COOKIE_SECURE` | `auto` | `auto`：請求帶 `x-forwarded-proto: https` 時補 `Secure`；`always`：一律補；`never`：不補 | 純 HTTP 的 LAN 存取若補 `Secure`，瀏覽器會直接丟棄 cookie |

### 4.2 token 來源（既有）

| 變數 | 預設 | 功能 | 備註 |
|---|---|---|---|
| `DSH_WEB_LOG` | `/app/.dsh-web.log` | 代理用來抓 launch token 的 DSH 日誌路徑 | admin 變體由管理服務寫入同一個檔 |
| `DSH_TOKEN` | 空 | 直接指定 token，**優先於**日誌 | 重啟 DSH 後同樣會失效，需自行更新 |
| `DSH_TOKEN_FILE` | 空 | 從檔案讀 token，優先於日誌、低於 `DSH_TOKEN` | 適合由外部 supervisor 寫入 |
| `DSH_LAUNCH_TOKEN_PATTERN` | 內建 regex | 自訂抓取 token 的正規表示式，捕獲組 1 為 token | 只在日誌格式變動時使用 |
| `DSH_TOKEN_QUERY_KEY` | `token` | 交換用的 query 參數名稱 | 僅供修改過上游的部署使用；官方固定 `token` |
| `DSH_TOKEN_FILE_AUTO` | `/app/.dsh-launch-token` | 抓到 token 後**寫出**的檔案 | **只寫不讀**，供診斷；不是設定來源 |

### 4.3 容器／入口腳本（既有）

| 變數 | 預設 | 功能 |
|---|---|---|
| `DSH_PORT` | `3079` | 容器內 DSH 監聽埠（只綁 `127.0.0.1`） |
| `PROXY_PORT` | `3080` | 代理對外監聽埠 |
| `PROXY_USERNAME` / `PROXY_PASSWORD` | 空 | **兩者都設定**才啟用 HTTP Basic Auth（HTTP 與 WebSocket 都生效） |
| `NPM_CONFIG_REGISTRY` | 官方源 | admin 變體的預設 npm 源 |
| `DSH_INSTALL_DIR` | `/opt/dsh` | admin 變體的 DSH 安裝目錄 |

範例：

```sh
docker run -d --name dsh-harness -p 3080:3080 \
  -v dsh-data:/home/node/.dsh \
  -e PROXY_USERNAME=yourname -e PROXY_PASSWORD=yourpass \
  -e DSH_COOKIE_SAMESITE=lax -e DSH_COOKIE_SECURE=auto \
  --restart unless-stopped smanx/deepseek-harness:latest
```

---

## 5. 可以「關閉」cookie / token 驗證嗎？

### 5.1 上游：沒有這個開關

`packages/client/connection/src/index.ts` 的 `ConnectionConfig` 只有四個欄位：`recovery`、`trustedHosts`、`cookieMaxAgeDays`、`maxRequestBodyBytes`。**沒有** `auth`、`noAuth`、`disableAuth` 之類的選項；`BrowserAuth.create(...)` 是無條件建立的，`authorizeIndex` / `admit` 也無條件驗證。

`--public-url`、`--trusted-host` 只影響「公告的網址」與「Host 柵欄放不放行」，**不會關閉認證**。

### 5.2 這套代理：使用者本來就不需要 token

只要代理的自動交換正常，使用者開 `http://<主機>:3080/` 就會被自動換成 cookie，**不需要看到或貼上任何 token**。本次修正的目的就是把這個自動流程修到不會卡死，而不是關閉驗證。

### 5.3 如果你真的想完全關掉

| 方案 | 做法 | 風險 |
|---|---|---|
| **A. 建議** | 保留 DSH 認證，代理自動交換；前面再加 Basic Auth／SSO／VPN | 無；這已是「使用者無感」的作法 |
| **B. 改 DSH 本體** | 在 image 建置時改 `lib/index.js`，讓 `authorizeIndex`／`isAuthenticated`／`authenticateApi` 直接放行 | **不建議**：等於把可執行工具的完整 Host API 開放給任何能連到 port 的人；每次升級 DSH 都會覆蓋；需同時改 index、`/api`、WebSocket 三處 |
| **C. 代理自簽 cookie（可加）** | 代理讀 `$DSH_HOME/.credentials.yaml` 的簽名密鑰，自行簽發 `v1` cookie | 代理持有簽名密鑰，且依賴上游 cookie 格式；格式改版時需同步。可作為「完全不依賴日誌」的最後手段 |

結論：**沒有可以直接關閉 cookie/token 的官方設定**；日常也不需要關，因為 token 只存在於「代理 ↔ DSH」之間。方案 C 已於 2026-11-11 實作為預設路徑（見 §0），因此連日誌都不再需要讀。

---

## 6. 套用與回滾

```sh
# 套用
cd /path/to/deepseek-harness-docker
git apply /tmp/opencode/deepseek-harness-docker-login-fix.patch

# 重建（代理程式是 COPY 進 image 的）
docker build -t smanx/deepseek-harness:login-fix .
docker rm -f dsh-harness
docker run -d --name dsh-harness -p 3080:3080 \
  -v dsh-data:/home/node/.dsh \
  --restart unless-stopped smanx/deepseek-harness:login-fix

# 回滾
git checkout -- proxy/upstream-token.js proxy/index.js manager/index.js
```

> **資料卷**：目前 Dockerfile 以 `USER node` 執行，`$DSH_HOME` 是 `/home/node/.dsh`。
> README 的 `-v dsh-data:/root/.dsh` **沒有作用**；容器重建會重建 cookie 簽名密鑰，
> 所有既有 session 一次失效（本次修正會自動救回，但每次升級仍會讓所有人重登一次）。

---

## 7. 驗證

已附兩組測試（Bun 執行）：

```sh
cd /tmp/opencode/dsh-proxy-test
bun test.mjs          # 10/10：單元，假上游
bun integration.mjs   #  6/6：整合，實際跑 proxy/index.js + http-proxy
```

上線後在容器內：

```sh
docker exec dsh-harness sh -c '
  T=$(grep -o "token=[A-Za-z0-9_-]*" /app/.dsh-web.log | tail -1 | cut -d= -f2)
  curl -sS -o /dev/null -w "clean /      %{http_code}\n" http://127.0.0.1:3079/
  curl -sS -c /tmp/jar -o /dev/null -w "exchange     %{http_code}\n" "http://127.0.0.1:3079/?token=$T"
  curl -sS -b /tmp/jar -o /dev/null -w "with cookie  %{http_code}\n" http://127.0.0.1:3079/
'
# 期望：401 / 303 / 200
```

代理端（從外部）：

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://<主機>:3080/     # 303
curl -sS -i http://<主機>:3080/ | grep -i set-cookie              # SameSite=Lax
docker logs -f dsh-harness | grep upstream-token                   # 應見「自動登入成功」
```

排錯對照：

| 現象 | 判定 |
|---|---|
| `[upstream-token] 未取得 launch token` | 日誌路徑不對／`/app` 不可寫／`DSH_WEB_LOG` 被改 |
| `自動登入失敗 … 重送仍 401` 連續出現 | 日誌裡的 token 落後於實際 process（等日誌刷新，或 `DSH_TOKEN` 手動指定） |
| 頁面能開、`/api` 全部 403 | 那是 Host 信任柵欄，不是本問題；繞過本代理直連 DSH 時需 `--trusted-host` |
| 只有手機主畫面 App 失敗 | `SameSite=Strict`；確認 `DSH_COOKIE_SAMESITE=lax` 且外層代理有轉發 `Set-Cookie` |

---

## 8. 已知限制

- 依賴「從日誌抓 token」仍是 screen-scraping：日誌被截斷、輪替、或格式改變時會失效（會自動重試並記錄日誌）。**自 2026-11-11 起這只是回退路徑**，預設改用 §0 的自簽 cookie（讀 `.credentials.yaml` 的簽名密鑰）。
- 自簽 cookie 依賴上游的 cookie 格式（`v1.<body>.<hmac>`、名稱 `dsh-auth-<sha256(authority)>`）；DSH 改版時需同步。已核對 0.1.7、0.2.0、0.2.1、0.2.2 格式一致。
- 自簽 cookie 的 authority 綁定代理轉發的 Host（`127.0.0.1:<DSH_PORT>`），因此代理不能再對 DSH 使用不同的 Host 改寫方式。
- 所有完成交換的瀏覽器共用同一組 Host API 權限；人員隔離請靠 Basic Auth／SSO／VPN，並限制 3080 的來源。
- `SameSite=Lax` 是代理層改寫，不是上游修正；上游仍硬編碼 `Strict`（`browser-auth.ts`）。
- 上游建議（可提交 discussion）：新增 `cookieSameSite: 'strict' | 'lax'` 設定，或提供 supervisor 取得當前 process token 的官方管道（例如 `--token-file`），取代日誌抓取。
