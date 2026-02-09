// VYPODE FOR LETTERBOXD - Content Script v1.3.2
// Background actions + auto-advance + auto-next-page + Voice Review + Star Rating
// v1.3.2: Fixed speech recognition stability, simplified submit to clipboard+open page
(function() {
  'use strict';
  if (window.vypodeInjected) return;
  window.vypodeInjected = true;

  let currentZone = 'neutral';
  let isOverCard = false;
  let vypodeVisible = false;
  let filmDeck = [];
  let currentDeckIndex = 0;
  let isListingPage = false;
  let isProcessingAction = false;
  let actionIframe = null;

  // Review & Rating state
  let reviewPanelVisible = false;
  let currentRating = 0;
  let recognition = null;
  let isListening = false;

  // Detect page type
  function detectPageType() {
    const path = window.location.pathname;
    if (path.match(/^\/film\/[^\/]+\/?$/)) {
      return 'single';
    } else if (path.includes('/films/') || path.includes('/watchlist') || path.includes('/list/')) {
      return 'listing';
    }
    return 'unknown';
  }

  // Extract film data from single film page
  function getFilmData() {
    const titleEl = document.querySelector('h1.headline-1');
    const yearEl = document.querySelector('.releaseyear a');
    const posterEl = document.querySelector('.film-poster img') || document.querySelector('.image');
    const ratingEl = document.querySelector('.average-rating .display-rating');
    const directorEl = document.querySelector('.contributor a');
    const genreEls = document.querySelectorAll('.text-sluglist a[href*="/films/genre/"]');
    return {
      title: titleEl?.textContent?.trim() || 'Unknown Film',
      year: yearEl?.textContent?.trim() || '',
      poster: posterEl?.src || '',
      rating: ratingEl?.textContent?.trim() || '',
      director: directorEl?.textContent?.trim() || '',
      genres: Array.from(genreEls).slice(0, 3).map(el => el.textContent.trim()),
      url: window.location.href
    };
  }

  // Extract all films from listing page
  function getFilmsFromListing() {
    const films = [];
    const posterContainers = document.querySelectorAll('.poster-container, .film-poster, .poster');

    posterContainers.forEach(container => {
      const link = container.querySelector('a[href*="/film/"]') || container.closest('a[href*="/film/"]');
      const img = container.querySelector('img');
      const filmPoster = container.closest('.poster-container') || container;

      if (link && img) {
        const href = link.getAttribute('href');
        const filmSlug = href.match(/\/film\/([^\/]+)/)?.[1];
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

  // Find next page URL
  function getNextPageUrl() {
    const nextLink = document.querySelector('.paginate-nextprev a.next') ||
                     document.querySelector('a[rel="next"]') ||
                     document.querySelector('.pagination a.next');
    return nextLink?.href || null;
  }

  // Find action buttons on single film page
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
    if (buttons.watchBtn) { buttons.watchBtn.click(); showFeedback('👁️ Marked as watched!', 'watch'); return true; }
    showFeedback('Could not find watch button', 'error'); return false;
  }

  function performLike() {
    const buttons = findButtons();
    if (buttons.likeBtn) { buttons.likeBtn.click(); showFeedback('❤️ Liked!', 'like'); return true; }
    showFeedback('Could not find like button', 'error'); return false;
  }

  function performWatchlist() {
    const buttons = findButtons();
    if (buttons.watchlistBtn) { buttons.watchlistBtn.click(); showFeedback('📋 Added to Watchlist!', 'watchlist'); return true; }
    showFeedback('Could not find watchlist button', 'error'); return false;
  }

  // Perform action in background via hidden iframe
  function performBackgroundAction(filmUrl, action) {
    if (isProcessingAction) return;
    isProcessingAction = true;

    const film = filmDeck[currentDeckIndex];
    showFeedback(`Processing ${action}...`, action);

    if (actionIframe) actionIframe.remove();
    actionIframe = document.createElement('iframe');
    actionIframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(actionIframe);

    actionIframe.onload = function() {
      try {
        const iframeDoc = actionIframe.contentDocument || actionIframe.contentWindow.document;

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

          if (btn) {
            btn.click();
            if (action === 'watch') film.isWatched = !film.isWatched;
            else if (action === 'like') film.isLiked = !film.isLiked;
            else if (action === 'watchlist') film.inWatchlist = !film.inWatchlist;
            film.actioned = true;
            const messages = { watch: '👁️ Marked as watched!', like: '❤️ Liked!', watchlist: '📋 Added to Watchlist!' };
            showFeedback(messages[action], action);
          } else {
            showFeedback('Could not find button', 'error');
          }

          setTimeout(() => {
            if (actionIframe) { actionIframe.remove(); actionIframe = null; }
            isProcessingAction = false;
            advanceToNextCard();
          }, 300);
        }, 800);
      } catch (e) {
        console.log('Iframe blocked, using fetch fallback');
        performFetchAction(filmUrl, action, film);
      }
    };

    actionIframe.onerror = function() {
      isProcessingAction = false;
      showFeedback('Error loading film', 'error');
      if (actionIframe) { actionIframe.remove(); actionIframe = null; }
    };

    actionIframe.src = filmUrl;
  }

  async function performFetchAction(filmUrl, action, film) {
    try {
      film.actioned = true;
      const messages = { watch: '👁️ Watched (will sync)', like: '❤️ Liked (will sync)', watchlist: '📋 Watchlist (will sync)' };
      showFeedback(messages[action], action);
      if (action === 'watch') film.isWatched = true;
      else if (action === 'like') film.isLiked = true;
      else if (action === 'watchlist') film.inWatchlist = true;
    } catch (e) {
      showFeedback('Error: ' + e.message, 'error');
    } finally {
      if (actionIframe) { actionIframe.remove(); actionIframe = null; }
      isProcessingAction = false;
      advanceToNextCard();
    }
  }

  // Submit review - copies to clipboard and opens film page
  function submitReview(filmUrl, reviewText, rating) {
    if (isProcessingAction) return;

    // Build review text with rating
    let fullReview = reviewText || '';
    const ratingStars = rating > 0 ? '★'.repeat(rating) + '☆'.repeat(5 - rating) : '';

    // Copy to clipboard
    if (fullReview || rating > 0) {
      const clipboardText = fullReview;
      navigator.clipboard.writeText(clipboardText).then(() => {
        if (fullReview) {
          showFeedback('📋 Review copied! Opening film page...', 'watchlist');
        } else {
          showFeedback('Opening film page to rate ' + ratingStars, 'watchlist');
        }
      }).catch(() => {
        showFeedback('Opening film page...', 'watch');
      });
    }

    // Open the film page to log/review
    const reviewUrl = filmUrl.replace(/\/?$/, '') + '/reviews/';
    setTimeout(() => {
      window.open(filmUrl, '_blank');
      hideReviewPanel();
      if (isListingPage) {
        filmDeck[currentDeckIndex].actioned = true;
        advanceToNextCard();
      }
    }, 500);
  }

  function advanceToNextCard() {
    if (currentDeckIndex < filmDeck.length - 1) {
      currentDeckIndex++;
      updateDeckCard();
      updateProgress();
    } else {
      const nextPageUrl = getNextPageUrl();
      if (nextPageUrl) {
        showFeedback('Loading next page...', 'watch');
        setTimeout(() => { window.location.href = nextPageUrl + '#vypode-auto'; }, 1000);
      } else {
        showFeedback('🎉 All done! No more pages.', 'watchlist');
      }
    }
  }

  function skipCurrentFilm() {
    filmDeck[currentDeckIndex].actioned = true;
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

  // ==================== REVIEW PANEL ====================

  function initSpeechRecognition() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      return null;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = false; // Use non-continuous mode for stability
    recognition.interimResults = true;
    recognition.lang = 'en-GB';
    recognition._shouldRestart = false;

    recognition.onresult = (event) => {
      const textarea = document.getElementById('vypodeReviewText');
      if (!textarea) return;

      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript + ' ';
        } else {
          interimTranscript = transcript;
        }
      }

      if (finalTranscript) {
        textarea.value += finalTranscript;
      }

      const interim = document.getElementById('vypodeInterim');
      if (interim) interim.textContent = interimTranscript;
    };

    recognition.onerror = (event) => {
      console.log('Speech recognition error:', event.error);
      // Only stop on fatal errors
      if (event.error === 'not-allowed') {
        showFeedback('Microphone access denied - check browser permissions', 'error');
        isListening = false;
        updateMicButton();
      } else if (event.error === 'no-speech') {
        // This is normal - just means silence, will auto-restart
        console.log('No speech detected, will restart...');
      }
      // Don't call stopListening here - let onend handle restart
    };

    recognition.onend = () => {
      const interim = document.getElementById('vypodeInterim');
      if (interim) interim.textContent = '';

      // Restart if we're still supposed to be listening
      if (isListening) {
        setTimeout(() => {
          if (isListening && recognition) {
            try {
              recognition.start();
            } catch(e) {
              console.log('Restart failed:', e);
            }
          }
        }, 100);
      }
    };

    return recognition;
  }

  function startListening() {
    // Create fresh recognition instance each time
    if (recognition) {
      try { recognition.stop(); } catch(e) {}
    }
    recognition = initSpeechRecognition();

    if (!recognition) {
      showFeedback('Speech recognition not supported in this browser', 'error');
      return;
    }

    isListening = true;
    updateMicButton();

    try {
      recognition.start();
      showFeedback('🎤 Listening... speak now', 'like');
    } catch (e) {
      console.error('Could not start recognition:', e);
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
    showFeedback('🛑 Stopped listening', 'watch');
  }

  function toggleListening() {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }

  function updateMicButton() {
    const micBtn = document.getElementById('vypodeMicBtn');
    if (micBtn) {
      micBtn.classList.toggle('listening', isListening);
      micBtn.innerHTML = isListening ? '🔴 Recording...' : '🎤 Dictate';
    }
  }

  function setRating(stars) {
    currentRating = stars;
    updateRatingDisplay();
  }

  function updateRatingDisplay() {
    const starContainer = document.getElementById('vypodeStars');
    if (!starContainer) return;

    const starBtns = starContainer.querySelectorAll('.vypode-star');
    starBtns.forEach((btn, i) => {
      btn.classList.toggle('active', i < currentRating);
    });

    const ratingText = document.getElementById('vypodeRatingText');
    if (ratingText) {
      if (currentRating > 0) {
        ratingText.textContent = '★'.repeat(currentRating) + ' (' + currentRating + '/5)';
      } else {
        ratingText.textContent = 'No rating';
      }
    }
  }

  function showReviewPanel() {
    if (reviewPanelVisible) return;
    reviewPanelVisible = true;
    currentRating = 0;

    const film = isListingPage ? filmDeck[currentDeckIndex] : getFilmData();

    const panel = document.createElement('div');
    panel.className = 'vypode-review-panel';
    panel.innerHTML = `
      <div class="vypode-review-content">
        <div class="vypode-review-header">
          <h3>Review: ${film.title}</h3>
          <button class="vypode-review-close" id="vypodeReviewClose">✕</button>
        </div>

        <div class="vypode-rating-section">
          <label>Rating (press 1-5 for stars):</label>
          <div class="vypode-stars" id="vypodeStars">
            ${[1,2,3,4,5].map(i => `<button class="vypode-star" data-rating="${i}">★</button>`).join('')}
          </div>
          <span class="vypode-rating-text" id="vypodeRatingText">No rating</span>
        </div>

        <div class="vypode-review-section">
          <label>Your review:</label>
          <div class="vypode-dictate-row">
            <button class="vypode-mic-btn" id="vypodeMicBtn">🎤 Dictate</button>
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
          <span>Shortcuts: <b>1-5</b> stars • <b>Shift</b> toggle panel • <b>Enter</b> submit • <b>Esc</b> close</span>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    setTimeout(() => panel.classList.add('visible'), 10);

    // Event listeners
    document.getElementById('vypodeReviewClose').addEventListener('click', hideReviewPanel);
    document.getElementById('vypodeReviewCancel').addEventListener('click', hideReviewPanel);
    document.getElementById('vypodeMicBtn').addEventListener('click', toggleListening);

    document.getElementById('vypodeReviewSubmit').addEventListener('click', () => {
      const reviewText = document.getElementById('vypodeReviewText').value.trim();
      const filmUrl = isListingPage ? filmDeck[currentDeckIndex].url : window.location.href;
      submitReview(filmUrl, reviewText, currentRating);
    });

    // Star rating clicks
    document.querySelectorAll('.vypode-star').forEach(btn => {
      btn.addEventListener('click', () => {
        setRating(parseInt(btn.dataset.rating));
      });
    });
  }

  function hideReviewPanel() {
    reviewPanelVisible = false;
    stopListening();
    const panel = document.querySelector('.vypode-review-panel');
    if (panel) {
      panel.classList.remove('visible');
      setTimeout(() => panel.remove(), 300);
    }
  }

  // ==================== UI CREATION ====================

  function createVypodeUI() {
    const film = getFilmData();
    const states = getStates();
    createVypodeOverlay(film, states, false);
  }

  function createVypodeDeckUI() {
    filmDeck = getFilmsFromListing();
    if (filmDeck.length === 0) {
      showFeedback('No films found on this page', 'error');
      return;
    }
    currentDeckIndex = 0;
    const film = filmDeck[0];
    createVypodeOverlay(film, { isWatched: film.isWatched, isLiked: film.isLiked, inWatchlist: film.inWatchlist }, true);
  }

  function createVypodeOverlay(film, states, isDeck) {
    const existing = document.querySelector('.vypode-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'vypode-overlay';

    const nextPageUrl = getNextPageUrl();
    const deckControls = isDeck ? `
      <div class="vypode-deck-nav">
        <button class="vypode-nav-btn" id="vypodePrev" ${currentDeckIndex === 0 ? 'disabled' : ''}>‹ Prev</button>
        <span class="vypode-deck-counter">${currentDeckIndex + 1} / ${filmDeck.length}</span>
        <button class="vypode-nav-btn" id="vypodeNext">Next ›</button>
      </div>
      <div class="vypode-progress-bar">
        <div class="vypode-progress-fill" style="width: ${((currentDeckIndex + 1) / filmDeck.length) * 100}%"></div>
      </div>
    ` : '';

    overlay.innerHTML = `
      <div class="vypode-container">
        <div class="vypode-header">
          <div class="vypode-logo">VYPODE</div>
          <button class="vypode-review-btn" id="vypodeOpenReview" title="Write review (Shift)">✏️ Review</button>
          <button class="vypode-close" id="vypodeClose">✕</button>
        </div>
        ${deckControls}
        <div class="vypode-card-area">
          <div class="vypode-card" id="vypodeCard">
            <img class="vypode-card-bg" src="${film.poster}" alt="${film.title}" onerror="this.src='https://letterboxd.com/static/img/empty-poster-230.c6baa486.png'">
            <div class="vypode-card-gradient"></div>
            <div class="vypode-glow-edge glow-right"></div>
            <div class="vypode-glow-edge glow-left"></div>
            <div class="vypode-glow-edge glow-up"></div>
            <div class="vypode-glow-edge glow-down"></div>
            <div class="vypode-swipe-overlay watch">WATCHED</div>
            <div class="vypode-swipe-overlay like">❤️ LIKE</div>
            <div class="vypode-swipe-overlay watchlist">WATCHLIST</div>
            <div class="vypode-swipe-overlay skip">SKIP</div>
            <div class="vypode-zone-indicator zone-left">👁️ WATCHED ←</div>
            <div class="vypode-zone-indicator zone-right">→ WATCHLIST 📋</div>
            <div class="vypode-zone-indicator zone-up">↑ LIKE ❤️</div>
            <div class="vypode-zone-indicator zone-down">↓ SKIP ⏭️</div>
            <div class="vypode-card-info">
              <div class="vypode-card-title">${film.title}</div>
              <div class="vypode-card-meta">
                ${film.year ? `<span>${film.year}</span>` : ''}
                ${film.rating ? `<span>·</span><span class="vypode-rating">★ ${film.rating}</span>` : ''}
                ${film.director ? `<span>·</span><span>${film.director}</span>` : ''}
              </div>
              <div class="vypode-card-genres">
                ${film.genres.map(g => `<span class="vypode-genre-tag">${g}</span>`).join('')}
              </div>
              <div class="vypode-card-states">
                ${states.isWatched ? '<span class="vypode-state watched">✓ Watched</span>' : ''}
                ${states.isLiked ? '<span class="vypode-state liked">❤️ Liked</span>' : ''}
                ${states.inWatchlist ? '<span class="vypode-state watchlist">📋 In Watchlist</span>' : ''}
              </div>
            </div>
          </div>
        </div>
        <div class="vypode-hints">
          <div class="vypode-hint"><span class="hint-dot amber"></span>← Watched</div>
          <div class="vypode-hint"><span class="hint-dot red"></span>↑ Like</div>
          <div class="vypode-hint"><span class="hint-dot green"></span>Watchlist →</div>
          ${isDeck ? '<div class="vypode-hint"><span class="hint-dot blue"></span>↓ Skip</div>' : ''}
        </div>
        <div class="vypode-hints-sub">
          ${isDeck ? 'Swipe to act • <b>Shift</b> to review • 1-5 to rate' : '<b>Shift</b> to write review • 1-5 to rate'}
        </div>
        ${isDeck ? `<a href="${film.url}" target="_blank" class="vypode-open-link">Open film page ↗</a>` : ''}
      </div>
      <div class="vypode-cursor-ring" id="vypodeCursor"><span class="vypode-cursor-label" id="vypodeCursorLabel"></span></div>
    `;

    document.body.appendChild(overlay);
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
      card.querySelector('.vypode-card-bg').src = film.poster;
      card.querySelector('.vypode-card-bg').alt = film.title;
      card.querySelector('.vypode-card-title').textContent = film.title;

      const metaEl = card.querySelector('.vypode-card-meta');
      metaEl.innerHTML = `
        ${film.year ? `<span>${film.year}</span>` : ''}
        ${film.rating ? `<span>·</span><span class="vypode-rating">★ ${film.rating}</span>` : ''}
        ${film.director ? `<span>·</span><span>${film.director}</span>` : ''}
      `;

      const statesEl = card.querySelector('.vypode-card-states');
      statesEl.innerHTML = `
        ${film.isWatched ? '<span class="vypode-state watched">✓ Watched</span>' : ''}
        ${film.isLiked ? '<span class="vypode-state liked">❤️ Liked</span>' : ''}
        ${film.inWatchlist ? '<span class="vypode-state watchlist">📋 In Watchlist</span>' : ''}
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

  function setupEventListeners(isDeck) {
    const card = document.getElementById('vypodeCard');
    const cursor = document.getElementById('vypodeCursor');
    const cursorLabel = document.getElementById('vypodeCursorLabel');
    const closeBtn = document.getElementById('vypodeClose');
    const overlay = document.querySelector('.vypode-overlay');
    const prevBtn = document.getElementById('vypodePrev');
    const nextBtn = document.getElementById('vypodeNext');
    const reviewBtn = document.getElementById('vypodeOpenReview');

    if (!card) return;

    closeBtn?.addEventListener('click', hideVypode);
    overlay?.addEventListener('click', (e) => { if (e.target === overlay) hideVypode(); });
    reviewBtn?.addEventListener('click', showReviewPanel);

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

    // If review panel is open, handle its shortcuts
    if (reviewPanelVisible) {
      // Number keys 1-5 for star rating (simple: 1=1 star, 2=2 stars, etc.)
      if (e.key >= '1' && e.key <= '5') {
        e.preventDefault();
        setRating(parseInt(e.key));
      } else if (e.key === 'Shift') {
        e.preventDefault();
        hideReviewPanel();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        const textarea = document.getElementById('vypodeReviewText');
        if (document.activeElement !== textarea) {
          e.preventDefault();
          document.getElementById('vypodeReviewSubmit')?.click();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideReviewPanel();
      }
      return;
    }

    if (isProcessingAction) return;
    const card = document.getElementById('vypodeCard');
    if (!card) return;

    // Shift to open review panel
    if (e.key === 'Shift') {
      e.preventDefault();
      showReviewPanel();
      return;
    }

    // Number keys 1-5 for quick rating (opens review panel and sets rating)
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

  function updateCursorAndCard(card, cursor, cursorLabel, zone, isDeck) {
    cursor.className = 'vypode-cursor-ring visible';
    resetCardVisuals(card);
    if (zone === 'right') {
      cursor.classList.add('zone-right'); cursorLabel.textContent = '📋';
      card.querySelector('.glow-right').style.opacity = 1;
      card.querySelector('.vypode-swipe-overlay.watchlist').style.opacity = 0.9;
      card.querySelector('.zone-right').classList.add('active');
      card.style.transform = 'perspective(800px) rotateY(3deg) translateX(8px)';
    } else if (zone === 'left') {
      cursor.classList.add('zone-left'); cursorLabel.textContent = '👁️';
      card.querySelector('.glow-left').style.opacity = 1;
      card.querySelector('.vypode-swipe-overlay.watch').style.opacity = 0.9;
      card.querySelector('.zone-left').classList.add('active');
      card.style.transform = 'perspective(800px) rotateY(-3deg) translateX(-8px)';
    } else if (zone === 'up') {
      cursor.classList.add('zone-up'); cursorLabel.textContent = '❤️';
      card.querySelector('.glow-up').style.opacity = 1;
      card.querySelector('.vypode-swipe-overlay.like').style.opacity = 0.9;
      card.querySelector('.zone-up').classList.add('active');
      card.style.transform = 'perspective(800px) rotateX(3deg) translateY(-6px)';
    } else if (zone === 'down' && isDeck) {
      cursor.classList.add('zone-down'); cursorLabel.textContent = '⏭️';
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
    if (statesContainer) statesContainer.innerHTML = (states.isWatched ? '<span class="vypode-state watched">✓ Watched</span>' : '') + (states.isLiked ? '<span class="vypode-state liked">❤️ Liked</span>' : '') + (states.inWatchlist ? '<span class="vypode-state watchlist">📋 In Watchlist</span>' : '');
  }

  function hideVypode() {
    hideReviewPanel();
    const overlay = document.querySelector('.vypode-overlay');
    if (overlay) { overlay.classList.add('hiding'); setTimeout(() => overlay.remove(), 300); }
    vypodeVisible = false;
    isListingPage = false;
    if (actionIframe) { actionIframe.remove(); actionIframe = null; }
    document.removeEventListener('keydown', handleKeyDown);
  }

  function createToggleButton() {
    const existing = document.querySelector('.vypode-toggle-btn');
    if (existing) return;

    const pageType = detectPageType();
    if (pageType === 'unknown') return;

    const btn = document.createElement('button');
    btn.className = 'vypode-toggle-btn';
    btn.innerHTML = pageType === 'listing' ? '🎴 Vypode Deck' : '🎴 Vypode';
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

  function init() {
    if (window.location.hash === '#vypode-auto') {
      window.location.hash = '';
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          setTimeout(() => { createToggleButton(); createVypodeDeckUI(); }, 1500);
        });
      } else {
        setTimeout(() => { createToggleButton(); createVypodeDeckUI(); }, 1500);
      }
      return;
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(createToggleButton, 1000));
    } else {
      setTimeout(createToggleButton, 1000);
    }
  }

  init();
})();
