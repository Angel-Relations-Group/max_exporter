(function() {
  if (window.__maxExporterContentLoaded) return;
  window.__maxExporterContentLoaded = true;

  // Selectors use base class names only (without Svelte hash suffixes) for robustness
  // across MAX app builds. Svelte adds hash classes like "svelte-XXX" but the base
  // class name (history, item, bubble, text) is stable.
  const SEL_HISTORY = 'div.history';
  const SEL_ITEM = 'div.item';
  const SEL_BUBBLE = 'div.bubble';
  // sessionStorage key for the multi-session export state (declared here —
  // early in the file — because checkPendingExport below reads it during the
  // initial script evaluation, before the later storage helpers execute).
  const SESSION_KEY = 'max_export_session';

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
  const _mediaByBubble = new WeakMap(); // bubble element -> discovered photo URLs
  const _recordByBubble = new WeakMap(); // bubble element -> this session's record (photo pass)
  let _collectMedia = false; // "download photos" enabled — collect image URLs while scanning
  let _capturedLink = null;

  // ---- Photo URL discovery (batch media download) ----
  // MAX renders photos lazily: an <img> outside the viewport keeps a tiny
  // data:-URI placeholder instead of its src, and a loaded one exposes its CDN
  // link (i.oneme.ru). Collect real http(s) URLs per bubble and merge across
  // passes; the final report lists them and the download step fetches each at
  // original quality into a per-export media/ folder.

  // Real (downloadable) photo URLs of one <img>, best first. MAX renders photos
  // lazily: until an image enters the viewport its src holds a tiny inlined
  // webp placeholder (data:image/webp;base64 — a blurred LQIP of a few hundred
  // bytes). Placeholders are never real media, so only http(s) URLs qualify.
  function imgRealUrls(img) {
    const urls = [];
    const push = (raw) => {
      if (!raw) return;
      const url = normalizeMediaUrl(raw);
      if (url && /^https?:/.test(url)) urls.push(url);
    };
    push(img.currentSrc);
    push(img.getAttribute('src'));
    // srcset variants, largest width descriptor first (rarely used by MAX).
    (img.getAttribute('srcset') || '').split(',').map(s => s.trim()).filter(Boolean)
      .map(part => {
        const m = part.match(/^(\S+)(?:\s+(\d+)w)?$/);
        return m ? { url: m[1], w: m[2] ? parseInt(m[2], 10) : 0 } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.w - a.w)
      .forEach(v => push(v.url));
    ['data-src', 'data-original', 'data-url'].forEach(a => push(img.getAttribute(a)));
    return [...new Set(urls)];
  }

  function normalizeMediaUrl(url) {
    if (!url) return '';
    try { return new URL(url, location.href).href; } catch(e) { return url; }
  }

  // The .media block that actually carries the photo (as opposed to avatars,
  // tiny inline previews or video/audio players), scored by rendered area.
  function findPhotoMedia(content) {
    const candidates = [];
    content.querySelectorAll('.media').forEach(media => {
      if (media.closest('.avatar, .author, .sender, .meta, .reaction, .reactions')) return;
      if (media.querySelector('video, audio, .video, .audio, .voice, .music')) return;
      const rect = media.getBoundingClientRect();
      const mediaArea = Math.max(0, rect.width) * Math.max(0, rect.height);
      let largestImageArea = 0;
      media.querySelectorAll('img').forEach(img => {
        const width = img.naturalWidth || img.clientWidth || 0;
        const height = img.naturalHeight || img.clientHeight || 0;
        largestImageArea = Math.max(largestImageArea, width * height);
      });
      const hasPhotoShape = mediaArea >= 12000 || largestImageArea >= 40000 ||
        !!media.querySelector('picture, source, [class*="photo" i], [class*="image" i]');
      if (hasPhotoShape) candidates.push({ media, score: Math.max(mediaArea, largestImageArea) });
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].media : null;
  }

  function extractPhotoUrls(bubble) {
    const content = bubble.querySelector('.bubbleContent') || bubble;
    const media = findPhotoMedia(content);
    if (!media) return [];
    const found = [];
    // One best URL per <img> (previously every candidate variant was kept and
    // later saved as a separate file, flooding media/ with duplicates).
    media.querySelectorAll('img').forEach(img => {
      const width = img.naturalWidth || img.clientWidth || 0;
      const height = img.naturalHeight || img.clientHeight || 0;
      if (width && height && width * height < 40000) return;
      const urls = imgRealUrls(img);
      if (urls.length) found.push(urls[0]);
    });
    media.querySelectorAll('source').forEach(srcsetEl => {
      const part = (srcsetEl.getAttribute('srcset') || '').split(',').map(s => s.trim()).filter(Boolean).pop();
      if (!part) return;
      const url = normalizeMediaUrl(part.split(/\s+/)[0]);
      if (url && /^https?:/.test(url)) found.push(url);
    });
    // Only direct image links: a plain <a> inside .media is usually the target
    // article of a link preview — downloading it would save an HTML page.
    media.querySelectorAll('a[href]').forEach(a => {
      const href = normalizeMediaUrl(a.getAttribute('href'));
      if (href && /^https?:/.test(href) &&
          (/^https:\/\/i\.oneme\.ru\//.test(href) || /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i.test(href))) {
        found.push(href);
      }
    });
    media.querySelectorAll('*').forEach(el => {
      const bg = getComputedStyle(el).backgroundImage || '';
      const match = bg.match(/^url\(["']?(.*?)["']?\)$/);
      if (match) {
        const url = normalizeMediaUrl(match[1]);
        if (url && /^https?:/.test(url)) found.push(url);
      }
    });
    return [...new Set(found)];
  }

  // Merge freshly discovered URLs into the per-bubble set (images keep loading
  // as the chat scrolls, so later passes may see more candidates).
  function rememberMedia(bubble) {
    const fresh = extractPhotoUrls(bubble);
    const known = _mediaByBubble.get(bubble) || [];
    const merged = [...new Set([...known, ...fresh])];
    if (merged.length) _mediaByBubble.set(bubble, merged);
    return merged;
  }

  // MAX lazy-loads old photos only while the bubble is actually inside the
  // viewport. Bring it to the centre and wait; never open the photo viewer,
  // because MAX does not expose a reliable programmatic close action.
  async function ensurePhotoUrlsForBubble(bubble) {
    let urls = rememberMedia(bubble);
    if (urls.length || detectMediaType(bubble) !== 'Фото') return urls;
    try {
      bubble.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    } catch(e) {}
    for (let i = 0; i < 25 && !urls.length; i++) {
      await sleep(100);
      urls = rememberMedia(bubble);
    }
    return urls;
  }

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
  // Inspect only freshly ADDED nodes (and skip mutations inside the chat
  // history, which dominate during scrolling) instead of re-querying the whole
  // document on every mutation batch — a full-document [class*="snackbar"]
  // scan per batch made exports progressively slower as the DOM grew.
  function _nodeLooksSnackbar(el) {
    try { return !!(el.matches && el.matches(_snackbarSel)); } catch(e) { return false; }
  }
  function _startSnackbarObserver() {
    if (_snackbarObserver) return;
    _snackbarObserver = new MutationObserver((muts) => {
      if (!_toastSuppressing) return;
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (!n || n.nodeType !== 1) continue;
          if (n.closest && n.closest(SEL_HISTORY)) continue;
          if (_nodeLooksSnackbar(n)) { try { n.remove(); } catch(e){} continue; }
          if (n.querySelectorAll) {
            let inner = null;
            try { inner = n.querySelectorAll(_snackbarSel); } catch(e) {}
            if (inner) inner.forEach(el => { try { el.remove(); } catch(e){} });
          }
        }
      }
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

  // ---- Incremental message processing ----
  // Messages are processed as the upward scroll encounters them: capture the
  // post link, record the row (text/time/views/reactions) right away.
  //
  // IMPORTANT (verified live on max.ru): the app keeps every loaded message
  // mounted in its Svelte tree no matter what we do to the DOM — hiding items
  // frees no memory, and removing nodes outright breaks history loading (the
  // app re-renders in a spiral and stops prepending). Memory is therefore NOT
  // bounded by DOM tricks but by splitting the export into page-reload
  // sessions (see doExportSession); a processed item is only marked as done so
  // later scans skip it, and its media players are neutralized (the feed
  // autoplays videos, which burns RAM/CPU).
  let _records = [];          // this session's rows: {key, link, text, time, views, reactions}
  let _seenKeys = new Set();  // link || identityKey — row-level dedup (session)
  let _linksCount = 0;
  let _useDateRange = false;
  let _startMs = 0;
  let _endMs = Infinity;
  const _releasedItems = new WeakSet();
  const _doneBubbles = new WeakSet();
  const _bubbleTries = new WeakMap();
  const _itemDateCache = new WeakMap(); // released item -> date (ms) in effect after it
  const _MAX_CAPTURE_TRIES = 4;
  // Reload the page once the retained DOM reaches this many chat items; the
  // next session deep-links to the oldest captured post and continues. ~800
  // items keeps the tab in the low-gigabyte range even for huge channels.
  const SESSION_ITEM_LIMIT_DEFAULT = 800;

  function releaseItem(item, dateAfterMs) {
    if (_releasedItems.has(item)) return;
    _releasedItems.add(item);
    _itemDateCache.set(item, { after: dateAfterMs == null ? null : dateAfterMs });
    try { item.dataset.maxExportDone = '1'; } catch(e) {}
    try {
      // Stop autoplaying media in processed items; everything stays visible.
      item.querySelectorAll('video').forEach(v => {
        try { v.pause(); } catch(e) {}
        try { if (v.srcObject) v.srcObject = null; } catch(e) {}
        v.removeAttribute('src');
        try { v.load(); } catch(e) {}
      });
      item.querySelectorAll('audio').forEach(a => {
        try { a.pause(); } catch(e) {}
        a.removeAttribute('src');
        try { a.load(); } catch(e) {}
      });
    } catch(e) {}
  }

  // Extract the exportable row fields that come straight from the DOM (no link).
  function buildMessageRecord(bubble, text, time, link, idKey) {
    const ctx = bubble.closest('.messageWrapper') || bubble.closest('.block') || bubble.closest('[class*="wrapper"]') || bubble;
    let reactions = 0;
    ctx.querySelectorAll('.reaction .counter').forEach(c => {
      const n = parseInt((c.textContent || '').trim(), 10);
      if (!isNaN(n)) reactions += n;
    });
    let views = 0;
    const viewEl = ctx.querySelector('[class*="views" i]');
    if (viewEl) views = parseViews(viewEl.textContent);
    const rec = { key: link || ('i:' + idKey), link: link || '', text, time, views, reactions };
    if (_collectMedia) {
      rec.mediaUrls = rememberMedia(bubble);
      rec.expectedPhoto = detectMediaType(bubble) === 'Фото';
    }
    _recordByBubble.set(bubble, rec);
    return rec;
  }

  // One pass over the currently loaded chat DOM (top -> bottom = oldest ->
  // newest). Date context is tracked at the BUBBLE level: day-separator
  // capsules and bubbles are visited together in document order, because one
  // div.item can contain several capsules AND message blocks (verified on
  // MAX), and a per-item date misdates messages at day boundaries. Messages
  // outside the requested date range are skipped entirely — no context-menu
  // round trip, no snackbar, no counting.
  // finalPass (after the scroll loop): records bubbles whose capture kept
  // failing with an empty link instead of leaving them unprocessed.
  async function processLoadedMessages(finalPass) {
    const hist = document.querySelector(SEL_HISTORY);
    if (!hist) return;
    let curDateMs = null;
    const items = hist.querySelectorAll(SEL_ITEM);

    for (const item of items) {
      if (_releasedItems.has(item)) {
        const c = _itemDateCache.get(item);
        if (c && c.after != null) curDateMs = c.after;
        continue;
      }

      const useFallback = !item.querySelector(SEL_BUBBLE);
      const walkSel = useFallback
        ? 'span.capsule, [class*="bubble"], [class*="message"], [class*="content"]'
        : 'span.capsule, ' + SEL_BUBBLE;

      let pending = false;
      for (const node of item.querySelectorAll(walkSel)) {
        if (node.matches('span.capsule')) {
          const d = parseCapsuleDate(node.textContent);
          if (d != null) curDateMs = d;
          continue;
        }
        const bubble = node;
        if (_doneBubbles.has(bubble)) continue;
        const text = extractBubbleText(bubble);
        if (text.length <= 2 || isExcludedMessage(text)) { _doneBubbles.add(bubble); continue; }
        const block = bubble.closest('.block');
        const tod = nodeTimeMs(block || item);  // per-message time of day
        const t = curDateMs != null ? curDateMs + tod : null;

        // Outside the requested range: never capture a link for this message.
        if (_useDateRange && t != null && (t > _endMs || t < _startMs)) {
          _doneBubbles.add(bubble);
          continue;
        }

        const token = bubbleMediaToken(bubble);
        const idKey = identityKey(text, token);
        let link = _linkByClean.get(idKey) || null;
        if (!link) {
          const tries = (_bubbleTries.get(bubble) || 0) + 1;
          _bubbleTries.set(bubble, tries);
          if (!SHOULD_STOP && tries <= _MAX_CAPTURE_TRIES) {
            link = await getLinkForBubble(bubble);
            if (link) storeLink(bubble, link, text, token);
          }
        } else {
          _linkByBubble.set(bubble, link);
        }
        if (link) {
          _doneBubbles.add(bubble);
          if (!_seenKeys.has(link)) {
            _seenKeys.add(link);
            _records.push(buildMessageRecord(bubble, text, t == null ? 0 : t, link, idKey));
            _linksCount++;
          }
        } else if (finalPass || (_bubbleTries.get(bubble) || 0) >= _MAX_CAPTURE_TRIES) {
          // Completeness first: keep the row, the link stays empty.
          _doneBubbles.add(bubble);
          if (!_seenKeys.has(idKey)) {
            _seenKeys.add(idKey);
            _records.push(buildMessageRecord(bubble, text, t == null ? 0 : t, '', idKey));
          }
        } else {
          pending = true; // transient capture race — retry on a later pass
        }
      }
      if (!pending) releaseItem(item, curDateMs);
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
    const photoMedia = findPhotoMedia(content);
    const media = photoMedia || content.querySelector('.media');
    if (media) {
      if (media.querySelector('.video, video')) return lbl('Видео', getMediaFileName(content));
      if (media.querySelector('audio, .audio, .voice, .music')) return lbl('Аудио', getMediaFileName(content));
      // A .media block that is neither video nor audio nor a small non-photo
      // preview is a photo grid. The <img> may be lazy/unloaded, so don't
      // require it to be present.
      if (photoMedia) return 'Фото';
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

  // Extract the text from a bubble element (used by processLoadedMessages)
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
  // Force-remove leftover context menus. On a sluggish page the app can be
  // slow to tear the previous menu down, and findCopyLinkItem() would then
  // click the STALE item — capturing the previous post's link for this bubble
  // (that message then vanishes from the export as a "duplicate"). Removing
  // menu nodes before every attempt makes any menu we find provably fresh.
  const MENU_CONTAINER_SEL = '.actionsMenu, .menuContainer, [class*="actionsMenu"], [class*="menuContainer"]';
  function removeMenus() {
    document.querySelectorAll(MENU_CONTAINER_SEL).forEach(el => { try { el.remove(); } catch(e){} });
  }
  async function getLinkForBubble(bubble) {
    async function attempt() {
      _capturedLink = null;
      removeMenus();
      dismissMenu();
      await sleep(30);
      removeMenus();  // the app may tear its menu down asynchronously
      bubble.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 300}));
      const item = await waitFor(findCopyLinkItem, 15, 20);
      if (!item) return null;
      item.click();
      const link = await waitFor(()=>_capturedLink, 15, 30);  // wait for clipboard capture
      _capturedLink = null;
      removeMenus();
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
    // Two entry points:
    //  * 'max_export_pending'      — a fresh export request from the popup
    //  * 'max_export_session'      — the next session of a running multi-session
    //                                export (page was reloaded/deep-linked)
    let st = null;
    const pending = sessionStorage.getItem('max_export_pending');
    if (pending) {
      sessionStorage.removeItem('max_export_pending');
      let params;
      try {
        params = JSON.parse(pending);
      } catch(e) {
        setProgress('Ошибка: повреждённые данные экспорта');
        return;
      }
      st = { params, phase: 'run', sessionNo: 1, entryLink: null, roundsUsed: 0, totalRecords: 0 };
      saveSession(st);
      idbClear().catch(function(){});  // drop any leftover rows from an aborted run
    } else {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (!saved) return;
      try {
        st = JSON.parse(saved);
      } catch(e) {
        sessionStorage.removeItem(SESSION_KEY);
        return;
      }
      if (!st || st.phase !== 'run' || !st.params) {
        sessionStorage.removeItem(SESSION_KEY);
        return;
      }
    }

    (async () => {
      const panel = ensurePanel();
      panel.style.display = 'block';
      panel.querySelector('#max-exporter-stop').style.display = 'block';
      setProgress(st.sessionNo > 1
        ? `Сессия ${st.sessionNo}: ожидание загрузки чата...`
        : 'Перезагрузка... Ожидание загрузки чата...');

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
        setProgress(`Ожидание загрузки... Сообщений: ${domCount}`);
        if (domCount === prevDom) {
          stable++;
        } else {
          stable = 0;
          prevDom = domCount;
        }
      }

      RUNNING = true;
      doExportSession(st.params, st).catch(e => {
        setProgress('Ошибка: ' + e.message);
        try { sessionStorage.removeItem(SESSION_KEY); } catch(e2) {}
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
    const header = ['datetime','post_link','text','media_files','views','reactions_total'];
    const lines = [];
    lines.push(header.map(csvSafe).join(';'));
    for(const r of rows){
      lines.push([
        csvSafe(r.datetime || ''),
        csvSafe(r.post_link || ''),
        csvSafe(r.text || ''),
        csvSafe((r.media_files || []).join(', ')),
        csvSafe(r.views ?? ''),
        csvSafe(r.reactions_total ?? '')
      ].join(';'));
    }
    return '\uFEFF' + lines.join('\r\n');
  }

  // Sends the file content to the background, which builds a blob and saves it
  // via chrome.downloads. `isBase64` switches the payload to raw media bytes.
  // Resolves with the background response, or an error from
  // chrome.runtime.lastError / a missing response.
  function downloadFile(content, filename, mime, isBase64){
    return new Promise((resolve) => {
      const msg = { type: 'MAX_EXPORT_DOWNLOAD', content, filename, mime };
      if (isBase64) msg.base64 = true;
      chrome.runtime.sendMessage(
        msg,
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

  // Ask the background to download a remote URL (chat media) via
  // chrome.downloads. Resolves with the background response, or an error from
  // chrome.runtime.lastError / a missing response.
  function downloadUrl(url, filename){
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'MAX_EXPORT_DOWNLOAD_URL', url, filename },
        (resp) => {
          const err = chrome.runtime.lastError;
          if (err) resolve({ ok: false, error: err.message });
          else resolve(resp || { ok: false, error: 'нет ответа от фоновой службы' });
        }
      );
    });
  }

  // File extension for a media download, whitelisted to image formats (the
  // URL path may carry none at all — CDN links often don't).
  function extensionFromUrl(url) {
    try {
      const path = new URL(url).pathname;
      const m = path.match(/\.([a-z0-9]{2,5})$/i);
      if (m && /^(?:jpe?g|png|webp|heic|gif|bmp|tiff?)$/i.test(m[1])) return m[1].toLowerCase().replace('jpeg', 'jpg');
    } catch(e) {}
    return 'jpg';
  }

  // ---- Original-quality media download ----
  // Chat photo links on i.oneme.ru point at a lossy webp preview sized for the
  // chat bubble. The app's own photo viewer "Скачать" button re-requests the
  // exact same link with &fn=external_28, and the CDN then returns the uploaded
  // original (usually JPEG, 2-3x larger at identical pixel size). Speed is
  // explicitly secondary here — the point of the option is usable quality.
  function originalQualityUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname !== 'i.oneme.ru' || u.searchParams.has('fn')) return url;
      u.searchParams.set('fn', 'external_28');
      return u.href;
    } catch(e) { return url; }
  }

  function extFromContentType(mime) {
    switch ((mime || '').split(';')[0].trim().toLowerCase()) {
      case 'image/jpeg': return 'jpg';
      case 'image/png': return 'png';
      case 'image/webp': return 'webp';
      case 'image/gif': return 'gif';
      case 'image/bmp': return 'bmp';
      case 'image/heic':
      case 'image/heif': return 'heic';
      case 'image/tiff': return 'tif';
      default: return '';
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(fr.error || new Error('FileReader error'));
      fr.readAsDataURL(blob);
    });
  }

  // Fetch the original-quality bytes from the page context (the CDN serves
  // CORS headers — the viewer itself fetches these links the same way), name
  // the file by the actual Content-Type and save it via the background. If the
  // fetch is blocked, fall back to a plain background URL download. Resolves
  // {filename, bytes} on success or {error}.
  async function saveOriginalMedia(url, filenameNoExt) {
    const urlOrig = originalQualityUrl(url);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      const resp = await fetch(urlOrig, { credentials: 'omit', signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const mime = (resp.headers.get('content-type') || '').split(';')[0].trim();
      const blob = await resp.blob();
      if (!blob.size) throw new Error('пустой ответ');
      const ext = extFromContentType(mime) || extensionFromUrl(urlOrig);
      const filename = `${filenameNoExt}.${ext}`;
      const r = await downloadFile(await blobToBase64(blob), filename, mime || 'application/octet-stream', true);
      if (!r || !r.ok) throw new Error((r && r.error) || 'не сохранено');
      return { filename, bytes: blob.size };
    } catch (e) {
      const filename = `${filenameNoExt}.${extensionFromUrl(urlOrig)}`;
      const r = await downloadUrl(urlOrig, filename);
      if (r && r.ok) return { filename, bytes: 0 };
      return { filename: null, error: ((r && r.error) || e.message || String(e)) };
    }
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

  // ---- Cross-session storage ----
  // Every reload session appends its rows to IndexedDB (survives page reloads,
  // no meaningful size limit); the final report is built from the accumulated
  // set, deduplicated by post link.
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('max_exporter', 1);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore('records', { keyPath: 'key' }); } catch(e) {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbPutAll(rows) {
    if (!rows.length) return;
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      const store = tx.objectStore('records');
      for (const r of rows) store.put(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }
  async function idbGetAll() {
    const db = await idbOpen();
    const rows = await new Promise((resolve, reject) => {
      const req = db.transaction('records', 'readonly').objectStore('records').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows;
  }
  async function idbClear() {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      tx.objectStore('records').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  function saveSession(st) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(st)); } catch(e) {} }
  // Captured post links point at max.ru; the web app lives on web.max.ru.
  function toWebLink(link) {
    try {
      const u = new URL(link);
      if (u.hostname === 'max.ru' || u.hostname.endsWith('.max.ru')) {
        return 'https://web.max.ru' + u.pathname + u.search;
      }
      return link;
    } catch(e) { return link; }
  }

  // Let late-arriving history prepends land and capture them. A single static
  // sweep after the scroll loop can miss messages the app was still inserting
  // at the moment the loop broke (observed live as a missing block of messages
  // right at the range-start boundary).
  async function drainSweep(hist) {
    for (let i = 0; i < 10; i++) {
      if (SHOULD_STOP) break;
      const domBefore = hist ? hist.querySelectorAll(SEL_ITEM).length : 0;
      const recBefore = _records.length;
      await processLoadedMessages(true);
      await sleep(700);
      const domAfter = hist ? hist.querySelectorAll(SEL_ITEM).length : 0;
      if (domAfter === domBefore && _records.length === recBefore) break;
    }
  }

  // Final per-session photo sweep: after the scroll loop, re-check every
  // recorded photo bubble that ended up with no URLs — MAX may simply not have
  // loaded the image while the bubble was passing through the viewport.
  async function collectSessionPhotos(hist) {
    if (!hist) return;
    const pending = [];
    hist.querySelectorAll(SEL_BUBBLE).forEach(bubble => {
      const rec = _recordByBubble.get(bubble);
      if (rec && rec.expectedPhoto && !(rec.mediaUrls && rec.mediaUrls.length)) pending.push({ bubble, rec });
    });
    let found = 0;
    for (const p of pending) {
      if (SHOULD_STOP) break;
      p.rec.mediaUrls = await ensurePhotoUrlsForBubble(p.bubble);
      if (p.rec.mediaUrls.length) found++;
      setProgress(`Дозагрузка фотографий: найдено ${found} из ${pending.length}`);
    }
  }

  // One page-reload session of the export. Memory stays bounded because the
  // page is reloaded (deep-linking to the oldest captured post) once the
  // retained DOM grows past sessionItemLimit; accumulated rows live in
  // IndexedDB and survive the reloads.
  async function doExportSession(params, st) {
    const { maxScrolls, startDate, endDate, startDateSet, endDateSet } = params;

    if(!validateRequiredElements()){
      setProgress('Ошибка: не найдены элементы чата на странице');
      sessionStorage.removeItem(SESSION_KEY);
      markPanelFinished();
      return;
    }

    SHOULD_STOP = false;
    _collectMedia = !!params.downloadPhotos;
    // Suppress "You copied the link to the post" snackbars for the whole session.
    hideToasts();

    const parsedStartDate = parseInputDate(startDate);
    const parsedEndDate = parseInputDate(endDate);
    _startMs = parsedStartDate ? parsedStartDate.getTime() : 0;
    _endMs = parsedEndDate ? parsedEndDate.getTime() + 86400000 : Infinity;
    _useDateRange = !!(startDateSet && parsedStartDate) || !!(endDateSet && parsedEndDate);

    _records = [];
    _seenKeys = new Set();
    _linksCount = 0;

    const sessionItemLimit = (params.sessionItemLimit > 0) ? params.sessionItemLimit : SESSION_ITEM_LIMIT_DEFAULT;
    const totalRoundsBudget = _useDateRange ? 9999 : Math.min(maxScrolls, 500);
    const roundsBudget = Math.max(0, totalRoundsBudget - (st.roundsUsed || 0));
    const maxStable = _useDateRange ? 20 : 12;

    const historyEl = document.querySelector(SEL_HISTORY);
    let stableRounds = 0;
    let prevDomCount = 0;
    let rounds = 0;
    let dateReached = false;
    let stableBreak = false;

    if (!st.entryLink) {
      // First session: scroll down to load the most recent messages — the loop
      // will then scroll upward, loading progressively older ones. If the
      // channel has unread messages, MAX opens it at the first unread one.
      setProgress(`Загрузка свежих сообщений: ${historyEl ? historyEl.querySelectorAll(SEL_ITEM).length : 0}`);
      await scrollToNewestMessages();
    } else {
      // Continuation session: the chat already opened AT the anchor post (via
      // its permalink). Scrolling to the newest messages here would make the
      // app load the entire newer history again — exactly what we avoid.
      setProgress(`Сессия ${st.sessionNo}: продолжение с места остановки`);
      await sleep(600);
    }

    await processLoadedMessages(false);

    for (let i = 1; i <= roundsBudget; i++) {
      if (SHOULD_STOP) break;

      scrollChat('top');
      await sleep(350);
      rounds++;

      if (_useDateRange) {
        const oldest = getOldestVisibleDateMs();
        if (oldest < Infinity && oldest < _startMs) {
          setProgress(`Дата начала достигнута. Обработано всего: ${(st.totalRecords || 0) + _records.length}`);
          dateReached = true;
          break;
        }
      }

      const curDomCount = historyEl ? historyEl.querySelectorAll(SEL_ITEM).length : 0;

      if (curDomCount === prevDomCount) {
        stableRounds++;
      } else {
        stableRounds = 0;
        prevDomCount = curDomCount;
      }

      // Counters cover only messages inside the requested range.
      setProgress(`Сессия ${st.sessionNo} | Шаг ${rounds} | Обработано всего: ${(st.totalRecords || 0) + _records.length} | Ссылок: ${_linksCount} | В DOM: ${curDomCount}`);

      await processLoadedMessages(false);

      if (stableRounds >= maxStable) { stableBreak = true; break; }
      if (curDomCount >= sessionItemLimit) break;
    }

    await sleep(400);
    await drainSweep(historyEl);

    // Give photo records still missing their URLs a final chance to load
    // (bubbles are centred in the viewport one by one).
    if (_collectMedia && !SHOULD_STOP) {
      await collectSessionPhotos(historyEl);
    }

    // Persist this session's rows (IDB put deduplicates by key across sessions).
    await idbPutAll(_records);
    st.totalRecords = (st.totalRecords || 0) + _records.length;
    st.roundsUsed = (st.roundsUsed || 0) + rounds;

    const roundsExhausted = !_useDateRange && st.roundsUsed >= totalRoundsBudget;
    const terminal = SHOULD_STOP || dateReached || stableBreak || roundsExhausted;

    // Continuation anchor: the oldest post with a captured link this session.
    let anchor = null;
    for (const r of _records) {
      if (r.link && (anchor == null || r.time < anchor.time)) anchor = r;
    }

    if (terminal || !anchor || _records.length === 0) {
      st.phase = 'finish';
      saveSession(st);
      await finishExport(params);
      return;
    }

    // Memory cap reached mid-history: reload deep-linked to the anchor post.
    st.sessionNo = (st.sessionNo || 1) + 1;
    st.entryLink = toWebLink(anchor.link);
    saveSession(st);
    setProgress(`Сессия ${st.sessionNo - 1} завершена (всего обработано: ${st.totalRecords}). Открываю продолжение...`);
    await sleep(500);
    location.href = st.entryLink;
  }

  // Build and download the final report from all accumulated session rows.
  async function finishExport(params) {
    const { format, paginationEnabled, paginationRows, startDate, endDate, startDateSet, endDateSet, downloadPhotos } = params;

    let rows = [];
    try { rows = await idbGetAll(); } catch(e) {}
    try { await idbClear(); } catch(e) {}
    try { sessionStorage.removeItem(SESSION_KEY); } catch(e) {}

    const parsedStartDate = parseInputDate(startDate);
    const parsedEndDate = parseInputDate(endDate);
    const startMs = parsedStartDate ? parsedStartDate.getTime() : 0;
    const endMs = parsedEndDate ? parsedEndDate.getTime() + 86400000 : Infinity;
    const useDateRange = !!(startDateSet && parsedStartDate) || !!(endDateSet && parsedEndDate);

    // Resolve the channel slug: prefer the slug embedded in captured links.
    const slug = await findChannelSlug();

    let results = rows;
    if (useDateRange) {
      results = results.filter(m => m.time >= startMs && m.time <= endMs);
    }
    results.sort((a, b) => a.time - b.time);

    let photoNumber = 0;
    const photoJobs = [];
    const out = results.map((m, rowIndex) => {
      // Media URLs are only collected while downloadPhotos was enabled; rows
      // from older runs (or text-only posts) simply carry an empty list.
      const urls = downloadPhotos ? [...new Set(m.mediaUrls || [])] : [];
      const jobs = urls.map((url, index) => {
        photoNumber++;
        const datePart = m.time ? `${new Date(m.time).getFullYear()}-${pad(new Date(m.time).getMonth() + 1)}-${pad(new Date(m.time).getDate())}` : 'unknown-date';
        photoJobs.push({
          rowIndex,
          url,
          base: `${datePart}_${String(photoNumber).padStart(5, '0')}_${String(index + 1).padStart(2, '0')}`
        });
      });
      return {
        datetime: m.time ? formatTime(m.time) : '',
        post_link: m.link || '',
        text: m.text,
        media_files: [],
        media_urls: urls,
        expected_photo: !!m.expectedPhoto,
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
      const exportFolder = `MAX_Export_${slug}_${ts}`;
      const missingPhotoMessages = out.filter(row => row.expected_photo && !(row.media_urls || []).length).length;
      const chunkSize = (paginationEnabled && paginationRows > 0) ? paginationRows : out.length;
      const totalParts = Math.ceil(out.length / chunkSize);

      // Media first: originals are fetched one by one (quality over speed) and
      // the file extension depends on what the CDN actually returns, so the
      // report is written afterwards and lists the exact saved filenames.
      let downloadErrors = [];
      let photoBytes = 0;
      let photosSaved = 0;
      if (downloadPhotos && photoJobs.length && !SHOULD_STOP) {
        for (let i = 0; i < photoJobs.length; i++) {
          if (SHOULD_STOP) break;
          const job = photoJobs[i];
          setProgress(`Скачивание фото (${i + 1} из ${photoJobs.length})...`);
          const res = await saveOriginalMedia(job.url, `${exportFolder}/media/${job.base}`);
          if (res.filename) {
            job.filename = res.filename.split('/').pop();
            photoBytes += res.bytes || 0;
            photosSaved++;
          } else {
            downloadErrors.push(`Фото ${job.base}: ${res.error || 'ошибка'}`);
          }
          await sleep(80);
        }
      }
      const filesByRow = new Map();
      photoJobs.forEach(job => {
        if (!job.filename) return;
        const list = filesByRow.get(job.rowIndex) || [];
        list.push(job.filename);
        filesByRow.set(job.rowIndex, list);
      });
      out.forEach((row, rowIndex) => { row.media_files = filesByRow.get(rowIndex) || []; });

      for (let part = 0; part < totalParts; part++) {
        if (SHOULD_STOP) break;
        const chunk = out.slice(part * chunkSize, (part + 1) * chunkSize);
        const suffix = totalParts > 1 ? `_part${part + 1}of${totalParts}` : '';

        setProgress(`Сохранение файла ${part + 1} из ${totalParts}...`);

        const content = format === 'json' ? JSON.stringify(chunk, null, 2) : toExcelCsv(chunk);
        const filename = format === 'json'
          ? `${exportFolder}/max_${slug}_${ts}${suffix}.json`
          : `${exportFolder}/max_${slug}_${ts}${suffix}.csv`;
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
        const sizeInfo = photoBytes ? `, ${(photoBytes / 1048576).toFixed(1)} МБ` : '';
        const photoInfo = downloadPhotos ? `
Фото (оригиналы): ${photosSaved}, не найдено у сообщений: ${missingPhotoMessages}${sizeInfo}` : '';
        setProgress(`Готово.
${format.toUpperCase()}: ${out.length} сообщений${partInfo}${photoInfo}
Файлы сохранены в папке по умолчанию.`);
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
      try { sessionStorage.removeItem(SESSION_KEY); } catch(e) {}
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