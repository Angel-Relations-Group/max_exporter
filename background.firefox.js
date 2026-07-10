// Background (Firefox event page): сохраняет файлы от имени расширения,
// обходя per-site запрос "automatic downloads" от <a download> в контенте.
//
// Event page умеет создавать object URL, а data: URL Firefox блокирует —
// поэтому файл упаковывается в blob: URL, скачивание запускается через
// chrome.downloads, а blob освобождается (revokeObjectURL) после
// завершения/таймаута. Ответ возвращается асинхронно.
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
      const timer = setTimeout(() => onDone('timeout'), 30000); // страховка канала ответа
      chrome.downloads.onChanged.addListener(onChange);
    })
    .catch(err => {
      cleanup();
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    });

  return true; // ответ придёт асинхронно
});
