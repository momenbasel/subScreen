(() => {
  'use strict';

  const PROVIDERS = {
    thum: {
      name: 'thum.io',
      needsKey: false,
      buildUrl(target, opts) {
        let params = 'width/' + opts.width;
        if (opts.delay > 0) params = 'wait/' + opts.delay + '/' + params;
        return 'https://image.thum.io/get/' + params + '/' + target;
      }
    },
    urlbox: {
      name: 'urlbox.io',
      needsKey: true,
      buildUrl(target, opts) {
        var p = new URLSearchParams({
          url: target,
          width: String(opts.width),
          height: String(opts.height)
        });
        if (opts.delay > 0) p.set('delay', String(opts.delay * 1000));
        return 'https://api.urlbox.io/v1/' + opts.apiKey + '/png?' + p;
      }
    }
  };

  var SIZES = {
    sm:   { width: 450,  height: 300 },
    md:   { width: 800,  height: 600 },
    lg:   { width: 1280, height: 800 },
    full: { width: 1920, height: 1080 }
  };

  var STORAGE_KEY = 'subscreen_v2';

  var state = {
    targets: [],
    results: new Map(),
    captures: new Map(),
    provider: 'thum',
    apiKey: '',
    size: 'md',
    delay: 0,
    filter: 'all',
    search: '',
    lbIndex: -1,
    scanning: false,
    scanId: 0
  };

  var lastLightboxFocus = null;
  var storageWarningShown = false;

  var $ = function(s) { return document.querySelector(s); };
  var $$ = function(s) { return document.querySelectorAll(s); };

  function el(tag, attrs) {
    var e = document.createElement(tag);
    var children = Array.prototype.slice.call(arguments, 2);
    if (attrs) {
      Object.keys(attrs).forEach(function(k) {
        var v = attrs[k];
        if (k === 'className') e.className = v;
        else if (k === 'dataset') Object.assign(e.dataset, v);
        else if (k.indexOf('on') === 0 && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, String(v));
      });
    }
    children.forEach(function(c) {
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else if (c) e.appendChild(c);
    });
    return e;
  }

  function escapeHtml(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function debounce(fn, ms) {
    var t;
    return function() {
      var args = arguments;
      var self = this;
      clearTimeout(t);
      t = setTimeout(function() { fn.apply(self, args); }, ms);
    };
  }

  function parseTargets(raw) {
    if (!raw || !raw.trim()) return [];

    var lines = [];
    raw.split(/[\n\r]+/).forEach(function(l) {
      l.split(',').forEach(function(s) {
        var trimmed = s.trim();
        if (trimmed && trimmed.charAt(0) !== '#') lines.push(trimmed);
      });
    });

    var seen = {};
    var results = [];

    lines.forEach(function(line) {
      var url = null;
      var urlMatch = line.match(/(https?:\/\/[^\s\[\]<>"]+)/);

      if (urlMatch) {
        url = urlMatch[1].replace(/\/+$/, '');
      } else {
        var domainMatch = line.match(/([a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(:\d+)?/);
        if (domainMatch) {
          url = 'https://' + domainMatch[0];
        } else {
          var ipMatch = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?/);
          if (ipMatch) url = 'https://' + ipMatch[0];
        }
      }

      if (url && !seen[url]) {
        seen[url] = true;
        results.push(url);
      }
    });

    return results;
  }

  function getDomain(url) {
    try { return new URL(url).host; }
    catch(e) { return url; }
  }

  function getScreenshotUrl(targetUrl) {
    var provider = PROVIDERS[state.provider];
    if (!provider) return '';
    var sz = SIZES[state.size];
    return provider.buildUrl(targetUrl, {
      width: sz.width,
      height: sz.height,
      delay: state.delay,
      apiKey: state.apiKey
    });
  }

  function updateStats() {
    var loaded = 0, failed = 0;
    state.results.forEach(function(s) {
      if (s === 'loaded') loaded++;
      else if (s === 'failed') failed++;
    });
    var total = state.targets.length;

    $('#stat-total').textContent = total;
    $('#stat-loaded').textContent = loaded;
    $('#stat-failed').textContent = failed;
    $('#stat-pending').textContent = Math.max(0, total - loaded - failed);

    var pct = total > 0 ? ((loaded + failed) / total) * 100 : 0;
    $('#progress-fill').style.width = pct + '%';
    $('#scan-progress').setAttribute('aria-valuenow', String(Math.round(pct)));

    var retryBtn = $('#btn-retry-failed');
    if (retryBtn) retryBtn.hidden = failed === 0;

    if (loaded + failed === total && total > 0) {
      state.scanning = false;
      syncScanButton();
      $('#scan-status').textContent = 'Scan complete: ' + loaded + ' loaded, ' + failed + ' failed.';
    }
  }

  function getVisibleIndices() {
    var indices = [];
    for (var i = 0; i < state.targets.length; i++) {
      var url = state.targets[i];
      var status = state.results.get(url) || 'pending';
      var domain = getDomain(url).toLowerCase();

      if (state.filter !== 'all' && status !== state.filter) continue;
      if (state.search && domain.indexOf(state.search.toLowerCase()) === -1) continue;
      indices.push(i);
    }
    return indices;
  }

  function applyFilter() {
    var visible = {};
    getVisibleIndices().forEach(function(i) { visible[i] = true; });
    $$('.card').forEach(function(card) {
      var idx = parseInt(card.dataset.index, 10);
      card.style.display = visible[idx] ? '' : 'none';
    });
    $$('.filter').forEach(function(b) {
      b.classList.toggle('active', b.dataset.filter === state.filter);
      b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter));
    });
    $('#filter-empty').hidden = !state.targets.length || Object.keys(visible).length > 0;
  }

  function createCard(url, index) {
    var scanId = state.scanId;
    var domain = getDomain(url);
    var imgSrc = getScreenshotUrl(url);

    var img = el('img', { loading: 'lazy', alt: 'Screenshot of ' + domain + '. Open preview', draggable: 'false', tabindex: '0', role: 'button', onkeydown: function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(index); } } });
    var skeleton = el('div', { className: 'card-skeleton' });
    var statusDot = el('span', { className: 'card-status-dot' });

    var overlay = el('div', { className: 'card-overlay' },
      el('button', {
        className: 'card-action',
        onclick: function(e) { e.stopPropagation(); window.open(url, '_blank'); }
      }, 'Open'),
      el('button', {
        className: 'card-action',
        onclick: function(e) { e.stopPropagation(); retryScreenshot(index); }
      }, 'Retry'),
      el('button', {
        className: 'card-action',
        onclick: function(e) {
          e.stopPropagation();
          copyText(url, 'URL copied');
        }
      }, 'Copy')
    );

    var imgWrap = el('div', {
      className: 'card-img',
      onclick: function() { openLightbox(index); }
    }, img, skeleton, overlay);

    var info = el('div', { className: 'card-info' },
      statusDot,
      el('span', { className: 'card-domain', title: url }, domain)
    );

    var card = el('div', {
      className: 'card',
      dataset: { status: 'pending', index: String(index) }
    }, imgWrap, info);

    img.onload = function() {
      if (scanId !== state.scanId) return;
      card.dataset.status = 'loaded';
      state.results.set(url, 'loaded');
      updateStats();
      applyFilter();
    };

    img.onerror = function() {
      if (scanId !== state.scanId) return;
      card.dataset.status = 'failed';
      state.results.set(url, 'failed');
      updateStats();
      applyFilter();
    };

    state.results.set(url, 'pending');
    state.captures.set(url, { provider: state.provider, src: imgSrc });
    img.src = imgSrc;

    return card;
  }

  function retryScreenshot(index) {
    var url = state.targets[index];
    if (!url) return;

    var card = $('.card[data-index="' + index + '"]');
    if (!card) return;

    card.dataset.status = 'pending';
    state.results.set(url, 'pending');
    updateStats();

    var img = card.querySelector('img');
    var base = getScreenshotUrl(url);
    var sep = base.indexOf('?') > -1 ? '&' : '?';
    var source = base + sep + '_t=' + Date.now();
    state.captures.set(url, { provider: state.provider, src: source });
    img.src = source;
  }

  function retryAllFailed() {
    state.targets.forEach(function(url, i) {
      if (state.results.get(url) === 'failed') retryScreenshot(i);
    });
    toast('Retrying failed screenshots');
  }

  function startScan() {
    if (state.scanning) return;

    var raw = $('#targets').value;
    var targets = parseTargets(raw);

    if (!targets.length) {
      toast('No valid targets found', 'error');
      return;
    }

    if (state.provider === 'manual') {
      openManual(targets);
      return;
    }

    if (state.provider === 'urlbox' && !state.apiKey) {
      toast('urlbox.io requires an API key', 'error');
      return;
    }

    var scanId = ++state.scanId;
    state.targets = targets;
    state.results.clear();
    state.captures.clear();
    state.scanning = true;
    state.filter = 'all';
    state.search = '';

    syncScanButton();
    $('#scan-status').textContent = 'Loading screenshots for ' + targets.length + ' targets.';
    $('#stats-bar').hidden = false;
    $('#btn-export').disabled = false;
    $('#btn-copy').hidden = false;
    $('#empty-state').style.display = 'none';

    var searchInput = $('#search');
    if (searchInput) searchInput.value = '';

    var gallery = $('#gallery');
    gallery.replaceChildren();
    updateStats();

    var BATCH = 15;
    var i = 0;

    function processBatch() {
      if (scanId !== state.scanId) return;
      var end = Math.min(i + BATCH, targets.length);
      var fragment = document.createDocumentFragment();
      for (var j = i; j < end; j++) {
        fragment.appendChild(createCard(targets[j], j));
      }
      gallery.appendChild(fragment);
      i = end;
      if (i < targets.length) {
        setTimeout(processBatch, 40);
      }
    }

    processBatch();
    applyFilter();
    saveSettings();
  }

  function openManual(targets) {
    var blocked = false;
    for (var i = 0; i < targets.length; i++) {
      var w = window.open(targets[i], '_blank');
      if (!w) { blocked = true; break; }
    }
    if (blocked) {
      toast('Popup blocker active - allow popups for this site', 'error');
    } else {
      toast('Opened ' + targets.length + ' tab' + (targets.length !== 1 ? 's' : ''), 'success');
    }
  }

  function clearResults() {
    state.scanId++;
    $('#filter-empty').hidden = true;
    $('#scan-status').textContent = 'Results cleared.';
    state.targets = [];
    state.results.clear();
    state.captures.clear();
    state.scanning = false;
    state.filter = 'all';
    state.search = '';

    $('#targets').value = '';
    $('#gallery').replaceChildren();
    $('#stats-bar').hidden = true;
    $('#btn-export').disabled = true;
    $('#btn-copy').hidden = true;
    $('#target-count').textContent = '';
    $('#empty-state').style.display = '';

    var searchInput = $('#search');
    if (searchInput) searchInput.value = '';

    syncScanButton();
  }

  function syncScanButton() {
    var btn = $('#btn-start');
    btn.disabled = state.scanning;
    btn.textContent = state.scanning ? 'Scanning...' : 'Start Scan';
  }

  function openLightbox(index) {
    var url = state.targets[index];
    if (!url) return;

    lastLightboxFocus = document.activeElement;
    state.lbIndex = index;
    var lb = $('#lightbox');
    lb.hidden = false;
    document.body.style.overflow = 'hidden';
    updateLightboxContent();
    $('.app').inert = true;
    $('#lb-close').focus();
    requestAnimationFrame(function() { lb.classList.add('active'); });
  }

  function closeLightbox() {
    var lb = $('#lightbox');
    lb.classList.remove('active');
    document.body.style.overflow = '';
    $('.app').inert = false;
    if (lastLightboxFocus && lastLightboxFocus.isConnected) lastLightboxFocus.focus();
    lb.hidden = true;
    state.lbIndex = -1;
  }

  function navigateLightbox(dir) {
    var visible = getVisibleIndices();
    if (!visible.length) return;

    var currentPos = visible.indexOf(state.lbIndex);
    var nextPos = currentPos + dir;
    if (nextPos < 0) nextPos = visible.length - 1;
    if (nextPos >= visible.length) nextPos = 0;

    state.lbIndex = visible[nextPos];
    updateLightboxContent();
  }

  function updateLightboxContent() {
    var url = state.targets[state.lbIndex];
    if (!url) return;

    var visible = getVisibleIndices();
    var pos = visible.indexOf(state.lbIndex) + 1;

    var capture = state.captures.get(url);
    $('#lb-img').src = capture ? capture.src : '';
    $('#lb-img').alt = 'Screenshot of ' + getDomain(url);
    $('#lb-domain').textContent = getDomain(url);
    $('#lb-counter').textContent = pos + ' / ' + visible.length;
    $('#lb-open').href = url;
  }

  function exportReport() {
    if (!state.targets.length) return;

    var date = new Date().toISOString().split('T')[0];
    var time = new Date().toLocaleTimeString();
    var loaded = 0, failed = 0;
    state.results.forEach(function(s) {
      if (s === 'loaded') loaded++;
      else if (s === 'failed') failed++;
    });

    var cards = state.targets.map(function(url) {
      var domain = getDomain(url);
      var status = state.results.get(url);
      var capture = state.captures.get(url);
      var imgSrc = capture && capture.provider !== 'urlbox' ? capture.src : '';

      if (status === 'loaded' && imgSrc) {
        return '<div class="item"><a href="' + escapeHtml(url) + '" target="_blank"><img src="' + escapeHtml(imgSrc) + '" alt="' + escapeHtml(domain) + '" loading="lazy"></a><div class="meta"><a href="' + escapeHtml(url) + '" target="_blank">' + escapeHtml(domain) + '</a><span class="badge ok">OK</span></div></div>';
      }
      var omitted = status === 'loaded' && capture && capture.provider === 'urlbox';
      var label = omitted ? 'Preview excluded to protect your API key' : '';
      var badge = status === 'loaded' ? 'OK' : status === 'failed' ? 'FAIL' : 'PENDING';
      return '<div class="item"><div class="placeholder">' + label + '</div><div class="meta"><a href="' + escapeHtml(url) + '" target="_blank">' + escapeHtml(domain) + '</a><span class="badge ' + (status === 'loaded' ? 'ok' : 'fail') + '">' + badge + '</span></div></div>';
    }).join('\n');

    var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>SubScreen Report - ' + escapeHtml(date) + '</title>\n<style>\n*{margin:0;padding:0;box-sizing:border-box}\nbody{font-family:system-ui,sans-serif;background:#09090b;color:#fafafa;padding:32px 24px}\nh1{font-size:22px;font-weight:700;letter-spacing:-0.02em}\n.sub{color:#a1a1aa;font-size:13px;margin:6px 0 28px}\n.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,400px),1fr));gap:16px}\n.item{background:#18181b;border:1px solid #27272a;border-radius:10px;overflow:hidden}\n.item img{width:100%;display:block}\n.placeholder{height:180px;background:#111114;display:flex;align-items:center;justify-content:center;color:#a1a1aa;font-size:12px;padding:20px;text-align:center}\n.placeholder:empty::after{content:"Screenshot unavailable"}\n.meta{padding:10px 14px;display:flex;align-items:center;justify-content:space-between;font-size:12px;font-family:monospace;border-top:1px solid #27272a}\n.meta a{color:#60a5fa;text-decoration:none}\n.meta a:hover{text-decoration:underline}\n.badge{padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;font-family:system-ui,sans-serif;text-transform:uppercase;letter-spacing:0.05em}\n.badge.ok{background:rgba(34,197,94,0.12);color:#22c55e}\n.badge.fail{background:rgba(239,68,68,0.12);color:#ef4444}\n</style>\n</head>\n<body>\n<h1>SubScreen Report</h1>\n<p class="sub">' + escapeHtml(date) + ' ' + escapeHtml(time) + ' &middot; ' + state.targets.length + ' targets &middot; ' + loaded + ' captured &middot; ' + failed + ' failed</p>\n<div class="grid">\n' + cards + '\n</div>\n</body>\n</html>';

    var blob = new Blob([html], { type: 'text/html' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'subscreen-report-' + date + '.html';
    a.click();
    URL.revokeObjectURL(a.href);
    var hasPrivatePreviews = Array.from(state.captures.values()).some(function(capture) { return capture.provider === 'urlbox'; });
    toast(hasPrivatePreviews ? 'Report exported. Urlbox previews excluded to protect your API key.' : 'Report exported', 'success');
  }

  function copyDomains() {
    var domains = state.targets.map(getDomain).join('\n');
    copyText(domains, 'Domains copied to clipboard');
  }

  function copyText(value, message) {
    if (!navigator.clipboard) { toast('Clipboard unavailable. Copy the text manually.', 'error'); return; }
    navigator.clipboard.writeText(value).then(function() { toast(message, 'success'); }).catch(function() { toast('Copy blocked by the browser. Copy the text manually.', 'error'); });
  }

  function toast(msg, type) {
    var t = el('div', { className: 'toast ' + (type || '') }, msg);
    var container = $('#toast-container');
    container.appendChild(t);
    requestAnimationFrame(function() { t.classList.add('show'); });
    setTimeout(function() {
      t.classList.remove('show');
      setTimeout(function() { t.remove(); }, 300);
    }, 2600);
  }

  function setupDragDrop() {
    var zone = $('#drop-zone');
    var overlay = $('#drop-overlay');

    ['dragenter', 'dragover'].forEach(function(ev) {
      zone.addEventListener(ev, function(e) {
        e.preventDefault();
        overlay.classList.add('active');
      });
    });

    ['dragleave', 'drop'].forEach(function(ev) {
      zone.addEventListener(ev, function() {
        overlay.classList.remove('active');
      });
    });

    zone.addEventListener('drop', function(e) {
      e.preventDefault();
      var file = e.dataTransfer.files[0];
      if (!file) return;

      importFile(file);
    });
  }

  function importFile(file) {
    if (!file) return;
    var validTypes = ['text/plain', 'text/csv', 'application/octet-stream', ''];
    var validExts = ['.txt', '.csv', '.lst', '.list'];
    var ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

    if (validTypes.indexOf(file.type) === -1 && validExts.indexOf(ext) === -1) {
      toast('Unsupported file type', 'error');
      return;
    }

    var reader = new FileReader();
    reader.onload = function() {
      var textarea = $('#targets');
      var existing = textarea.value.trim();
      textarea.value = existing ? existing + '\n' + reader.result : reader.result;
      updateTargetCount();
      toast('Loaded ' + file.name, 'success');
    };
    reader.onerror = function() { toast('Could not read this file. Try another file.', 'error'); };
    reader.readAsText(file);
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        provider: state.provider,
        size: state.size,
        delay: state.delay
      }));
    } catch(e) {
      if (!storageWarningShown) { toast('Browser storage unavailable. Settings apply to this tab only.', 'error'); storageWarningShown = true; }
    }
  }

  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var cfg = JSON.parse(raw);
      if (cfg.provider === 'manual' || PROVIDERS[cfg.provider]) { state.provider = cfg.provider; $('#provider').value = cfg.provider; }
      if (SIZES[cfg.size]) { state.size = cfg.size; $('#size').value = cfg.size; }
      if ([0, 2, 5, 10].indexOf(cfg.delay) !== -1) { state.delay = cfg.delay; $('#delay').value = String(cfg.delay); }
      toggleApiKeyField();
      saveSettings();
    } catch(e) { toast('Saved settings could not be loaded. Using defaults.', 'error'); }
  }

  function updateTargetCount() {
    var count = parseTargets($('#targets').value).length;
    var elem = $('#target-count');
    if (elem) {
      elem.textContent = count > 0 ? count + ' unique target' + (count !== 1 ? 's' : '') + ' detected' : '';
    }
  }

  function toggleApiKeyField() {
    $('#api-key-group').hidden = state.provider !== 'urlbox';
    $('#provider-help').textContent = state.provider === 'urlbox' ? 'Urlbox receives the target URLs and API key. The key is not saved in browser storage. Urlbox previews are excluded from exported reports to protect the key.' : state.provider === 'manual' ? 'Targets open directly in browser tabs. Allow popups for this site when using manual mode.' : 'thum.io receives the target URLs to create screenshots. Use manual mode for targets you do not want to send to a screenshot provider.';
  }

  function setupKeyboard() {
    document.addEventListener('keydown', function(e) {
      var lbHidden = $('#lightbox').hidden;

      if (e.key === 'Escape' && !lbHidden) {
        closeLightbox();
        e.preventDefault();
        return;
      }

      if (!lbHidden) {
        if (e.key === 'Tab') {
          var controls = Array.prototype.filter.call($('#lightbox').querySelectorAll('button, a[href]'), function(node) { return node.offsetParent !== null; });
          var first = controls[0], last = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
          else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
        }
        if (e.key === 'ArrowLeft') { navigateLightbox(-1); e.preventDefault(); }
        if (e.key === 'ArrowRight') { navigateLightbox(1); e.preventDefault(); }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        startScan();
      }
    });
  }

  function init() {
    loadSettings();
    setupDragDrop();
    setupKeyboard();

    $('#btn-start').addEventListener('click', startScan);
    $('#btn-import').addEventListener('click', function() { $('#target-file').click(); });
    $('#target-file').addEventListener('change', function(e) { importFile(e.target.files[0]); e.target.value = ''; });
    $('#btn-clear').addEventListener('click', clearResults);
    $('#btn-export').addEventListener('click', exportReport);
    $('#btn-copy').addEventListener('click', copyDomains);
    $('#btn-retry-failed').addEventListener('click', retryAllFailed);

    $('#provider').addEventListener('change', function(e) {
      state.provider = e.target.value;
      toggleApiKeyField();
      saveSettings();
    });

    $('#api-key').addEventListener('input', function(e) {
      state.apiKey = e.target.value.trim();
    });

    $('#size').addEventListener('change', function(e) {
      state.size = e.target.value;
      saveSettings();
    });

    $('#delay').addEventListener('change', function(e) {
      state.delay = parseInt(e.target.value, 10);
      saveSettings();
    });

    $$('.filter').forEach(function(btn) {
      btn.addEventListener('click', function() {
        state.filter = btn.dataset.filter;
        applyFilter();
      });
    });

    $('#search').addEventListener('input', debounce(function(e) {
      state.search = e.target.value;
      applyFilter();
    }, 200));

    $('#targets').addEventListener('input', debounce(updateTargetCount, 300));

    $('#lb-close').addEventListener('click', closeLightbox);
    $('#lb-backdrop').addEventListener('click', closeLightbox);
    $('#lb-prev').addEventListener('click', function() { navigateLightbox(-1); });
    $('#lb-next').addEventListener('click', function() { navigateLightbox(1); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
