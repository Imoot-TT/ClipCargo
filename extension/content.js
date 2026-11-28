(() => {
  const CONTENT_SCRIPT_VERSION = '2026.11.21.3';
  if (globalThis.__clipCargoContentScriptVersion === CONTENT_SCRIPT_VERSION) return;
  globalThis.__clipCargoContentScriptStop?.();
  globalThis.__clipCargoContentScriptVersion = CONTENT_SCRIPT_VERSION;
  globalThis.__clipCargoContentScriptStarted = true;

  const MARKER = 'data-clipcargo-video-control';
  const PAGE_MARKER = 'data-clipcargo-page-control';
  const hostOverride = globalThis.__clipCargoContentScriptHostOverride || location.hostname;
  const SUPPORTED_HOSTS = new Set([
    'www.youtube.com', 'm.youtube.com', 'www.xiaohongshu.com',
    'www.douyin.com', 'www.tiktok.com', 'www.bilibili.com',
    'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'www.instagram.com', 'www.facebook.com',
    'vimeo.com', 'www.dailymotion.com', 'www.twitch.tv',
  ]);
  const VIDEO_PATHS = [
    /^\/watch(?:\/|$|\?)/, /^\/shorts\//, /^\/explore\//,
    /^\/discovery\/item\//, /^\/@[^/]+\/video\//, /^\/video\//,
    /^\/video\/(?:av|BV)/i, /^\/[^/]+\/status\/\d+/, /^\/(?:reel|p)\//,
    /^\/(?:watch|reel|videos)\//, /^\/\d+(?:$|\/)/,
  ];
  let customSite = false;
  let closeActivePanel = null;
  let mutationObserver = null;
  let resizeObserver = null;
  let observedResizeTargets = new WeakSet();
  let navigationListener = null;
  let documentClickListener = null;

  globalThis.__clipCargoContentScriptStop = () => {
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    mutationObserver = null;
    resizeObserver = null;
    observedResizeTargets = new WeakSet();
    if (navigationListener) document.removeEventListener('yt-navigate-finish', navigationListener, true);
    if (documentClickListener) document.removeEventListener('click', documentClickListener);
    navigationListener = null;
    documentClickListener = null;
    closeActivePanel?.();
    document.documentElement.removeAttribute(PAGE_MARKER);
    document.querySelectorAll(`[${MARKER}]`).forEach((surface) => surface.removeAttribute(MARKER));
    document.querySelectorAll('[data-clipcargo-host], [data-clipcargo-panel-host]').forEach((host) => {
      host.__clipCargoCleanup?.();
      host.remove();
    });
  };

  function videoUrl(value) {
    try {
      const url = new URL(value, location.href);
      const sameCustomSite = customSite;
      if (!SUPPORTED_HOSTS.has(url.hostname) && !sameCustomSite) return null;
      if (sameCustomSite) return url.href;
      return VIDEO_PATHS.some((pattern) => pattern.test(`${url.pathname}${url.search}`)) ? url.href : null;
    } catch {
      return null;
    }
  }

  function isXHost(hostname = hostOverride) {
    return hostname === 'x.com' || hostname === 'www.x.com' || hostname === 'twitter.com' || hostname === 'www.twitter.com';
  }

  function isBiliHost(hostname = hostOverride) {
    return hostname === 'www.bilibili.com' || hostname === 'bilibili.com';
  }

  function xVideoSurface(element) {
    return tweetContainer(element)?.querySelector('video, [data-testid="videoPlayer"]') || null;
  }

  function tweetContainer(element) {
    return element?.closest('article, [data-testid="tweet"], [role="article"]') || null;
  }

  function tweetStatusLink(element) {
    const tweet = tweetContainer(element);
    if (!tweet) return null;
    return [...tweet.querySelectorAll('a[href]')].find((link) => {
      try { return /\/(?:[^/]+|i)\/status\/\d+(?:[/?#]|$)/i.test(new URL(link.href, location.href).pathname); } catch { return false; }
    }) || null;
  }

  function mediaPageUrl(element) {
    const pageUrl = videoUrl(location.href);
    if (pageUrl) return pageUrl;
    if (!isXHost()) return null;
    return videoUrl(tweetStatusLink(element)?.href || '') || null;
  }

  function defaultProject(pageUrl) {
    try {
      const host = new URL(pageUrl).hostname;
      return ({
        'www.youtube.com': 'YouTube', 'm.youtube.com': 'YouTube',
        'www.xiaohongshu.com': '小红书', 'www.douyin.com': '抖音',
        'www.tiktok.com': 'TikTok', 'www.bilibili.com': 'B站',
        'x.com': 'X', 'www.x.com': 'X', 'twitter.com': 'X', 'www.twitter.com': 'X', 'www.instagram.com': 'Instagram',
        'www.facebook.com': 'Facebook', 'vimeo.com': 'Vimeo',
        'www.dailymotion.com': 'Dailymotion', 'www.twitch.tv': 'Twitch',
      })[host] || '未分类';
    } catch {
      return '未分类';
    }
  }

  function cardTitle(link, surface) {
    const image = surface.querySelector('img[alt]');
    const labelled = link.getAttribute('aria-label') || link.getAttribute('title') || image?.alt;
    if (labelled?.trim()) return labelled.trim().slice(0, 512);
    const card = link.closest('ytd-rich-item-renderer, ytd-video-renderer, [data-e2e*="video"], article, li');
    return (card?.innerText || document.title || '未命名视频').trim().split('\n')[0].slice(0, 512);
  }

  function mediaSurface(link) {
    const tweet = tweetContainer(link);
    const preferred = isXHost()
      ? xVideoSurface(link)
      : link.querySelector('ytd-thumbnail, img, video')
      || link.closest('ytd-thumbnail, [class*="cover"], [class*="thumbnail"]')?.querySelector('img, video')
      || tweet?.querySelector('video, [data-testid="videoPlayer"]');
    let surface = preferred?.closest('ytd-thumbnail, a, [class*="cover"], [class*="thumbnail"]')
      || (tweet && preferred ? preferred.closest('[data-testid="videoPlayer"]') || preferred.parentElement : null)
      || link;
    const rect = surface.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 68) {
      const card = tweet || link.closest('ytd-rich-item-renderer, ytd-video-renderer, article, li, [data-e2e*="video"]');
      const media = card?.querySelector('a[href] img, a[href] video, img, video');
      surface = media?.closest('a, [class*="cover"], [class*="thumbnail"]') || media?.parentElement || surface;
    }
    const finalRect = surface?.getBoundingClientRect();
    if (!surface || finalRect.width < 120 || finalRect.height < 68) return null;
    if (isBiliHost()) {
      const card = link.closest('.bili-video-card, .bili-video-card__wrap, [class*="bili-video-card"]');
      const cardRect = card?.getBoundingClientRect();
      if (card && cardRect.width >= 120 && cardRect.height >= 68 && cardRect.width <= finalRect.width * 1.35) return card;
    }
    return surface;
  }

  function styleText() {
    return `
      :host{all:initial;position:absolute;z-index:2147483647!important;top:8px;left:8px;isolation:isolate;pointer-events:auto;font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif;color:#17191f}
      *{box-sizing:border-box}
      .marker{width:28px;height:28px;padding:0;border:1px solid rgba(255,255,255,.72);border-radius:8px;display:grid;place-items:center;background:rgba(24,26,34,.9);box-shadow:0 4px 12px rgba(15,18,28,.22);cursor:pointer;backdrop-filter:blur(8px);transition:transform .14s ease,box-shadow .14s ease}
      .marker.compact{width:24px;height:24px;border-radius:7px}
      .marker:hover{transform:translateY(-1px);box-shadow:0 8px 22px rgba(15,18,28,.3)}
      .marker:focus-visible{outline:3px solid rgba(95,112,236,.42);outline-offset:2px}
      .marker img{width:18px;height:18px;display:block}.marker.compact img{width:15px;height:15px}
      .panel{position:fixed;z-index:2147483001;top:0;left:0;width:212px;padding:6px;border:1px solid rgba(216,220,229,.94);border-radius:11px;background:rgba(255,255,255,.97);box-shadow:0 14px 38px rgba(18,23,38,.18),0 2px 8px rgba(18,23,38,.08);color:#17191f;backdrop-filter:blur(18px)}
      .panel.compact{width:188px}
      .panel[hidden]{display:none}
      .panel-head{height:27px;padding:0 7px;display:flex;align-items:center;gap:7px;color:#747a86;font-size:10px;font-weight:600;letter-spacing:.01em}
      .panel-head img{width:15px;height:15px;border-radius:4px}.panel-head span:last-child{margin-left:auto;max-width:104px;overflow:hidden;color:#969ba5;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
      .menu{display:grid;gap:2px}.menu-row{width:100%;min-height:34px;padding:6px 8px;border:0;border-radius:7px;display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;gap:8px;background:transparent;color:#252832;font:11px inherit;text-align:left;cursor:pointer}
      .menu-row:hover{background:#f2f3f7}.menu-row:focus-visible{outline:2px solid rgba(81,95,212,.38);outline-offset:-2px}.menu-icon{width:15px;height:15px;display:block;background:currentColor;mask:var(--icon) center/contain no-repeat;-webkit-mask:var(--icon) center/contain no-repeat;color:#6a7180}.menu-row strong{font-weight:600}.menu-row small{max-width:94px;overflow:hidden;color:#777e8b;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.menu-row.collect{color:#4655c8}.menu-row.collect .menu-icon{color:#5364d9}.menu-row:disabled{opacity:.58;cursor:default}
      .project-editor{margin:3px 2px 2px;padding:7px;border-radius:8px;background:#f5f6f9}.project-editor[hidden]{display:none}.project-editor label{display:grid;gap:4px;color:#747a86;font-size:9px}
      input{width:100%;height:27px;padding:4px 7px;border:1px solid #dfe2e9;border-radius:6px;background:#fff;color:#17191f;font:11px inherit;outline:none}
      input:focus{border-color:#5967dc;box-shadow:inset 0 0 0 1px #5967dc}
      .status{margin:3px 3px 2px;padding:6px 8px;border-radius:6px;background:#f5f6f9;color:#69707d;font-size:9px;line-height:1.35}.status:empty{display:none}.status.ok{background:#eef8f3;color:#237757}.status.error{background:#fff1f2;color:#b43a45}
    `;
  }

  function mount(surface, metadata, options = {}) {
    const floating = Boolean(options.floating);
    if (floating ? document.documentElement.hasAttribute(PAGE_MARKER) : surface.hasAttribute(MARKER)) return;
    if (floating) document.documentElement.setAttribute(PAGE_MARKER, '');
    else {
      surface.setAttribute(MARKER, '');
      if (getComputedStyle(surface).position === 'static') surface.style.position = 'relative';
    }
    const host = document.createElement('span');
    host.setAttribute('data-clipcargo-host', '');
    const shadow = host.attachShadow({ mode: 'closed' });
    const panelHost = document.createElement('span');
    panelHost.setAttribute('data-clipcargo-panel-host', '');
    // The panel lives under documentElement so it can escape card clipping. Keep
    // a reference to its card so virtualized feeds can release it when a card is
    // recycled or removed while the user scrolls.
    const trackedSurface = floating ? document.documentElement : surface;
    host.__clipCargoSurface = trackedSurface;
    panelHost.__clipCargoSurface = trackedSurface;
    panelHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;isolation:isolate';
    const panelShadow = panelHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = styleText();
    const marker = document.createElement('button');
    marker.className = 'marker';
    marker.type = 'button';
    marker.title = '用 ClipCargo 收集这个视频';
    marker.setAttribute('aria-label', '用 ClipCargo 收集这个视频');
    if (!chrome.runtime?.id) return;
    const logo = document.createElement('img');
    logo.src = chrome.runtime.getURL('icons/32.png');
    logo.alt = '';
    marker.append(logo);
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.hidden = true;
    panel.innerHTML = `<div class="panel-head"><img src="${chrome.runtime.getURL('icons/32.png')}" alt=""><span>ClipCargo</span><span class="platform">${defaultProject(metadata.pageUrl)}</span></div><div class="menu"><button class="menu-row collect" type="button"><span class="menu-icon" style="--icon:url('${chrome.runtime.getURL('icons/download.svg')}')" aria-hidden="true"></span><strong>收集这个视频</strong></button><button class="menu-row project-toggle" type="button" aria-expanded="false"><span class="menu-icon" style="--icon:url('${chrome.runtime.getURL('icons/folder.svg')}')" aria-hidden="true"></span><span>保存到</span><small class="project-name">${defaultProject(metadata.pageUrl)}</small></button></div><div class="project-editor" hidden><label>项目<input maxlength="50" value="${defaultProject(metadata.pageUrl)}" aria-label="保存到项目"></label></div><p class="status" aria-live="polite"></p>`;
    const surfaceRect = surface.getBoundingClientRect();
    if (floating || surfaceRect.width < 260 || surfaceRect.height < 150) {
      marker.classList.add('compact');
      panel.classList.add('compact');
    }
    const project = panel.querySelector('input');
    const collect = panel.querySelector('.collect');
    const collectLabel = collect.querySelector('strong');
    const projectToggle = panel.querySelector('.project-toggle');
    const projectEditor = panel.querySelector('.project-editor');
    const projectName = panel.querySelector('.project-name');
    const status = panel.querySelector('.status');
    const projectHost = new URL(metadata.pageUrl).hostname;
    chrome.storage.local.get('projectsByHost').then((stored) => {
      const remembered = stored.projectsByHost?.[projectHost];
      if (remembered?.trim()) project.value = remembered.slice(0, 50);
      projectName.textContent = project.value;
    });
    project.addEventListener('input', () => { projectName.textContent = project.value.trim() || '未分类'; });
    projectToggle.addEventListener('click', () => {
      const opening = projectEditor.hidden;
      projectEditor.hidden = !opening;
      projectToggle.setAttribute('aria-expanded', String(opening));
      positionPanel();
      if (opening) project.focus();
    });
    const positionPanel = () => {
      const rect = marker.getBoundingClientRect();
      const panelWidth = panel.offsetWidth || (panel.classList.contains('compact') ? 188 : 212);
      const panelHeight = Math.max(panel.offsetHeight, 104);
      const left = Math.max(8, Math.min(window.innerWidth - panelWidth - 8, rect.left));
      const below = rect.bottom + 7;
      const top = below + panelHeight <= window.innerHeight - 8
        ? below
        : Math.max(8, rect.top - panelHeight - 7);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    marker.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      if (panel.hidden) {
        closeActivePanel?.();
        panel.hidden = false;
        closeActivePanel = () => { panel.hidden = true; closeActivePanel = null; };
        positionPanel();
        collect.focus();
      } else {
        closeActivePanel?.();
      }
    });
    const controlLifetime = new AbortController();
    const repositionPanel = () => { if (!panel.hidden) positionPanel(); };
    window.addEventListener('scroll', repositionPanel, { capture: true, signal: controlLifetime.signal });
    window.addEventListener('resize', repositionPanel, { signal: controlLifetime.signal });
    host.__clipCargoCleanup = () => {
      controlLifetime.abort();
      panelHost.remove();
    };
    panel.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); });
    collect.addEventListener('click', async () => {
      collect.disabled = true;
      collectLabel.textContent = '正在收集…';
      status.textContent = '';
      const projectName = project.value.trim() || '未分类';
      const stored = await chrome.storage.local.get('projectsByHost');
      await chrome.storage.local.set({ projectsByHost: { ...(stored.projectsByHost || {}), [projectHost]: projectName } });
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'capture-video-card',
          payload: { pageUrl: metadata.pageUrl, title: metadata.title, projectName, method: 'extension' },
        });
        if (!response?.ok) throw new Error(response?.error || 'ClipCargo 没有确认接收。');
        status.textContent = response.value?.queued ? '已暂存，打开 ClipCargo 后会自动发送。' : '已收进 ClipCargo。';
        status.className = 'status ok';
        collectLabel.textContent = '已收集';
        setTimeout(() => {
          closeActivePanel?.();
          collect.disabled = false;
          collectLabel.textContent = '收集这个视频';
          status.textContent = '';
        }, response.value?.queued ? 1200 : 650);
      } catch (error) {
        status.textContent = error?.message || '发送失败，请重试。';
        status.className = 'status error';
        collect.disabled = false;
        collectLabel.textContent = '重新收集';
      }
    });
    shadow.append(style, marker);
    panelShadow.append(style.cloneNode(true), panel);
    document.documentElement.append(panelHost);
    if (floating) {
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;top:14px;right:14px;left:auto';
      document.documentElement.append(host);
    } else {
      surface.append(host);
    }
  }

  function pruneDetachedControls() {
    document.querySelectorAll('[data-clipcargo-panel-host]').forEach((panelHost) => {
      const surface = panelHost.__clipCargoSurface;
      if (surface?.isConnected !== false) return;
      panelHost.remove();
    });
  }

  function scan() {
    pruneDetachedControls();
    for (const link of document.querySelectorAll('a[href]')) {
      const pageUrl = videoUrl(link.href);
      if (!pageUrl) continue;
      if (isXHost() && !xVideoSurface(link)) continue;
      const surface = mediaSurface(link);
      if (surface) mount(surface, { pageUrl, title: cardTitle(link, surface) });
    }
    for (const video of document.querySelectorAll('video, [data-testid="videoPlayer"]')) {
      if (video.closest(`[${MARKER}]`)) continue;
      const pageUrl = mediaPageUrl(video);
      if (!pageUrl) continue;
      const surface = video.matches('[data-testid="videoPlayer"]') ? video : video.parentElement;
      if (surface?.getBoundingClientRect().width >= 120) {
        const statusLink = tweetStatusLink(video);
        mount(surface, { pageUrl, title: statusLink ? cardTitle(statusLink, surface) : document.title.slice(0, 512) });
      }
    }
    if (customSite && !document.querySelector(`[${MARKER}]`) && !document.documentElement.hasAttribute(PAGE_MARKER)) {
      mount(document.documentElement, { pageUrl: location.href, title: document.title.slice(0, 512) }, { floating: true });
    }
    if (typeof ResizeObserver === 'function') {
      resizeObserver ||= new ResizeObserver(() => scheduleScan());
      document.querySelectorAll('video, [data-testid="videoPlayer"]').forEach((target) => {
        if (observedResizeTargets.has(target)) return;
        observedResizeTargets.add(target);
        resizeObserver.observe(target);
      });
    }
  }

  let scheduled = false;
  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; scan(); }, 180);
  }
  async function start() {
    const host = hostOverride.toLowerCase().replace(/^www\./, '');
    const stored = await chrome.storage.local.get(['mediaSites', 'disabledMediaSites']);
    const disabled = Array.isArray(stored.disabledMediaSites) ? stored.disabledMediaSites : [];
    if (disabled.includes(host)) return;
    const configured = Array.isArray(stored.mediaSites) ? stored.mediaSites : [];
    customSite = configured.includes(host);
    if (!SUPPORTED_HOSTS.has(hostOverride) && !customSite) return;
    scan();
    mutationObserver = new MutationObserver(scheduleScan);
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-testid', 'poster', 'src', 'style'],
    });
    navigationListener = scheduleScan;
    documentClickListener = () => closeActivePanel?.();
    document.addEventListener('yt-navigate-finish', navigationListener, true);
    document.addEventListener('click', documentClickListener);
  }
  start().catch(() => {});
})();
