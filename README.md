# Swipe for Letterboxd v6.3.0-beta.3

> Formerly **Vypode for Letterboxd** — renamed to **Swipe for Letterboxd** in v6.1.0. Internal storage keys and APIs are unchanged, so existing local data carries over.


A Chrome extension that adds a swipe-style interface and a local profile database for Letterboxd. It helps you move through films quickly, hide titles you have already handled, and search your own watched history by title, rating, liked status, and review text where Letterboxd exposes it.

## What's New in v6.3.0-beta.3

- **Trailer shortcut** — press **T** on a Swipe deck card, or select the visible
  *Trailer* control, to open that film's Letterboxd trailer page in a new tab.
  The current card and deck position stay unchanged.
- **Trailer availability** — Swipe checks the film details it already loads and
  disables the control when Letterboxd does not list a trailer. Validated film
  slugs are used directly, including titles whose Letterboxd slug contains a
  year or differs from the displayed title.
- **Reliable dictation state** — the review panel now says *Requesting* until
  the browser confirms recording has started, reports microphone, service,
  network, language, and no-speech failures, and never loops endlessly after
  an error.
- **Safer final words** — Stop finishes recognition gracefully, Cancel aborts
  it, and Submit waits briefly for the final transcript. If the speech engine
  times out, the review stays open for you to check before submitting again.
- **Brave and unsupported-browser fallback** — when browser speech recognition
  is unavailable or never starts, Swipe focuses the review box and explains how
  to use system dictation instead of showing a false Recording state.

## What's New in v6.3.0-beta.2

- **Final-card stall fixed** — choosing an action that is already active (such
  as Watchlist on a film already in your watchlist) now consumes the card and
  triggers next-page navigation without sending a duplicate Letterboxd action.
- **Automatic real page navigation (beta)** — Settings → Deck Behaviour now
  includes *Open next Letterboxd page automatically*. When enabled, advancing
  past the final card follows Letterboxd's real Next link in the same tab and
  reopens Swipe Deck after the new page loads.
- **Safe by default** — the setting is opt-in. With it disabled, v6.2's
  continuous in-place page loading is unchanged.
- **Undo-safe transitions** — automatic navigation waits until the five-second
  Undo window has closed and waits for queued Letterboxd actions before leaving
  the page. Closing Swipe or disabling the setting cancels a pending move.
- **Pagination guardrails** — only a different, same-origin Letterboxd Next URL
  is followed. Fully filtered pages continue with a ten-jump loop guard, and
  the deck stops normally when there is no next page.

## What's New in v6.2.0

- **Future-proof film detection** — the deck now also reads Letterboxd's new
  React (`LazyPoster`) grid markup, already live on member/profile pages,
  including before poster images hydrate. One unified extractor replaces two
  duplicated scrapers, so listing pages, fetched next pages, and the new
  markup all behave identically.
- **CSV export in Letterboxd's import format** — Settings → Data → *Export CSV
  (Letterboxd)* writes your watched films (title, year, director, rating,
  watch date, review) as a file `letterboxd.com/import` accepts. Your
  local-only database is now fully portable.
- **No more dead-end deck clicks** — on AJAX-loaded grids (e.g. Films →
  Popular) the deck waits for films to arrive instead of failing with
  "No films found".
- **Filter changes keep your place** — re-applying deck filters now refilters
  the full accumulated deck (across auto-loaded pages) instead of rescraping
  only the first page.
- **Snappier** — the next card's metadata is prefetched, and database search
  is debounced so big libraries don't rescan on every keystroke.
- **Cleaner data** — browsing a listing no longer re-stamps fresh
  `watchedAt` timestamps onto films you watched long ago.

## What's New in v6.0.2

- **No lost user actions** — A deliberate mark (watched/liked/etc.) can no longer be overwritten by a background sync that reconciles in the same instant across tabs.
- **Smoother large libraries** — On big histories, rapid swipes are coalesced into fewer storage writes (flushed on tab close), avoiding a full re-save per action.
- **Letterboxd disclosure** — README now documents Sync's request volume, account-changing actions, and Terms-of-Use responsibility.

## What's New in v6.0.1

- **Corrupted-storage safety** — Malformed persisted data (non-object `slugs`/`_meta`) no longer crashes extension load; it falls back to an empty registry.
- **Throttle-resilient sync** — A `429`/`503` from Letterboxd is retried with backoff (honouring `Retry-After`) instead of aborting the whole sync.
- **Politer review fetching** — Review-text enrichment runs at lower concurrency with a short inter-request pause.

## What's New in v6.0

- **Fresh poster filtering** — Deck mode hides films you have already watched, liked, added to watchlist, or skipped.
- **Local profile database** — Collection Sync builds a device-local registry of watched films with titles, posters, ratings, likes, and available review text.
- **Database browser** — Settings includes search, filters, sorting, per-film detail, and counts for watched, liked, watchlist, skipped, rated, and reviewed films.
- **Durable skip** — Skipped films stay hidden across sessions until you clear them.
- **Account linking** — Detects your Letterboxd username from the page while you are logged in.
- **Export/import** — Save or restore your Vypode registry as JSON.

There is no third-party cloud backup in this release. Your film registry is stored in Chrome storage on this device; only small filter preferences use Chrome's built-in sync storage when available.

## Installation

### Testing v6.3.0-beta.3

1. Download and unzip `swipe-for-letterboxd-v6.3.0-beta.3.zip` from the beta release.
2. Open `chrome://extensions/`, enable **Developer mode**, and choose **Load unpacked**.
3. Select the unzipped folder containing `manifest.json`.
4. Open a Letterboxd listing and launch **Swipe Deck**. Press **T** or use the
   *Trailer* control; the trailer opens in a new tab without advancing the card.
5. Open **Review** and test Dictate. The button changes to Recording only after
   the browser starts recognition; Stop and Submit preserve the final words.
6. In Brave, **System dictation** focuses the review box and gives the macOS
   shortcut. Browser speech recognition can also be checked in Chrome.
7. To test pagination, enable **Settings → Deck Behaviour → Open next Letterboxd
   page automatically** and finish the last card on a page.

### From Chrome Web Store

Coming soon.

### Manual Installation

1. Download the extension from `https://github.com/leathalobaidi/vypode-letterboxd`.
2. Click **Code** then **Download ZIP**.
3. Unzip `vypode-letterboxd-main.zip`.
4. Open Chrome and go to `chrome://extensions/`.
5. Enable **Developer mode**.
6. Click **Load unpacked**.
7. Select the unzipped folder containing `manifest.json`.

The folder should include:

```text
vypode-letterboxd-main/
├── manifest.json
├── content.js
├── background.js
├── film-state.js
├── popup.html
├── popup.js
├── styles.css
├── icons/
└── README.md
```

## How to Use

### Film Pages

On pages like `letterboxd.com/film/parasite/`, click the **Vypode** button in the bottom-right corner and use the card actions to mark watched, like, add to watchlist, or review.

### Listing Pages

On pages like `letterboxd.com/films/popular/`, click **Vypode Deck**. The deck starts with fresh films only, based on your local registry and filter settings. Use the arrows, swipe zones, or keyboard shortcuts to act on each film.

## Controls

| Action | Mouse | Keyboard |
| --- | --- | --- |
| Mark as watched | Left zone + click | Left arrow |
| Like | Top zone + click | Up arrow |
| Add to watchlist | Right zone + click | Right arrow |
| Skip | Bottom zone + click | Down arrow |
| Open trailer | Trailer control | T |
| Review | Review button | R |
| Settings | Gear icon | S |
| Close | Click outside card or X | Escape |

## Collection Sync

Open Settings and click **Sync now** while logged into Letterboxd. Vypode fetches public profile pages from your Letterboxd account:

- `/{username}/films/` for watched films
- `/{username}/watchlist/` for watchlist films
- `/{username}/likes/films/` for liked films
- Review links on watched films when Letterboxd exposes them in the listing

Sync stores normalized film records locally in `chrome.storage.local`:

```json
{
  "parasite-2019": {
    "title": "Parasite",
    "year": "2019",
    "poster": "https://...",
    "url": "https://letterboxd.com/film/parasite-2019/",
    "ratingValue": 5,
    "reviewText": "My review text",
    "watched": true,
    "liked": true,
    "watchlist": false,
    "skipped": false,
    "source": "collectionSync"
  }
}
```

Large histories can take a few minutes because Vypode paginates through Letterboxd respectfully and fetches review text as optional metadata.

## Privacy

**Swipe for Letterboxd is local-first and collects no data for the developer.** There is no server, no analytics, and no developer-side account.

- **Where your data lives.** Your film registry — titles, years, ratings, liked/watched/watchlist status, and review text where Letterboxd exposes it — is stored only in your own browser via `chrome.storage` on your device. Filter preferences use Chrome's built-in sync storage. Nothing is transmitted to the developer.
- **What it reads.** To build that local database it reads your own Letterboxd profile pages, which requires you to be signed in. It reads only what it needs to record your watch history on your device.
- **What it changes.** When you mark watched/liked/watchlist or submit a review, it acts on your real Letterboxd account using your active session — the same as if you clicked those controls yourself.
- **Dictation and trailers.** Dictation uses the speech-recognition service supplied by your browser or operating system; depending on the browser, audio may be processed by the browser vendor's service. Swipe never receives or stores the audio. Opening a trailer visits Letterboxd's trailer page, which may load a YouTube player under Letterboxd's and YouTube's privacy policies.

This section serves as the extension's privacy policy.

## Letterboxd, requests, and your account

Swipe for Letterboxd acts entirely from inside your own logged-in browser session — it has no server and stores nothing off your device.

- **Authenticated requests.** A full Collection Sync issues many requests to `letterboxd.com` as you (paginating watched films, watchlist, and likes, plus optional review-text pages). Swipe throttles these (sequential paging with delays, low-concurrency review fetching) and backs off on `429`/`503`, but a large library still means a meaningful burst of traffic. Sync only when you intend to.
- **Account-changing actions.** Marking watched/liked/watchlist and submitting reviews write to your real Letterboxd account, using your active session. Review submission posts to a Letterboxd endpoint that is not a public, documented API, so it may change or break without notice.
- **Your responsibility.** Use Swipe for Letterboxd in accordance with [Letterboxd's Terms of Use](https://letterboxd.com/terms-of-use/). It is an unofficial, independent tool, not affiliated with or endorsed by Letterboxd. Use at your own risk.

## Profile Database

Settings includes a **Profile Database** section where you can:

- Search by title, slug, rating text, or review text.
- Filter by all, watched, liked, watchlist, rated, reviewed, missing rating, or skipped.
- Sort by title, rating, year, or recently updated.
- Open a detail view with poster, rating, liked/watched state, stored review text, and a link back to Letterboxd.

## Data Management

In Settings you can:

- **Export data** as JSON.
- **Import data** from a previous Vypode export.
- **Clear skipped** to let skipped films appear again.
- **Clear all local data** to remove the registry, sync metadata, and saved preferences on this device.

## Supported Pages

- Film pages: `letterboxd.com/film/*`
- Popular film pages: `letterboxd.com/films/popular/*`
- Decade and genre pages: `letterboxd.com/films/decade/*`, `letterboxd.com/films/genre/*`
- User film pages: `letterboxd.com/*/films/*`
- User watchlists: `letterboxd.com/*/watchlist/*`
- User lists: `letterboxd.com/*/list/*`

## Requirements

- Chrome browser with Manifest V3 support.
- Logged into Letterboxd for collection sync and actions that modify your account.

## Troubleshooting

**Button not appearing?**

Refresh the Letterboxd page, make sure the extension is enabled in `chrome://extensions/`, and confirm you are on a supported page.

**All films filtered?**

Your current page may contain only films already in your local registry. Open Settings and temporarily turn off one or more deck filters.

**Sync taking too long?**

Large accounts can take a few minutes. Keep the Letterboxd tab open until the sync completes.

**Review submit failed?**

Make sure you are logged into Letterboxd. Vypode keeps the review panel open so you can retry.

**Dictate says it is unavailable or never starts?**

Allow microphone access for `letterboxd.com` and for your browser in the
operating-system settings. Brave uses system-dictation guidance because its
browser speech-recognition service is not dependable for this extension.
On macOS, focus the review box and use your configured Dictation shortcut,
commonly Fn/Globe twice.

## Migration from v4.0

v6.0 preserves older local film state and upgrades entries as they are loaded. Run Collection Sync after installing to populate the richer profile database.

---

Made with film love.
