// Background (Chrome MV3 service worker): saves files on behalf of the extension,
// bypassing the per-site "automatic downloads" prompt from <a download> in content.
//
// The service worker cannot create object URLs, therefore the file is packaged
// into a data: URL (base64), and the download is triggered via chrome.downloads.
// The response is returned asynchronously after completion/timeout.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!['MAX_EXPORT_DOWNLOAD', 'MAX_EXPORT_DOWNLOAD_URL'].includes(msg?.type)) return false;

  if (typeof chrome.downloads?.download !== 'function') {
    sendResponse({ ok: false, error: 'chrome.downloads недоступен — перезагрузите расширение' });
    return false;
  }

  // Download via chrome.downloads and sendResponse exactly once, when the
  // download completes, is interrupted or times out (safety net so the
  // response channel never hangs).
  const watchDownload = (filename, url, timeoutMs) => {
    chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' })
      .then(id => {
        const onDone = (state) => {
          chrome.downloads.onChanged.removeListener(onChange);
          clearTimeout(timer);
          sendResponse({ ok: state === 'complete', id, state });
        };
        const onChange = (delta) => {
          if (delta.id !== id || !delta.state) return;
          const state = delta.state.current;
          if (state === 'complete' || state === 'interrupted') onDone(state);
        };
        const timer = setTimeout(() => onDone('timeout'), timeoutMs);
        chrome.downloads.onChanged.addListener(onChange);
      })
      .catch(err => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
  };

  if (msg.type === 'MAX_EXPORT_DOWNLOAD_URL') {
    watchDownload(msg.filename, msg.url, 60000);
    return true;
  }

  const mime = (msg.mime || 'text/plain').replace(/;\s*$/, '');

  let url;
  try {
    if (msg.base64) {
      // Binary payload (media originals): the content is already base64.
      url = 'data:' + mime + ';base64,' + msg.content;
    } else {
      // SW: TextEncoder -> binary string -> base64 (in chunks, avoiding stack overflow)
      const bytes = new TextEncoder().encode(msg.content);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      url = 'data:' + mime + ';base64,' + btoa(bin);
    }
  } catch (e) {
    sendResponse({ ok: false, error: 'подготовка URL: ' + e.message });
    return false;
  }

  watchDownload(msg.filename, url, msg.base64 ? 120000 : 30000);
  return true; // response will arrive asynchronously
});
