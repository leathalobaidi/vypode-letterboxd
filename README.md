# Vypode for Letterboxd v6.0

A Chrome extension that adds a swipe-style interface and a local profile database for Letterboxd. It helps you move through films quickly, hide titles you have already handled, and search your own watched history by title, rating, liked status, and review text where Letterboxd exposes it.

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

## Migration from v4.0

v6.0 preserves older local film state and upgrades entries as they are loaded. Run Collection Sync after installing to populate the richer profile database.

---

Made with film love.
