// Background (Firefox event page): saves files on behalf of the extension,
// bypassing the per-site "automatic downloads" prompt from <a download> in content.
//
// The event page can create object URLs, whereas Firefox blocks data: URLs —
// therefore the file is packaged into a blob: URL, the download is triggered via
// chrome.downloads, and the blob is released (revokeObjectURL) after
// completion/timeout. The response is returned asynchronously.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'MAX_EXPORT_DOWNLOAD') return false;

  if (typeof chrome.downloads?.download !== 'function') {
    sendResponse({ ok: false, error: 'chrome.downloads недоступен — перезагрузите расширение' });
    return false;
  }

  const mime = (msg.mime || 'text/plain').replace(/;\s*$/, '');

  let url;
  try {
    const blob = new Blob([msg.content], { type: mime });
    url = URL.createObjectURL(blob);
  } catch (e) {
    sendResponse({ ok: false, error: 'подготовка URL: ' + e.message });
    return false;
  }

  const cleanup = () => URL.revokeObjectURL(url);

  chrome.downloads.download({ url, filename: msg.filename, saveAs: false, conflictAction: 'uniquify' })
    .then(id => {
      const onDone = (state) => {
        chrome.downloads.onChanged.removeListener(onChange);
        clearTimeout(timer);
        cleanup();
        sendResponse({ ok: state === 'complete', id, state });
      };
      const onChange = (delta) => {
        if (delta.id === id && delta.state?.current !== 'in_progress') {
          onDone(delta.state.current);
        }
      };
      const timer = setTimeout(() => onDone('timeout'), 30000); // safety net for the response channel
      chrome.downloads.onChanged.addListener(onChange);
    })
    .catch(err => {
      cleanup();
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    });

  return true; // response will arrive asynchronously
});
