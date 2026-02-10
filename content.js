// VYPODE FOR LETTERBOXD — Content Script v5.0.0
// Background actions + auto-advance + auto-next-page + Voice Review + Star Rating
// v5.0.0: FilmState registry, fresh poster filtering, durable skip,
//         account awareness, collection sync, settings panel, cloud sync
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

  // ── HTML escaping ───────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
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
      poster: posterEl?.src || '',
      rating: ratingEl?.textContent?.trim() || '',
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

        let title = img.alt || container.getAttribute('data-film-name') || filmSlug?.replace(/-/g, ' ') || 'Unknown';
        title = title.replace(/^Poster for /i, '');

        let posterUrl = img.src || img.dataset.src || '';
        if (posterUrl.includes('empty-poster') || !posterUrl) {
          posterUrl = img.srcset?.split(',')[0]?.trim()?.split(' ')[0] || '';
        }
        if (posterUrl) {
          posterUrl = posterUrl.replace(/-0-\d+-0-\d+-crop/, '-0-460-0-690-crop')
                               .replace(/-\d+-\d+-\d+-\d+-crop/, '-0-460-0-690-crop');
        }

        const ratingEl = filmPoster.querySelector('.rating') || filmPoster.querySelector('[class*="rating"]');
        const rating = ratingEl?.textContent?.trim() || '';

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

        films.push({
          title: title.charAt(0).toUpperCase() + title.slice(1),
          year: '',
          poster: posterUrl,
          rating: rating,
          director: '',
          genres: [],
          url: 'https://letterboxd.com' + href,
          slug: filmSlug,
          isWatched,
          isLiked,
          inWatchlist,
          actioned: false
        });
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

  function getNextPageUrl() {
    const nextLink = document.querySelector('.paginate-nextprev a.next') ||
                     document.querySelector('a[rel="next"]') ||
                     document.querySelector('.pagination a.next');
    return nextLink?.href || null;
  }

  // ── Action buttons (single film page) ──────────────────────────────

  function findButtons() {
    return {
      watchBtn: document.querySelector('[data-track-action="Watched"]') || document.querySelector('.action.-watch') || document.querySelector('.film-watch-link-target'),
      likeBtn: document.querySelector('[data-track-action="Liked"]') || document.querySelector('.action.-like') || document.querySelector('.film-like-link-target'),
      watchlistBtn: document.querySelector('[data-track-action="Watchlist"]') || document.querySelector('.action.-watchlist') || document.querySelector('.film-watch-list-link-target')
    };
  }

  function getStates() {
    return {
      isWatched: document.querySelector('.action.-watch.-checked, .icon-watched.-on, .film-watch-link-target.icon-watched.-on') !== null,
      isLiked: document.querySelector('.action.-like.-checked, .icon-like.-on, .film-like-link-target.icon-like.-on') !== null,
      inWatchlist: document.querySelector('.action.-watchlist.-checked, .icon-watchlist.-on, .film-watch-list-link-target.icon-watchlist.-on') !== null
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

    // Optimistic update — mark film and persist immediately so the user
    // can keep swiping without waiting for Letterboxd to respond.
    if (action === 'watch') film.isWatched = !film.isWatched;
    else if (action === 'like') film.isLiked = !film.isLiked;
    else if (action === 'watchlist') film.inWatchlist = !film.inWatchlist;
    film.actioned = true;

    if (film.slug && window.VypodeFilmState) {
      const flagMap = { watch: 'watched', like: 'liked', watchlist: 'watchlist' };
      window.VypodeFilmState.setFlag(film.slug, flagMap[action], true, 'userAction');
    }

    const messages = { watch: 'Marked as watched!', like: 'Liked!', watchlist: 'Added to Watchlist!' };
    showFeedback(messages[action], action);

    // Advance to the next card right away
    advanceToNextCard();
    isProcessingAction = false;

    // Queue the actual Letterboxd action for background processing
    actionQueue.push({ filmUrl, action });
    processActionQueue();
  }

  function processActionQueue() {
    if (isProcessingQueue || actionQueue.length === 0) return;
    isProcessingQueue = true;

    const { filmUrl, action } = actionQueue.shift();

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(iframe);

    const timeout = setTimeout(() => {
      iframe.remove();
      isProcessingQueue = false;
      processActionQueue();
    }, 10000);

    iframe.onload = function() {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

        setTimeout(() => {
          let btn = null;
          if (action === 'watch') {
            btn = iframeDoc.querySelector('[data-track-action="Watched"]') ||
                  iframeDoc.querySelector('.action.-watch') ||
                  iframeDoc.querySelector('.film-watch-link-target');
          } else if (action === 'like') {
            btn = iframeDoc.querySelector('[data-track-action="Liked"]') ||
                  iframeDoc.querySelector('.action.-like') ||
                  iframeDoc.querySelector('.film-like-link-target');
          } else if (action === 'watchlist') {
            btn = iframeDoc.querySelector('[data-track-action="Watchlist"]') ||
                  iframeDoc.querySelector('.action.-watchlist') ||
                  iframeDoc.querySelector('.film-watch-list-link-target');
          }

          if (btn) btn.click();

          setTimeout(() => {
            clearTimeout(timeout);
            iframe.remove();
            isProcessingQueue = false;
            processActionQueue();
          }, 300);
        }, 800);
      } catch (e) {
        clearTimeout(timeout);
        iframe.remove();
        isProcessingQueue = false;
        processActionQueue();
      }
    };

    iframe.onerror = function() {
      clearTimeout(timeout);
      iframe.remove();
      isProcessingQueue = false;
      processActionQueue();
    };

    iframe.src = filmUrl;
  }

  // ── Review submission ───────────────────────────────────────────────

  function submitReview(filmUrl, reviewText, rating) {
    if (isProcessingAction) return;
    isProcessingAction = true;

    const fullReview = reviewText || '';
    if (!fullReview && rating <= 0) {
      isProcessingAction = false;
      return;
    }

    showFeedback('Submitting review...', 'watchlist');

    if (actionIframe) actionIframe.remove();
    actionIframe = document.createElement('iframe');
    actionIframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1024px;height:768px;opacity:0;pointer-events:none;';
    document.body.appendChild(actionIframe);

    iframeTimeout = setTimeout(() => {
      reviewFallback(filmUrl, fullReview, rating, 'Review timed out');
    }, 15000);

    actionIframe.onerror = function() {
      reviewFallback(filmUrl, fullReview, rating, 'Error loading film page');
    };

    actionIframe.onload = function() {
      try {
        const iframeDoc = actionIframe.contentDocument || actionIframe.contentWindow.document;

        setTimeout(() => {
          const reviewBtn = iframeDoc.querySelector('.add-this-film');
          if (!reviewBtn) {
            reviewFallback(filmUrl, fullReview, rating, 'Could not find review button');
            return;
          }

          reviewBtn.click();

          let pollCount = 0;
          const pollInterval = setInterval(() => {
            pollCount++;
            const modal = iframeDoc.querySelector('#add-film');
            if (modal) {
              clearInterval(pollInterval);
              fillAndSubmitReview(iframeDoc, modal, filmUrl, fullReview, rating);
            } else if (pollCount >= 20) {
              clearInterval(pollInterval);
              reviewFallback(filmUrl, fullReview, rating, 'Review form did not open');
            }
          }, 250);
        }, 1500);
      } catch (e) {
        reviewFallback(filmUrl, fullReview, rating, 'Error accessing film page');
      }
    };

    actionIframe.src = filmUrl;
  }

  function fillAndSubmitReview(iframeDoc, modal, filmUrl, reviewText, rating) {
    if (reviewText) {
      const textarea = modal.querySelector('textarea') ||
                       iframeDoc.querySelector('#diary-entry-review');
      if (textarea) {
        textarea.value = reviewText;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    if (rating > 0) {
      const lbRating = rating * 2; // Letterboxd uses half-star scale 1-10
      const rateWidget = modal.querySelector('.rateit');
      if (rateWidget && rateWidget.dataset.rateAction) {
        const csrf = iframeDoc.querySelector('input[name="__csrf"]')?.value;
        if (csrf) {
          const ratingData = new FormData();
          ratingData.set('rating', lbRating);
          ratingData.set('__csrf', csrf);
          const rateUrl = rateWidget.dataset.rateAction.startsWith('http')
            ? rateWidget.dataset.rateAction
            : new URL(rateWidget.dataset.rateAction, filmUrl).href;
          fetch(rateUrl, { method: 'POST', body: ratingData }).catch(() => {});
        }
      }
      const ratingInput = modal.querySelector('input[name="rating"]');
      if (ratingInput) {
        ratingInput.value = lbRating;
        ratingInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    setTimeout(() => {
      const submitBtn = iframeDoc.querySelector('#diary-entry-submit-button') ||
                        modal.querySelector('input[type="submit"]') ||
                        modal.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.click();
        clearTimeout(iframeTimeout);
        setTimeout(() => {
          showFeedback('Review submitted!', 'watchlist');
          cleanupIframe();
          hideReviewPanel();
          if (isListingPage) {
            filmDeck[currentDeckIndex].actioned = true;
            advanceToNextCard();
          }
        }, 2000);
      } else {
        reviewFallback(filmUrl, reviewText, rating, 'Could not find submit button');
      }
    }, 500);
  }

  function reviewFallback(filmUrl, reviewText, rating, reason) {
    clearTimeout(iframeTimeout);
    const ratingStars = rating > 0 ? '\u2605'.repeat(rating) + '\u2606'.repeat(5 - rating) : '';
    const clipboardText = ((ratingStars ? ratingStars + '\n' : '') + reviewText).trim();

    const openPage = () => {
      setTimeout(() => {
        window.open(filmUrl, '_blank');
        cleanupIframe();
        hideReviewPanel();
        if (isListingPage) {
          filmDeck[currentDeckIndex].actioned = true;
          advanceToNextCard();
        }
      }, 500);
    };

    if (clipboardText) {
      navigator.clipboard.writeText(clipboardText).then(() => {
        showFeedback(reason + ' \u2014 review copied, opening film page', 'error');
        openPage();
      }).catch(() => {
        showFeedback(reason + ' \u2014 opening film page', 'error');
        openPage();
      });
    } else {
      showFeedback(reason + ' \u2014 opening film page', 'error');
      openPage();
    }
  }

  // ── Deck navigation ─────────────────────────────────────────────────

  function advanceToNextCard() {
    if (currentDeckIndex < filmDeck.length - 1) {
      currentDeckIndex++;
      updateDeckCard();
      updateProgress();
    } else {
      const nextPageUrl = getNextPageUrl();
      if (nextPageUrl) {
        showFeedback('Syncing actions & loading next page...', 'watch');
        waitForQueueDrain(() => { window.location.href = nextPageUrl + '#vypode-auto'; });
      } else {
        showFeedback('All done! No more pages.', 'watchlist');
      }
    }
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
    const film = filmDeck[currentDeckIndex];
    film.actioned = true;

    // Durable skip: persist to FilmState
    if (film.slug && window.VypodeFilmState) {
      window.VypodeFilmState.setFlag(film.slug, 'skipped', true, 'userAction');
    }

    showFeedback('Skipped', 'skip');
    advanceToNextCard();
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
      const results = { watched: 0, watchlist: 0, liked: 0 };

      // 1. Sync watched films from /{username}/films/
      const watchedSlugs = await fetchAllFilmSlugs(`/${letterboxdUsername}/films/`);
      results.watched = watchedSlugs.length;

      // 2. Sync watchlist from /{username}/watchlist/
      const watchlistSlugs = await fetchAllFilmSlugs(`/${letterboxdUsername}/watchlist/`);
      results.watchlist = watchlistSlugs.length;

      // 3. Sync liked films from /{username}/likes/films/
      const likedSlugs = await fetchAllFilmSlugs(`/${letterboxdUsername}/likes/films/`);
      results.liked = likedSlugs.length;

      // Build bulk update map
      const slugMap = {};
      for (const slug of watchedSlugs) {
        if (!slugMap[slug]) slugMap[slug] = {};
        slugMap[slug].watched = true;
      }
      for (const slug of watchlistSlugs) {
        if (!slugMap[slug]) slugMap[slug] = {};
        slugMap[slug].watchlist = true;
      }
      for (const slug of likedSlugs) {
        if (!slugMap[slug]) slugMap[slug] = {};
        slugMap[slug].liked = true;
      }

      // Apply to local registry
      const updated = window.VypodeFilmState.bulkSetFromSync(slugMap, 'collectionSync');

      const duration = Date.now() - startTime;
      window.VypodeFilmState.setSyncMeta(new Date().toISOString(), duration, results);

      isSyncing = false;
      updateSyncUI('done');
      showFeedback(`Sync complete: ${results.watched} watched, ${results.watchlist} watchlist, ${results.liked} liked`, 'watchlist');

      // Push to cloud if signed in
      try {
        chrome.runtime.sendMessage({ type: 'vypode', action: 'cloudPush' });
      } catch (e) { /* background may not be ready */ }

      return { success: true, results, updated, duration };

    } catch (e) {
      isSyncing = false;
      updateSyncUI('error');
      showFeedback('Sync failed: ' + e.message, 'error');
      return { success: false, error: e.message };
    }
  }

  // Fetch all film slugs from paginated Letterboxd pages
  async function fetchAllFilmSlugs(basePath) {
    const slugs = [];
    let page = 1;
    const maxPages = 100; // Safety cap: 100 pages x 72 films = 7,200 films max

    while (page <= maxPages) {
      const url = `https://letterboxd.com${basePath}page/${page}/`;

      // Rate limit: 1 request per second
      if (page > 1) await sleep(1000);

      try {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) break;

        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Extract film slugs from poster links
        const links = doc.querySelectorAll('a[href*="/film/"]');
        let foundOnPage = 0;

        for (const link of links) {
          const match = link.getAttribute('href')?.match(/\/film\/([^\/]+)/);
          if (match && match[1]) {
            const slug = match[1];
            if (!slugs.includes(slug)) {
              slugs.push(slug);
              foundOnPage++;
            }
          }
        }

        // Stop condition: no films found (empty page = past the end)
        if (foundOnPage === 0) break;

        // Stop condition: no next page link
        const hasNext = doc.querySelector('.paginate-nextprev a.next') ||
                        doc.querySelector('a[rel="next"]');
        if (!hasNext) break;

        page++;
      } catch (e) {
        console.warn('Vypode sync: failed to fetch page', page, e);
        break;
      }
    }

    return slugs;
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

  // ── Listen for background messages ──────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== 'vypode') return;
    if (msg.action === 'triggerSync') {
      // Background alarm triggered a sync
      runCollectionSync();
    }
  });

  // ==================== REVIEW PANEL ====================

  function initSpeechRecognition() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) return null;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-GB';

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

  function setRating(stars) {
    currentRating = stars;
    updateRatingDisplay();
  }

  function updateRatingDisplay() {
    const starContainer = document.getElementById('vypodeStars');
    if (!starContainer) return;
    starContainer.querySelectorAll('.vypode-star').forEach((btn, i) => {
      btn.classList.toggle('active', i < currentRating);
    });
    const ratingText = document.getElementById('vypodeRatingText');
    if (ratingText) {
      ratingText.textContent = currentRating > 0 ? '\u2605'.repeat(currentRating) + ' (' + currentRating + '/5)' : 'No rating';
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
          <label>Rating (click stars or press 1-5 when not typing):</label>
          <div class="vypode-stars" id="vypodeStars">
            ${[1,2,3,4,5].map(i => `<button class="vypode-star" data-rating="${i}">\u2605</button>`).join('')}
          </div>
          <span class="vypode-rating-text" id="vypodeRatingText">No rating</span>
        </div>
        <div class="vypode-review-section">
          <label>Your review:</label>
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
          <span>Shortcuts: <b>1-5</b> stars (when not typing) &bull; <b>Esc</b> close &bull; <b>Enter</b> submit</span>
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
          ${meta.syncCounts ? `<div class="vypode-sync-counts">
            ${meta.syncCounts.watched || 0} watched &bull; ${meta.syncCounts.watchlist || 0} watchlist &bull; ${meta.syncCounts.liked || 0} liked
          </div>` : ''}
          <div class="vypode-settings-hint">Syncs your watched, liked, and watchlist films from Letterboxd. Auto-syncs once per day.</div>
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
            <div class="vypode-stat"><span class="vypode-stat-num">${stats.total || 0}</span><span class="vypode-stat-label">Total</span></div>
            <div class="vypode-stat"><span class="vypode-stat-num vypode-stat-watched">${stats.watched || 0}</span><span class="vypode-stat-label">Watched</span></div>
            <div class="vypode-stat"><span class="vypode-stat-num vypode-stat-liked">${stats.liked || 0}</span><span class="vypode-stat-label">Liked</span></div>
            <div class="vypode-stat"><span class="vypode-stat-num vypode-stat-watchlist">${stats.watchlist || 0}</span><span class="vypode-stat-label">Watchlist</span></div>
            <div class="vypode-stat"><span class="vypode-stat-num vypode-stat-skipped">${stats.skipped || 0}</span><span class="vypode-stat-label">Skipped</span></div>
          </div>
        </div>

        <!-- Cloud Section -->
        <div class="vypode-settings-section">
          <div class="vypode-settings-section-title">Cloud Backup</div>
          <div id="vypodeCloudStatus" class="vypode-cloud-status">Checking...</div>
          <div class="vypode-cloud-actions">
            <button class="vypode-settings-btn" id="vypodeCloudSignIn">Sign in with Google</button>
            <button class="vypode-settings-btn vypode-btn-secondary" id="vypodeCloudPull" disabled>Restore from cloud</button>
            <button class="vypode-settings-btn vypode-btn-secondary" id="vypodeCloudPush" disabled>Back up to cloud</button>
          </div>
          <div class="vypode-settings-hint">Sign in to back up your film registry across devices.</div>
        </div>

        <!-- Data Section -->
        <div class="vypode-settings-section">
          <div class="vypode-settings-section-title">Data</div>
          <div class="vypode-data-actions">
            <button class="vypode-settings-btn vypode-btn-secondary" id="vypodeExport">Export data</button>
            <button class="vypode-settings-btn vypode-btn-secondary" id="vypodeImport">Import data</button>
            <button class="vypode-settings-btn vypode-btn-danger" id="vypodeClearSkipped">Clear skipped</button>
            <button class="vypode-settings-btn vypode-btn-danger" id="vypodeClearAll">Clear all data</button>
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

    // Cloud status check
    checkCloudStatus();

    // Cloud sign in
    document.getElementById('vypodeCloudSignIn').addEventListener('click', async () => {
      const btn = document.getElementById('vypodeCloudSignIn');
      btn.textContent = 'Signing in...';
      btn.disabled = true;
      try {
        const result = await sendToBackground('cloudSignIn');
        if (result.success) {
          showFeedback('Signed in to cloud: ' + result.email, 'watchlist');
          checkCloudStatus();
        } else {
          showFeedback('Sign in failed: ' + (result.error || 'Unknown error'), 'error');
          btn.textContent = 'Sign in with Google';
          btn.disabled = false;
        }
      } catch (e) {
        showFeedback('Sign in failed', 'error');
        btn.textContent = 'Sign in with Google';
        btn.disabled = false;
      }
    });

    // Cloud pull
    document.getElementById('vypodeCloudPull').addEventListener('click', async () => {
      showFeedback('Restoring from cloud...', 'watch');
      try {
        const result = await sendToBackground('cloudPull');
        if (result.success && result.registry) {
          const merged = window.VypodeFilmState.mergeFromCloud(result.registry);
          showFeedback(`Restored ${result.count} films from cloud (${merged} updated)`, 'watchlist');
        } else {
          showFeedback('Restore failed: ' + (result.error || 'No data'), 'error');
        }
      } catch (e) {
        showFeedback('Restore failed', 'error');
      }
    });

    // Cloud push
    document.getElementById('vypodeCloudPush').addEventListener('click', async () => {
      showFeedback('Backing up to cloud...', 'watch');
      try {
        const result = await sendToBackground('cloudPush');
        if (result.success) {
          showFeedback(`Backed up ${result.count} films to cloud`, 'watchlist');
        } else {
          showFeedback('Backup failed: ' + (result.error || 'Unknown'), 'error');
        }
      } catch (e) {
        showFeedback('Backup failed', 'error');
      }
    });

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
        const result = window.VypodeFilmState.importData(reader.result);
        if (result.success) {
          showFeedback(`Imported ${result.merged} film entries`, 'watchlist');
        } else {
          showFeedback('Import failed: ' + result.error, 'error');
        }
      };
      reader.readAsText(file);
    });

    // Clear skipped
    document.getElementById('vypodeClearSkipped').addEventListener('click', () => {
      if (confirm('Clear all skipped films? They will appear in your deck again.')) {
        window.VypodeFilmState.clearSkipped();
        showFeedback('Skipped films cleared', 'watchlist');
      }
    });

    // Clear all
    document.getElementById('vypodeClearAll').addEventListener('click', () => {
      if (confirm('Delete ALL Vypode data? This cannot be undone.')) {
        window.VypodeFilmState.clearAll().then(() => {
          showFeedback('All data cleared', 'watch');
        });
      }
    });
  }

  function hideSettingsPanel() {
    settingsPanelVisible = false;
    const panel = document.querySelector('.vypode-settings-panel');
    if (panel) { panel.classList.remove('visible'); setTimeout(() => panel.remove(), 300); }
  }

  async function checkCloudStatus() {
    const statusEl = document.getElementById('vypodeCloudStatus');
    const signInBtn = document.getElementById('vypodeCloudSignIn');
    const pullBtn = document.getElementById('vypodeCloudPull');
    const pushBtn = document.getElementById('vypodeCloudPush');
    if (!statusEl) return;

    try {
      const result = await sendToBackground('getCloudStatus');
      if (result.signedIn) {
        statusEl.textContent = 'Signed in as ' + (result.email || 'Unknown');
        statusEl.style.color = '#00c853';
        if (signInBtn) { signInBtn.textContent = 'Sign out'; signInBtn.onclick = handleCloudSignOut; }
        if (pullBtn) pullBtn.disabled = false;
        if (pushBtn) pushBtn.disabled = false;
      } else {
        statusEl.textContent = 'Not signed in';
        statusEl.style.color = 'rgba(255,255,255,0.5)';
      }
    } catch (e) {
      statusEl.textContent = 'Cloud unavailable';
      statusEl.style.color = 'rgba(255,255,255,0.3)';
    }
  }

  async function handleCloudSignOut() {
    try {
      await sendToBackground('cloudSignOut');
      showFeedback('Signed out from cloud', 'watch');
      checkCloudStatus();
    } catch (e) {
      showFeedback('Sign out failed', 'error');
    }
  }

  function sendToBackground(action, data) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'vypode', action, data }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response || {});
        }
      });
    });
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

    // Poster fallback
    const posterImg = overlay.querySelector('.vypode-card-bg');
    if (posterImg) {
      posterImg.addEventListener('error', function() {
        this.src = 'https://letterboxd.com/static/img/empty-poster-230.c6baa486.png';
      }, { once: true });
    }

    setupEventListeners(isDeck);
    vypodeVisible = true;
    isListingPage = isDeck;
  }

  function updateDeckCard() {
    if (!isListingPage || filmDeck.length === 0) return;

    const film = filmDeck[currentDeckIndex];
    const card = document.getElementById('vypodeCard');
    const prevBtn = document.getElementById('vypodePrev');
    const openLink = document.querySelector('.vypode-open-link');

    if (!card) return;

    card.style.opacity = '0';
    card.style.transform = 'scale(0.95)';

    setTimeout(() => {
      const bgImg = card.querySelector('.vypode-card-bg');
      bgImg.src = film.poster;
      bgImg.alt = film.title;
      card.querySelector('.vypode-card-title').textContent = film.title;

      const metaEl = card.querySelector('.vypode-card-meta');
      metaEl.innerHTML = `
        ${film.year ? `<span>${escapeHtml(film.year)}</span>` : ''}
        ${film.rating ? `<span>\u00b7</span><span class="vypode-rating">\u2605 ${escapeHtml(film.rating)}</span>` : ''}
        ${film.director ? `<span>\u00b7</span><span>${escapeHtml(film.director)}</span>` : ''}
      `;

      const statesEl = card.querySelector('.vypode-card-states');
      statesEl.innerHTML = `
        ${film.isWatched ? '<span class="vypode-state watched">\u2713 Watched</span>' : ''}
        ${film.isLiked ? '<span class="vypode-state liked">Liked</span>' : ''}
        ${film.inWatchlist ? '<span class="vypode-state watchlist">In Watchlist</span>' : ''}
      `;

      if (prevBtn) prevBtn.disabled = currentDeckIndex === 0;
      if (openLink) openLink.href = film.url;

      card.style.opacity = '1';
      card.style.transform = '';
    }, 150);

    updateProgress();
  }

  function goToPrevCard() {
    if (currentDeckIndex > 0) {
      currentDeckIndex--;
      updateDeckCard();
    }
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
      nextBtn?.addEventListener('click', skipCurrentFilm);
    }

    card.addEventListener('mouseenter', () => { isOverCard = true; cursor.classList.add('visible'); });
    card.addEventListener('mouseleave', () => { isOverCard = false; currentZone = 'neutral'; cursor.classList.remove('visible'); cursor.className = 'vypode-cursor-ring'; resetCardVisuals(card); });

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
        animateAction('left');
        setTimeout(() => { isDeck ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'watch') : performWatch(); }, 300);
      }
      else if (currentZone === 'right') {
        animateAction('right');
        setTimeout(() => { isDeck ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'watchlist') : performWatchlist(); }, 300);
      }
      else if (currentZone === 'up') {
        animateAction('up');
        setTimeout(() => { isDeck ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'like') : performLike(); }, 300);
      }
      else if (currentZone === 'down' && isDeck) {
        animateAction('down');
        setTimeout(() => skipCurrentFilm(), 300);
      }
    });

    document.addEventListener('keydown', handleKeyDown);
  }

  function handleKeyDown(e) {
    if (!vypodeVisible) return;

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
      setTimeout(() => setRating(parseInt(e.key)), 100);
      return;
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      animateAction('left');
      setTimeout(() => { isListingPage ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'watch') : performWatch(); }, 300);
    }
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      animateAction('right');
      setTimeout(() => { isListingPage ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'watchlist') : performWatchlist(); }, 300);
    }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      animateAction('up');
      setTimeout(() => { isListingPage ? performBackgroundAction(filmDeck[currentDeckIndex].url, 'like') : performLike(); }, 300);
    }
    else if (e.key === 'ArrowDown' && isListingPage) {
      e.preventDefault();
      animateAction('down');
      setTimeout(() => skipCurrentFilm(), 300);
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
    card.style.transition = 'transform 0.4s ease, opacity 0.4s ease';
    if (direction === 'right') card.style.transform = 'translateX(300px) rotate(20deg)';
    else if (direction === 'left') card.style.transform = 'translateX(-300px) rotate(-20deg)';
    else if (direction === 'up') card.style.transform = 'translateY(-200px) scale(1.1)';
    else if (direction === 'down') card.style.transform = 'translateY(200px) scale(0.9)';
    card.style.opacity = '0.5';
    setTimeout(() => {
      card.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      card.style.transform = '';
      card.style.opacity = '1';
      if (!isListingPage) setTimeout(refreshStates, 500);
    }, 400);
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
