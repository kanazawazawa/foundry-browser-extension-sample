// ツールバーアイコンをクリックした際に自動でサイドパネルを開く（Chrome / Edge 共通）
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("Failed to set sidePanel behavior:", err));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("Failed to set sidePanel behavior:", err));
});
