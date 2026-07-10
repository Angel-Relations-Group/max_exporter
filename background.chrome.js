// Background (Chrome MV3 service worker): сохраняет файлы от имени расширения,
// обходя per-site запрос "automatic downloads" от <a download> в контенте.
//
// Service worker не умеет создавать object URL, поэтому файл упаковывается
// в data: URL (base64), а скачивание запускается через chrome.downloads.
// Ответ возвращается асинхронно после завершения/таймаута.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'MAX_EXPORT_DOWNLOAD') return false;

  if (typeof chrome.downloads?.download !== 'function') {
    sendResponse({ ok: false, error: 'chrome.downloads недоступен — перезагрузите расширение' });
    return false;
  }

  const mime = (msg.mime || 'text/plain').replace(/;\s*$/, '');

  // SW: TextEncoder -> binary string -> base64 (чанками, без переполнения стека)
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
        if (delta.id === id && delta.state?.current !== 'in_progress') {
          onDone(delta.state.current);
        }
      };
      const timer = setTimeout(() => onDone('timeout'), 30000); // страховка канала ответа
      chrome.downloads.onChanged.addListener(onChange);
    })
    .catch(err => {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    });

  return true; // ответ придёт асинхронно
});
