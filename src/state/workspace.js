(function () {
  const ui = {
    drawer: { open: false, type: null, draft: {}, payload: null },
    inbox: {
      activeId: null,
      drafts: new Map(),
      preset: 'package',
      quality: '1080',
      saveSubtitles: true,
      subtitleLanguages: ['zh.*', 'en.*'],
      saveCover: true,
      saveSourceRecord: true,
      retainSource: true,
    },
    library: {
      activeKey: null,
      drafts: new Map(),
      subtitleQuery: '',
      subtitleTracks: [],
      subtitleCues: [],
      subtitleLoading: false,
      subtitleError: '',
    },
    studio: {
      activeKey: null,
      sessions: new Map(),
      pendingSeek: null,
      dragging: null,
      mountedKey: null,
      pendingAutoImports: new Map(),
    },
  };

  function ensureInboxDraft(item, preferences) {
    if (!item) return null;
    let draft = ui.inbox.drafts.get(item.id);
    if (!draft) {
      draft = {
        title: item.title || '',
        projectName: item.projectName || '未分类',
        preset: preferences?.downloadPreset || ui.inbox.preset,
        quality: preferences?.downloadQuality || ui.inbox.quality,
        saveSubtitles: preferences?.saveSubtitles ?? ui.inbox.saveSubtitles,
        subtitleLanguages: [...ui.inbox.subtitleLanguages],
        saveCover: true,
        saveSourceRecord: true,
        retainSource: true,
        dirty: false,
      };
      ui.inbox.drafts.set(item.id, draft);
    } else if (!draft.dirty) {
      draft.title = item.title || '';
      draft.projectName = item.projectName || '未分类';
    }
    return draft;
  }

  function ensureLibraryDraft(asset) {
    if (!asset) return null;
    const key = `${asset.assetType}:${asset.assetId}`;
    let draft = ui.library.drafts.get(key);
    if (!draft) {
      draft = { title: asset.title || '', projectName: asset.projectName || '未分类', dirty: false };
      ui.library.drafts.set(key, draft);
    } else if (!draft.dirty) {
      draft.title = asset.title || '';
      draft.projectName = asset.projectName || '未分类';
    }
    return draft;
  }

  function ensureStudioSession(asset) {
    if (!asset) return null;
    const key = `${asset.assetType}:${asset.assetId}`;
    let session = ui.studio.sessions.get(key);
    if (!session) {
      const savedTime = Number(localStorage.getItem(`clipcargo:studio-position:${key}`) || 0);
      const duration = Math.max(0, Number(asset.durationSeconds || 0));
      session = {
        currentTime: Number.isFinite(savedTime) ? savedTime : 0,
        duration,
        inPoint: 0,
        outPoint: duration || 10,
        playbackRate: 1,
        mode: 'clip',
        cropX: 50,
        cropY: 50,
        cropZoom: 100,
        notes: [],
        autoImport: false,
        loading: true,
        error: '',
        decodeError: false,
        path: '',
        subtitles: [],
      };
      ui.studio.sessions.set(key, session);
    } else if (!session.duration && asset.durationSeconds) {
      session.duration = Number(asset.durationSeconds);
      session.outPoint = session.duration;
    }
    return session;
  }

  function openStudioAsset(assetType, assetId, seekSeconds = null) {
    ui.studio.activeKey = `${assetType}:${assetId}`;
    ui.studio.pendingSeek = Number.isFinite(Number(seekSeconds)) ? Math.max(0, Number(seekSeconds)) : null;
  }

  function editableActiveElement(root = document) {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
    return active.matches('input, textarea, select, [contenteditable="true"]') ? active : null;
  }

  function shouldDeferRefresh(root = document) {
    const active = editableActiveElement(root);
    return Boolean(
      active?.matches('[data-preserve-refresh], #library-search, #subtitle-search')
      || ui.drawer.open
      || ui.studio.dragging
      || document.querySelector('#studio-video')
      || document.querySelector('[data-confirm-persistent="true"]'),
    );
  }

  function interactionKey(element) {
    if (!(element instanceof HTMLElement)) return null;
    if (element.dataset.focusKey) return `[data-focus-key="${CSS.escape(element.dataset.focusKey)}"]`;
    if (element.id) return `#${CSS.escape(element.id)}`;
    return null;
  }

  function captureInteraction(root = document) {
    const active = editableActiveElement(root);
    const key = interactionKey(active);
    return {
      key,
      selection: active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null,
      scrollTop: document.querySelector('#main')?.scrollTop || 0,
    };
  }

  function restoreInteraction(snapshot) {
    if (!snapshot) return;
    const replacement = snapshot.key ? document.querySelector(snapshot.key) : null;
    if (replacement instanceof HTMLElement && !replacement.hasAttribute('disabled')) {
      replacement.focus({ preventScroll: true });
      if (snapshot.selection && 'setSelectionRange' in replacement) {
        replacement.setSelectionRange(snapshot.selection[0], snapshot.selection[1]);
      }
    }
    const main = document.querySelector('#main');
    if (main) main.scrollTop = snapshot.scrollTop || 0;
  }

  function openDrawer(type, draft = {}, payload = null) {
    ui.drawer.open = true;
    ui.drawer.type = type;
    ui.drawer.draft = { ...draft };
    ui.drawer.payload = payload;
  }

  function closeDrawer() {
    ui.drawer.open = false;
    ui.drawer.type = null;
    ui.drawer.draft = {};
    ui.drawer.payload = null;
  }

  function resetLibrarySubtitles() {
    ui.library.subtitleQuery = '';
    ui.library.subtitleTracks = [];
    ui.library.subtitleCues = [];
    ui.library.subtitleLoading = false;
    ui.library.subtitleError = '';
  }

  function patchLiveData(root, state) {
    if (!root) return;
    const jobs = new Map((state.jobs || []).map((job) => [String(job.id), job]));
    const derivatives = new Map((state.derivatives || []).map((job) => [String(job.id), job]));
    root.querySelectorAll('[data-live-job-id]').forEach((node) => {
      const item = jobs.get(node.dataset.liveJobId);
      if (!item) return;
      const progress = Math.max(0, Math.min(100, Number(item.progressPercent || 0)));
      node.style.setProperty('--live-progress', `${progress}%`);
      node.querySelector('[data-live-progress-fill]')?.style.setProperty('width', `${progress}%`);
      const label = node.querySelector('[data-live-progress-label]');
      if (label) label.textContent = `${Math.round(progress)}%`;
    });
    root.querySelectorAll('[data-live-derivative-id]').forEach((node) => {
      const item = derivatives.get(node.dataset.liveDerivativeId);
      if (!item) return;
      const progress = Math.max(0, Math.min(100, Number(item.progressPercent || 0)));
      node.querySelector('[data-live-progress-fill]')?.style.setProperty('width', `${progress}%`);
      const label = node.querySelector('[data-live-progress-label]');
      if (label) label.textContent = `${Math.round(progress)}%`;
    });
  }

  window.ClipCargoWorkspace = {
    ui,
    ensureInboxDraft,
    ensureLibraryDraft,
    ensureStudioSession,
    openStudioAsset,
    shouldDeferRefresh,
    captureInteraction,
    restoreInteraction,
    openDrawer,
    closeDrawer,
    resetLibrarySubtitles,
    patchLiveData,
  };
})();
