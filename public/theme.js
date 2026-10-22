/* siiswell theme. A CLASSIC script that runs synchronously from <head> (no module, no inline code: the CSP
   forbids both), so <html data-theme> is set BEFORE the first paint and the page never flashes the wrong palette.

   choice = "auto" (default: follow the device, no attribute) | "light" | "dark".
   The choice lives in localStorage; every access is wrapped, so a browser that blocks storage (private window,
   cleared site data) still works: the choice then simply lasts until the page is closed.
   style.css keeps the light palette in :root, the dark one under `@media (prefers-color-scheme: dark)` (unless
   data-theme="light") and again under `:root[data-theme="dark"]`. window.OrchTheme (name kept: app.js reads it) is the tiny API app.js uses for
   the header switch (get / set / next). */
(function () {
  var KEY = "siiswell-theme";
  var LEGACY_KEY = "orch-theme"; /* the key before the rename: moved to KEY once, then removed */
  try {
    var old = localStorage.getItem(LEGACY_KEY);
    if (old !== null) {
      if (localStorage.getItem(KEY) === null) localStorage.setItem(KEY, old);
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch (e) {
    /* storage blocked: nothing to move */
  }
  var ORDER = ["auto", "light", "dark"];
  /* --bg of each palette in style.css: what the browser UI (address bar, status bar) is tinted with */
  var BG = { light: "#f6f7f9", dark: "#0e1013" };

  function valid(c) {
    return c === "light" || c === "dark" ? c : "auto";
  }
  function read() {
    try {
      return valid(localStorage.getItem(KEY));
    } catch (e) {
      return "auto";
    }
  }
  function write(c) {
    try {
      if (c === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, c);
    } catch (e) {
      /* storage blocked: the choice stays in memory only */
    }
  }

  function apply(c) {
    var root = document.documentElement;
    if (c === "light" || c === "dark") root.setAttribute("data-theme", c);
    else root.removeAttribute("data-theme");

    /* <meta name="theme-color"> comes as a light / dark pair selected by the DEVICE setting; a manual choice must
       win over it, so both get the chosen colour, and "auto" puts each back to its own. */
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      var forDark = /dark/.test(metas[i].getAttribute("media") || "");
      metas[i].setAttribute("content", c === "auto" ? (forDark ? BG.dark : BG.light) : BG[c]);
    }
    var scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.setAttribute("content", c === "auto" ? "light dark" : c);
  }

  var current = read();
  apply(current);

  window.OrchTheme = {
    ORDER: ORDER,
    get: function () {
      return current;
    },
    set: function (c) {
      current = valid(c);
      write(current);
      apply(current);
      return current;
    },
    /* the choice after `c` in Auto -> Light -> Dark -> Auto */
    next: function (c) {
      return ORDER[(ORDER.indexOf(valid(c)) + 1) % ORDER.length];
    },
  };
})();
