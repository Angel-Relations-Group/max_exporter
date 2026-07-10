// Background (Chrome MV3 service worker): saves files on behalf of the extension,
// bypassing the per-site "automatic downloads" prompt from <a download> in content.
//
// The service worker cannot create object URLs, therefore the file is packaged
// into a data: URL (base64), and the download is triggered via chrome.downloads.
// The response is returned asynchronously after completion/timeout.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'MAX_EXPORT_DOWNLOAD') return false;

  if (typeof chrome.downloads?.download !== 'function') {
    sendResponse({ ok: false, error: 'chrome.downloads недоступен — перезагрузите расширение' });
    return false;
  }

  const mime = (msg.mime || 'text/plain').replace(/;\s*$/, '');

  // SW: TextEncoder -> binary string -> base64 (in chunks, avoiding stack overflow)
  function buildUrl() {
    const bytes = new TextEncoder().encode(msg.content);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return 'data:' + mime + ';base64,' + btoa(bin);
  }

  let url;
  try {
    url = buildUrl();
  } catch (e) {
    sendResponse({ ok: false, error: 'подготовка URL: ' + e.message });
    return false;
  }

  chrome.downloads.download({ url, filename: msg.filename, saveAs: false, conflictAction: 'uniquify' })
    .then(id => {
      const onDone = (state) => {
        chrome.downloads.onChanged.removeListener(onChange);
        clearTimeout(timer);
        sendResponse({ ok: state === 'complete', id, state });
      };
      const onChange = (delta) => {
        if (delta.id !== id || !delta.state) return;
        const s = delta.state.current;
        if (s === 'complete' || s === 'interrupted') onDone(s);
      };
      const timer = setTimeout(() => onDone('timeout'), 30000); // safety net for the response channel
      chrome.downloads.onChanged.addListener(onChange);
    })
    .catch(err => {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    });

  return true; // response will arrive asynchronously
});
