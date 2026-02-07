// ==UserScript==
// @name         Image Proxy
// @namespace    danielytuk/IMGPROXY
// @version      1.0.1
// @description  Proxy Imgur (UK Ban) and any image that errors.
// @license      Unlicense
// @match        *://*/*
// @homepageURL  https://github.com/danielytuk/UserScripts
// @supportURL   https://github.com/danielytuk/UserScripts/Issues
// @icon         https://proxy.duckduckgo.com/iu/?u=https://imgur.com/favicon.ico
// @updateURL    https://raw.githubusercontent.com/danielytuk/UserScripts/refs/heads/main/scripts/imgproxy.user.js
// @run-at       document-start
// ==/UserScript==

(() => {
  "use strict";

  const P1 = "https://external-content.duckduckgo.com/iu/?u=";
  const P2 = "https://searx.namejeff.xyz/image_proxy?url=";

  const LAZY = ["data-src", "data-original"]; // keep tiny; add more if you really need
  const st = new WeakMap(); // el -> { o: originalAbsUrl, a: attempts, done: decidedOnce }

  const prox = (base, u) => base + encodeURIComponent(u);
  const isProxied = (u) => u && (u.indexOf(P1) === 0 || u.indexOf(P2) === 0 || u.indexOf("data:") === 0 || u.indexOf("blob:") === 0);

  const abs = (u) => {
    if (!u) return "";
    u = ("" + u).trim();
    if (!u) return "";
    if (u.slice(0, 2) === "//") u = location.protocol + u;
    try { return new URL(u, location.href).href; } catch { return ""; }
  };

  const isImgurI = (u) => {
    try { return new URL(u).hostname === "i.imgur.com"; } catch { return false; }
  };

  const getState = (el) => {
    let x = st.get(el);
    if (!x) { x = { o: "", a: 0, done: false }; st.set(el, x); }
    return x;
  };

  const pickImgUrl = (img) => img.getAttribute("src") || (LAZY[0] && img.getAttribute(LAZY[0])) || (LAZY[1] && img.getAttribute(LAZY[1])) || "";

  const rewriteSrcsetImgurOnly = (ss) => {
    if (!ss) return ss;
    // Each entry: "url [descriptor]"
    const parts = ss.split(",");
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i].trim();
      if (!p) continue;
      const sp = p.search(/\s/);
      const urlPart = sp === -1 ? p : p.slice(0, sp);
      const rest = sp === -1 ? "" : p.slice(sp);
      const u = abs(urlPart);
      if (u && !isProxied(u) && isImgurI(u)) parts[i] = prox(P1, u) + rest;
    }
    return parts.join(", ");
  };

  const ensureErrorHandler = (img) => {
    if (img.__mip_err) return;
    img.__mip_err = 1;

    img.addEventListener("error", () => {
      const x = getState(img);

      // Capture a stable original only once, from the first non-proxied URL we can see.
      if (!x.o) {
        const u = abs(pickImgUrl(img) || img.currentSrc || img.src);
        if (u && !isProxied(u)) x.o = u;
      }
      if (!x.o) return;

      // Advance fallback only a limited number of times.
      // original -> P1 -> P2 -> original, then stop.
      x.a++;
      if (x.a === 1) img.src = prox(P1, x.o);
      else if (x.a === 2) img.src = prox(P2, x.o);
      else if (x.a === 3) img.src = x.o;
    }, { passive: true });
  };

  const processImg = (img) => {
    if (!img || img.nodeType !== 1 || img.tagName !== "IMG") return;

    ensureErrorHandler(img);

    const x = getState(img);
    if (x.done) return;

    const u0 = abs(pickImgUrl(img));
    if (!u0) return; // wait until it has a URL; we'll see it again via mutations

    if (!x.o && !isProxied(u0)) x.o = u0;

    // Only pre-proxy i.imgur.com
    if (!isProxied(u0) && isImgurI(u0)) {
      const p = prox(P1, u0);
      img.setAttribute("src", p);
      for (let i = 0; i < LAZY.length; i++) if (img.hasAttribute(LAZY[i])) img.setAttribute(LAZY[i], p);
    }

    if (img.hasAttribute("srcset")) {
      const ss = img.getAttribute("srcset") || "";
      const n = rewriteSrcsetImgurOnly(ss);
      if (n !== ss) img.setAttribute("srcset", n);
    }

    x.done = true; // only decide/update once
  };

  const processSource = (el) => {
    if (!el || el.nodeType !== 1 || el.tagName !== "SOURCE" || !el.hasAttribute("srcset")) return;

    const x = getState(el);
    if (x.done) return;

    const ss = el.getAttribute("srcset") || "";
    if (!ss) return;

    const n = rewriteSrcsetImgurOnly(ss);
    if (n !== ss) el.setAttribute("srcset", n);

    x.done = true;
  };

  // --- fast batching ---
  const q = new Set();
  let raf = 0;

  const flush = () => {
    raf = 0;
    q.forEach((el) => {
      if (el.tagName === "IMG") processImg(el);
      else processSource(el);
    });
    q.clear();
  };

  const enqueue = (n) => {
    if (!n || n.nodeType !== 1) return;

    // Direct node
    if (n.tagName === "IMG" || (n.tagName === "SOURCE" && n.hasAttribute("srcset"))) q.add(n);

    // Descendants (only when needed)
    if (n.querySelectorAll) {
      const list = n.querySelectorAll("img,source[srcset]");
      for (let i = 0; i < list.length; i++) q.add(list[i]);
    }

    if (!raf) raf = requestAnimationFrame(flush);
  };

  // Observe DOM changes & attribute updates, but each element gets "decided" only once.
  new MutationObserver((ms) => {
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (m.type === "childList") {
        for (let j = 0; j < m.addedNodes.length; j++) enqueue(m.addedNodes[j]);
      } else {
        enqueue(m.target);
      }
    }
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "srcset"].concat(LAZY),
  });

  // Initial scan (cheap enough once)
  const scan = () => {
    const list = document.querySelectorAll("img,source[srcset]");
    for (let i = 0; i < list.length; i++) enqueue(list[i]);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan, { once: true });
  else scan();
})();
