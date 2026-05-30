'use strict';

function renderPopup(result) {
  const user = result.vypode_user;
  const state = result.vypode_state;

  const nameEl = document.getElementById('accountName');
  const statusEl = document.getElementById('accountStatus');
  if (user && user.username) {
    nameEl.textContent = user.username;
    statusEl.textContent = 'Linked';
    statusEl.className = 'status linked';
  } else {
    nameEl.textContent = 'No account linked';
    statusEl.textContent = 'Log in to Letterboxd and visit any page';
    statusEl.className = 'status unlinked';
  }

  if (state && state.slugs) {
    const slugs = state.slugs;
    let watched = 0;
    let liked = 0;
    let watchlist = 0;
    let skipped = 0;
    let rated = 0;
    let reviewed = 0;
    for (const slug in slugs) {
      const e = slugs[slug];
      if (!e || typeof e !== 'object') continue;
      if (e.watched) watched++;
      if (e.liked) liked++;
      if (e.watchlist) watchlist++;
      if (e.skipped) skipped++;
      if (e.ratingValue || e.rating) rated++;
      if (e.reviewText) reviewed++;
    }
    document.getElementById('statWatched').textContent = watched;
    document.getElementById('statLiked').textContent = liked;
    document.getElementById('statWatchlist').textContent = watchlist;
    document.getElementById('statSkipped').textContent = skipped;
    document.getElementById('statRated').textContent = rated;
    document.getElementById('statReviewed').textContent = reviewed;
  } else {
    document.getElementById('statWatched').textContent = '0';
    document.getElementById('statLiked').textContent = '0';
    document.getElementById('statWatchlist').textContent = '0';
    document.getElementById('statSkipped').textContent = '0';
    document.getElementById('statRated').textContent = '0';
    document.getElementById('statReviewed').textContent = '0';
  }
}

// Load account status and stats from chrome.storage. This must live in an
// external file because Manifest V3 extension pages block inline scripts.
if (globalThis.chrome?.storage?.local) {
  chrome.storage.local.get(['vypode_user', 'vypode_state'], renderPopup);
} else {
  renderPopup({});
}
