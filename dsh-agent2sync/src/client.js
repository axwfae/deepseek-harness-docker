/**
 * dsh-agent2sync（显示名 Agent2Sync）— browser half
 * 手写的 ModuleLoader bundle，无构建步骤。
 *
 * 在「插件」页挂一张 Agent2Sync 卡片，提供三件事：
 *   1. 服务器设置（网关地址）
 *   2. API Key 设置（写入 DSH 凭据，草稿不回显已存的值）
 *   3. 模型供应商名称设置（与已有提供商重名时直接拒绝保存）
 * 以及一个「同步模型列表」按钮。
 *
 * 手写 bundle 的硬规矩（对照 dsh-agent-lang 的既有实践）：
 *   - 只有一次 `window.__ModuleLoader__.load({...})`，id 必须等于包名；
 *   - `require` 只允许客户端模块的基线白名单，实际只有 react；
 *   - 只用 React.createElement，不写 JSX/TS；
 *   - 组件定义在模块顶层，父级重渲染不会把卡片重挂；
 *   - `dsh.client.inject` 里列出必须先加载的包，否则 apply 时槽位还不存在。
 */
window.__ModuleLoader__.load({
	id: "dsh-agent2sync",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var E = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useCallback = React.useCallback;

		var TAG = "[dsh-agent2sync]";
		/** 与 Host 侧 cordis.patch.yml 里的 routePath 默认值保持一致。 */
		var SYNC_PATH = "/agent2sync/sync";
		/** 卡片在 plugins.bundle.config 槽位里的 key：用包名，不是 Loader 条目 id。 */
		var SLOT_KEY = "dsh-agent2sync";
		/** 供应商名称的合法形状，与 Host 侧保持同一套规则。 */
		var PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

		var STYLE = [
			".a2s-card{display:flex;flex-direction:column;gap:12px;}",
			".a2s-title{font-size:14px;font-weight:600;line-height:1.3;}",
			".a2s-desc{font-size:12px;opacity:.65;line-height:1.5;}",
			".a2s-field{display:flex;flex-direction:column;gap:5px;}",
			".a2s-label{font-size:12px;opacity:.72;}",
			".a2s-input{box-sizing:border-box;width:100%;font-size:12px;line-height:1.4;padding:7px 9px;",
			"border:1px solid var(--dsh-border,#3a3a3a);border-radius:6px;background:transparent;color:inherit;",
			"font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}",
			".a2s-input:focus{outline:none;border-color:var(--dsh-accent,#4d7cfe);}",
			".a2s-input.bad{border-color:#e5484d;}",
			".a2s-hint{font-size:11px;line-height:1.5;opacity:.6;}",
			".a2s-hint.bad{color:#e5484d;opacity:1;}",
			".a2s-hint.good{color:#30a46c;opacity:1;}",
			".a2s-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}",
			".a2s-btn{appearance:none;border:1px solid var(--dsh-border,#3a3a3a);background:var(--dsh-bg-secondary,transparent);",
			"color:inherit;font-size:12px;font-weight:500;line-height:1;padding:7px 12px;border-radius:6px;cursor:pointer;}",
			".a2s-btn.primary{border-color:var(--dsh-accent,#4d7cfe);}",
			".a2s-btn:hover:not(:disabled){border-color:var(--dsh-accent,#4d7cfe);}",
			".a2s-btn:disabled{opacity:.45;cursor:default;}",
			".a2s-note{font-size:12px;line-height:1.5;}",
			".a2s-err{color:#e5484d;}",
			".a2s-ok{color:#30a46c;}",
			".a2s-tags{display:flex;flex-wrap:wrap;gap:4px;}",
			".a2s-tag{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1;",
			"padding:4px 6px;border-radius:4px;border:1px solid var(--dsh-border,#3a3a3a);}",
			".a2s-tag.add{border-color:#30a46c66;color:#30a46c;}",
			".a2s-tag.del{border-color:#e5484d66;color:#e5484d;}",
			".a2s-div{height:1px;background:var(--dsh-border,#3a3a3a);opacity:.5;}",
		].join("");

		/** 样式只注入一次；热重载后旧的会被移除，避免越堆越多。 */
		function ensureStyles() {
			var existing = document.querySelector('style[data-plugin="dsh-agent2sync"]');
			if (existing !== null) existing.remove();
			var style = document.createElement("style");
			style.dataset.plugin = "dsh-agent2sync";
			style.textContent = STYLE;
			document.head.appendChild(style);
			return function () {
				try { style.remove(); } catch (error) { /* 尽力而为 */ }
			};
		}

		/** 解析 Host 的 JSON 应答，把字段级错误也带出来。 */
		function readJson(response) {
			return response.json().then(function (body) {
				if (!response.ok || body === null || body.ok === false) {
					var failure = new Error(body && body.error ? body.error : "HTTP " + response.status);
					if (body && typeof body.field === "string") failure.field = body.field;
					throw failure;
				}
				return body;
			});
		}

		/** 供应商名称是否已被列表里的其他提供商占用。 */
		function isTaken(providers, selfId, candidate) {
			if (!Array.isArray(providers) || candidate.length === 0) return false;
			for (var i = 0; i < providers.length; i += 1) {
				if (providers[i] === candidate && providers[i] !== selfId) return true;
			}
			return false;
		}

		/**
		 * 卡片正文。
		 * @param props - 槽位 inject 工厂返回的成员（routePath）。
		 */
		function Agent2SyncCard(props) {
			var path = props && typeof props.routePath === "string" && props.routePath.length > 0
				? props.routePath
				: SYNC_PATH;

			var busyState = useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];

			var statusState = useState(null);
			var status = statusState[0];
			var setStatus = statusState[1];

			var resultState = useState(null);
			var result = resultState[0];
			var setResult = resultState[1];

			var errorState = useState(null);
			var error = errorState[0];
			var setError = errorState[1];

			var reloadState = useState(0);
			var reload = reloadState[0];
			var setReload = reloadState[1];

			var baseDraftState = useState("");
			var baseDraft = baseDraftState[0];
			var setBaseDraft = baseDraftState[1];

			var providerDraftState = useState("");
			var providerDraft = providerDraftState[0];
			var setProviderDraft = providerDraftState[1];

			var keyDraftState = useState("");
			var keyDraft = keyDraftState[0];
			var setKeyDraft = keyDraftState[1];

			var savingState = useState(false);
			var saving = savingState[0];
			var setSaving = savingState[1];

			var fieldErrorState = useState(null);
			var fieldError = fieldErrorState[0];
			var setFieldError = fieldErrorState[1];

			// 卡片挂载 / 每次同步成功后，读一次 Host 侧状态。
			useEffect(function () {
				var alive = true;
				fetch(path + "?settings=1", { headers: { accept: "application/json" } })
					.then(readJson)
					.then(function (body) {
						if (!alive) return;
						setStatus(body);
						// 首次拿到状态时把输入框填成当前值；之后用户的编辑不被覆盖。
						setBaseDraft(function (current) { return current === "" ? body.baseURL : current; });
						setProviderDraft(function (current) { return current === "" ? body.providerId : current; });
					})
					.catch(function (failure) {
						if (alive) setError(failure && failure.message ? failure.message : String(failure));
					});
				return function () { alive = false; };
			}, [path, reload]);

			var runSync = useCallback(function () {
				setBusy(true);
				setError(null);
				fetch(path, { method: "POST", headers: { accept: "application/json" } })
					.then(readJson)
					.then(function (body) {
						setResult(body);
						setReload(function (value) { return value + 1; });
					})
					.catch(function (failure) {
						setError(failure && failure.message ? failure.message : String(failure));
					})
					.then(function () { setBusy(false); });
			}, [path]);

			var saveSettings = useCallback(function () {
				var nextBase = baseDraft.trim();
				var nextProvider = providerDraft.trim();
				var payload = { baseURL: nextBase, providerId: nextProvider };
				// 留空表示「不修改已保存的 Key」；填了才覆盖。
				if (keyDraft !== "") payload.apiKey = keyDraft;

				setSaving(true);
				setError(null);
				setFieldError(null);
				fetch(path + "?settings=1", {
					method: "POST",
					headers: { accept: "application/json", "content-type": "application/json" },
					body: JSON.stringify(payload),
				})
					.then(readJson)
					.then(function (body) {
						setStatus(body);
						setBaseDraft(body.baseURL);
						setProviderDraft(body.providerId);
						setKeyDraft("");
						if (body.sync) setResult(body.sync);
						if (body.syncError) setError("设置已保存，但重新同步失败：" + body.syncError);
						else if (body.renamed) setError(null);
					})
					.catch(function (failure) {
						if (failure && failure.field) setFieldError({ field: failure.field, message: failure.message });
						else setError(failure && failure.message ? failure.message : String(failure));
					})
					.then(function () { setSaving(false); });
			}, [path, baseDraft, providerDraft, keyDraft]);

			var providers = status !== null && Array.isArray(status.providers) ? status.providers : [];
			var selfId = status !== null ? status.providerId : "";
			var providerValue = providerDraft !== "" ? providerDraft : selfId;
			var providerTaken = isTaken(providers, selfId, providerValue);
			var providerShapeBad = providerValue.length > 0 && !PROVIDER_ID_PATTERN.test(providerValue);
			var providerBad = providerTaken || providerShapeBad;
			var baseValue = baseDraft !== "" ? baseDraft : (status !== null ? status.baseURL : "");
			var baseEmpty = baseValue.length === 0;
			var baseBad = !baseEmpty && !/^https?:\/\//i.test(baseValue);
			var canSave = !saving && !providerBad && !baseBad && providerValue.length > 0 && baseValue.length > 0;

			var rows = [];

			rows.push(E("div", { key: "head" },
				E("div", { className: "a2s-title" }, "Agent2Sync"),
				E("div", { className: "a2s-desc" },
					"把 Agent2API 网关的模型目录同步成 DSH 里的一个模型提供商。"
					+ "服务端消失的模型会一并删除，新出现的模型自动加入。",
				),
			));

			// ── 服务器设置 ─────────────────────────────────────────────
			rows.push(E("div", { className: "a2s-field", key: "f-base" },
				E("label", { className: "a2s-label" }, "服务器"),
				E("input", {
					className: baseBad ? "a2s-input bad" : "a2s-input",
					type: "text",
					value: baseValue,
					spellCheck: false,
					placeholder: "http://<网关主机>:3065/v1",
					onChange: function (event) { setBaseDraft(event.target.value); },
				}),
				baseBad
					? E("div", { className: "a2s-hint bad" }, "地址需要以 http:// 或 https:// 开头")
					: baseEmpty
						? E("div", { className: "a2s-hint" },
							"必填：填写 Agent2API 网关地址（不含尾部 /models）",
						)
						: E("div", { className: "a2s-hint" }, "Agent2API 的 OpenAI 兼容端点，不含尾部 /models"),
			));

			// ── API Key 设置 ───────────────────────────────────────────
			var keyHint;
			if (fieldError !== null && fieldError.field === "apiKey") {
				keyHint = E("div", { className: "a2s-hint bad" }, fieldError.message);
			} else if (status !== null && status.hasApiKey) {
				keyHint = E("div", { className: "a2s-hint good" },
					"已保存网关 Key（" + status.apiKeyEnv + "）。留空则不修改。",
				);
			} else {
				keyHint = E("div", { className: "a2s-hint bad" },
					"尚未配置网关 Key：模型列表能同步，但对话请求会被网关拒绝。",
				);
			}
			rows.push(E("div", { className: "a2s-field", key: "f-key" },
				E("label", { className: "a2s-label" }, "API Key"),
				E("input", {
					className: "a2s-input",
					type: "password",
					value: keyDraft,
					spellCheck: false,
					autoComplete: "off",
					placeholder: status !== null && status.hasApiKey ? "已保存，留空不修改" : "粘贴 Agent2API 的网关 Key",
					onChange: function (event) { setKeyDraft(event.target.value); },
				}),
				keyHint,
			));

			// ── 供应商名称设置 ─────────────────────────────────────────
			var providerHint;
			if (fieldError !== null && fieldError.field === "providerId") {
				providerHint = E("div", { className: "a2s-hint bad" }, fieldError.message);
			} else if (providerTaken) {
				providerHint = E("div", { className: "a2s-hint bad" },
					"\"" + providerValue + "\" 已被现有提供商占用，换一个名字才能保存。",
				);
			} else if (providerShapeBad) {
				providerHint = E("div", { className: "a2s-hint bad" },
					"只能用小写字母、数字、点、下划线和连字符，且以字母或数字开头。",
				);
			} else {
				providerHint = E("div", { className: "a2s-hint" },
					"模型选择器里这个提供商的名字。已有提供商：" + (providers.length > 0 ? providers.join("、") : "（无）"),
				);
			}
			rows.push(E("div", { className: "a2s-field", key: "f-provider" },
				E("label", { className: "a2s-label" }, "模型供应商名称"),
				E("input", {
					className: providerBad ? "a2s-input bad" : "a2s-input",
					type: "text",
					value: providerValue,
					spellCheck: false,
					placeholder: "agent2sync",
					onChange: function (event) { setProviderDraft(event.target.value); },
				}),
				providerHint,
			));

			rows.push(E("div", { className: "a2s-actions", key: "actions" },
				E("button", {
					type: "button",
					className: "a2s-btn primary",
					onClick: saveSettings,
					disabled: !canSave,
				}, saving ? "保存中…" : "保存设置"),
				E("button", {
					type: "button",
					className: "a2s-btn",
					onClick: runSync,
					disabled: busy,
				}, busy ? "同步中…" : "同步模型列表"),
				status !== null
					? E("span", { className: "a2s-hint" }, "当前 " + status.modelCount + " 个模型")
					: null,
			));

			// ── 同步结果 ───────────────────────────────────────────────
			if (result !== null) {
				var line = "已同步 " + result.total + " 个模型（网关报告 " + result.fetched + " 个"
					+ (result.excluded > 0 ? "，排除 " + result.excluded + " 个非对话模型" : "")
					+ "），用时 " + result.durationMs + " ms。";
				var tags = [];
				(result.added || []).forEach(function (id) {
					tags.push(E("span", { className: "a2s-tag add", key: "a" + id }, "+" + id));
				});
				(result.removed || []).forEach(function (id) {
					tags.push(E("span", { className: "a2s-tag del", key: "r" + id }, "−" + id));
				});
				rows.push(E("div", { key: "result" },
					E("div", { className: "a2s-note a2s-ok" }, line),
					tags.length > 0 ? E("div", { className: "a2s-tags" }, tags) : null,
				));
			}

			if (error !== null) {
				rows.push(E("div", { className: "a2s-note a2s-err", key: "error" }, "失败：" + error));
			}

			return E("div", { className: "a2s-card" }, rows);
		}

		/** 卡片外壳：插件页每一行都长这样。 */
		function CardShell(props) {
			return E("div", { className: "a2s-card" },
				E(Agent2SyncCard, props),
			);
		}

		/** 单个插槽出错不应该把整个插件 fiber 一起拖垮。 */
		class QuietBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(error) {
				console.warn(TAG + " 卡片渲染失败:", error && error.message ? error.message : error);
			}
			render() {
				if (this.state.failed) {
					return E("div", { className: "a2s-note a2s-err" }, "Agent2Sync 卡片渲染失败，详见控制台。");
				}
				return this.props.children;
			}
		}

		// ── plugin ────────────────────────────────────────────────────────────

		exports.name = "dsh-agent2sync/client";

		/** `slots` 是唯一硬依赖：卡片挂在插件页的 bundle-config 座位上。 */
		exports.inject = ["slots"];

		exports.apply = function (ctx) {
			ctx.effect(ensureStyles, "dsh-agent2sync: styles");

			try {
				var slots = ctx.slots;
				if (!slots || typeof slots.register !== "function" || typeof slots.inject !== "function") {
					console.warn(TAG + " slots 服务不可用，设置卡片已跳过");
					return;
				}
				slots.inject("plugins.bundle.config", function () {
					return slots.register({
						name: "plugins.bundle.config",
						key: SLOT_KEY,
						inject: function () {
							return { routePath: SYNC_PATH };
						},
					}, function BundleConfigWithBoundary(props) {
						return E(QuietBoundary, null, E(CardShell, props));
					});
				});
			} catch (error) {
				console.warn(TAG + " 设置卡片注册失败:", error && error.message ? error.message : error);
			}
		};

		return module.exports;
	},
});
