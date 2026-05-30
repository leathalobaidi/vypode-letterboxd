// VYPODE FOR LETTERBOXD — Content Script v5.0.0
// Background actions + auto-advance + auto-next-page + Voice Review + Star Rating
// v5.0.0: FilmState registry, fresh poster filtering, durable skip,
//         account awareness, collection sync, settings panel, local profile database
(function() {
  'use strict';
  if (window.vypodeInjected) return;
  window.vypodeInjected = true;

  // ── Core UI state ───────────────────────────────────────────────────

  let currentZone = 'neutral';
  let isOverCard = false;
  let vypodeVisible = false;
  let filmDeck = [];
  let currentDeckIndex = 0;
  let isListingPage = false;
  let isProcessingAction = false;
  let actionIframe = null;
  let iframeTimeout = null;

  // Background action queue — lets user swipe instantly while Letterboxd syncs
  let actionQueue = [];
  let isProcessingQueue = false;

  // Review & Rating state
  let reviewPanelVisible = false;
  let settingsPanelVisible = false;
  let currentRating = 0;
  let recognition = null;
  let isListening = false;

  // Account state
  let letterboxdUsername = null;
  let isSyncing = false;

  // Track how many films were filtered so we can show a badge
  let filteredCount = 0;

  // ── Selector constants ──────────────────────────────────────────────

  const SELECTORS = {
    watch: '[data-track-action="Watched"], .action.-watch, .film-watch-link-target',
    like: '[data-track-action="Liked"], .action.-like, .film-like-link-target',
    watchlist: '[data-track-action="Watchlist"], .action.-watchlist, .film-watch-list-link-target',
    watchedState: '.action.-watch.-checked, .icon-watched.-on, .film-watch-link-target.icon-watched.-on',
    likedState: '.action.-like.-checked, .icon-like.-on, .film-like-link-target.icon-like.-on',
    watchlistState: '.action.-watchlist.-checked, .icon-watchlist.-on, .film-watch-list-link-target.icon-watchlist.-on'
  };

  // ── HTML escaping ───────────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function absoluteLetterboxdUrl(path) {
    if (!path) return '';
    return path.startsWith('http') ? path : 'https://letterboxd.com' + path;
  }

  function normalizePosterUrl(url, srcset) {
    let posterUrl = url || '';
    if ((!posterUrl || posterUrl.includes('empty-poster')) && srcset) {
      posterUrl = srcset.split(',')[0]?.trim()?.split(' ')[0] || posterUrl;
    }
    if (!posterUrl) return '';
    return posterUrl
      .replace(/-0-\d+-0-\d+-crop/, '-0-460-0-690-crop')
      .replace(/-\d+-\d+-\d+-\d+-crop/, '-0-460-0-690-crop');
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

  function detectLetterboxdUsername() {
    // Primary: nav profile link
    const profileLink = document.querySelector('.main-nav a[href*="/"][class*="avatar"]') ||
                        document.querySelector('a.avatar[href]') ||
                        document.querySelector('.nav .profile-menu a[href]');
    if (profileLink) {
      const match = profileLink.getAttribute('href')?.match(/^\/([^\/]+)\/?$/);
      if (match) return match[1];
    }

    // Fallback: look for the username in the header profile area
    const navItems = document.querySelectorAll('.main-nav a[href]');
    for (const link of navItems) {
      const href = link.getAttribute('href');
      // Profile links are like /username/ with just one path segment
      if (href && href.match(/^\/[a-zA-Z0-9_]+\/?$/) && !href.match(/^\/(films|lists|members|activity|journal|search|settings|pro|about)\/?$/)) {
        const text = link.textContent.trim().toLowerCase();
        const slug = href.replace(/\//g, '');
        // Confirm it's a profile link by checking if text matches or link has avatar
        if (link.querySelector('img') || link.classList.contains('avatar') || text === slug) {
          return slug;
        }
      }
    }

    // Fallback: check body data attribute
    const body = document.body;
    if (body.dataset.owner) return body.dataset.owner;

    return null;
  }

  async function initAccount() {
    letterboxdUsername = detectLetterboxdUsername();
    if (letterboxdUsername) {
      // Store locally
      chrome.storage.local.set({ vypode_user: { username: letterboxdUsername, detectedAt: new Date().toISOString() } });
    } else {
      // Try to load from storage (may have been detected on a previous page)
      const result = await new Promise(resolve => {
        chrome.storage.local.get(['vypode_user'], resolve);
      });
      if (result.vypode_user?.username) {
        letterboxdUsername = result.vypode_user.username;
      }
    }
  }

  // ── Page type detection ─────────────────────────────────────────────

  function detectPageType() {
    const path = window.location.pathname;
    if (path.match(/^\/film\/[^\/]+\/?$/)) {
      return 'single';
    } else if (path.includes('/films/') || path.includes('/watchlist') || path.includes('/list/')) {
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
    const slugMatch = window.location.pathname.match(/\/film\/([^\/]+)/);
    return {
      title: titleEl?.textContent?.trim() || 'Unknown Film',
      year: yearEl?.textContent?.trim() || '',
      poster: normalizePosterUrl(posterEl?.src, posterEl?.srcset),
      rating: ratingEl?.textContent?.trim() || '',
      ratingValue: null,
      director: directorEl?.textContent?.trim() || '',
      genres: Array.from(genreEls).slice(0, 3).map(el => el.textContent.trim()),
      url: window.location.href,
      slug: slugMatch?.[1] || null
    };
  }

  function getFilmsFromListing() {
    const films = [];
    const seen = new Set(); // Dedupe by slug
    const posterContainers = document.querySelectorAll('.poster-container, .film-poster, .poster');

    posterContainers.forEach(container => {
      const link = container.querySelector('a[href*="/film/"]') || container.closest('a[href*="/film/"]');
      const img = container.querySelector('img');
      const filmPoster = container.closest('.poster-container') || container;

      if (link && img) {
        const href = link.getAttribute('href');
        const filmSlug = href.match(/\/film\/([^\/]+)/)?.[1];

        // Dedupe: skip if we already have this slug
        if (!filmSlug || seen.has(filmSlug)) return;
        seen.add(filmSlug);

        let title = titleWithoutPosterPrefix(
          img.alt || container.getAttribute('data-film-name'),
          filmSlug?.replace(/-/g, ' ')
        );

        const posterUrl = normalizePosterUrl(img.src || img.dataset.src, img.srcset);

        const ratingEl = filmPoster.querySelector('.rating') || filmPoster.querySelector('[class*="rating"]');
        const rating = ratingEl?.textContent?.trim() || '';
        const ratingValue = parseRatingValue(ratingEl);

        const overlay = filmPoster.querySelector('.film-poster-overlay, .overlay');
        const isWatched = overlay?.querySelector('.icon-watched.-on, .action.-watched.-checked') !== null;
        const isLiked = overlay?.querySelector('.icon-like.-on, .action.-like.-checked') !== null;
        const inWatchlist = overlay?.querySelector('.icon-watchlist.-on, .action.-watchlist.-checked') !== null;

        // Update FilmState from DOM overlay states
        if (window.VypodeFilmState) {
          if (isWatched) window.VypodeFilmState.setFlag(filmSlug, 'watched', true, 'domSync');
          if (isLiked) window.VypodeFilmState.setFlag(filmSlug, 'liked', true, 'domSync');
          if (inWatchlist) window.VypodeFilmState.setFlag(filmSlug, 'watchlist', true, 'domSync');
        }

        const film = {
          title: title.charAt(0).toUpperCase() + title.slice(1),
          year: parseYearFromTitle(title),
          poster: posterUrl,
          rating: rating,
          ratingValue,
          director: '',
          genres: [],
          url: absoluteLetterboxdUrl(href),
          slug: filmSlug,
          isWatched,
          isLiked,
          inWatchlist,
          actioned: false
        };
        persistFilmRecord(film, 'domSync');
        films.push(film);
      }
    });

    return films;
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
    film.enriched = true; // Mark immediately to avoid duplicate fetches
    try {
      const response = await fetch(film.url, { credentials: 'same-origin' });
      if (!response.ok) return;
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      film.year = doc.querySelector('.releaseyear a')?.textContent?.trim() || '';
      film.director = doc.querySelector('.contributor a')?.textContent?.trim() || '';
      const genreEls = doc.querySelectorAll('.text-sluglist a[href*="/films/genre/"]');
      film.genres = Array.from(genreEls).slice(0, 3).map(el => el.textContent.trim());

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
    if (genresEl && film.genres.length > 0) {
      genresEl.innerHTML = film.genres.map(g => '<span class="vypode-genre-tag">' + escapeHtml(g) + '</span>').join('');
    }
  }

  function getNextPageUrl() {
    const nextLink = document.querySelector('.paginate-nextprev a.next') ||
                     document.querySelector('a[rel="next"]') ||
                     document.querySelector('.pagination a.next');
    if (nextLink?.href) return nextLink.href;
    // Fallback: infer /page/N/ from current URL (Letterboxd listing pattern)
    return inferNextPageUrl(window.location.href);
  }

  function inferNextPageUrl(href) {
    try {
      const u = new URL(href);
      const m = u.pathname.match(/^(.*?)\/page\/(\d+)\/?$/);
      if (m) {
        u.pathname = `${m[1]}/page/${parseInt(m[2], 10) + 1}/`;
        return u.toString();
      }
      // No /page/N/ — assume current is page 1, jump to page 2
      u.pathname = u.pathname.replace(/\/$/, '') + '/page/2/';
      return u.toString();
    } catch { return null; }
  }

  function inferNextPageUrlFromDoc(fetchedUrl) {
    return inferNextPageUrl(fetchedUrl);
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

  function performWatch() {
    const buttons = findButtons();
    if (buttons.watchBtn) {
      buttons.watchBtn.click();
      const slug = window.location.pathname.match(/\/film\/([^\/]+)/)?.[1];
      if (slug && window.VypodeFilmState) window.VypodeFilmState.setFlag(slug, 'watched', true, 'userAction');
      showFeedback('Marked as watched!', 'watch');
      return true;
    }
    showFeedback('Could not find watch button', 'error'); return false;
  }

  function performLike() {
    const buttons = findButtons();
    if (buttons.likeBtn) {
      buttons.likeBtn.click();
      const slug = window.location.pathname.match(/\/film\/([^\/]+)/)?.[1];
      if (slug && window.VypodeFilmState) window.VypodeFilmState.setFlag(slug, 'liked', true, 'userAction');
      showFeedback('Liked!', 'like');
      return true;
    }
    showFeedback('Could not find like button', 'error'); return false;
  }

  function performWatchlist() {
    const buttons = findButtons();
    if (buttons.watchlistBtn) {
      buttons.watchlistBtn.click();
      const slug = window.location.pathname.match(/\/film\/([^\/]+)/)?.[1];
      if (slug && window.VypodeFilmState) window.VypodeFilmState.setFlag(slug, 'watchlist', true, 'userAction');
      showFeedback('Added to Watchlist!', 'watchlist');
      return true;
    }
    showFeedback('Could not find watchlist button', 'error'); return false;
  }

  // ── Iframe cleanup + background actions ─────────────────────────────

  function cleanupIframe() {
    if (iframeTimeout) { clearTimeout(iframeTimeout); iframeTimeout = null; }
    if (actionIframe) { actionIframe.remove(); actionIframe = null; }
    isProcessingAction = false;
  }

  function performBackgroundAction(filmUrl, action) {
    if (isProcessingAction) return;
    isProcessingAction = true;

    const film = filmDeck[currentDeckIndex];
    const prevIndex = currentDeckIndex;
    const flagMap = { watch: 'watched', like: 'liked', watchlist: 'watchlist' };
    const dirMap = { watch: 'left', like: 'up', watchlist: 'right' };
    const previousValue = action === 'watch' ? film.isWatched : action === 'like' ? film.isLiked : film.inWatchlist;

    // Optimistic update — mark film and persist immediately so the user
    // can keep swiping without waiting for Letterboxd to respond.
    if (action === 'watch') film.isWatched = !film.isWatched;
    else if (action === 'like') film.isLiked = !film.isLiked;
    else if (action === 'watchlist') film.inWatchlist = !film.inWatchlist;
    film.actioned = true;

    if (film.slug && window.VypodeFilmState) {
      window.VypodeFilmState.setFlag(film.slug, flagMap[action], true, 'userAction');
    }

    const messages = { watch: 'Marked as watched!', like: 'Liked!', watchlist: 'Added to Watchlist!' };

    // Show undo toast — user has 5s to reverse
    showUndoToast(messages[action], action, () => {
      // Undo: revert optimistic state
      if (action === 'watch') film.isWatched = false;
      else if (action === 'like') film.isLiked = false;
      else if (action === 'watchlist') film.inWatchlist = false;
      film.actioned = false;
      if (film.slug && window.VypodeFilmState) {
        window.VypodeFilmState.setFlag(film.slug, flagMap[action], false, 'userAction');
      }
      // Remove from action queue if still pending
      const qIdx = actionQueue.findIndex(q => q.filmUrl === filmUrl && q.action === action);
      if (qIdx !== -1) actionQueue.splice(qIdx, 1);
      // Go back to the undone card
      currentDeckIndex = prevIndex;
      updateDeckCard();
      updateProgress();
      showFeedback('Undone!', 'skip');
    });

    // Queue the actual Letterboxd action (non-blocking)
    actionQueue.push({ filmUrl, action, retries: 0, slug: film.slug, previousValue });
    processActionQueue();

    // Visual flyoff + next-card rise, parallel with action queue
    const hasNext = currentDeckIndex < filmDeck.length - 1;
    if (hasNext) {
      runSwipeAnimation(dirMap[action]);
      currentDeckIndex++;
      updateProgress();
      enrichFilmData(filmDeck[currentDeckIndex]);
      preloadNextPosters(currentDeckIndex + 1, 10);
      setTimeout(() => {
        populateCurrentCard(filmDeck[currentDeckIndex]);
        populateNextCard(filmDeck[currentDeckIndex + 1]);
        resetCardStack();
        isProcessingAction = false;
      }, 200);
    } else {
      advanceToNextCard();
      isProcessingAction = false;
    }
  }

  function processActionQueue() {
    if (isProcessingQueue || actionQueue.length === 0) return;
    isProcessingQueue = true;

    const item = actionQueue.shift();
    const { filmUrl, action, retries = 0 } = item;

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(iframe);

    const onFail = () => {
      iframe.remove();
      // Retry up to 3 times with increasing delay
      if (retries < 3) {
        setTimeout(() => {
          actionQueue.push({ ...item, retries: retries + 1 });
          isProcessingQueue = false;
          processActionQueue();
        }, (retries + 1) * 1000);
      } else {
        console.warn('Vypode: action failed after 3 retries', action, filmUrl);
        rollbackFailedAction(item);
        showFeedback('Letterboxd action failed; local change rolled back', 'error');
        isProcessingQueue = false;
        processActionQueue();
      }
    };

    const timeout = setTimeout(() => {
      onFail();
    }, 10000);

    iframe.onload = function() {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

        setTimeout(() => {
          const selectorMap = { watch: SELECTORS.watch, like: SELECTORS.like, watchlist: SELECTORS.watchlist };
          const btn = iframeDoc.querySelector(selectorMap[action]);

          if (btn) {
            btn.click();
            setTimeout(() => {
              clearTimeout(timeout);
              iframe.remove();
              isProcessingQueue = false;
              processActionQueue();
            }, 300);
          } else {
            clearTimeout(timeout);
            onFail();
          }
        }, 800);
      } catch (e) {
        clearTimeout(timeout);
        onFail();
      }
    };

    iframe.onerror = function() {
      clearTimeout(timeout);
      onFail();
    };

    iframe.src = filmUrl;
  }

  function rollbackFailedAction(item) {
    const flagMap = { watch: 'watched', like: 'liked', watchlist: 'watchlist' };
    const flag = flagMap[item.action];
    if (!flag || !item.slug) return;

    const film = filmDeck.find(f => f.slug === item.slug);
    if (film) {
      if (flag === 'watched') film.isWatched = item.previousValue;
      else if (flag === 'liked') film.isLiked = item.previousValue;
      else if (flag === 'watchlist') film.inWatchlist = item.previousValue;
    }
    window.VypodeFilmState?.setFlag(item.slug, flag, Boolean(item.previousValue), 'userAction');
    updateDeckCard();
  }

  // ── Review submission ───────────────────────────────────────────────

  function vyLog(...args) { console.log('[Vypode]', ...args); }
  function vyWarn(...args) { console.warn('[Vypode]', ...args); }

  // Direct API submission — POSTs to /s/save-diary-entry like Letterboxd's own modal does.
  // Avoids the fragile hidden-iframe DOM-scraping approach entirely.
  async function submitReview(filmUrl, reviewText, rating) {
    if (isProcessingAction) return;
    isProcessingAction = true;

    const fullReview = reviewText || '';
    vyLog('submitReview: url=%s rating=%d reviewLen=%d', filmUrl, rating, fullReview.length);
    if (!fullReview && rating <= 0) {
      vyWarn('submitReview: nothing to submit (empty review + rating=0)');
      isProcessingAction = false;
      return;
    }

    const filmSlug = (filmUrl.match(/\/film\/([^\/]+)/) || [])[1];
    showFeedback('Submitting review...', 'watchlist');

    try {
      if (!filmSlug) throw new Error('Could not parse film slug from ' + filmUrl);
      // Normalize to the canonical film page. Deck URLs can be user-scoped
      // (/<user>/film/<slug>/) which 404 for unlogged films — the canonical
      // /film/<slug>/ page always exists and carries CSRF + production-uid.
      const canonicalUrl = 'https://letterboxd.com/film/' + filmSlug + '/';
      vyLog('fetching film page for CSRF + UID:', canonicalUrl);
      const r = await fetch(canonicalUrl, { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error('Film page fetch failed: ' + r.status);
      const html = await r.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      const csrf = doc.querySelector('input[name="__csrf"]')?.value;
      // data-production-uid is on every film page; data-watchable-uid only on
      // review elements (missing on films with no visible reviews).
      const watchableUid =
        doc.querySelector('[data-production-uid]')?.dataset?.productionUid ||
        doc.querySelector('[data-watchable-uid]')?.dataset?.watchableUid;
      vyLog('parsed csrf?', !!csrf, csrf === 'placeholder' ? '(placeholder!)' : '', 'uid?', watchableUid);

      if (!csrf || csrf === 'placeholder') throw new Error('Not logged in to Letterboxd');
      if (!watchableUid) throw new Error('Could not identify film (no production-uid)');

      // 3. Build form data — diary entry with today's date so it lands on profile
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const form = new URLSearchParams();
      form.set('__csrf', csrf);
      form.set('viewingId', '');
      form.set('viewingableUid', watchableUid);
      form.set('specifiedDate', 'true');
      form.set('viewingDateStr', dateStr);
      if (fullReview) form.set('review', fullReview);
      if (rating > 0) form.set('rating', String(rating * 2)); // 0-10 half-star scale
      form.set('rewatch', 'false');
      form.set('containsSpoilers', 'false');
      form.set('tags', '');
      vyLog('POST /s/save-diary-entry payload keys:', [...form.keys()]);

      const resp = await fetch('https://letterboxd.com/s/save-diary-entry', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        body: form,
      });
      const text = await resp.text();
      vyLog('save-diary-entry status:', resp.status, 'body preview:', text.slice(0, 400));

      if (!resp.ok) throw new Error('Server returned ' + resp.status);

      // Letterboxd typically returns JSON {result: true, ...} on success
      let result = null;
      try { result = JSON.parse(text); } catch {}
      if (result && result.result === false) {
        throw new Error(result.messages?.join(', ') || 'Letterboxd rejected entry');
      }

      // 4. Verify by checking diary
      await verifyReviewSubmitted(filmSlug, rating, () => {
        window.VypodeFilmState?.updateFilm?.(filmSlug, {
          ratingValue: rating || null,
          rating: rating > 0 ? '★'.repeat(rating) : null,
          reviewText: fullReview || null,
          watched: true,
          watchedAt: new Date().toISOString(),
          url: canonicalUrl
        }, 'userAction');
        hideReviewPanel();
        if (isListingPage) {
          filmDeck[currentDeckIndex].actioned = true;
          advanceToNextCard();
        }
      });
    } catch (e) {
      vyWarn('submitReview failed:', e.message);
      // No tab fallback — keep the review panel open so the user can retry.
      showFeedback('Review failed: ' + e.message + ' — try again', 'error');
    } finally {
      isProcessingAction = false;
    }
  }


  async function verifyReviewSubmitted(filmSlug, rating, doneCallback) {
    // Wait for Letterboxd to persist, then check diary
    await new Promise(r => setTimeout(r, 3000));
    if (!letterboxdUsername || !filmSlug) {
      vyWarn('verifyReviewSubmitted: skipped — missing username or slug');
      showFeedback('Review sent — could not verify (no username)', 'watchlist');
      doneCallback();
      return;
    }
    try {
      const diaryUrl = `https://letterboxd.com/${letterboxdUsername}/films/diary/`;
      const resp = await fetch(diaryUrl, { credentials: 'same-origin', cache: 'no-store' });
      const html = await resp.text();
      const found = html.includes(`/film/${filmSlug}/`);
      vyLog('verifyReviewSubmitted: diary fetch status', resp.status, 'film slug present?', found);
      if (found) {
        showFeedback('Review submitted!', 'watchlist');
      } else {
        vyWarn('verifyReviewSubmitted: film not in diary — submit likely failed');
        showFeedback('Review may not have submitted — check your diary', 'error');
      }
    } catch (e) {
      vyWarn('verifyReviewSubmitted: error:', e.message);
      showFeedback('Review sent — verification failed', 'watchlist');
    }
    doneCallback();
  }


  // ── Deck navigation ─────────────────────────────────────────────────

  // Track the current next-page URL (updated as we load more pages)
  let currentNextPageUrl = null;
  let isLoadingMore = false;

  function advanceToNextCard() {
    if (currentDeckIndex < filmDeck.length - 1) {
      currentDeckIndex++;
      updateDeckCard();
      updateProgress();
      // Pre-fetch film details for the new card
      enrichFilmData(filmDeck[currentDeckIndex]);
      preloadNextPosters(currentDeckIndex + 1, 10);
    } else {
      const nextUrl = currentNextPageUrl || getNextPageUrl();
      if (nextUrl) {
        loadNextPageFilms(nextUrl);
      } else {
        showFeedback('All done! No more pages.', 'watchlist');
      }
    }
  }

  async function loadNextPageFilms(url) {
    if (isLoadingMore) return;
    isLoadingMore = true;
    showFeedback('Loading more films...', 'watch');

    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('Failed to load page');

      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      // Extract films from the fetched page DOM
      const newFilms = extractFilmsFromDoc(doc);
      const filtered = filterFilmDeck(newFilms);

      // Update the next-page URL from the fetched document
      const nextLink = doc.querySelector('.paginate-nextprev a.next') || doc.querySelector('a[rel="next"]');
      if (nextLink) {
        const href = nextLink.getAttribute('href');
        currentNextPageUrl = href.startsWith('http') ? href : 'https://letterboxd.com' + href;
      } else if (newFilms.length > 0) {
        // Page has films but no DOM next-link — infer from the fetched URL
        currentNextPageUrl = inferNextPageUrlFromDoc(url);
      } else {
        // Empty page = real end of pagination
        currentNextPageUrl = null;
      }

      if (filtered.length > 0) {
        filmDeck.push(...filtered);
        currentDeckIndex++;
        updateDeckCard();
        updateProgress();
        enrichFilmData(filmDeck[currentDeckIndex]);
        preloadNextPosters(currentDeckIndex + 1, 10);
        showFeedback('Loaded ' + filtered.length + ' more films', 'watchlist');
      } else if (currentNextPageUrl) {
        // All films on this page were filtered — try the next one
        isLoadingMore = false;
        loadNextPageFilms(currentNextPageUrl);
        return;
      } else {
        showFeedback('All done! No more pages.', 'watchlist');
      }
    } catch (e) {
      // Fallback: full page navigation
      showFeedback('Syncing actions & loading next page...', 'watch');
      waitForQueueDrain(() => { window.location.href = url + '#vypode-auto'; });
    }

    isLoadingMore = false;
  }

  function extractFilmsFromDoc(doc) {
    const films = [];
    const seen = new Set();
    const posterContainers = doc.querySelectorAll('.poster-container, .film-poster, .poster');

    posterContainers.forEach(container => {
      const link = container.querySelector('a[href*="/film/"]') || container.closest('a[href*="/film/"]');
      const img = container.querySelector('img');
      const filmPoster = container.closest('.poster-container') || container;

      if (link && img) {
        const href = link.getAttribute('href');
        const filmSlug = href.match(/\/film\/([^\/]+)/)?.[1];
        if (!filmSlug || seen.has(filmSlug)) return;
        seen.add(filmSlug);

        // Also skip if already in the current deck
        if (filmDeck.some(f => f.slug === filmSlug)) return;

        let title = titleWithoutPosterPrefix(
          img.alt || container.getAttribute('data-film-name'),
          filmSlug?.replace(/-/g, ' ')
        );
        const posterUrl = normalizePosterUrl(img.src || img.dataset.src, img.srcset);

        const ratingEl = filmPoster.querySelector('.rating') || filmPoster.querySelector('[class*="rating"]');
        const overlay = filmPoster.querySelector('.film-poster-overlay, .overlay');

        const film = {
          title: title.charAt(0).toUpperCase() + title.slice(1),
          year: parseYearFromTitle(title),
          poster: posterUrl,
          rating: ratingEl?.textContent?.trim() || '',
          ratingValue: parseRatingValue(ratingEl),
          director: '', genres: [],
          url: absoluteLetterboxdUrl(href),
          slug: filmSlug,
          isWatched: overlay?.querySelector('.icon-watched.-on, .action.-watched.-checked') !== null,
          isLiked: overlay?.querySelector('.icon-like.-on, .action.-like.-checked') !== null,
          inWatchlist: overlay?.querySelector('.icon-watchlist.-on, .action.-watchlist.-checked') !== null,
          actioned: false
        };
        persistFilmRecord(film, 'domSync');
        films.push(film);
      }
    });

    return films;
  }

  function waitForQueueDrain(callback, elapsed) {
    elapsed = elapsed || 0;
    if ((actionQueue.length === 0 && !isProcessingQueue) || elapsed >= 15000) {
      callback();
    } else {
      setTimeout(function() { waitForQueueDrain(callback, elapsed + 200); }, 200);
    }
  }

  function skipCurrentFilm() {
    if (isProcessingAction) return;
    isProcessingAction = true;

    const film = filmDeck[currentDeckIndex];
    const prevIndex = currentDeckIndex;
    film.actioned = true;

    // Durable skip: persist to FilmState
    if (film.slug && window.VypodeFilmState) {
      window.VypodeFilmState.setFlag(film.slug, 'skipped', true, 'userAction');
    }

    showUndoToast('Skipped', 'skip', () => {
      film.actioned = false;
      if (film.slug && window.VypodeFilmState) {
        window.VypodeFilmState.setFlag(film.slug, 'skipped', false, 'userAction');
      }
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
      preloadNextPosters(currentDeckIndex + 1, 10);
      setTimeout(() => {
        populateCurrentCard(filmDeck[currentDeckIndex]);
        populateNextCard(filmDeck[currentDeckIndex + 1]);
        resetCardStack();
        isProcessingAction = false;
      }, 200);
    } else {
      advanceToNextCard();
      isProcessingAction = false;
    }
  }

  function showFeedback(message, type) {
    const existing = document.querySelector('.vypode-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'vypode-toast vypode-toast-' + type;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 2000);
  }

  let lastUndoCallback = null;
  function showUndoToast(message, type, undoCallback) {
    const existing = document.querySelector('.vypode-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'vypode-toast vypode-toast-' + type + ' vypode-toast-undo';
    toast.innerHTML = '<span>' + escapeHtml(message) + '</span><button class="vypode-undo-btn">Undo (⌘Z)</button>';
    document.body.appendChild(toast);
    let undone = false;
    const fire = () => {
      if (undone) return;
      undone = true;
      undoCallback();
      lastUndoCallback = null;
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    };
    lastUndoCallback = fire;
    toast.querySelector('.vypode-undo-btn').addEventListener('click', fire);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      if (!undone) {
        if (lastUndoCallback === fire) lastUndoCallback = null;
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
      }
    }, 5000);
  }

  function updateProgress() {
    const counter = document.querySelector('.vypode-deck-counter');
    const progress = document.querySelector('.vypode-progress-fill');
    if (counter) counter.textContent = `${currentDeckIndex + 1} / ${filmDeck.length}`;
    if (progress) progress.style.width = ((currentDeckIndex + 1) / filmDeck.length) * 100 + '%';
  }

  // ==================== COLLECTION SYNC ENGINE ====================

  async function runCollectionSync() {
    if (!letterboxdUsername) {
      showFeedback('No Letterboxd account detected — log in first', 'error');
      return { success: false, error: 'Not logged in' };
    }
    if (isSyncing) {
      showFeedback('Sync already in progress...', 'watch');
      return { success: false, error: 'Already syncing' };
    }

    isSyncing = true;
    updateSyncUI('syncing');
    showFeedback('Syncing your Letterboxd collections...', 'watch');
    const startTime = Date.now();

    try {
      const results = { watched: 0, watchlist: 0, liked: 0, reviewed: 0 };

      const [watchedFilms, watchlistFilms, likedFilms] = await Promise.all([
        fetchAllCollectionFilms(`/${letterboxdUsername}/films/`, { watched: true }),
        fetchAllCollectionFilms(`/${letterboxdUsername}/watchlist/`, { watchlist: true }),
        fetchAllCollectionFilms(`/${letterboxdUsername}/likes/films/`, { liked: true })
      ]);
      results.watched = watchedFilms.length;
      results.watchlist = watchlistFilms.length;
      results.liked = likedFilms.length;

      const syncStatus = document.getElementById('vypodeSyncStatus');
      if (syncStatus) syncStatus.textContent = 'Loading review text where available...';
      await hydrateReviewText(watchedFilms);
      results.reviewed = watchedFilms.filter(film => film.reviewText).length;

      const slugMap = {};
      for (const film of [...watchedFilms, ...watchlistFilms, ...likedFilms]) {
        if (!film.slug) continue;
        slugMap[film.slug] = mergeSyncedFilmRecord(slugMap[film.slug], film);
      }

      const updated = window.VypodeFilmState.bulkSetFromSync(slugMap, 'collectionSync');
      const reconciled = window.VypodeFilmState.reconcileFlags?.({
        watched: new Set(watchedFilms.map(film => film.slug)),
        liked: new Set(likedFilms.map(film => film.slug)),
        watchlist: new Set(watchlistFilms.map(film => film.slug))
      }, 'collectionSync') || 0;

      const duration = Date.now() - startTime;
      window.VypodeFilmState.setSyncMeta(new Date().toISOString(), duration, results);

      isSyncing = false;
      updateSyncUI('done');
      refreshSettingsStats();
      renderDatabaseBrowser();
      showFeedback(`Sync complete: ${results.watched} watched, ${results.watchlist} watchlist, ${results.liked} liked`, 'watchlist');

      return { success: true, results, updated, reconciled, duration };

    } catch (e) {
      isSyncing = false;
      updateSyncUI('error');
      showFeedback('Sync failed: ' + e.message, 'error');
      return { success: false, error: e.message };
    }
  }

  async function fetchAllCollectionFilms(basePath, flags) {
    const films = new Map();
    let page = 1;
    const maxPages = 100; // Safety cap: 100 pages x 72 films = 7,200 films max

    while (page <= maxPages) {
      const url = `https://letterboxd.com${basePath}page/${page}/`;

      if (page > 1) await sleep(150);

      try {
        const response = await fetchWithTimeout(url, { credentials: 'same-origin' }, 15000);
        if (!response.ok) break;

        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const pageFilms = extractProfileFilms(doc, flags);
        let foundOnPage = 0;
        for (const film of pageFilms) {
          if (!film.slug) continue;
          const existing = films.get(film.slug) || {};
          films.set(film.slug, { ...existing, ...film });
          foundOnPage++;
        }

        if (foundOnPage === 0) break;

        const hasNext = doc.querySelector('.paginate-nextprev a.next') ||
                        doc.querySelector('a[rel="next"]');
        if (!hasNext) break;

        page++;
      } catch (e) {
        console.warn('Vypode sync: failed to fetch page', page, e);
        break;
      }
    }

    return Array.from(films.values());
  }

  function mergeSyncedFilmRecord(existing, incoming) {
    const merged = { ...(existing || {}) };
    for (const key of ['slug', 'title', 'year', 'poster', 'url', 'rating', 'ratingValue', 'reviewText', 'reviewUrl']) {
      if (incoming[key] !== undefined && incoming[key] !== null && incoming[key] !== '') {
        merged[key] = incoming[key];
      }
    }
    for (const flag of ['watched', 'liked', 'watchlist']) {
      merged[flag] = Boolean(merged[flag] || incoming[flag]);
    }
    return merged;
  }

  function extractProfileFilms(doc, flags) {
    const films = [];
    const items = doc.querySelectorAll('.griditem, li.poster-container, li.posteritem');
    const containers = items.length ? items : doc.querySelectorAll('[data-item-slug]');

    containers.forEach(item => {
      const component = item.querySelector('[data-item-slug]') || item.closest('[data-item-slug]') || item;
      const link = item.querySelector('a[href*="/film/"]') || component.querySelector?.('a[href*="/film/"]');
      const img = item.querySelector('img');
      const href = component.dataset?.itemLink || link?.getAttribute('href') || '';
      const slug = component.dataset?.itemSlug || href.match(/\/film\/([^\/]+)/)?.[1];
      if (!slug) return;

      const title = titleWithoutPosterPrefix(
        component.dataset?.itemName || component.dataset?.itemFullDisplayName || img?.alt,
        slug.replace(/-/g, ' ')
      );
      const ratingEl = item.querySelector('.poster-viewingdata .rating[class*="rated-"], .rating[class*="rated-"]');
      const reviewLink = item.querySelector('a.review-micro[href*="/film/"], a.icon-review[href*="/film/"]');

      const film = {
        slug,
        title,
        year: parseYearFromTitle(title),
        poster: normalizePosterUrl(img?.src || img?.dataset?.src, img?.srcset),
        url: absoluteLetterboxdUrl(href || `/film/${slug}/`),
        rating: ratingEl?.textContent?.trim() || null,
        ratingValue: parseRatingValue(ratingEl),
        reviewUrl: reviewLink ? absoluteLetterboxdUrl(reviewLink.getAttribute('href')) : null
      };
      if (flags?.watched) film.watched = true;
      if (flags?.liked) film.liked = true;
      if (flags?.watchlist) film.watchlist = true;
      films.push(film);
    });

    return films;
  }

  async function hydrateReviewText(films) {
    const queue = films.filter(film => film.reviewUrl && !film.reviewText);
    const syncStatus = document.getElementById('vypodeSyncStatus');
    let completed = 0;
    if (syncStatus && queue.length > 0) {
      syncStatus.textContent = `Loading review text where available... 0/${queue.length}`;
    }
    let index = 0;
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (index < queue.length) {
        const film = queue[index++];
        try {
          const response = await fetchWithTimeout(film.reviewUrl, { credentials: 'same-origin', cache: 'no-store' }, 12000);
          if (!response.ok) continue;
          const html = await response.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const body = doc.querySelector('.js-review-body, .review .body-text, .body-text.-prose');
          if (body) {
            film.reviewText = body.textContent.replace(/\s+/g, ' ').trim();
          }
        } catch (e) {
          // Review text is additive metadata. Missing text should never fail the whole sync.
        } finally {
          completed++;
          if (syncStatus && (completed === queue.length || completed % 25 === 0)) {
            syncStatus.textContent = `Loading review text where available... ${completed}/${queue.length}`;
          }
        }
      }
    });
    await Promise.all(workers);
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...(options || {}), signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function updateSyncUI(state) {
    const syncBtn = document.getElementById('vypodeSyncBtn');
    const syncStatus = document.getElementById('vypodeSyncStatus');
    if (syncBtn) {
      syncBtn.disabled = state === 'syncing';
      syncBtn.textContent = state === 'syncing' ? 'Syncing...' : 'Sync now';
    }
    if (syncStatus) {
      if (state === 'syncing') {
        syncStatus.textContent = 'Syncing your collections...';
        syncStatus.style.color = '#f7931e';
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

  function initSpeechRecognition() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) return null;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en';

    recognition.onresult = (event) => {
      const textarea = document.getElementById('vypodeReviewText');
      if (!textarea) return;
      let finalTranscript = '';
      let interimTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalTranscript += transcript + ' ';
        else interimTranscript = transcript;
      }
      if (finalTranscript) textarea.value += finalTranscript;
      const interim = document.getElementById('vypodeInterim');
      if (interim) interim.textContent = interimTranscript;
    };

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed') {
        showFeedback('Microphone access denied - check browser permissions', 'error');
        isListening = false;
        updateMicButton();
      }
    };

    recognition.onend = () => {
      const interim = document.getElementById('vypodeInterim');
      if (interim) interim.textContent = '';
      if (isListening) {
        setTimeout(() => {
          if (isListening && recognition) {
            try { recognition.start(); } catch(e) {}
          }
        }, 100);
      }
    };

    return recognition;
  }

  function startListening() {
    if (recognition) { try { recognition.stop(); } catch(e) {} }
    recognition = initSpeechRecognition();
    if (!recognition) { showFeedback('Speech recognition not supported in this browser', 'error'); return; }
    isListening = true;
    updateMicButton();
    try {
      recognition.start();
      showFeedback('Listening... speak now', 'like');
    } catch (e) {
      isListening = false;
      updateMicButton();
      showFeedback('Could not start microphone', 'error');
    }
  }

  function stopListening() {
    isListening = false;
    if (recognition) {
      try { recognition.stop(); } catch(e) {}
      try { recognition.abort(); } catch(e) {}
    }
    updateMicButton();
    const interim = document.getElementById('vypodeInterim');
    if (interim) interim.textContent = '';
  }

  function toggleListening() {
    if (isListening) stopListening();
    else startListening();
  }

  function updateMicButton() {
    const micBtn = document.getElementById('vypodeMicBtn');
    if (micBtn) {
      micBtn.classList.toggle('listening', isListening);
      micBtn.textContent = isListening ? 'Recording...' : 'Dictate';
    }
  }

  function setRating(value) {
    // Toggle off if clicking the same rating again
    currentRating = (currentRating === value) ? 0 : value;
    if (currentRating < 0) currentRating = 0;
    updateRatingDisplay();
  }

  function updateRatingDisplay() {
    const starContainer = document.getElementById('vypodeStars');
    if (!starContainer) return;
    starContainer.querySelectorAll('.vypode-star').forEach((btn, i) => {
      btn.classList.remove('active', 'half');
      if (currentRating >= i + 1) btn.classList.add('active');
    });
    const ratingText = document.getElementById('vypodeRatingText');
    if (ratingText) {
      ratingText.textContent = currentRating > 0
        ? '\u2605'.repeat(currentRating) + ' (' + currentRating + '/5)'
        : 'No rating';
    }
  }

  function showReviewPanel() {
    if (reviewPanelVisible) return;
    reviewPanelVisible = true;
    currentRating = 0;

    const film = isListingPage ? filmDeck[currentDeckIndex] : getFilmData();
    const safeTitle = escapeHtml(film.title);

    const panel = document.createElement('div');
    panel.className = 'vypode-review-panel';
    panel.innerHTML = `
      <div class="vypode-review-content">
        <div class="vypode-review-header">
          <h3>Review: ${safeTitle}</h3>
          <button class="vypode-review-close" id="vypodeReviewClose">\u2715</button>
        </div>
        <div class="vypode-rating-section">
          <label>Rating (1-5 stars):</label>
          <div class="vypode-stars" id="vypodeStars">
            ${[1,2,3,4,5].map(i => `<button class="vypode-star" data-rating="${i}">\u2605</button>`).join('')}
          </div>
          <span class="vypode-rating-text" id="vypodeRatingText">No rating</span>
        </div>
        <div class="vypode-review-section">
          <label>Your review:</label>
          <div class="vypode-review-notice">Submitting creates a Letterboxd diary entry for today using this rating and review text.</div>
          <div class="vypode-dictate-row">
            <button class="vypode-mic-btn" id="vypodeMicBtn">Dictate</button>
            <span class="vypode-mic-hint">or just type below</span>
          </div>
          <div class="vypode-interim" id="vypodeInterim"></div>
          <textarea id="vypodeReviewText" placeholder="Write or dictate your review here..."></textarea>
        </div>
        <div class="vypode-review-actions">
          <button class="vypode-btn vypode-btn-cancel" id="vypodeReviewCancel">Cancel</button>
          <button class="vypode-btn vypode-btn-submit" id="vypodeReviewSubmit">Submit Review</button>
        </div>
        <div class="vypode-review-shortcuts">
          <span><b>1-5</b> stars &bull; <b>Esc</b> close &bull; <b>Enter</b> submit</span>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    setTimeout(() => panel.classList.add('visible'), 10);

    document.getElementById('vypodeReviewClose').addEventListener('click', hideReviewPanel);
    document.getElementById('vypodeReviewCancel').addEventListener('click', hideReviewPanel);
    document.getElementById('vypodeMicBtn').addEventListener('click', toggleListening);
    document.getElementById('vypodeReviewSubmit').addEventListener('click', () => {
      const reviewText = document.getElementById('vypodeReviewText').value.trim();
      const filmUrl = isListingPage ? filmDeck[currentDeckIndex].url : window.location.href;
      submitReview(filmUrl, reviewText, currentRating);
    });
    document.querySelectorAll('.vypode-star').forEach(btn => {
      btn.addEventListener('click', () => setRating(parseInt(btn.dataset.rating)));
    });
  }

  function hideReviewPanel() {
    reviewPanelVisible = false;
    stopListening();
    const panel = document.querySelector('.vypode-review-panel');
    if (panel) { panel.classList.remove('visible'); setTimeout(() => panel.remove(), 300); }
  }

  function isUserTyping() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  // ==================== SETTINGS PANEL ====================

  function showSettingsPanel() {
    if (settingsPanelVisible) return;
    settingsPanelVisible = true;

    const prefs = window.VypodeFilmState?.getPrefs() || {};
    const meta = window.VypodeFilmState?.getMeta() || {};
    const stats = window.VypodeFilmState?.getStats() || {};
    const lastSync = meta.lastSyncAt ? formatTimeAgo(meta.lastSyncAt) : 'Never';
    const safeUsername = letterboxdUsername ? escapeHtml(letterboxdUsername) : null;

    const panel = document.createElement('div');
    panel.className = 'vypode-settings-panel';
    panel.innerHTML = `
      <div class="vypode-settings-content">
        <div class="vypode-settings-header">
          <h3>Settings</h3>
          <button class="vypode-review-close" id="vypodeSettingsClose">\u2715</button>
        </div>

        <!-- Account Section -->
        <div class="vypode-settings-section">
          <div class="vypode-settings-section-title">Letterboxd Account</div>
          ${safeUsername
            ? `<div class="vypode-account-row">
                <span class="vypode-account-avatar">\ud83d\udc64</span>
                <span class="vypode-account-name">${safeUsername}</span>
                <span class="vypode-account-badge">Linked</span>
              </div>`
            : `<div class="vypode-account-row">
                <span class="vypode-account-warn">\u26a0\ufe0f Not logged in to Letterboxd</span>
              </div>
              <div class="vypode-settings-hint">Log in to Letterboxd and refresh to link your account.</div>`
          }
        </div>

        <!-- Sync Section -->
        <div class="vypode-settings-section">
          <div class="vypode-settings-section-title">Collection Sync</div>
          <div class="vypode-sync-row">
            <span id="vypodeSyncStatus" class="vypode-sync-status">Last sync: ${escapeHtml(lastSync)}</span>
            <button class="vypode-sync-btn" id="vypodeSyncBtn" ${!safeUsername ? 'disabled' : ''}>Sync now</button>
          </div>
          ${meta.syncCounts ? `<div class="vypode-sync-counts" id="vypodeSyncCounts">
            ${meta.syncCounts.watched || 0} watched &bull; ${meta.syncCounts.watchlist || 0} watchlist &bull; ${meta.syncCounts.liked || 0} liked
          </div>` : ''}
          <div class="vypode-settings-hint">Builds a local-only database on this device with watched films, posters, ratings, likes, and review text where available.</div>
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
        <div class="vypode-settings-section">
          <div class="vypode-settings-section-title">Profile Database</div>
          <div class="vypode-db-controls">
            <input type="search" id="vypodeDbSearch" placeholder="Search title or review">
            <select id="vypodeDbFilter">
              <option value="all">All films</option>
              <option value="watched">Watched</option>
              <option value="liked">Liked</option>
              <option value="watchlist">Watchlist</option>
              <option value="rated">Rated</option>
              <option value="reviewed">Reviewed</option>
              <option value="missing-rating">Missing rating</option>
              <option value="skipped">Skipped</option>
            </select>
            <select id="vypodeDbSort">
              <option value="title">Title A-Z</option>
              <option value="rating">Rating high-low</option>
              <option value="year">Year newest</option>
              <option value="updated">Recently updated</option>
            </select>
          </div>
          <div class="vypode-db-summary" id="vypodeDbSummary"></div>
          <div class="vypode-db-list" id="vypodeDbList"></div>
        </div>

        <!-- Data Section -->
        <div class="vypode-settings-section">
          <div class="vypode-settings-section-title">Data</div>
          <div class="vypode-data-actions">
            <button class="vypode-settings-btn vypode-btn-secondary" id="vypodeExport">Export data</button>
            <button class="vypode-settings-btn vypode-btn-secondary" id="vypodeImport">Import data</button>
            <button class="vypode-settings-btn vypode-btn-danger" id="vypodeClearSkipped">Clear skipped</button>
            <button class="vypode-settings-btn vypode-btn-danger" id="vypodeClearAll">Clear all local data</button>
          </div>
          <input type="file" id="vypodeImportFile" accept=".json" style="display:none">
        </div>

        <div class="vypode-settings-footer">Vypode v5.0.0</div>
      </div>
    `;

    document.body.appendChild(panel);
    setTimeout(() => panel.classList.add('visible'), 10);

    // Wire up event listeners
    document.getElementById('vypodeSettingsClose').addEventListener('click', hideSettingsPanel);
    document.getElementById('vypodeSyncBtn')?.addEventListener('click', () => runCollectionSync());

    // Filter toggles
    panel.querySelectorAll('.vypode-toggle').forEach(toggle => {
      toggle.addEventListener('change', () => {
        const pref = toggle.dataset.pref;
        window.VypodeFilmState?.setPref(pref, toggle.checked);
      });
    });

    bindDatabaseControls();
    renderDatabaseBrowser();

    // Export
    document.getElementById('vypodeExport').addEventListener('click', () => {
      const data = window.VypodeFilmState.exportData();
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vypode-export-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showFeedback('Data exported', 'watchlist');
    });

    // Import
    document.getElementById('vypodeImport').addEventListener('click', () => {
      document.getElementById('vypodeImportFile').click();
    });
    document.getElementById('vypodeImportFile').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const result = window.VypodeFilmState.importData(reader.result);
          if (result.success) {
            refreshSettingsStats();
            showFeedback(`Imported ${result.merged} film entries`, 'watchlist');
          } else {
            showFeedback('Import failed: ' + result.error, 'error');
          }
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
        window.VypodeFilmState.clearSkipped().then(() => {
          refreshSettingsStats();
          showFeedback('Skipped films cleared', 'watchlist');
        });
      }
    });

    // Clear all
    document.getElementById('vypodeClearAll').addEventListener('click', () => {
      if (confirm('Delete ALL local Vypode data on this device? This cannot be undone.')) {
        window.VypodeFilmState.clearAll().then(() => {
          chrome.storage.local.remove(['vypode_user'], () => {});
          refreshSettingsStats();
          showFeedback('All local data cleared', 'watch');
        });
      }
    });
  }

  function hideSettingsPanel() {
    settingsPanelVisible = false;
    const panel = document.querySelector('.vypode-settings-panel');
    if (panel) { panel.classList.remove('visible'); setTimeout(() => panel.remove(), 300); }
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
    for (const id of ['vypodeDbSearch', 'vypodeDbFilter', 'vypodeDbSort']) {
      document.getElementById(id)?.addEventListener('input', renderDatabaseBrowser);
      document.getElementById(id)?.addEventListener('change', renderDatabaseBrowser);
    }
  }

  function databaseOptions() {
    return {
      search: document.getElementById('vypodeDbSearch')?.value || '',
      filter: document.getElementById('vypodeDbFilter')?.value || 'all',
      sort: document.getElementById('vypodeDbSort')?.value || 'title'
    };
  }

  function renderDatabaseBrowser() {
    const list = document.getElementById('vypodeDbList');
    const summary = document.getElementById('vypodeDbSummary');
    if (!list || !summary || !window.VypodeFilmState?.query) return;

    const rows = window.VypodeFilmState.query(databaseOptions());
    const visible = rows.slice(0, 80);
    summary.textContent = rows.length
      ? `Showing ${visible.length} of ${rows.length} films`
      : 'No matching films yet. Run Collection Sync to build your local profile database.';

    list.innerHTML = visible.map(film => {
      const title = escapeHtml(film.title || film.slug);
      const year = film.year ? ` <span>${escapeHtml(film.year)}</span>` : '';
      const rating = film.ratingValue ? `${film.ratingValue}/5` : (film.rating ? escapeHtml(film.rating) : 'No rating');
      const badges = [
        film.watched ? 'Watched' : null,
        film.liked ? 'Liked' : null,
        film.watchlist ? 'Watchlist' : null,
        film.reviewText ? 'Review' : null
      ].filter(Boolean).map(label => `<span>${label}</span>`).join('');
      const poster = film.poster
        ? `<img src="${escapeHtml(film.poster)}" alt="">`
        : '<div class="vypode-db-poster-empty"></div>';
      return `
        <button type="button" class="vypode-db-row" data-slug="${escapeHtml(film.slug)}">
          ${poster}
          <span class="vypode-db-main">
            <strong>${title}${year}</strong>
            <small>${escapeHtml(rating)}</small>
            <span class="vypode-db-badges">${badges}</span>
          </span>
        </button>
      `;
    }).join('');

    list.querySelectorAll('.vypode-db-row').forEach(row => {
      row.addEventListener('click', () => showDatabaseDetail(row.dataset.slug));
    });
  }

  function showDatabaseDetail(slug) {
    const film = window.VypodeFilmState?.get?.(slug);
    if (!film) return;
    const existing = document.querySelector('.vypode-db-detail');
    if (existing) existing.remove();

    const detail = document.createElement('div');
    detail.className = 'vypode-db-detail';
    detail.innerHTML = `
      <button type="button" class="vypode-db-detail-close" aria-label="Close">\u2715</button>
      <div class="vypode-db-detail-body">
        ${film.poster ? `<img src="${escapeHtml(film.poster)}" alt="">` : ''}
        <div>
          <h4>${escapeHtml(film.title || slug)}${film.year ? ` <span>${escapeHtml(film.year)}</span>` : ''}</h4>
          <p>${film.ratingValue ? `Your rating: ${film.ratingValue}/5` : 'No rating stored'}</p>
          <p>${film.liked ? 'Liked' : 'Not liked'} &bull; ${film.watched ? 'Watched' : 'Not watched'}</p>
          ${film.reviewText ? `<blockquote>${escapeHtml(film.reviewText)}</blockquote>` : '<p>No review text stored.</p>'}
          ${film.url ? `<a href="${escapeHtml(film.url)}" target="_blank" rel="noopener noreferrer">Open film page</a>` : ''}
        </div>
      </div>
    `;
    document.body.appendChild(detail);
    detail.querySelector('.vypode-db-detail-close').addEventListener('click', () => detail.remove());
  }

  // ==================== UI CREATION ====================

  function createVypodeUI() {
    const film = getFilmData();
    const states = getStates();
    createVypodeOverlay(film, states, false);
  }

  async function createVypodeDeckUI() {
    let allFilms = getFilmsFromListing();
    if (allFilms.length === 0) {
      showFeedback('No films found on this page', 'error');
      return;
    }

    // Apply fresh poster filtering
    filmDeck = filterFilmDeck(allFilms);

    if (filmDeck.length === 0) {
      showFeedback(`All ${allFilms.length} films already in your collections — nothing new here!`, 'watchlist');
      return;
    }

    currentDeckIndex = 0;
    const film = filmDeck[0];
    createVypodeOverlay(
      film,
      { isWatched: film.isWatched, isLiked: film.isLiked, inWatchlist: film.inWatchlist },
      true
    );
    // Lazy-fetch film details for the first card
    enrichFilmData(film);
  }

  function createVypodeOverlay(film, states, isDeck) {
    const existing = document.querySelector('.vypode-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'vypode-overlay';

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
        <button class="vypode-nav-btn" id="vypodePrev" ${currentDeckIndex === 0 ? 'disabled' : ''}>&#8249; Prev</button>
        <span class="vypode-deck-counter">${currentDeckIndex + 1} / ${filmDeck.length}</span>
        <button class="vypode-nav-btn" id="vypodeNext">Next &#8250;</button>
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
          <div class="vypode-logo">VYPODE</div>
          ${filterBadge}
          <button class="vypode-review-btn" id="vypodeOpenReview" title="Write review (R)">Review</button>
          <button class="vypode-settings-btn-header" id="vypodeOpenSettings" title="Settings">\u2699</button>
          <button class="vypode-close" id="vypodeClose">\u2715</button>
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
        <div class="vypode-hints">
          <div class="vypode-hint"><span class="hint-dot amber"></span>\u2190 Watched</div>
          <div class="vypode-hint"><span class="hint-dot red"></span>\u2191 Like</div>
          <div class="vypode-hint"><span class="hint-dot green"></span>Watchlist \u2192</div>
          ${isDeck ? '<div class="vypode-hint"><span class="hint-dot blue"></span>\u2193 Skip</div>' : ''}
        </div>
        <div class="vypode-hints-sub">
          ${isDeck ? 'Swipe to act \u2022 <b>R</b> to review \u2022 <b>S</b> settings' : '<b>R</b> to write review \u2022 <b>S</b> settings'}
        </div>
        ${isDeck ? `<a href="${safeUrl}" target="_blank" class="vypode-open-link">Open film page \u2197</a>` : ''}
      </div>
      <div class="vypode-cursor-ring" id="vypodeCursor"><span class="vypode-cursor-label" id="vypodeCursorLabel"></span></div>
    `;

    document.body.appendChild(overlay);

    // Poster fallback (current card only)
    const posterImg = overlay.querySelector('#vypodeCard .vypode-card-bg');
    if (posterImg) {
      posterImg.addEventListener('error', function() {
        this.src = 'https://letterboxd.com/static/img/empty-poster-230.c6baa486.png';
      }, { once: true });
    }

    setupEventListeners(isDeck);
    vypodeVisible = true;
    isListingPage = isDeck;

    if (isDeck) {
      populateNextCard(filmDeck[currentDeckIndex + 1]);
      preloadNextPosters(currentDeckIndex + 1, 10);
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
    bg.src = film.poster || '';
    bg.alt = film.title || '';
    const title = next.querySelector('.vypode-card-title');
    if (title) title.textContent = film.title || '';
  }

  function populateCurrentCard(film) {
    const card = document.getElementById('vypodeCard');
    if (!card || !film) return;
    const bg = card.querySelector('.vypode-card-bg');
    bg.src = film.poster;
    bg.alt = film.title;
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
    const prevBtn = document.getElementById('vypodePrev');
    if (prevBtn) prevBtn.disabled = currentDeckIndex === 0;
    const openLink = document.querySelector('.vypode-open-link');
    if (openLink) openLink.href = film.url;
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
    if (!isListingPage || filmDeck.length === 0) return;
    populateCurrentCard(filmDeck[currentDeckIndex]);
    populateNextCard(filmDeck[currentDeckIndex + 1]);
    resetCardStack();
    updateProgress();
  }

  function goToPrevCard() {
    if (currentDeckIndex > 0) {
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

    if (!card) return;

    closeBtn?.addEventListener('click', hideVypode);
    overlay?.addEventListener('click', (e) => { if (e.target === overlay) hideVypode(); });
    reviewBtn?.addEventListener('click', showReviewPanel);
    settingsBtn?.addEventListener('click', showSettingsPanel);

    if (isDeck) {
      prevBtn?.addEventListener('click', goToPrevCard);
      nextBtn?.addEventListener('click', goToNextCard);
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
          isDeck ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'watch') : (animateAction('left'), performWatch());
        } else if (angle > -45 && angle < 45) {
          isDeck ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'watchlist') : (animateAction('right'), performWatchlist());
        } else if (angle < -45 && angle >= -135) {
          isDeck ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'like') : (animateAction('up'), performLike());
        } else if (angle > 45 && angle <= 135 && isDeck) {
          skipCurrentFilm();
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
        isDeck ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'watch') : (animateAction('left'), performWatch());
      }
      else if (currentZone === 'right') {
        isDeck ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'watchlist') : (animateAction('right'), performWatchlist());
      }
      else if (currentZone === 'up') {
        isDeck ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'like') : (animateAction('up'), performLike());
      }
      else if (currentZone === 'down' && isDeck) {
        skipCurrentFilm();
      }
    });

    document.removeEventListener('keydown', handleKeyDown);
    document.addEventListener('keydown', handleKeyDown);
  }

  function handleKeyDown(e) {
    if (!vypodeVisible) return;

    // Cmd/Ctrl+Z — undo last action (any time, even with no toast visible)
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey && !isUserTyping()) {
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
      if (e.key >= '1' && e.key <= '5' && !isUserTyping()) {
        e.preventDefault();
        setRating(parseInt(e.key));
      } else if (e.key === 'Enter' && !e.shiftKey && !isUserTyping()) {
        e.preventDefault();
        document.getElementById('vypodeReviewSubmit')?.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideReviewPanel();
      }
      return;
    }

    // Settings panel — Escape to close
    if (settingsPanelVisible) {
      if (e.key === 'Escape') {
        e.preventDefault();
        hideSettingsPanel();
      }
      return;
    }

    if (isProcessingAction) return;
    const card = document.getElementById('vypodeCard');
    if (!card) return;

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

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      isListingPage ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'watch') : (animateAction('left'), performWatch());
    }
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      isListingPage ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'watchlist') : (animateAction('right'), performWatchlist());
    }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      isListingPage ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'like') : (animateAction('up'), performLike());
    }
    else if (e.key === 'ArrowDown' && isListingPage) {
      e.preventDefault();
      skipCurrentFilm();
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
    hideReviewPanel();
    hideSettingsPanel();
    const overlay = document.querySelector('.vypode-overlay');
    if (overlay) { overlay.classList.add('hiding'); setTimeout(() => overlay.remove(), 300); }
    vypodeVisible = false;
    isListingPage = false;
    cleanupIframe();
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
    btn.textContent = pageType === 'listing' ? 'Vypode Deck' : 'Vypode';
    btn.title = pageType === 'listing' ? 'Browse films with Vypode swipe deck' : 'Open Vypode swipe interface';
    btn.addEventListener('click', () => {
      if (vypodeVisible) {
        hideVypode();
      } else {
        if (pageType === 'listing') {
          createVypodeDeckUI();
        } else {
          createVypodeUI();
        }
      }
    });
    document.body.appendChild(btn);
  }

  async function init() {
    // Initialize FilmState registry
    if (window.VypodeFilmState) {
      await window.VypodeFilmState.init();
    }

    // Detect account
    await initAccount();

    // Auto-open deck from next-page navigation
    if (window.location.hash === '#vypode-auto') {
      window.location.hash = '';
      setTimeout(() => { createToggleButton(); createVypodeDeckUI(); }, 1500);
      return;
    }

    setTimeout(createToggleButton, 1000);
  }

  init();
})();
