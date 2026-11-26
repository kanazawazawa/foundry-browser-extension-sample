importScripts("target-guard.js");

const { DEFAULT_ALLOWED_TARGET_ORIGINS, normalizeAllowedOrigins, isAllowedTargetUrl } =
  globalThis.FoundryTargetGuard;

let cachedGuardConfig = null;

async function loadTargetGuardConfig() {
  if (cachedGuardConfig) {
    return cachedGuardConfig;
  }
  try {
    const res = await fetch(chrome.runtime.getURL("config.local.json"));
    if (res.ok) {
      const cfg = await res.json();
      cachedGuardConfig = {
        allowedOrigins: normalizeAllowedOrigins(cfg.allowedOrigins),
        bridgeUrl: typeof cfg.bridgeUrl === "string" ? cfg.bridgeUrl.trim() : "",
      };
      return cachedGuardConfig;
    }
  } catch {
    // config.local.json 未配置時は既定の許可リストを使用
  }
  cachedGuardConfig = {
    allowedOrigins: [...DEFAULT_ALLOWED_TARGET_ORIGINS],
    bridgeUrl: "",
  };
  return cachedGuardConfig;
}

async function getActiveBridgeUrl(fallbackBridgeUrl) {
  try {
    const stored = await chrome.storage.local.get(["entraBridgeUrl"]);
    return (stored.entraBridgeUrl || fallbackBridgeUrl || "").trim();
  } catch {
    return fallbackBridgeUrl || "";
  }
}

async function updateTabBadge(tabId, url) {
  if (!tabId) return;
  const { allowedOrigins, bridgeUrl: localBridgeUrl } = await loadTargetGuardConfig();
  const activeBridgeUrl = await getActiveBridgeUrl(localBridgeUrl);
  const allowed = isAllowedTargetUrl(url, allowedOrigins, activeBridgeUrl);
  try {
    if (allowed) {
      await chrome.action.setBadgeText({ tabId, text: "ON" });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0d9488" });
      await chrome.action.setTitle({
        tabId,
        title: "Foundry Form Copilot (Entra Easy Auth) — 許可対象の業務アプリ",
      });
    } else {
      await chrome.action.setBadgeText({ tabId, text: "" });
      await chrome.action.setTitle({
        tabId,
        title: "Foundry Form Copilot (Entra Easy Auth) — 対象外ページ（設定のみ表示・送信無効）",
      });
    }
  } catch {
    // タブが閉じられた直後などは無視
  }
}

async function refreshAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => updateTabBadge(tab.id, tab.url)));
  } catch {
    // 初期化時のタブ列挙失敗は無視
  }
}

// ツールバーアイコンをクリックした際に自動でサイドパネルを開く（Chrome / Edge 共通）
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("Failed to set sidePanel behavior:", err));
  refreshAllTabs();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("Failed to set sidePanel behavior:", err));
  refreshAllTabs();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    updateTabBadge(tabId, changeInfo.url || tab.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateTabBadge(tab.id, tab.url);
  } catch {
    // タブ取得失敗時は無視
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.entraBridgeUrl) {
    refreshAllTabs();
  }
});
