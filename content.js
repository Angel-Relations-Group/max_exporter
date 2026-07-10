(function() {
  if (window.__maxExporterContentLoaded) return;
  window.__maxExporterContentLoaded = true;

  // Selectors use base class names only (without Svelte hash suffixes) for robustness
  // across MAX app builds. Svelte adds hash classes like "svelte-XXX" but the base
  // class name (history, item, bubble, text) is stable.
  const SEL_HISTORY = 'div.history';
  const SEL_ITEM = 'div.item';
  const SEL_BUBBLE = 'div.bubble';

  let RUNNING = false;
  let SHOULD_STOP = false;

  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
  // Poll a predicate: sleep(step), then check, up to `tries` times. Returns the
  // first truthy value (or null). Replaces manual polling loops.
  async function waitFor(pred, step, tries){ for(let i=0;i<tries;i++){ await sleep(step); const v=pred(); if(v) return v; } return null; }
  const pad = (n)=>String(n).padStart(2,'0');

  let _resolvedSlug = null;
  let _lastPathname = location.pathname;

  function resetOnNavigate() {
    const cur = location.pathname;
    if (cur !== _lastPathname) {
      _resolvedSlug = null;
      _lastPathname = cur;
    }
  }

  window.addEventListener('popstate', resetOnNavigate);

  const _linkByClean = new Map();   // identityKey -> post link (progress counter)
  const _linkByBubble = new WeakMap(); // bubble element -> post link (primary identity)
  let _capturedLink = null;

  // Listen for captured links from main-inject.js (clipboard interception)
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'MAX_EXPORT_CAPTURED_LINK' && e.data.link) {
      _capturedLink = e.data.link;
    }
  });

  // ---- Toast/snackbar suppression during export ----
  // Clicking "Copy link to post" makes the app show a "Вы скопировали ссылку на пост"
  // snackbar. During export we trigger many copies: the snackbars stack and linger
  // (they don't auto-dismiss quickly), and removing a node makes the app re-render it
  // from its internal queue. So suppression = CSS hiding + CONTINUOUS node removal via
  // a MutationObserver, kept active until the app's snackbar queue has drained.
  let _toastHider = null;
  let _toastSuppressing = false;
  let _snackbarObserver = null;
  const _snackbarSel = '.snackbar, [class*="snackbar"]';

  function _removeSnackbars() {
    document.querySelectorAll(_snackbarSel).forEach(el => { try { el.remove(); } catch(e){} });
  }
  function _startSnackbarObserver() {
    if (_snackbarObserver) return;
    _snackbarObserver = new MutationObserver(() => {
      if (_toastSuppressing) _removeSnackbars();
    });
    _snackbarObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function hideToasts() {
    _toastSuppressing = true;
    if (!_toastHider) {
      _toastHider = document.createElement('style');
      _toastHider.textContent = `
        .menuContainer,.actionsMenu,[class*="popoverPortal"],[class*="popover"]{display:none!important}
        .snackbar,.snackbar *,[class*="snackbar"]{display:none!important}
      `;
      document.head.appendChild(_toastHider);
    }
    _removeSnackbars();
    _startSnackbarObserver();
  }

  function stopToastSuppression() {
    _toastSuppressing = false;
    if (_snackbarObserver) {
      try { _snackbarObserver.disconnect(); } catch(e) {}
      _snackbarObserver = null;
    }
  }

  // Store a captured post link under both identity maps. The post link is the only
  // stable unique id; text/media tokens can collide, so it is the dedup key.
  function storeLink(bubble, link, text, token) {
    _linkByBubble.set(bubble, link);
    const dc = identityKey(text, token);
    if (!_linkByClean.has(dc)) _linkByClean.set(dc, link);
  }

  // Capture a link for one bubble via the context menu (skips already-captured).
  // Returns true on success.
  async function captureLinkForBubble(bubble, text, token) {
    if (_linkByBubble.has(bubble)) return true;
    const link = await getLinkForBubble(bubble);
    if (link) { storeLink(bubble, link, text, token); return true; }
    return false;
  }

  // Collect links for all currently visible messages via the context menu
  // "Copy link to post" (captured through the patched clipboard.writeText).
  async function collectLinksForVisible() {
    const hist = document.querySelector(SEL_HISTORY);
    if (!hist) return;
    const todo = [];
    for (const bubble of hist.querySelectorAll(SEL_BUBBLE)) {
      if (_linkByBubble.has(bubble)) continue;
      const text = extractBubbleText(bubble);
      if (text.length <= 2) continue;
      todo.push({ bubble, text, token: bubbleMediaToken(bubble) });
    }
    // First pass; retry once for bubbles whose capture raced.
    const missed = [];
    for (const m of todo) {
      if (SHOULD_STOP) break;
      if (!await captureLinkForBubble(m.bubble, m.text, m.token)) missed.push(m);
    }
    for (const m of missed) {
      if (SHOULD_STOP) break;
      await captureLinkForBubble(m.bubble, m.text, m.token);
    }
  }

  // Capture links for collected messages that are still missing one. Called after
  // the scroll loop, when the DOM holds the final set of messages.
  async function fillMissingLinks(results) {
    for (const m of results) {
      if (SHOULD_STOP) break;
      if (!m.bubble) continue;
      await captureLinkForBubble(m.bubble, m.text, m.token);
    }
  }

  // Determine the media type of a bubble that has no caption text.
  // Looks at the attachment block: div.sticker => Sticker, div.videoMessage
  // (round video / "circle" rendered on a canvas) => Circle, div.media
  // (div.video/<video> => Video, <audio>/.audio => Audio, <img>/.image => Photo),
  // or div.attaches => File. For audio/video/file the on-screen filename is
  // appended after the type ("File: report.pdf"); stickers, circles and photos
  // expose no filename and stay type-only.
  // Extract the on-screen filename for an audio/video/file attachment. Returns ''
  // when none is exposed (photo grids, voice messages, stickers, circles and
  // caption-less media clips have no filename in the DOM).
  function getMediaFileName(content) {
    const attaches = content.querySelector('.attaches');
    if (attaches) {
      const titles = attaches.querySelectorAll('.title');
      if (titles.length) {
        return Array.from(titles).map(t => (t.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ');
      }
    }
    const media = content.querySelector('.media');
    if (media) {
      // Some audio (music) / video uploads expose a track/document title.
      const nameEl = media.querySelector('.title, [class*="fileName"]');
      if (nameEl) {
        const t = (nameEl.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 2) return t;
      }
      // Fall back to a clean filename embedded in the media source URL.
      const srcEl = media.querySelector('video, audio, source');
      if (srcEl) {
        const src = srcEl.getAttribute('src') || '';
        const m = src.match(/([^\/?#]+\.(?:mp3|m4a|aac|ogg|wav|flac|mp4|webm|mov|avi|mkv|wmv))(?:[?#]|$)/i);
        if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
      }
    }
    return '';
  }

  function lbl(type, n){ return n ? type + ': ' + n : type; }

  function detectMediaType(bubble) {
    const content = bubble.querySelector('.bubbleContent') || bubble;
    const media = content.querySelector('.media');
    if (media) {
      if (media.querySelector('.video, video')) return lbl('Видео', getMediaFileName(content));
      if (media.querySelector('audio, .audio, .voice, .music')) return lbl('Аудио', getMediaFileName(content));
      // A .media block that is neither video nor audio is a photo grid. The
      // <img> may be lazy/unloaded, so don't require it to be present.
      return 'Фото';
    }
    const attaches = content.querySelector('.attaches');
    if (attaches) {
      // Audio (voice/music) attachments live in .attachAudio inside .attaches,
      // NOT in .media — detect them before falling back to a generic "File".
      if (attaches.querySelector('.attachAudio')) return lbl('Аудио', getMediaFileName(content));
      if (attaches.querySelector('.attachVideo, video')) return lbl('Видео', getMediaFileName(content));
      return lbl('Файл', getMediaFileName(content));
    }
    if (content.querySelector('.sticker')) return 'Стикер';
    if (content.querySelector('.videoMessage')) return 'Кружок';
    return '';
  }

  // Unique identifier for a media attachment (poster for video, src for image/audio).
  // Empty for text-only bubbles. Used to distinguish several media-only posts that
  // share the same caption-less text ("Video").
  function bubbleMediaToken(bubble) {
    const content = bubble.querySelector('.bubbleContent') || bubble;
    // Sticker: identify by its data-testid ("sticker-<id>") or image src so
    // several sticker-only posts (which all read as text "Sticker") stay distinct.
    const sticker = content.querySelector('.sticker');
    if (sticker) {
      const btn = sticker.querySelector('[data-testid^="sticker-"], button[aria-label="Стикер"]') || sticker;
      const testid = btn.getAttribute && btn.getAttribute('data-testid');
      if (testid) return 's:' + testid;
      const img = sticker.querySelector('img');
      if (img && img.getAttribute('src')) return 's:' + img.getAttribute('src');
    }
    // Video message ("circle"): rendered on a canvas, so there is no asset URL.
    // Identify it by its duration (.time) + meta (views/time) so several such
    // posts (which all read as text "Circle") stay distinct.
    const videoMessage = content.querySelector('.videoMessage');
    if (videoMessage) {
      const timeEl = videoMessage.querySelector('.time');
      const meta = bubble.querySelector('.meta');
      const dur = timeEl && timeEl.textContent ? timeEl.textContent.replace(/\s+/g, ' ').trim() : '';
      const mt = meta ? (meta.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 40) : '';
      return 'vm:' + dur + '|' + mt;
    }
    const media = content.querySelector('.media');
    if (media) {
      const video = media.querySelector('video');
      if (video) {
        const poster = video.getAttribute('poster');
        if (poster) return 'v:' + poster;
        const src = video.getAttribute('src');
        if (src) return 'v:' + src;
      }
      const img = media.querySelector('img');
      if (img && img.getAttribute('src')) return 'p:' + img.getAttribute('src');
      const audio = media.querySelector('audio');
      if (audio && audio.getAttribute('src')) return 'a:' + audio.getAttribute('src');
    } else {
      const attaches = content.querySelector('.attaches');
      if (attaches) return 'f:' + (attaches.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 120);
    }
    // Caption-less media/file post whose asset isn't currently in the DOM
    // (e.g. a photo scrolled out of view with its <img> unloaded). Fall back
    // to the views/time meta so several such posts keep distinct identity keys.
    if (media || content.querySelector('.attaches')) {
      const meta = bubble.querySelector('.meta');
      if (meta) return 'm:' + (meta.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 40);
    }
    return '';
  }

  // Identity key for deduplication and link association. Media-only posts would
  // otherwise all collapse to the same cleanText (e.g. "video"); appending the
  // unique media token keeps them distinct.
  function identityKey(text, token) {
    const dc = cleanText(text);
    return token ? dc + '|' + token.substring(0, 120) : dc;
  }

  // Extract the text from a bubble element (used by collectDomMessages)
  function extractBubbleText(bubble) {
    const content = bubble.querySelector('.bubbleContent') || bubble;
    // The caption is a direct child span.text of bubbleContent. If absent the
    // bubble is media-only — fall back to the media type label.
    const textEl = content.querySelector(':scope > span.text');
    let text = textEl ? textEl.innerText : detectMediaType(bubble);
    text = (text || '').replace(/\u00A0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return text;
  }

  // Get link for a single bubble via context menu "Copy link to post".
  // The menu render and the clipboard capture (patched navigator.clipboard.writeText
  // -> postMessage -> _capturedLink) are both async, so we poll instead of using fixed
  // sleeps, and retry once to avoid sporadic dropped links.
  const MENU_ITEM_SEL = '.menuContainer [class*="item"], .actionsMenu [class*="item"], .menuContainer button, .actionsMenu button, .actionsMenuItem';
  function dismissMenu() {
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', keyCode: 27, which: 27, bubbles: true}));
  }
  function findCopyLinkItem() {
    const items = document.querySelectorAll(MENU_ITEM_SEL);
    for (const it of items) {
      const label = (it.innerText || '') + ' ' + (it.textContent || '');
      if (label.includes('Скопировать ссылку')) return it;
    }
    return null;
  }
  async function getLinkForBubble(bubble) {
    async function attempt() {
      _capturedLink = null;
      dismissMenu();  // clear any stale menu first
      await sleep(20);
      bubble.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 300}));
      const item = await waitFor(findCopyLinkItem, 15, 20);
      if (!item) return null;
      item.click();
      const link = await waitFor(()=>_capturedLink, 15, 30);  // wait for clipboard capture
      _capturedLink = null;
      return link;
    }

    let link = null;
    // Signal the MAIN-world interceptor (main-inject.js) to capture the link
    // instead of writing to the clipboard. Use a DOM attribute (not a window
    // property): content scripts run in an isolated world invisible to MAIN.
    document.documentElement.setAttribute('data-max-export-capturing', '1');
    try {
      link = await attempt();
      if (!link) { await sleep(60); link = await attempt(); }  // one retry on race
    } finally {
      document.documentElement.removeAttribute('data-max-export-capturing');
    }
    dismissMenu();
    return link;
  }

  // Read the open channel's display name from the chat header (top bar). The
  // export filename always uses this title (e.g. "foo bar"), regardless of
  // whether the channel has a text slug or only a numeric id. Returns null when
  // no title element is found (e.g. header not yet rendered).
  function getChannelTitleFromDom() {
    const sels = [
      '.headerWrapper .title',
      '.header .content--left .title',
      '.headerWrapper .name'
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length >= 2) return t;
      }
    }
    return null;
  }

  // Make a free-form channel title safe to embed in a download filename across
  // Windows/macOS/Linux. Any run of whitespace and/or filesystem-reserved
  // characters is collapsed into a single underscore, so e.g. "foo bar "
  // becomes "foo_bar". Unicode letters (e.g. Cyrillic) are preserved.
  function sanitizeForFilename(name) {
    let s = (name || '').replace(/[\u0000-\u001f]/g, '').trim();
    s = s.replace(/[\s\u00A0\\/:*?"<>|]+/g, '_');
    s = s.replace(/^_+|_+$/g, '');
    if (!s) return '';
    if (s.length > 80) s = s.substring(0, 80).replace(/_+$/g, '');
    return s;
  }

  function findChannelSlug() {
    resetOnNavigate();
    if (_resolvedSlug) return _resolvedSlug;

    // The filename should always contain the channel's display name (e.g.
    // "foo bar"), not the link slug. Prefer the title read from the chat
    // header. This affects only the filename — links in the report still come
    // from clipboard capture and keep their original form (slug or numeric
    // /c/-<id>/).
    const titleSlug = sanitizeForFilename(getChannelTitleFromDom() || '');
    if (titleSlug) { _resolvedSlug = titleSlug; return titleSlug; }

    // Fallbacks when the header title is not available (header not rendered
    // during reload, etc.).
    const urlSlug = location.pathname.split('/').filter(Boolean)[0] || 'unknown';
    if (!/^-?\d+$/.test(urlSlug)) { _resolvedSlug = urlSlug; return urlSlug; }

    // URL-captured slug from sessionStorage (set by main-inject.js at document_start),
    // mapping a numeric channel id to its slug.
    try {
      const stored = JSON.parse(sessionStorage.getItem('_maxExportSlugMap') || '{}');
      if (stored[urlSlug]) { _resolvedSlug = stored[urlSlug]; return stored[urlSlug]; }
    } catch(e) {}

    // The canonical channel slug is embedded in every captured post link as
    // https://max.ru/<slug>/<postId>. Internal SPA navigation / server redirects
    // can load a channel directly at its numeric ID, leaving the sessionStorage
    // map above empty — but post links always carry the slug.
    const slugFromLink = _slugFromCapturedLinks();
    if (slugFromLink) {
      _resolvedSlug = slugFromLink;
      try {
        const map = JSON.parse(sessionStorage.getItem('_maxExportSlugMap') || '{}');
        map[urlSlug] = slugFromLink;
        sessionStorage.setItem('_maxExportSlugMap', JSON.stringify(map));
      } catch(e) {}
      return slugFromLink;
    }

    // Final fallback: numeric ID (post links in the report still come from the
    // posts themselves via clipboard capture, so this only affects the filename).
    _resolvedSlug = urlSlug;
    return urlSlug;
  }

  // Extract a non-numeric channel slug from any captured post link. MAX exposes
  // links as https://max.ru/<slug>/<postId>; the slug segment is the canonical
  // username. Returns null when no usable link has been captured yet.
  function _slugFromCapturedLinks() {
    const links = [];
    _linkByClean.forEach(l => links.push(l));
    for (const link of links) {
      if (typeof link !== 'string') continue;
      const m = link.match(/max\.ru\/([a-zA-Z][a-zA-Z0-9_]{1,31})(?:[/?#]|$)/);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  (function checkPendingExport() {
    const pending = sessionStorage.getItem('max_export_pending');
    if (!pending) return;
    sessionStorage.removeItem('max_export_pending');

    let params;
    try {
      params = JSON.parse(pending);
    } catch(e) {
      setProgress('Ошибка: повреждённые данные экспорта');
      return;
    }

    (async () => {
      const panel = ensurePanel();
      panel.style.display = 'block';
      panel.querySelector('#max-exporter-stop').style.display = 'block';
      setProgress('Перезагрузка... ожидание загрузки чата...');

      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        if (document.querySelector(SEL_HISTORY) &&
            document.querySelector(SEL_ITEM)) break;
      }

      let prevDom = 0;
      let stable = 0;
      while (stable < 3) {
        await sleep(1000);
        const hist = document.querySelector(SEL_HISTORY);
        const domCount = hist ? hist.querySelectorAll(SEL_ITEM).length : 0;
        setProgress(`Ожидание загрузки... сообщений в DOM: ${domCount}`);
        if (domCount === prevDom) {
          stable++;
        } else {
          stable = 0;
          prevDom = domCount;
        }
      }

      RUNNING = true;
      doExport(params).catch(e => {
        setProgress('Ошибка: ' + e.message);
        finalizeExport();
      });
    })();
  })();

  // After an export finishes we reload the page to clear the app's in-memory
  // snackbar queue (the copies during link collection enqueue many "You copied
  // the link to the post" notifications). The completion message is persisted
  // here and shown again after the reload.
  (function showLastResult() {
    const stored = sessionStorage.getItem('max_export_result');
    if (!stored) return;
    sessionStorage.removeItem('max_export_result');
    let info;
    try { info = JSON.parse(stored); } catch(e) { return; }
    const panel = ensurePanel();
    panel.style.display = 'block';
    panel.querySelector('#max-exporter-stop').style.display = 'none';
    panel.querySelector('#max-exporter-close-panel').style.display = 'block';
    setProgress(info.text || 'Готов.');
  })();

  function ensurePanel(){
    let el = document.getElementById('max-exporter-panel');
    if(el) return el;
    el = document.createElement('div');
    el.id = 'max-exporter-panel';
    el.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px;">MAX Export</div>
      <div class="muted">Экспорт сообщений: целевое количество + сортировка по времени.</div>
      <div id="max-exporter-progress" class="mono" style="margin-top:8px;">Готов.</div>
      <button id="max-exporter-stop" style="display:none;">Стоп</button>
      <button id="max-exporter-close-panel" style="display:none;">Закрыть</button>
    `;
    document.documentElement.appendChild(el);
    el.querySelector('#max-exporter-stop').addEventListener('click', ()=>{ SHOULD_STOP = true; });
    el.querySelector('#max-exporter-close-panel').addEventListener('click', ()=>{ el.style.display = 'none'; });
    return el;
  }
  function setProgress(t){
    ensurePanel().querySelector('#max-exporter-progress').textContent = t;
  }

  // Mark the panel as finished: stop button hidden, close button shown, RUNNING
  // cleared so a new export can start. Used on every exit path (validation
  // failure, errors, success) so the user is never stuck with RUNNING == true.
  function markPanelFinished(){
    RUNNING = false;
    const panel = ensurePanel();
    panel.querySelector('#max-exporter-stop').style.display = 'none';
    panel.querySelector('#max-exporter-close-panel').style.display = 'block';
  }

  // Full teardown after an export that actually ran (links were collected, so
  // snackbar suppression is active): disconnect the snackbar observer, persist the
  // final progress text for re-display after reload, then reload to drop the
  // app's in-memory snackbar queue.
  function finalizeExport(){
    markPanelFinished();
    stopToastSuppression();
    try {
      sessionStorage.setItem('max_export_result', JSON.stringify({
        text: ensurePanel().querySelector('#max-exporter-progress').textContent
      }));
    } catch(e) {}
    location.reload();
  }

  function parseInputDate(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.split('-');
    if (parts.length !== 3) return null;
    const date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (isNaN(date.getTime())) return null;
    return date;
  }

  function formatTime(epochMs) {
    if (!epochMs) return '';
    const d = new Date(epochMs);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function csvSafe(v){
    let s = v == null ? '' : String(v);
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function toExcelCsv(rows){
    const header = ['datetime','post_link','text','views','reactions_total'];
    const lines = [];
    lines.push(header.map(csvSafe).join(';'));
    for(const r of rows){
      lines.push([
        csvSafe(r.datetime || ''),
        csvSafe(r.post_link || ''),
        csvSafe(r.text || ''),
        csvSafe(r.views ?? ''),
        csvSafe(r.reactions_total ?? '')
      ].join(';'));
    }
    return '\uFEFF' + lines.join('\r\n');
  }

  // Sends the file content to the background, which builds a blob and saves it
  // via chrome.downloads. Resolves with the background response, or an error
  // from chrome.runtime.lastError / a missing response.
  function downloadFile(content, filename, mime){
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'MAX_EXPORT_DOWNLOAD', content, filename, mime },
        (resp) => {
          const err = chrome.runtime.lastError;
          if (err) resolve({ ok: false, error: err.message });
          else resolve(resp || { ok: false, error: 'нет ответа от фоновой службы (перезагрузите расширение)' });
        }
      );
    });
  }

  function validateRequiredElements(){
    return !!(document.querySelector(SEL_HISTORY) && document.querySelector(SEL_ITEM));
  }

  function getScrollable() {
    const history = document.querySelector(SEL_HISTORY);
    if (!history) return null;
    let el = history.querySelector('.scrollable');
    if (el) return el;
    for (const child of history.querySelectorAll('*')) {
      if (child.scrollHeight > child.clientHeight + 1) {
        const style = getComputedStyle(child);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay') return child;
      }
    }
    return null;
  }

  function scrollChat(position) {
    const el = getScrollable();
    if (!el) return;
    el.scrollTop = position === 'top' ? 0 : el.scrollHeight;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  }

  // Robustly scroll the channel to its very newest message and wait until the DOM
  // stops growing there. When a channel has unread messages, MAX opens it at the
  // first unread position and the newest messages may not yet be rendered. Clicking
  // the "jump to latest" scroll button (if present) + repeated scroll-to-bottom
  // forces those newest messages to load before the upward export scroll begins.
  function findJumpToLatestButton() {
    const counter = document.querySelector('span.scrollButtonCounter');
    if (counter) return counter.closest('button, [role="button"], .scrollButton') || counter;
    return null;
  }

  async function scrollToNewestMessages() {
    const historyEl = document.querySelector(SEL_HISTORY);
    const domCount = () => historyEl ? historyEl.querySelectorAll(SEL_ITEM).length : 0;

    let prevCount = 0;
    let stable = 0;
    // Keep scrolling/clicking to the bottom until the newest messages are loaded
    // (DOM count stops growing AND the unread jump button is gone).
    for (let i = 0; i < 80; i++) {
      const btn = findJumpToLatestButton();
      if (btn) { try { btn.click(); } catch(e){} }
      scrollChat('bottom');
      await sleep(350);

      const cur = domCount();
      if (cur === prevCount) {
        stable++;
      } else {
        stable = 0;
        prevCount = cur;
      }
      // Require stability AND no remaining unread jump button.
      if (stable >= 4 && !findJumpToLatestButton()) break;
    }

    // Final settle: ensure we're pinned to the absolute bottom.
    scrollChat('bottom');
    await sleep(400);
    scrollChat('bottom');
  }

  const EXCLUDE_EXACT = ['трансляция началась', 'трансляция закончилась'];
  function isExcludedMessage(text) {
    const norm = (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return EXCLUDE_EXACT.includes(norm);
  }

  function cleanText(text) {
    return (text || '').replace(/[^\p{L}\p{N}]/gu, ' ').replace(/\s+/g, ' ').trim().substring(0, 150).toLowerCase();
  }

  const RU_MONTHS = {'января':0,'февраля':1,'марта':2,'апреля':3,'мая':4,'июня':5,'июля':6,'августа':7,'сентября':8,'октября':9,'ноября':10,'декабря':11};

  function parseCapsuleDate(s) {
    if (!s) return null;
    s = s.trim().toLowerCase();
    const now = new Date();
    if (s === 'сегодня' || s === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (s === 'вчера' || s === 'yesterday') return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
    const m = s.match(/(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?/);
    if (m) {
      const mon = RU_MONTHS[m[2]];
      if (mon == null) return null;
      const year = m[3] ? parseInt(m[3], 10) : now.getFullYear();
      return new Date(year, mon, parseInt(m[1], 10)).getTime();
    }
    const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10)).getTime();
    return null;
  }

  function parseTimeOfDay(s) {
    const m = /(\d{1,2}):(\d{2})/.exec(s || '');
    if (!m) return 0;
    return (parseInt(m[1], 10) % 24) * 3600000 + parseInt(m[2], 10) * 60000;
  }

  function nodeTimeMs(node) {
    // MAX displays message time inside a .meta element. But media players
    // (audio/video attachments, "circles") ALSO contain a .meta showing the media DURATION,
    // and that one appears BEFORE the message's real .meta in DOM order.
    // Skip any .meta inside a media/attachment player, otherwise the
    // audio duration (e.g. "01:10") is read as the message time of day.
    for (const meta of node.querySelectorAll('.meta')) {
      if (meta.closest('.media, .attaches, .attachAudio, .attachVideo, .attachDocument, .videoMessage, .audio, .video, .duration')) continue;
      const t = (meta.innerText || '').trim();
      const m = t.match(/(\d{1,2}):(\d{2})/);
      if (m) return parseTimeOfDay(m[0]);
    }
    // Fallback: first element whose entire text is HH:MM,
    // skipping non-time elements (durations, views, counters, headers)
    for (const el of node.querySelectorAll('*')) {
      if (el.closest('.duration, .views, .counter, .reaction, .header, .link, .author, .name')) continue;
      const t = (el.innerText || '').trim();
      if (/^\d{1,2}:\d{2}$/.test(t)) return parseTimeOfDay(t);
    }
    return 0;
  }

  function getOldestVisibleDateMs() {
    const hist = document.querySelector(SEL_HISTORY);
    if (!hist) return Infinity;
    let oldest = Infinity;
    hist.querySelectorAll('span.capsule').forEach(c => {
      const t = parseCapsuleDate(c.textContent);
      if (t != null) oldest = Math.min(oldest, t);
    });
    return oldest;
  }

  function parseViews(text) {
    if (!text) return 0;
    const t = text.trim().toLowerCase().replace(/\s/g, '').replace(',', '.');
    const m = t.match(/([\d.]+)\s*([kкmм])?/);
    if (!m) return 0;
    let n = parseFloat(m[1]);
    if (isNaN(n)) return 0;
    if (m[2] === 'k' || m[2] === 'к') n *= 1000;
    if (m[2] === 'm' || m[2] === 'м') n *= 1000000;
    return Math.round(n);
  }

  function collectDomMessages() {
    const out = [];
    const hist = document.querySelector(SEL_HISTORY);
    if (!hist) {
      return out;
    }
    let curDateMs = null;
    const items = hist.querySelectorAll(SEL_ITEM);

    items.forEach(item => {
      const cap = item.querySelector('span.capsule, [class*="capsule"]');
      if (cap) {
        const d = parseCapsuleDate(cap.textContent);
        if (d != null) curDateMs = d;
      }

      // Primary: use SEL_BUBBLE; Fallback: try generic selectors
      let bubbles = item.querySelectorAll(SEL_BUBBLE);
      if (bubbles.length === 0) {
        // Fallback selectors for different MAX layouts
        bubbles = item.querySelectorAll('[class*="bubble"], [class*="message"], [class*="content"]');
      }

      bubbles.forEach(bubble => {
        const text = extractBubbleText(bubble);
        if (text.length <= 2) return;
        const ctx = bubble.closest('.messageWrapper') || bubble.closest('.block') || bubble.closest('[class*="wrapper"]') || bubble;

        // Search for time in the widest context (the item element) to find HH:MM
        const tod = nodeTimeMs(item);
        const time = curDateMs != null ? curDateMs + tod : 0;

        let reactions = 0;
        ctx.querySelectorAll('.reaction .counter').forEach(c => {
          const n = parseInt((c.textContent || '').trim(), 10);
          if (!isNaN(n)) reactions += n;
        });

        let views = 0;
        const viewEl = ctx.querySelector('[class*="views" i]');
        if (viewEl) views = parseViews(viewEl.textContent);

        out.push({ text, token: bubbleMediaToken(bubble), bubble, time, reactions, views });
      });
    });
    return out;
  }

  async function doExport(params) {
    const {maxScrolls, format, startDate, endDate, startDateSet, endDateSet, paginationEnabled, paginationRows} = params;

    if(!validateRequiredElements()){
      setProgress('Ошибка: не найдены элементы чата на странице');
      markPanelFinished();
      return;
    }

    SHOULD_STOP = false;

    // Suppress "You copied the link to the post" snackbars for the whole export.
    // Link collection triggers many copies; without this the snackbars stack up.
    hideToasts();

    const parsedStartDate = parseInputDate(startDate);
    const parsedEndDate = parseInputDate(endDate);
    const startMs = parsedStartDate ? parsedStartDate.getTime() : 0;
    const endMs = parsedEndDate ? parsedEndDate.getTime() + 86400000 : Infinity;
    const useDateRange = !!(startDateSet && parsedStartDate) || !!(endDateSet && parsedEndDate);

    const effectiveMaxScrolls = useDateRange ? 9999 : Math.min(maxScrolls, 500);
    const maxStable = useDateRange ? 20 : 12;
    let stableRounds = 0;
    let prevDomCount = 0;

    const historyEl = document.querySelector(SEL_HISTORY);

    // Scroll down to load the most recent messages — the loop will then scroll
    // upward, loading progressively older ones. If the channel has unread
    // messages, MAX opens it at the first unread one, so the newest messages may
    // not be loaded yet. Force-scroll to the very latest message and wait for
    // stabilization.
    setProgress(`Загрузка свежих сообщений... DOM: ${historyEl ? historyEl.querySelectorAll(SEL_ITEM).length : 0}`);
    await scrollToNewestMessages();

    // Collect links for initially visible messages
    setProgress(`Сбор ссылок... DOM: ${historyEl ? historyEl.querySelectorAll(SEL_ITEM).length : 0}`);
    await collectLinksForVisible();

    for(let i = 1; i <= effectiveMaxScrolls; i++){
      if(SHOULD_STOP) break;

      scrollChat('top');
      await sleep(350);

      if(useDateRange) {
        const oldest = getOldestVisibleDateMs();
        if(oldest < Infinity && oldest < startMs) {
          setProgress(`Дата начала достигнута. DOM: ${historyEl ? historyEl.querySelectorAll(SEL_ITEM).length : 0}`);
          break;
        }
      }

      const curDomCount = historyEl ? historyEl.querySelectorAll(SEL_ITEM).length : 0;

      if(curDomCount === prevDomCount) {
        stableRounds++;
      } else {
        stableRounds = 0;
        prevDomCount = curDomCount;
      }

      setProgress(`Шаг ${i}/${effectiveMaxScrolls} | DOM: ${curDomCount} | Ссылок: ${_linkByClean.size}`);

      // Collect links for newly visible messages
      await collectLinksForVisible();

      if(stableRounds >= maxStable) break;
    }

    await sleep(1000);

    const collected = collectDomMessages();

    // The post link is the only stable unique identifier (MAX exposes no message
    // id in the DOM, and caption-less media posts collide on text/media tokens).
    // Capture a link for every collected bubble before deduping.
    await fillMissingLinks(collected);

    // Resolve the channel slug AFTER link collection: the canonical slug is
    // embedded in the captured post links, so we need them populated first.
    const slug = await findChannelSlug();

    const seen = new Set();
    let results = [];

    for (const m of collected) {
      const link = (m.bubble && _linkByBubble.get(m.bubble)) || '';
      const key = link || identityKey(m.text, m.token);
      if (seen.has(key)) continue;
      seen.add(key);
      if (isExcludedMessage(m.text)) continue;
      m._link = link;
      results.push(m);
    }

    if(useDateRange) {
      results = results.filter(m => m.time >= startMs && m.time <= endMs);
    }

    results.sort((a, b) => a.time - b.time);

    const out = results.map(m => {
      return {
        datetime: m.time ? formatTime(m.time) : '',
        post_link: m._link || '',
        text: m.text,
        views: m.views || '',
        reactions_total: m.reactions || ''
      };
    });

    try {
      if (out.length === 0) {
        setProgress('Нет сообщений за выбранный период.');
        return;
      }
      const now = new Date();
      const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      const chunkSize = (paginationEnabled && paginationRows > 0) ? paginationRows : out.length;
      const totalParts = Math.ceil(out.length / chunkSize);

      let downloadErrors = [];
      for (let part = 0; part < totalParts; part++) {
        if (SHOULD_STOP) break;
        const chunk = out.slice(part * chunkSize, (part + 1) * chunkSize);
        const suffix = totalParts > 1 ? `_part${part + 1}of${totalParts}` : '';

        setProgress(`Сохранение файла ${part + 1} из ${totalParts}...`);

        const content = format === 'json' ? JSON.stringify(chunk, null, 2) : toExcelCsv(chunk);
        const filename = format === 'json'
          ? `max_${slug}_${ts}${suffix}.json`
          : `max_${slug}_${ts}${suffix}.csv`;
        const mime = format === 'json' ? 'application/json' : 'text/csv;charset=utf-8;';

        const resp = await downloadFile(content, filename, mime);
        if (!resp || !resp.ok) {
          const detail = (resp && resp.error) || 'неизвестная ошибка';
          downloadErrors.push(`Файл ${part + 1}: ${detail}`);
        }
      }

      if (downloadErrors.length) {
        setProgress(`Ошибки скачивания:\n${downloadErrors.join('\n')}`);
      } else {
        const partInfo = totalParts > 1 ? ` в ${totalParts} файлах (${chunkSize} строк/файл)` : '';
        setProgress(`Готово.
${format.toUpperCase()}: ${out.length} сообщений${partInfo}
Сохранение файла запущено.`);
      }
    } catch (e) {
      setProgress(`Ошибка скачивания:\n${e.message}`);
    } finally {
      // Reload to clear the app's in-memory snackbar queue. During the export we
      // triggered many "Copy link" actions, each enqueuing a snackbar; they are only
      // kept in JS memory, so a reload drops them all. The progress text is persisted
      // and re-shown after the reload (see showLastResult). The MutationObserver is
      // now disconnected (no more copies to handle); the CSS hider remains until the
      // reload so queued snackbars don't flash.
      finalizeExport();
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
    if(msg?.type === 'MAX_EXPORT_START'){
      if(RUNNING){
        sendResponse({ok:false, error:'Уже запущено'});
        return;
      }
      _resolvedSlug = null;
      RUNNING = true;
      sendResponse({ok:true});
      sessionStorage.setItem('max_export_pending', JSON.stringify(msg));
      location.reload();
      return;
    }
    if(msg?.type === 'MAX_EXPORT_STOP'){
      SHOULD_STOP = true;
      sendResponse({ok:true});
    }
  });
})();