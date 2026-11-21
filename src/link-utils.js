(function exposeLinkUtilities(global) {
  const trailingSharePunctuation = /[),.;!?\]}>，。；！？、）】》」』》]+$/u;

  function extractHttpUrls(input) {
    const matches = String(input || '').match(/https?:\/\/[^\s<>"'`]+/giu) || [];
    return matches
      .map((value) => value.replace(trailingSharePunctuation, ''))
      .filter(Boolean);
  }

  global.ClipCargoLinkUtils = Object.freeze({ extractHttpUrls });
}(globalThis));
