function wsInterceptionCode() {
  if (window._maxExportInterceptorInstalled) return;
  window._maxExportInterceptorInstalled = true;

  function captureMsg(m) {
    if (!m || !m.id) return;
    var text = '';
    if (typeof m.text === 'string') text = m.text;
    else if (typeof m.body === 'string') text = m.body;
    else if (m.content && typeof m.content === 'string') text = m.content;
    else if (m.content && typeof m.content.text === 'string') text = m.content.text;
    window.postMessage({
      type: 'MAX_EXPORT_WS_MSG',
      id: String(m.id),
      text: text || '',
      time: m.time || 0,
      views: (m.stats && m.stats.views) || 0,
      reactions: (m.reactionInfo && m.reactionInfo.totalCount) || 0,
      msgType: m.type || ''
    }, '*');
  }

  function handlePayload(p) {
    if (!p || !p.payload) return;
    deepCapture(p.payload, 0);
    extractSlugFromObj(p, 0);
    scanSlugKeys(p, 'root', 0, null);
  }

  function scanSlugKeys(obj, path, depth, inheritedId) {
    if (depth > 6 || !obj || typeof obj !== 'object') return;
    try {
      var localId = obj.chatId || obj.peerId || obj.dialogId || obj.channelId || inheritedId;
      for (var key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        var val = obj[key];
        if (typeof val === 'string') {
          var m = val.match(/^https?:\/\/(?:web\.)?max\.ru\/([a-zA-Z][a-zA-Z0-9_]{2,})\/?$/);
          if (m) {
            var slug = m[1];
            var peerId = localId || obj.id;
            if (peerId != null) {
              window.postMessage({
                type: 'MAX_EXPORT_SLUG_MAP',
                slug: slug,
                id: String(peerId)
              }, '*');
            }
          }
        }
        if (typeof val === 'object' && val !== null) {
          scanSlugKeys(val, path + '.' + key, depth + 1, localId);
        }
      }
    } catch(e) {}
  }

  function extractSlugFromObj(obj, depth) {
    if (depth > 15 || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach(function(item) { extractSlugFromObj(item, depth + 1); });
      return;
    }
    if (typeof obj.slug === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{2,}$/.test(obj.slug)) {
      var peerId = obj.peerId || obj.dialogId || obj.id || obj.channelId || obj.chatId;
      if (peerId != null) {
        window.postMessage({
          type: 'MAX_EXPORT_SLUG_MAP',
          slug: obj.slug,
          id: String(peerId)
        }, '*');
      }
    }
    for (var key in obj) {
      if (obj.hasOwnProperty(key)) extractSlugFromObj(obj[key], depth + 1);
    }
  }

  function deepCapture(obj, depth) {
    if (depth > 12 || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach(function(item) { deepCapture(item, depth + 1); });
      return;
    }
    if (obj.id && (typeof obj.text === 'string' || typeof obj.body === 'string')) {
      captureMsg(obj);
      return;
    }
    for (var key in obj) {
      if (obj.hasOwnProperty(key)) {
        deepCapture(obj[key], depth + 1);
      }
    }
  }

  function addListener(ws) {
    if (ws._maxExportListener) return;
    ws._maxExportListener = true;
    ws.addEventListener('message', function(e) {
      if (e.data && typeof e.data === 'string') {
        try {
          var p = JSON.parse(e.data);
          handlePayload(p);
        } catch(err) {}
      }
    });
  }

  var origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    addListener(this);
    return origSend.call(this, data);
  };

  var origWS = window.WebSocket;
  var wsPatch = function(url, protocols) {
    var ws = protocols ? new origWS(url, protocols) : new origWS(url);
    addListener(ws);
    return ws;
  };
  wsPatch.prototype = origWS.prototype;
  wsPatch.CONNECTING = 0;
  wsPatch.OPEN = 1;
  wsPatch.CLOSING = 2;
  wsPatch.CLOSED = 3;
  window.WebSocket = wsPatch;

  var origFetch = window.fetch;
  window.fetch = function() {
    return origFetch.apply(this, arguments).then(function(response) {
      try {
        var clone = response.clone();
        clone.text().then(function(body) {
          if (body && body.length > 50 && (body[0] === '{' || body[0] === '[')) {
            try {
              var data = JSON.parse(body);
              handlePayload(data);
            } catch(e) {}
          }
        }).catch(function(){});
      } catch(e) {}
      return response;
    });
  };
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url &&
      (tab.url.includes('max.ru') || tab.url.includes('web.max.ru'))) {
    chrome.scripting.executeScript({
      target: {tabId},
      world: 'MAIN',
      func: wsInterceptionCode,
      injectImmediately: true
    }).catch(() => {});
  }
});

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
  if(msg?.type === 'MAX_EXPORT_INJECT_WS'){
    const tabId = sender.tab?.id;
    if(!tabId){
      sendResponse({ok:false, error:'No tab ID'});
      return;
    }
    chrome.scripting.executeScript({
      target: {tabId},
      world: 'MAIN',
      func: wsInterceptionCode
    }).then(() => {
      sendResponse({ok:true});
    }).catch(err => {
      sendResponse({ok:false, error: err.message});
    });
    return true;
  }
  if(msg?.type === 'MAX_EXPORT_RESOLVE_SLUG'){
    const numericSlug = msg.numericSlug;
    if(!numericSlug){
      sendResponse({ok:false, error:'No numericSlug'});
      return true;
    }
    (async () => {
      try {
        const resp = await fetch('https://max.ru/' + numericSlug, {redirect: 'follow'});
        const finalUrl = resp.url;
        const parts = new URL(finalUrl).pathname.split('/').filter(Boolean);
        if(parts.length > 0 && !/^-?\d+$/.test(parts[0])){
          sendResponse({ok:true, slug: parts[0]});
          return;
        }
      } catch(e) {}
      sendResponse({ok:false, error:'no redirect'});
    })();
    return true;
  }
});
