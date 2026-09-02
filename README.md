# Swipe for Letterboxd v6.3.0-beta.7

> Formerly **Vypode for Letterboxd** — renamed to **Swipe for Letterboxd** in v6.1.0. Internal storage keys and APIs are unchanged, so existing local data carries over.


A Chrome extension that adds a swipe-style interface and a local profile database for Letterboxd. It helps you move through films quickly, hide titles you have already handled, and search your own watched history by title, rating, liked status, and review text where Letterboxd exposes it.

## What's New in v6.3.0-beta.7

- **Fresh account check before every review** — Swipe now confirms the signed-in
  Letterboxd account from a fresh, uncached film page before it submits. A stale
  tab cannot attach a review to a different account after a login change.
- **Clear All recovery is safer** — clearing local film data also forgets the
  current tab's cached account. A verified review can relink the same account
  immediately, including when Chrome retained an empty legacy account shell.
  Other open tabs adopt the cleared state, and stale background saves cannot
  reclaim or repopulate it.
- **Account actions stay fenced** — Watched, Like, and Watchlist remain blocked
  while cleared state is unclaimed. The final identity check now follows the
  film-data request, closing the account-switch window before review delivery.
- **Popup recovers without a reload** — after that verified relink, the toolbar
  popup recognises the active session and enables Sync again. A failed or
  mismatched verification marks the cached session inactive.
- **Reviewed with pinned Matt Pocock skills** — the repository now contains a
  pinned, auditable set of review, diagnosis, TDD, and design skills plus a
  project-specific security and release checklist. These development files are
  excluded from the runtime ZIP.

## What's New in v6.3.0-beta.6

- **Reviews work immediately after clearing local data** — after using *Clear
  local film data*, you can open Review and submit without refreshing the page
  or performing another action first.
- **Clear still forgets the saved account** — the account is linked again only
  when you explicitly save a new review draft, and a draft can never replace a
  different active Letterboxd account.

## What's New in v6.3.0-beta.5

- **Press K to start a trailer** — on a Letterboxd `/trailer/` page, **K** now
  starts the unopened YouTube player without requiring a trackpad click.
- **Reliable keyboard controls** — after **K** activates the trailer, **K** or
  **Space** sends play/pause directly, without requiring iframe focus or a click.
- **Discoverable and isolated** — a visible *Play trailer (K)* control appears
  on trailer pages. The shortcut ignores typing, modified keys, repeats, other
  Letterboxd pages, and unrelated or untrusted iframe URLs.
- **Visible deck actions on every card** — Watched, Like, Watchlist, and Skip
  now have labelled 44px buttons as well as swipe and arrow-key controls. The
  deck also scales to short and narrow windows without hiding its controls.
- **Safer reviews and account actions** — review drafts are saved per account
  and film, review options include date, rewatch, spoilers, tags, and like, and
  Letterboxd actions are durably queued before dispatch and checked afterward;
  optimistic local changes roll back when Letterboxd confirms a failure.
- **More useful profile database** — watched-date and genre filters, watched-date
  sorting, progressive result loading, film details, and individual skipped-film
  restore controls make larger local libraries easier to manage.
- **Useful extension popup** — the toolbar popup now shows extension health,
  pending account actions, and clear entry points for resuming Swipe, syncing
  your local profile, and opening settings when a supported Letterboxd tab is
  active.
- **Keyboard accessibility** — interactive Swipe controls have a consistent,
  high-contrast focus indicator, with reduced-motion and forced-colour support.
- **Repeatable release builds** — `npm run package` creates a deterministic ZIP
  and SHA-256 checksum. Continuous integration checks syntax, runs the full test
  suite, builds the ZIP twice, and verifies that both hashes match.

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
- **Snappier** — the next card's metadata is prefetched, and database results
  render in batches so large libraries do not create thousands of rows at once.
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
- **Export/import** — Save or restore your Swipe registry as JSON.

There is no third-party cloud backup in this release. Your film registry is stored in Chrome storage on this device; only small filter preferences use Chrome's built-in sync storage when available.

## Installation

### Testing v6.3.0-beta.7

1. Download and unzip `swipe-for-letterboxd-v6.3.0-beta.7.zip` from the beta release.
2. Open `chrome://extensions/`, enable **Developer mode**, and choose **Load unpacked**.
3. Select the unzipped folder containing `manifest.json`.
4. Open a Letterboxd listing and launch **Swipe Deck**. Press **T** or use the
   *Trailer* control; the trailer opens in a new tab without advancing the card.
5. On the trailer page, press **K** once. The YouTube trailer starts; use **K**
   or **Space** afterward to pause and resume it.
6. Open **Review** and test Dictate. The button changes to Recording only after
   the browser starts recognition; Stop and Submit preserve the final words.
7. In Brave, **System dictation** focuses the review box and gives the macOS
   shortcut. Browser speech recognition can also be checked in Chrome.
8. To test pagination, enable **Settings → Deck Behaviour → Open next Letterboxd
   page automatically** and finish the last card on a page.

### Build a validated ZIP

The release archive contains only the files Chrome needs at runtime. Its file
order, timestamps, and permissions are normalized so repeat builds from the
same source in the same supported environment produce the same SHA-256 checksum.
CI verifies this by comparing two independently generated archives on Ubuntu.

```sh
npm ci
npm run release:check
```

The ZIP and checksum are written to `dist/`. To use a different destination,
run `sh scripts/package-extension.sh /path/to/output`.

### From Chrome Web Store

Coming soon.

### Manual Installation

1. Open the project's [Releases](https://github.com/leathalobaidi/vypode-letterboxd/releases)
   page and choose the newest release you want to test.
2. Under **Assets**, download `swipe-for-letterboxd-v<version>.zip` and its
   matching `swipe-for-letterboxd-v<version>.sha256` checksum file.
3. Optionally verify the download with `shasum -a 256 -c <checksum-file>` on
   macOS, or `sha256sum -c <checksum-file>` on Linux.
4. Unzip the release asset into its own folder.
5. Open Chrome or Brave and go to `chrome://extensions/`.
6. Enable **Developer mode** and click **Load unpacked**.
7. Select the unzipped runtime folder containing `manifest.json`.

The folder should include:

```text
swipe-for-letterboxd-v<version>/
├── manifest.json
├── content.js
├── background.js
├── film-state.js
├── popup.html
├── popup.js
├── styles.css
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## How to Use

### Film Pages

On pages like `letterboxd.com/film/parasite/`, click the **Swipe** button in the bottom-right corner and use the card actions to mark watched, like, add to watchlist, or review.

### Listing Pages

On pages like `letterboxd.com/films/popular/`, click **Swipe Deck**. The deck starts with fresh films only, based on your local registry and filter settings. Use the arrows, swipe zones, or keyboard shortcuts to act on each film.

### Extension Popup

Select the Swipe toolbar icon to check whether the current tab is supported,
see unfinished Letterboxd actions, and use **Resume Swipe**, **Sync profile**, or
**Swipe settings**. Actions stay disabled until the popup finds a compatible
Letterboxd tab, and profile sync also requires an active Letterboxd login.

## Controls

| Action | Mouse | Keyboard |
| --- | --- | --- |
| Mark as watched | Watched button or left zone | Left arrow |
| Like | Like button or top zone | Up arrow |
| Add to watchlist | Watchlist button or right zone | Right arrow |
| Skip | Skip button or bottom zone | Down arrow |
| Open trailer | Trailer control | T |
| Start / pause trailer on its trailer page | Play trailer button or YouTube controls | K, then K / Space |
| Review | Review button | R |
| Settings | Gear icon | S |
| Close | Click outside card or X | Escape |

**Skip is local only.** It hides the film from future Swipe decks on this
device; it does not change your Letterboxd account. After a skip, Swipe advances
to the next card. If it was the last card, Swipe either loads the next listing
page in place or, when automatic next-page navigation is enabled, opens that
page after the five-second Undo window. Restore individual skips from the
Profile Database.

## Collection Sync

Open Settings and click **Sync now** while logged into Letterboxd. Swipe fetches public profile pages from your Letterboxd account:

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

Large histories can take a few minutes because Swipe paginates through Letterboxd respectfully and fetches review text as optional metadata.

## Privacy

**Swipe for Letterboxd is local-first and collects no data for the developer.** There is no server, no analytics, and no developer-side account.

- **Where your data lives.** Your film registry — titles, years, ratings, liked/watched/watchlist status, and review text where Letterboxd exposes it — is stored only in your own browser via `chrome.storage` on your device. Filter preferences use Chrome's built-in sync storage. Nothing is transmitted to the developer.
- **Account identifier.** Swipe detects and stores your Letterboxd username and
  a matching local account ID so data from different profiles stays separated.
  These identifiers remain in your browser and are never sent to the developer.
- **What it reads.** To build that local database it reads your own Letterboxd profile pages, which requires you to be signed in. It reads only what it needs to record your watch history on your device.
- **What it changes.** When you mark watched/liked/watchlist or submit a review, it acts on your real Letterboxd account using your active session — the same as if you clicked those controls yourself. On an explicit Review Submit, Swipe sends the review or rating, diary date, tags, rewatch/spoiler/like options, and a transient CSRF token directly to Letterboxd over HTTPS. The token is never stored.
- **URLs and actions.** Swipe handles the current Letterboxd URL, film/profile/list
  URLs, and the watched, like, watchlist, skip, and review choices needed for its
  disclosed features. It does not monitor browsing or interactions outside supported
  Letterboxd pages, log unrelated clicks or keystrokes, or send any of this data to
  the developer.
- **Dictation and trailers.** Dictation uses the speech-recognition service supplied by your browser or operating system; depending on the browser, audio may be processed by the browser vendor's service. Swipe never receives or stores the audio. Opening a trailer visits Letterboxd's trailer page, which may load a YouTube player under Letterboxd's and YouTube's privacy policies.
- **Why Chrome asks for storage access.** The `storage` permission keeps your
  film registry and Swipe preferences in Chrome storage. `unlimitedStorage`
  prevents larger Letterboxd histories, poster URLs, ratings, and review text
  from being silently truncated by the normal extension storage quota. Swipe
  does not use these permissions to read arbitrary files on your computer.
- **Why Swipe can access Letterboxd.** The `https://letterboxd.com/*` host
  permission lets the extension read supported Letterboxd pages, sync your own
  collections, open trailer controls, and carry out the watched/liked/watchlist
  actions you request. The `https://api.letterboxd.com/*` host permission lets
  the extension service worker send only a review submission that you explicitly
  confirm to Letterboxd's fixed production-log endpoint.

Swipe uses the account, page, form, and activity data it handles only to provide
and improve the user-facing features described here. It does not sell that data,
use it for advertising or credit decisions, transfer it for unrelated purposes,
or give the developer or other people access to it for unrelated processing.
Content that you explicitly submit to Letterboxd is handled according to your
Letterboxd account and privacy settings. This is Swipe's Limited Use disclosure
under the Chrome Web Store User Data Policy.

This section serves as the extension's privacy policy.

## Letterboxd, requests, and your account

Swipe for Letterboxd has no developer-operated server. Its film registry stays in
your browser on your device; small preferences may use Chrome's built-in sync
storage. Account actions go directly from your logged-in browser session to
Letterboxd.

- **Authenticated requests.** A full Collection Sync issues many requests to `letterboxd.com` as you (paginating watched films, watchlist, and likes, plus optional review-text pages). Swipe throttles these (sequential paging with delays, low-concurrency review fetching) and backs off on `429`/`503`, but a large library still means a meaningful burst of traffic. Sync only when you intend to.
- **Account-changing actions.** Marking watched/liked/watchlist and submitting reviews write to your real Letterboxd account, using your active session. Review submission sends the review/rating/date/tags/options and transient CSRF token directly to Letterboxd's API. That endpoint is not public or documented, so it may change or break without notice.
- **Your responsibility.** Use Swipe for Letterboxd in accordance with [Letterboxd's Terms of Use](https://letterboxd.com/terms-of-use/). It is an unofficial, independent tool, not affiliated with or endorsed by Letterboxd. Use at your own risk.

## Profile Database

Settings includes a **Profile Database** section where you can:

- Search by title, slug, rating text, or review text.
- Filter by status, genre, or watched date.
- Sort by title, rating, year, watched date, or recently updated.
- Load large result sets progressively instead of rendering the whole library at once.
- Open a detail view with poster, rating, liked/watched state, stored review text, and a link back to Letterboxd.
- Restore one skipped film at a time from the list or its detail view.

## Data Management

In Settings you can:

- **Export data** as JSON.
- **Import data** from a previous Swipe or Vypode export.
- **Clear skipped** to let skipped films appear again.
- **Clear local film data** to remove the registry, local account link, unsent
  action recovery records, review drafts, and sync metadata from this device.
  Your small interface preferences remain in Chrome sync. If an account action
  or review may already have reached Letterboxd, Swipe retains only a minimal
  account/film verification record so it cannot repeat the action blindly; the
  record is removed after Swipe verifies the film or you confirm that you
  checked it on Letterboxd. Review text and CSRF tokens are never retained in
  these records.

## Supported Pages

- Exact film pages: `letterboxd.com/film/<slug>/`
- Trailer pages: `letterboxd.com/film/<slug>/trailer/` (trailer playback control only)
- Popular film pages: `letterboxd.com/films/popular/*`
- Decade and genre pages: `letterboxd.com/films/decade/*`, `letterboxd.com/films/genre/*`
- User film pages: `letterboxd.com/*/films/*`
- User watchlists: `letterboxd.com/*/watchlist/*`
- User lists: `letterboxd.com/*/list/*`

## Requirements

- A Chromium browser with Manifest V3 support, such as Chrome or Brave.
- Logged into Letterboxd for collection sync and actions that modify your account.

## Troubleshooting

**Button not appearing?**

Refresh the Letterboxd page, make sure the extension is enabled in `chrome://extensions/`, and confirm you are on a supported page.

**All films filtered?**

Your current page may contain only films already in your local registry. Open Settings and temporarily turn off one or more deck filters.

**Sync taking too long?**

Large accounts can take a few minutes. Keep the Letterboxd tab open until the sync completes.

**Review submit failed or says the outcome is uncertain?**

Make sure you are logged into Letterboxd. Swipe keeps the draft and panel open.
Failures confirmed before any request was sent can be retried. If Swipe says the
outcome is uncertain, check the film in your Letterboxd diary first; Swipe blocks
another submission until you explicitly confirm that you checked. For a film
already in your watched history, edit the existing entry on Letterboxd, or select
Rewatch and confirm only when you deliberately want a new diary entry.

**Dictate says it is unavailable or never starts?**

In browsers that expose speech recognition, allow microphone access for
`letterboxd.com` and for the browser in the operating-system settings. Brave
uses system-dictation guidance because its browser speech-recognition service
is not dependable for this extension. On macOS, focus the review box and use
your configured Dictation shortcut, commonly Fn/Globe twice.

**K does not start the trailer?**

Make sure the address ends in `/trailer/` and wait for the YouTube thumbnail to
appear. Press **K** again if the browser took longer than usual to create the
player. Browser media settings can still block playback; once the shortcut is
active, a further **K** or **Space** sends play/pause to the embedded player.

## Migration from v4.0

v6.0 preserves older local film state and upgrades entries as they are loaded. Run Collection Sync after installing to populate the richer profile database.

---

Made with film love.
