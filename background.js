chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'MAX_EXPORT_DOWNLOAD') {
    try {
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
    } catch(e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }
});
