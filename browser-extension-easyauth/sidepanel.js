let bridgeUrl = "";
let tenantId = "";
let clientId = "";
let localDefaults = {};
let authSession = null; // { accessToken, refreshToken, expiresAt, userEmail, userName }
let agentsList = [];
let currentScan = { pageContext: null, formFields: [], tabId: null };
const conversationMap = new Map();

const projectStatusText = document.getElementById("projectStatusText");
const toggleSettingsBtn = document.getElementById("toggleSettingsBtn");
const settingsPanel = document.getElementById("settingsPanel");
const bridgeUrlInput = document.getElementById("bridgeUrlInput");
const tenantIdInput = document.getElementById("tenantIdInput");
const clientIdInput = document.getElementById("clientIdInput");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const redirectUriHint = document.getElementById("redirectUriHint");

const signedOutBox = document.getElementById("signedOutBox");
const signedInBox = document.getElementById("signedInBox");
const signInBtn = document.getElementById("signInBtn");
const signedInUserText = document.getElementById("signedInUserText");
const switchAccountBtn = document.getElementById("switchAccountBtn");
const signOutBtn = document.getElementById("signOutBtn");

const agentSelect = document.getElementById("agentSelect");
const refreshAgentsBtn = document.getElementById("refreshAgentsBtn");
const agentMetaText = document.getElementById("agentMetaText");
const tabScanDot = document.getElementById("tabScanDot");
const tabSummaryText = document.getElementById("tabSummaryText");
const rescanBtn = document.getElementById("rescanBtn");
const fieldsPreviewList = document.getElementById("fieldsPreviewList");
const chatContainer = document.getElementById("chatContainer");
const convBadge = document.getElementById("convBadge");
const resetConvBtn = document.getElementById("resetConvBtn");
const chatForm = document.getElementById("chatForm");
const promptInput = document.getElementById("promptInput");
const sendBtn = document.getElementById("sendBtn");

function getRedirectUri() {
  return chrome.identity.getRedirectURL("callback");
}

function getOAuthScopes() {
  return `openid profile email offline_access api://${clientId}/user_impersonation`;
}

function base64UrlEncode(uint8) {
  let binary = "";
  for (let i = 0; i < uint8.byteLength; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateRandomBase64Url(byteLen = 32) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function computePkceChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hashBuffer));
}

function parseJwtClaims(jwt) {
  if (!jwt) return {};
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return {};
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
}

function setSingleOption(selectEl, text) {
  const opt = document.createElement("option");
  opt.value = "";
  opt.textContent = text;
  selectEl.replaceChildren(opt);
}

function setPreviewMessage(text) {
  const li = document.createElement("li");
  li.textContent = text;
  fieldsPreviewList.replaceChildren(li);
}

function isEntraConfigured() {
  return Boolean(bridgeUrl && tenantId && clientId);
}

function updateAuthUi() {
  if (!isEntraConfigured()) {
    signedInBox.classList.add("hidden");
    signedOutBox.classList.remove("hidden");
    agentSelect.disabled = true;
    setSingleOption(agentSelect, "接続先を設定してください");
    agentMetaText.textContent =
      "右上の⚙️設定から ブリッジ URL・テナント ID・クライアント ID を設定してください";
    projectStatusText.textContent = "⚙️ 初期設定が必要です";
    settingsPanel.classList.remove("hidden");
    return;
  }

  if (authSession && authSession.accessToken) {
    signedOutBox.classList.add("hidden");
    signedInBox.classList.remove("hidden");
    const label = authSession.userEmail || authSession.userName || "サインイン済ユーザー";
    signedInUserText.textContent = label;
    agentSelect.disabled = false;
  } else {
    signedInBox.classList.add("hidden");
    signedOutBox.classList.remove("hidden");
    agentSelect.disabled = true;
    setSingleOption(agentSelect, "サインイン後に読み込まれます");
    agentMetaText.textContent = "上のボタンから Microsoft アカウントでサインインしてください";
    projectStatusText.textContent = "🔒 未サインイン（Entra Easy Auth）";
  }
}

async function signInWithEntra(forceSelectAccount = true) {
  if (!isEntraConfigured()) {
    settingsPanel.classList.remove("hidden");
    appendErrorCard("先に右上の⚙️設定から ブリッジ API URL・テナント ID・クライアント ID を入力して保存してください。");
    return;
  }
  signInBtn.disabled = true;
  const origLabel = signInBtn.querySelector("span:last-child").textContent;
  signInBtn.querySelector("span:last-child").textContent = "Microsoft サインイン画面を起動中...";

  try {
    const codeVerifier = generateRandomBase64Url(48);
    const codeChallenge = await computePkceChallenge(codeVerifier);
    const state = generateRandomBase64Url(16);
    const redirectUri = getRedirectUri();

    const authParams = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: getOAuthScopes(),
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });
    if (forceSelectAccount) {
      authParams.set("prompt", "select_account");
    }

    const authorizeUrl = `https://login.microsoftonline.com/${encodeURIComponent(
      tenantId
    )}/oauth2/v2.0/authorize?${authParams.toString()}`;

    const callbackUrlStr = await chrome.identity.launchWebAuthFlow({
      url: authorizeUrl,
      interactive: true,
    });

    const callbackUrl = new URL(callbackUrlStr);
    const errCode = callbackUrl.searchParams.get("error");
    if (errCode) {
      const errDesc = callbackUrl.searchParams.get("error_description") || errCode;
      throw new Error(errDesc);
    }

    const returnedState = callbackUrl.searchParams.get("state");
    if (returnedState !== state) {
      throw new Error("OAuth state が一致しませんでした。もう一度お試しください。");
    }

    const code = callbackUrl.searchParams.get("code");
    if (!code) {
      throw new Error("認可コードが取得できませんでした。");
    }

    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          scope: getOAuthScopes(),
        }),
      }
    );

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || "トークン交換に失敗しました");
    }

    const claims = {
      ...parseJwtClaims(tokenData.access_token),
      ...parseJwtClaims(tokenData.id_token),
    };

    authSession = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresAt: Date.now() + Number(tokenData.expires_in || 3600) * 1000,
      userEmail: claims.preferred_username || claims.upn || claims.email || "",
      userName: claims.name || "",
    };

    await chrome.storage.local.set({ entraAuthSession: authSession });
    updateAuthUi();
    await fetchHealthAndAgents();
  } catch (err) {
    const msg = err?.message || String(err);
    if (!/canceled|closed by the user/i.test(msg)) {
      appendErrorCard(`Entra サインイン失敗: ${msg}`);
    }
  } finally {
    signInBtn.disabled = false;
    signInBtn.querySelector("span:last-child").textContent = origLabel;
  }
}

async function ensureValidAccessToken() {
  if (!authSession || !authSession.accessToken) {
    return null;
  }
  if (Date.now() < (authSession.expiresAt || 0) - 60_000) {
    return authSession.accessToken;
  }
  if (!authSession.refreshToken) {
    authSession = null;
    await chrome.storage.local.remove("entraAuthSession");
    updateAuthUi();
    return null;
  }

  try {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: authSession.refreshToken,
          scope: getOAuthScopes(),
        }),
      }
    );
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(tokenData.error || "refresh_failed");
    }
    authSession = {
      ...authSession,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || authSession.refreshToken,
      expiresAt: Date.now() + Number(tokenData.expires_in || 3600) * 1000,
    };
    await chrome.storage.local.set({ entraAuthSession: authSession });
    return authSession.accessToken;
  } catch {
    authSession = null;
    await chrome.storage.local.remove("entraAuthSession");
    updateAuthUi();
    return null;
  }
}

async function signOutEntra() {
  authSession = null;
  agentsList = [];
  await chrome.storage.local.remove("entraAuthSession");
  updateAuthUi();
}

function getLocalDatePayload() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return { today: `${y}-${m}-${d}` };
}

function getConvKey() {
  const tabPart = currentScan.tabId || "no-tab";
  const agentPart = agentSelect.value || "no-agent";
  return `${tabPart}::${agentPart}`;
}

function updateConvBadge() {
  const cid = conversationMap.get(getConvKey());
  if (cid) {
    convBadge.textContent = `会話継続中 (${cid.slice(-8)})`;
    convBadge.style.background = "#ccfbf1";
    convBadge.style.color = "#115e59";
  } else {
    convBadge.textContent = "新規会話";
    convBadge.style.background = "#f1f5f9";
    convBadge.style.color = "#64748b";
  }
}

function updateAgentMetaDisplay() {
  const selected = agentsList.find((a) => a.agentName === agentSelect.value);
  if (!selected) {
    agentMetaText.textContent = "エージェントを選択してください";
    return;
  }
  const manualInfo = selected.manualFile
    ? `📄 File Search マニュアル: ${selected.manualFile}`
    : "📄 Foundry ポータル登録エージェント";
  agentMetaText.textContent = manualInfo;
  updateConvBadge();
}

async function loadOptionalLocalConfig() {
  try {
    const res = await fetch("./config.local.json");
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // config.local.json は任意（未作成時は設定画面からの入力値を使用）
  }
  return {};
}

async function loadSettings() {
  const [localCfg, stored] = await Promise.all([
    loadOptionalLocalConfig(),
    chrome.storage.local.get([
      "entraBridgeUrl",
      "entraTenantId",
      "entraClientId",
      "entraAuthSession",
      "selectedAgentEasyAuth",
    ]),
  ]);
  localDefaults = localCfg || {};
  bridgeUrl = (stored.entraBridgeUrl || localDefaults.bridgeUrl || "").replace(/\/+$/, "");
  tenantId = (stored.entraTenantId || localDefaults.tenantId || "").trim();
  clientId = (stored.entraClientId || localDefaults.clientId || "").trim();
  authSession = stored.entraAuthSession || null;

  bridgeUrlInput.value = bridgeUrl;
  tenantIdInput.value = tenantId;
  clientIdInput.value = clientId;
  redirectUriHint.textContent = `Entra SPA Redirect URI: ${getRedirectUri()}`;

  updateAuthUi();
  return stored.selectedAgentEasyAuth || "";
}

async function fetchHealthAndAgents(preferredAgent = "") {
  if (!isEntraConfigured()) {
    updateAuthUi();
    return;
  }
  try {
    const healthRes = await fetch(`${bridgeUrl}/api/health`);
    if (!healthRes.ok) {
      throw new Error(`Health HTTP ${healthRes.status}`);
    }
    const health = await healthRes.json();

    const token = await ensureValidAccessToken();
    if (!token) {
      updateAuthUi();
      return;
    }

    projectStatusText.textContent = "Foundry Agent 一覧を取得中...";
    const agentsRes = await fetch(`${bridgeUrl}/api/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (agentsRes.status === 401 || agentsRes.status === 403) {
      await signOutEntra();
      appendErrorCard(
        `App Service Easy Auth で認証が拒否されました (HTTP ${agentsRes.status})。再度 Microsoft アカウントでサインインしてください。`
      );
      return;
    }

    if (!agentsRes.ok) {
      throw new Error(`HTTP ${agentsRes.status}`);
    }

    const agentsData = await agentsRes.json();
    agentsList = agentsData.agents || [];
    if (agentsData.authenticatedUser && authSession) {
      signedInUserText.textContent = agentsData.authenticatedUser;
    }

    const projLabel = agentsData.projectName || health.projectName || "Foundry";
    const modelLabel = agentsData.modelDeploymentName || health.modelDeploymentName || "";
    projectStatusText.textContent = modelLabel
      ? `🟢 ${projLabel} (${modelLabel})`
      : `🟢 ${projLabel}`;

    const prevSelected = preferredAgent || agentSelect.value;
    agentSelect.replaceChildren();
    for (const ag of agentsList) {
      const opt = document.createElement("option");
      opt.value = ag.agentName;
      opt.textContent = `${ag.agentName} — ${ag.label}`;
      agentSelect.appendChild(opt);
    }

    if (prevSelected && agentsList.some((a) => a.agentName === prevSelected)) {
      agentSelect.value = prevSelected;
    } else if (agentsList.length > 0) {
      agentSelect.value = agentsList[0].agentName;
    }

    updateAgentMetaDisplay();
  } catch (err) {
    projectStatusText.textContent = "🔴 ブリッジ接続エラー";
    agentMetaText.textContent = `ブリッジAPI (${bridgeUrl}) への接続に失敗しました。`;
    console.error("Bridge connection error:", err);
  }
}

async function sendMessageToActiveTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return await chrome.tabs.sendMessage(tabId, payload);
  }
}

async function scanActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.id || !tab.url || /^(chrome|edge|about|chrome-extension):/.test(tab.url)) {
      currentScan = { pageContext: null, formFields: [], tabId: tab?.id || null };
      tabScanDot.className = "dot warn";
      tabSummaryText.textContent = "Webアプリのタブを開いてください";
      setPreviewMessage("対象外のシステムページです");
      updateConvBadge();
      return currentScan;
    }

    const res = await sendMessageToActiveTab(tab.id, { type: "SCAN_FORM" });
    if (!res || !res.ok) {
      throw new Error(res?.error || "フォーム解析失敗");
    }

    currentScan = {
      tabId: tab.id,
      pageContext: res.pageContext,
      formFields: res.formFields || [],
    };

    const count = currentScan.formFields.length;
    tabScanDot.className = count > 0 ? "dot ok" : "dot warn";
    tabSummaryText.textContent = `検出項目: ${count}件 ｜ ${res.pageContext?.title || ""}`;

    fieldsPreviewList.replaceChildren();
    for (const f of currentScan.formFields) {
      const li = document.createElement("li");
      li.textContent = `${f.label} (${f.fieldKey} / ${f.type})`;
      fieldsPreviewList.appendChild(li);
    }
    updateConvBadge();
    return currentScan;
  } catch (err) {
    tabScanDot.className = "dot warn";
    tabSummaryText.textContent = "このタブのフォームを解析できません";
    setPreviewMessage(String(err));
    return { pageContext: null, formFields: [], tabId: null };
  }
}

function appendUserBubble(text) {
  const div = document.createElement("div");
  div.className = "msg-user";
  div.textContent = text;
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function appendLoadingCard(agentName) {
  const div = document.createElement("div");
  div.className = "loading-card";
  const spinner = document.createElement("div");
  spinner.className = "spinner";
  const textSpan = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = agentName;
  textSpan.append("Easy Auth 認証トークンで ", strong, " を呼び出し中...");
  div.append(spinner, textSpan);
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return div;
}

function appendErrorCard(message) {
  const div = document.createElement("div");
  div.className = "error-card";
  div.textContent = `⚠️ ${message}`;
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function appendAgentResponseCard(apiRes, fillRes) {
  const card = document.createElement("div");
  card.className = "msg-agent";

  const badgeRow = document.createElement("div");
  badgeRow.className = "agent-badge-row";

  if (apiRes.authenticatedUser) {
    const authPill = document.createElement("span");
    authPill.className = "pill easyauth";
    authPill.textContent = `🔐 Easy Auth: ${apiRes.authenticatedUser}`;
    badgeRow.appendChild(authPill);
  }

  const agentPill = document.createElement("span");
  agentPill.className = "pill agent";
  agentPill.textContent = `🤖 ${apiRes.agentName}`;
  badgeRow.appendChild(agentPill);

  if (apiRes.usedWorkIq) {
    const wiqPill = document.createElement("span");
    wiqPill.className = "pill workiq";
    wiqPill.textContent = "🧠 Work IQ (M365) 参照済";
    badgeRow.appendChild(wiqPill);
  }

  if (apiRes.usedFileSearch) {
    const fsPill = document.createElement("span");
    fsPill.className = "pill filesearch";
    const citeTxt =
      apiRes.citations && apiRes.citations.length > 0
        ? `: ${apiRes.citations.join(", ")}`
        : "";
    fsPill.textContent = `📄 File Search 参照済${citeTxt}`;
    badgeRow.appendChild(fsPill);
  }

  if (fillRes && fillRes.ok) {
    const fillPill = document.createElement("span");
    fillPill.className = "pill filled";
    fillPill.textContent = `✏️ ${fillRes.appliedCount}項目を自動入力済`;
    badgeRow.appendChild(fillPill);
  }
  card.appendChild(badgeRow);

  const summaryEl = document.createElement("div");
  summaryEl.className = "agent-summary";
  summaryEl.textContent = apiRes.summary;
  card.appendChild(summaryEl);

  if (Array.isArray(apiRes.appliedRules) && apiRes.appliedRules.length > 0) {
    const rulesBox = document.createElement("div");
    rulesBox.className = "rules-box";
    const title = document.createElement("div");
    title.className = "rules-box-title";
    title.textContent = "📚 マニュアルから適用した規定・根拠";
    rulesBox.appendChild(title);

    const ul = document.createElement("ul");
    for (const rule of apiRes.appliedRules) {
      const li = document.createElement("li");
      li.textContent = rule;
      ul.appendChild(li);
    }
    rulesBox.appendChild(ul);
    card.appendChild(rulesBox);
  }

  if (fillRes?.appliedDetails?.length > 0) {
    const details = document.createElement("details");
    details.className = "applied-details";
    details.open = true;
    const sum = document.createElement("summary");
    sum.textContent = `入力された項目を確認 (${fillRes.appliedDetails.length}件)`;
    details.appendChild(sum);

    const tbl = document.createElement("table");
    tbl.className = "applied-table";
    for (const item of fillRes.appliedDetails) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = item.label;
      const td2 = document.createElement("td");
      td2.textContent = item.displayValue;
      tr.appendChild(td1);
      tr.appendChild(td2);
      tbl.appendChild(tr);
    }
    details.appendChild(tbl);
    card.appendChild(details);
  }

  if (apiRes.fieldValues && Object.keys(apiRes.fieldValues).length > 0) {
    const reapplyBtn = document.createElement("button");
    reapplyBtn.className = "reapply-btn";
    reapplyBtn.textContent = "⚡ 現在の画面にもう一度反映する";
    reapplyBtn.addEventListener("click", async () => {
      const latest = await scanActiveTab();
      if (latest.tabId) {
        await sendMessageToActiveTab(latest.tabId, {
          type: "APPLY_VALUES",
          fieldValues: apiRes.fieldValues,
        });
      }
    });
    card.appendChild(reapplyBtn);
  }

  chatContainer.appendChild(card);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function appendConsentCard(apiRes, originalPrompt) {
  const card = document.createElement("div");
  card.className = "consent-card";

  const title = document.createElement("div");
  title.className = "consent-title";
  title.textContent = "🔐 初回のみ：Microsoft 365 (Work IQ) 接続の許可が必要です";
  card.appendChild(title);

  const desc = document.createElement("div");
  desc.textContent =
    "Foundry Agent があなたの Outlook 予定表・メール・Teams チャットを参照できるよう、一度だけ同意画面で許可してください（次回以降は不要です）。";
  card.appendChild(desc);

  const actions = document.createElement("div");
  actions.className = "consent-actions";

  const openBtn = document.createElement("button");
  openBtn.className = "consent-open-btn";
  openBtn.textContent = "🔗 1. 同意画面を別タブで開く";
  openBtn.addEventListener("click", () => {
    if (typeof apiRes.consentLink === "string" && apiRes.consentLink.startsWith("https://")) {
      chrome.tabs.create({ url: apiRes.consentLink });
    }
  });

  const contBtn = document.createElement("button");
  contBtn.className = "consent-continue-btn";
  contBtn.textContent = "▶️ 2. 許可完了後に自動入力を実行する";
  contBtn.addEventListener("click", () => {
    card.remove();
    handleSubmitPrompt(originalPrompt, apiRes.previousResponseId || null, true);
  });

  actions.appendChild(openBtn);
  actions.appendChild(contBtn);
  card.appendChild(actions);

  chatContainer.appendChild(card);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

async function handleSubmitPrompt(userText, previousResponseId = null, skipUserBubble = false) {
  const trimmed = userText.trim();
  if (!trimmed) return;

  const token = await ensureValidAccessToken();
  if (!token) {
    appendErrorCard("先に「Microsoft アカウントでサインイン」ボタンを押して認証してください。");
    return;
  }

  const selectedAgent = agentSelect.value;
  if (!selectedAgent) {
    appendErrorCard("接続先の Foundry Agent を選択してください。");
    return;
  }

  const scan = await scanActiveTab();
  if (!scan.tabId || scan.formFields.length === 0) {
    appendErrorCard("現在のタブに入力可能なフォーム項目が見つかりませんでした。経費申請Webアプリのタブを開いてください。");
    return;
  }

  if (!skipUserBubble) {
    appendUserBubble(trimmed);
    promptInput.value = "";
  }
  sendBtn.disabled = true;

  const loadingEl = appendLoadingCard(selectedAgent);
  const convKey = getConvKey();
  const existingConvId = conversationMap.get(convKey) || null;

  try {
    const res = await fetch(`${bridgeUrl}/api/autofill`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        agentName: selectedAgent,
        userMessage: trimmed,
        conversationId: existingConvId,
        previousResponseId,
        currentDate: getLocalDatePayload(),
        pageContext: scan.pageContext,
        formFields: scan.formFields,
      }),
    });

    if (res.status === 401 || res.status === 403) {
      await signOutEntra();
      throw new Error(`Easy Auth トークン検証エラー (HTTP ${res.status})。再度サインインしてください。`);
    }

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`HTTP ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    if (data.conversationId) {
      conversationMap.set(convKey, data.conversationId);
      updateConvBadge();
    }

    if (data.consentRequired && data.consentLink) {
      loadingEl.remove();
      appendConsentCard(data, trimmed);
      return;
    }

    let fillRes = null;
    if (data.fieldValues && Object.keys(data.fieldValues).length > 0) {
      fillRes = await sendMessageToActiveTab(scan.tabId, {
        type: "APPLY_VALUES",
        fieldValues: data.fieldValues,
      });
      await scanActiveTab();
    }

    loadingEl.remove();
    appendAgentResponseCard(data, fillRes);
  } catch (err) {
    loadingEl.remove();
    appendErrorCard(err.message || String(err));
  } finally {
    sendBtn.disabled = false;
    promptInput.focus();
  }
}

toggleSettingsBtn.addEventListener("click", () => {
  settingsPanel.classList.toggle("hidden");
});

saveSettingsBtn.addEventListener("click", async () => {
  bridgeUrl = bridgeUrlInput.value.trim().replace(/\/+$/, "") || (localDefaults.bridgeUrl || "").replace(/\/+$/, "");
  tenantId = tenantIdInput.value.trim() || (localDefaults.tenantId || "").trim();
  clientId = clientIdInput.value.trim() || (localDefaults.clientId || "").trim();
  await chrome.storage.local.set({
    entraBridgeUrl: bridgeUrl,
    entraTenantId: tenantId,
    entraClientId: clientId,
  });
  settingsPanel.classList.add("hidden");
  updateAuthUi();
  await fetchHealthAndAgents();
});

signInBtn.addEventListener("click", () => signInWithEntra(true));
switchAccountBtn.addEventListener("click", () => signInWithEntra(true));
signOutBtn.addEventListener("click", signOutEntra);

agentSelect.addEventListener("change", async () => {
  await chrome.storage.local.set({ selectedAgentEasyAuth: agentSelect.value });
  updateAgentMetaDisplay();
});

refreshAgentsBtn.addEventListener("click", () => fetchHealthAndAgents());
rescanBtn.addEventListener("click", () => scanActiveTab());

resetConvBtn.addEventListener("click", () => {
  conversationMap.clear();
  chatContainer
    .querySelectorAll(".msg-user, .msg-agent, .error-card, .loading-card, .consent-card")
    .forEach((el) => el.remove());
  updateConvBadge();
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  handleSubmitPrompt(promptInput.value);
});

promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    handleSubmitPrompt(promptInput.value);
  }
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    promptInput.value = chip.getAttribute("data-prompt") || "";
    promptInput.focus();
  });
});

chrome.tabs.onActivated.addListener(() => {
  setTimeout(scanActiveTab, 120);
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    setTimeout(scanActiveTab, 150);
  }
});

(async () => {
  const preferredAgent = await loadSettings();
  await Promise.all([fetchHealthAndAgents(preferredAgent), scanActiveTab()]);
})();
