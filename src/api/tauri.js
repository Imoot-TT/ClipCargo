// The renderer talks to Tauri through this small boundary. Keeping the
// capability lookup and error normalization here makes app.js usable in the
// browser harness and gives future views one stable application API.
(function exposeClipCargoTauriApi() {
  const tauriCore = globalThis.__TAURI__?.core;
  const tauriDialog = globalThis.__TAURI__?.dialog;

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

  globalThis.ClipCargoTauri = Object.freeze({ invoke, openNativeFileDialog });
})();
