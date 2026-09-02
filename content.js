// SWIPE FOR LETTERBOXD — Content Script v6.3.0-beta.5
// Background actions + auto-advance + auto-next-page + Trailer keyboard playback + Voice Review + Star Rating
// v6.0.0: FilmState registry, fresh poster filtering, durable skip,
//         account awareness, collection sync, settings panel, local profile database
// v6.0.1: corrupted-storage load safety, 429/503 sync backoff, throttled review fan-out
// v6.0.2: same-instant reconcile/userAction tie-break, adaptive debounce for large libraries
// v6.1.0: rebrand Vypode → "Swipe for Letterboxd" (user-facing strings only)
// v6.3.0-beta.3: trailer shortcut and resilient review dictation
// v6.3.0-beta.4: cold-start and toggle trailer playback with K or Space
// v6.3.0-beta.5: verified account actions, safe sync, and account-scoped state
(function() {
  'use strict';
  if (window.vypodeInjected) return;
  window.vypodeInjected = true;

  // ── Core UI state ───────────────────────────────────────────────────

  let currentZone = 'neutral';
  let isOverCard = false;
  let vypodeVisible = false;
  let filmDeck = [];       // filtered deck the user swipes through
  let masterDeck = [];     // unfiltered films accumulated across pages — the
                           // source of truth when filters are re-applied
  let currentDeckIndex = 0;
  let isListingPage = false;
  let isProcessingAction = false;
  let actionIframe = null;
  let iframeTimeout = null;

  // Background action queue — lets user swipe instantly while Letterboxd syncs
  let actionQueue = [];
  let isProcessingQueue = false;
  let activeQueueItem = null;
  let activeSingleFilmAction = null;
  let actionQueueRetryTimer = null;
  let actionOutboxHydrated = false;
  let actionOutboxWriteChain = Promise.resolve();
  let actionQueueEpoch = 0;
  let actionQueueSuspended = false;
  const pendingActionOutboxOperations = new Set();
  let pendingDeckStateRefilter = false;
  let pendingDeckStateRefilterTimer = null;
  const ACTION_OUTBOX_KEY = 'vypode_action_outbox_v1';
  const ACTION_OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const ACTION_LEASE_MS = 30000;
  const ACCOUNT_ACTIONS = new Set(['watch', 'like', 'watchlist']);
  const DECK_ACTIONS = new Set(['watch', 'like', 'watchlist', 'skip']);
  const actionQueueOwnerToken = `tab:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  // Review & Rating state
  let reviewPanelVisible = false;
  let settingsPanelVisible = false;
  let currentRating = 0;
  let recognition = null;
  let speechState = 'idle';
  let speechSessionId = 0;
  let speechStartTimer = null;
  let speechStopTimer = null;
  let speechStopPromise = null;
  let resolveSpeechStop = null;
  let reviewReturnFocus = null;
  let reviewDraftContext = null;
  let reviewDraftSaveTimer = null;
  let reviewDraftWriteChain = Promise.resolve();
  let settingsReturnFocus = null;
  let overlayReturnFocus = null;
  const modalDialogStack = [];
  let databaseVisibleLimit = 80;
  let databaseQuerySignature = '';
  let trailerPlayerObserver = null;
  let trailerPlayerObserverTimer = null;
  let trailerPlaybackPhase = 'idle';
  const TRAILER_PLAY_REQUESTED = 'play-requested';
  const TRAILER_PAUSE_REQUESTED = 'pause-requested';
  let trailerPlaybackDesired = TRAILER_PAUSE_REQUESTED;
  let trailerKeyboardFrame = null;
  const SPEECH_START_TIMEOUT_MS = 30000;
  const SPEECH_STOP_TIMEOUT_MS = 4000;
  const TRAILER_PLAYER_WAIT_MS = 4000;
  const REVIEW_DRAFTS_KEY = 'vypode_review_drafts_v1';
  const MAX_REVIEW_TEXT_LENGTH = 50000;
  const MAX_REVIEW_TAGS = 20;
  const MAX_REVIEW_TAG_LENGTH = 100;
  const DATABASE_PAGE_SIZE = 80;

  // Account state
  let letterboxdUsername = null;
  let isLetterboxdSessionActive = false;
  let isSyncing = false;
  let syncAbortController = null;
  let syncRequiresRefresh = false;
  let popupSyncRun = null;
  let resolveContentInitialization;
  const contentInitialization = new Promise(resolve => {
    resolveContentInitialization = resolve;
  });

  // Track how many films were filtered so we can show a badge
  let filteredCount = 0;

  // ── Selector constants ──────────────────────────────────────────────

  const SELECTORS = {
    watch: '[data-track-action="Watched"], .action.-watch, .film-watch-link-target',
    like: '[data-track-action="Liked"], .action.-like, .film-like-link-target',
    watchlist: '[data-track-action="Watchlist"], .action.-watchlist, .film-watch-list-link-target',
    watchedState: '.action.-watch.-checked, .action.-watch.-on, .icon-watched.-on, .film-watch-link-target.icon-watched.-on',
    likedState: '.action.-like.-checked, .action.-like.-on, .icon-like.-on, .film-like-link-target.icon-like.-on',
    watchlistState: '.action.-watchlist.-checked, .action.-watchlist.-on, .icon-watchlist.-on, .film-watch-list-link-target.icon-watchlist.-on, .remove-from-watchlist'
  };
  const EMPTY_POSTER_URL = 'https://letterboxd.com/static/img/empty-poster-230.c6baa486.png';

  // ── HTML escaping ───────────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function isSafeFilmSlug(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
      /^[a-z0-9][a-z0-9-]*$/i.test(value) &&
      value !== '__proto__' && value !== 'constructor' && value !== 'prototype';
  }

  function parsedLetterboxdUrl(raw, baseUrl) {
    if (typeof raw !== 'string' || !raw || raw.length > 2048) return null;
    try {
      const url = new URL(raw, baseUrl || 'https://letterboxd.com/');
      if (url.origin !== 'https://letterboxd.com' || url.username || url.password) return null;
      return url;
    } catch {
      return null;
    }
  }

  function absoluteLetterboxdUrl(path) {
    const url = parsedLetterboxdUrl(path);
    return url ? url.href : '';
  }

  function canonicalLetterboxdFilmUrl(raw, expectedSlug) {
    if (!isSafeFilmSlug(expectedSlug)) return '';
    const url = parsedLetterboxdUrl(raw);
    if (!url || url.search || url.hash) return '';
    const match = url.pathname.match(/^\/film\/([a-z0-9][a-z0-9-]*)\/?$/i);
    if (!match || match[1].toLowerCase() !== expectedSlug.toLowerCase()) return '';
    return `https://letterboxd.com/film/${expectedSlug}/`;
  }

  function canonicalLetterboxdReviewUrl(raw, expectedSlug, expectedUsername) {
    if (!isSafeFilmSlug(expectedSlug) || !/^[a-z0-9_]{1,64}$/i.test(expectedUsername || '')) return '';
    const url = parsedLetterboxdUrl(raw);
    if (!url || url.search || url.hash) return '';
    const username = String(expectedUsername).toLowerCase();
    const slug = expectedSlug.toLowerCase();
    const current = url.pathname.match(/^\/([a-z0-9_]{1,64})\/film\/([a-z0-9][a-z0-9-]*)\/(?:([1-9]\d*)\/)?$/i);
    if (current && current[1].toLowerCase() === username && current[2].toLowerCase() === slug) {
      return `https://letterboxd.com/${username}/film/${expectedSlug}/${current[3] ? `${current[3]}/` : ''}`;
    }
    const legacy = url.pathname.match(/^\/film\/([a-z0-9][a-z0-9-]*)\/reviews\/by\/([a-z0-9_]{1,64})\/(?:([a-z0-9][a-z0-9-]*)\/)?$/i);
    if (legacy && legacy[1].toLowerCase() === slug && legacy[2].toLowerCase() === username) {
      return `https://letterboxd.com/film/${expectedSlug}/reviews/by/${username}/${legacy[3] ? `${legacy[3]}/` : ''}`;
    }
    return '';
  }

  function getTrailerPageUrl(film) {
    const slug = String(film?.slug || '');
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return '';
    return `https://letterboxd.com/film/${slug}/trailer/`;
  }

  function isTrailerPage() {
    return /^\/film\/[a-z0-9][a-z0-9-]*\/trailer\/?$/i.test(window.location.pathname);
  }

  function getYouTubeEmbedUrl(element) {
    if (!element) return null;
    const rawSrc = element.getAttribute('src') || element.getAttribute('href') || '';
    let url;
    try {
      url = new URL(rawSrc, window.location.href);
    } catch {
      return null;
    }
    const allowedHosts = new Set([
      'youtube.com',
      'www.youtube.com',
      'youtube-nocookie.com',
      'www.youtube-nocookie.com'
    ]);
    if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) return null;
    if (!/^\/embed\/[a-z0-9_-]+\/?$/i.test(url.pathname)) return null;
    return url;
  }

  function getTrailerPlayerFrame() {
    const frames = document.querySelectorAll(
      '#colorbox.-video iframe.cboxIframe, #cboxLoadedContent iframe.cboxIframe'
    );
    return Array.from(frames).find(frame => getYouTubeEmbedUrl(frame)) || null;
  }

  function getTrailerPlayerTrigger() {
    return Array.from(document.querySelectorAll(
      '.js-watch-panel-trailer a.js-video-zoom[href]'
    )).find(link => getYouTubeEmbedUrl(link)) || null;
  }

  function postYouTubeCommand(frame, targetOrigin, command) {
    try {
      frame?.contentWindow?.postMessage(
        JSON.stringify({ event: 'command', func: command, args: [] }),
        targetOrigin
      );
    } catch {}
  }

  function resetTrailerPlaybackSession() {
    trailerPlaybackPhase = 'idle';
    trailerPlaybackDesired = TRAILER_PAUSE_REQUESTED;
    trailerKeyboardFrame = null;
    updateTrailerPageControl();
  }

  function reconcileTrailerPlaybackSession(frame) {
    if (trailerPlaybackPhase !== 'ready') return;
    if (trailerKeyboardFrame !== frame || trailerKeyboardFrame?.isConnected === false) {
      resetTrailerPlaybackSession();
    }
  }

  function setTrailerPlaybackState(frame, shouldPlay) {
    trailerPlaybackPhase = 'ready';
    trailerPlaybackDesired = shouldPlay ? TRAILER_PLAY_REQUESTED : TRAILER_PAUSE_REQUESTED;
    trailerKeyboardFrame = frame;
    frame.dataset.vypodePlaybackRequested = trailerPlaybackDesired;
    updateTrailerPageControl();
  }

  function requestTrailerPlayback(frame, targetOrigin, shouldPlay) {
    setTrailerPlaybackState(frame, shouldPlay);
    postYouTubeCommand(frame, targetOrigin, shouldPlay ? 'playVideo' : 'pauseVideo');
  }

  function configureTrailerPlayer(frame, desiredState) {
    const url = getYouTubeEmbedUrl(frame);
    if (!url) return false;
    reconcileTrailerPlaybackSession(frame);

    const allowTokens = (frame.getAttribute('allow') || '')
      .split(';')
      .map(token => token.trim())
      .filter(Boolean);
    if (!allowTokens.some(token => token.split(/\s+/)[0] === 'autoplay')) allowTokens.push('autoplay');
    if (!allowTokens.some(token => token.split(/\s+/)[0] === 'encrypted-media')) allowTokens.push('encrypted-media');
    frame.setAttribute('allow', allowTokens.join('; '));
    if (!frame.getAttribute('title')) frame.setAttribute('title', 'YouTube trailer player');

    const alreadyConfigured =
      frame.dataset.vypodeKeyboardPlayer === 'true' &&
      url.searchParams.get('enablejsapi') === '1';
    const shouldPlay = desiredState === TRAILER_PLAY_REQUESTED
      ? true
      : desiredState === TRAILER_PAUSE_REQUESTED
        ? false
        : !(alreadyConfigured && trailerPlaybackPhase === 'ready' && trailerPlaybackDesired === TRAILER_PLAY_REQUESTED);
    if (alreadyConfigured) {
      requestTrailerPlayback(frame, url.origin, shouldPlay);
      return true;
    }

    url.searchParams.set('enablejsapi', '1');
    url.searchParams.set('autoplay', '1');
    url.searchParams.set('origin', window.location.origin);
    frame.dataset.vypodeKeyboardPlayer = 'true';
    setTrailerPlaybackState(frame, shouldPlay);
    frame.addEventListener('load', () => {
      if (trailerPlaybackPhase !== 'ready' || trailerKeyboardFrame !== frame || frame.isConnected === false) return;
      requestTrailerPlayback(
        frame,
        url.origin,
        trailerPlaybackDesired === TRAILER_PLAY_REQUESTED
      );
    }, { once: true });
    frame.setAttribute('src', url.href);
    return true;
  }

  function clearTrailerPlayerWait(resetPending = false) {
    if (trailerPlayerObserver) trailerPlayerObserver.disconnect();
    if (trailerPlayerObserverTimer) clearTimeout(trailerPlayerObserverTimer);
    trailerPlayerObserver = null;
    trailerPlayerObserverTimer = null;
    if (resetPending && trailerPlaybackPhase === 'pending') resetTrailerPlaybackSession();
  }

  function waitForTrailerPlayer() {
    clearTrailerPlayerWait();
    if (typeof MutationObserver === 'function') {
      trailerPlayerObserver = new MutationObserver(() => {
        const frame = getTrailerPlayerFrame();
        if (!frame) return;
        const desiredState = trailerPlaybackDesired;
        clearTrailerPlayerWait();
        configureTrailerPlayer(frame, desiredState);
      });
      trailerPlayerObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    trailerPlayerObserverTimer = setTimeout(() => clearTrailerPlayerWait(true), TRAILER_PLAYER_WAIT_MS);
  }

  function activateTrailerPlayer() {
    const frame = getTrailerPlayerFrame();
    reconcileTrailerPlaybackSession(frame);
    if (frame) {
      if (trailerPlaybackPhase === 'pending') {
        trailerPlaybackDesired = trailerPlaybackDesired === TRAILER_PLAY_REQUESTED
          ? TRAILER_PAUSE_REQUESTED
          : TRAILER_PLAY_REQUESTED;
        updateTrailerPageControl();
        const desiredState = trailerPlaybackDesired;
        clearTrailerPlayerWait();
        return configureTrailerPlayer(frame, desiredState);
      }
      return configureTrailerPlayer(frame);
    }

    if (trailerPlaybackPhase === 'pending') {
      trailerPlaybackDesired = trailerPlaybackDesired === TRAILER_PLAY_REQUESTED
        ? TRAILER_PAUSE_REQUESTED
        : TRAILER_PLAY_REQUESTED;
      updateTrailerPageControl();
      return true;
    }

    const trigger = getTrailerPlayerTrigger();
    if (!trigger) return false;
    trailerPlaybackPhase = 'pending';
    trailerPlaybackDesired = TRAILER_PLAY_REQUESTED;
    trailerKeyboardFrame = null;
    updateTrailerPageControl();
    waitForTrailerPlayer();
    trigger.click();
    const insertedFrame = getTrailerPlayerFrame();
    if (insertedFrame) {
      const desiredState = trailerPlaybackDesired;
      clearTrailerPlayerWait();
      configureTrailerPlayer(insertedFrame, desiredState);
    }
    return true;
  }

  function isInteractiveControl(element) {
    if (!element || element === document || element === document.body) return false;
    if (isEditableElement(element)) return true;
    return Boolean(element.closest?.(
      'button, a[href], summary, [tabindex], [role="button"], [role="link"], [role="radio"], [role="menuitem"], [role="option"], [role="switch"], [role="tab"]'
    ));
  }

  function updateTrailerPageControl() {
    const control = document.getElementById('vypodeTrailerPlaybackControl');
    if (!control) return;
    const hasValidatedTarget = Boolean(getTrailerPlayerFrame() || getTrailerPlayerTrigger());
    const hasRequest = trailerPlaybackPhase === 'pending' || trailerPlaybackPhase === 'ready';
    const playRequested = hasRequest && trailerPlaybackDesired === TRAILER_PLAY_REQUESTED;
    const pauseRequested = hasRequest && trailerPlaybackDesired === TRAILER_PAUSE_REQUESTED;

    control.disabled = !hasValidatedTarget && !hasRequest;
    control.dataset.playbackState = playRequested
      ? TRAILER_PLAY_REQUESTED
      : pauseRequested
        ? TRAILER_PAUSE_REQUESTED
        : hasValidatedTarget ? 'idle' : 'unavailable';
    control.setAttribute('aria-pressed', playRequested ? 'true' : 'false');
    if (playRequested) {
      control.textContent = 'Play requested';
      control.setAttribute('aria-label', 'Pause trailer; play requested');
      control.title = 'Pause trailer (K or Space)';
    } else if (pauseRequested) {
      control.textContent = 'Pause requested';
      control.setAttribute('aria-label', 'Play trailer; pause requested');
      control.title = 'Play trailer (K or Space)';
    } else if (hasValidatedTarget) {
      control.textContent = 'Play trailer';
      control.setAttribute('aria-label', 'Play trailer');
      control.title = 'Play trailer (K)';
    } else {
      control.textContent = 'Trailer unavailable';
      control.setAttribute('aria-label', 'Trailer unavailable');
      control.title = 'No validated YouTube trailer was found on this page';
    }
  }

  function announceTrailerPlaybackRequest() {
    updateTrailerPageControl();
    const message = trailerPlaybackDesired === TRAILER_PAUSE_REQUESTED
      ? 'Pause requested — press K or Space to request play'
      : 'Play requested — press K or Space to request pause';
    showFeedback(message, 'watchlist');
  }

  function handleTrailerPageKeyDown(event) {
    if (!isTrailerPage() || event.defaultPrevented || event.isComposing) return;
    const isK = event.key === 'k' || event.key === 'K';
    const isSpace = event.key === ' ' || event.code === 'Space';
    const activePlayer = getTrailerPlayerFrame();
    reconcileTrailerPlaybackSession(activePlayer);
    const canToggleWithSpace = trailerPlaybackPhase === 'pending' || trailerPlaybackPhase === 'ready';
    const isPlaybackKey = isK || (isSpace && canToggleWithSpace);
    if (!isPlaybackKey) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return;
    if (isSpace && (isInteractiveControl(event.target) || isInteractiveControl(document.activeElement))) return;
    if (isUserTyping(event.target)) return;
    if (!activateTrailerPlayer()) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    announceTrailerPlaybackRequest();
  }

  function setupTrailerPageShortcut() {
    if (!isTrailerPage()) return;
    document.removeEventListener('keydown', handleTrailerPageKeyDown, true);
    document.addEventListener('keydown', handleTrailerPageKeyDown, true);
    if (!document.getElementById('vypodeTrailerPlaybackControl')) {
      const control = document.createElement('button');
      control.type = 'button';
      control.id = 'vypodeTrailerPlaybackControl';
      control.className = 'vypode-trailer-page-control';
      control.setAttribute('aria-keyshortcuts', 'K Space');
      control.addEventListener('click', () => {
        if (!activateTrailerPlayer()) {
          updateTrailerPageControl();
          return;
        }
        announceTrailerPlaybackRequest();
      });
      document.body.appendChild(control);
    }
    updateTrailerPageControl();
  }

  function readCsrfToken(doc) {
    const root = doc || document;
    const tokens = Array.from(root.querySelectorAll('input[name="__csrf"], meta[name="csrf-token"]'))
      .map(el => el.value || el.content || el.getAttribute('content') || '')
      .map(value => value.trim())
      .filter(value => value && value !== 'placeholder');
    return tokens[0] || null;
  }

  function normalizePosterUrl(url, srcset) {
    let posterUrl = url || '';
    if ((!posterUrl || posterUrl.includes('empty-poster')) && srcset) {
      posterUrl = srcset.split(',')[0]?.trim()?.split(' ')[0] || posterUrl;
    }
    if (!posterUrl) return '';
    let parsed;
    try { parsed = new URL(posterUrl, 'https://letterboxd.com/'); }
    catch { return ''; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !new Set([
      'https://a.ltrbxd.com',
      'https://s.ltrbxd.com',
      'https://letterboxd.com'
    ]).has(parsed.origin)) return '';
    return parsed.href
      .replace(/-0-\d+-0-\d+-crop/, '-0-460-0-690-crop')
      .replace(/-\d+-\d+-\d+-\d+-crop/, '-0-460-0-690-crop');
  }

  function attachPosterFallback(img) {
    if (!img || img.dataset.vypodeFallbackAttached) return;
    img.dataset.vypodeFallbackAttached = 'true';
    img.addEventListener('error', function() {
      if (this.src !== EMPTY_POSTER_URL) this.src = EMPTY_POSTER_URL;
    });
  }

  function setPosterImage(img, src, alt) {
    if (!img) return;
    attachPosterFallback(img);
    img.alt = alt || '';
    img.src = src || EMPTY_POSTER_URL;
  }

  function titleWithoutPosterPrefix(value, fallback) {
    return (value || fallback || 'Unknown Film').replace(/^Poster for /i, '').trim();
  }

  function parseYearFromTitle(title) {
    const match = String(title || '').match(/\((\d{4})\)\s*$/);
    return match ? match[1] : '';
  }

  function parseRatingValue(ratingEl) {
    if (!ratingEl) return null;
    const classRating = String(ratingEl.className || '').match(/rated-(\d+)/);
    if (classRating) return Number(classRating[1]) / 2;
    const text = ratingEl.textContent || '';
    let total = 0;
    for (const char of text) {
      if (char === '★') total += 1;
      if (char === '½') total += 0.5;
    }
    return total || null;
  }

  function persistFilmRecord(film, source) {
    if (!film?.slug || !window.VypodeFilmState?.updateFilm) return;
    const patch = {};
    const metadata = {
      title: film.title,
      year: film.year || parseYearFromTitle(film.title),
      director: film.director,
      genres: Array.isArray(film.genres) ? film.genres : undefined,
      poster: film.poster,
      url: film.url,
      rating: film.rating,
      ratingValue: film.ratingValue,
      reviewText: film.reviewText,
      reviewUrl: film.reviewUrl
    };
    for (const key in metadata) {
      if (metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== '') {
        patch[key] = metadata[key];
      }
    }
    if (film.isWatched || film.watched) patch.watched = true;
    if (film.isLiked || film.liked) patch.liked = true;
    if (film.inWatchlist || film.watchlist) patch.watchlist = true;
    window.VypodeFilmState.updateFilm(film.slug, patch, source || 'domSync');
  }

  // ── Account detection ───────────────────────────────────────────────
  // Letterboxd shows the logged-in username in the nav bar

  function pageShowsSignedOutNav(rootDocument = document) {
    return Array.from(rootDocument?.querySelectorAll?.('a[href]') || []).some(link => {
      const href = link.getAttribute('href') || '';
      return /sign[\s-]*in/i.test(link.textContent || '') && href.includes('sign-in');
    });
  }

  function usernameFromProfileHref(href) {
    const match = href?.match(/^\/([a-zA-Z0-9_]+)\/?$/);
    if (!match) return null;

    const slug = match[1];
    if (/^(films|lists|members|activity|journal|search|settings|pro|about)$/i.test(slug)) {
      return null;
    }
    return slug;
  }

  function detectLetterboxdUsername(rootDocument = document) {
    // Primary: nav profile link
    const profileLink = rootDocument?.querySelector?.('.main-nav a[href*="/"][class*="avatar"]') ||
                        rootDocument?.querySelector?.('.main-nav a.avatar[href]') ||
                        rootDocument?.querySelector?.('.nav .profile-menu a[href]') ||
                        rootDocument?.querySelector?.('header a.avatar[href]');
    if (profileLink) {
      const username = usernameFromProfileHref(profileLink.getAttribute('href'));
      if (username) return username;
    }

    // Current Letterboxd menus expose a "Profile" link under a signed-in
    // account toggle instead of an avatar href on every film page.
    const allLinks = Array.from(rootDocument?.querySelectorAll?.('a[href]') || []);
    const hasSignOutLink = allLinks.some(link => /sign\s*out/i.test(link.textContent || ''));
    if (hasSignOutLink) {
      for (const link of allLinks) {
        const username = usernameFromProfileHref(link.getAttribute('href'));
        if (!username) continue;
        const text = link.textContent.trim().toLowerCase();
        if (text === 'profile' || text === username.toLowerCase()) {
          return username;
        }
      }
    }

    // Fallback: look for the username in the header profile area
    const navItems = rootDocument?.querySelectorAll?.('.main-nav a[href]') || [];
    for (const link of navItems) {
      // Profile links are like /username/ with just one path segment
      const slug = usernameFromProfileHref(link.getAttribute('href'));
      if (slug) {
        const text = link.textContent.trim().toLowerCase();
        // Confirm it's a profile link by checking if text matches or link has avatar
        if (link.querySelector('img') || link.classList.contains('avatar') || text === slug.toLowerCase()) {
          return slug;
        }
      }
    }

    return null;
  }

  function readLetterboxdSession(rootDocument = document) {
    if (!rootDocument || pageShowsSignedOutNav(rootDocument)) return { active: false, username: null };
    const username = detectLetterboxdUsername(rootDocument);
    return { active: Boolean(username), username };
  }

  async function initAccount() {
    const session = readLetterboxdSession(document);
    const activeUsername = session.username;
    if (activeUsername && session.active) {
      letterboxdUsername = activeUsername;
      isLetterboxdSessionActive = true;
      chrome.storage.local.set({
        vypode_user: {
          username: letterboxdUsername,
          detectedAt: new Date().toISOString(),
          active: true
        }
      });
    } else {
      isLetterboxdSessionActive = false;
      const result = await new Promise(resolve => {
        chrome.storage.local.get(['vypode_user'], resolve);
      });
      if (result.vypode_user?.username) {
        letterboxdUsername = result.vypode_user.username;
        chrome.storage.local.set({
          vypode_user: {
            ...result.vypode_user,
            active: false,
            lastCheckedAt: new Date().toISOString()
          }
        });
      }
    }
  }

  function requireActiveLetterboxdSession(actionLabel) {
    const session = readLetterboxdSession(document);
    const accountId = window.VypodeFilmState?.getAccountId?.();
    const expectedId = session.username ? `user:${session.username.toLowerCase()}` : null;
    if (session.active && isLetterboxdSessionActive &&
        session.username?.toLowerCase() === letterboxdUsername?.toLowerCase() &&
        (!accountId || accountId === expectedId)) return true;
    const action = actionLabel || 'change films on Letterboxd';
    showFeedback(`Log in to Letterboxd to ${action}`, 'error');
    return false;
  }

  function actionAccountMatchesDocument(account, rootDocument) {
    const session = readLetterboxdSession(rootDocument);
    return session.active && typeof account === 'string' &&
      session.username?.toLowerCase() === account.toLowerCase();
  }

  function actionAccountMatchesCurrentState(account) {
    return actionAccountMatchesDocument(account, document) &&
      isLetterboxdSessionActive &&
      letterboxdUsername?.toLowerCase() === account?.toLowerCase() &&
      window.VypodeFilmState?.getAccountId?.() === `user:${String(account || '').toLowerCase()}`;
  }

  // ── Page type detection ─────────────────────────────────────────────

  function detectPageType() {
    const path = window.location.pathname;
    if (/^\/film\/[a-z0-9][a-z0-9-]*\/?$/i.test(path)) {
      return 'single';
    } else if (
      /^\/films(?:\/.*)?$/i.test(path) ||
      /^\/[a-z0-9_]+\/(?:films|watchlist|list)(?:\/.*)?$/i.test(path)
    ) {
      return 'listing';
    }
    return 'unknown';
  }

  // ── Film data extraction ────────────────────────────────────────────

  function getFilmData() {
    const titleEl = document.querySelector('h1.headline-1');
    const yearEl = document.querySelector('.releaseyear a');
    const posterEl = document.querySelector('.film-poster img') || document.querySelector('.image');
    const ratingEl = document.querySelector('.average-rating .display-rating');
    const directorEl = document.querySelector('.contributor a');
    const genreEls = document.querySelectorAll('.text-sluglist a[href*="/films/genre/"]');
    const slugMatch = window.location.pathname.match(/^\/film\/([a-z0-9][a-z0-9-]*)\/?$/i);
    const slug = slugMatch?.[1] || null;
    return {
      title: titleEl?.textContent?.trim() || 'Unknown Film',
      year: yearEl?.textContent?.trim() || '',
      poster: normalizePosterUrl(posterEl?.src, posterEl?.srcset),
      rating: ratingEl?.textContent?.trim() || '',
      ratingValue: null,
      director: directorEl?.textContent?.trim() || '',
      genres: Array.from(genreEls).slice(0, 3).map(el => el.textContent.trim()),
      url: slug ? canonicalLetterboxdFilmUrl(window.location.href, slug) : '',
      slug
    };
  }

  // One extractor for every listing shape. Handles both the classic markup
  // (.poster-container/.film-poster/.poster with an <a> + <img>) and the new
  // React LazyPoster markup ([data-item-slug] components, already used on
  // member/profile grids), which carries its metadata in data-item-*
  // attributes and may not have hydrated an <img> yet.
  function extractListingFilms(root, opts) {
    const skipSlugs = opts?.skipSlugs || null;
    const films = [];
    const seen = new Set(); // Dedupe by slug

    const overlayStates = (scope) => {
      const overlay = scope?.querySelector?.('.film-poster-overlay, .overlay');
      return {
        isWatched: Boolean(overlay?.querySelector('.icon-watched.-on, .action.-watch.-checked, .action.-watch.-on')),
        isLiked: Boolean(overlay?.querySelector('.icon-like.-on, .action.-like.-checked, .action.-like.-on')),
        inWatchlist: Boolean(overlay?.querySelector('.icon-watchlist.-on, .action.-watchlist.-checked, .action.-watchlist.-on, .remove-from-watchlist')),
        likeStateKnown: Boolean(overlay)
      };
    };

    const addFilm = (slug, data) => {
      if (!isSafeFilmSlug(slug) || seen.has(slug)) return;
      const canonicalUrl = canonicalLetterboxdFilmUrl(data?.url, slug);
      if (!canonicalUrl) return;
      if (skipSlugs && skipSlugs.has(slug)) return;
      seen.add(slug);
      const film = {
        director: '', genres: [], actioned: false, ...data,
        poster: normalizePosterUrl(data?.poster),
        url: canonicalUrl,
        slug
      };
      persistFilmRecord(film, 'domSync');
      films.push(film);
    };

    // New React markup first — its data attributes are the most reliable.
    root.querySelectorAll('[data-item-slug]').forEach(component => {
      const slug = component.getAttribute('data-item-slug');
      if (!isSafeFilmSlug(slug)) return;
      const href = component.getAttribute('data-item-link') || `/film/${slug}/`;
      const img = component.querySelector('img');
      const container = component.closest('.poster-container, .griditem, li') || component;
      const rawName = component.getAttribute('data-item-name') ||
                      component.getAttribute('data-item-full-display-name') ||
                      img?.alt;
      const title = titleWithoutPosterPrefix(rawName, slug.replace(/-/g, ' '));
      const ratingEl = container.querySelector('.rating[class*="rated-"], .rating');
      addFilm(slug, {
        title: title.charAt(0).toUpperCase() + title.slice(1),
        year: parseYearFromTitle(title),
        poster: normalizePosterUrl(img?.src || img?.dataset?.src, img?.srcset),
        rating: ratingEl?.textContent?.trim() || '',
        ratingValue: parseRatingValue(ratingEl),
        // The data slug is the identity. Never follow a supplied off-site or
        // mismatched link; reconstruct the public film page instead.
        url: canonicalLetterboxdFilmUrl(href, slug) || `https://letterboxd.com/film/${slug}/`,
        ...overlayStates(container)
      });
    });

    // Classic markup (film pages, lists, browse grids).
    root.querySelectorAll('.poster-container, .film-poster, .poster').forEach(container => {
      const link = container.querySelector('a[href*="/film/"]') || container.closest('a[href*="/film/"]');
      const img = container.querySelector('img');
      const filmPoster = container.closest('.poster-container') || container;
      if (!link || !img) return;

      const href = link.getAttribute('href');
      const parsedLink = parsedLetterboxdUrl(href);
      const filmSlug = parsedLink && !parsedLink.search && !parsedLink.hash
        ? parsedLink.pathname.match(/^\/film\/([a-z0-9][a-z0-9-]*)\/?$/i)?.[1]
        : null;
      if (!isSafeFilmSlug(filmSlug)) return;

      const title = titleWithoutPosterPrefix(
        img.alt || container.getAttribute('data-film-name'),
        filmSlug.replace(/-/g, ' ')
      );
      const ratingEl = filmPoster.querySelector('.rating') || filmPoster.querySelector('[class*="rating"]');
      addFilm(filmSlug, {
        title: title.charAt(0).toUpperCase() + title.slice(1),
        year: parseYearFromTitle(title),
        poster: normalizePosterUrl(img.src || img.dataset.src, img.srcset),
        rating: ratingEl?.textContent?.trim() || '',
        ratingValue: parseRatingValue(ratingEl),
        url: canonicalLetterboxdFilmUrl(href, filmSlug),
        ...overlayStates(filmPoster)
      });
    });

    return films;
  }

  function getFilmsFromListing() {
    return extractListingFilms(document);
  }

  // Filter the film deck using the FilmState registry
  function filterFilmDeck(films) {
    if (!window.VypodeFilmState) return films;

    const before = films.length;
    const filtered = films.filter(film => !window.VypodeFilmState.shouldExclude(film.slug));
    filteredCount = before - filtered.length;
    return filtered;
  }

  // Lazy-fetch film details (year, director, genres) for deck cards
  async function enrichFilmData(film) {
    if (!film || film.enriched) return;
    // Cap retries so a persistently failing URL (offline / flaky network) can't
    // trigger an unbounded fetch loop on every deck advance.
    film.enrichAttempts = (film.enrichAttempts || 0) + 1;
    if (film.enrichAttempts > 3) { film.enriched = true; return; }
    film.enriched = true; // Mark immediately to avoid duplicate fetches
    try {
      const filmUrl = canonicalLetterboxdFilmUrl(film.url, film.slug);
      if (!filmUrl) return;
      film.url = filmUrl;
      const response = await fetch(filmUrl, { credentials: 'same-origin' });
      if (!response.ok) {
        film.enriched = false;
        return;
      }
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      film.year = doc.querySelector('.releaseyear a')?.textContent?.trim() || '';
      film.director = doc.querySelector('.contributor a')?.textContent?.trim() || '';
      const genreEls = doc.querySelectorAll('.text-sluglist a[href*="/films/genre/"]');
      film.genres = Array.from(genreEls).slice(0, 3).map(el => el.textContent.trim());
      film.hasTrailer = Boolean(doc.querySelector(
        '.js-watch-panel-trailer a[href], a.js-video-zoom[href], a[href*="/trailer/"]'
      ));
      persistFilmRecord(film, 'domSync');

      // Update the card if it's still the one being displayed
      if (filmDeck[currentDeckIndex] === film) {
        updateDeckCardMeta(film);
      }
    } catch (e) {
      // Not critical — card still works without enriched metadata
      film.enriched = false;
    }
  }

  function updateDeckCardMeta(film) {
    const card = document.getElementById('vypodeCard');
    if (!card) return;
    const metaEl = card.querySelector('.vypode-card-meta');
    if (metaEl) {
      metaEl.innerHTML =
        (film.year ? '<span>' + escapeHtml(film.year) + '</span>' : '') +
        (film.rating ? '<span>\u00b7</span><span class="vypode-rating">\u2605 ' + escapeHtml(film.rating) + '</span>' : '') +
        (film.director ? '<span>\u00b7</span><span>' + escapeHtml(film.director) + '</span>' : '');
    }
    const genresEl = card.querySelector('.vypode-card-genres');
    if (genresEl) {
      const genres = Array.isArray(film.genres) ? film.genres : [];
      genresEl.innerHTML = genres.map(g => '<span class="vypode-genre-tag">' + escapeHtml(g) + '</span>').join('');
    }
    updateTrailerControl(film);
  }

  function findNextPageLink(root) {
    const scope = root || document;
    const selectors = [
      '.paginate-nextprev a.next',
      '.paginate-nextprev .next a[href]',
      'a[rel~="next"][href]',
      '.pagination a.next',
      '.pagination a[aria-label="Next"]',
      '.pagination a[aria-label="Next page"]',
      'a.pagination-next',
      'a.next[href*="/page/"]',
      'link[rel~="next"][href]'
    ];
    for (const selector of selectors) {
      const link = scope.querySelector(selector);
      if (link && !link.closest?.('.vypode-overlay')) return link;
    }

    // Letterboxd has changed pagination markup more than once. Keep the
    // accessible-text fallback inside pagination containers so query/cursor
    // URLs work without treating unrelated "Next" links as pagination.
    const paginationScopes = scope.querySelectorAll(
      '.paginate-nextprev, .pagination, nav[aria-label*="Pagination"], nav[aria-label*="pagination"]'
    );
    for (const pagination of paginationScopes) {
      const link = Array.from(pagination.querySelectorAll('a[href]')).find(candidate => {
        if (candidate.closest?.('.vypode-overlay')) return false;
        const label = [
          candidate.getAttribute('aria-label'),
          candidate.getAttribute('title'),
          candidate.textContent
        ].filter(Boolean).join(' ');
        return /\bnext(?:\s+page)?\b/i.test(label);
      });
      if (link) return link;
    }
    return null;
  }

  function getNextPageUrl(root, baseUrl) {
    const nextLink = findNextPageLink(root);
    const href = nextLink?.getAttribute?.('href') || nextLink?.href;
    if (!href) return null;
    try {
      const source = new URL(baseUrl || window.location.href, window.location.href);
      const destination = new URL(href, source.href);
      if (!validListingPaginationDestination(source, destination)) return null;
      destination.hash = '';
      source.hash = '';
      if (destination.href === source.href) return null;
      return destination.href;
    } catch (e) {
      return null;
    }
  }

  function listingPaginationFamily(pathname) {
    if (typeof pathname !== 'string') return null;
    let normalized = pathname.replace(/\/+/g, '/');
    if (!normalized.startsWith('/')) return null;
    if (!normalized.endsWith('/')) normalized += '/';
    const pageMatch = normalized.match(/^(.*)\/page\/([1-9]\d*)\/$/i);
    const family = pageMatch ? `${pageMatch[1]}/` : normalized;
    if (/^\/films(?:\/[^?#]*)?\/$/i.test(family)) return family.toLowerCase();
    if (/^\/[a-z0-9_]{1,64}\/(?:films|watchlist)(?:\/[^?#]*)?\/$/i.test(family)) return family.toLowerCase();
    if (/^\/[a-z0-9_]{1,64}\/list\/[a-z0-9][a-z0-9-]*\/$/i.test(family)) return family.toLowerCase();
    return null;
  }

  function validListingPaginationDestination(source, destination) {
    if (!(source instanceof URL) || !(destination instanceof URL)) return false;
    if (source.origin !== 'https://letterboxd.com' || destination.origin !== source.origin ||
        destination.username || destination.password) return false;
    const sourceFamily = listingPaginationFamily(source.pathname);
    const destinationFamily = listingPaginationFamily(destination.pathname);
    if (!sourceFamily || destinationFamily !== sourceFamily) return false;
    const sourceCopy = new URL(source.href);
    const destinationCopy = new URL(destination.href);
    sourceCopy.hash = '';
    destinationCopy.hash = '';
    return destinationCopy.href !== sourceCopy.href;
  }

  // ── Action buttons (single film page) ──────────────────────────────

  function findButtons() {
    return {
      watchBtn: document.querySelector(SELECTORS.watch),
      likeBtn: document.querySelector(SELECTORS.like),
      watchlistBtn: document.querySelector(SELECTORS.watchlist)
    };
  }

  function getStates() {
    return {
      isWatched: document.querySelector(SELECTORS.watchedState) !== null,
      isLiked: document.querySelector(SELECTORS.likedState) !== null,
      inWatchlist: document.querySelector(SELECTORS.watchlistState) !== null
    };
  }

  function validLetterboxdFilmActionUrl(rawUrl) {
    const url = parsedLetterboxdUrl(rawUrl, window.location.href);
    if (!url || url.search || url.hash) return null;
    const slug = url.pathname.match(/^\/film\/([a-z0-9][a-z0-9-]*)\/?$/i)?.[1];
    return slug ? canonicalLetterboxdFilmUrl(url.href, slug) : null;
  }

  function readActionOutbox() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get([ACTION_OUTBOX_KEY], result => {
          const stored = result?.[ACTION_OUTBOX_KEY];
          resolve(stored && typeof stored === 'object' ? stored : {});
        });
      } catch {
        resolve({});
      }
    });
  }

  function currentActionGeneration() {
    const generation = Number(window.VypodeFilmState?.getMeta?.()?.rootGeneration);
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
  }

  function queueItemIsLive(item) {
    return Boolean(item) && !item.cancelled && !item.invalidated && item.epoch === actionQueueEpoch;
  }

  function trackActionOutboxOperation(operation) {
    pendingActionOutboxOperations.add(operation);
    operation.finally(() => pendingActionOutboxOperations.delete(operation)).catch(() => {});
    return operation;
  }

  async function waitForPendingActionOutboxOperations() {
    while (pendingActionOutboxOperations.size > 0) {
      await Promise.allSettled(Array.from(pendingActionOutboxOperations));
      await Promise.resolve();
    }
    await actionOutboxWriteChain.catch(() => {});
  }

  async function writeActionOutbox(mutator, guard) {
    actionOutboxWriteChain = actionOutboxWriteChain.then(async () => {
      if (guard && !guard()) return false;
      const stored = await readActionOutbox();
      if (guard && !guard()) return false;
      const next = { ...stored };
      mutator(next);
      if (guard && !guard()) return false;
      await new Promise(resolve => {
        try {
          chrome.storage.local.set({ [ACTION_OUTBOX_KEY]: next }, () => {
            resolve(!chrome.runtime?.lastError);
          });
        } catch {
          resolve(false);
        }
      }).then(wrote => {
        if (!wrote) throw new Error('Could not persist the Letterboxd action queue');
      });
      return true;
    }).catch(() => false);
    return actionOutboxWriteChain;
  }

  function sendActionOutboxMutation(action, data) {
    const operation = (async () => {
      const sendMessage = chrome.runtime?.sendMessage;
      if (typeof sendMessage !== 'function') return null;
      const pending = sendMessage({ type: 'vypode-state', action, data });
      if (!pending || typeof pending.then !== 'function') return null;
      const response = await pending;
      if (response?.error) throw new Error(response.error);
      return response || null;
    })();
    return trackActionOutboxOperation(operation);
  }

  function serializableQueueItem(item) {
    return {
      id: item.outboxId || item.id,
      filmUrl: item.filmUrl,
      action: item.action,
      slug: item.slug,
      previousValue: Boolean(item.previousValue),
      account: item.account || null,
      createdAt: item.createdAt,
      mutationAt: item.mutationAt,
      mutationToken: item.mutationToken,
      generation: item.generation,
      leaseOwner: null,
      leaseExpiresAt: null,
      dispatchedAt: item.dispatchedAt || null
    };
  }

  async function persistActionOutboxItem(item) {
    if (!item?.id || !queueItemIsLive(item)) return { ok: false, invalidated: true };
    const record = serializableQueueItem(item);
    const remote = await sendActionOutboxMutation('outboxUpsert', {
      id: record.id,
      record,
      account: item.account,
      generation: item.generation
    });
    if (!queueItemIsLive(item)) return { ok: false, invalidated: true };
    if (remote) {
      if (remote.stale) return remote;
      if (!remote.ok) throw new Error('Could not persist queued Letterboxd action');
      item.outboxId = remote.id || record.id;
      item.deduped = remote.deduped === true;
      if (remote.record?.dispatchedAt) {
        item.dispatched = true;
        item.dispatchedAt = remote.record.dispatchedAt;
      }
      return remote;
    }
    let localId = record.id;
    let localRecord = record;
    let deduped = false;
    const wrote = await writeActionOutbox(outbox => {
      const duplicate = Object.entries(outbox).find(([id, candidate]) => {
        const normalized = hydratedOutboxRecord(id, candidate);
        return normalized && normalized.account.toLowerCase() === String(record.account).toLowerCase() &&
          normalized.slug === record.slug && normalized.action === record.action &&
          normalized.generation === record.generation;
      });
      if (duplicate) {
        localId = duplicate[0];
        localRecord = duplicate[1];
        deduped = localId !== record.id;
        return;
      }
      outbox[record.id] = record;
    }, () => queueItemIsLive(item) && currentActionGeneration() === item.generation);
    if (wrote) {
      item.outboxId = localId;
      item.deduped = deduped;
      if (localRecord?.dispatchedAt) {
        item.dispatched = true;
        item.dispatchedAt = localRecord.dispatchedAt;
      }
    }
    return wrote
      ? { ok: true, localFallback: true, id: localId, deduped, record: localRecord }
      : { ok: false, invalidated: true };
  }

  async function removeActionOutboxItem(item, outcome) {
    const id = item?.outboxId || item?.id;
    if (!id) return { ok: false };
    const remote = await sendActionOutboxMutation('outboxRemove', { id, ...(outcome ? { outcome } : {}) });
    if (remote) return remote;
    await writeActionOutbox(outbox => { delete outbox[id]; });
    return { ok: true, localFallback: true };
  }

  async function removeActionOutboxIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return { ok: true };
    const remote = await sendActionOutboxMutation('outboxRemove', { ids });
    if (remote) return remote;
    await writeActionOutbox(outbox => ids.forEach(id => { delete outbox[id]; }));
    return { ok: true, localFallback: true };
  }

  async function claimActionOutboxItem(item) {
    if (!queueItemIsLive(item)) return { ok: false, invalidated: true };
    const id = item.outboxId || item.id;
    const remote = await sendActionOutboxMutation('outboxClaim', {
      id,
      owner: actionQueueOwnerToken,
      leaseMs: ACTION_LEASE_MS,
      account: item.account,
      generation: item.generation
    });
    if (remote) return remote;
    return { ok: true, claimed: true, localFallback: true, id };
  }

  async function markActionOutboxDispatched(item) {
    const id = item.outboxId || item.id;
    const remote = await sendActionOutboxMutation('outboxMarkDispatched', {
      id,
      owner: actionQueueOwnerToken
    });
    if (remote) return remote;
    if (queueItemIsLive(item)) {
      await writeActionOutbox(outbox => {
        if (outbox[id]) outbox[id].dispatchedAt = item.dispatchedAt;
      }, () => queueItemIsLive(item));
    }
    return { ok: true, marked: true, localFallback: true };
  }

  async function completeActionOutboxItem(item) {
    const id = item?.outboxId || item?.id;
    if (!id) return { ok: false };
    const remote = await sendActionOutboxMutation('outboxComplete', {
      id,
      owner: actionQueueOwnerToken
    });
    if (remote) return remote;
    await writeActionOutbox(outbox => { delete outbox[id]; });
    return { ok: true, completed: true, localFallback: true };
  }

  async function releaseActionOutboxItem(item) {
    const id = item?.outboxId || item?.id;
    if (!id || !item.claimed) return { ok: false };
    const remote = await sendActionOutboxMutation('outboxRelease', {
      id,
      owner: actionQueueOwnerToken
    });
    if (remote) return remote;
    return { ok: true, released: true, localFallback: true };
  }

  function hydratedOutboxRecord(id, raw) {
    const filmUrl = validLetterboxdFilmActionUrl(raw?.filmUrl);
    const urlSlug = filmUrl?.match(/\/film\/([^/]+)\/?$/i)?.[1] || null;
    const createdAt = new Date(raw?.createdAt || 0).getTime();
    const mutationAt = new Date(raw?.mutationAt || 0).getTime();
    const generation = Number(raw?.generation);
    if (!filmUrl || !ACCOUNT_ACTIONS.has(raw?.action) || typeof raw?.slug !== 'string' ||
        raw.slug !== urlSlug || typeof raw?.account !== 'string' || !raw.account ||
        !Number.isFinite(createdAt) || !Number.isFinite(mutationAt) ||
        typeof raw?.mutationToken !== 'string' || !raw.mutationToken ||
        !Number.isSafeInteger(generation) || generation < 0) return null;
    return {
      id,
      outboxId: id,
      filmUrl,
      action: raw.action,
      slug: raw.slug,
      previousValue: Boolean(raw.previousValue),
      account: raw.account,
      createdAt: new Date(createdAt).toISOString(),
      mutationAt: new Date(mutationAt).toISOString(),
      mutationToken: raw.mutationToken,
      generation,
      retries: 0,
      committed: false,
      dispatched: Boolean(raw.dispatchedAt),
      dispatchedAt: raw.dispatchedAt || null,
      cancelled: false,
      invalidated: false,
      restored: true,
      claimed: false,
      timers: new Set(),
      epoch: actionQueueEpoch
    };
  }

  function actionFlag(action) {
    return { watch: 'watched', like: 'liked', watchlist: 'watchlist' }[action] || null;
  }

  function exactOptimisticMutationStillCurrent(item) {
    const flag = actionFlag(item?.action);
    if (!flag || !item?.slug || !actionAccountMatchesCurrentState(item.account)) return false;
    const entry = window.VypodeFilmState?.get?.(item.slug);
    return entry?.[flag] === true &&
      new Date(entry[flag + 'ChangedAt'] || entry[flag + 'At'] || 0).getTime() ===
        new Date(item.mutationAt || 0).getTime() &&
      entry[flag + 'MutationToken'] === item.mutationToken;
  }

  function rollbackFailedAction(item, options) {
    const flag = actionFlag(item?.action);
    if (!flag || !exactOptimisticMutationStillCurrent(item)) return false;
    const prefix = options?.expired ? 'expired' : options?.undo ? 'undo' : 'failed';
    const rollbackToken = (prefix + ':' + item.mutationToken).slice(0, 200);
    if (!window.VypodeFilmState?.setFlag?.(
      item.slug, flag, Boolean(item.previousValue), 'userAction', rollbackToken
    )) return false;
    const film = filmDeck.find(candidate => candidate.slug === item.slug) ||
      masterDeck.find(candidate => candidate.slug === item.slug);
    if (film) {
      if (flag === 'watched') film.isWatched = Boolean(item.previousValue);
      else if (flag === 'liked') film.isLiked = Boolean(item.previousValue);
      else if (flag === 'watchlist') film.inWatchlist = Boolean(item.previousValue);
      film.actioned = false;
    }
    if (!options?.skipDeckRefresh) updateDeckCard();
    return true;
  }

  async function readHydratedActionOutbox() {
    const remote = await sendActionOutboxMutation('outboxList', {
      account: letterboxdUsername,
      generation: currentActionGeneration()
    });
    if (remote?.ok && Array.isArray(remote.records)) {
      return { records: remote.records, workerPruned: true };
    }
    const stored = await readActionOutbox();
    return {
      records: Object.entries(stored).map(([id, record]) => ({ ...record, id })),
      workerPruned: false
    };
  }

  async function hydrateActionOutbox() {
    if (actionOutboxHydrated || !isLetterboxdSessionActive || !letterboxdUsername) return;
    actionOutboxHydrated = true;
    const { records, workerPruned } = await readHydratedActionOutbox();
    const now = Date.now();
    const staleIds = [];
    for (const raw of records) {
      const id = raw?.id;
      const item = hydratedOutboxRecord(id, raw);
      if (!item) {
        if (!workerPruned && typeof id === 'string') staleIds.push(id);
        continue;
      }
      const age = now - new Date(item.createdAt).getTime();
      const expired = age >= ACTION_OUTBOX_MAX_AGE_MS || age < -5 * 60 * 1000;
      const belongsToAccount = item.account.toLowerCase() === letterboxdUsername.toLowerCase();
      if (expired) {
        if (!workerPruned && belongsToAccount) {
          rollbackFailedAction(item, { expired: true, skipDeckRefresh: true });
          staleIds.push(id);
        }
        continue;
      }
      if (!belongsToAccount || item.generation !== currentActionGeneration()) continue;
      if (actionQueue.some(candidate => (candidate.outboxId || candidate.id) === id) ||
          (activeQueueItem?.outboxId || activeQueueItem?.id) === id) continue;
      actionQueue.push(item);
    }
    if (staleIds.length > 0) await removeActionOutboxIds(staleIds);
    processActionQueue();
  }

  function iframeActionIsActive(iframeDoc, action) {
    const selectorMap = {
      watch: SELECTORS.watchedState,
      like: SELECTORS.likedState,
      watchlist: SELECTORS.watchlistState
    };
    const selector = selectorMap[action];
    return Boolean(selector && iframeDoc?.querySelector?.(selector));
  }

  function actionButtonForDocument(rootDocument, action) {
    const selector = { watch: SELECTORS.watch, like: SELECTORS.like, watchlist: SELECTORS.watchlist }[action];
    return selector ? rootDocument?.querySelector?.(selector) : null;
  }

  function setDeckActionControlsDisabled(disabled) {
    document.querySelectorAll('.vypode-action-control').forEach(button => {
      const requiresAccount = button.dataset.action !== 'skip';
      const unavailableAccount = requiresAccount && !actionAccountMatchesCurrentState(letterboxdUsername);
      button.disabled = Boolean(disabled || !filmDeck[currentDeckIndex] || unavailableAccount);
    });
  }

  function updateDeckActionControls() {
    setDeckActionControlsDisabled(isProcessingAction);
  }

  function singleActionContextMatches(context) {
    return context?.epoch === actionQueueEpoch &&
      activeSingleFilmAction === context &&
      context.generation === currentActionGeneration() &&
      actionAccountMatchesCurrentState(context.account) &&
      window.location.pathname.match(/\/film\/([^/]+)/)?.[1] === context.slug;
  }

  function performSingleFilmAction(action) {
    if (!ACCOUNT_ACTIONS.has(action)) {
      showFeedback('Unsupported film action', 'error');
      return false;
    }
    const labels = {
      watch: 'mark films as watched',
      like: 'like films',
      watchlist: 'add films to your watchlist'
    };
    if (!requireActiveLetterboxdSession(labels[action]) || isProcessingAction) return false;
    const stateKey = { watch: 'isWatched', like: 'isLiked', watchlist: 'inWatchlist' }[action];
    const alreadyMessage = {
      watch: 'Already marked as watched',
      like: 'Already liked',
      watchlist: 'Already in Watchlist'
    }[action];
    if (getStates()[stateKey]) {
      showFeedback(alreadyMessage, action);
      return false;
    }
    const button = actionButtonForDocument(document, action);
    const slug = window.location.pathname.match(/\/film\/([^/]+)/)?.[1];
    const account = letterboxdUsername;
    const filmUrl = validLetterboxdFilmActionUrl(window.location.href);
    if (!button || !slug || !filmUrl || !actionAccountMatchesCurrentState(account)) {
      showFeedback('Could not verify the ' + action + ' control for this account', 'error');
      return false;
    }

    const createdAt = new Date().toISOString();
    const id = ('single:' + slug + ':' + action + ':' + Date.now() + ':' + Math.random().toString(36).slice(2)).slice(0, 500);
    const context = {
      id,
      outboxId: id,
      filmUrl,
      action,
      account,
      slug,
      epoch: actionQueueEpoch,
      generation: currentActionGeneration(),
      previousValue: false,
      createdAt,
      mutationAt: createdAt,
      mutationToken: id.slice(0, 200),
      cancelled: false,
      invalidated: false,
      committed: false,
      claimed: false,
      deduped: false,
      dispatched: false,
      dispatchedAt: null,
      timer: null
    };
    activeSingleFilmAction = context;
    isProcessingAction = true;
    setDeckActionControlsDisabled(true);

    const finish = () => {
      if (context.timer) clearTimeout(context.timer);
      context.timer = null;
      if (activeSingleFilmAction === context) activeSingleFilmAction = null;
      isProcessingAction = false;
      updateDeckActionControls();
      refreshStates();
    };

    const releaseForLaterVerification = async () => {
      if (!context.claimed) return;
      await releaseActionOutboxItem(context).catch(() => null);
      context.claimed = false;
    };

    const failBeforeDispatch = async message => {
      if (!singleActionContextMatches(context)) return;
      if (context.claimed) await releaseForLaterVerification();
      if (!context.deduped && !context.dispatched) {
        await removeActionOutboxItem(context, 'failed').catch(() => null);
      }
      if (!singleActionContextMatches(context)) return;
      finish();
      showFeedback(message, 'error');
    };

    const verify = (elapsed = 0) => {
      if (activeSingleFilmAction !== context || context.epoch !== actionQueueEpoch) return;
      if (!singleActionContextMatches(context)) {
        releaseForLaterVerification().catch(() => {});
        finish();
        showFeedback('Letterboxd account changed after the action was sent; local data was not changed', 'error');
        return;
      }
      if (iframeActionIsActive(document, action)) {
        (async () => {
          const flag = actionFlag(action);
          let persisted = false;
          try {
            persisted = await window.VypodeFilmState?.setFlagPersisted?.(
              slug,
              flag,
              true,
              'userAction',
              context.mutationToken,
              { accountId: window.VypodeFilmState?.getAccountId?.(), generation: context.generation }
            );
          } catch (error) {
            vyWarn('Could not persist verified single-film action:', error.message);
          }
          if (!singleActionContextMatches(context)) return;
          if (!persisted) {
            await releaseForLaterVerification();
            if (!singleActionContextMatches(context)) return;
            finish();
            showFeedback('Letterboxd confirmed the action, but its local state could not be saved. It will be verified again later.', 'error');
            return;
          }
          const completed = await completeActionOutboxItem(context).catch(() => null);
          if (!singleActionContextMatches(context)) return;
          context.claimed = false;
          context.committed = Boolean(completed?.completed || completed?.localFallback);
          finish();
          showFeedback(
            context.committed
              ? { watch: 'Marked as watched!', like: 'Liked!', watchlist: 'Added to Watchlist!' }[action]
              : 'Letterboxd confirmed the action, but recovery cleanup is still pending',
            context.committed ? action : 'error'
          );
        })();
        return;
      }
      if (elapsed >= 4000) {
        releaseForLaterVerification().finally(() => {
          if (!singleActionContextMatches(context)) return;
          finish();
          showFeedback(
            'Letterboxd did not confirm the ' + action + ' change. It may have been sent, so check the film before trying again.',
            'error'
          );
        });
        return;
      }
      context.timer = setTimeout(() => verify(elapsed + 200), 200);
    };

    (async () => {
      let persisted;
      try {
        persisted = await persistActionOutboxItem(context);
      } catch (error) {
        await failBeforeDispatch('Could not safely queue the Letterboxd action: ' + error.message);
        return;
      }
      if (!singleActionContextMatches(context)) return;
      if (persisted?.stale || !persisted?.ok) {
        await failBeforeDispatch('The action was cancelled by a newer local data reset');
        return;
      }

      let claim;
      try {
        claim = await claimActionOutboxItem(context);
      } catch (error) {
        await failBeforeDispatch('Could not reserve the Letterboxd action: ' + error.message);
        return;
      }
      if (!singleActionContextMatches(context)) {
        if (claim?.claimed) {
          context.claimed = true;
          releaseForLaterVerification().catch(() => {});
        }
        return;
      }
      if (claim?.stale) {
        await failBeforeDispatch('The action was cancelled by a newer local data reset');
        return;
      }
      if (claim?.missing) {
        if (claim.outcome === 'success') {
          const saved = await window.VypodeFilmState?.setFlagPersisted?.(
            slug,
            actionFlag(action),
            true,
            'userAction',
            context.mutationToken,
            { accountId: window.VypodeFilmState?.getAccountId?.(), generation: context.generation }
          ).catch(() => false);
          if (!singleActionContextMatches(context)) return;
          finish();
          showFeedback(saved ? 'Letterboxd already confirmed this action' : 'Letterboxd confirmed this action, but local state could not be saved', saved ? action : 'error');
        } else {
          finish();
          showFeedback(
            claim.outcome === 'uncertain'
              ? 'A matching action may already have reached Letterboxd. Check the film before changing it again.'
              : 'The earlier matching action was not completed. Please reload before trying again.',
            'error'
          );
        }
        return;
      }
      if (claim?.busy) {
        finish();
        showFeedback('This film action is already being handled in another tab', 'error');
        return;
      }
      if (!claim?.claimed) {
        await failBeforeDispatch('Could not safely reserve the Letterboxd action');
        return;
      }
      context.claimed = true;
      if (claim.record?.dispatchedAt) {
        context.dispatched = true;
        context.dispatchedAt = claim.record.dispatchedAt;
      }
      if (context.dispatched) {
        context.timer = setTimeout(() => verify(0), 0);
        return;
      }

      context.dispatchedAt = new Date().toISOString();
      const marked = await markActionOutboxDispatched(context).catch(() => null);
      if (!singleActionContextMatches(context)) return;
      if (!marked?.marked && !marked?.localFallback) {
        await failBeforeDispatch('Could not record the action before sending it to Letterboxd');
        return;
      }
      context.dispatched = true;
      button.click();
      context.timer = setTimeout(() => verify(0), 0);
    })();
    return true;
  }

  function performWatch() {
    if (getStates().isWatched) {
      showFeedback('Already marked as watched', 'watch');
      return false;
    }
    return performSingleFilmAction('watch');
  }

  function performLike() {
    if (getStates().isLiked) {
      showFeedback('Already liked', 'like');
      return false;
    }
    return performSingleFilmAction('like');
  }

  function performWatchlist() {
    if (getStates().inWatchlist) {
      showFeedback('Already in Watchlist', 'watchlist');
      return false;
    }
    return performSingleFilmAction('watchlist');
  }

  function clearQueueItemTimers(item) {
    for (const timer of item?.timers || []) clearTimeout(timer);
    item?.timers?.clear?.();
  }

  function scheduleQueueItemCallback(item, callback, delay) {
    if (!item.timers) item.timers = new Set();
    const timer = setTimeout(() => {
      item.timers.delete(timer);
      if (queueItemIsLive(item)) callback();
    }, delay);
    item.timers.add(timer);
    return timer;
  }

  function cleanupIframe() {
    if (iframeTimeout) { clearTimeout(iframeTimeout); iframeTimeout = null; }
    if (actionQueueRetryTimer) { clearTimeout(actionQueueRetryTimer); actionQueueRetryTimer = null; }
    const items = [...actionQueue, activeQueueItem].filter(Boolean);
    for (const item of items) {
      item.cancelled = true;
      clearQueueItemTimers(item);
    }
    actionQueue = [];
    if (actionIframe) { actionIframe.remove(); actionIframe = null; }
    activeQueueItem = null;
    isProcessingQueue = false;
    isProcessingAction = false;
    updateDeckActionControls();
  }

  async function invalidateActionQueueForClear() {
    actionQueueEpoch++;
    actionQueueSuspended = true;
    const items = [...actionQueue, activeQueueItem].filter(Boolean);
    const uniqueItems = Array.from(new Set(items));
    const dispatched = uniqueItems.filter(item => item.dispatched).length +
      (activeSingleFilmAction?.dispatched ? 1 : 0);
    for (const item of uniqueItems) {
      item.cancelled = true;
      item.invalidated = true;
      clearQueueItemTimers(item);
      item.undoController?.expire('Cancelled');
    }
    if (activeSingleFilmAction) {
      activeSingleFilmAction.epoch = -1;
      if (activeSingleFilmAction.timer) clearTimeout(activeSingleFilmAction.timer);
      activeSingleFilmAction = null;
    }
    if (iframeTimeout) clearTimeout(iframeTimeout);
    if (actionQueueRetryTimer) clearTimeout(actionQueueRetryTimer);
    iframeTimeout = null;
    actionQueueRetryTimer = null;
    if (actionIframe) actionIframe.remove();
    actionIframe = null;
    actionQueue = [];
    activeQueueItem = null;
    isProcessingQueue = false;
    isProcessingAction = false;
    cancelPendingPageNavigation();
    updateDeckActionControls();
    await waitForPendingActionOutboxOperations();
    return dispatched;
  }

  function suspendActionQueueForAccountChange(item, iframe, message) {
    actionQueueSuspended = true;
    clearQueueItemTimers(item);
    if (iframeTimeout) clearTimeout(iframeTimeout);
    iframeTimeout = null;
    if (iframe) iframe.remove();
    if (actionIframe === iframe) actionIframe = null;
    if (activeQueueItem === item) {
      activeQueueItem = null;
      isProcessingQueue = false;
      if (queueItemIsLive(item) && !actionQueue.includes(item)) actionQueue.unshift(item);
    }
    releaseActionOutboxItem(item).catch(() => {});
    item.claimed = false;
    showFeedback(
      message || (item.dispatched
        ? 'Letterboxd account changed after this action was sent; verification is suspended'
        : 'Letterboxd account changed; queued actions are suspended'),
      'error'
    );
    updateDeckActionControls();
    drainPendingDeckStateRefilter();
  }

  function revalidateActionQueueSession() {
    const next = activeQueueItem || actionQueue[0];
    if (!next || !actionAccountMatchesCurrentState(next.account)) return false;
    actionQueueSuspended = false;
    processActionQueue();
    return true;
  }

  function performBackgroundAction(filmUrl, action) {
    const actionLabels = {
      watch: 'mark films as watched',
      like: 'like films',
      watchlist: 'add films to your watchlist'
    };
    if (!ACCOUNT_ACTIONS.has(action)) {
      showFeedback('Unsupported film action', 'error');
      return false;
    }
    if (!requireActiveLetterboxdSession(actionLabels[action]) || isProcessingAction) return false;
    const safeFilmUrl = validLetterboxdFilmActionUrl(filmUrl);
    if (!safeFilmUrl) {
      showFeedback('Could not verify this Letterboxd film address', 'error');
      return false;
    }
    const film = filmDeck[currentDeckIndex];
    const urlSlug = safeFilmUrl.match(/\/film\/([^/]+)\/?$/i)?.[1];
    if (!film || !film.slug || film.slug !== urlSlug) {
      showFeedback('No verified current film to update', 'error');
      return false;
    }

    isProcessingAction = true;
    setDeckActionControlsDisabled(true);
    const prevIndex = currentDeckIndex;
    const flag = actionFlag(action);
    const dirMap = { watch: 'left', like: 'up', watchlist: 'right' };
    const previousValue = action === 'watch' ? film.isWatched : action === 'like' ? film.isLiked : film.inWatchlist;
    if (previousValue) {
      showFeedback(action === 'watch' ? 'Already watched' : action === 'like' ? 'Already liked' : 'Already in Watchlist', action);
      advanceDeckAfterAction(dirMap[action]);
      return true;
    }

    const createdAt = new Date().toISOString();
    const id = film.slug + ':' + action + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
    const queueItem = {
      id,
      outboxId: id,
      filmUrl: safeFilmUrl,
      action,
      retries: 0,
      slug: film.slug,
      previousValue,
      committed: false,
      dispatched: false,
      dispatchedAt: null,
      cancelled: false,
      invalidated: false,
      account: letterboxdUsername,
      createdAt,
      mutationAt: createdAt,
      mutationToken: id,
      generation: currentActionGeneration(),
      epoch: actionQueueEpoch,
      claimed: false,
      timers: new Set()
    };

    if (action === 'watch') film.isWatched = true;
    else if (action === 'like') film.isLiked = true;
    else film.inWatchlist = true;
    film.actioned = true;
    if (!window.VypodeFilmState?.setFlag?.(film.slug, flag, true, 'userAction', queueItem.mutationToken)) {
      isProcessingAction = false;
      film.actioned = false;
      updateDeckActionControls();
      showFeedback('Could not save the local action', 'error');
      return false;
    }
    queueItem.mutationAt = window.VypodeFilmState.get(film.slug)?.[flag + 'ChangedAt'] || createdAt;

    const messages = { watch: 'Marked as watched!', like: 'Liked!', watchlist: 'Added to Watchlist!' };
    queueItem.undoController = showUndoToast(messages[action], action, async () => {
      if (queueItem.committed) {
        showFeedback('Already synced to Letterboxd', 'watchlist');
        return;
      }
      if (queueItem.dispatched) {
        showFeedback('Action was sent and is still being verified', 'watchlist');
        return;
      }
      const qIdx = actionQueue.indexOf(queueItem);
      if (qIdx !== -1) actionQueue.splice(qIdx, 1);
      else if (activeQueueItem !== queueItem) {
        showFeedback('Already synced to Letterboxd', 'watchlist');
        return;
      }
      queueItem.cancelled = true;
      queueItem.invalidated = true;
      clearQueueItemTimers(queueItem);
      const wasActive = activeQueueItem === queueItem;
      if (wasActive) {
        if (iframeTimeout) clearTimeout(iframeTimeout);
        iframeTimeout = null;
        if (actionIframe) actionIframe.remove();
        actionIframe = null;
        activeQueueItem = null;
        isProcessingQueue = false;
      }
      try {
        if (queueItem.deduped && queueItem.claimed) await releaseActionOutboxItem(queueItem);
        else if (!queueItem.deduped) await removeActionOutboxItem(queueItem, 'cancelled');
      } catch (error) {
        vyWarn('Could not clean up undone action outbox record:', error.message);
      }
      queueItem.claimed = false;
      cancelPendingPageNavigation();
      rollbackFailedAction(queueItem, { undo: true, skipDeckRefresh: true });
      currentDeckIndex = prevIndex;
      updateDeckCard();
      updateProgress();
      showFeedback('Undone!', 'skip');
      updateDeckActionControls();
      if (wasActive || actionQueue.length > 0) processActionQueue();
    });

    actionQueue.push(queueItem);
    persistActionOutboxItem(queueItem).then(result => {
      if (!queueItemIsLive(queueItem)) return;
      if (result?.stale || !result?.ok) {
        queueItem.invalidated = true;
        rollbackFailedAction(queueItem);
        showFeedback('Queued action was cancelled by a newer data reset', 'error');
        return;
      }
      processActionQueue();
    }).catch(error => {
      if (!queueItemIsLive(queueItem)) return;
      queueItem.invalidated = true;
      rollbackFailedAction(queueItem);
      showFeedback('Could not queue Letterboxd action: ' + error.message, 'error');
    });

    advanceDeckAfterAction(dirMap[action], { afterUndoWindow: true });
    return true;
  }

  function advanceDeckAfterAction(direction, options) {
    const hasNext = currentDeckIndex < filmDeck.length - 1;
    if (hasNext) {
      runSwipeAnimation(direction);
      currentDeckIndex++;
      updateProgress();
      enrichFilmData(filmDeck[currentDeckIndex]);
      enrichFilmData(filmDeck[currentDeckIndex + 1]);
      preloadNextPosters(currentDeckIndex + 1, 10);
      setTimeout(() => {
        populateCurrentCard(filmDeck[currentDeckIndex]);
        populateNextCard(filmDeck[currentDeckIndex + 1]);
        resetCardStack();
        isProcessingAction = false;
        updateDeckActionControls();
        drainPendingDeckStateRefilter();
      }, 200);
    } else {
      advanceToNextCard(options);
      isProcessingAction = false;
      updateDeckActionControls();
      drainPendingDeckStateRefilter();
    }
  }

  function setQueueItemLocalValue(item, value) {
    const flag = actionFlag(item?.action);
    if (!flag || !item?.slug || !actionAccountMatchesCurrentState(item.account)) return false;
    const entry = window.VypodeFilmState?.get?.(item.slug);
    if (entry?.[flag] !== Boolean(value)) {
      const prefix = value ? 'verified' : 'reconciled';
      const token = (prefix + ':' + item.mutationToken).slice(0, 200);
      if (!window.VypodeFilmState?.setFlag?.(item.slug, flag, Boolean(value), 'userAction', token)) return false;
    }
    const film = filmDeck.find(candidate => candidate.slug === item.slug) ||
      masterDeck.find(candidate => candidate.slug === item.slug);
    if (film) {
      if (flag === 'watched') film.isWatched = Boolean(value);
      else if (flag === 'liked') film.isLiked = Boolean(value);
      else if (flag === 'watchlist') film.inWatchlist = Boolean(value);
    }
    return true;
  }

  function finishQueueItem(item, iframe, timeout) {
    clearQueueItemTimers(item);
    if (activeQueueItem !== item) return;
    if (actionIframe === iframe) actionIframe = null;
    if (iframeTimeout === timeout) iframeTimeout = null;
    activeQueueItem = null;
    isProcessingQueue = false;
    processActionQueue();
    drainPendingDeckStateRefilter();
  }

  function processActionQueue() {
    if (actionQueueSuspended || isProcessingQueue || actionQueue.length === 0) return;
    const item = actionQueue.shift();
    if (!queueItemIsLive(item)) {
      processActionQueue();
      return;
    }
    if (!actionAccountMatchesCurrentState(item.account)) {
      actionQueue.unshift(item);
      actionQueueSuspended = true;
      showFeedback('Letterboxd account changed; queued actions are suspended', 'error');
      return;
    }

    isProcessingQueue = true;
    activeQueueItem = item;
    claimActionOutboxItem(item).then(claim => {
      if (!queueItemIsLive(item) || activeQueueItem !== item) {
        if (claim?.claimed) {
          item.claimed = true;
          releaseActionOutboxItem(item).catch(() => {});
        }
        return;
      }
      if (claim?.stale) {
        item.invalidated = true;
        finishQueueItem(item, null, null);
        return;
      }
      if (claim?.missing) {
        if (claim.outcome === 'success') {
          item.committed = true;
          item.undoController?.expire('Synced');
          setQueueItemLocalValue(item, true);
        } else if (claim.outcome === 'uncertain') {
          item.undoController?.expire('Check Letterboxd');
          showFeedback('A matching action may have reached Letterboxd. Check the film before changing it again.', 'error');
        } else {
          rollbackFailedAction(item);
          item.undoController?.expire(claim.outcome === 'cancelled' ? 'Cancelled' : 'Not synced');
          showFeedback(
            claim.outcome === 'cancelled'
              ? 'The matching Letterboxd action was cancelled; local change rolled back'
              : 'Could not verify the matching Letterboxd action; local change rolled back',
            'error'
          );
        }
        finishQueueItem(item, null, null);
        return;
      }
      if (claim?.busy) {
        activeQueueItem = null;
        isProcessingQueue = false;
        const waitMs = Math.max(50, new Date(claim.leaseExpiresAt || 0).getTime() - Date.now() + 20);
        actionQueueRetryTimer = setTimeout(() => {
          actionQueueRetryTimer = null;
          if (!queueItemIsLive(item)) return;
          actionQueue.push(item);
          processActionQueue();
        }, Math.min(waitMs, ACTION_LEASE_MS + 100));
        return;
      }
      if (!claim?.claimed) {
        onTerminalQueueFailure(item, null, null, 'Could not claim queued action');
        return;
      }
      item.claimed = true;
      if (claim.record?.dispatchedAt) {
        item.dispatched = true;
        item.dispatchedAt = claim.record.dispatchedAt;
      }
      startClaimedActionAttempt(item);
    }).catch(error => {
      if (!queueItemIsLive(item) || activeQueueItem !== item) return;
      onTerminalQueueFailure(item, null, null, error.message);
    });
  }

  function onTerminalQueueFailure(item, iframe, timeout, reason) {
    if (!queueItemIsLive(item) || activeQueueItem !== item) return;
    console.warn('Vypode: action failed', item.action, item.filmUrl, reason || '');
    rollbackFailedAction(item);
    removeActionOutboxItem(item, 'failed').catch(() => {});
    showFeedback('Letterboxd action failed; local change rolled back', 'error');
    finishQueueItem(item, iframe, timeout);
  }

  function startClaimedActionAttempt(item) {
    if (!queueItemIsLive(item) || activeQueueItem !== item) return;
    if (!actionAccountMatchesCurrentState(item.account)) {
      suspendActionQueueForAccountChange(item, null);
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    actionIframe = iframe;
    let timeout = null;
    let failureHandled = false;
    let attemptInProgress = false;

    const onVerified = async () => {
      if (!queueItemIsLive(item) || activeQueueItem !== item || failureHandled) return;
      failureHandled = true;
      clearTimeout(timeout);
      iframe.remove();
      const completed = await completeActionOutboxItem(item).catch(() => null);
      if (!queueItemIsLive(item) || activeQueueItem !== item) return;
      if (!completed?.completed && !completed?.localFallback) {
        finishQueueItem(item, iframe, timeout);
        return;
      }
      if (!actionAccountMatchesCurrentState(item.account)) {
        finishQueueItem(item, iframe, timeout);
        showFeedback('Letterboxd account changed; verified remote action was not written locally', 'error');
        return;
      }
      item.committed = true;
      item.undoController?.expire('Synced');
      setQueueItemLocalValue(item, true);
      finishQueueItem(item, iframe, timeout);
    };

    const onFail = reason => {
      if (failureHandled || item.committed || !queueItemIsLive(item) || activeQueueItem !== item) return;
      if (item.dispatched) {
        // A toggle click is not idempotent. If Letterboxd's DOM never confirms
        // the new state, another click could undo the first one. Keep the
        // optimistic value explicitly unresolved and only verify on a later run.
        failureHandled = true;
        clearTimeout(timeout);
        iframe.remove();
        if (actionIframe === iframe) actionIframe = null;
        if (iframeTimeout === timeout) iframeTimeout = null;
        item.undoController?.expire('Check Letterboxd');
        showFeedback('Letterboxd may have received the action, but it could not be confirmed. Check the film before trying again.', 'error');
        releaseActionOutboxItem(item).catch(() => {});
        item.claimed = false;
        finishQueueItem(item, iframe, timeout);
        return;
      }
      failureHandled = true;
      clearTimeout(timeout);
      iframe.remove();
      if (actionIframe === iframe) actionIframe = null;
      if (iframeTimeout === timeout) iframeTimeout = null;
      if (!actionAccountMatchesCurrentState(item.account)) {
        suspendActionQueueForAccountChange(item, iframe);
        return;
      }
      if (item.retries < 3) {
        const delay = (item.retries + 1) * 1000;
        actionQueueRetryTimer = scheduleQueueItemCallback(item, () => {
          actionQueueRetryTimer = null;
          if (!actionAccountMatchesCurrentState(item.account)) {
            suspendActionQueueForAccountChange(item, null);
            return;
          }
          if (activeQueueItem === item) activeQueueItem = null;
          item.retries += 1;
          actionQueue.push(item);
          isProcessingQueue = false;
          processActionQueue();
        }, delay);
      } else {
        onTerminalQueueFailure(item, iframe, timeout, reason);
      }
    };

    const waitForVerifiedState = (iframeDoc, elapsed = 0) => {
      if (!queueItemIsLive(item) || failureHandled || activeQueueItem !== item) return;
      if (!actionAccountMatchesCurrentState(item.account) ||
          !actionAccountMatchesDocument(item.account, iframeDoc)) {
        suspendActionQueueForAccountChange(item, iframe);
        return;
      }
      if (iframeActionIsActive(iframeDoc, item.action)) {
        onVerified();
        return;
      }
      if (elapsed >= 4000) {
        onFail('Letterboxd state did not change');
        return;
      }
      scheduleQueueItemCallback(item, () => waitForVerifiedState(iframeDoc, elapsed + 200), 200);
    };

    timeout = scheduleQueueItemCallback(item, () => onFail('Iframe timed out'), 10000);
    iframeTimeout = timeout;

    iframe.onload = function() {
      if (!queueItemIsLive(item) || activeQueueItem !== item || failureHandled || attemptInProgress) return;
      attemptInProgress = true;
      let iframeDoc;
      try {
        iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
      } catch {
        onFail('Could not read action page');
        return;
      }
      if (!actionAccountMatchesCurrentState(item.account) ||
          !actionAccountMatchesDocument(item.account, iframeDoc)) {
        suspendActionQueueForAccountChange(item, iframe);
        return;
      }

      if (item.dispatched) {
        // Recovery of a previously clicked action is verification-only.
        // Never click a Letterboxd toggle twice when the first result is unknown.
        waitForVerifiedState(iframeDoc);
        return;
      }

      scheduleQueueItemCallback(item, async () => {
        if (failureHandled || activeQueueItem !== item) return;
        if (!actionAccountMatchesCurrentState(item.account) ||
            !actionAccountMatchesDocument(item.account, iframeDoc)) {
          suspendActionQueueForAccountChange(item, iframe);
          return;
        }
        if (iframeActionIsActive(iframeDoc, item.action)) {
          onVerified();
          return;
        }
        const button = actionButtonForDocument(iframeDoc, item.action);
        if (!button) {
          onFail('Could not find Letterboxd action control');
          return;
        }

        item.dispatchedAt = new Date().toISOString();
        const marked = await markActionOutboxDispatched(item).catch(() => null);
        if (!queueItemIsLive(item) || failureHandled || activeQueueItem !== item) return;
        if (!marked?.marked && !marked?.localFallback) {
          onFail('Lost outbox ownership before dispatch');
          return;
        }
        if (!actionAccountMatchesCurrentState(item.account) ||
            !actionAccountMatchesDocument(item.account, iframeDoc)) {
          suspendActionQueueForAccountChange(item, iframe);
          return;
        }
        item.dispatched = true;
        item.undoController?.expire('Syncing…');
        button.click();
        waitForVerifiedState(iframeDoc);
      }, 800);
    };

    iframe.onerror = () => onFail('Iframe failed to load');
    iframe.src = item.filmUrl;
    document.body.appendChild(iframe);
  }

  function dispatchAction(action) {
    if (!DECK_ACTIONS.has(action)) {
      showFeedback('Unsupported film action', 'error');
      return false;
    }
    if (isProcessingAction) return false;
    if (isListingPage) {
      const film = filmDeck[currentDeckIndex];
      if (!film) {
        showFeedback('No film matches the current filters', 'watchlist');
        updateDeckActionControls();
        return false;
      }
      if (action === 'skip') {
        skipCurrentFilm();
        return true;
      }
      if (!requireActiveLetterboxdSession({
        watch: 'mark films as watched',
        like: 'like films',
        watchlist: 'add films to your watchlist'
      }[action])) {
        updateDeckActionControls();
        return false;
      }
      return performBackgroundAction(film.url, action);
    }
    if (action === 'skip') return false;
    animateAction({ watch: 'left', like: 'up', watchlist: 'right' }[action]);
    return { watch: performWatch, like: performLike, watchlist: performWatchlist }[action]();
  }

  // ── Review submission ───────────────────────────────────────────────

  function vyWarn(...args) { console.warn('[Vypode]', ...args); }

  function hasOwnValue(object, key) {
    return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key) &&
      object[key] !== undefined && object[key] !== null;
  }

  function responseMessageText(message) {
    if (typeof message === 'string') return message;
    if (!message || typeof message !== 'object') return '';
    return message.text || message.message || message.code || '';
  }

  function suppliedLogEntryValue(logEntry, key, nestedKey) {
    if (nestedKey) {
      if (!hasOwnValue(logEntry, key) || !logEntry[key] || typeof logEntry[key] !== 'object') {
        return { supplied: false };
      }
      return hasOwnValue(logEntry[key], nestedKey)
        ? { supplied: true, value: logEntry[key][nestedKey] }
        : { supplied: false };
    }
    return hasOwnValue(logEntry, key)
      ? { supplied: true, value: logEntry[key] }
      : { supplied: false };
  }

  function localTodayString() {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  }

  function isValidReviewDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function parseReviewTags(value) {
    const rawTags = Array.isArray(value) ? value : String(value || '').split(/[,\n]/);
    const tags = [];
    const seen = new Set();
    for (const raw of rawTags) {
      if (typeof raw !== 'string') throw new Error('Tags must be text');
      const tag = raw.trim();
      if (!tag) continue;
      if (tag.length > MAX_REVIEW_TAG_LENGTH) throw new Error(`Each tag must be ${MAX_REVIEW_TAG_LENGTH} characters or fewer`);
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    }
    if (tags.length > MAX_REVIEW_TAGS) throw new Error(`Use no more than ${MAX_REVIEW_TAGS} tags`);
    return tags;
  }

  function normalizeReviewDraft(raw, accountId, slug) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid review draft');
    const reviewText = typeof raw.reviewText === 'string' ? raw.reviewText : '';
    if (reviewText.length > MAX_REVIEW_TEXT_LENGTH) throw new Error(`Review must be ${MAX_REVIEW_TEXT_LENGTH} characters or fewer`);
    if (typeof raw.rating !== 'number' || typeof raw.rewatch !== 'boolean' || typeof raw.spoilers !== 'boolean') {
      throw new Error('Invalid review draft options');
    }
    const rating = raw.rating;
    if (rating !== 0 && !isValidReviewRating(rating)) throw new Error('Rating must use half-star steps from 0.5 to 5');
    if (!isValidReviewDate(raw.diaryDate)) throw new Error('Choose a valid diary date');
    const likeMode = ['preserve', 'like', 'unlike'].includes(raw.likeMode) ? raw.likeMode : 'preserve';
    const revision = raw.revision === undefined ? 0 : raw.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid review draft revision');
    return {
      accountId,
      slug,
      reviewText,
      rating,
      diaryDate: raw.diaryDate,
      rewatch: raw.rewatch,
      spoilers: raw.spoilers,
      likeMode,
      tags: parseReviewTags(raw.tags),
      revision,
      updatedAt: Number.isFinite(new Date(raw.updatedAt).getTime()) ? new Date(raw.updatedAt).toISOString() : new Date().toISOString()
    };
  }

  function activeReviewAccountId() {
    const stateAccount = window.VypodeFilmState?.getAccountId?.();
    if (typeof stateAccount === 'string' && /^user:[a-z0-9_]{1,64}$/i.test(stateAccount)) {
      return stateAccount.toLowerCase();
    }
    return typeof letterboxdUsername === 'string' && /^[a-z0-9_]{1,64}$/i.test(letterboxdUsername)
      ? `user:${letterboxdUsername.toLowerCase()}`
      : null;
  }

  function readLocalStorage(keys) {
    return new Promise(resolve => {
      try { chrome.storage.local.get(keys, value => resolve(value || {})); }
      catch { resolve({}); }
    });
  }

  function writeLocalStorage(value) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(value, () => {
          if (chrome.runtime?.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function sendReviewDraftCommand(action, data) {
    const sendMessage = chrome.runtime?.sendMessage;
    if (typeof sendMessage !== 'function') return { unavailable: true };
    const pending = sendMessage({ type: 'vypode-state', action, data });
    if (!pending || typeof pending.then !== 'function') return { unavailable: true };
    const response = await pending;
    if (!response || typeof response !== 'object') throw new Error('Draft service returned no response');
    if (response.stale) throw new Error('Draft belongs to an older cleared data generation');
    if (response.error || !response.ok) throw new Error(response.error || 'Draft service rejected the request');
    return response;
  }

  function pruneLocalReviewDrafts(store) {
    const records = [];
    for (const accountId of Object.keys(store || {})) {
      if (!/^user:[a-z0-9_]{1,64}$/i.test(accountId) || !store[accountId] || typeof store[accountId] !== 'object') continue;
      for (const slug of Object.keys(store[accountId])) {
        const draft = store[accountId][slug];
        if (!/^[a-z0-9][a-z0-9-]{0,199}$/i.test(slug) || !draft || typeof draft !== 'object') continue;
        records.push({ accountId: accountId.toLowerCase(), slug, draft });
      }
    }
    records.sort((a, b) => String(b.draft.updatedAt || '').localeCompare(String(a.draft.updatedAt || '')));
    const next = Object.create(null);
    for (const { accountId, slug, draft } of records.slice(0, 100)) {
      if (!next[accountId]) next[accountId] = Object.create(null);
      next[accountId][slug] = draft;
    }
    return next;
  }

  function reviewDraftCommand(action, accountId, slug, draft, options) {
    reviewDraftWriteChain = reviewDraftWriteChain.catch(() => {}).then(async () => {
      const generation = Number.isSafeInteger(options?.generation)
        ? options.generation
        : Number(window.VypodeFilmState?.getMeta?.().rootGeneration);
      if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Draft has no valid data generation');
      const data = { accountId, slug, generation };
      if (draft) data.draft = draft;
      if (Number.isSafeInteger(options?.expectedRevision)) data.expectedRevision = options.expectedRevision;
      if (typeof options?.expectedUpdatedAt === 'string') data.expectedUpdatedAt = options.expectedUpdatedAt;
      const remote = await sendReviewDraftCommand(action, data);
      if (!remote.unavailable) return action === 'reviewDraftGet' ? remote.draft : remote;

      // Callback-only test/legacy hosts do not expose MV3 Promise messaging.
      // Fence that fallback against the same root generation before every
      // write so an old page cannot repopulate drafts after Clear All.
      const result = await readLocalStorage([REVIEW_DRAFTS_KEY, 'vypode_state']);
      const storedGeneration = Number(result.vypode_state?._meta?.generation) || 0;
      if (storedGeneration !== generation) throw new Error('Draft belongs to an older cleared data generation');
      let store = pruneLocalReviewDrafts(result[REVIEW_DRAFTS_KEY]);
      if (action === 'reviewDraftGet') return store[accountId]?.[slug] || null;
      if (action === 'reviewDraftUpsert') {
        if (!store[accountId]) store[accountId] = Object.create(null);
        store[accountId][slug] = draft;
        store = pruneLocalReviewDrafts(store);
      } else if (action === 'reviewDraftRemove') {
        const stored = store[accountId]?.[slug] || null;
        if (stored && Number.isSafeInteger(options?.expectedRevision) &&
            (stored.revision !== options.expectedRevision || stored.updatedAt !== options.expectedUpdatedAt)) {
          return { ok: true, removed: false, newer: true, draft: stored };
        }
        if (store[accountId]) {
          delete store[accountId][slug];
          if (Object.keys(store[accountId]).length === 0) delete store[accountId];
        }
      }
      await writeLocalStorage({ [REVIEW_DRAFTS_KEY]: store });
      return { ok: true };
    });
    return reviewDraftWriteChain;
  }

  async function loadReviewDraft(accountId, slug, generation) {
    if (!accountId || !slug) return null;
    const raw = await reviewDraftCommand('reviewDraftGet', accountId, slug, null, { generation });
    if (!raw) return null;
    try { return normalizeReviewDraft(raw, accountId, slug); }
    catch { return null; }
  }

  function saveReviewDraft(draft, generation) {
    if (!draft?.accountId || !draft?.slug) return Promise.resolve(null);
    return reviewDraftCommand('reviewDraftUpsert', draft.accountId, draft.slug, draft, { generation });
  }

  function removeReviewDraft(accountId, slug, generation, expectedDraft) {
    if (!accountId || !slug) return Promise.resolve(null);
    return reviewDraftCommand('reviewDraftRemove', accountId, slug, null, {
      generation,
      expectedRevision: expectedDraft?.revision,
      expectedUpdatedAt: expectedDraft?.updatedAt
    });
  }

  // Lifecycle events can destroy this content-script context before a queued
  // promise continuation runs. Snapshot synchronously and invoke the MV3
  // worker immediately; its own stateWriteQueue preserves write ordering.
  function handoffActiveReviewDraft(context) {
    const active = context || reviewDraftContext;
    if (!active?.accountId || !active?.slug || !active.panel?.isConnected) return null;
    if (reviewDraftSaveTimer) clearTimeout(reviewDraftSaveTimer);
    reviewDraftSaveTimer = null;
    let draft;
    try {
      draft = reviewDraftFromPanel(active);
    } catch {
      return null;
    }
    let handedToBackground = false;
    try {
      const pending = chrome.runtime?.sendMessage?.({
        type: 'vypode-state',
        action: 'reviewDraftUpsert',
        data: { accountId: draft.accountId, slug: draft.slug, generation: active.generation, draft }
      });
      handedToBackground = Boolean(pending && typeof pending.then === 'function');
      if (handedToBackground) pending.catch(() => {});
    } catch {}
    return { draft, handedToBackground };
  }

  function reviewContextMatchesCurrentAccount(context) {
    const generation = Number(window.VypodeFilmState?.getMeta?.().rootGeneration);
    return Boolean(context?.accountId) && !context.invalidated &&
      activeReviewAccountId() === context.accountId && generation === context.generation;
  }

  function closeReviewForAccountChange(context) {
    if (!context || reviewDraftContext !== context) return;
    const handoff = handoffActiveReviewDraft(context);
    context.invalidated = true;
    // Callback-only test hosts and a worker that is unavailable before a normal
    // in-page account change still get the ordinary serialized fallback persistence path.
    if (handoff?.draft && !handoff.handedToBackground) saveReviewDraft(handoff.draft, context.generation).catch(() => {});
    hideReviewPanel({ saveDraft: false });
    showFeedback('Letterboxd account changed. The original account draft was saved; reopen Review.', 'error');
  }

  function closeReviewForStateReset(context) {
    if (!context || reviewDraftContext !== context) return;
    context.invalidated = true;
    hideReviewPanel({ saveDraft: false });
    showFeedback('Local data was cleared in another tab. The older review editor was closed.', 'error');
  }

  function equalSubmittedValue(actual, expected) {
    if (Array.isArray(actual) || Array.isArray(expected)) {
      return Array.isArray(actual) && Array.isArray(expected) &&
        actual.length === expected.length && actual.every((value, index) => value === expected[index]);
    }
    return actual === expected;
  }

  // A successful POST must be an explicit production-log response. Diary pages
  // are not used as fallback proof: an older entry for the same film could match.
  function verifyReviewSubmitted(responseBody, intended) {
    const messages = Array.isArray(responseBody?.messages) ? responseBody.messages : [];
    const rejection = messages.find(message => message?.type === 'Error');
    if (rejection) {
      return { status: 'rejected', reason: responseMessageText(rejection) || 'Letterboxd rejected entry' };
    }

    const logEntry = responseBody?.logEntry;
    if (!logEntry || typeof logEntry !== 'object' || String(logEntry.id || '').trim() === '') {
      return { status: 'unconfirmed', reason: 'Response did not include a log entry id' };
    }

    const returnedReview = suppliedLogEntryValue(logEntry, 'review', 'text');
    const returnedProductionId = suppliedLogEntryValue(logEntry, 'productionId');
    const returnedRating = suppliedLogEntryValue(logEntry, 'rating');
    const returnedDate = suppliedLogEntryValue(logEntry, 'diaryDetails', 'diaryDate');
    const returnedRewatch = suppliedLogEntryValue(logEntry, 'diaryDetails', 'rewatch');
    const returnedLike = suppliedLogEntryValue(logEntry, 'like');
    const returnedSpoilers = suppliedLogEntryValue(logEntry, 'review', 'containsSpoilers');
    const returnedTags = suppliedLogEntryValue(logEntry, 'tags');
    const returnedPrivacy = suppliedLogEntryValue(logEntry, 'privacyPolicy');
    const comparisons = [
      ['film id', returnedProductionId, intended.productionId],
      ['diary date', returnedDate, intended.watchedDate],
      ['rewatch', returnedRewatch, intended.rewatch],
      ['like', returnedLike, intended.like],
      ['tags', returnedTags, intended.tags]
    ];
    if (intended.reviewText !== undefined) comparisons.push(['review text', returnedReview, intended.reviewText]);
    if (intended.rating !== undefined) comparisons.push(['rating', returnedRating, intended.rating]);
    if (intended.spoilers !== undefined) comparisons.push(['spoiler setting', returnedSpoilers, intended.spoilers]);
    if (intended.privacyPolicy !== undefined) comparisons.push(['privacy setting', returnedPrivacy, intended.privacyPolicy]);
    for (const [label, returned, expected] of comparisons) {
      if (returned.supplied && !equalSubmittedValue(returned.value, expected)) {
        return { status: 'unconfirmed', reason: `Returned ${label} did not match the submitted value` };
      }
    }
    return { status: 'confirmed', logEntryId: logEntry.id };
  }

  function isValidReviewRating(rating) {
    return Number.isFinite(rating) && rating >= 0.5 && rating <= 5 && Number.isInteger(rating * 2);
  }

  function reviewRatingDisplay(rating) {
    if (!rating) return null;
    return '★'.repeat(Math.floor(rating)) + (rating % 1 ? '½' : '');
  }

  async function fetchReviewFilmJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) throw new Error('Film page fetch failed: ' + response.status);
      const text = await response.text();
      if (text.length > 512 * 1024) throw new Error('Film data response was too large');
      try { return JSON.parse(text); }
      catch { throw new Error('Film page returned invalid JSON'); }
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Film page request timed out');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function sendReviewSubmissionCommand(data) {
    const sendMessage = chrome.runtime?.sendMessage;
    if (typeof sendMessage !== 'function') throw new Error('Review service is unavailable');
    const pending = sendMessage({ type: 'vypode-review', action: 'submit', data });
    if (!pending || typeof pending.then !== 'function') throw new Error('Review service is unavailable');
    const response = await pending;
    if (!response || typeof response !== 'object') throw new Error('Review service returned no response');
    return response;
  }

  async function sendReviewControlCommand(action, data) {
    const sendMessage = chrome.runtime?.sendMessage;
    if (typeof sendMessage !== 'function') throw new Error('Review service is unavailable');
    const pending = sendMessage({ type: 'vypode-review', action, data });
    if (!pending || typeof pending.then !== 'function') throw new Error('Review service is unavailable');
    const response = await pending;
    if (!response || typeof response !== 'object') throw new Error('Review service returned no response');
    return response;
  }

  function lockReviewRetry(context, message, markerToken) {
    if (!context?.panel?.isConnected) return;
    context.reviewRetryBlocked = true;
    if (typeof markerToken === 'string' && markerToken) context.reviewUncertainMarkerToken = markerToken;
    const submit = context.panel.querySelector('#vypodeReviewSubmit');
    if (submit) submit.disabled = true;
    let warning = context.panel.querySelector('#vypodeReviewUncertain');
    if (!warning) {
      warning = document.createElement('div');
      warning.id = 'vypodeReviewUncertain';
      warning.className = 'vypode-review-notice vypode-review-warning';
      const text = document.createElement('span');
      text.className = 'vypode-review-uncertain-text';
      const link = document.createElement('a');
      link.href = `https://letterboxd.com/film/${context.slug}/`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Check the film on Letterboxd';
      const resolve = document.createElement('button');
      resolve.type = 'button';
      resolve.className = 'vypode-btn vypode-btn-cancel vypode-review-resolve-uncertain';
      resolve.textContent = 'I checked Letterboxd — allow another submission';
      warning.append(text, document.createElement('br'), link, document.createElement('br'), resolve);
      context.panel.querySelector('.vypode-review-actions')?.before(warning);
      resolve.addEventListener('click', async () => {
        if (!reviewContextMatchesCurrentAccount(context)) {
          closeReviewForAccountChange(context);
          return;
        }
        if (!context.reviewUncertainMarkerToken) {
          setReviewDraftStatus('The submission lock could not be identified. Close and reopen Review, then check Letterboxd again.', 'error');
          return;
        }
        if (!window.confirm('Only continue if you checked Letterboxd and confirmed no entry was created. Allow another submission?')) return;
        resolve.disabled = true;
        try {
          const result = await sendReviewControlCommand('resolveUncertain', {
            accountId: context.accountId,
            generation: context.generation,
            slug: context.slug,
            markerRequestId: context.reviewUncertainMarkerToken
          });
          if (!result.ok) {
            if (result.markerToken) context.reviewUncertainMarkerToken = result.markerToken;
            throw new Error(result.error || 'Could not clear the submission lock');
          }
          context.reviewRetryBlocked = false;
          warning.remove();
          if (submit) submit.disabled = !isLetterboxdSessionActive;
          setReviewDraftStatus('Submission lock cleared after your Letterboxd check', 'saved');
        } catch (error) {
          resolve.disabled = false;
          setReviewDraftStatus(error.message, 'error');
        }
      });
    }
    const text = warning.querySelector('.vypode-review-uncertain-text');
    if (text) text.textContent = message || 'Letterboxd may have created this entry, but the result could not be confirmed. Do not submit again until you check.';
  }

  // The service worker owns the cross-origin production-log POST. It validates
  // the page/account/generation and commits confirmed local state even if this
  // tab closes before the response returns.
  async function submitReview(filmUrl, rawDraft, binding) {
    if (!requireActiveLetterboxdSession('submit reviews')) return;
    if (isProcessingAction) return;
    let parsedFilmUrl;
    try { parsedFilmUrl = new URL(filmUrl, window.location.href); }
    catch { parsedFilmUrl = null; }
    const filmSlug = parsedFilmUrl?.origin === 'https://letterboxd.com'
      ? (parsedFilmUrl.pathname.match(/^\/film\/([a-z0-9][a-z0-9-]*)\/?$/i) || [])[1]
      : null;
    if (!filmSlug) {
      showFeedback('Review failed: could not identify this film', 'error');
      return;
    }
    const accountId = binding?.accountId || rawDraft?.accountId || null;
    if (!/^user:[a-z0-9_]{1,64}$/i.test(accountId || '') ||
        rawDraft?.accountId !== accountId || rawDraft?.slug !== filmSlug) {
      showFeedback('Review not submitted: the account or film context changed', 'error');
      return { status: 'context-changed' };
    }
    if (!reviewContextMatchesCurrentAccount(binding || { accountId })) {
      showFeedback('Review not submitted because the Letterboxd account changed. Draft kept.', 'error');
      return { status: 'account-changed' };
    }
    let draft;
    try {
      draft = normalizeReviewDraft(rawDraft, accountId, filmSlug);
    } catch (error) {
      showFeedback(`Review failed: ${error.message}`, 'error');
      return;
    }
    const fullReview = draft.reviewText.trim();
    const rating = draft.rating;
    const hasRating = rating !== null && rating !== undefined && rating !== 0;
    if (!fullReview && !hasRating) {
      showFeedback('Add a review or rating before submitting', 'error');
      return;
    }

    isProcessingAction = true;
    // Bind to the slug selected when the editor opened. Deck navigation can
    // continue while the POST is in flight, so currentDeckIndex is not identity.
    const reviewedIndex = isListingPage ? filmDeck.findIndex(film => film?.slug === filmSlug) : -1;
    const reviewedCard = isListingPage
      ? (reviewedIndex >= 0
          ? filmDeck[reviewedIndex]
          : masterDeck.find(film => film?.slug === filmSlug) || (binding?.film?.slug === filmSlug ? binding.film : null))
      : null;
    showFeedback('Submitting review...', 'watchlist');

    try {
      const canonicalUrl = 'https://letterboxd.com/film/' + filmSlug + '/';
      const filmDataUrl = canonicalUrl + 'json/';
      const filmData = await fetchReviewFilmJson(filmDataUrl);
      if (!reviewContextMatchesCurrentAccount(binding || { accountId })) {
        showFeedback('Review not submitted because the Letterboxd account changed. Draft kept.', 'error');
        return { status: 'account-changed' };
      }

      const csrf = readCsrfToken(document) || filmData.csrf;
      const productionId = filmData.lid;
      const storedFilm = window.VypodeFilmState?.get?.(filmSlug);
      const liveFilmState = !isListingPage ? getStates() : null;
      const explicitRemoteLike = [filmData?.viewerState?.liked, filmData?.liked, filmData?.like]
        .find(value => typeof value === 'boolean');
      let preservedLike;
      if (typeof explicitRemoteLike === 'boolean') {
        preservedLike = explicitRemoteLike;
      } else if (isListingPage && reviewedCard?.likeStateKnown === true && typeof reviewedCard.isLiked === 'boolean') {
        preservedLike = reviewedCard.isLiked;
      } else if (!isListingPage && document.querySelector(SELECTORS.like) && typeof liveFilmState?.isLiked === 'boolean') {
        preservedLike = liveFilmState.isLiked;
      } else if (storedFilm && (storedFilm.likedChangedAt || storedFilm.likedAt || storedFilm.likedSource) &&
                 typeof storedFilm.liked === 'boolean') {
        preservedLike = storedFilm.liked;
      }
      if (draft.likeMode === 'preserve' && typeof preservedLike !== 'boolean') {
        setReviewDraftStatus('Current like state could not be verified. Choose “Like this film” or “Do not like this film” before submitting.', 'error');
        showFeedback('Review not submitted: choose an explicit Like option', 'error');
        return { status: 'like-unknown' };
      }
      const intendedLike = draft.likeMode === 'like' || (draft.likeMode === 'preserve' && preservedLike === true);

      if (!csrf || csrf === 'placeholder') throw new Error('Not logged in to Letterboxd');
      if (!productionId) throw new Error('Could not identify film (no production lid)');

      const payload = {
        productionId,
        diaryDetails: { diaryDate: draft.diaryDate, rewatch: draft.rewatch },
        tags: draft.tags,
        like: intendedLike
      };
      if (fullReview) payload.review = { text: fullReview, containsSpoilers: draft.spoilers };
      if (hasRating) payload.rating = rating;
      const privacyPolicy = typeof filmData?.privacyPolicy === 'string' && filmData.privacyPolicy.trim()
        ? filmData.privacyPolicy.trim()
        : null;
      if (privacyPolicy) payload.privacyPolicy = privacyPolicy;

      if (!reviewContextMatchesCurrentAccount(binding || { accountId })) {
        showFeedback('Review not submitted because the Letterboxd account changed. Draft kept.', 'error');
        return { status: 'account-changed' };
      }

      const submitResult = await sendReviewSubmissionCommand({
        accountId,
        generation: binding?.generation,
        slug: filmSlug,
        csrf,
        payload,
        requestId: `review:${accountId}:${filmSlug}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        draftRevision: draft.revision,
        draftUpdatedAt: draft.updatedAt
      });
      if (!submitResult.ok) {
        if (submitResult.busy) {
          showFeedback('A review for this film is already submitting in another tab. Draft kept.', 'error');
          return { status: 'busy' };
        }
        if (submitResult.uncertain) {
          lockReviewRetry(binding, 'Letterboxd may have created this entry, but the result could not be confirmed. Check before allowing another submission.', submitResult.markerToken);
          showFeedback('Review outcome is uncertain — draft kept. Check your Letterboxd diary before retrying.', 'error');
          return { status: 'uncertain' };
        }
        if (submitResult.stale || submitResult.code === 'context-changed') {
          showFeedback('Review not submitted because local data or the active account changed. Draft kept.', 'error');
          return { status: 'context-changed' };
        }
        throw new Error(submitResult.error || 'Review service rejected the request');
      }
      if (!submitResult.confirmed && submitResult.uncertain) {
        lockReviewRetry(binding, 'Letterboxd may have created this entry, but the result could not be confirmed. Check before allowing another submission.', submitResult.markerToken);
        showFeedback('Review outcome is uncertain — draft kept. Check your Letterboxd diary before retrying.', 'error');
        return { status: 'uncertain' };
      }
      if (!submitResult.confirmed && (submitResult.status < 200 || submitResult.status >= 300)) {
        throw new Error('Server returned ' + submitResult.status);
      }
      const verification = submitResult.verification || verifyReviewSubmitted(submitResult.body, {
        productionId,
        reviewText: fullReview || undefined,
        rating: hasRating ? rating : undefined,
        watchedDate: draft.diaryDate,
        rewatch: draft.rewatch,
        like: intendedLike,
        spoilers: fullReview ? draft.spoilers : undefined,
        tags: draft.tags,
        privacyPolicy: privacyPolicy || undefined
      });
      if (verification.status !== 'confirmed') {
        vyWarn('submitReview: unconfirmed response; preserving draft', verification.status);
        const feedback = verification.status === 'rejected'
          ? `Review failed: ${verification.reason} — draft kept.`
          : 'Review response uncertain — draft kept. Check your diary before retrying.';
        if (verification.status === 'unconfirmed') lockReviewRetry(binding, null, submitResult.markerToken);
        showFeedback(feedback, 'error');
        return { status: verification.status };
      }

      const accountStillBound = reviewContextMatchesCurrentAccount(binding || { accountId });
      if (accountStillBound && submitResult.stateCommitted !== false) {
        const localPatch = {
          watched: true,
          watchedDate: draft.diaryDate,
          liked: intendedLike,
          url: canonicalUrl
        };
        if (hasRating) {
          localPatch.ratingValue = rating;
          localPatch.rating = reviewRatingDisplay(rating);
        }
        if (fullReview) localPatch.reviewText = fullReview;
        window.VypodeFilmState?.updateFilm?.(filmSlug, localPatch, 'userAction');
      }
      const draftCleared = submitResult.draftCleared === true;
      const newerEdits = Boolean(submitResult.newerDraft) ||
        Boolean(binding && (binding.revision !== draft.revision || binding.dirty));
      const deckStillBound = accountStillBound && reviewContextMatchesCurrentAccount(binding || { accountId });
      showFeedback(
        newerEdits
          ? 'Review submitted. Newer edits remain saved in the open draft.'
          : submitResult.stateCommitted === false
            ? 'Review submitted, but local data changed before it could be recorded. Do not retry without checking your diary.'
            :
        !deckStillBound
          ? (draftCleared
              ? 'Review submitted for the original account; its local draft was cleared.'
              : 'Review submitted for the original account, but its local draft could not be cleared.')
          : draftCleared
          ? 'Review submitted!'
          : 'Review submitted, but the local draft could not be cleared.',
        draftCleared && deckStillBound && !newerEdits && submitResult.stateCommitted !== false ? 'watchlist' : 'error'
      );
      if (reviewDraftContext === binding && draftCleared && !newerEdits) hideReviewPanel({ saveDraft: false });
      if (deckStillBound && submitResult.stateCommitted !== false && isListingPage && reviewedCard) {
        reviewedCard.isLiked = intendedLike;
        reviewedCard.liked = intendedLike;
        reviewedCard.actioned = true;
        // Only advance if this slug is still the card being shown.
        if (filmDeck[currentDeckIndex]?.slug === filmSlug) advanceToNextCard();
      }
      return { status: 'confirmed', draftCleared };
    } catch (e) {
      vyWarn('submitReview failed:', e.message);
      // No tab fallback — keep the review panel open so the user can retry.
      showFeedback('Review failed: ' + e.message + ' — try again', 'error');
    } finally {
      isProcessingAction = false;
      drainPendingDeckStateRefilter();
    }
  }


  // ── Deck navigation ─────────────────────────────────────────────────

  // The v6.2 in-place loader remains the default. The beta option chooses a
  // real Letterboxd page navigation instead, then reopens the deck there.
  let currentNextPageUrl = null;
  let isLoadingMore = false;
  let isNavigatingPage = false;
  let pageNavigationTimer = null;
  let pageNavigationGeneration = 0;
  const MAX_AUTO_RESUME_PAGES = 10;
  const MAX_IN_PLACE_PAGES = 25;
  let inPlacePageHops = 0;
  const visitedInPlacePages = new Set();
  let deckRunGeneration = 0;
  let deckRunAbortController = null;
  let isOpeningDeck = false;

  function cancelDeckRun() {
    deckRunGeneration++;
    deckRunAbortController?.abort?.();
    deckRunAbortController = null;
    isOpeningDeck = false;
    isLoadingMore = false;
    const toggle = document.querySelector('.vypode-toggle-btn');
    if (toggle) toggle.disabled = false;
  }

  function isAutoNextPageEnabled() {
    return window.VypodeFilmState?.getPrefs?.().autoNextPage === true;
  }

  function deckResumeUrl(url, resumeHop) {
    try {
      const destination = new URL(url, window.location.href);
      const source = new URL(window.location.href);
      if (!validListingPaginationDestination(source, destination)) return '';
      const hop = Number.isInteger(resumeHop) && resumeHop > 0
        ? Math.min(resumeHop, MAX_AUTO_RESUME_PAGES)
        : 0;
      destination.hash = hop > 0 ? `vypode-auto=${hop}` : 'vypode-auto';
      return destination.href;
    } catch (e) {
      return '';
    }
  }

  function cancelPendingPageNavigation() {
    pageNavigationGeneration++;
    if (pageNavigationTimer) {
      clearTimeout(pageNavigationTimer);
      pageNavigationTimer = null;
    }
    isNavigatingPage = false;
  }

  function navigateToNextPage(url, options) {
    // A second terminal action gets its own complete Undo window. Replace the
    // earlier schedule instead of letting it navigate during the newer toast.
    if (isNavigatingPage && options?.afterUndoWindow) {
      cancelPendingPageNavigation();
    } else if (isNavigatingPage) {
      return;
    }
    const destination = deckResumeUrl(url, options?.resumeHop);
    if (!destination) {
      showFeedback('Could not verify the next Letterboxd listing page', 'error');
      return;
    }
    isNavigatingPage = true;
    const generation = ++pageNavigationGeneration;
    const delayMs = options?.afterUndoWindow ? 5200 : 0;
    const requirePreference = options?.requirePreference !== false;

    const beginNavigation = () => {
      pageNavigationTimer = null;
      if (generation !== pageNavigationGeneration) return;
      if (requirePreference && !isAutoNextPageEnabled()) {
        cancelPendingPageNavigation();
        return;
      }
      showFeedback('Opening the next Letterboxd page...', 'watch');

      // Actions run in background iframes. Give them time to commit before the
      // real page navigation tears down this content-script instance.
      waitForQueueDrain(() => {
        if (generation !== pageNavigationGeneration || !isNavigatingPage) return;
        // If a browser beforeunload handler blocks this assignment for any
        // reason, leave the feature retryable instead of permanently latched.
        isNavigatingPage = false;
        window.location.href = destination;
      }, 0, () => {
        if (generation !== pageNavigationGeneration) return;
        cancelPendingPageNavigation();
        showFeedback('Still syncing actions — try Next page again shortly', 'error');
      });
    };

    if (delayMs > 0) pageNavigationTimer = setTimeout(beginNavigation, delayMs);
    else beginNavigation();
  }

  function advanceToNextCard(options) {
    if (currentDeckIndex < filmDeck.length - 1) {
      currentDeckIndex++;
      updateDeckCard();
      updateProgress();
      // Pre-fetch film details for the new card
      enrichFilmData(filmDeck[currentDeckIndex]);
      enrichFilmData(filmDeck[currentDeckIndex + 1]); // pre-warm the next card's metadata
      preloadNextPosters(currentDeckIndex + 1, 10);
    } else {
      const nextUrl = currentNextPageUrl || getNextPageUrl();
      if (!nextUrl) {
        showFeedback('All done! No more pages.', 'watchlist');
      } else if (isAutoNextPageEnabled()) {
        navigateToNextPage(nextUrl, { afterUndoWindow: options?.afterUndoWindow === true });
      } else {
        loadNextPageFilms(nextUrl, options);
      }
    }
  }

  async function loadNextPageFilms(url, options) {
    if (isLoadingMore) return;
    const runGeneration = deckRunGeneration;
    const signal = deckRunAbortController?.signal;
    if (!vypodeVisible || !isListingPage || signal?.aborted) return;
    let canonicalUrl;
    try {
      const parsed = new URL(url, window.location.href);
      const source = new URL(window.location.href);
      if (!validListingPaginationDestination(source, parsed)) throw new Error('Unsafe pagination target');
      parsed.hash = '';
      canonicalUrl = parsed.href;
    } catch {
      showFeedback('Could not verify the next Letterboxd page', 'error');
      return;
    }
    if (visitedInPlacePages.has(canonicalUrl)) {
      showFeedback('Stopped because Letterboxd pagination repeated a page', 'error');
      return;
    }
    if (inPlacePageHops >= MAX_IN_PLACE_PAGES) {
      showFeedback(`Opening page ${inPlacePageHops + 2} after ${MAX_IN_PLACE_PAGES} in-place loads...`, 'watch');
      navigateToNextPage(canonicalUrl, { requirePreference: false, afterUndoWindow: options?.afterUndoWindow === true });
      return;
    }
    visitedInPlacePages.add(canonicalUrl);
    inPlacePageHops++;
    isLoadingMore = true;
    showFeedback('Loading more films...', 'watch');

    try {
      const response = await fetch(url, { credentials: 'same-origin', signal });
      if (!response.ok) throw new Error('Failed to load page');

      const html = await response.text();
      if (signal?.aborted || runGeneration !== deckRunGeneration || !vypodeVisible || !isListingPage) return;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const pageFilms = extractListingFilms(doc);
      if (pageFilms.length === 0) {
        // Current Letterboxd listing responses can be an HTTP-200 CSI shell
        // whose film grid appears only after browser hydration. Navigate to
        // the already validated Next URL so Letterboxd can render it normally.
        throw new Error('Fetched page contains no extractable films');
      }
      const existingSlugs = new Set(masterDeck.map(film => film.slug));
      const newFilms = pageFilms.filter(film => !existingSlugs.has(film.slug));
      masterDeck.push(...newFilms);
      const filtered = filterFilmDeck(newFilms);

      currentNextPageUrl = getNextPageUrl(doc, url);

      if (filtered.length > 0) {
        filmDeck.push(...filtered);
        currentDeckIndex++;
        updateDeckCard();
        updateProgress();
        enrichFilmData(filmDeck[currentDeckIndex]);
        enrichFilmData(filmDeck[currentDeckIndex + 1]);
        preloadNextPosters(currentDeckIndex + 1, 10);
        showFeedback('Loaded ' + filtered.length + ' more films', 'watchlist');
      } else if (currentNextPageUrl) {
        // All films on this page were filtered — try the next one.
        isLoadingMore = false;
        loadNextPageFilms(currentNextPageUrl, options);
        return;
      } else {
        showFeedback('All done! No more pages.', 'watchlist');
      }
    } catch (e) {
      if (signal?.aborted || runGeneration !== deckRunGeneration || !vypodeVisible || !isListingPage) return;
      // Dynamic Letterboxd grids may not exist in fetched source HTML. A real
      // navigation lets Letterboxd hydrate the page normally, then resumes.
      showFeedback('Syncing actions & loading next page...', 'watch');
      navigateToNextPage(url, {
        requirePreference: false,
        afterUndoWindow: options?.afterUndoWindow === true
      });
    }

    if (runGeneration === deckRunGeneration) isLoadingMore = false;
  }

  function waitForQueueDrain(callback, elapsed, timeoutCallback) {
    elapsed = elapsed || 0;
    if (actionQueue.length === 0 && !isProcessingQueue) {
      callback();
    } else if (elapsed >= 60000) {
      timeoutCallback?.();
    } else {
      setTimeout(function() { waitForQueueDrain(callback, elapsed + 200, timeoutCallback); }, 200);
    }
  }

  async function skipCurrentFilm() {
    if (isProcessingAction) return;
    const film = filmDeck[currentDeckIndex];
    if (!film) {
      showFeedback('No current film to skip', 'error');
      return;
    }
    isProcessingAction = true;
    setDeckActionControlsDisabled(true);

    const prevIndex = currentDeckIndex;
    film.actioned = true;

    const skipContext = {
      accountId: window.VypodeFilmState?.getAccountId?.(),
      generation: currentActionGeneration()
    };
    try {
      const saved = film.slug && await window.VypodeFilmState?.setFlagPersisted?.(
        film.slug, 'skipped', true, 'userAction', undefined, skipContext
      );
      if (!saved) throw new Error('local data changed before the skip was saved');
    } catch (error) {
      film.actioned = false;
      isProcessingAction = false;
      updateDeckActionControls();
      showFeedback('Could not save skipped film: ' + error.message, 'error');
      return false;
    }

    showUndoToast('Skipped', 'skip', async () => {
      cancelPendingPageNavigation();
      try {
        const undone = await window.VypodeFilmState?.setFlagPersisted?.(
          film.slug, 'skipped', false, 'userAction', undefined, {
            accountId: window.VypodeFilmState?.getAccountId?.(),
            generation: currentActionGeneration()
          }
        );
        if (!undone) throw new Error('local data changed before Undo was saved');
      } catch (error) {
        showFeedback('Could not save Undo: ' + error.message, 'error');
        return;
      }
      film.actioned = false;
      currentDeckIndex = prevIndex;
      updateDeckCard();
      updateProgress();
      showFeedback('Undone!', 'skip');
    });

    const hasNext = currentDeckIndex < filmDeck.length - 1;
    if (hasNext) {
      runSwipeAnimation('down');
      currentDeckIndex++;
      updateProgress();
      enrichFilmData(filmDeck[currentDeckIndex]);
      enrichFilmData(filmDeck[currentDeckIndex + 1]); // pre-warm the next card's metadata
      preloadNextPosters(currentDeckIndex + 1, 10);
      setTimeout(() => {
        populateCurrentCard(filmDeck[currentDeckIndex]);
        populateNextCard(filmDeck[currentDeckIndex + 1]);
        resetCardStack();
        isProcessingAction = false;
        updateDeckActionControls();
        drainPendingDeckStateRefilter();
      }, 200);
    } else {
      // Keep the five-second Undo window available before leaving this page.
      advanceToNextCard({ afterUndoWindow: true });
      isProcessingAction = false;
      updateDeckActionControls();
      drainPendingDeckStateRefilter();
    }
    return true;
  }

  function showFeedback(message, type) {
    const existing = document.querySelector('.vypode-toast:not(.vypode-toast-undo)');
    if (existing) existing.remove();
    const undoToast = document.querySelector('.vypode-toast-undo');
    const toast = document.createElement('div');
    toast.className = 'vypode-toast vypode-toast-' + type;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    toast.setAttribute('aria-atomic', 'true');
    toast.textContent = message;
    if (undoToast) toast.style.bottom = '140px';
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 2000);
  }

  let lastUndoCallback = null;
  function showUndoToast(message, type, undoCallback) {
    document.querySelectorAll('.vypode-toast').forEach(existing => existing.remove());
    const toast = document.createElement('div');
    toast.className = 'vypode-toast vypode-toast-' + type + ' vypode-toast-undo';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.setAttribute('aria-atomic', 'true');
    toast.innerHTML = '<span>' + escapeHtml(message) + '</span><button class="vypode-undo-btn">Undo (⌘Z)</button>';
    document.body.appendChild(toast);
    let actionable = true;
    const fire = () => {
      if (!actionable) return;
      actionable = false;
      undoCallback();
      lastUndoCallback = null;
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    };
    lastUndoCallback = fire;
    toast.querySelector('.vypode-undo-btn').addEventListener('click', fire);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      if (lastUndoCallback === fire) lastUndoCallback = null;
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
    return {
      expire(label) {
        if (!actionable) return;
        actionable = false;
        if (lastUndoCallback === fire) lastUndoCallback = null;
        const button = toast.querySelector('.vypode-undo-btn');
        if (button) {
          button.textContent = label || 'Syncing…';
          button.disabled = true;
          button.setAttribute('aria-disabled', 'true');
        }
      }
    };
  }

  function updateProgress() {
    const counter = document.querySelector('.vypode-deck-counter');
    const progress = document.querySelector('.vypode-progress-fill');
    if (counter) counter.textContent = filmDeck.length ? `${currentDeckIndex + 1} / ${filmDeck.length}` : '0 / 0';
    if (progress) progress.style.width = filmDeck.length
      ? ((currentDeckIndex + 1) / filmDeck.length) * 100 + '%'
      : '0%';
  }

  // ==================== COLLECTION SYNC ENGINE ====================

  function collectionSyncFlagCounts() {
    const counts = { watched: 0, liked: 0, watchlist: 0 };
    const records = window.VypodeFilmState?.getAll?.() || {};
    for (const entry of Object.values(records)) {
      if (!entry) continue;
      for (const flag of Object.keys(counts)) {
        // Metadata refreshes may update entry.source without changing the
        // provenance of any collection flag. Guard mass drops from the
        // per-flag source so an ordinary browse cannot disable this safety net.
        if (entry[flag] && entry[flag + 'Source'] === 'collectionSync') counts[flag]++;
      }
    }
    return counts;
  }

  function suspiciousCollectionDrops(before, next) {
    return Object.keys(before).filter(flag => {
      const previousCount = before[flag] || 0;
      const nextCount = next[flag] || 0;
      return (previousCount > 0 && nextCount === 0) ||
        (previousCount >= 4 && nextCount <= Math.max(1, Math.floor(previousCount * 0.25)));
    });
  }

  function pageIsSignedOutDocument(doc) {
    const links = Array.from(doc?.querySelectorAll?.('a[href]') || []);
    const hasSignIn = links.some(link => /sign[\s-]*in/i.test(link.textContent || '') &&
      (link.getAttribute('href') || '').includes('sign-in'));
    const hasSignOut = links.some(link => /sign\s*out/i.test(link.textContent || ''));
    return hasSignIn && !hasSignOut;
  }

  function pageExplicitlyShowsEmptyCollection(doc) {
    const marker = doc?.querySelector?.(
      '.empty-message, .no-results, .message.-empty, [data-component-class*="Empty"], [data-testid*="empty"]'
    );
    return Boolean(marker);
  }

  function updateCollectionSyncProgress(label, page, count) {
    const status = document.getElementById('vypodeSyncStatus');
    if (status) status.textContent = `Syncing ${label}: page ${page} • ${count} films`;
  }

  function createSyncAbortError() {
    const error = new Error('Sync cancelled');
    error.name = 'AbortError';
    return error;
  }

  function isSyncAbort(error, signal) {
    // A request timeout also rejects with AbortError, but it is a sync failure,
    // not a user cancellation. The parent signal is the cancellation authority.
    return signal ? signal.aborted : error?.name === 'AbortError';
  }

  function throwIfSyncAborted(signal) {
    if (signal?.aborted) throw createSyncAbortError();
  }

  function cancelCollectionSync() {
    if (!isSyncing || !syncAbortController || syncAbortController.signal.aborted) return false;
    syncAbortController.abort();
    updateSyncUI('cancelling');
    showFeedback('Cancelling collection sync...', 'watch');
    return true;
  }

  async function runCollectionSync() {
    if (!isLetterboxdSessionActive) {
      showFeedback('Log in to Letterboxd to sync your profile', 'error');
      return { success: false, error: 'Not logged in' };
    }
    if (!letterboxdUsername) {
      showFeedback('No Letterboxd account detected — log in first', 'error');
      return { success: false, error: 'Not logged in' };
    }
    if (isSyncing) {
      const cancelRequested = cancelCollectionSync();
      return { success: false, cancelled: cancelRequested, error: cancelRequested ? 'Sync cancelled' : 'Already cancelling' };
    }

    const expectedAccountId = window.VypodeFilmState?.getAccountId?.() || null;
    const expectedAccountUsername = window.VypodeFilmState?.getAccountUsername?.() || null;
    const expectedGeneration = Number(window.VypodeFilmState?.getMeta?.().rootGeneration);
    if (!expectedAccountId || !expectedAccountUsername || expectedAccountUsername.toLowerCase() !== letterboxdUsername.toLowerCase()) {
      syncRequiresRefresh = true;
      updateSyncUI('account-changed');
      showFeedback('Letterboxd account changed — refresh this page before syncing', 'error');
      return { success: false, accountChanged: true, error: 'Letterboxd account changed' };
    }

    const controller = new AbortController();
    const signal = controller.signal;
    let accountChanged = false;
    let stateChanged = false;
    let commitStarted = false;
    let commitMutated = false;
    const detectAccountChange = (snapshot) => {
      const currentGeneration = Number(window.VypodeFilmState?.getMeta?.().rootGeneration);
      const currentAccount = window.VypodeFilmState?.getAccountId?.();
      if (currentAccount === expectedAccountId && currentGeneration === expectedGeneration &&
          (!snapshot || commitStarted || !['state-changed', 'cleared-all', 'stale-write-rejected', 'account-changed'].includes(snapshot.reason))) {
        return false;
      }
      accountChanged = currentAccount !== expectedAccountId;
      stateChanged = !accountChanged;
      if (!signal.aborted) controller.abort();
      return true;
    };
    const assertSyncAccount = () => {
      if (detectAccountChange()) {
        const error = new Error(accountChanged
          ? 'Letterboxd account changed during sync'
          : 'Local film data changed during sync');
        error.name = accountChanged ? 'SyncAccountChangedError' : 'SyncStateChangedError';
        throw error;
      }
      throwIfSyncAborted(signal);
    };
    const unsubscribeAccount = window.VypodeFilmState?.subscribe?.(detectAccountChange) || (() => {});
    syncAbortController = controller;
    isSyncing = true;
    updateSyncUI('syncing');
    showFeedback('Syncing your Letterboxd collections...', 'watch');
    const startTime = Date.now();
    const syncStartedAt = new Date(startTime).toISOString();

    try {
      const results = { watched: 0, watchlist: 0, liked: 0, reviewed: 0 };

      const previousCounts = collectionSyncFlagCounts();
      // Wait for every sibling to settle. This makes cancellation deterministic:
      // no abandoned page worker can reject later or survive into a restarted sync.
      const stageResults = await Promise.allSettled([
        fetchAllCollectionFilms(`/${letterboxdUsername}/films/`, { watched: true }, 'watched films', signal),
        fetchAllCollectionFilms(`/${letterboxdUsername}/watchlist/`, { watchlist: true }, 'watchlist', signal),
        fetchAllCollectionFilms(`/${letterboxdUsername}/likes/films/`, { liked: true }, 'liked films', signal),
        fetchAllDiaryFilms(`/${letterboxdUsername}/films/diary/`, 'diary', signal)
      ]);
      assertSyncAccount();
      const rejectedStage = stageResults.find(result => result.status === 'rejected');
      if (rejectedStage) throw rejectedStage.reason;
      const [watchedResult, watchlistResult, likedResult, diaryResult] = stageResults.map(result => result.value);

      const incomplete = [
        ['watched films', watchedResult],
        ['watchlist', watchlistResult],
        ['liked films', likedResult],
        ['diary', diaryResult]
      ].find(([, result]) => !result.complete);
      if (incomplete) {
        throw new Error(`Could not complete ${incomplete[0]} sync: ${incomplete[1].error || 'partial fetch'}`);
      }

      const watchedFilms = watchedResult.films;
      const watchlistFilms = watchlistResult.films;
      const likedFilms = likedResult.films;
      const diaryFilms = diaryResult.films;
      results.watched = watchedFilms.length;
      results.watchlist = watchlistFilms.length;
      results.liked = likedFilms.length;

      const suspiciousDrops = suspiciousCollectionDrops(previousCounts, {
        watched: results.watched,
        watchlist: results.watchlist,
        liked: results.liked
      });
      if (suspiciousDrops.length > 0) {
        throw new Error(
          `Sync result dropped most ${suspiciousDrops.join(', ')} records; no local flags were changed. Try again later.`
        );
      }

      const slugMap = {};
      for (const film of [...watchedFilms, ...watchlistFilms, ...likedFilms]) {
        if (!film.slug) continue;
        slugMap[film.slug] = mergeSyncedFilmRecord(slugMap[film.slug], film);
      }
      // The all-films page is the watched-flag authority. Diary entries add
      // exact dates and log metadata, but a watched film with no diary row
      // must remain present in this staged map.
      for (const film of diaryFilms) {
        if (!film.slug) continue;
        slugMap[film.slug] = mergeSyncedFilmRecord(slugMap[film.slug], film);
      }

      const syncStatus = document.getElementById('vypodeSyncStatus');
      if (syncStatus) syncStatus.textContent = 'Loading review text where available...';
      await hydrateReviewText(Object.values(slugMap), signal);
      // FilmState and its sync metadata remain completely untouched until every
      // remote stage has completed and the active run is still authorised.
      assertSyncAccount();
      results.reviewed = Object.values(slugMap).filter(film => film.reviewText).length;

      assertSyncAccount();
      commitStarted = true;
      const updated = window.VypodeFilmState.bulkSetFromSync(slugMap, 'collectionSync', { syncStartedAt });
      commitMutated = true;
      assertSyncAccount();
      const reconciled = window.VypodeFilmState.reconcileFlags?.({
        watched: new Set(watchedFilms.map(film => film.slug)),
        liked: new Set(likedFilms.map(film => film.slug)),
        watchlist: new Set(watchlistFilms.map(film => film.slug))
      }, 'collectionSync', { syncStartedAt }) || 0;
      const diaryEvidence = Object.create(null);
      for (const film of watchedFilms) {
        if (!film.slug) continue;
        diaryEvidence[film.slug] = {
          ratingPresent: film.ratingValue !== null && film.ratingValue !== undefined,
          reviewPresent: film.reviewPresent === true || film.reviewUrl
            ? true
            : film.reviewPresent === false
              ? false
              : undefined
        };
      }
      for (const film of diaryFilms) {
        if (!film.slug) continue;
        const prior = diaryEvidence[film.slug] || {};
        diaryEvidence[film.slug] = {
          ratingPresent: prior.ratingPresent === true ||
            (film.ratingValue !== null && film.ratingValue !== undefined),
          reviewPresent: prior.reviewPresent === true || film.reviewPresent === true || film.reviewUrl
            ? true
            : prior.reviewPresent === false || film.reviewPresent === false
              ? false
              : undefined
        };
      }
      const metadataCleared = window.VypodeFilmState.reconcileSyncMetadata?.(
        diaryEvidence, 'collectionSync', { syncStartedAt }
      ) || 0;

      const duration = Date.now() - startTime;
      assertSyncAccount();
      window.VypodeFilmState.setSyncMeta(new Date().toISOString(), duration, results);
      // No await occurs between the last account assertion and this point, so
      // the subscription covers every staged mutation. The storage writer's
      // generation fence owns the final commit itself.
      unsubscribeAccount();
      const persisted = await window.VypodeFilmState.flush();
      if (persisted === false) {
        const error = new Error('Local film data changed before the sync could be saved');
        error.name = 'SyncStateChangedError';
        throw error;
      }

      updateSyncUI('done');
      refreshSettingsStats();
      renderDatabaseBrowser();
      showFeedback(`Sync complete: ${results.watched} watched, ${results.watchlist} watchlist, ${results.liked} liked`, 'watchlist');

      return { success: true, results, updated, reconciled, metadataCleared, duration };

    } catch (e) {
      if (commitMutated) {
        try { await window.VypodeFilmState?.reload?.(); } catch {}
      }
      if (accountChanged || e?.name === 'SyncAccountChangedError') {
        syncRequiresRefresh = true;
        updateSyncUI('account-changed');
        showFeedback('Sync stopped because the active account changed — no sync data was saved', 'error');
        return { success: false, accountChanged: true, error: 'Letterboxd account changed' };
      }
      if (stateChanged || e?.name === 'SyncStateChangedError') {
        updateSyncUI('error');
        showFeedback('Sync stopped because local data changed in another tab — no staged sync data was kept', 'error');
        return { success: false, stateChanged: true, error: 'Local film data changed' };
      }
      if (isSyncAbort(e, signal)) {
        updateSyncUI('cancelled');
        showFeedback('Sync cancelled — no local data was changed', 'watch');
        return { success: false, cancelled: true, error: 'Sync cancelled' };
      }
      updateSyncUI('error');
      showFeedback('Sync failed: ' + e.message, 'error');
      return { success: false, error: e.message };
    } finally {
      unsubscribeAccount();
      if (syncAbortController === controller) {
        syncAbortController = null;
        isSyncing = false;
      }
    }
  }

  async function fetchAllCollectionFilms(basePath, flags, progressLabel, signal) {
    const films = new Map();
    let page = 1;
    const maxPages = 250; // Safety cap: 250 pages x 72 films = 18,000 films max

    while (page <= maxPages) {
      throwIfSyncAborted(signal);
      const url = `https://letterboxd.com${basePath}page/${page}/`;

      if (page > 1) await sleep(150, signal);

      try {
        const { response, body: html } = await fetchWithRetry(url, { credentials: 'same-origin', signal }, 15000);
        if (!response.ok) {
          return {
            films: Array.from(films.values()),
            complete: false,
            error: `HTTP ${response.status} on page ${page}`
          };
        }

        const doc = new DOMParser().parseFromString(html, 'text/html');

        const pageFilms = extractProfileFilms(doc, flags);
        let foundOnPage = 0;
        for (const film of pageFilms) {
          if (!film.slug) continue;
          const existing = films.get(film.slug) || {};
          films.set(film.slug, { ...existing, ...film });
          foundOnPage++;
        }

        if (pageIsSignedOutDocument(doc)) {
          return {
            films: Array.from(films.values()),
            complete: false,
            error: `signed-out response on page ${page}`
          };
        }

        if (foundOnPage === 0) {
          if (pageExplicitlyShowsEmptyCollection(doc)) {
            return { films: Array.from(films.values()), complete: true };
          }
          return {
            films: Array.from(films.values()),
            complete: false,
            error: `HTTP 200 page ${page} contained no recognizable films or explicit empty state`
          };
        }

        updateCollectionSyncProgress(progressLabel || 'collection', page, films.size);

        const hasNext = doc.querySelector('.paginate-nextprev a.next') ||
                        doc.querySelector('a[rel="next"]');
        if (!hasNext) {
          return { films: Array.from(films.values()), complete: true };
        }

        page++;
      } catch (e) {
        if (isSyncAbort(e, signal)) throw createSyncAbortError();
        console.warn('Vypode sync: failed to fetch page', page, e);
        return {
          films: Array.from(films.values()),
          complete: false,
          error: e.message || `failed page ${page}`
        };
      }
    }

    return {
      films: Array.from(films.values()),
      complete: false,
      error: `stopped after ${maxPages} pages with more pages remaining`
    };
  }

  // Diary pagination is a separate authoritative stage because it is the only
  // source that exposes the day a film was logged. Keep it independent from
  // /films/: profiles can legitimately contain watched films with no diary
  // entries, so an empty (but explicit) diary is valid.
  async function fetchAllDiaryFilms(basePath, progressLabel, signal) {
    const films = new Map();
    let page = 1;
    const maxPages = 250;

    while (page <= maxPages) {
      throwIfSyncAborted(signal);
      const url = `https://letterboxd.com${basePath}page/${page}/`;
      if (page > 1) await sleep(150, signal);

      try {
        const { response, body: html } = await fetchWithRetry(url, { credentials: 'same-origin', signal }, 15000);
        if (!response.ok) {
          return { films: Array.from(films.values()), complete: false, error: `HTTP ${response.status} on page ${page}` };
        }
        const doc = new DOMParser().parseFromString(html, 'text/html');
        if (pageIsSignedOutDocument(doc)) {
          return { films: Array.from(films.values()), complete: false, error: `signed-out response on page ${page}` };
        }

        const pageFilms = extractDiaryFilms(doc);
        if (pageFilms.length === 0) {
          if (pageExplicitlyShowsEmptyCollection(doc)) return { films: Array.from(films.values()), complete: true };
          return {
            films: Array.from(films.values()),
            complete: false,
            error: `HTTP 200 page ${page} contained no recognizable diary entries or explicit empty state`
          };
        }
        for (const film of pageFilms) {
          if (!film.slug) continue;
          films.set(film.slug, mergeDiaryFilmRecord(films.get(film.slug), film));
        }

        updateCollectionSyncProgress(progressLabel || 'diary', page, films.size);
        const hasNext = doc.querySelector('.paginate-nextprev a.next') || doc.querySelector('a[rel="next"]');
        if (!hasNext) return { films: Array.from(films.values()), complete: true };
        page++;
      } catch (e) {
        if (isSyncAbort(e, signal)) throw createSyncAbortError();
        console.warn('Vypode sync: failed to fetch diary page', page, e);
        return { films: Array.from(films.values()), complete: false, error: e.message || `failed page ${page}` };
      }
    }

    return { films: Array.from(films.values()), complete: false, error: `stopped after ${maxPages} pages with more pages remaining` };
  }

  function mergeSyncedFilmRecord(existing, incoming) {
    const merged = { ...(existing || {}) };
    for (const key of ['slug', 'title', 'year', 'director', 'genres', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl', 'reviewPresent', 'watchedAt', 'watchedDate']) {
      if (incoming[key] !== undefined && incoming[key] !== null && incoming[key] !== '') {
        merged[key] = incoming[key];
      }
    }
    for (const flag of ['watched', 'liked', 'watchlist']) {
      merged[flag] = Boolean(merged[flag] || incoming[flag]);
    }
    return merged;
  }

  function diaryRecordSortKey(film) {
    // The page order is usually newest-first, but a stable key also makes two
    // same-day rewatch entries resolve consistently across paginated responses.
    return [
      film?.watchedDate || '',
      film?.reviewUrl || '',
      String(film?.ratingValue ?? ''),
      film?.url || ''
    ].join('\u0000');
  }

  function diaryReviewSortKey(film) {
    if (!film?.reviewUrl) return '';
    return [film.watchedDate || '', film.reviewUrl].join('\u0000');
  }

  function mergeDiaryFilmRecord(existing, incoming) {
    if (!existing) return { ...incoming };
    // The newest diary row owns the watch date and rating. A review can live on
    // an older viewing, though, so retain the newest available review link
    // independently instead of dropping it when the latest rewatch is unreviewed.
    const latest = diaryRecordSortKey(incoming) > diaryRecordSortKey(existing)
      ? incoming
      : existing;
    const latestReview = diaryReviewSortKey(incoming) > diaryReviewSortKey(existing)
      ? incoming
      : existing;
    const merged = { ...latest };
    if (latestReview.reviewUrl) merged.reviewUrl = latestReview.reviewUrl;
    merged.reviewPresent = Boolean(existing.reviewPresent || incoming.reviewPresent || latestReview.reviewUrl);
    merged.liked = Boolean(existing.liked || incoming.liked);
    merged.rewatched = Boolean(existing.rewatched || incoming.rewatched);
    return merged;
  }

  function extractDiaryFilms(doc) {
    const films = [];
    const rows = doc.querySelectorAll('tr.diary-entry-row');
    rows.forEach(row => {
      const component = row.querySelector('[data-item-slug]');
      const href = component?.dataset?.itemLink || row.querySelector('a[href*="/film/"]')?.getAttribute('href') || '';
      const slug = component?.dataset?.itemSlug || parsedLetterboxdUrl(href)?.pathname.match(/^\/film\/([a-z0-9][a-z0-9-]*)\/?$/i)?.[1];
      const dateHref = row.querySelector('.col-daydate a.daydate[href*="/diary/films/for/"]')?.getAttribute('href') || '';
      const dateMatch = dateHref.match(/\/diary\/films\/for\/(\d{4})\/(\d{2})\/(\d{2})\//);
      if (!isSafeFilmSlug(slug) || !dateMatch) return;

      const filmLink = row.querySelector('a[href*="/film/"]');
      const img = row.querySelector('img');
      const ratingEl = row.querySelector('[class*="rated-"]');
      const reviewLink = row.querySelector('.col-review a[href], a.icon-review[href], a[class*="review"][href]');
      const likeLink = row.querySelector('.col-like a[href], a.icon-like[href], [data-track-action="Liked"]');
      const rewatchLink = row.querySelector('.col-rewatch a[href], a.icon-rewatch[href], [data-track-action="Rewatched"]');
      const title = titleWithoutPosterPrefix(
        component?.dataset?.itemName || component?.dataset?.itemFullDisplayName || img?.alt,
        slug.replace(/-/g, ' ')
      );
      const filmUrl = canonicalLetterboxdFilmUrl(href || filmLink?.getAttribute('href') || `/film/${slug}/`, slug);
      if (!filmUrl) return;
      const rawReviewUrl = reviewLink?.getAttribute('href') || '';
      const reviewUrl = rawReviewUrl
        ? canonicalLetterboxdReviewUrl(rawReviewUrl, slug, letterboxdUsername)
        : '';
      const film = {
        slug,
        title,
        year: parseYearFromTitle(title),
        poster: normalizePosterUrl(img?.src || img?.dataset?.src, img?.srcset),
        url: filmUrl,
        rating: ratingEl?.textContent?.trim() || null,
        ratingValue: parseRatingValue(ratingEl),
        reviewUrl: reviewUrl || null,
        // An invalid link is neither proof that a review exists nor complete
        // evidence that it does not. Preserve prior metadata in that case.
        reviewPresent: reviewLink ? (reviewUrl ? true : null) : false,
        watched: true,
        watchedDate: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
      };
      if (likeLink) film.liked = true;
      if (rewatchLink) film.rewatched = true;
      films.push(film);
    });
    return films;
  }

  function extractProfileFilms(doc, flags) {
    const films = [];
    const items = doc.querySelectorAll('.griditem, li.poster-container, li.posteritem, tr.diary-entry-row');
    const containers = items.length ? items : doc.querySelectorAll('[data-item-slug]');

    containers.forEach(item => {
      const component = item.querySelector('[data-item-slug]') || item.closest('[data-item-slug]') || item;
      const link = item.querySelector('a[href*="/film/"]') || component.querySelector?.('a[href*="/film/"]');
      const img = item.querySelector('img');
      const href = component.dataset?.itemLink || link?.getAttribute('href') || '';
      const slug = component.dataset?.itemSlug || parsedLetterboxdUrl(href)?.pathname.match(/^\/film\/([a-z0-9][a-z0-9-]*)\/?$/i)?.[1];
      if (!isSafeFilmSlug(slug)) return;

      const title = titleWithoutPosterPrefix(
        component.dataset?.itemName || component.dataset?.itemFullDisplayName || img?.alt,
        slug.replace(/-/g, ' ')
      );
      const ratingEl = item.querySelector('.poster-viewingdata .rating[class*="rated-"], .rating[class*="rated-"]');
      const reviewLink = item.querySelector('a.review-micro[href*="/film/"], a.icon-review[href*="/film/"]');
      const watchedDateLink = item.querySelector(
        '.col-daydate a.daydate[href*="/diary/films/for/"], a[href*="/diary/films/for/"]'
      );
      const watchedDateMatch = watchedDateLink?.getAttribute('href')?.match(
        /\/diary\/films\/for\/(\d{4})\/(\d{2})\/(\d{2})\//
      );
      const explicitDate = item.querySelector('time[datetime]')?.getAttribute('datetime') ||
        component.dataset?.viewingDate || '';
      let watchedAt = null;
      if (watchedDateMatch) {
        watchedAt = `${watchedDateMatch[1]}-${watchedDateMatch[2]}-${watchedDateMatch[3]}T12:00:00.000Z`;
      } else if (explicitDate && Number.isFinite(new Date(explicitDate).getTime())) {
        watchedAt = new Date(explicitDate).toISOString();
      }

      const filmUrl = canonicalLetterboxdFilmUrl(href || `/film/${slug}/`, slug);
      if (!filmUrl) return;
      const reviewUrl = reviewLink
        ? canonicalLetterboxdReviewUrl(reviewLink.getAttribute('href'), slug, letterboxdUsername)
        : '';
      const film = {
        slug,
        title,
        year: parseYearFromTitle(title),
        poster: normalizePosterUrl(img?.src || img?.dataset?.src, img?.srcset),
        url: filmUrl,
        rating: ratingEl?.textContent?.trim() || null,
        ratingValue: parseRatingValue(ratingEl),
        reviewUrl: reviewUrl || null,
        reviewPresent: reviewLink ? (reviewUrl ? true : null) : false,
        watchedAt
      };
      if (flags?.watched) film.watched = true;
      if (flags?.liked) film.liked = true;
      if (flags?.watchlist) film.watchlist = true;
      films.push(film);
    });

    return films;
  }

  function reviewBodyPlainText(body) {
    if (!body) return '';
    const copy = body.cloneNode(true);
    copy.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    copy.querySelectorAll('p, div, li, blockquote').forEach(node => node.append('\n'));
    return String(copy.textContent || '')
      .split(/\r?\n/)
      .map(line => line.replace(/[\t ]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  async function hydrateReviewText(films, signal) {
    const cachedFilms = window.VypodeFilmState?.getAll?.() || {};
    const queue = [];
    for (const film of films) {
      if (!film?.reviewUrl) continue;
      const canonicalReviewUrl = canonicalLetterboxdReviewUrl(
        film.reviewUrl,
        film.slug,
        letterboxdUsername
      );
      if (!canonicalReviewUrl) {
        delete film.reviewUrl;
        film.reviewHydrationFailed = true;
        continue;
      }
      film.reviewUrl = canonicalReviewUrl;
      const cached = cachedFilms[film.slug];
      if (cached?.reviewText && cached.reviewUrl === film.reviewUrl) {
        // Keep the staged sync record complete without a redundant fetch.
        film.reviewText = cached.reviewText;
        film.reviewHydrated = true;
      } else {
        queue.push(film);
      }
    }
    const syncStatus = document.getElementById('vypodeSyncStatus');
    let completed = 0;
    if (syncStatus && queue.length > 0) {
      syncStatus.textContent = `Loading review text where available... 0/${queue.length}`;
    }
    let index = 0;
    // Throttle: 2 concurrent workers with a short inter-request pause keeps the
    // review-text fan-out polite to letterboxd.com on large histories.
    const CONCURRENCY = Math.min(2, queue.length);
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (index < queue.length) {
        throwIfSyncAborted(signal);
        const film = queue[index++];
        const requestedReviewUrl = canonicalLetterboxdReviewUrl(film.reviewUrl, film.slug, letterboxdUsername);
        let hydrated = false;
        if (!requestedReviewUrl) {
          delete film.reviewUrl;
          film.reviewHydrationFailed = true;
          continue;
        }
        if (index > CONCURRENCY) await sleep(250, signal);
        try {
          const { response, body: html } = await fetchWithRetry(
            requestedReviewUrl,
            { credentials: 'same-origin', cache: 'no-store', signal },
            12000
          );
          if (response.ok) {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const body = doc.querySelector('.js-review-body, .review .body-text, .body-text.-prose');
            const text = reviewBodyPlainText(body);
            if (text) {
              film.reviewText = text;
              film.reviewHydrated = true;
              hydrated = true;
            }
          }
        } catch (e) {
          if (isSyncAbort(e, signal)) throw createSyncAbortError();
          // Review text is additive metadata. Missing text should never fail the whole sync.
        } finally {
          if (!hydrated && film.reviewUrl === requestedReviewUrl) {
            // Do not pair a newly discovered URL with stale text retained by
            // FilmState's additive merge. Keeping the old stored pair means the
            // new URL will be fetched again on the next sync.
            delete film.reviewUrl;
            delete film.reviewText;
            film.reviewHydrationFailed = true;
          }
          completed++;
          if (syncStatus && (completed === queue.length || completed % 25 === 0)) {
            syncStatus.textContent = `Loading review text where available... ${completed}/${queue.length}`;
          }
        }
      }
    });
    const settled = await Promise.allSettled(workers);
    throwIfSyncAborted(signal);
    const rejected = settled.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const parentSignal = options?.signal;
    throwIfSyncAborted(parentSignal);
    const abortFromParent = () => controller.abort();
    parentSignal?.addEventListener?.('abort', abortFromParent, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timeout);
      parentSignal?.removeEventListener?.('abort', abortFromParent);
    };
    try {
      const response = await fetch(url, { ...(options || {}), signal: controller.signal });
      return {
        response,
        release: cleanup,
        async readText() {
          try {
            return await response.text();
          } finally {
            cleanup();
          }
        }
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  // Like fetchWithTimeout, but treats Letterboxd throttling (429 / 503) as
  // retryable rather than fatal: honour Retry-After when present, otherwise
  // back off exponentially. A throttled page is recoverable, so it must not
  // abort the whole sync as "incomplete".
  async function fetchWithRetry(url, options, timeoutMs, maxRetries = 3) {
    let attempt = 0;
    while (true) {
      const request = await fetchWithTimeout(url, options, timeoutMs);
      const response = request.response;
      if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
        const headerVal = response.headers?.get?.('Retry-After');
        const retryAfter = parseInt(headerVal, 10);
        const backoff = Number.isFinite(retryAfter)
          ? Math.min(retryAfter * 1000, 30000)
          : Math.min(1000 * Math.pow(2, attempt), 8000);
        request.release();
        await sleep(backoff, options?.signal);
        attempt++;
        continue;
      }
      if (!response.ok) {
        request.release();
        return { response, body: '' };
      }
      return { response, body: await request.readText() };
    }
  }

  function sleep(ms, signal) {
    if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
    throwIfSyncAborted(signal);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener?.('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timeout);
        signal.removeEventListener?.('abort', onAbort);
        reject(createSyncAbortError());
      };
      signal.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  function updateSyncUI(state) {
    const syncBtn = document.getElementById('vypodeSyncBtn');
    const syncStatus = document.getElementById('vypodeSyncStatus');
    if (syncBtn) {
      syncBtn.disabled = state === 'cancelling' || state === 'account-changed' ||
        (!isLetterboxdSessionActive && state !== 'syncing');
      syncBtn.textContent = state === 'syncing'
        ? 'Cancel sync'
        : state === 'cancelling' ? 'Cancelling...'
          : state === 'account-changed' ? 'Refresh to sync' : 'Sync now';
      syncBtn.setAttribute(
        'aria-label',
        state === 'syncing' ? 'Cancel collection sync'
          : state === 'account-changed' ? 'Refresh this page before syncing' : 'Sync Letterboxd collection now'
      );
    }
    if (syncStatus) {
      syncStatus.dataset.state = state;
      syncStatus.setAttribute('aria-busy', state === 'syncing' || state === 'cancelling' ? 'true' : 'false');
      if (state === 'syncing') {
        syncStatus.textContent = 'Syncing your collections...';
        syncStatus.style.color = '#f7931e';
      } else if (state === 'cancelling') {
        syncStatus.textContent = 'Cancelling sync...';
        syncStatus.style.color = '#f7931e';
      } else if (state === 'cancelled') {
        syncStatus.textContent = 'Sync cancelled — no local data changed';
        syncStatus.style.color = '#f7931e';
      } else if (state === 'account-changed') {
        syncStatus.textContent = 'Sync stopped — active account changed; refresh this page';
        syncStatus.style.color = '#ff4444';
      } else if (state === 'done') {
        const meta = window.VypodeFilmState?.getMeta();
        syncStatus.textContent = meta?.lastSyncAt ? `Last sync: ${formatTimeAgo(meta.lastSyncAt)}` : 'Sync complete';
        syncStatus.style.color = '#00c853';
      } else if (state === 'error') {
        syncStatus.textContent = 'Sync failed — try again';
        syncStatus.style.color = '#ff4444';
      }
    }
  }

  function formatTimeAgo(isoString) {
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // ==================== REVIEW PANEL ====================

  function getSpeechRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function isBraveBrowser() {
    return Boolean(window.navigator?.brave && typeof window.navigator.brave.isBrave === 'function');
  }

  function systemDictationHelp(prefix) {
    const platform = `${window.navigator?.platform || ''} ${window.navigator?.userAgent || ''}`;
    const shortcut = /Mac/i.test(platform)
      ? 'Focus the review box and press Fn/Globe twice to use macOS Dictation.'
      : 'Focus the review box and start your system dictation shortcut.';
    return `${prefix ? prefix + ' ' : ''}${shortcut}`;
  }

  function setSpeechStatus(message, tone) {
    const status = document.getElementById('vypodeSpeechStatus');
    if (!status) return;
    status.textContent = message || '';
    status.className = `vypode-speech-status${tone ? ` ${tone}` : ''}`;
  }

  function clearSpeechTimers() {
    if (speechStartTimer) clearTimeout(speechStartTimer);
    if (speechStopTimer) clearTimeout(speechStopTimer);
    speechStartTimer = null;
    speechStopTimer = null;
  }

  function settleSpeechStop(result) {
    const resolve = resolveSpeechStop;
    resolveSpeechStop = null;
    speechStopPromise = null;
    if (resolve) resolve(result || { status: 'complete' });
  }

  function updateMicButton() {
    const micBtn = document.getElementById('vypodeMicBtn');
    if (!micBtn) return;
    const labels = {
      idle: 'Dictate',
      starting: 'Cancel dictation',
      listening: 'Recording...',
      stopping: 'Finishing...',
      unavailable: 'System dictation',
      error: 'Dictate'
    };
    const active = speechState === 'starting' || speechState === 'listening' || speechState === 'stopping';
    micBtn.textContent = labels[speechState] || 'Dictate';
    micBtn.dataset.state = speechState;
    micBtn.classList.toggle('listening', speechState === 'listening');
    micBtn.disabled = speechState === 'stopping';
    micBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    micBtn.setAttribute('aria-busy', speechState === 'stopping' ? 'true' : 'false');
  }

  function setDictationState(nextState, message, tone) {
    speechState = nextState;
    updateMicButton();
    if (message !== undefined) setSpeechStatus(message, tone);
  }

  function clearInterimTranscript() {
    const interim = document.getElementById('vypodeInterim');
    if (interim) interim.textContent = '';
  }

  function finishDictationSession(instance, sessionId, nextState, message, tone, stopResult) {
    if (recognition !== instance || speechSessionId !== sessionId) return;
    clearSpeechTimers();
    recognition = null;
    clearInterimTranscript();
    settleSpeechStop(stopResult);
    setDictationState(nextState || 'idle', message, tone);
  }

  function speechErrorMessage(code) {
    const braveHint = isBraveBrowser()
      ? ' Brave browser speech recognition may be unavailable; use system dictation or try Chrome.'
      : '';
    const messages = {
      'not-allowed': 'Microphone access is blocked. Allow it for letterboxd.com and in your system settings.',
      'service-not-allowed': 'The browser speech service is blocked or unavailable.' + braveHint,
      'audio-capture': 'No working microphone was found. Check your browser and system microphone settings.',
      'network': 'The speech service could not connect. Check your connection and try again.' + braveHint,
      'no-speech': 'No speech was heard. Press Dictate and try again.',
      'language-not-supported': 'Your current language is not supported for browser dictation.',
      'bad-grammar': 'The browser could not configure speech recognition.',
      'phrases-not-supported': 'The browser could not configure speech recognition.',
      'aborted': 'Dictation stopped unexpectedly. Press Dictate to try again.'
    };
    return messages[code] || `Dictation failed${code ? ` (${code})` : ''}. Press Dictate to try again.`;
  }

  function appendFinalTranscript(textarea, transcript) {
    const clean = String(transcript || '').replace(/\s+/g, ' ').trim();
    if (!textarea || !clean) return;
    const existing = textarea.value || '';
    const separator = existing && !/\s$/.test(existing) && !/^[,.;!?]/.test(clean) ? ' ' : '';
    textarea.value = existing + separator + clean;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function initSpeechRecognition(sessionId) {
    const SpeechRecognition = getSpeechRecognitionCtor();
    if (!SpeechRecognition) return null;
    const instance = new SpeechRecognition();
    const committedResultIndexes = new Set();
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;
    instance.lang = window.navigator?.language || 'en-GB';

    const isCurrent = () => recognition === instance && speechSessionId === sessionId;
    const markStarted = () => {
      if (!isCurrent() || speechState === 'stopping') return;
      if (speechStartTimer) clearTimeout(speechStartTimer);
      speechStartTimer = null;
      setDictationState('listening', 'Listening. Press Recording to stop and keep your final words.', 'listening');
    };

    instance.onstart = markStarted;
    instance.onaudiostart = markStarted;
    instance.onresult = (event) => {
      if (!isCurrent()) return;
      markStarted();
      const textarea = document.getElementById('vypodeReviewText');
      if (!textarea) return;
      const finalParts = [];
      const interimParts = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i]?.[0]?.transcript || '';
        if (event.results[i].isFinal) {
          if (!committedResultIndexes.has(i)) {
            committedResultIndexes.add(i);
            finalParts.push(transcript);
          }
        } else {
          interimParts.push(transcript);
        }
      }
      appendFinalTranscript(textarea, finalParts.join(' '));
      const interim = document.getElementById('vypodeInterim');
      if (interim) interim.textContent = interimParts.join(' ').trim();
    };
    instance.onnomatch = () => {
      if (isCurrent()) setSpeechStatus('That was not clear enough to transcribe. Keep speaking or try again.', 'warning');
    };
    instance.onerror = (event) => {
      if (!isCurrent()) return;
      const code = event?.error || 'unknown';
      if (code === 'aborted' && speechState === 'stopping') {
        finishDictationSession(
          instance,
          sessionId,
          'idle',
          'Dictation stopped before final words were confirmed. Check the review text before submitting.',
          'warning',
          { status: 'error' }
        );
        return;
      }
      if (code === 'service-not-allowed') {
        finishDictationSession(
          instance,
          sessionId,
          'unavailable',
          systemDictationHelp('The browser speech service is unavailable.'),
          'warning',
          { status: 'error' }
        );
        document.getElementById('vypodeReviewText')?.focus();
        return;
      }
      finishDictationSession(
        instance,
        sessionId,
        code === 'no-speech' ? 'idle' : 'error',
        speechErrorMessage(code),
        code === 'no-speech' ? 'warning' : 'error',
        { status: 'error' }
      );
    };
    instance.onend = () => {
      if (!isCurrent()) return;
      const stoppedByUser = speechState === 'stopping';
      finishDictationSession(
        instance,
        sessionId,
        'idle',
        stoppedByUser ? 'Dictation added to your review.' : 'Dictation finished. Press Dictate to continue.',
        'success',
        { status: 'complete' }
      );
    };

    return instance;
  }

  function focusSystemDictation(prefix) {
    const textarea = document.getElementById('vypodeReviewText');
    textarea?.focus();
    setDictationState('unavailable', systemDictationHelp(prefix || 'Browser dictation is unavailable.'), 'warning');
  }

  function startListening() {
    if (speechState === 'starting' || speechState === 'listening' || speechState === 'stopping') return;
    if (isBraveBrowser()) {
      focusSystemDictation('Brave browser dictation is unavailable.');
      return;
    }
    if (!getSpeechRecognitionCtor()) {
      focusSystemDictation();
      return;
    }

    const sessionId = ++speechSessionId;
    let instance = null;
    try {
      instance = initSpeechRecognition(sessionId);
    } catch {
      focusSystemDictation('This browser could not create a speech-recognition session.');
      return;
    }
    recognition = instance;
    if (!instance) {
      focusSystemDictation();
      return;
    }

    setDictationState('starting', 'Requesting microphone access...', 'requesting');
    speechStartTimer = setTimeout(() => {
      if (recognition !== instance || speechSessionId !== sessionId || speechState !== 'starting') return;
      speechSessionId++;
      recognition = null;
      clearSpeechTimers();
      try { instance.abort(); } catch {}
      settleSpeechStop({ status: 'error' });
      focusSystemDictation('Browser dictation did not start.');
    }, SPEECH_START_TIMEOUT_MS);

    try {
      instance.start();
    } catch {
      finishDictationSession(instance, sessionId, 'error', 'Could not start browser dictation. Press Dictate to try again.', 'error');
    }
  }

  function stopListening(options) {
    const cancel = Boolean(options?.cancel);
    const instance = recognition;

    if (cancel) {
      speechSessionId++;
      recognition = null;
      clearSpeechTimers();
      clearInterimTranscript();
      settleSpeechStop({ status: 'cancelled' });
      if (instance) {
        try { instance.abort(); } catch {}
      }
      setDictationState('idle', '');
      return Promise.resolve({ status: 'cancelled' });
    }

    if (!instance) return Promise.resolve({ status: 'idle' });
    if (speechState === 'stopping' && speechStopPromise) return speechStopPromise;
    const sessionId = speechSessionId;
    const stopPromise = new Promise(resolve => { resolveSpeechStop = resolve; });
    speechStopPromise = stopPromise;
    if (speechStartTimer) clearTimeout(speechStartTimer);
    speechStartTimer = null;
    setDictationState('stopping', 'Finishing the last dictated words...', 'requesting');

    speechStopTimer = setTimeout(() => {
      if (recognition !== instance || speechSessionId !== sessionId) return;
      speechSessionId++;
      recognition = null;
      clearSpeechTimers();
      clearInterimTranscript();
      try { instance.abort(); } catch {}
      settleSpeechStop({ status: 'timeout' });
      setDictationState('idle', 'Final dictated words could not be confirmed. Review the text, then press Submit again.', 'error');
    }, SPEECH_STOP_TIMEOUT_MS);

    try {
      instance.stop();
    } catch {
      speechSessionId++;
      recognition = null;
      clearSpeechTimers();
      try { instance.abort(); } catch {}
      settleSpeechStop({ status: 'error' });
      setDictationState('error', 'Could not finish dictation cleanly. Check the review text and try again.', 'error');
    }
    return stopPromise;
  }

  function toggleListening() {
    if (speechState === 'starting') {
      stopListening({ cancel: true });
    } else if (speechState === 'listening') {
      stopListening();
    } else if (speechState === 'stopping') {
      return;
    } else if (isBraveBrowser()) {
      focusSystemDictation('Brave browser dictation is unavailable.');
    } else if (!getSpeechRecognitionCtor() || speechState === 'unavailable') {
      focusSystemDictation();
    } else {
      startListening();
    }
  }

  function setRating(value) {
    // Toggle off if clicking the same rating again
    currentRating = (currentRating === value) ? 0 : value;
    if (currentRating < 0) currentRating = 0;
    updateRatingDisplay();
    scheduleActiveReviewDraftSave();
  }

  function updateRatingDisplay() {
    const starContainer = document.getElementById('vypodeStars');
    if (!starContainer) return;
    starContainer.querySelectorAll('.vypode-star').forEach(btn => {
      const value = Number(btn.dataset.rating);
      btn.classList.toggle('active', currentRating === value);
      btn.setAttribute('aria-checked', currentRating === value ? 'true' : 'false');
    });
    const ratingText = document.getElementById('vypodeRatingText');
    if (ratingText) {
      ratingText.textContent = currentRating > 0
        ? `${currentRating.toFixed(currentRating % 1 ? 1 : 0)} / 5 stars`
        : 'No rating';
    }
  }

  function ratingChoiceLabel(value) {
    if (value === 0.5) return '\u00bd';
    return value % 1 ? `${Math.floor(value)}\u00bd` : String(value);
  }

  function setReviewDraftStatus(message, tone) {
    const status = document.getElementById('vypodeDraftStatus');
    if (!status) return;
    status.textContent = message || '';
    status.className = `vypode-draft-status${tone ? ` ${tone}` : ''}`;
  }

  function reviewDraftFromPanel(context) {
    if (!context?.panel?.isConnected) throw new Error('Review editor is closed');
    return normalizeReviewDraft({
      reviewText: context.panel.querySelector('#vypodeReviewText')?.value || '',
      rating: currentRating,
      diaryDate: context.panel.querySelector('#vypodeDiaryDate')?.value || '',
      rewatch: Boolean(context.panel.querySelector('#vypodeRewatch')?.checked),
      spoilers: Boolean(context.panel.querySelector('#vypodeSpoilers')?.checked),
      likeMode: context.panel.querySelector('#vypodeReviewLike')?.value || 'preserve',
      tags: context.panel.querySelector('#vypodeReviewTags')?.value || '',
      revision: context.revision,
      updatedAt: new Date().toISOString()
    }, context.accountId, context.slug);
  }

  function applyReviewDraftToPanel(context, draft) {
    if (!context?.panel?.isConnected || !draft) return;
    const text = context.panel.querySelector('#vypodeReviewText');
    const date = context.panel.querySelector('#vypodeDiaryDate');
    const rewatch = context.panel.querySelector('#vypodeRewatch');
    const spoilers = context.panel.querySelector('#vypodeSpoilers');
    const like = context.panel.querySelector('#vypodeReviewLike');
    const tags = context.panel.querySelector('#vypodeReviewTags');
    if (text) text.value = draft.reviewText;
    if (date) date.value = draft.diaryDate;
    if (rewatch) rewatch.checked = draft.rewatch;
    if (spoilers) spoilers.checked = draft.spoilers;
    if (like) {
      const options = Array.from(like.options || []);
      const selectedIndex = options.findIndex(option => option.value === draft.likeMode);
      if (selectedIndex >= 0) {
        like.selectedIndex = selectedIndex;
        options.forEach((option, index) => {
          if (index === selectedIndex) option.setAttribute('selected', '');
          else option.removeAttribute('selected');
        });
      }
    }
    if (tags) tags.value = draft.tags.join(', ');
    currentRating = draft.rating;
    context.revision = Math.max(context.revision, draft.revision || 0);
    updateRatingDisplay();
  }

  async function persistActiveReviewDraft(context) {
    const active = context || reviewDraftContext;
    if (!active?.accountId || !active?.slug || !active.panel?.isConnected) return null;
    if (reviewDraftSaveTimer) clearTimeout(reviewDraftSaveTimer);
    reviewDraftSaveTimer = null;
    const revision = active.revision;
    let draft;
    try {
      draft = reviewDraftFromPanel(active);
    } catch (error) {
      if (reviewDraftContext === active) setReviewDraftStatus(error.message, 'error');
      throw error;
    }
    if (reviewDraftContext === active) setReviewDraftStatus('Saving draft\u2026');
    await saveReviewDraft(draft, active.generation);
    if (reviewDraftContext === active && active.revision === revision) {
      active.dirty = false;
      setReviewDraftStatus('Draft saved on this device', 'saved');
    }
    return draft;
  }

  function scheduleActiveReviewDraftSave() {
    const context = reviewDraftContext;
    if (!context?.panel?.isConnected) return;
    context.dirty = true;
    context.revision += 1;
    setReviewDraftStatus('Draft not saved yet');
    if (!context.accountId) {
      setReviewDraftStatus('Sign in so this draft can be tied to your account', 'warning');
      return;
    }
    if (reviewDraftSaveTimer) clearTimeout(reviewDraftSaveTimer);
    reviewDraftSaveTimer = setTimeout(() => {
      persistActiveReviewDraft(context).catch(error => {
        if (reviewDraftContext === context) setReviewDraftStatus(`Draft could not be saved: ${error.message}`, 'error');
      });
    }, 250);
  }

  function showReviewPanel() {
    if (reviewPanelVisible || settingsPanelVisible) return;
    document.querySelectorAll('.vypode-review-panel').forEach(existing => existing.remove());
    const film = isListingPage ? filmDeck[currentDeckIndex] : getFilmData();
    if (!film) {
      showFeedback('No current film to review', 'error');
      return;
    }
    reviewPanelVisible = true;
    reviewReturnFocus = document.activeElement;
    const safeTitle = escapeHtml(film.title);
    const storedFilm = window.VypodeFilmState?.get?.(film.slug);
    const existingLogKnown = Boolean(
      storedFilm?.watchedDate || storedFilm?.reviewText || storedFilm?.reviewUrl ||
      film.reviewText || film.reviewUrl
    );
    // This endpoint creates a new diary entry. Cached text/rating belongs to an
    // existing entry and must never be presented as if this form could edit it.
    currentRating = 0;
    const accountId = activeReviewAccountId();
    const today = localTodayString();
    const inactiveReviewNotice = !isLetterboxdSessionActive
      ? '<div class="vypode-review-notice vypode-review-warning">Log in to Letterboxd and refresh before submitting a review.</div>'
      : '';
    const existingLogNotice = existingLogKnown
      ? `<div class="vypode-review-notice vypode-review-warning" id="vypodeExistingLogNotice">This film already has diary or review data locally. This form cannot edit an existing Letterboxd entry. <a href="https://letterboxd.com/film/${escapeHtml(film.slug)}/" target="_blank" rel="noopener noreferrer">Open it on Letterboxd</a>, or tick “This was a rewatch” to deliberately log another viewing.</div>`
      : '';

    const panel = document.createElement('div');
    panel.className = 'vypode-review-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'vypodeReviewTitle');
    panel.innerHTML = `
      <div class="vypode-review-content" data-film-slug="${escapeHtml(film.slug)}">
        <div class="vypode-review-header">
          <h3 id="vypodeReviewTitle">Review: ${safeTitle}</h3>
          <button type="button" class="vypode-review-close" id="vypodeReviewClose" aria-label="Close review">\u2715</button>
        </div>
        <div class="vypode-rating-section">
          <div id="vypodeRatingLabel">Rating (optional):</div>
          <div class="vypode-stars" id="vypodeStars" role="radiogroup" aria-labelledby="vypodeRatingLabel">
            ${[0.5,1,1.5,2,2.5,3,3.5,4,4.5,5].map(value => `<button type="button" class="vypode-star" data-rating="${value}" role="radio" aria-checked="false" aria-label="${value} stars">${ratingChoiceLabel(value)}</button>`).join('')}
          </div>
          <span class="vypode-rating-text" id="vypodeRatingText">No rating</span>
        </div>
        <div class="vypode-review-options">
          <label class="vypode-review-field" for="vypodeDiaryDate">
            <span>Diary date</span>
            <input type="date" id="vypodeDiaryDate" value="${today}" max="${today}" required>
          </label>
          <label class="vypode-review-field" for="vypodeReviewLike">
            <span>Like</span>
            <select id="vypodeReviewLike">
              <option value="preserve">Keep current like state</option>
              <option value="like">Like this film</option>
              <option value="unlike">Do not like this film</option>
            </select>
          </label>
          <label class="vypode-review-check"><input type="checkbox" id="vypodeRewatch"> This was a rewatch</label>
          <label class="vypode-review-check"><input type="checkbox" id="vypodeSpoilers"> Contains spoilers</label>
          <label class="vypode-review-field vypode-review-tags" for="vypodeReviewTags">
            <span>Tags <small>(comma separated, up to ${MAX_REVIEW_TAGS})</small></span>
            <input type="text" id="vypodeReviewTags" maxlength="${MAX_REVIEW_TAGS * (MAX_REVIEW_TAG_LENGTH + 2)}" placeholder="cinema, family night">
          </label>
        </div>
        <div class="vypode-review-section">
          <label for="vypodeReviewText">Your review:</label>
          <div class="vypode-review-notice">Your draft stays on this device until Letterboxd confirms the entry.</div>
          ${inactiveReviewNotice}
          ${existingLogNotice}
          <div class="vypode-dictate-row">
            <button type="button" class="vypode-mic-btn" id="vypodeMicBtn" aria-pressed="false" aria-describedby="vypodeSpeechStatus" data-state="idle">Dictate</button>
            <span class="vypode-mic-hint">or just type below</span>
          </div>
          <div class="vypode-speech-status" id="vypodeSpeechStatus" role="status" aria-live="polite" aria-atomic="true"></div>
          <div class="vypode-interim" id="vypodeInterim" aria-hidden="true"></div>
          <textarea id="vypodeReviewText" maxlength="${MAX_REVIEW_TEXT_LENGTH}" placeholder="Write or dictate your review here..."></textarea>
          <div class="vypode-draft-status" id="vypodeDraftStatus" role="status" aria-live="polite"></div>
        </div>
        <div class="vypode-review-actions">
          <button class="vypode-btn vypode-btn-cancel" id="vypodeReviewCancel">Close</button>
          <button class="vypode-btn vypode-btn-submit" id="vypodeReviewSubmit" ${!isLetterboxdSessionActive ? 'disabled' : ''}>${isLetterboxdSessionActive ? 'Submit Review' : 'Log in to submit'}</button>
        </div>
        <div class="vypode-review-shortcuts">
          <span><b>1-5</b> full stars &bull; choose half stars above &bull; <b>Esc</b> close &bull; <b>Enter</b> submit</span>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    registerModalDialog(panel, () => hideReviewPanel(), reviewReturnFocus);
    const reviewTextarea = panel.querySelector('#vypodeReviewText');
    const context = {
      panel,
      film,
      slug: film.slug,
      accountId,
      generation: Number(window.VypodeFilmState?.getMeta?.().rootGeneration),
      dirty: false,
      revision: 0,
      invalidated: false,
      existingLogKnown,
      reviewRetryBlocked: false
    };
    reviewDraftContext = context;
    updateRatingDisplay();
    if (accountId) {
      sendReviewControlCommand('getUncertain', {
        accountId,
        generation: context.generation,
        slug: film.slug
      }).then(result => {
        if (result?.ok && result.blocked && reviewDraftContext === context && panel.isConnected) {
          lockReviewRetry(context, null, result.markerToken);
        }
      }).catch(() => {
        // Submission itself remains worker-gated if the status check cannot run.
      });
    }
    loadReviewDraft(accountId, film.slug, context.generation).then(draft => {
      if (!draft || reviewDraftContext !== context || context.dirty || !panel.isConnected) return;
      applyReviewDraftToPanel(context, draft);
      setReviewDraftStatus('Draft restored from this device', 'saved');
    }).catch(() => {
      if (reviewDraftContext === context) setReviewDraftStatus('Stored draft could not be read', 'error');
    });
    setTimeout(() => {
      if (!panel.isConnected || activeModalDialog()?.dialog !== panel) return;
      panel.classList.add('visible');
      reviewTextarea?.focus();
    }, 10);

    panel.querySelector('#vypodeReviewClose').addEventListener('click', hideReviewPanel);
    panel.querySelector('#vypodeReviewCancel').addEventListener('click', hideReviewPanel);
    panel.querySelector('#vypodeMicBtn').addEventListener('click', toggleListening);
    panel.querySelectorAll('#vypodeReviewText, #vypodeDiaryDate, #vypodeReviewLike, #vypodeReviewTags, #vypodeRewatch, #vypodeSpoilers')
      .forEach(control => {
        control.addEventListener('input', scheduleActiveReviewDraftSave);
        control.addEventListener('change', scheduleActiveReviewDraftSave);
      });
    if (isBraveBrowser()) {
      setDictationState('unavailable', systemDictationHelp('Brave browser dictation is unavailable.'), 'warning');
    } else if (getSpeechRecognitionCtor()) {
      setDictationState('idle', 'Press Dictate, then speak after the browser confirms it is recording.');
    } else {
      setDictationState('unavailable', systemDictationHelp('Browser dictation is unavailable.'), 'warning');
    }
    panel.querySelector('#vypodeReviewSubmit').addEventListener('click', async (event) => {
      const submitBtn = event.currentTarget;
      if (submitBtn.dataset.submitting === 'true') return;
      if (context.reviewRetryBlocked) {
        setReviewDraftStatus('Check Letterboxd and clear the uncertain submission lock before trying again.', 'error');
        return;
      }
      if (!reviewContextMatchesCurrentAccount(context)) {
        closeReviewForAccountChange(context);
        return;
      }
      if (context.existingLogKnown) {
        if (!panel.querySelector('#vypodeRewatch')?.checked) {
          setReviewDraftStatus('This would create another diary entry. To edit the existing entry, open Letterboxd. To log another viewing, tick “This was a rewatch”.', 'error');
          panel.querySelector('#vypodeRewatch')?.focus();
          return;
        }
        if (!window.confirm('This creates a new Letterboxd diary entry instead of editing the existing one. Log another viewing?')) return;
      }
      submitBtn.dataset.submitting = 'true';
      submitBtn.disabled = true;
      submitBtn.textContent = speechState === 'listening' || speechState === 'starting'
        ? 'Finishing dictation...'
        : 'Submitting...';
      const speechStopResult = await stopListening();
      if (!reviewPanelVisible || !document.body.contains(panel)) return;
      if (!reviewContextMatchesCurrentAccount(context)) {
        closeReviewForAccountChange(context);
        return;
      }
      if (speechStopResult?.status === 'timeout' || speechStopResult?.status === 'error') {
        submitBtn.dataset.submitting = 'false';
        submitBtn.disabled = !isLetterboxdSessionActive;
        submitBtn.textContent = isLetterboxdSessionActive ? 'Submit Review' : 'Log in to submit';
        setSpeechStatus(
          'Dictation did not finish cleanly. Review the text, then press Submit again.',
          'error'
        );
        document.getElementById('vypodeReviewText')?.focus();
        return;
      }
      const filmUrl = film?.url || window.location.href;
      submitBtn.textContent = 'Submitting...';
      let draft;
      try {
        draft = await persistActiveReviewDraft(context);
      } catch (error) {
        submitBtn.dataset.submitting = 'false';
        submitBtn.disabled = !isLetterboxdSessionActive;
        submitBtn.textContent = isLetterboxdSessionActive ? 'Submit Review' : 'Log in to submit';
        showFeedback(`Review not submitted: ${error.message}`, 'error');
        return;
      }
      if (!reviewContextMatchesCurrentAccount(context)) {
        closeReviewForAccountChange(context);
        return;
      }
      await submitReview(filmUrl, draft, context);
      if (reviewPanelVisible && document.body.contains(submitBtn)) {
        submitBtn.dataset.submitting = 'false';
        submitBtn.disabled = !isLetterboxdSessionActive;
        submitBtn.textContent = isLetterboxdSessionActive ? 'Submit Review' : 'Log in to submit';
      }
    });
    panel.querySelectorAll('.vypode-star').forEach(btn => {
      btn.addEventListener('click', () => setRating(Number(btn.dataset.rating)));
    });
  }

  function hideReviewPanel(options) {
    const context = reviewDraftContext;
    const shouldSaveDraft = options?.saveDraft !== false;
    if (reviewDraftSaveTimer) clearTimeout(reviewDraftSaveTimer);
    reviewDraftSaveTimer = null;
    if (shouldSaveDraft && context?.accountId && context.panel?.isConnected) {
      persistActiveReviewDraft(context).catch(() => {});
    }
    reviewDraftContext = null;
    reviewPanelVisible = false;
    stopListening({ cancel: true });
    const panel = document.querySelector('.vypode-review-panel');
    const modalEntry = releaseModalDialog(panel);
    reviewReturnFocus = null;
    if (panel) {
      panel.classList.remove('visible');
      if (options?.restoreFocus !== false) {
        focusAfterModalClose(modalEntry, '#vypodeOpenReview, .vypode-toggle-btn');
      }
      panel.setAttribute('aria-hidden', 'true');
      setTimeout(() => {
        panel.remove();
      }, 300);
    }
  }

  function isEditableElement(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    const contentEditable = el.getAttribute?.('contenteditable');
    if (contentEditable !== null && contentEditable !== undefined && contentEditable !== 'false') return true;
    if (el.closest?.('[contenteditable]:not([contenteditable="false"])')) return true;
    return false;
  }

  function isUserTyping(eventTarget) {
    return isEditableElement(eventTarget) || isEditableElement(document.activeElement);
  }

  const MODAL_FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable]:not([contenteditable="false"])'
  ].join(',');

  function isModalControlVisible(control, dialog) {
    if (control.getAttribute?.('tabindex') === '-1') return false;
    for (let current = control; current && current !== dialog; current = current.parentElement) {
      if (current.hidden || current.getAttribute?.('aria-hidden') === 'true' ||
          current.hasAttribute?.('inert') || current.style?.display === 'none' ||
          current.style?.visibility === 'hidden') return false;
    }
    return true;
  }

  function modalFocusableControls(dialog) {
    if (!dialog) return [];
    const controls = Array.from(dialog.querySelectorAll(MODAL_FOCUSABLE_SELECTOR))
      .filter(control => isModalControlVisible(control, dialog));
    // Keep Close as the final stop in the base Swipe dialog. It remains in the
    // header visually, while keyboard users get a predictable loop from Close
    // back to the first action and from the first action back to Close.
    if (dialog.classList?.contains('vypode-overlay')) {
      const closeIndex = controls.findIndex(control => control.id === 'vypodeClose');
      if (closeIndex >= 0) controls.push(...controls.splice(closeIndex, 1));
    }
    return controls;
  }

  function setModalLayerActive(dialog, active) {
    if (!dialog) return;
    dialog.setAttribute('aria-modal', active ? 'true' : 'false');
    if (active) {
      dialog.removeAttribute('aria-hidden');
      dialog.removeAttribute('inert');
    } else {
      dialog.setAttribute('aria-hidden', 'true');
      dialog.setAttribute('inert', '');
    }
  }

  function activeModalDialog() {
    let removedDisconnectedDialog = false;
    while (modalDialogStack.length && !modalDialogStack[modalDialogStack.length - 1].dialog?.isConnected) {
      modalDialogStack.pop();
      removedDisconnectedDialog = true;
    }
    const active = modalDialogStack[modalDialogStack.length - 1] || null;
    if (removedDisconnectedDialog && active) setModalLayerActive(active.dialog, true);
    return active;
  }

  function registerModalDialog(dialog, close, returnFocus) {
    const current = activeModalDialog();
    if (current) setModalLayerActive(current.dialog, false);
    const entry = { dialog, close, returnFocus };
    modalDialogStack.push(entry);
    setModalLayerActive(dialog, true);
    return entry;
  }

  function releaseModalDialog(dialog) {
    const index = modalDialogStack.findIndex(entry => entry.dialog === dialog);
    if (index < 0) return null;
    const wasActive = index === modalDialogStack.length - 1;
    const [entry] = modalDialogStack.splice(index, 1);
    dialog.setAttribute('aria-modal', 'false');
    dialog.setAttribute('inert', '');
    if (wasActive) {
      const next = activeModalDialog();
      if (next) setModalLayerActive(next.dialog, true);
    }
    return { ...entry, wasActive };
  }

  function focusAfterModalClose(entry, fallbackSelector) {
    if (!entry?.wasActive) return;
    const active = activeModalDialog();
    if (active) {
      if (active.dialog.contains(document.activeElement)) return;
      const returnedControl = entry.returnFocus;
      if (returnedControl?.isConnected && active.dialog.contains(returnedControl)) {
        returnedControl.focus?.();
        return;
      }
      const fallback = fallbackSelector ? active.dialog.querySelector(fallbackSelector) : null;
      (fallback || modalFocusableControls(active.dialog)[0] || active.dialog).focus?.();
      return;
    }
    const fallback = fallbackSelector ? document.querySelector(fallbackSelector) : null;
    const returnFocus = entry.returnFocus;
    const canRestorePrevious = returnFocus?.isConnected && returnFocus !== document.body &&
      returnFocus !== document.documentElement && !entry.dialog.contains(returnFocus);
    const target = canRestorePrevious ? returnFocus : fallback;
    target?.focus?.();
  }

  function containModalFocus(event, dialog) {
    const controls = modalFocusableControls(dialog);
    if (controls.length === 0) {
      event.preventDefault();
      if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
      dialog.focus?.();
      return;
    }
    const focused = document.activeElement;
    const currentIndex = controls.indexOf(focused);
    const nextIndex = currentIndex < 0
      ? (event.shiftKey ? controls.length - 1 : 0)
      : (currentIndex + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
    // Driving the whole sequence ourselves also lets the visually placed base
    // Close button be the logical final stop without positive tabindex values.
    event.preventDefault();
    controls[nextIndex].focus?.();
  }

  function handleModalKeyDown(event) {
    const active = activeModalDialog();
    if (!active) return false;
    // Leave browser and assistive-technology chords untouched, while keeping
    // them from falling through to deck shortcuts behind the active dialog.
    if (event.metaKey || event.ctrlKey || event.altKey) return true;
    if (event.key === 'Tab') {
      containModalFocus(event, active.dialog);
      return true;
    }
    if (event.key === 'Escape' && !event.shiftKey) {
      event.preventDefault();
      active.close?.();
      return true;
    }
    return false;
  }

  function handleModalKeyDownCapture(event) {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    handleModalKeyDown(event);
  }

  // Settings can be opened directly from the extension popup before the Swipe
  // overlay installs its deck shortcuts. Modal focus containment must therefore
  // live for the lifetime of the content script, independently of the overlay.
  document.addEventListener('keydown', handleModalKeyDownCapture, true);

  // ==================== SETTINGS PANEL ====================

  function showSettingsPanel() {
    if (settingsPanelVisible || reviewPanelVisible) return;
    document.querySelectorAll('.vypode-settings-panel').forEach(existing => existing.remove());
    settingsPanelVisible = true;
    settingsReturnFocus = document.activeElement;
    databaseVisibleLimit = DATABASE_PAGE_SIZE;
    databaseQuerySignature = '';

    const prefs = window.VypodeFilmState?.getPrefs() || {};
    const meta = window.VypodeFilmState?.getMeta() || {};
    const stats = window.VypodeFilmState?.getStats() || {};
    const lastSync = meta.lastSyncAt ? formatTimeAgo(meta.lastSyncAt) : 'Never';
    const safeUsername = letterboxdUsername ? escapeHtml(letterboxdUsername) : null;
    const accountHtml = isLetterboxdSessionActive && safeUsername
      ? `<div class="vypode-account-row">
          <span class="vypode-account-avatar">\ud83d\udc64</span>
          <span class="vypode-account-name">${safeUsername}</span>
          <span class="vypode-account-badge">Linked</span>
        </div>`
      : `<div class="vypode-account-row">
          <span class="vypode-account-warn">\u26a0\ufe0f Not logged in to Letterboxd</span>
        </div>
        <div class="vypode-settings-hint">Log in to Letterboxd and refresh before syncing, marking, liking, watchlisting, or submitting reviews.</div>`;

    const panel = document.createElement('div');
    panel.className = 'vypode-settings-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'vypodeSettingsTitle');
    panel.innerHTML = `
      <div class="vypode-settings-content">
        <div class="vypode-settings-header">
          <h3 id="vypodeSettingsTitle">Settings</h3>
          <button type="button" class="vypode-review-close" id="vypodeSettingsClose" aria-label="Close settings">\u2715</button>
        </div>

        <!-- Account Section -->
        <div class="vypode-settings-section">
          <div class="vypode-settings-section-title">Letterboxd Account</div>
          ${accountHtml}
        </div>

        <!-- Sync Section -->
        <div class="vypode-settings-section">
          <div class="vypode-settings-section-title">Collection Sync</div>
          <div class="vypode-sync-row">
            <span id="vypodeSyncStatus" class="vypode-sync-status" role="status" aria-live="polite">Last sync: ${escapeHtml(lastSync)}</span>
            <button type="button" class="vypode-sync-btn" id="vypodeSyncBtn" ${!isLetterboxdSessionActive ? 'disabled' : ''}>Sync now</button>
          </div>
          ${meta.syncCounts ? `<div class="vypode-sync-counts" id="vypodeSyncCounts">
            ${meta.syncCounts.watched || 0} watched &bull; ${meta.syncCounts.watchlist || 0} watchlist &bull; ${meta.syncCounts.liked || 0} liked
          </div>` : ''}
          <div class="vypode-settings-hint">${isLetterboxdSessionActive ? 'Builds a local-only database on this device with watched films, posters, ratings, likes, and review text where available.' : 'Log in to Letterboxd and refresh to sync your own profile database.'}</div>
        </div>

        <!-- Filter Section -->
        <div class="vypode-settings-section">
          <div class="vypode-settings-section-title">Deck Filters</div>
          <div class="vypode-settings-hint">Films matching these filters are hidden from the deck.</div>
          <label class="vypode-toggle-row">
            <span>Hide watched films</span>
            <input type="checkbox" class="vypode-toggle" data-pref="excludeWatched" ${prefs.excludeWatched !== false ? 'checked' : ''}>
            <span class="vypode-toggle-slider"></span>
          </label>
          <label class="vypode-toggle-row">
            <span>Hide liked films</span>
            <input type="checkbox" class="vypode-toggle" data-pref="excludeLiked" ${prefs.excludeLiked !== false ? 'checked' : ''}>
            <span class="vypode-toggle-slider"></span>
          </label>
          <label class="vypode-toggle-row">
            <span>Hide watchlist films</span>
            <input type="checkbox" class="vypode-toggle" data-pref="excludeWatchlist" ${prefs.excludeWatchlist !== false ? 'checked' : ''}>
            <span class="vypode-toggle-slider"></span>
          </label>
          <label class="vypode-toggle-row">
            <span>Hide skipped films</span>
            <input type="checkbox" class="vypode-toggle" data-pref="excludeSkipped" ${prefs.excludeSkipped !== false ? 'checked' : ''}>
            <span class="vypode-toggle-slider"></span>
          </label>
        </div>

        <!-- Deck Behaviour Section -->
        <div class="vypode-settings-section">
          <div class="vypode-settings-section-title">Deck Behaviour</div>
          <label class="vypode-toggle-row">
            <span>Open next Letterboxd page automatically</span>
            <input type="checkbox" class="vypode-toggle" data-pref="autoNextPage" ${prefs.autoNextPage === true ? 'checked' : ''}>
            <span class="vypode-toggle-slider"></span>
          </label>
          <div class="vypode-settings-hint">After the last card, follows Letterboxd's Next link in this tab and reopens Swipe Deck.</div>
        </div>

        <!-- Stats Section -->
        <div class="vypode-settings-section">
          <div class="vypode-settings-section-title">Your Film Registry</div>
          <div class="vypode-stats-grid">
            <div class="vypode-stat"><span class="vypode-stat-num vypode-stat-total">${stats.total || 0}</span><span class="vypode-stat-label">Total</span></div>
            <div class="vypode-stat"><span class="vypode-stat-num vypode-stat-watched">${stats.watched || 0}</span><span class="vypode-stat-label">Watched</span></div>
            <div class="vypode-stat"><span class="vypode-stat-num vypode-stat-liked">${stats.liked || 0}</span><span class="vypode-stat-label">Liked</span></div>
            <div class="vypode-stat"><span class="vypode-stat-num vypode-stat-watchlist">${stats.watchlist || 0}</span><span class="vypode-stat-label">Watchlist</span></div>
            <div class="vypode-stat"><span class="vypode-stat-num vypode-stat-skipped">${stats.skipped || 0}</span><span class="vypode-stat-label">Skipped</span></div>
            <div class="vypode-stat"><span class="vypode-stat-num vypode-stat-rated">${stats.rated || 0}</span><span class="vypode-stat-label">Rated</span></div>
            <div class="vypode-stat"><span class="vypode-stat-num vypode-stat-reviewed">${stats.reviewed || 0}</span><span class="vypode-stat-label">Reviewed</span></div>
          </div>
        </div>

        <!-- Database Section -->
        <div class="vypode-settings-section" id="vypodeDatabaseSection">
          <div class="vypode-settings-title-row">
            <div class="vypode-settings-section-title">Profile Database</div>
            <button type="button" class="vypode-skipped-manage-btn" id="vypodeManageSkipped" aria-controls="vypodeDbList" aria-label="Manage ${stats.skipped || 0} skipped films" ${stats.skipped ? '' : 'disabled'}>Skipped (${stats.skipped || 0})</button>
          </div>
          <div class="vypode-db-controls">
            <input type="search" id="vypodeDbSearch" aria-label="Search profile database" placeholder="Search title or review">
            <select id="vypodeDbFilter" aria-label="Filter profile database by status">
              <option value="all">All films</option>
              <option value="watched">Watched</option>
              <option value="liked">Liked</option>
              <option value="watchlist">Watchlist</option>
              <option value="rated">Rated</option>
              <option value="reviewed">Reviewed</option>
              <option value="missing-rating">Missing rating</option>
              <option value="skipped">Skipped</option>
            </select>
            <select id="vypodeDbGenreFilter" aria-label="Filter profile database by genre">
              <option value="all">All genres</option>
            </select>
            <select id="vypodeDbDateFilter" aria-label="Filter profile database by watch date">
              <option value="all">Any watch date</option>
              <option value="watched-with-date">Has watch date</option>
              <option value="watched-last-30">Last 30 days</option>
              <option value="watched-this-year">This year</option>
              <option value="missing-watched-date">Missing watch date</option>
            </select>
            <select id="vypodeDbSort" aria-label="Sort profile database">
              <option value="title">Title A-Z</option>
              <option value="rating">Rating high-low</option>
              <option value="watchedAt">Watch date newest</option>
              <option value="year">Year newest</option>
              <option value="updated">Recently updated</option>
            </select>
          </div>
          <div class="vypode-db-summary" id="vypodeDbSummary" aria-live="polite"></div>
          <div class="vypode-db-list" id="vypodeDbList" role="region" aria-label="Profile database films"></div>
          <div class="vypode-db-pagination" id="vypodeDbPagination"></div>
        </div>

        <!-- Data Section -->
        <div class="vypode-settings-section">
          <div class="vypode-settings-section-title">Data</div>
          <div class="vypode-data-actions">
            <button class="vypode-settings-btn vypode-btn-secondary" id="vypodeExport">Export data</button>
            <button class="vypode-settings-btn vypode-btn-secondary" id="vypodeExportCsv" title="Watched films as a CSV that letterboxd.com/import accepts">Export CSV (Letterboxd)</button>
            <button class="vypode-settings-btn vypode-btn-secondary" id="vypodeImport">Import data</button>
            <button class="vypode-settings-btn vypode-btn-danger" id="vypodeClearSkipped">Clear skipped</button>
            <button class="vypode-settings-btn vypode-btn-danger" id="vypodeClearAll">Clear local film data</button>
          </div>
          <input type="file" id="vypodeImportFile" accept=".json" style="display:none">
        </div>

        <div class="vypode-settings-footer">Swipe for Letterboxd v6.3.0-beta.5</div>
      </div>
    `;

    document.body.appendChild(panel);
    registerModalDialog(panel, () => hideSettingsPanel(), settingsReturnFocus);
    if (isSyncing) {
      updateSyncUI(syncAbortController?.signal.aborted ? 'cancelling' : 'syncing');
    } else if (syncRequiresRefresh) {
      updateSyncUI('account-changed');
    }
    setTimeout(() => {
      if (!panel.isConnected || activeModalDialog()?.dialog !== panel) return;
      panel.classList.add('visible');
      panel.querySelector('#vypodeSettingsClose')?.focus();
    }, 10);

    // Wire up event listeners
    document.getElementById('vypodeSettingsClose').addEventListener('click', hideSettingsPanel);
    document.getElementById('vypodeSyncBtn')?.addEventListener('click', () => runCollectionSync());

    // Filter toggles
    panel.querySelectorAll('.vypode-toggle').forEach(toggle => {
      toggle.addEventListener('change', async () => {
        const pref = toggle.dataset.pref;
        const desired = toggle.checked;
        const previous = window.VypodeFilmState?.getPrefs?.()[pref];
        toggle.disabled = true;
        try {
          const saved = await window.VypodeFilmState?.setPref(pref, desired);
          if (!saved) throw new Error('preference was rejected');
        } catch (error) {
          toggle.checked = Boolean(previous);
          showFeedback('Could not save preference: ' + error.message, 'error');
          toggle.disabled = false;
          return;
        }
        toggle.disabled = false;
        if (pref === 'autoNextPage' && !toggle.checked) {
          cancelPendingPageNavigation();
        }
        if (pref.startsWith('exclude') && isListingPage) {
          const currentSlug = filmDeck[currentDeckIndex]?.slug;
          // Re-filter from the accumulated master deck so films collected via
          // auto-paging survive a filter change (re-scraping the DOM would
          // throw away every page after the first).
          const source = masterDeck.length ? masterDeck : getFilmsFromListing();
          filmDeck = filterFilmDeck(source);
          if (filmDeck.length > 0) {
            const retainedIndex = filmDeck.findIndex(film => film.slug === currentSlug);
            currentDeckIndex = retainedIndex >= 0
              ? retainedIndex
              : Math.min(currentDeckIndex, filmDeck.length - 1);
            updateDeckCard();
          } else {
            currentDeckIndex = 0;
            renderEmptyDeckState('No films match the current filters');
            showFeedback('Current page has no films matching these filters', 'watchlist');
          }
        }
      });
    });

    bindDatabaseControls();
    renderDatabaseBrowser();

    // Jump straight to a compact, actionable view of the skipped films. This
    // keeps Clear skipped as a bulk escape hatch while making the usual task —
    // restoring one accidental skip — safe and easy to find.
    document.getElementById('vypodeManageSkipped')?.addEventListener('click', () => {
      const search = document.getElementById('vypodeDbSearch');
      if (search) search.value = '';
      setDatabaseControlValue('vypodeDbFilter', 'skipped');
      setDatabaseControlValue('vypodeDbGenreFilter', 'all');
      setDatabaseControlValue('vypodeDbDateFilter', 'all');
      renderDatabaseBrowser();
      document.getElementById('vypodeDatabaseSection')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      const firstAction = document.querySelector('#vypodeDbList .vypode-db-restore') ||
        document.querySelector('#vypodeDbList .vypode-db-row') ||
        document.getElementById('vypodeDbSearch');
      firstAction?.focus?.();
    });

    // Export
    document.getElementById('vypodeExport').addEventListener('click', () => {
      try {
        const data = window.VypodeFilmState.exportData();
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `vypode-export-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        // Keep the blob alive long enough for Chromium/Brave to hand it to the
        // download service after the synthetic click task has completed.
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        showFeedback('Data exported', 'watchlist');
      } catch (error) {
        showFeedback('Export failed: ' + error.message, 'error');
      }
    });

    // Export CSV in Letterboxd's import format (watched films only)
    document.getElementById('vypodeExportCsv').addEventListener('click', () => {
      try {
        const csv = window.VypodeFilmState.exportLetterboxdCsv();
        const rowCount = csv.split('\r\n').length - 1;
        if (rowCount === 0) {
          showFeedback('No watched films to export yet — run Collection Sync first', 'error');
          return;
        }
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `letterboxd-import-${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        showFeedback(`Exported ${rowCount} watched films as CSV`, 'watchlist');
      } catch (error) {
        showFeedback('CSV export failed: ' + error.message, 'error');
      }
    });

    // Import
    document.getElementById('vypodeImport').addEventListener('click', () => {
      document.getElementById('vypodeImportFile').click();
    });
    document.getElementById('vypodeImportFile').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const importLimit = Number(window.VypodeFilmState?.getLimits?.().importBytes) || 64 * 1024 * 1024;
      if (Number(file.size) > importLimit) {
        e.target.value = '';
        showFeedback(`Import failed: file exceeds the ${Math.round(importLimit / 1024 / 1024)} MB limit`, 'error');
        return;
      }
      const importContext = {
        accountId: window.VypodeFilmState?.getAccountId?.(),
        generation: Number(window.VypodeFilmState?.getMeta?.().rootGeneration)
      };
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const result = await window.VypodeFilmState.importData(reader.result, importContext);
          if (result.success) {
            refreshSettingsStats();
            showFeedback(`Imported ${result.merged} film entries`, 'watchlist');
          } else {
            showFeedback('Import failed: ' + result.error, 'error');
          }
        } catch (error) {
          showFeedback('Import failed: ' + error.message, 'error');
        } finally {
          e.target.value = '';
        }
      };
      reader.onerror = () => {
        e.target.value = '';
        showFeedback('Import failed: could not read file', 'error');
      };
      reader.readAsText(file);
    });

    // Clear skipped
    document.getElementById('vypodeClearSkipped').addEventListener('click', () => {
      if (confirm('Clear all skipped films? They will appear in your deck again.')) {
        window.VypodeFilmState.clearSkipped()
          .then(cleared => {
            if (!cleared) {
              showFeedback('Skipped films changed in another tab — list refreshed', 'watchlist');
              refreshSettingsStats();
              return;
            }
            refreshDeckAfterSkipRestore(null);
            refreshSettingsStats();
            showFeedback('Skipped films cleared', 'watchlist');
          })
          .catch(error => showFeedback('Could not clear skipped films: ' + error.message, 'error'));
      }
    });

    // Clear all
    document.getElementById('vypodeClearAll').addEventListener('click', async () => {
      const sentCount = [...actionQueue, activeQueueItem].filter(Boolean).filter(item => item.dispatched).length +
        (activeSingleFilmAction?.dispatched ? 1 : 0);
      const sentWarning = sentCount > 0
        ? `\n\n${sentCount} action${sentCount === 1 ? ' has' : 's have'} already been sent to Letterboxd and cannot be recalled. Local verification will stop.`
        : '';
      const actionWarning = '\n\nAlready-sent Letterboxd actions from this or another signed-in account may still complete. Swipe keeps their minimal verification records so a toggle cannot be sent twice.';
      const reviewWarning = '\n\nA review already sent to Letterboxd may still complete. Swipe keeps only a minimal account/film safety lock for any such review so it cannot be submitted twice.';
      if (!confirm(
        'Delete local Swipe film data on this device? This clears the film registry, saved account selection, unsent action recovery, review drafts, and sync history. Chrome-synced interface preferences are kept. This cannot be undone.' +
        sentWarning + actionWarning + reviewWarning
      )) return;
      const clearButton = document.getElementById('vypodeClearAll');
      if (clearButton) clearButton.disabled = true;
      try {
        const dispatched = await invalidateActionQueueForClear();
        const cleared = await window.VypodeFilmState.clearAll();
        if (!cleared) throw new Error('another tab changed the data first');
        const clearResult = window.VypodeFilmState?.getLastClearResult?.() || {};
        const dispatchedActions = Math.max(dispatched, Number(clearResult.dispatchedActions) || 0);
        const dispatchedReviews = Number(clearResult.dispatchedReviews) || 0;
        actionQueueSuspended = false;
        refreshSettingsStats();
        const remoteWarnings = [];
        if (dispatchedActions > 0) {
          remoteWarnings.push(`${dispatchedActions} already-sent Letterboxd action${dispatchedActions === 1 ? '' : 's'} remain verification-only`);
        }
        if (dispatchedReviews > 0) {
          remoteWarnings.push(`${dispatchedReviews} already-sent review${dispatchedReviews === 1 ? '' : 's'} remain locked until you check Letterboxd`);
        }
        showFeedback(
          remoteWarnings.length > 0
            ? `Local film data cleared; ${remoteWarnings.join('; ')}`
            : 'Local film data cleared; Chrome-synced interface preferences were kept',
          remoteWarnings.length > 0 ? 'error' : 'watch'
        );
      } catch (error) {
        showFeedback('Could not clear all local data: ' + error.message, 'error');
      } finally {
        if (clearButton?.isConnected) clearButton.disabled = false;
      }
    });
  }

  function hideSettingsPanel(options) {
    document.querySelectorAll('.vypode-db-detail').forEach(detail => {
      closeDatabaseDetail(detail, { restoreFocus: false });
    });
    settingsPanelVisible = false;
    const panel = document.querySelector('.vypode-settings-panel');
    const modalEntry = releaseModalDialog(panel);
    settingsReturnFocus = null;
    if (panel) {
      panel.classList.remove('visible');
      if (options?.restoreFocus !== false) {
        focusAfterModalClose(modalEntry, '#vypodeOpenSettings, .vypode-toggle-btn');
      }
      panel.setAttribute('aria-hidden', 'true');
      setTimeout(() => {
        panel.remove();
      }, 300);
    }
  }

  function refreshSettingsStats() {
    const stats = window.VypodeFilmState?.getStats?.();
    if (!stats) return;

    const pairs = [
      ['.vypode-stat-total', stats.total],
      ['.vypode-stat-watched', stats.watched],
      ['.vypode-stat-liked', stats.liked],
      ['.vypode-stat-watchlist', stats.watchlist],
      ['.vypode-stat-skipped', stats.skipped],
      ['.vypode-stat-rated', stats.rated],
      ['.vypode-stat-reviewed', stats.reviewed]
    ];
    for (const [selector, value] of pairs) {
      const el = document.querySelector(selector);
      if (el) el.textContent = value || 0;
    }
    const manageSkipped = document.getElementById('vypodeManageSkipped');
    if (manageSkipped) {
      const count = stats.skipped || 0;
      manageSkipped.textContent = `Skipped (${count})`;
      manageSkipped.disabled = count === 0;
      manageSkipped.setAttribute('aria-label', `Manage ${count} skipped ${count === 1 ? 'film' : 'films'}`);
    }
    const meta = window.VypodeFilmState?.getMeta?.();
    const syncRow = document.querySelector('.vypode-sync-row');
    let syncCounts = document.getElementById('vypodeSyncCounts');
    if (meta?.syncCounts && syncRow) {
      if (!syncCounts) {
        syncCounts = document.createElement('div');
        syncCounts.id = 'vypodeSyncCounts';
        syncCounts.className = 'vypode-sync-counts';
        syncRow.insertAdjacentElement('afterend', syncCounts);
      }
      syncCounts.textContent = `${meta.syncCounts.watched || 0} watched • ${meta.syncCounts.watchlist || 0} watchlist • ${meta.syncCounts.liked || 0} liked`;
    }
    renderDatabaseBrowser();
  }

  function bindDatabaseControls() {
    for (const id of ['vypodeDbSearch', 'vypodeDbFilter', 'vypodeDbGenreFilter', 'vypodeDbDateFilter', 'vypodeDbSort']) {
      document.getElementById(id)?.addEventListener('input', renderDatabaseBrowser);
      document.getElementById(id)?.addEventListener('change', renderDatabaseBrowser);
    }
  }

  function controlValue(id, fallback) {
    const el = document.getElementById(id);
    if (!el) return fallback;
    const options = Array.from(el.options || []);
    const selected = options.find(option => option.selected);
    return el.value || selected?.value || options[el.selectedIndex]?.value || fallback;
  }

  function setDatabaseControlValue(id, value) {
    const select = document.getElementById(id);
    if (!select) return;
    const options = Array.from(select.options || []);
    const next = options.find(option => option.value === value);
    if (!next) return;
    select.selectedIndex = options.indexOf(next);
    options.forEach(option => {
      option.selected = option === next;
      if (option === next) option.setAttribute('selected', '');
      else option.removeAttribute('selected');
    });
  }

  function databaseOptions() {
    return {
      search: document.getElementById('vypodeDbSearch')?.value || '',
      filter: controlValue('vypodeDbFilter', 'all'),
      genre: controlValue('vypodeDbGenreFilter', 'all'),
      dateFilter: controlValue('vypodeDbDateFilter', 'all'),
      sort: controlValue('vypodeDbSort', 'title')
    };
  }

  function renderGenreOptions() {
    const select = document.getElementById('vypodeDbGenreFilter');
    if (!select || !window.VypodeFilmState?.getGenres) return;
    const current = select.value || 'all';
    const genres = window.VypodeFilmState.getGenres();
    select.innerHTML = '<option value="all">All genres</option>' + genres.map(genre => {
      const safe = escapeHtml(genre);
      return `<option value="${safe}">${safe}</option>`;
    }).join('');
    const nextValue = genres.includes(current) ? current : 'all';
    Array.from(select.options).forEach(option => {
      option.selected = option.value === nextValue;
    });
  }

  function formatStoredDate(isoString) {
    if (!isoString) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(isoString)) return isoString;
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
  }

  function renderDatabaseBrowser() {
    const list = document.getElementById('vypodeDbList');
    const summary = document.getElementById('vypodeDbSummary');
    const pagination = document.getElementById('vypodeDbPagination');
    if (!list || !summary || !pagination || !window.VypodeFilmState?.query) return;

    renderGenreOptions();
    const options = databaseOptions();
    const renderedAccountId = window.VypodeFilmState.getAccountId?.() || '';
    const nextSignature = JSON.stringify([
      renderedAccountId,
      options.search,
      options.filter,
      options.genre,
      options.dateFilter,
      options.sort
    ]);
    if (nextSignature !== databaseQuerySignature) {
      databaseQuerySignature = nextSignature;
      databaseVisibleLimit = DATABASE_PAGE_SIZE;
    }
    const rows = window.VypodeFilmState.query(options);
    const visible = rows.slice(0, databaseVisibleLimit);
    const remaining = Math.max(0, rows.length - visible.length);
    const displayedTotal = Number.parseInt(document.querySelector('.vypode-stat-total')?.textContent || '', 10);
    const totalFilms = Number.isFinite(displayedTotal) ? displayedTotal : rows.length;
    const filtersActive = Boolean(options.search.trim()) || options.filter !== 'all' ||
      options.genre !== 'all' || options.dateFilter !== 'all';
    summary.textContent = rows.length
      ? filtersActive
        ? `Showing ${visible.length} of ${rows.length} matching films (${totalFilms} total)`
        : `Showing ${visible.length} of ${rows.length} films`
      : options.filter === 'skipped'
        ? 'No skipped films. Restored films can appear in the Swipe deck again.'
        : totalFilms > 0
          ? `No films match the current filters (${totalFilms} total)`
          : 'No films yet. Run Collection Sync to build your local profile database.';

    list.innerHTML = visible.map((film, index) => {
      const title = escapeHtml(film.title || film.slug);
      const year = film.year ? ` <span>${escapeHtml(film.year)}</span>` : '';
      const rating = film.ratingValue ? `${film.ratingValue}/5` : (film.rating ? escapeHtml(film.rating) : 'No rating');
      const watchedDate = formatStoredDate(film.watchedDate);
      const genres = Array.isArray(film.genres) && film.genres.length
        ? ` • ${escapeHtml(film.genres.slice(0, 2).join(', '))}`
        : '';
      const badges = [
        film.watched ? 'Watched' : null,
        film.liked ? 'Liked' : null,
        film.watchlist ? 'Watchlist' : null,
        film.reviewText ? 'Review' : null,
        film.skipped ? 'Skipped' : null
      ].filter(Boolean).map(label => `<span>${label}</span>`).join('');
      const poster = film.poster
        ? `<img src="${escapeHtml(film.poster)}" alt="">`
        : '<div class="vypode-db-poster-empty"></div>';
      return `
        <div class="vypode-db-row-shell">
          <button type="button" class="vypode-db-row" data-slug="${escapeHtml(film.slug)}" data-result-index="${index}" aria-label="View details for ${title}">
            ${poster}
            <span class="vypode-db-main">
              <strong>${title}${year}</strong>
              <small>${escapeHtml(rating)}${watchedDate ? ` • Watched ${escapeHtml(watchedDate)}` : ''}${genres}</small>
              <span class="vypode-db-badges">${badges}</span>
            </span>
          </button>
          ${film.skipped ? `<button type="button" class="vypode-db-restore" data-slug="${escapeHtml(film.slug)}" data-account-id="${escapeHtml(renderedAccountId)}" aria-label="Restore ${title} to the Swipe deck">Restore</button>` : ''}
        </div>
      `;
    }).join('');

    pagination.innerHTML = remaining > 0
      ? `<button type="button" class="vypode-db-load-more" id="vypodeDbLoadMore" aria-controls="vypodeDbList" aria-describedby="vypodeDbSummary">Load ${Math.min(DATABASE_PAGE_SIZE, remaining)} more <span>(${remaining} remaining)</span></button>`
      : '';

    list.querySelectorAll('img').forEach(attachPosterFallback);
    list.querySelectorAll('.vypode-db-row').forEach(row => {
      row.addEventListener('click', () => showDatabaseDetail(row.dataset.slug, row));
    });
    list.querySelectorAll('.vypode-db-restore').forEach(button => {
      button.addEventListener('click', () => restoreSkippedFilm(button.dataset.slug, button, null, button.dataset.accountId));
    });
    pagination.querySelector('#vypodeDbLoadMore')?.addEventListener('click', () => {
      const firstNewIndex = visible.length;
      databaseVisibleLimit += DATABASE_PAGE_SIZE;
      renderDatabaseBrowser();
      document.querySelector(`#vypodeDbList .vypode-db-row[data-result-index="${firstNewIndex}"]`)?.focus?.();
    });
  }

  function refreshDeckAfterSkipRestore(slug) {
    if (!vypodeVisible || !isListingPage) return;
    const currentSlug = filmDeck[currentDeckIndex]?.slug;
    const source = masterDeck.length ? masterDeck : getFilmsFromListing();
    const restoredFilm = source.find(film => film.slug === slug);
    if (restoredFilm) restoredFilm.actioned = false;
    filmDeck = filterFilmDeck(source);
    if (filmDeck.length === 0) {
      currentDeckIndex = 0;
      renderEmptyDeckState('No films match the current filters');
      return;
    }
    const targetSlug = currentSlug && filmDeck.some(film => film.slug === currentSlug)
      ? currentSlug
      : slug;
    const targetIndex = filmDeck.findIndex(film => film.slug === targetSlug);
    currentDeckIndex = targetIndex >= 0 ? targetIndex : Math.min(currentDeckIndex, filmDeck.length - 1);
    updateDeckCard();
  }

  function deckStateRefilterIsBusy() {
    return isProcessingAction || isProcessingQueue || Boolean(activeQueueItem) ||
      actionQueue.length > 0 || Boolean(actionQueueRetryTimer);
  }

  function drainPendingDeckStateRefilter() {
    if (pendingDeckStateRefilterTimer) {
      clearTimeout(pendingDeckStateRefilterTimer);
      pendingDeckStateRefilterTimer = null;
    }
    if (!pendingDeckStateRefilter) return;
    if (!vypodeVisible || !isListingPage) {
      pendingDeckStateRefilter = false;
      return;
    }
    if (deckStateRefilterIsBusy()) {
      pendingDeckStateRefilterTimer = setTimeout(drainPendingDeckStateRefilter, 50);
      return;
    }
    pendingDeckStateRefilter = false;
    refreshDeckAfterSkipRestore(null);
  }

  function queueDeckStateRefilter() {
    if (!vypodeVisible || !isListingPage) return;
    pendingDeckStateRefilter = true;
    drainPendingDeckStateRefilter();
  }

  async function restoreSkippedFilm(slug, trigger, detail, expectedAccountId) {
    if (!slug || !window.VypodeFilmState?.restoreSkipped) return;
    const boundAccountId = expectedAccountId || detail?.dataset.accountId || trigger?.dataset.accountId;
    if (!boundAccountId || window.VypodeFilmState.getAccountId?.() !== boundAccountId) {
      closeDatabaseDetail(detail, { restoreFocus: false });
      refreshSettingsStats();
      showFeedback('Letterboxd account changed — choose the film again', 'error');
      document.getElementById('vypodeDbSearch')?.focus?.();
      return;
    }
    const previousLabel = trigger?.textContent;
    if (trigger) {
      trigger.disabled = true;
      trigger.textContent = 'Restoring…';
    }
    try {
      const restored = await window.VypodeFilmState.restoreSkipped(slug, boundAccountId);
      if (window.VypodeFilmState.getAccountId?.() !== boundAccountId) {
        closeDatabaseDetail(detail, { restoreFocus: false });
        refreshSettingsStats();
        showFeedback('Letterboxd account changed while restoring the film', 'error');
        document.getElementById('vypodeDbSearch')?.focus?.();
        return;
      }
      if (!restored) {
        showFeedback('This film is no longer skipped', 'watchlist');
        refreshSettingsStats();
        return;
      }
      closeDatabaseDetail(detail, { restoreFocus: false });
      refreshDeckAfterSkipRestore(slug);
      refreshSettingsStats();
      showFeedback('Film restored to the Swipe deck', 'watchlist');
      const nextAction = document.querySelector('#vypodeDbList .vypode-db-restore') ||
        document.getElementById('vypodeManageSkipped') ||
        document.getElementById('vypodeDbSearch');
      if (!nextAction?.disabled) nextAction?.focus?.();
      else document.getElementById('vypodeDbSearch')?.focus?.();
    } catch (error) {
      showFeedback('Could not restore film: ' + error.message, 'error');
    } finally {
      if (trigger?.isConnected) {
        trigger.disabled = false;
        trigger.textContent = previousLabel || 'Restore';
      }
    }
  }

  function closeDatabaseDetail(detail, options) {
    if (!detail) return;
    const modalEntry = releaseModalDialog(detail);
    detail.remove();
    if (options?.restoreFocus !== false) {
      focusAfterModalClose(modalEntry, options?.fallbackSelector || '#vypodeDbSearch');
    }
  }

  function showDatabaseDetail(slug, returnFocus) {
    const film = window.VypodeFilmState?.get?.(slug);
    if (!film) return;
    const expectedAccountId = window.VypodeFilmState?.getAccountId?.();
    if (!expectedAccountId) return;
    const existing = document.querySelector('.vypode-db-detail');
    if (existing) closeDatabaseDetail(existing, { restoreFocus: false });

    const detail = document.createElement('div');
    detail.className = 'vypode-db-detail';
    detail.dataset.slug = slug;
    detail.dataset.accountId = expectedAccountId;
    detail.setAttribute('role', 'dialog');
    detail.setAttribute('aria-modal', 'true');
    detail.setAttribute('aria-labelledby', 'vypodeDbDetailTitle');
    detail.innerHTML = `
      <button type="button" class="vypode-db-detail-close" aria-label="Close film details">\u2715</button>
      <div class="vypode-db-detail-body">
        ${film.poster ? `<img src="${escapeHtml(film.poster)}" alt="">` : ''}
        <div>
          <h4 id="vypodeDbDetailTitle">${escapeHtml(film.title || slug)}${film.year ? ` <span>${escapeHtml(film.year)}</span>` : ''}</h4>
          <p>${film.ratingValue ? `Your rating: ${film.ratingValue}/5` : 'No rating stored'}</p>
          ${film.director ? `<p>Director: ${escapeHtml(film.director)}</p>` : ''}
          ${Array.isArray(film.genres) && film.genres.length ? `<p>Genres: ${escapeHtml(film.genres.join(', '))}</p>` : ''}
          ${formatStoredDate(film.watchedDate) ? `<p>Watched date: ${escapeHtml(formatStoredDate(film.watchedDate))}</p>` : ''}
          <p>${film.liked ? 'Liked' : 'Not liked'} &bull; ${film.watched ? 'Watched' : 'Not watched'}</p>
          <p class="vypode-db-detail-skip-status">${film.skipped ? 'Skipped from the Swipe deck' : 'Available in the Swipe deck'}</p>
          ${film.reviewText ? `<blockquote>${escapeHtml(film.reviewText)}</blockquote>` : '<p>No review text stored.</p>'}
          ${film.url ? `<a href="${escapeHtml(film.url)}" target="_blank" rel="noopener noreferrer">Open film page</a>` : ''}
          ${film.skipped ? `<button type="button" class="vypode-settings-btn vypode-db-restore-detail" data-slug="${escapeHtml(slug)}">Restore to Swipe deck</button>` : ''}
        </div>
      </div>
    `;
    document.body.appendChild(detail);
    const closeDetail = () => closeDatabaseDetail(detail);
    detail.querySelector('.vypode-db-detail-close')?.focus?.();
    registerModalDialog(detail, closeDetail, returnFocus);
    detail.querySelectorAll('img').forEach(attachPosterFallback);
    detail.querySelector('.vypode-db-detail-close').addEventListener('click', closeDetail);
    const restore = detail.querySelector('.vypode-db-restore-detail');
    restore?.addEventListener('click', () => restoreSkippedFilm(slug, restore, detail, expectedAccountId));
  }

  function refreshOpenDatabaseDetail() {
    const detail = document.querySelector('.vypode-db-detail');
    if (!detail?.dataset.slug) return;
    if (detail.dataset.accountId !== window.VypodeFilmState?.getAccountId?.()) {
      closeDatabaseDetail(detail, { fallbackSelector: '#vypodeDbSearch' });
      return;
    }
    const film = window.VypodeFilmState?.get?.(detail.dataset.slug);
    if (!film) {
      closeDatabaseDetail(detail, { fallbackSelector: '#vypodeDbSearch' });
      return;
    }
    const status = detail.querySelector('.vypode-db-detail-skip-status');
    if (status) status.textContent = film.skipped
      ? 'Skipped from the Swipe deck'
      : 'Available in the Swipe deck';
    if (!film.skipped) detail.querySelector('.vypode-db-restore-detail')?.remove();
  }

  // ==================== UI CREATION ====================

  function createVypodeUI() {
    const film = getFilmData();
    const states = getStates();
    createVypodeOverlay(film, states, false);
  }

  async function createVypodeDeckUI(options) {
    if (isOpeningDeck) return false;
    cancelDeckRun();
    const runGeneration = deckRunGeneration;
    const controller = new AbortController();
    deckRunAbortController = controller;
    isOpeningDeck = true;
    const toggle = document.querySelector('.vypode-toggle-btn');
    if (toggle) toggle.disabled = true;
    const autoResumeHop = Number.isInteger(options?.autoResumeHop)
      ? Math.max(0, Math.min(options.autoResumeHop, MAX_AUTO_RESUME_PAGES))
      : null;
    try {
      cancelPendingPageNavigation();
      currentNextPageUrl = null;
      isLoadingMore = false;
      inPlacePageHops = 0;
      visitedInPlacePages.clear();
      let allFilms = getFilmsFromListing();
      if (allFilms.length === 0) {
        // Listing grids are often AJAX-loaded after our button appears — wait
        // briefly for the films to arrive instead of dead-ending the click.
        showFeedback('Waiting for films to load...', 'watch');
        const deadline = Date.now() + 8000;
        while (allFilms.length === 0 && Date.now() < deadline) {
          await sleep(500, controller.signal);
          if (controller.signal.aborted || runGeneration !== deckRunGeneration) return false;
          allFilms = getFilmsFromListing();
        }
      }
      if (controller.signal.aborted || runGeneration !== deckRunGeneration) return false;
      if (allFilms.length === 0) {
        showFeedback('No films found yet — wait for the page to finish loading, then try again', 'error');
        return false;
      }

      // Apply fresh poster filtering
      masterDeck = allFilms;
      filmDeck = filterFilmDeck(allFilms);

      if (filmDeck.length === 0) {
        const nextUrl = getNextPageUrl();
        if (autoResumeHop !== null && isAutoNextPageEnabled() && nextUrl && autoResumeHop < MAX_AUTO_RESUME_PAGES) {
          showFeedback('This page is fully filtered — opening the next page...', 'watch');
          navigateToNextPage(nextUrl, { resumeHop: autoResumeHop + 1 });
          return true;
        }
        const emptyMessage = autoResumeHop === MAX_AUTO_RESUME_PAGES && nextUrl
          ? `Stopped after ${MAX_AUTO_RESUME_PAGES} automatic page jumps — press Next to continue`
          : `All ${allFilms.length} films on this page are hidden by your filters`;
        currentDeckIndex = 0;
        createVypodeOverlay({
          title: emptyMessage,
          year: '',
          rating: '',
          director: '',
          poster: '',
          url: '',
          slug: '',
          genres: [],
          hasTrailer: false
        }, { isWatched: false, isLiked: false, inWatchlist: false }, true);
        renderEmptyDeckState(emptyMessage);
        const reviewButton = document.getElementById('vypodeOpenReview');
        if (reviewButton) {
          reviewButton.disabled = true;
          reviewButton.title = 'Choose a film before writing a review';
        }
        showFeedback(emptyMessage, 'watchlist');
        return true;
      }

      if (controller.signal.aborted || runGeneration !== deckRunGeneration) return false;
      currentDeckIndex = 0;
      const film = filmDeck[0];
      createVypodeOverlay(
        film,
        { isWatched: film.isWatched, isLiked: film.isLiked, inWatchlist: film.inWatchlist },
        true
      );
      // Lazy-fetch film details for the first two cards
      enrichFilmData(film);
      enrichFilmData(filmDeck[1]);
      return true;
    } catch (error) {
      if (controller.signal.aborted || runGeneration !== deckRunGeneration || error?.name === 'AbortError') return false;
      throw error;
    } finally {
      if (runGeneration === deckRunGeneration) {
        isOpeningDeck = false;
        if (toggle) toggle.disabled = false;
      }
    }
  }

  function updateTrailerControl(film) {
    const link = document.getElementById('vypodeTrailerLink');
    if (!link) return;
    const trailerUrl = getTrailerPageUrl(film);
    const unavailable = !trailerUrl || film?.hasTrailer === false;
    link.classList.toggle('unavailable', unavailable);
    link.setAttribute('aria-disabled', unavailable ? 'true' : 'false');
    link.setAttribute('tabindex', '0');
    if (unavailable) {
      link.removeAttribute('href');
      link.textContent = film?.hasTrailer === false ? 'No trailer listed' : 'Trailer unavailable';
      link.title = film?.hasTrailer === false
        ? 'Letterboxd does not list a trailer for this film'
        : 'This film does not have a valid Letterboxd trailer address';
    } else {
      link.href = trailerUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Trailer \u2197';
      link.title = film?.hasTrailer === true ? 'Open trailer (T)' : 'Open trailer on Letterboxd (T)';
    }
  }

  function openCurrentTrailer() {
    if (!isListingPage) return false;
    const film = filmDeck[currentDeckIndex];
    const trailerUrl = getTrailerPageUrl(film);
    if (!trailerUrl || film?.hasTrailer === false) {
      showFeedback(
        film?.hasTrailer === false ? 'No trailer is listed for this film' : 'Trailer unavailable for this card',
        'error'
      );
      return false;
    }
    const link = document.getElementById('vypodeTrailerLink');
    if (!link) return false;
    if (link.href !== trailerUrl) updateTrailerControl(film);
    link.click();
    return true;
  }

  function createVypodeOverlay(film, states, isDeck) {
    const existing = document.querySelector('.vypode-overlay');
    const existingModalEntry = existing ? releaseModalDialog(existing) : null;
    if (existing) existing.remove();
    const focusedBeforeOpen = existingModalEntry?.returnFocus || document.activeElement;
    overlayReturnFocus = focusedBeforeOpen?.isConnected
      ? focusedBeforeOpen
      : document.querySelector('.vypode-toggle-btn');

    const overlay = document.createElement('div');
    overlay.className = 'vypode-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Swipe for Letterboxd');

    const safeTitle = escapeHtml(film.title);
    const safeYear = escapeHtml(film.year);
    const safeRating = escapeHtml(film.rating);
    const safeDirector = escapeHtml(film.director);
    const safePoster = escapeHtml(film.poster);
    const safeUrl = escapeHtml(film.url);
    const safeGenres = film.genres.map(g => escapeHtml(g));

    const nextPageUrl = getNextPageUrl();
    const deckControls = isDeck ? `
      <div class="vypode-deck-nav">
        <button type="button" class="vypode-nav-btn" id="vypodePrev" ${currentDeckIndex === 0 ? 'disabled' : ''}>&#8249; Prev</button>
        <span class="vypode-deck-counter">${currentDeckIndex + 1} / ${filmDeck.length}</span>
        <button type="button" class="vypode-nav-btn" id="vypodeNext">Next &#8250;</button>
      </div>
      <div class="vypode-progress-bar">
        <div class="vypode-progress-fill" style="width: ${((currentDeckIndex + 1) / filmDeck.length) * 100}%"></div>
      </div>
    ` : '';

    // Filter badge: show how many films were hidden
    const filterBadge = isDeck && filteredCount > 0
      ? `<span class="vypode-filter-badge" title="${filteredCount} films hidden by filters">${filteredCount} filtered</span>`
      : '';

    overlay.innerHTML = `
      <div class="vypode-container">
        <div class="vypode-header">
          <div class="vypode-logo">SWIPE</div>
          ${filterBadge}
          <button type="button" class="vypode-review-btn" id="vypodeOpenReview" title="Write review (R)">Review</button>
          <button type="button" class="vypode-settings-btn-header" id="vypodeOpenSettings" title="Settings" aria-label="Open settings">\u2699</button>
          <button type="button" class="vypode-close" id="vypodeClose" aria-label="Close Swipe">\u2715</button>
        </div>
        ${deckControls}
        <div class="vypode-card-area">
          ${isDeck ? `
          <div class="vypode-card-next" id="vypodeCardNext">
            <img class="vypode-card-bg" src="" alt="">
            <div class="vypode-card-gradient"></div>
            <div class="vypode-card-info">
              <div class="vypode-card-title"></div>
            </div>
          </div>` : ''}
          <div class="vypode-card" id="vypodeCard">
            <img class="vypode-card-bg" src="${safePoster}" alt="${safeTitle}">
            <div class="vypode-card-gradient"></div>
            <div class="vypode-glow-edge glow-right"></div>
            <div class="vypode-glow-edge glow-left"></div>
            <div class="vypode-glow-edge glow-up"></div>
            <div class="vypode-glow-edge glow-down"></div>
            <div class="vypode-swipe-overlay watch">WATCHED</div>
            <div class="vypode-swipe-overlay like">LIKE</div>
            <div class="vypode-swipe-overlay watchlist">WATCHLIST</div>
            <div class="vypode-swipe-overlay skip">SKIP</div>
            <div class="vypode-zone-indicator zone-left">WATCHED \u2190</div>
            <div class="vypode-zone-indicator zone-right">\u2192 WATCHLIST</div>
            <div class="vypode-zone-indicator zone-up">\u2191 LIKE</div>
            <div class="vypode-zone-indicator zone-down">\u2193 SKIP</div>
            <div class="vypode-card-info">
              <div class="vypode-card-title">${safeTitle}</div>
              <div class="vypode-card-meta">
                ${safeYear ? `<span>${safeYear}</span>` : ''}
                ${safeRating ? `<span>\u00b7</span><span class="vypode-rating">\u2605 ${safeRating}</span>` : ''}
                ${safeDirector ? `<span>\u00b7</span><span>${safeDirector}</span>` : ''}
              </div>
              <div class="vypode-card-genres">
                ${safeGenres.map(g => `<span class="vypode-genre-tag">${g}</span>`).join('')}
              </div>
              <div class="vypode-card-states">
                ${states.isWatched ? '<span class="vypode-state watched">\u2713 Watched</span>' : ''}
                ${states.isLiked ? '<span class="vypode-state liked">Liked</span>' : ''}
                ${states.inWatchlist ? '<span class="vypode-state watchlist">In Watchlist</span>' : ''}
              </div>
            </div>
          </div>
        </div>
        ${isDeck ? `<div class="vypode-action-controls" role="group" aria-label="Film actions">
          <button type="button" class="vypode-action-control watched" data-action="watch" aria-keyshortcuts="ArrowLeft"><span aria-hidden="true">\u25c0</span> Watched</button>
          <button type="button" class="vypode-action-control like" data-action="like" aria-keyshortcuts="ArrowUp"><span aria-hidden="true">\u2665</span> Like</button>
          <button type="button" class="vypode-action-control watchlist" data-action="watchlist" aria-keyshortcuts="ArrowRight"><span aria-hidden="true">+</span> Watchlist</button>
          <button type="button" class="vypode-action-control skip" data-action="skip" aria-keyshortcuts="ArrowDown"><span aria-hidden="true">\u23ed</span> Skip</button>
        </div>` : ''}
        <div class="vypode-hints">
          <div class="vypode-hint"><span class="hint-dot amber"></span>\u2190 Watched</div>
          <div class="vypode-hint"><span class="hint-dot red"></span>\u2191 Like</div>
          <div class="vypode-hint"><span class="hint-dot green"></span>Watchlist \u2192</div>
          ${isDeck ? '<div class="vypode-hint"><span class="hint-dot blue"></span>\u2193 Skip</div>' : ''}
        </div>
        <div class="vypode-hints-sub">
          ${isDeck ? 'Swipe to act \u2022 <b>T</b> trailer \u2022 <b>R</b> review \u2022 <b>S</b> settings' : '<b>R</b> to write review \u2022 <b>S</b> settings'}
        </div>
        ${isDeck ? `<div class="vypode-footer-links">
          <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="vypode-open-link">Open film page \u2197</a>
          <a id="vypodeTrailerLink" class="vypode-trailer-btn" target="_blank" rel="noopener noreferrer">Trailer \u2197</a>
        </div>` : ''}
      </div>
      <div class="vypode-cursor-ring" id="vypodeCursor"><span class="vypode-cursor-label" id="vypodeCursorLabel"></span></div>
    `;

    document.body.appendChild(overlay);

    // Poster fallback (current card only)
    const posterImg = overlay.querySelector('#vypodeCard .vypode-card-bg');
    setPosterImage(posterImg, film.poster, film.title);
    setPosterImage(overlay.querySelector('#vypodeCardNext .vypode-card-bg'), '', '');

    setupEventListeners(isDeck);
    registerModalDialog(overlay, () => hideVypode(), overlayReturnFocus);
    vypodeVisible = true;
    isListingPage = isDeck;
    overlay.querySelector('#vypodeClose')?.focus?.();

    if (isDeck) {
      updateTrailerControl(film);
      populateNextCard(filmDeck[currentDeckIndex + 1]);
      preloadNextPosters(currentDeckIndex + 1, 10);
      updateDeckActionControls();
    }
  }

  // ── Card stack helpers ──────────────────────────────────────────────

  const preloadedPosters = new Set();
  function preloadNextPosters(startIdx, count) {
    for (let i = 0; i < count; i++) {
      const film = filmDeck[startIdx + i];
      if (!film || !film.poster || preloadedPosters.has(film.poster)) continue;
      preloadedPosters.add(film.poster);
      const img = new Image();
      img.src = film.poster;
    }
  }

  function populateNextCard(film) {
    const next = document.getElementById('vypodeCardNext');
    if (!next) return;
    if (!film) { next.style.visibility = 'hidden'; return; }
    next.style.visibility = '';
    const bg = next.querySelector('.vypode-card-bg');
    setPosterImage(bg, film.poster, film.title);
    const title = next.querySelector('.vypode-card-title');
    if (title) title.textContent = film.title || '';
  }

  function populateCurrentCard(film) {
    const card = document.getElementById('vypodeCard');
    if (!card || !film) return;
    card.removeAttribute('aria-disabled');
    card.style.pointerEvents = '';
    const bg = card.querySelector('.vypode-card-bg');
    setPosterImage(bg, film.poster, film.title);
    card.querySelector('.vypode-card-title').textContent = film.title;
    const metaEl = card.querySelector('.vypode-card-meta');
    metaEl.innerHTML = `
      ${film.year ? `<span>${escapeHtml(film.year)}</span>` : ''}
      ${film.rating ? `<span>·</span><span class="vypode-rating">★ ${escapeHtml(film.rating)}</span>` : ''}
      ${film.director ? `<span>·</span><span>${escapeHtml(film.director)}</span>` : ''}
    `;
    const statesEl = card.querySelector('.vypode-card-states');
    statesEl.innerHTML = `
      ${film.isWatched ? '<span class="vypode-state watched">✓ Watched</span>' : ''}
      ${film.isLiked ? '<span class="vypode-state liked">Liked</span>' : ''}
      ${film.inWatchlist ? '<span class="vypode-state watchlist">In Watchlist</span>' : ''}
    `;
    const genresEl = card.querySelector('.vypode-card-genres');
    if (genresEl) {
      const genres = Array.isArray(film.genres) ? film.genres : [];
      genresEl.innerHTML = genres.map(genre =>
        `<span class="vypode-genre-tag">${escapeHtml(genre)}</span>`
      ).join('');
    }
    const prevBtn = document.getElementById('vypodePrev');
    if (prevBtn) prevBtn.disabled = currentDeckIndex === 0;
    const nextBtn = document.getElementById('vypodeNext');
    if (nextBtn) nextBtn.disabled = false;
    const reviewBtn = document.getElementById('vypodeOpenReview');
    if (reviewBtn) {
      reviewBtn.disabled = false;
      reviewBtn.title = 'Write review (R)';
    }
    const openLink = document.querySelector('.vypode-open-link');
    if (openLink) openLink.href = film.url;
    updateTrailerControl(film);
    updateDeckActionControls();
  }

  function renderEmptyDeckState(message) {
    const card = document.getElementById('vypodeCard');
    if (!card) return;
    card.setAttribute('aria-disabled', 'true');
    card.style.pointerEvents = 'none';
    setPosterImage(card.querySelector('.vypode-card-bg'), '', '');
    const title = card.querySelector('.vypode-card-title');
    if (title) title.textContent = message || 'No films match the current filters';
    for (const selector of ['.vypode-card-meta', '.vypode-card-genres', '.vypode-card-states']) {
      const element = card.querySelector(selector);
      if (element) element.textContent = '';
    }
    populateNextCard(null);
    const prevBtn = document.getElementById('vypodePrev');
    const nextBtn = document.getElementById('vypodeNext');
    const reviewBtn = document.getElementById('vypodeOpenReview');
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = !getNextPageUrl();
    if (reviewBtn) {
      reviewBtn.disabled = true;
      reviewBtn.title = 'Choose a film before writing a review';
    }
    document.querySelector('.vypode-open-link')?.removeAttribute('href');
    setDeckActionControlsDisabled(true);
    updateTrailerControl(null);
    updateProgress();
  }

  // Flyoff current + scale-up next, then DOM-swap so the next becomes current.
  function runSwipeAnimation(direction) {
    const card = document.getElementById('vypodeCard');
    const next = document.getElementById('vypodeCardNext');
    if (!card) return;
    card.style.transition = 'transform 0.2s cubic-bezier(.2,.7,.4,1), opacity 0.2s ease';
    if (direction === 'right') card.style.transform = 'translateX(360px) rotate(20deg)';
    else if (direction === 'left') card.style.transform = 'translateX(-360px) rotate(-20deg)';
    else if (direction === 'up') card.style.transform = 'translateY(-260px) scale(1.05)';
    else if (direction === 'down') card.style.transform = 'translateY(260px) scale(0.9)';
    card.style.opacity = '0';
    if (next) {
      next.style.transform = 'scale(1)';
      next.style.opacity = '1';
    }
  }

  function resetCardStack() {
    const card = document.getElementById('vypodeCard');
    const next = document.getElementById('vypodeCardNext');
    if (!card) return;
    card.style.transition = 'none';
    card.style.transform = '';
    card.style.opacity = '1';
    resetCardVisuals(card);
    if (next) {
      next.style.transition = 'none';
      next.style.transform = 'scale(0.95)';
      next.style.opacity = '0.6';
    }
    // Force reflow then restore transitions for future drags
    void card.offsetWidth;
    card.style.transition = '';
    if (next) next.style.transition = '';
  }

  function updateDeckCard() {
    if (!isListingPage) return;
    if (filmDeck.length === 0) {
      renderEmptyDeckState();
      return;
    }
    populateCurrentCard(filmDeck[currentDeckIndex]);
    populateNextCard(filmDeck[currentDeckIndex + 1]);
    resetCardStack();
    updateProgress();
  }

  function goToPrevCard() {
    if (currentDeckIndex > 0) {
      cancelPendingPageNavigation();
      currentDeckIndex--;
      updateDeckCard();
    }
  }

  function goToNextCard() {
    advanceToNextCard();
  }

  // ── Event listeners ─────────────────────────────────────────────────

  function setupEventListeners(isDeck) {
    const card = document.getElementById('vypodeCard');
    const cursor = document.getElementById('vypodeCursor');
    const cursorLabel = document.getElementById('vypodeCursorLabel');
    const closeBtn = document.getElementById('vypodeClose');
    const overlay = document.querySelector('.vypode-overlay');
    const prevBtn = document.getElementById('vypodePrev');
    const nextBtn = document.getElementById('vypodeNext');
    const reviewBtn = document.getElementById('vypodeOpenReview');
    const settingsBtn = document.getElementById('vypodeOpenSettings');
    const trailerLink = document.getElementById('vypodeTrailerLink');

    if (!card) return;

    closeBtn?.addEventListener('click', hideVypode);
    overlay?.addEventListener('click', (e) => { if (e.target === overlay) hideVypode(); });
    reviewBtn?.addEventListener('click', showReviewPanel);
    settingsBtn?.addEventListener('click', showSettingsPanel);
    trailerLink?.addEventListener('click', (event) => {
      if (trailerLink.getAttribute('aria-disabled') !== 'true') return;
      event.preventDefault();
      showFeedback('No trailer is listed for this film', 'error');
    });
    trailerLink?.addEventListener('keydown', (event) => {
      if (
        trailerLink.getAttribute('aria-disabled') === 'true' &&
        (event.key === 'Enter' || event.key === ' ')
      ) {
        event.preventDefault();
        showFeedback('No trailer is listed for this film', 'error');
      }
    });

    if (isDeck) {
      prevBtn?.addEventListener('click', goToPrevCard);
      nextBtn?.addEventListener('click', goToNextCard);
      document.querySelectorAll('.vypode-action-control').forEach(button => {
        button.addEventListener('click', () => dispatchAction(button.dataset.action));
      });
    }

    card.addEventListener('mouseenter', () => { isOverCard = true; cursor.classList.add('visible'); });
    card.addEventListener('mouseleave', () => { isOverCard = false; currentZone = 'neutral'; cursor.classList.remove('visible'); cursor.className = 'vypode-cursor-ring'; resetCardVisuals(card); });

    // Touch / swipe gestures
    let touchStartX = 0, touchStartY = 0, touchStartTime = 0;

    card.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchStartTime = Date.now();
      card.style.transition = 'none';
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const dx = touch.clientX - touchStartX;
      const dy = touch.clientY - touchStartY;

      // Clear overlays first (resetCardVisuals also wipes transform), then set drag pos
      resetCardVisuals(card);
      card.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) rotate(' + (dx * 0.05) + 'deg)';

      const absDx = Math.abs(dx), absDy = Math.abs(dy);
      if (absDx > 30 || absDy > 30) {
        if (absDx > absDy) {
          if (dx < -30) card.querySelector('.vypode-swipe-overlay.watch').style.opacity = Math.min(1, absDx / 120);
          else if (dx > 30) card.querySelector('.vypode-swipe-overlay.watchlist').style.opacity = Math.min(1, absDx / 120);
        } else {
          if (dy < -30) card.querySelector('.vypode-swipe-overlay.like').style.opacity = Math.min(1, absDy / 120);
          else if (dy > 30 && isDeck) card.querySelector('.vypode-swipe-overlay.skip').style.opacity = Math.min(1, absDy / 120);
        }
      }
    }, { passive: false });

    card.addEventListener('touchend', (e) => {
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchStartX;
      const dy = touch.clientY - touchStartY;
      const elapsed = Date.now() - touchStartTime;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const velocity = dist / Math.max(elapsed, 1);

      // Trigger if displacement > 80px or fast flick > 0.5px/ms
      const triggered = dist > 80 || (velocity > 0.5 && dist > 30);
      if (triggered && !isProcessingAction) {
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        if (angle > 135 || angle < -135) {
          dispatchAction('watch');
        } else if (angle > -45 && angle < 45) {
          dispatchAction('watchlist');
        } else if (angle < -45 && angle >= -135) {
          dispatchAction('like');
        } else if (angle > 45 && angle <= 135 && isDeck) {
          dispatchAction('skip');
        } else {
          // Direction unclear — snap back
          card.style.transition = 'transform 0.2s cubic-bezier(.2,.7,.4,1)';
          card.style.transform = '';
          resetCardVisuals(card);
        }
      } else {
        // No trigger — snap back to center
        card.style.transition = 'transform 0.2s cubic-bezier(.2,.7,.4,1)';
        card.style.transform = '';
        resetCardVisuals(card);
      }
    });

    card.addEventListener('mousemove', (e) => {
      if (isProcessingAction) return;
      const rect = card.getBoundingClientRect();
      const relX = (e.clientX - rect.left) / rect.width;
      const relY = (e.clientY - rect.top) / rect.height;
      cursor.style.left = e.clientX + 'px';
      cursor.style.top = e.clientY + 'px';
      let zone = 'neutral';
      if (relY < 0.3 && relX > 0.2 && relX < 0.8) zone = 'up';
      else if (relY > 0.7 && relX > 0.2 && relX < 0.8 && isDeck) zone = 'down';
      else if (relX < 0.3) zone = 'left';
      else if (relX > 0.7) zone = 'right';
      if (zone !== currentZone) { currentZone = zone; updateCursorAndCard(card, cursor, cursorLabel, zone, isDeck); }
      if (zone === 'neutral') { card.style.transform = 'perspective(800px) rotateY(' + ((relX - 0.5) * 8) + 'deg) rotateX(' + ((relY - 0.5) * -4) + 'deg)'; }
    });

    card.addEventListener('click', () => {
      if (isProcessingAction) return;

      if (currentZone === 'left') {
        dispatchAction('watch');
      }
      else if (currentZone === 'right') {
        dispatchAction('watchlist');
      }
      else if (currentZone === 'up') {
        dispatchAction('like');
      }
      else if (currentZone === 'down' && isDeck) {
        dispatchAction('skip');
      }
    });

    document.removeEventListener('keydown', handleKeyDown);
    document.addEventListener('keydown', handleKeyDown);
  }

  function handleKeyDown(e) {
    if (!vypodeVisible || e.defaultPrevented || e.isComposing || e.repeat) return;
    const hasCommandModifier = e.metaKey || e.ctrlKey || e.altKey;

    // The capture listener owns modal Escape/Tab globally. Keep browser chords
    // from reaching deck actions while a dialog is active.
    if (activeModalDialog() && hasCommandModifier) return;

    // Cmd/Ctrl+Z — undo last action (any time, even with no toast visible)
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'z' || e.key === 'Z') && !e.shiftKey && !isUserTyping(e.target)) {
      e.preventDefault();
      if (lastUndoCallback) {
        lastUndoCallback();
      } else if (isListingPage && currentDeckIndex > 0) {
        goToPrevCard();
      }
      return;
    }

    // Review panel shortcuts
    if (reviewPanelVisible) {
      if (hasCommandModifier) return;
      if (e.key >= '1' && e.key <= '5' && !isUserTyping(e.target)) {
        e.preventDefault();
        setRating(parseInt(e.key));
      } else if (e.key === 'Enter' && !e.shiftKey && !isUserTyping(e.target) && !isInteractiveControl(e.target)) {
        e.preventDefault();
        document.getElementById('vypodeReviewSubmit')?.click();
      }
      return;
    }

    // Keep deck shortcuts inert while Settings (or its detail dialog) is open.
    if (settingsPanelVisible) {
      if (hasCommandModifier) return;
      return;
    }

    if (hasCommandModifier || isUserTyping(e.target)) return;
    if (isProcessingAction) return;
    const card = document.getElementById('vypodeCard');
    if (!card) return;

    if (
      isListingPage &&
      (e.key === 't' || e.key === 'T') &&
      !hasCommandModifier
    ) {
      if (openCurrentTrailer()) e.preventDefault();
      return;
    }

    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      showReviewPanel();
      return;
    }

    if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      showSettingsPanel();
      return;
    }

    if (e.key >= '1' && e.key <= '5') {
      e.preventDefault();
      showReviewPanel();
      const val = parseInt(e.key);
      setTimeout(() => setRating(val), 100);
      return;
    }

    if (e.shiftKey && e.key.startsWith('Arrow')) return;

    const currentFilm = isListingPage ? filmDeck[currentDeckIndex] : null;
    if (isListingPage && !currentFilm && e.key.startsWith('Arrow')) {
      showFeedback('No film matches the current filters', 'watchlist');
      return;
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      dispatchAction('watch');
    }
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      dispatchAction('watchlist');
    }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      dispatchAction('like');
    }
    else if (e.key === 'ArrowDown' && isListingPage) {
      e.preventDefault();
      dispatchAction('skip');
    }
    else if (e.key === 'Escape') hideVypode();
  }

  // ── Card visuals ────────────────────────────────────────────────────

  function updateCursorAndCard(card, cursor, cursorLabel, zone, isDeck) {
    cursor.className = 'vypode-cursor-ring visible';
    resetCardVisuals(card);
    if (zone === 'right') {
      cursor.classList.add('zone-right'); cursorLabel.textContent = '\ud83d\udccb';
      card.querySelector('.glow-right').style.opacity = 1;
      card.querySelector('.vypode-swipe-overlay.watchlist').style.opacity = 0.9;
      card.querySelector('.zone-right').classList.add('active');
      card.style.transform = 'perspective(800px) rotateY(3deg) translateX(8px)';
    } else if (zone === 'left') {
      cursor.classList.add('zone-left'); cursorLabel.textContent = '\ud83d\udc41\ufe0f';
      card.querySelector('.glow-left').style.opacity = 1;
      card.querySelector('.vypode-swipe-overlay.watch').style.opacity = 0.9;
      card.querySelector('.zone-left').classList.add('active');
      card.style.transform = 'perspective(800px) rotateY(-3deg) translateX(-8px)';
    } else if (zone === 'up') {
      cursor.classList.add('zone-up'); cursorLabel.textContent = '\u2764\ufe0f';
      card.querySelector('.glow-up').style.opacity = 1;
      card.querySelector('.vypode-swipe-overlay.like').style.opacity = 0.9;
      card.querySelector('.zone-up').classList.add('active');
      card.style.transform = 'perspective(800px) rotateX(3deg) translateY(-6px)';
    } else if (zone === 'down' && isDeck) {
      cursor.classList.add('zone-down'); cursorLabel.textContent = '\u23ed\ufe0f';
      const glowDown = card.querySelector('.glow-down');
      const skipOverlay = card.querySelector('.vypode-swipe-overlay.skip');
      const zoneDown = card.querySelector('.zone-down');
      if (glowDown) glowDown.style.opacity = 1;
      if (skipOverlay) skipOverlay.style.opacity = 0.9;
      if (zoneDown) zoneDown.classList.add('active');
      card.style.transform = 'perspective(800px) rotateX(-3deg) translateY(6px)';
    } else { cursorLabel.textContent = ''; card.style.transform = ''; }
  }

  function resetCardVisuals(card) {
    card.querySelectorAll('.vypode-glow-edge').forEach(g => g.style.opacity = 0);
    card.querySelectorAll('.vypode-swipe-overlay').forEach(o => o.style.opacity = 0);
    card.querySelectorAll('.vypode-zone-indicator').forEach(z => z.classList.remove('active'));
    card.style.transform = '';
  }

  function animateAction(direction) {
    const card = document.getElementById('vypodeCard');
    if (!card) return;
    card.style.transition = 'transform 0.2s cubic-bezier(.2,.7,.4,1), opacity 0.2s ease';
    if (direction === 'right') card.style.transform = 'translateX(300px) rotate(20deg)';
    else if (direction === 'left') card.style.transform = 'translateX(-300px) rotate(-20deg)';
    else if (direction === 'up') card.style.transform = 'translateY(-200px) scale(1.1)';
    else if (direction === 'down') card.style.transform = 'translateY(200px) scale(0.9)';
    card.style.opacity = '0.5';
    setTimeout(() => {
      card.style.transition = 'transform 0.2s cubic-bezier(.2,.7,.4,1), opacity 0.2s ease';
      card.style.transform = '';
      card.style.opacity = '1';
      if (!isListingPage) setTimeout(refreshStates, 200);
    }, 200);
  }

  function refreshStates() {
    const states = getStates();
    const statesContainer = document.querySelector('.vypode-card-states');
    if (statesContainer) statesContainer.innerHTML = (states.isWatched ? '<span class="vypode-state watched">\u2713 Watched</span>' : '') + (states.isLiked ? '<span class="vypode-state liked">Liked</span>' : '') + (states.inWatchlist ? '<span class="vypode-state watchlist">In Watchlist</span>' : '');
  }

  function hideVypode() {
    cancelDeckRun();
    cancelPendingPageNavigation();
    pendingDeckStateRefilter = false;
    if (pendingDeckStateRefilterTimer) {
      clearTimeout(pendingDeckStateRefilterTimer);
      pendingDeckStateRefilterTimer = null;
    }
    hideReviewPanel({ restoreFocus: false });
    hideSettingsPanel({ restoreFocus: false });
    const overlay = document.querySelector('.vypode-overlay');
    const modalEntry = releaseModalDialog(overlay);
    overlayReturnFocus = null;
    if (overlay) {
      overlay.classList.add('hiding');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.setAttribute('inert', '');
      focusAfterModalClose(modalEntry, '.vypode-toggle-btn');
      setTimeout(() => overlay.remove(), 300);
    }
    vypodeVisible = false;
    isListingPage = false;
    // Background actions are an outbox, not part of the overlay lifecycle.
    // Closing the deck must not cancel a click that has already been queued or
    // sent to Letterboxd; the queue owns and removes its hidden iframe.
    document.removeEventListener('keydown', handleKeyDown);
  }

  // ── Toggle button + init ────────────────────────────────────────────

  function createToggleButton() {
    const existing = document.querySelector('.vypode-toggle-btn');
    if (existing) return;

    const pageType = detectPageType();
    if (pageType === 'unknown') return;

    const btn = document.createElement('button');
    btn.className = 'vypode-toggle-btn';
    btn.textContent = pageType === 'listing' ? 'Swipe Deck' : 'Swipe';
    btn.title = pageType === 'listing' ? 'Browse films with the Swipe deck' : 'Open the Swipe interface';
    btn.onclick = () => {
      if (vypodeVisible) {
        hideVypode();
      } else {
        try {
          if (pageType === 'listing') {
            Promise.resolve(createVypodeDeckUI()).catch(e => {
              console.warn('Vypode deck failed:', e);
              showFeedback('Could not open Swipe deck: ' + e.message, 'error');
            });
          } else {
            createVypodeUI();
          }
        } catch (e) {
          console.warn('Vypode open failed:', e);
          showFeedback('Could not open Swipe: ' + e.message, 'error');
        }
      }
    };
    document.body.appendChild(btn);
  }

  // ── Extension popup bridge ───────────────────────────────────────────────────

  const POPUP_ACTIONS = new Set(['ping', 'resumeSwipe', 'openSettings', 'syncNow']);

  function popupResponse(ok, action, code, message, extra) {
    return {
      ok: ok === true,
      action: typeof action === 'string' ? action : null,
      code,
      message,
      ...(ok === true ? {} : { error: message }),
      ...(extra && typeof extra === 'object' ? extra : {})
    };
  }

  function popupCapabilities() {
    const supported = detectPageType() !== 'unknown';
    const stateUsername = window.VypodeFilmState?.getAccountUsername?.() || null;
    const accountReady = Boolean(
      isLetterboxdSessionActive &&
      letterboxdUsername &&
      stateUsername &&
      stateUsername.toLowerCase() === letterboxdUsername.toLowerCase()
    );
    return {
      supported,
      capabilities: {
        resumeSwipe: supported,
        openSettings: supported,
        syncNow: supported && accountReady
      }
    };
  }

  async function openSwipeFromPopup() {
    const pageType = detectPageType();
    if (pageType === 'unknown') {
      return popupResponse(false, 'resumeSwipe', 'unsupported-page', 'Swipe is not available on this Letterboxd page.');
    }

    // Resume means reveal the Swipe surface. Dismiss a child panel first so
    // an already-open deck is not left hidden beneath Settings or Review.
    if (reviewPanelVisible) hideReviewPanel();
    if (settingsPanelVisible) hideSettingsPanel();

    const existing = document.querySelector('.vypode-overlay');
    if (vypodeVisible && existing) {
      existing.classList.remove('hiding');
      existing.hidden = false;
      existing.removeAttribute('aria-hidden');
      return popupResponse(true, 'resumeSwipe', 'already-open', 'Swipe is already open on this tab.');
    }
    if (vypodeVisible && !existing) vypodeVisible = false;

    try {
      if (pageType === 'listing') await createVypodeDeckUI();
      else createVypodeUI();
    } catch (error) {
      return popupResponse(false, 'resumeSwipe', 'open-failed', `Could not open Swipe: ${error.message}`);
    }

    const overlay = document.querySelector('.vypode-overlay');
    if (!vypodeVisible || !overlay) {
      return popupResponse(false, 'resumeSwipe', 'open-failed', 'Swipe could not open on this page.');
    }
    overlay.classList.remove('hiding');
    overlay.hidden = false;
    overlay.removeAttribute('aria-hidden');
    return popupResponse(true, 'resumeSwipe', 'opened', 'Swipe opened on this tab.');
  }

  function openSettingsFromPopup() {
    if (detectPageType() === 'unknown') {
      return popupResponse(false, 'openSettings', 'unsupported-page', 'Swipe settings are not available on this Letterboxd page.');
    }
    // A popup command is an explicit request to switch panels. Closing Review
    // first hands its latest fields to the durable draft queue, then lets
    // Settings take focus instead of returning a misleading open-failed result.
    if (reviewPanelVisible) hideReviewPanel();
    let panel = document.querySelector('.vypode-settings-panel');
    const alreadyOpen = settingsPanelVisible && Boolean(panel);
    if (settingsPanelVisible && !panel) settingsPanelVisible = false;
    if (!alreadyOpen) showSettingsPanel();
    panel = document.querySelector('.vypode-settings-panel');
    if (!panel) {
      return popupResponse(false, 'openSettings', 'open-failed', 'Swipe settings could not open on this page.');
    }
    panel.classList.add('visible');
    return popupResponse(
      true,
      'openSettings',
      alreadyOpen ? 'already-open' : 'opened',
      alreadyOpen ? 'Swipe settings are already open.' : 'Swipe settings opened on this tab.'
    );
  }

  function startSyncFromPopup() {
    if (detectPageType() === 'unknown') {
      return popupResponse(false, 'syncNow', 'unsupported-page', 'Profile sync is not available on this Letterboxd page.');
    }
    if (!isLetterboxdSessionActive || !letterboxdUsername) {
      return popupResponse(false, 'syncNow', 'not-logged-in', 'Log in to Letterboxd before syncing your profile.');
    }
    const stateUsername = window.VypodeFilmState?.getAccountUsername?.() || null;
    if (!stateUsername || stateUsername.toLowerCase() !== letterboxdUsername.toLowerCase()) {
      return popupResponse(false, 'syncNow', 'account-changed', 'The Letterboxd account changed. Refresh this tab before syncing.');
    }
    // runCollectionSync treats a second invocation as a cancellation request.
    // Popup duplicates are acknowledgements only, so never invoke it again
    // while any settings- or popup-started run is active.
    if (popupSyncRun || isSyncing) {
      return popupResponse(true, 'syncNow', 'sync-in-progress', 'Profile sync is already running.', { started: false });
    }

    try {
      const run = runCollectionSync();
      popupSyncRun = Promise.resolve(run).finally(() => {
        if (popupSyncRun === trackedRun) popupSyncRun = null;
      });
      const trackedRun = popupSyncRun;
      // The completion UI is owned by runCollectionSync. Keep the message
      // channel short-lived while retaining this promise as the duplicate lock.
      trackedRun.catch(error => console.warn('Vypode popup sync failed:', error));
      return popupResponse(true, 'syncNow', 'sync-started', 'Profile sync started on this tab.', { started: true });
    } catch (error) {
      popupSyncRun = null;
      return popupResponse(false, 'syncNow', 'sync-failed', `Could not start profile sync: ${error.message}`);
    }
  }

  async function handlePopupAction(message) {
    const initialized = await contentInitialization;
    if (!initialized.ok) {
      return popupResponse(false, message.action, 'initialization-failed', 'Swipe did not finish loading on this page.');
    }

    const availability = popupCapabilities();
    if (!availability.supported) {
      return popupResponse(false, message.action, 'unsupported-page', 'Use an exact film page, films page, watchlist, or list.', {
        supported: false,
        capabilities: availability.capabilities
      });
    }
    if (message.action === 'ping') {
      return popupResponse(true, 'ping', 'ready', 'Swipe is ready on this tab.', {
        supported: true,
        capabilities: availability.capabilities
      });
    }
    if (message.action === 'resumeSwipe') return openSwipeFromPopup();
    if (message.action === 'openSettings') return openSettingsFromPopup();
    return startSyncFromPopup();
  }

  function receivePopupMessage(message, _sender, sendResponse) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.type !== 'vypode-popup') return false;
    const keys = Object.keys(message);
    const validShape = keys.length === 2 && keys.includes('type') && keys.includes('action');
    if (!validShape || typeof message.action !== 'string' || !POPUP_ACTIONS.has(message.action)) {
      sendResponse(popupResponse(false, typeof message.action === 'string' ? message.action : null, 'unsupported-action', 'Unsupported popup action.'));
      return false;
    }
    handlePopupAction(message)
      .then(sendResponse)
      .catch(error => sendResponse(popupResponse(false, message.action, 'action-failed', `Popup action failed: ${error.message}`)));
    return true;
  }

  chrome.runtime?.onMessage?.addListener?.(receivePopupMessage);

  async function init() {
    setupTrailerPageShortcut();

    // Detect the account before initializing FilmState so account-aware
    // registries can isolate cached data. Older init() implementations safely
    // ignore the optional argument.
    await initAccount();
    if (window.VypodeFilmState) {
      await window.VypodeFilmState.init(letterboxdUsername || null);
      window.VypodeFilmState.subscribe?.(snapshot => {
        const snapshotGeneration = Number(snapshot?.meta?.rootGeneration);
        const queuedItems = [...actionQueue, activeQueueItem].filter(Boolean);
        const queuePredatesSnapshot = Number.isSafeInteger(snapshotGeneration) && (
          queuedItems.some(item => item.generation !== snapshotGeneration) ||
          (activeSingleFilmAction && activeSingleFilmAction.generation !== snapshotGeneration)
        );
        if (queuePredatesSnapshot) {
          // Another tab completed Clear All. Invalidation runs synchronously up
          // to its first await, removing any claimed iframe before an 800ms
          // delayed click or post-click verification can mutate cleared data.
          invalidateActionQueueForClear().then(() => {
            actionQueueSuspended = false;
          }).catch(() => {});
        } else if (queuedItems.length > 0 &&
                   queuedItems.some(item => !actionAccountMatchesCurrentState(item.account))) {
          const current = activeQueueItem || queuedItems[0];
          if (activeQueueItem) suspendActionQueueForAccountChange(current, actionIframe);
          else actionQueueSuspended = true;
        } else if (actionQueueSuspended) {
          revalidateActionQueueSession();
        }
        if (reviewDraftContext && Number.isSafeInteger(snapshotGeneration) &&
            snapshotGeneration !== reviewDraftContext.generation) {
          closeReviewForStateReset(reviewDraftContext);
        } else if (snapshot?.reason === 'account-changed' && reviewDraftContext &&
            snapshot.accountId !== reviewDraftContext.accountId) {
          closeReviewForAccountChange(reviewDraftContext);
        }
        // storage.onChanged drives this in other open Letterboxd tabs. Keep an
        // already-open management view honest without making the user close
        // and reopen Settings to see a restore performed elsewhere.
        if (settingsPanelVisible) {
          refreshSettingsStats();
          refreshOpenDatabaseDetail();
        }
        if (snapshot?.reason === 'state-changed') queueDeckStateRefilter();
      });
    }
    await hydrateActionOutbox();

    window.addEventListener('pagehide', () => {
      cancelDeckRun();
      clearTrailerPlayerWait(true);
      resetTrailerPlaybackSession();
      handoffActiveReviewDraft();
      if (!window.VypodeFilmState?.handoffForLifecycle?.()) window.VypodeFilmState?.flush?.();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') handoffActiveReviewDraft();
    });
    window.addEventListener('beforeunload', (e) => {
      cancelDeckRun();
      handoffActiveReviewDraft();
      if (!window.VypodeFilmState?.handoffForLifecycle?.()) window.VypodeFilmState?.flush?.();
      if (actionQueue.length > 0 || isProcessingQueue) {
        e.preventDefault();
        e.returnValue = 'Vypode is still syncing actions to Letterboxd.';
        return e.returnValue;
      }
    });

    // Auto-open deck from next-page navigation
    const autoResumeMatch = window.location.hash.match(/^#vypode-auto(?:=(\d+))?$/);
    if (autoResumeMatch) {
      const autoResumeHop = Math.min(
        Number.parseInt(autoResumeMatch[1] || '0', 10) || 0,
        MAX_AUTO_RESUME_PAGES
      );
      // Remove the private resume marker without adding a same-page entry to
      // browser history. Keep a fallback for lightweight test/older runtimes.
      if (window.history?.replaceState) {
        window.history.replaceState(
          window.history.state,
          '',
          window.location.pathname + window.location.search
        );
      } else {
        window.location.hash = '';
      }
      setTimeout(() => {
        createToggleButton();
        createVypodeDeckUI({ autoResumeHop });
      }, 1500);
      return;
    }

    setTimeout(createToggleButton, 1000);
  }

  init().then(
    () => resolveContentInitialization({ ok: true }),
    error => {
      console.warn('Vypode initialization failed:', error);
      resolveContentInitialization({ ok: false, error });
    }
  );
})();
