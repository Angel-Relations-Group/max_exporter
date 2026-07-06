
// Re-inject the MAIN-world hook on SPA navigations (it must run before the app
// patches the APIs we depend on: navigator.clipboard and the History API).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url &&
      (tab.url.includes('max.ru') || tab.url.includes('web.max.ru'))) {
    chrome.scripting.executeScript({
      target: {tabId},
      world: 'MAIN',
      files: ['main-inject.js'],
      injectImmediately: true
    }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'MAX_EXPORT_DOWNLOAD') {
    chrome.downloads.download({
      url: msg.url,
      filename: msg.filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: !!downloadId, downloadId });
      }
    });
    return true;
  }
});
