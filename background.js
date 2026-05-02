chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if(msg?.type === 'MAX_EXPORT_DOWNLOAD'){
    chrome.downloads.download({
      url: msg.url,
      filename: msg.filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ok:false, error: chrome.runtime.lastError.message});
      } else {
        sendResponse({ok: !!downloadId, downloadId});
      }
    });
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({
    url: ['https://max.ru/*', 'https://web.max.ru/*']
  }, (tabs) => {
    for (const tab of tabs) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      }).catch(() => {});
      chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content.css']
      }).catch(() => {});
    }
  });
});
