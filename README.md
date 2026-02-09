# Vypode for Letterboxd

A Chrome extension that adds a swipe-style interface for quickly rating and managing films on Letterboxd. Stay in the swipe view as you browse through all films, with actions performed in the background.

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `vypode-letterboxd-extension` folder from your Downloads
5. The extension is now installed!

## How to Use

### On Film Pages (e.g., letterboxd.com/film/parasite/)
1. Click the **🎴 Vypode** button in the bottom-right corner
2. Use the swipe interface to take action on that film

### On Listing Pages (e.g., letterboxd.com/films/popular/)
1. Click the **🎴 Vypode Deck** button in the bottom-right corner
2. Browse through all films on the page as a card deck
3. Swipe to take action - **actions happen in the background** so you stay in the deck
4. When you finish all films on the page, it **automatically loads the next page**

## Controls

| Action | Mouse | Keyboard |
|--------|-------|----------|
| **Mark as Watched** | Move cursor to left zone + click | ← Arrow |
| **Like** | Move cursor to top zone + click | ↑ Arrow |
| **Add to Watchlist** | Move cursor to right zone + click | → Arrow |
| **Skip** (deck mode) | Move cursor to bottom zone + click | ↓ Arrow |
| **Previous Film** | Click Prev button | - |
| **Close** | Click outside card or ✕ button | Escape |

## Key Features

### Background Actions
Actions are performed in a hidden iframe, so you never leave the swipe deck. Keep swiping through films without interruption!

### Auto-Advance
After each action (watched, liked, watchlist, or skip), the deck automatically moves to the next film.

### Auto-Next Page
When you've gone through all films on the current page, Vypode automatically navigates to the next page and reopens the deck.

### Progress Bar
Visual progress indicator shows how far you've gone through the current page's films.

## Supported Pages

- **Film pages**: `letterboxd.com/film/*`
- **Popular films**: `letterboxd.com/films/popular/*`
- **Decade browsing**: `letterboxd.com/films/decade/*`
- **Genre browsing**: `letterboxd.com/films/genre/*`
- **User watchlists**: `letterboxd.com/*/watchlist/*`
- **User lists**: `letterboxd.com/*/list/*`
- **Any film listing page**

## Requirements

- Chrome browser
- Logged into your Letterboxd account

## Troubleshooting

**Button not appearing?**
- Make sure you're on a supported page
- Try refreshing the page
- Check that the extension is enabled in `chrome://extensions/`

**Actions not working?**
- Ensure you're logged into Letterboxd
- Some actions may take a moment to process (watch for the toast notification)

**Deck mode shows "No films found"?**
- The page may not have loaded fully - wait a moment and try again

---

Made with ❤️ for film lovers
