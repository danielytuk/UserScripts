// ==UserScript==
// @name         YouTube One-Ear / Mono Audio Fix (Stereo-Safe, Smart)
// @namespace    danielytuk-ytAudioFix
// @version      2.0.0
// @description  Automatically fixes one-ear / broken mono audio on YouTube while preserving real stereo when available.
// @author       danielytuk
// @match        https://www.youtube.com/watch*
// @match        https://m.youtube.com/watch*
// @match        https://www.youtube.com/embed/*
// @match        https://www.youtube-nocookie.com/embed/*
// @run-at       document-idle
// @grant        none
// @license      Unlicense
// @homepageURL  https://github.com/danielytuk/UserScripts
// @supportURL   https://github.com/danielytuk/UserScripts/issues
// @downloadURL  https://raw.githubusercontent.com/danielytuk/UserScripts/refs/heads/main/scripts/ytaudioFix.user.js
// @updateURL    https://raw.githubusercontent.com/danielytuk/UserScripts/refs/heads/main/scripts/ytaudioFix.user.js
// @compatible   chrome
// @compatible   firefox
// @compatible   edge
// ==/UserScript==

(() => {
  'use strict';

  /******************************************************************
   * Config / constants
   ******************************************************************/

  const STORAGE_KEY = 'ytMonoFixConfig';

  const DEFAULT_CONFIG = {
    enabled: true,
    showBadge: true,
    aggressive: false, // detect strong L/R imbalance, not just total silence
    logLevel: 0        // 0 = silent, 1 = info, 2 = debug
  };

  const FFT_SIZE = 32;
  const SILENCE_THRESHOLD = 0.02;       // RMS threshold for silent channel
  const AGGRESSIVE_RATIO = 4;           // RMS ratio to treat as one-ear in aggressive mode
  const FAST_CHECK_INTERVAL = 350;      // ms – initial fast detection
  const SLOW_CHECK_INTERVAL = 2000;     // ms – after mode is stable
  const STABLE_CHECKS_BEFORE_SLOW = 8;  // how many consistent results before slowing down

  let audioCtx = null;

  /** video -> state object */
  const videoStates = new WeakMap();
  /** Strong references for iteration (for config changes) */
  const activeStates = new Set();

  const loadConfig = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_CONFIG };
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  };

  const saveConfig = (cfg) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    } catch {
      // ignore quota errors
    }
  };

  let CONFIG = loadConfig();

  const log = (level, ...args) => {
    if (CONFIG.logLevel >= level) {
      console.log('[YT Mono Fix]', ...args);
    }
  };

  /**
   * Compute RMS of 8-bit PCM buffer (0..255) centered at 128.
   */
  const rms = (buf) => {
    let sum = 0;
    const len = buf.length;
    for (let i = 0; i < len; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / len);
  };

  // Decide if audio should be forced to mono for this sample.
  const shouldUseMono = (rmsL, rmsR) => {
    const leftSilent = rmsL < SILENCE_THRESHOLD;
    const rightSilent = rmsR < SILENCE_THRESHOLD;

    // Classic case: one side dead, the other alive
    if ((leftSilent && !rightSilent) || (rightSilent && !leftSilent)) {
      return true;
    }

    // Aggressive mode: huge imbalance counts as "broken"
    if (CONFIG.aggressive) {
      const maxVal = Math.max(rmsL, rmsR);
      const minVal = Math.min(rmsL, rmsR);

      if (maxVal > SILENCE_THRESHOLD && minVal > 0) {
        const ratio = maxVal / minVal;
        if (ratio >= AGGRESSIVE_RATIO) {
          return true;
        }
      }
    }

    return false;
  };

  let badgeEl = null;

  const ensureBadgeElement = () => {
    if (badgeEl) return badgeEl;

    const el = document.createElement('div');
    el.id = 'yt-mono-fix-badge';
    el.style.position = 'fixed';
    el.style.zIndex = '999999';
    el.style.bottom = '12px';
    el.style.left = '12px';
    el.style.padding = '4px 8px';
    el.style.fontSize = '11px';
    el.style.fontFamily = 'system-ui, sans-serif';
    el.style.background = 'rgba(0, 0, 0, 0.7)';
    el.style.color = '#fff';
    el.style.borderRadius = '4px';
    el.style.pointerEvents = 'none';
    el.style.userSelect = 'none';
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.15s ease-out';
    el.textContent = 'Mono Fix: ...';

    document.documentElement.appendChild(el);
    badgeEl = el;
    return el;
  };

  const updateBadge = (mode) => {
    if (!CONFIG.showBadge) {
      if (badgeEl) badgeEl.style.opacity = '0';
      return;
    }
    const el = ensureBadgeElement();
    if (!CONFIG.enabled) {
      el.textContent = 'Mono Fix: OFF (Stereo passthrough)';
    } else if (mode === 'mono') {
      el.textContent = CONFIG.aggressive
        ? 'Mono Fix: ON (Aggressive)'
        : 'Mono Fix: ON';
    } else if (mode === 'stereo') {
      el.textContent = 'Mono Fix: Stereo';
    } else {
      el.textContent = 'Mono Fix: Detecting...';
    }
    el.style.opacity = '1';
  };

  const getOrCreateAudioContext = () => {
    if (audioCtx) return audioCtx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
    return audioCtx;
  };

  const resumeAudioContext = () => {
    if (!audioCtx || audioCtx.state !== 'suspended') return;
    audioCtx.resume().catch(() => {});
  };

  /**
   * Ensure stereo routing (no mono fix) for this video.
   */
  const applyStereoRouting = (state) => {
    const { splitter, merger, gain } = state;

    // Clear any old routing to avoid parallel paths.
    try { splitter.disconnect(merger); } catch {}
    try { splitter.disconnect(gain); } catch {}
    try { gain.disconnect(merger); } catch {}

    // Direct stereo: L->L, R->R
    splitter.connect(merger, 0, 0);
    splitter.connect(merger, 1, 1);

    state.mode = 'stereo';
    log(2, 'Applied stereo routing');
  };

  /**
   * Ensure mono routing (both ears get mixed L+R).
   */
  const applyMonoRouting = (state) => {
    const { splitter, merger, gain } = state;

    try { splitter.disconnect(merger); } catch {}
    try { splitter.disconnect(gain); } catch {}
    try { gain.disconnect(merger); } catch {}

    // Mix both channels into gain, then output to both ears
    splitter.connect(gain, 0);
    splitter.connect(gain, 1);
    gain.connect(merger, 0, 0);
    gain.connect(merger, 0, 1);

    state.mode = 'mono';
    log(2, 'Applied mono routing');
  };

  /**
   * Guarantee routing that matches current CONFIG and detection decision.
   * If disabled via config, always stereo.
   */
  const ensureRoutingForDecision = (state, useMono) => {
    const desiredMode = CONFIG.enabled ? (useMono ? 'mono' : 'stereo') : 'stereo';

    if (state.mode === desiredMode) return;

    if (desiredMode === 'mono') {
      applyMonoRouting(state);
    } else {
      applyStereoRouting(state);
    }

    updateBadge(desiredMode);
  };

  /**
   * Create and attach audio graph to a video element.
   */
  const setupVideoAudio = (video) => {
    if (!video || videoStates.has(video)) return;

    const ctx = getOrCreateAudioContext();
    if (!ctx) {
      log(1, 'Web Audio not supported; Mono Fix disabled.');
      return;
    }

    resumeAudioContext();

    let sourceNode;
    try {
      sourceNode = ctx.createMediaElementSource(video);
    } catch (e) {
      // This can happen if another script already created a source for this element.
      log(1, 'MediaElementSource already exists or cannot be created:', e);
      return;
    }

    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const gain = ctx.createGain();
    const analyserL = ctx.createAnalyser();
    const analyserR = ctx.createAnalyser();

    analyserL.fftSize = FFT_SIZE;
    analyserR.fftSize = FFT_SIZE;
    gain.gain.value = 1;

    // Static wiring (doesn't change):
    // video -> splitter
    // splitter -> analysers
    // merger -> destination
    sourceNode.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);
    merger.connect(ctx.destination);

    const state = {
      video,
      ctx,
      sourceNode,
      splitter,
      merger,
      gain,
      analyserL,
      analyserR,
      bufferL: new Uint8Array(analyserL.fftSize),
      bufferR: new Uint8Array(analyserR.fftSize),
      mode: 'unknown',
      checkTimer: null,
      interval: FAST_CHECK_INTERVAL,
      stableCount: 0,
      destroyed: false
    };

    videoStates.set(video, state);
    activeStates.add(state);

    // Initial routing: stereo passthrough until detection says otherwise
    applyStereoRouting(state);
    updateBadge(state.mode);

    const scheduleNextCheck = () => {
      if (state.destroyed) return;
      state.checkTimer = setTimeout(runCheck, state.interval);
    };

    const stopChecks = () => {
      if (state.checkTimer != null) {
        clearTimeout(state.checkTimer);
        state.checkTimer = null;
      }
    };

    const runCheck = () => {
      if (state.destroyed) return;

      // If video not playing, pause detection until it resumes
      if (video.paused || video.ended) {
        stopChecks();
        return;
      }

      resumeAudioContext();

      state.analyserL.getByteTimeDomainData(state.bufferL);
      state.analyserR.getByteTimeDomainData(state.bufferR);

      const rmsL = rms(state.bufferL);
      const rmsR = rms(state.bufferR);
      const useMono = shouldUseMono(rmsL, rmsR);

      const prevMode = state.mode;
      ensureRoutingForDecision(state, useMono);

      if (state.mode === prevMode) {
        state.stableCount++;
      } else {
        state.stableCount = 0;
      }

      // Once we've had stable results for a while, slow down checks
      if (state.stableCount >= STABLE_CHECKS_BEFORE_SLOW) {
        state.interval = SLOW_CHECK_INTERVAL;
      }

      log(2, 'Check RMS L/R:', rmsL.toFixed(4), rmsR.toFixed(4),
        'mode=', state.mode, 'interval=', state.interval);

      scheduleNextCheck();
    };

    // Start checks when video actually plays
    const onPlay = () => {
      if (state.destroyed) return;
      if (state.checkTimer == null) {
        state.interval = FAST_CHECK_INTERVAL;
        state.stableCount = 0;
        runCheck();
      }
    };

    const onEndedOrPause = () => {
      // Stop checks to avoid pointless work
      stopChecks();
    };

    const onDispose = () => {
      if (state.destroyed) return;
      state.destroyed = true;
      stopChecks();
      try { state.sourceNode.disconnect(); } catch {}
      try { state.splitter.disconnect(); } catch {}
      try { state.gain.disconnect(); } catch {}
      try { state.merger.disconnect(); } catch {}
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onEndedOrPause);
      video.removeEventListener('ended', onEndedOrPause);
      activeStates.delete(state);
      // WeakMap entry will be GC'd when video is collected.
      log(2, 'Cleaned up audio state for video');
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onEndedOrPause);
    video.addEventListener('ended', onEndedOrPause);

    // If video is already playing when script attaches
    if (!video.paused && !video.ended) {
      onPlay();
    }

    // If the element is removed from DOM, try to clean up
    const observer = new MutationObserver(() => {
      if (!document.documentElement.contains(video)) {
        observer.disconnect();
        onDispose();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };

  /******************************************************************
   * Keyboard shortcuts & config broadcasting
   ******************************************************************/

  const applyConfigToAllStates = () => {
    for (const state of activeStates) {
      if (state.destroyed) continue;
      // Force routing to reconsider current mode with new config
      ensureRoutingForDecision(state, state.mode === 'mono');
    }
    // Badge reflects latest config + last state we touched
    updateBadge(activeStates.values().next().value?.mode ?? 'unknown');
  };

  const toggleEnabled = () => {
    CONFIG.enabled = !CONFIG.enabled;
    saveConfig(CONFIG);
    log(1, 'Mono Fix enabled =', CONFIG.enabled);
    applyConfigToAllStates();
  };

  const toggleAggressive = () => {
    CONFIG.aggressive = !CONFIG.aggressive;
    saveConfig(CONFIG);
    log(1, 'Aggressive mode =', CONFIG.aggressive);
    applyConfigToAllStates();
  };

  const toggleBadge = () => {
    CONFIG.showBadge = !CONFIG.showBadge;
    saveConfig(CONFIG);
    log(1, 'Badge visible =', CONFIG.showBadge);
    updateBadge(activeStates.values().next().value?.mode ?? 'unknown');
  };

  window.addEventListener('keydown', (ev) => {
    // Avoid triggering while typing in inputs/textareas or with IME, etc.
    const target = ev.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }

    if (!ev.altKey || !ev.shiftKey || ev.repeat) return;

    switch (ev.code) {
      case 'KeyM':
        toggleEnabled();
        break;
      case 'KeyA':
        toggleAggressive();
        break;
      case 'KeyB':
        toggleBadge();
        break;
      default:
        return;
    }

    ev.preventDefault();
    ev.stopPropagation();
  });

  /******************************************************************
   * Video discovery (MutationObserver + initial scan)
   ******************************************************************/

  const processExistingVideos = () => {
    const videos = document.querySelectorAll('video');
    videos.forEach(setupVideoAudio);
  };

  const observer = new MutationObserver((mutations) => {
    let foundVideo = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue; // ELEMENT_NODE
        if (node.tagName === 'VIDEO') {
          setupVideoAudio(node);
          foundVideo = true;
        } else {
          const vids = node.querySelectorAll?.('video');
          vids && vids.forEach(setupVideoAudio);
          if (vids && vids.length > 0) foundVideo = true;
        }
      }
    }
    if (foundVideo) {
      log(2, 'Detected new video element(s).');
    }
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
      processExistingVideos();
    }, { once: true });
  }

  // Initial scan in case videos are already there
  processExistingVideos();

  log(1, 'YouTube Mono Fix loaded. Shortcuts: Alt+Shift+M (toggle), Alt+Shift+A (aggressive), Alt+Shift+B (badge).');
})();
