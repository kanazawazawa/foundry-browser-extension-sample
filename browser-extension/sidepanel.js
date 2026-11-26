const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8765";

let bridgeUrl = DEFAULT_BRIDGE_URL;
let demoKey = "";
let agentsList = [];
let currentScan = { pageContext: null, formFields: [], tabId: null };
const conversationMap = new Map();

const projectStatusText = document.getElementById("projectStatusText");
const toggleSettingsBtn = document.getElementById("toggleSettingsBtn");
const settingsPanel = document.getElementById("settingsPanel");
const demoKeyInput = document.getElementById("demoKeyInput");
const bridgeUrlInput = document.getElementById("bridgeUrlInput");
const saveBridgeBtn = document.getElementById("saveBridgeBtn");
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
    convBadge.style.background = "#dbeafe";
    convBadge.style.color = "#1e40af";
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

function buildApiHeaders(includeJson = false) {
  const headers = {};
  if (includeJson) {
    headers["Content-Type"] = "application/json";
  }
  if (demoKey) {
    headers["X-Demo-Key"] = demoKey;
  }
  return headers;
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

async function loadOptionalLocalConfig() {
  try {
    const res = await fetch("./config.local.json");
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // config.local.json は任意（未作成時は既定値を使用）
  }
  return {};
}

async function loadSettings() {
  const [localCfg, stored] = await Promise.all([
    loadOptionalLocalConfig(),
    chrome.storage.local.get(["bridgeUrl", "demoKey", "selectedAgent"]),
  ]);
  const fallbackUrl = (localCfg.bridgeUrl || DEFAULT_BRIDGE_URL).replace(/\/+$/, "");
  bridgeUrl = (stored.bridgeUrl || fallbackUrl).replace(/\/+$/, "");
  demoKey = (stored.demoKey || "").trim();
  bridgeUrlInput.value = bridgeUrl;
  demoKeyInput.value = demoKey;
  return stored.selectedAgent || "";
}

async function fetchHealthAndAgents(preferredAgent = "") {
  try {
    projectStatusText.textContent = "Foundry 接続確認中...";
    const healthRes = await fetch(`${bridgeUrl}/api/health`);
    if (!healthRes.ok) {
      throw new Error(`HTTP ${healthRes.status}`);
    }
    const health = await healthRes.json();

    if (health.authRequired && !demoKey) {
      projectStatusText.textContent = "🔒 合言葉の入力が必要です";
      setSingleOption(agentSelect, "🔒 合言葉を設定してください");
      agentMetaText.textContent =
        "上の「🔑 デモ用合言葉」を入力して「保存して接続」を押してください。";
      settingsPanel.classList.remove("hidden");
      demoKeyInput.focus();
      return;
    }

    const agentsRes = await fetch(`${bridgeUrl}/api/agents`, {
      headers: buildApiHeaders(false),
    });

    if (agentsRes.status === 401) {
      projectStatusText.textContent = "🔒 合言葉が一致しません";
      setSingleOption(agentSelect, "🔒 合言葉を確認してください");
      agentMetaText.textContent =
        "合言葉（アクセスキー）が正しくありません。再入力して「保存して接続」を押してください。";
      settingsPanel.classList.remove("hidden");
      demoKeyInput.focus();
      return;
    }

    if (!agentsRes.ok) {
      throw new Error(`HTTP ${agentsRes.status}`);
    }

    const agentsData = await agentsRes.json();
    agentsList = agentsData.agents || [];

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
    agentMetaText.textContent =
      `ブリッジAPI (${bridgeUrl}) への接続に失敗しました。右上⚙️からURLを確認してください。`;
    console.error("Bridge connection error:", err);
  }
}

async function sendMessageToActiveTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (_firstErr) {
    // 拡張機能ロード前から開いていたタブにも即座に content.js を動的注入して再試行
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
  textSpan.append(strong, " が社内規定を検索し、入力値を生成しています...");
  div.append(spinner, textSpan);
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return div;
}

function appendErrorCard(message) {
  const div = document.createElement("div");
  div.className = "error-card";
  div.textContent = `⚠️ エラー: ${message}`;
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function appendAgentResponseCard(apiRes, fillRes) {
  const card = document.createElement("div");
  card.className = "msg-agent";

  // バッジ行
  const badgeRow = document.createElement("div");
  badgeRow.className = "agent-badge-row";

  const agentPill = document.createElement("span");
  agentPill.className = "pill agent";
  agentPill.textContent = `🤖 ${apiRes.agentName}`;
  badgeRow.appendChild(agentPill);

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

  // 要約テキスト
  const summaryEl = document.createElement("div");
  summaryEl.className = "agent-summary";
  summaryEl.textContent = apiRes.summary;
  card.appendChild(summaryEl);

  // 適用された規定ルール
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

  // 自動入力された項目の詳細テーブル
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

  // 再反映ボタン
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

async function handleSubmitPrompt(userText) {
  const trimmed = userText.trim();
  if (!trimmed) return;

  const selectedAgent = agentSelect.value;
  if (!selectedAgent) {
    appendErrorCard("接続先の Foundry Agent を選択してください。");
    return;
  }

  // 送信直前に必ず最新タブのフォーム構造をスキャン
  const scan = await scanActiveTab();
  if (!scan.tabId || scan.formFields.length === 0) {
    appendErrorCard("現在のタブに入力可能なフォーム項目が見つかりませんでした。経費申請Webアプリのタブを開いてください。");
    return;
  }

  appendUserBubble(trimmed);
  promptInput.value = "";
  sendBtn.disabled = true;

  const loadingEl = appendLoadingCard(selectedAgent);
  const convKey = getConvKey();
  const existingConvId = conversationMap.get(convKey) || null;

  try {
    const res = await fetch(`${bridgeUrl}/api/autofill`, {
      method: "POST",
      headers: buildApiHeaders(true),
      body: JSON.stringify({
        agentName: selectedAgent,
        userMessage: trimmed,
        conversationId: existingConvId,
        currentDate: getLocalDatePayload(),
        pageContext: scan.pageContext,
        formFields: scan.formFields,
      }),
    });

    if (res.status === 401) {
      settingsPanel.classList.remove("hidden");
      demoKeyInput.focus();
      throw new Error("合言葉（アクセスキー）が未入力または一致しません。右上の⚙️設定から合言葉を入力してください。");
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

    let fillRes = null;
    if (data.fieldValues && Object.keys(data.fieldValues).length > 0) {
      fillRes = await sendMessageToActiveTab(scan.tabId, {
        type: "APPLY_VALUES",
        fieldValues: data.fieldValues,
      });
      // 反映後の現在値を再スキャンして保持
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

// イベント登録
toggleSettingsBtn.addEventListener("click", () => {
  settingsPanel.classList.toggle("hidden");
});

async function saveSettingsAndConnect() {
  bridgeUrl = bridgeUrlInput.value.trim().replace(/\/+$/, "") || DEFAULT_BRIDGE_URL;
  demoKey = demoKeyInput.value.trim();
  await chrome.storage.local.set({ bridgeUrl, demoKey });
  settingsPanel.classList.add("hidden");
  await fetchHealthAndAgents();
}

saveBridgeBtn.addEventListener("click", saveSettingsAndConnect);

demoKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    saveSettingsAndConnect();
  }
});

agentSelect.addEventListener("change", async () => {
  await chrome.storage.local.set({ selectedAgent: agentSelect.value });
  updateAgentMetaDisplay();
});

refreshAgentsBtn.addEventListener("click", () => fetchHealthAndAgents());
rescanBtn.addEventListener("click", () => scanActiveTab());

resetConvBtn.addEventListener("click", () => {
  conversationMap.clear();
  chatContainer
    .querySelectorAll(".msg-user, .msg-agent, .error-card, .loading-card")
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

// タブ切り替え・ページ遷移時に自動再スキャン
chrome.tabs.onActivated.addListener(() => {
  setTimeout(scanActiveTab, 120);
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    setTimeout(scanActiveTab, 150);
  }
});

// 初期化
(async () => {
  const preferredAgent = await loadSettings();
  await Promise.all([fetchHealthAndAgents(preferredAgent), scanActiveTab()]);
})();
