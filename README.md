# Vypode for Letterboxd v5.0

A Chrome extension that adds a swipe-style interface for quickly rating and managing films on Letterboxd. **Fresh posters only** — films you've watched, liked, added to watchlist, or skipped are automatically hidden.

## What's New in v5.0

- **Fresh poster filtering** — Deck mode only shows films you haven't already acted on
- **Durable skip** — Skipped films stay hidden across sessions
- **Account linking** — Detects your Letterboxd username automatically
- **Collection sync** — Pulls your watched, liked, and watchlist films from Letterboxd
- **Settings panel** — Filter toggles, sync controls, export/import, stats
- **Cloud backup** — Optional Google sign-in to back up your film registry across devices via Supabase
- **Background service worker** — Handles scheduled sync and cloud operations

## Installation

### From Chrome Web Store (Recommended)
*Coming soon — pending review*

### Manual Installation (Developer Mode)

#### Step 1: Download the extension

1. Go to this page: https://github.com/leathalobaidi/vypode-letterboxd
2. Click the green **Code** button (near the top right)
3. Click **Download ZIP** from the dropdown menu
4. The file `vypode-letterboxd-main.zip` will download to your Downloads folder
5. **Unzip the file** — double-click it on Mac, or right-click → Extract All on Windows

You'll now have a folder called `vypode-letterboxd-main` containing:
```
vypode-letterboxd-main/
├── manifest.json
├── content.js
├── background.js
├── film-state.js
├── popup.html
├── styles.css
├── icons/
├── supabase-setup.sql
└── README.md
```

#### Step 2: Install in Chrome

1. Open Chrome and type `chrome://extensions/` in the address bar
2. Turn on **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked** (button appears after enabling Developer mode)
4. Navigate to the `vypode-letterboxd-main` folder you unzipped
5. Select the **entire folder** (the one containing `manifest.json`)
6. Click **Select Folder**

Done! You'll see the Vypode icon in your Chrome toolbar. Head to any Letterboxd film or listing page to start swiping.

## How to Use

### On Film Pages (e.g., letterboxd.com/film/parasite/)
1. Click the **Vypode** button in the bottom-right corner
2. Use the swipe interface to take action on that film

### On Listing Pages (e.g., letterboxd.com/films/popular/)
1. Click the **Vypode Deck** button in the bottom-right corner
2. The deck **only shows fresh films** — anything you've already watched, liked, added to watchlist, or skipped is automatically hidden
3. Swipe to take action — actions happen in the background via hidden iframe
4. When you finish all fresh films on the page, it automatically loads the next page

## Controls

| Action | Mouse | Keyboard |
|--------|-------|----------|
| **Mark as Watched** | Left zone + click | Left arrow |
| **Like** | Top zone + click | Up arrow |
| **Add to Watchlist** | Right zone + click | Right arrow |
| **Skip** (deck mode) | Bottom zone + click | Down arrow |
| **Review** | Review button | R |
| **Settings** | Gear icon | S |
| **Close** | Click outside card or X | Escape |

## Account Linking

Vypode detects your Letterboxd username automatically from the navigation bar when you're logged in. No password or API key is needed — it reads the username from the page DOM.

To confirm your linked account, press **S** to open Settings. Your username appears at the top.

If you're not logged in to Letterboxd, Vypode runs in **local-only mode** — all features work except collection sync.

## Collection Sync

Sync pulls your film collections from Letterboxd by fetching your profile pages:
- `/{username}/films/` — watched films
- `/{username}/watchlist/` — watchlist
- `/{username}/likes/films/` — liked films

### How it works
- Parses film slugs from each paginated listing
- Updates your local FilmState registry with the results
- Rate-limited to 1 request per second to be respectful to Letterboxd
- Auto-syncs once per day (via chrome.alarms)
- Manual sync available in Settings

### What data is stored
All film state is stored locally in `chrome.storage.local` as a registry keyed by film slug:
```
{
  "parasite-2019": {
    "watched": true, "watchedAt": "2025-01-15T...",
    "liked": true, "likedAt": "2025-01-15T...",
    "watchlist": false, "watchlistAt": null,
    "skipped": false, "skippedAt": null,
    "lastAction": "watched",
    "source": "collectionSync"
  }
}
```

Small preferences (filter toggles) use `chrome.storage.sync` for cross-device settings sync.

## Cloud Backup (Optional)

Cloud backup requires a Supabase project. This is **optional** — the extension works fully without it.

### Setup
1. Create a free project at [supabase.com](https://supabase.com)
2. Run `supabase-setup.sql` in the SQL Editor
3. Enable Google auth in Authentication > Providers
4. Copy your Supabase URL and anon key into `background.js`
5. Set your Google OAuth client ID in `manifest.json`
6. Add your Chrome extension ID to Google OAuth redirect URIs

### How it works
- Sign in via Google (uses `chrome.identity`)
- Backs up your FilmState registry to Supabase
- Timestamp-based merge: latest change wins per slug per flag
- Offline writes are queued and retried
- Data encrypted in transit (HTTPS) and at rest (Supabase AES-256)
- Row Level Security ensures you can only access your own data

## Filter Settings

Open Settings (S key or gear icon) to toggle which films are hidden:

| Filter | Default | What it does |
|--------|---------|--------------|
| Hide watched | On | Hides films you've marked as watched |
| Hide liked | On | Hides films you've liked |
| Hide watchlist | On | Hides films in your watchlist |
| Hide skipped | On | Hides films you've skipped |

Turn off "Hide watchlist" if you want to review your watchlist films in the deck.

## Data Management

In Settings you can:
- **Export** your full film registry as JSON
- **Import** a previously exported JSON file (merges with existing data)
- **Clear skipped** to bring back all skipped films
- **Clear all data** to reset everything

## Resetting

To fully reset Vypode:
1. Open Settings > Clear all data
2. Or go to `chrome://extensions/`, find Vypode, and click "Remove"
3. Reinstall from the unpacked folder

To reset just cloud data:
1. Open Settings > Sign out from cloud
2. Delete the data from your Supabase dashboard if needed

## Migration from v4.0

v5.0 is backwards compatible. If you had v4.0 installed:
- Your existing extension state is preserved
- Film states will build up as you use the deck
- Run a collection sync to populate the registry from your Letterboxd account
- No manual migration steps needed

## Supported Pages

- Film pages: `letterboxd.com/film/*`
- Popular films: `letterboxd.com/films/popular/*`
- Decade browsing: `letterboxd.com/films/decade/*`
- Genre browsing: `letterboxd.com/films/genre/*`
- User watchlists: `letterboxd.com/*/watchlist/*`
- User lists: `letterboxd.com/*/list/*`

## Requirements

- Chrome browser (Manifest V3)
- Logged into your Letterboxd account (for full features)

## Troubleshooting

**Button not appearing?**
- Make sure you're on a supported page
- Refresh the page
- Check the extension is enabled in `chrome://extensions/`

**"All films filtered" message?**
- Your collections are fully synced — all films on this page are already in your watched/liked/watchlist/skipped lists
- Open Settings (S) and toggle off some filters to see more films

**Sync taking too long?**
- Large collections (1000+ films) may take a few minutes
- The sync runs in the background — you can keep using the extension

**Actions not working?**
- Ensure you're logged into Letterboxd
- Some actions may take a moment (watch for the toast notification)

---

Made with film love
