// 上游自動授權（前向兼容官方 DSH 的 launch-token 機制）。
//
// 設計目標：token 完全由本鏡像處理，使用者經 Basic Auth（若啟用）通過後，
// 不再需要任何額外動作。
//
// 關鍵點：絕不在每次轉發時注入 token——官方模型是「launch token 換取瀏覽器
// 會話 cookie」，若每請求都帶 token，上游會為每個請求簽發一個全新身份，
// 出現身份錯亂。本模組只在「首頁請求被上游 401 拒絕」時補一次交換。
//
// 相對舊版的修正（皆對應實際踩到的無法登入情境）：
//   1. token 快取改由日誌 mtime 驅動：DSH 重啟（admin 版切版本、手動重啟、
//      崩潰後被宿主拉起）後會產生新 token，舊版永久快取舊值，導致所有沒有
//      cookie 的瀏覽器永遠停在 401。
//   2. 重送時「取代」而非「附加」token：舊版在原始網址已帶 ?token= 時會組成
//      ?token=old&token=new，而上游要求 query 中恰好一個 token，於是永遠 401。
//   3. 重送仍 401 時立刻作廢快取，下一個請求重新掃描日誌。
//   4. 非 '/' 的首頁入口（/index.html、舊深連結）導回 '/' 完成交換，並用
//      __dsh_auth 標記避免重導環；上游只認 GET / 做 token 交換。
//   5. Set-Cookie 的 SameSite=Strict 可改寫為 Lax：安裝版 App／從其他 App
//      開啟時，跨站頂層導航的第一跳不帶 Strict cookie，會造成 401 或重導環
//      （上游 discussion #5362、#9096）。預設 lax，設 strict 可還原。
//   6. 外部鏈路為 HTTPS 時（x-forwarded-proto: https）自動補 Secure，避免
//      cookie 在 HTTPS 下缺少 Secure 而無法長時間保存。
//
// 2026-11 追加（根治「重啟後 / 手動啟動後永遠 401」）：
//   launch token 只存在於 DSH 進程記憶體、只在啟動時印一行，任何「從日誌抓」
//   的方案都會在下列情境失效：DSH 由 docker exec／手動啟動（日誌沒進檔案）、
//   日誌裡的 token 屬於已退出的舊進程、DSH_TOKEN／DSH_TOKEN_FILE 環境變數殘留
//   舊值（硬指定會永久覆蓋日誌打撈）。此時代理拼出的 /?token=… 必然被上游
//   401，而且每個請求都重試無效。
//
//   根治方案：代理直接讀 DSH 落盤的簽名密鑰（$DSH_HOME/.credentials.yaml 的
//   client-connection/browser-session 記錄），自己簽發 v1 會話 cookie，並把它
//   注入每一個轉給上游的請求（HTTP 與 WebSocket）。密鑰是持久化的、跨進程
//   重啟不變，因此完全不依賴 launch token，也不需要日誌。token 打撈保留為
//   讀不到密鑰時的回退路徑。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LOG_FILE = process.env.DSH_WEB_LOG || '/app/.dsh-web.log';
const TOKEN_FILE_AUTO = process.env.DSH_TOKEN_FILE_AUTO || '/app/.dsh-launch-token';
// 官方 DSH 的 launch token 透過首頁 URL 上的 ?token= 傳入，不接受請求頭。
const TOKEN_QUERY_KEY = process.env.DSH_TOKEN_QUERY_KEY || 'token';

const HARD_TOKEN = process.env.DSH_TOKEN || '';
const HARD_TOKEN_FILE = process.env.DSH_TOKEN_FILE || '';

// 非 '/' 入口導回 '/' 的一次性標記；帶了它仍 401 就直接透傳，不再重導。
const AUTH_MARKER = '__dsh_auth';

// cookie 屬性改寫：lax（預設）| strict（保持上游原樣）
const COOKIE_SAMESITE = String(process.env.DSH_COOKIE_SAMESITE || 'lax').toLowerCase();
// Secure 補寫：auto（依 x-forwarded-proto）| always | never
const COOKIE_SECURE = String(process.env.DSH_COOKIE_SECURE || 'auto').toLowerCase();

const MAX_TAIL_BYTES = 512 * 1024;
// 抓不到 token 時，兩次掃描的最小間隔，避免每個 401 都重讀日誌。
const SCAN_MIN_INTERVAL = 1000;

// ── 代理自簽會話 cookie（主要登入路徑，不再依賴 launch token）──────────
// DSH 的 cookie 格式（packages/client/connection/src/browser-auth.ts）：
//   name  = "dsh-auth-" + base64url(sha256(authority))
//   value = "v1." + base64url(JSON{version,authority,issuedAt,expiresAt})
//           + "." + base64url(HMAC-SHA256(secret, body))
// secret 保存在 $DSH_HOME/.credentials.yaml 的 client-connection/browser-session
// 記錄（kind: grant, payload: {version: 1, secret: <base64url 32 bytes>}）。
const COOKIE_PREFIX = 'dsh-auth-';
const COOKIE_PAYLOAD_VERSION = 1;
const CREDENTIALS_FILE = process.env.DSH_CREDENTIALS_FILE || '';
const SESSION_MAX_AGE_DAYS = (() => {
  const n = Number(process.env.DSH_COOKIE_MAX_AGE_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
})();
const DAY_MS = 24 * 60 * 60 * 1000;

let PATTERN = null;
if (process.env.DSH_LAUNCH_TOKEN_PATTERN) {
  try { PATTERN = new RegExp(process.env.DSH_LAUNCH_TOKEN_PATTERN); } catch {}
}
const DEFAULT_TOKEN_RE = /(?:[?&,]|^)token[=:]\s*["']?([A-Za-z0-9._~-]{16,})/i;

// mtimeMs = -1 表示「尚未同步過」，第一次呼叫一定重掃。
let state = { token: '', source: null, mtimeMs: -1, lastScanAt: 0 };

function readTail(p, maxBytes) {
  try {
    const st = fs.statSync(p);
    if (!st.size) return '';
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

// 返回文本中 regex 的【最後一個】匹配（日誌裡可能有多次啟動打印的舊 token，
// 越新的打印越靠後，取最後一個即當前最新 token），無匹配返回 null。
function lastMatch(text, regex) {
  let re;
  try {
    re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  } catch {
    return null;
  }
  let last = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    last = m;
    if (m[0] === '') re.lastIndex += 1;
  }
  return last;
}

// token 去敏：僅保留頭尾 4 個字符，中間用 * 填充，便於日誌排查又不泄露完整 token
function maskToken(t) {
  const s = String(t || '');
  if (s.length <= 8) return s ? s.slice(0, 1) + '****' : '(empty)';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

// 從日誌文本中提取最新（末尾）的 launch token
function extractFromText(text) {
  if (PATTERN) {
    const m = lastMatch(text, PATTERN);
    if (m) return (m[1] !== undefined ? m[1] : m[0]).trim();
  }
  const m = lastMatch(text, DEFAULT_TOKEN_RE);
  return m ? m[1] : null;
}

// 打撈一次：讀 DSH 日誌尾部提取 token，命中則落盤到 TOKEN_FILE_AUTO
function scanOnce() {
  state.lastScanAt = Date.now();
  const token = extractFromText(readTail(LOG_FILE, MAX_TAIL_BYTES));
  if (!token) return '';
  const t = token.trim();
  try { fs.writeFileSync(TOKEN_FILE_AUTO, t); } catch {}
  if (t !== state.token) {
    console.log(`[upstream-token] 已捕獲 DSH launch token（${maskToken(t)}，長度 ${t.length}），僅用於換取會話`);
  }
  state.token = t;
  state.source = 'auto';
  return t;
}

function readHardToken() {
  if (HARD_TOKEN) return HARD_TOKEN;
  if (HARD_TOKEN_FILE) {
    try { return fs.readFileSync(HARD_TOKEN_FILE, 'utf8').trim(); } catch {}
  }
  return '';
}

// 確保已拿到「當前 process」的 token：優先手工，其次依日誌 mtime 自動打撈。
// 日誌一旦有更新（DSH 重啟）就立即重掃，不再永久快取第一次抓到的值。
function ensureToken(force = false) {
  const hard = readHardToken();
  if (hard) {
    state.token = hard;
    state.source = 'manual';
    return hard;
  }

  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(LOG_FILE).mtimeMs; } catch {}

  const changed = mtimeMs !== state.mtimeMs;
  const now = Date.now();
  // 日誌一變就重掃；沒有可用 token 時才套用最小間隔，避免每個請求都讀日誌尾段。
  const due = force || changed
    || (state.token === '' && now - state.lastScanAt >= SCAN_MIN_INTERVAL);

  if (due) {
    state.mtimeMs = mtimeMs;
    const scanned = scanOnce();
    if (scanned) return scanned;
    // 掃不到時保留舊 token 當備援；下一個請求（1 秒後或日誌再變）會重試。
  }
  return state.token;
}

// 作廢快取：token 被上游拒絕（DSH 重啟但日誌尚未刷新）時呼叫。
function invalidateToken() {
  state.token = '';
  state.mtimeMs = -1;
  state.lastScanAt = 0;
}

// ── 簽名密鑰：候選路徑與解析 ─────────────────────────────────────────
// 依序嘗試：顯式 DSH_CREDENTIALS_FILE → $DSH_HOME → 目前使用者家目錄 →
// 映像內常見的 /home/node/.dsh、/root/.dsh（README 舊寫法）。
function credentialCandidates() {
  const list = [];
  if (CREDENTIALS_FILE) list.push(CREDENTIALS_FILE);
  const homes = [];
  if (process.env.DSH_HOME) homes.push(process.env.DSH_HOME);
  try { homes.push(path.join(os.homedir(), '.dsh')); } catch {}
  homes.push('/home/node/.dsh', '/root/.dsh');
  for (const home of homes) if (home) list.push(path.join(home, '.credentials.yaml'));
  return [...new Set(list)];
}

function base64Url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 從 YAML 文本中取出 browser-session 記錄的 secret（不引入 yaml 相依）。
// 只認 `client-connection/browser-session:` 區塊，避免誤抓 refs 或其他記錄；
// 值必須是 32 bytes 的 base64url（43 字元）。
function extractSecret(text) {
  const lines = String(text).split(/\r?\n/);
  const RECORD_KEY = /^[ \t]*(['"]?)client-connection\/browser-session\1[ \t]*:(?:[ \t]|$)/;
  let recordIndent = -1;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.match(/^[ \t]*/)[0].length;
    if (recordIndent !== -1 && indent <= recordIndent) recordIndent = -1;
    if (recordIndent === -1) {
      if (RECORD_KEY.test(line)) recordIndent = indent;
      continue;
    }
    const secret = /^[ \t]+secret[ \t]*:[ \t]*(.+?)[ \t]*$/.exec(line);
    if (!secret) continue;
    let value = secret[1];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  }
  return null;
}

// 每個候選檔案的快取：mtime/size 一變就重讀。這裡刻意不做「N 秒 TTL」——
// 密鑰輪替（資料卷重建、刪除後重建）時，下一個請求就要立刻用新密鑰，
// 否則會出現短暫 401。stat 的成本遠低於一次反向代理。
const secretFiles = new Map(); // file -> { mtimeMs, size, secret }
let secretLogState = { path: null, warnedAt: 0 };

// 讀取所有可用密鑰（依檔案 mtime 新→舊排序）。
function readSecrets() {
  const now = Date.now();
  const entries = [];
  for (const file of credentialCandidates()) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      secretFiles.delete(file);
      continue;
    }
    const cached = secretFiles.get(file);
    let secret;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      secret = cached.secret;
    } else {
      try {
        secret = extractSecret(fs.readFileSync(file, 'utf8'));
      } catch {
        secret = null;
      }
      secretFiles.set(file, { mtimeMs: st.mtimeMs, size: st.size, secret });
      if (secret) {
        console.log(`[upstream-token] 讀取 DSH 簽名密鑰（${file}）：使用代理自簽會話 cookie${cached && cached.secret && cached.secret !== secret ? '（密鑰已輪替，重新簽發）' : ''}`);
      }
    }
    if (secret) entries.push({ file, mtimeMs: st.mtimeMs, secret });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const first = entries[0];
  if (first && first.file !== secretLogState.path) {
    secretLogState.path = first.file;
  } else if (!first) {
    secretLogState.path = null;
    // 讀不到密鑰就只能回退 launch token；每分鐘提示一次，方便排查掛載/權限問題。
    if (now - secretLogState.warnedAt > 60000) {
      secretLogState.warnedAt = now;
      console.warn(`[upstream-token] 找不到可讀的 DSH 簽名密鑰（候選：${credentialCandidates().join(', ')}）；改用 launch token 回退路徑`);
    }
  }
  return entries;
}

// 由密鑰簽出一個 v1 會話 cookie；authority 必須與上游看到的 Host 完全一致
// （代理以 changeOrigin 轉發，因此固定是 127.0.0.1:<DSH_PORT>）。
function signSessionCookie(authority, secretB64) {
  const secret = Buffer.from(secretB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (secret.length !== 32) return null;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + SESSION_MAX_AGE_DAYS * DAY_MS;
  const body = base64Url(Buffer.from(JSON.stringify({
    version: COOKIE_PAYLOAD_VERSION,
    authority,
    issuedAt,
    expiresAt,
  }), 'utf8'));
  const signature = base64Url(crypto.createHmac('sha256', secret).update(body).digest());
  return {
    name: COOKIE_PREFIX + base64Url(crypto.createHash('sha256').update(authority).digest()),
    value: `v${COOKIE_PAYLOAD_VERSION}.${body}.${signature}`,
    expiresAt,
    maxAge: SESSION_MAX_AGE_DAYS * 24 * 60 * 60,
  };
}

// 目前可用的所有會話 cookie（不同 DSH_HOME 可能各有一把密鑰）。
function sessionCookies(authority) {
  const out = [];
  const seen = new Set();
  for (const entry of readSecrets()) {
    if (seen.has(entry.secret)) continue;
    seen.add(entry.secret);
    const cookie = signSessionCookie(authority, entry.secret);
    if (cookie) out.push(cookie);
  }
  return out;
}

// 用代理簽發的 cookie 取代瀏覽器帶來的同名 cookie（上游只看第一個同名值），
// 其餘 cookie 原樣保留。
function mergeCookieHeader(rawHeader, cookie) {
  const kept = String(rawHeader || '')
    .split(';')
    .map((segment) => segment.trim())
    .filter((segment) => {
      if (!segment) return false;
      const at = segment.indexOf('=');
      return at === -1 || segment.slice(0, at).trim() !== cookie.name;
    });
  kept.push(`${cookie.name}=${cookie.value}`);
  return kept.join('; ');
}

// 注入上游請求：HTTP 與 WebSocket 都靠這一步通過 DSH 的 cookie 驗證。
function applyUpstreamAuth(req, authority) {
  if (!req || !req.headers) return false;
  const cookies = sessionCookies(authority);
  if (!cookies.length) return false;
  req.headers.cookie = mergeCookieHeader(req.headers.cookie, cookies[0]);
  return true;
}

// 給瀏覽器的 Set-Cookie（讓瀏覽器也持有有效會話；代理仍會逐請求注入）。
function formatSetCookie(cookie, secure) {
  const sameSite = COOKIE_SAMESITE === 'strict' ? 'Strict' : 'Lax';
  let out = `${cookie.name}=${cookie.value}; Max-Age=${cookie.maxAge}; Path=/; `
    + `Expires=${new Date(cookie.expiresAt).toUTCString()}; HttpOnly; SameSite=${sameSite}`;
  if (secure) out += '; Secure';
  return out;
}

// 版本探測：供診斷與後續按版本細化判斷；一般不需要
const VERSION_PATHS = [
  process.env.DSH_VERSION,
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
  '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/package.json',
];
function detectDshVersion() {
  for (const p of VERSION_PATHS) {
    if (!p) continue;
    if (String(p).includes('package.json')) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')).version || null; } catch {}
    } else {
      return p;
    }
  }
  return null;
}

// ── 根目錄授權引導（401 → 帶 token 重發 → 透傳 set-cookie）─────────
const FORWARD_HEADERS = [
  'accept', 'accept-language', 'user-agent', 'cookie', 'referer',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
];
function pickIndexHeaders(req, dropCookie) {
  const src = req.headers || {};
  const out = { accept: '*/*', 'accept-encoding': 'identity' };
  for (let i = 0; i < FORWARD_HEADERS.length; i++) {
    const n = FORWARD_HEADERS[i];
    // token 交換 = 換取全新會話；瀏覽器若帶舊 cookie（過期/無效會話），
    // 上游會因 cookie 校驗失敗直接 401，導致重發永遠失敗。因此重發時剝離。
    if (dropCookie && n === 'cookie') continue;
    if (src[n]) out[n] = src[n];
  }
  return out;
}

// Node 18 的 fetch 沒有 getSetCookie；退回讀單一 set-cookie 字串。
// （Node 24 / Bun 都走 getSetCookie，多個 cookie 不會被合併。）
function readSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') {
    const list = headers.getSetCookie();
    if (Array.isArray(list) && list.length) return list;
  }
  const raw = headers.get('set-cookie');
  return raw ? [raw] : [];
}

async function fetchRaw(origin, headers, path) {
  const url = path && path !== '/' ? origin + path : origin + '/';
  const res = await fetch(url, { method: 'GET', headers, redirect: 'manual' });
  return {
    status: res.status,
    headers: res.headers,
    setCookies: readSetCookies(res.headers),
    body: await res.text(),
  };
}

// 把 HTML 內容注入一段腳本，插入到第一個 <head> 之後（無則插到最前）。
function injectIntoHead(content, snippet) {
  const i = content.toLowerCase().indexOf('<head');
  if (i !== -1) {
    const e = content.indexOf('>', i);
    return e !== -1 ? content.slice(0, e + 1) + snippet + content.slice(e + 1) : snippet + content;
  }
  return snippet + content;
}

// 外部鏈路是否為 HTTPS：只信任反向代理明確帶上的 x-forwarded-proto。
function isSecureRequest(req) {
  if (COOKIE_SECURE === 'always') return true;
  if (COOKIE_SECURE === 'never') return false;
  const raw = (req.headers && req.headers['x-forwarded-proto']) || '';
  return String(raw).split(',')[0].trim().toLowerCase() === 'https';
}

function rewriteSetCookies(cookies, secure) {
  return cookies.map((cookie) => {
    let out = cookie;
    if (COOKIE_SAMESITE === 'lax') out = out.replace(/SameSite=Strict/gi, 'SameSite=Lax');
    if (secure && !/;\s*Secure\b/i.test(out)) out += '; Secure';
    return out;
  });
}

// 把上游響應整體透傳給瀏覽器（保留 set-cookie 供瀏覽器建立會話；對 html 做注入改寫）。
// extraCookies 是代理自己簽發的會話 cookie（字符串形式），追加在透傳的 Set-Cookie 之後。
function sendRaw(r, res, transformHtml, secure, extraCookies) {
  const hs = {};
  let hasCacheControl = false;
  for (const [k, v] of r.headers) {
    const lk = k.toLowerCase();
    if (lk === 'cache-control') hasCacheControl = true;
    if (['content-length', 'content-encoding', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'set-cookie'].includes(lk)) continue;
    hs[k] = v;
  }
  if (!hasCacheControl) hs['Cache-Control'] = 'no-store';
  const cookies = rewriteSetCookies(r.setCookies, !!secure);
  if (extraCookies && extraCookies.length) cookies.push(...extraCookies);
  if (cookies.length) hs['Set-Cookie'] = cookies;

  let body = r.body;
  const ct = String(r.headers.get ? r.headers.get('content-type') : '').toLowerCase();
  if (ct.includes('text/html') && transformHtml) body = transformHtml(body);
  // 3xx/空 body 的響應（如 303 重定向）不設 Content-Type，避免誤導瀏覽器按 HTML 處理
  if (body && body.length) {
    hs['Content-Type'] = ct || 'text/html; charset=utf-8';
  }

  res.writeHead(r.status, hs);
  res.end(body);
  return true;
}

// 重送用的網址：移除所有既有 token，再放入恰好一個當前 token。
// 舊版用「附加」的方式，會產生 ?token=old&token=new，上游要求 tokens.length === 1，
// 因此永遠 401——這是書籤／歷史紀錄殘留舊 token 時無法登入的直接原因。
function buildAuthUrl(reqUrl, origin, token) {
  const url = new URL(reqUrl, origin);
  url.searchParams.delete(TOKEN_QUERY_KEY);
  url.searchParams.set(TOKEN_QUERY_KEY, token);
  return `${url.pathname}${url.search}`;
}

// 是否為「文件導航」：/index.html 或瀏覽器要求 HTML 時才導回 '/'。
function wantsDocument(req, url) {
  if (/\.html?$/i.test(url.pathname)) return true;
  const accept = String((req.headers && req.headers.accept) || '');
  return accept.includes('text/html') || accept === '' || accept === '*/*';
}

// 處理首頁 GET：優先帶上代理自簽的會話 cookie（不用 token、不受重啟影響）；
// 若密鑰不可用，回退到「帶 launch token 重送」的老路徑。
// 返回 true 表示已接管響應；返回 false 表示出現異常，呼叫方應回退到普通反向代理。
async function serveIndex(req, res, ctx) {
  const origin = ctx.origin;
  const transformHtml = ctx.transformHtml;
  const secure = isSecureRequest(req);
  const authority = ctx.authority || new URL(origin).host;
  const session = sessionCookies(authority);
  const reqUrl = req.url || '/';
  let url;
  try {
    url = new URL(reqUrl, origin);
  } catch {
    url = new URL('/', origin);
  }

  // 首次請求：帶上代理自簽 cookie（呼叫方通常已注入，這裡再保證一次，
  // 讓 serveIndex 單獨被呼叫時也成立）。
  const firstHeaders = pickIndexHeaders(req);
  if (session.length) firstHeaders.cookie = mergeCookieHeader(req.headers.cookie, session[0]);

  let first;
  try {
    first = await fetchRaw(origin, firstHeaders, `${url.pathname}${url.search}`);
  } catch {
    return false;
  }

  if (first.status !== 401) {
    if (first.status !== 200) {
      console.log(`[upstream-token] ${url.pathname} 首次請求返回 ${first.status}（非 401），直接透傳`);
    }
    return sendRaw(first, res, transformHtml, secure,
      session.length ? [formatSetCookie(session[0], secure)] : []);
  }

  // 其他候選密鑰（不同 DSH_HOME）：逐一嘗試，全部失敗才回退 launch token。
  for (let i = 1; i < session.length; i++) {
    let retry = null;
    try {
      const headers = pickIndexHeaders(req);
      headers.cookie = mergeCookieHeader(req.headers.cookie, session[i]);
      retry = await fetchRaw(origin, headers, `${url.pathname}${url.search}`);
    } catch {
      retry = null;
    }
    if (retry && retry.status !== 401) {
      console.log(`[upstream-token] 改用另一把簽名密鑰的會話 cookie 成功（${url.pathname}）`);
      return sendRaw(retry, res, transformHtml, secure, [formatSetCookie(session[i], secure)]);
    }
  }

  if (session.length) {
    console.log(`[upstream-token] 自簽會話 cookie 被上游拒絕（${url.pathname}），回退 launch token`);
  }

  const token = ensureToken();

  // 非 '/' 的首頁入口（/index.html、舊深連結）：上游只認 GET / 做 token 交換，
  // 因此導回 '/' 完成交換；帶 __dsh_auth 標記，避免交換失敗時無限重導。
  if (url.pathname !== '/' && !url.searchParams.has(AUTH_MARKER) && wantsDocument(req, url)) {
    if (!token) {
      console.log('[upstream-token] 未取得 launch token，無法引導非根入口，透傳 401');
      return sendRaw(first, res, transformHtml, secure);
    }
    const target = new URL('/', origin);
    for (const [key, value] of url.searchParams) {
      if (key === TOKEN_QUERY_KEY || key === AUTH_MARKER) continue;
      target.searchParams.append(key, value);
    }
    target.searchParams.set(TOKEN_QUERY_KEY, token);
    target.searchParams.set(AUTH_MARKER, '1');
    console.log(`[upstream-token] ${url.pathname} 需要授權，導向 / 換取會話（token ${maskToken(token)}）`);
    res.writeHead(302, {
      'cache-control': 'no-store',
      location: `${target.pathname}${target.search}`,
      'referrer-policy': 'no-referrer',
    });
    res.end();
    return true;
  }

  if (!token) {
    console.log('[upstream-token] 未取得 launch token，透傳上游 401');
    return sendRaw(first, res, transformHtml, secure);
  }

  const authUrl = buildAuthUrl(reqUrl, origin, token);
  console.log(`[upstream-token] 上游 401，攜帶 launch token（${maskToken(token)}）重送 ${url.pathname}`);

  let retry = null;
  // 重發是「換取全新會話」，必須剝離瀏覽器舊 cookie，否則上游可能因無效 cookie 直接 401
  try { retry = await fetchRaw(origin, pickIndexHeaders(req, true), authUrl); } catch { retry = null; }
  if (retry === null) {
    console.log('[upstream-token] 攜帶 token 重送失敗（網路異常或上游無回應），透傳首次 401');
    return sendRaw(first, res, transformHtml, secure);
  }

  if (retry.status === 401) {
    // token 已失效（多半是 DSH 已重啟但本模組仍握著舊值）：立刻作廢快取，
    // 下一個請求會依日誌 mtime 重新掃描，而不是永遠卡在 401。
    invalidateToken();
    console.log(`[upstream-token] 自動登入失敗：token（${maskToken(token)}）重送仍 401，已作廢快取待下次重掃`);
    return sendRaw(retry, res, transformHtml, secure);
  }

  const cookies = retry.setCookies.length;
  if (retry.status >= 300 && retry.status < 400) {
    const loc = String(retry.headers.get ? retry.headers.get('location') : retry.headers.location || '');
    console.log(`[upstream-token] 自動登入成功：上游 ${retry.status} 重定向到「${loc || '/'}」，下發 ${cookies} 個會話 cookie`);
  }
  return sendRaw(retry, res, transformHtml, secure);
}

module.exports = {
  serveIndex, ensureToken, invalidateToken, injectIntoHead, detectDshVersion,
  applyUpstreamAuth, sessionCookies, extractSecret,
};
