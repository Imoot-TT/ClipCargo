// The renderer talks to Tauri through this small boundary. Keeping the
// capability lookup and error normalization here makes app.js usable in the
// browser harness and gives future views one stable application API.
(function exposeClipCargoTauriApi() {
  const tauriCore = globalThis.__TAURI__?.core;
  const tauriDialog = globalThis.__TAURI__?.dialog;
  const tauriWindow = globalThis.__TAURI__?.window;

  function unavailable(command) {
    const error = new Error(`Tauri command unavailable: ${command}`);
    error.code = 'TAURI_UNAVAILABLE';
    return error;
  }

  async function invoke(command, args) {
    if (typeof tauriCore?.invoke !== 'function') throw unavailable(command);
    try {
      return await tauriCore.invoke(command, args);
    } catch (error) {
      if (error instanceof Error) throw error;
      const normalized = new Error(typeof error === 'string' ? error : error?.message || 'Tauri command failed');
      normalized.cause = error;
      throw normalized;
    }
  }

  function openNativeFileDialog(options) {
    if (typeof tauriDialog?.open !== 'function') throw unavailable('dialog.open');
    return tauriDialog.open(options);
  }

  async function setWindowTheme(theme) {
    const window = typeof tauriWindow?.getCurrentWindow === 'function'
      ? tauriWindow.getCurrentWindow()
      : null;
    if (typeof window?.setTheme !== 'function') return false;
    try {
      await window.setTheme(theme || null);
      return true;
    } catch {
      return false;
    }
  }

  function currentWindow() {
    return typeof tauriWindow?.getCurrentWindow === 'function'
      ? tauriWindow.getCurrentWindow()
      : null;
  }

  async function runWindowAction(action) {
    const window = currentWindow();
    if (!window || typeof window[action] !== 'function') return false;
    await window[action]();
    return true;
  }

  const minimizeWindow = () => runWindowAction('minimize');
  const toggleMaximizeWindow = () => runWindowAction('toggleMaximize');
  const closeWindow = () => runWindowAction('close');
  const startWindowDragging = () => runWindowAction('startDragging');
  async function isWindowMaximized() {
    const window = currentWindow();
    return typeof window?.isMaximized === 'function' ? window.isMaximized() : false;
  }

  globalThis.ClipCargoTauri = Object.freeze({
    invoke,
    openNativeFileDialog,
    setWindowTheme,
    minimizeWindow,
    toggleMaximizeWindow,
    closeWindow,
    startWindowDragging,
    isWindowMaximized,
  });
})();
