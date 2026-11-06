/** Dedicated IAB shim; never includes the Host Renderer binding or changes page CSP. */
export const BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE = String.raw`(() => {
  const key = '__codexhostBrowserAnnotationStylesV1';
  if (globalThis[key]?.refresh() === true) return;
  if (typeof CSSStyleSheet !== 'function' ||
      typeof CSSStyleSheet.prototype.replaceSync !== 'function') return;
  let root = null;
  let shadow = null;
  let stylesObserver = null;
  const copies = new Map();
  function removeCopies() {
    if (shadow) {
      const owned = new Set(Array.from(copies.values(), copy => copy.sheet));
      shadow.adoptedStyleSheets = shadow.adoptedStyleSheets.filter(sheet => !owned.has(sheet));
    }
    copies.clear();
  }
  function syncStyles() {
    if (!shadow) return;
    const present = new Set();
    for (const style of shadow.querySelectorAll('style')) {
      const text = style.textContent || '';
      // Only repair Codex's cursor stylesheet when CSP rejected its style element.
      if (style.sheet || !text.includes('.annotation-selection-cursor')) continue;
      present.add(style);
      const previous = copies.get(style);
      if (previous?.text === text && shadow.adoptedStyleSheets.includes(previous.sheet)) continue;
      try {
        const sheet = previous?.sheet ?? new CSSStyleSheet();
        sheet.replaceSync(text);
        if (!shadow.adoptedStyleSheets.includes(sheet)) {
          shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
        }
        copies.set(style, { sheet, text });
      } catch { /* Unsupported annotation styles leave native behavior intact. */ }
    }
    for (const [style, copy] of copies) {
      if (present.has(style)) continue;
      shadow.adoptedStyleSheets = shadow.adoptedStyleSheets.filter(sheet => sheet !== copy.sheet);
      copies.delete(style);
    }
  }
  function refresh() {
    const nextRoot = document.documentElement;
    if (root !== nextRoot) {
      rootObserver.disconnect();
      rootObserver.observe(document, { childList: true });
      root = nextRoot;
      if (root) rootObserver.observe(root, { childList: true });
    }
    const host = document.getElementById('codex-browser-sidebar-comments-root');
    const nextShadow = host?.parentElement === root ? host?.shadowRoot ?? null : null;
    if (nextShadow !== shadow) {
      stylesObserver?.disconnect();
      removeCopies();
      shadow = nextShadow;
      stylesObserver = null;
      if (shadow && 'adoptedStyleSheets' in shadow) {
        stylesObserver = new MutationObserver(syncStyles);
        stylesObserver.observe(shadow, { childList: true, subtree: true, characterData: true });
      } else {
        shadow = null;
      }
    }
    syncStyles();
    return true;
  }
  const rootObserver = new MutationObserver(refresh);
  rootObserver.observe(document, { childList: true });
  globalThis[key] = { refresh };
  refresh();
})();`;
