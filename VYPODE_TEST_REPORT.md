# Vypode for Letterboxd — Build, Test & Hardening Report

**Date:** 2026-05-31 · **Version:** 6.0.0 · **Repo:** `~/vypode-letterboxd` (git)

> ⚠️ **Honesty note on the harness.** The "e2e" suite is **not** a real Chromium/Puppeteer/Playwright
> browser driving the unpacked extension. It is a **DOM simulation** (`linkedom` + Node `vm`) with
> hand-mocked `chrome.storage`, `fetch`, `Image`, etc. It executes the real `content.js`/`popup.js`
> logic against a synthetic DOM and dispatches synthetic events. The `popup-ui` unit spec is mostly
> **static source-string assertions**. So this report verifies **logic, wiring, and data integrity** —
> it does **not** verify real-browser rendering or live actions against letterboxd.com. Any claim below
> is scoped to what the harness can actually prove. No live Letterboxd account was exercised.

---

## 1. What this product is

A Manifest V3 Chrome extension that injects a Tinder-style swipe deck and a local film database onto
Letterboxd listing/film pages. It maintains a **local-only** registry (`chrome.storage.local`, keyed by
film slug) of the user's watched films — title, poster, star rating, liked status, review text — and
lets the user filter, sort, search, review, and triage (watched / like / watchlist / skip). Prefs sync
via `chrome.storage.sync`. No cloud, no OAuth, no external backend (verified by test).

## 2. Result summary

| Metric | Before | After |
|---|---|---|
| Unit tests | 22 (1 failing) | **51 passing** |
| e2e (DOM-sim) tests | 5 passing | **5 passing** |
| **Total** | 26/27 | **56/56 green** |
| Real bugs fixed (this session) | — | **3** (B2, B3, B4) |
| Flagged-but-correct (reverted) | — | 1 |
| New robustness tests added | — | **11** |
| New mock-data generator | — | **1** |

`npm test` → `npm run check` (syntax + manifest JSON) → unit → e2e, all green.

> **Concurrency note (honesty).** Midway through this session a **parallel process** (a second
> agent running the same goal-prompt's "Chaos Tester" role) began writing into this repo:
> `tests/unit/film-state-hardening.spec.mjs` (15 adversarial tests) plus its own guards in
> `film-state.js`. Its chaos tests caught a **real** crash I had not — corrupted storage where
> `slugs`/`_meta` are non-object primitives threw `TypeError` inside `migrateData`/`loadFromStorage`
> under `'use strict'`. I detected the live collision, **stopped editing the shared file to avoid
> clobbering its writes**, and the two efforts converged: my fixes (B2/B3/B4) and its storage-shape
> guards coexist, suite fully green. Of that file's initial 7 failures, **1 was a real bug (now fixed)**
> and **6 were cross-realm `deepEqual` mistakes in the test harness itself** (vm-realm arrays vs host
> arrays), since corrected by that process. The `tests/unit/film-state-hardening.spec.mjs` file is
> **not my authorship.**

## 3. Bug log (found → fix → verified)

| # | Severity | Location | Problem | Fix | Verified by |
|---|---|---|---|---|---|
| B1 | Low (test) | `tests/unit/manifest.spec.mjs:12` | Hard-coded `version === '5.0.0'` failed against manifest `6.0.0` — drift trap on every bump. | Assert `manifest.version === package.json version` + semver shape. | manifest spec |
| B2 | **Medium** | `content.js` `submitReview` (~L786) | Read `filmDeck[currentDeckIndex]` ~3 s later inside the async verify callback; if the deck moved/emptied it marked or crashed the **wrong card**. | Capture `reviewedCard`/`reviewedIndex` at submit time; mark that card; only `advanceToNextCard()` if the index hasn't moved. | code review (race removed); not browser-reproduced |
| B3 | **Medium** | `film-state.js` `clearAll` (L548) | `registry = {}` dropped the null-prototype pollution defense until next reload — `get('toString')` would return an inherited function. | `registry = Object.create(null)`. | `clearAll restores a null-prototype registry` test (has teeth: fails on `{}`) |
| B4 | Low | `content.js` `enrichFilmData` (L361) | On network error it reset `enriched = false`, allowing **unbounded re-fetch** of a persistently failing URL on every deck advance (offline / flaky). | Cap at 3 attempts via `enrichAttempts`, then stop. | code review |
| — | n/a | `film-state.js` `updateFilm` | Audit flagged "missing watch-date timestamp" as a bug. **Investigated → correct by design.** `updateFilm` is a literal patch; a watched film with no `watchedAt` is intentionally surfaced by the `missing-watched-date` filter (fabricating `now` would corrupt the watch date). The existing test caught my attempted "fix"; **reverted**, added a clarifying comment. | — | film-state spec regression |

### Known issues left as-is (documented, non-blocking)
- **Half-star ratings:** `parseRatingValue` reads `.5` but the review UI submits integers only; `updateRatingDisplay` has dead `half`-class code (`content.js:1422`). Cosmetic / feature gap, not a correctness bug.
- **`beforeunload` confirm** fires whenever the action queue is non-empty — can nag on normal navigation (`content.js:2492`).
- **`migrateData` v0/v1** branches are effectively no-ops (placeholder) — harmless cruft.
- Browser-level chaos (offline mid-import, rapid clicking, real CSRF/review POST) is **guarded in code** (`requireActiveLetterboxdSession`, sync-failure messages, fallback navigation, `isProcessingAction` lock) but **not auto-tested** — see harness note.

## 4. Test / feature matrix

PASS = verified by harness · LOGIC = verified at DOM-sim/logic level only · MANUAL = needs real browser, not run

| Area | Item | Status | Note |
|---|---|---|---|
| Install/first-run | Manifest valid, MV3, local-first perms only, all referenced files exist | **PASS** | manifest spec |
| Install/first-run | No cloud/OAuth/Supabase/identity/alarms artifacts ship | **PASS** | manifest spec |
| Install/first-run | Icon/popup loads, no console errors in real Chrome | MANUAL | not browser-run |
| Empty state | DB browser shows "Run Collection Sync" prompt at zero data | **LOGIC** | e2e + audit |
| Import | Valid registry import (timestamp-wins) | **PASS** | film-state spec |
| Import | Empty history import | **PASS** | new robustness spec |
| Import | Bulk (50) / huge (10k) history | **PASS** | new robustness spec |
| Import | Invalid JSON / unsafe slugs / missing-flag booleans rejected | **PASS** | film-state spec |
| Data | Title/poster/stars/liked/review tracked per film | **PASS** | film-state + e2e |
| Data | Malformed/partial/null stored entries load without throwing | **PASS** | new robustness spec |
| Data | Unicode / CJK / emoji titles search + sort | **PASS** | new robustness spec |
| Data | Legacy v0 blob migrates to current version | **PASS** | new robustness spec |
| Data | 10,000-film history: stats/search/genres/sort correct (~97 ms) | **PASS** | new robustness spec |
| Filter | Each status filter (watched/liked/watchlist/rated/reviewed/missing-rating/skipped) | **PASS** | film-state + new |
| Filter | Genre, watch-date ranges, free-text search | **PASS** | film-state + e2e |
| Filter | **Combined** status+genre+search | **PASS** | new robustness spec |
| Filter | Zero-result + reset-to-full | **PASS** | new robustness spec |
| Sort | title / year / rating / watchedAt / updated all correct | **PASS** | new robustness spec |
| Detail | Per-film detail view shows director/genres/review | **LOGIC** | e2e |
| Buttons | `clearSkipped` clears only skipped; `clearAll` empties registry | **PASS** | film-state + new + e2e |
| Settings | Deck filter prefs persist via `chrome.storage.sync` | **LOGIC** | e2e (single run) |
| Settings | Persist **across reload** | MANUAL | harness doesn't re-instantiate |
| Sync/actions | Account actions require active Letterboxd session; signed-out guards & disabled buttons | **PASS** | film-state + e2e |
| Sync/actions | Multi-tab writes merge (no clobber) | **PASS** | film-state spec |
| Review | CSRF/LID parse + production-log API submit; deck-advance race fixed | **LOGIC** (submit path MANUAL) | code review |
| Errors | Sync failure / offline → message + fallback nav, no crash | **LOGIC** | audit; not browser-run |
| Errors | `enrichFilmData` no longer loops on failing URL | **LOGIC** | code review |

## 5. Expert review panel (simulated)

Critiques are tied to verified product facts. "Blocking" = must fix before first-time-user GA.

- **Steve Jobs — first-run & simplicity. Verdict: REVISE.** Top objections: (1) **The popup is dead weight** — it's read-only stats + static instructions, no action; the user's first tap shows numbers, not their films. *Ticket:* make the popup either open the deck/DB or show the last swipe — give the first tap a verb. (2) **No onboarding** — a fresh user lands with empty stats and a "Run Collection Sync" string; the magic moment (seeing your history) is buried behind an unexplained sync. *Ticket:* one-line "Sync your Letterboxd history" CTA front-and-centre. (3) Two filter surfaces (deck prefs vs DB browser) is two mental models. *Ticket:* unify language. *None blocking, but #1+#2 define whether anyone stays.*
- **Peter Thiel — defensibility. Verdict: REVISE.** (1) Right now it's "filters over Letterboxd" — Letterboxd can ship that. The defensible wedge is the **swipe-triage of your own backlog/watchlist**, which Letterboxd doesn't do. *Ticket:* lead with triage, not filtering. (2) Local-only DB is a genuine privacy story — under-sold. *Ticket:* make "your data never leaves the browser" a headline. *Non-blocking — strategy, not correctness.*
- **Bill Gates — scale & data integrity. Verdict: PASS (with fixes landed).** (1) 10k-history correctness now tested (97 ms) ✅. (2) **Prototype-pollution after clearAll** — fixed (B3) ✅. (3) **Watch-date integrity** — confirmed `updateFilm` must not fabricate dates ✅. Residual: full-registry re-serialize on every debounced write is O(n); fine to ~10k, worth watching beyond. *Ticket (non-blocking):* incremental/chunked writes for very large libraries.
- **CEO of Letterboxd — ToS & respectful data use. Verdict: REVISE — one blocking item.** (1) Review/rating submission posts to the **private** `/api/v0/production-log-entries` endpoint with a scraped CSRF token — **fragile and arguably outside intended use**. *Ticket (BLOCKING for a public listing):* document this clearly, fail gracefully when the endpoint/markup changes (it already keeps the panel open on failure ✅), and treat it as best-effort. (2) Imported ratings/reviews are stored verbatim and local-only — respectful ✅. (3) Host perms scoped to `letterboxd.com` only ✅.
- **Werner Herzog — emotional truth. Verdict: REVISE.** The deck is mechanical — "a conveyor belt of posters." Seeing a life lived through film needs texture: *Ticket:* surface the user's own old review on the card; show "you watched this 7 years ago"; let the history feel like memory, not a spreadsheet. *Non-blocking.*
- **Quentin Tarantino — power users / deep cuts. Verdict: REVISE.** (1) Unicode/obscure titles now handled ✅ (tested). (2) **Only integer star ratings** despite half-star parsing — a film obsessive rates ★★★★½. *Ticket:* wire half-star submission (dead code already half-there at `content.js:1422`). (3) No sort by director or rewatch count for encyclopaedic libraries. *Ticket:* add director sort. *Non-blocking but #2 stings the target user.*

**Blocking objections:** 1 — Letterboxd-CEO's "private-API submission must be documented + degrade gracefully" (graceful-failure path already exists; the gap is disclosure/expectation-setting, not a crash).

## 6. Assumptions made

1. "YouTube sorter" in the request = this **Letterboxd** swipe/sorter extension (the only film-sorter in the workspace; the goal prompt itself describes Letterboxd).
2. No real Chrome/Puppeteer was available or intended — I extended the existing linkedom harness rather than introducing a heavy browser-automation dependency unprompted.
3. The repo's pre-existing uncommitted changes were left as the working baseline; I did **not** commit (no instruction to).
4. `updateFilm` not stamping flag timestamps is intentional (confirmed by the existing test), not a bug.
5. The private review-submit API is accepted as best-effort; it must not be the only path to value.
6. Deterministic mock data (fixed timestamps, no `Math.random`) is preferable for reproducible tests.

## 7. Readiness verdict

**Conditional yes — ready for a *technical/beta* first-time user, not yet for an unguided GA audience.** The data layer is genuinely solid: prototype-safe, malformed-tolerant, unicode-correct, and proven against a 10k-film history, with 38/38 logic/DOM tests green and four real defects addressed. What stands between this and a confident public release is **not correctness but experience and verification**: there is no onboarding and the popup does nothing (Jobs), the value prop reads as "another filter" rather than backlog-triage (Thiel), half-star ratings and director sort are missing for power users (Tarantino), and — most importantly — the review/rating path relies on a private Letterboxd API that has only been verified at the logic level, never against the live site in a real browser. Land the onboarding/popup CTA and run one real-Chrome smoke test of the swipe + review flow against a live account, and this is GA-ready.

## 8. New / changed files

- `film-state.js` — B3 fix (`clearAll` null-proto) + `updateFilm` clarifying comment.
- `content.js` — B2 fix (review deck-advance race) + B4 fix (enrich retry cap).
- `tests/unit/manifest.spec.mjs` — B1 fix (version drift).
- `tests/helpers/film-state-runtime.mjs` — shared vm harness (new).
- `tests/helpers/mock-letterboxd.mjs` — deterministic mock history generator (new).
- `tests/unit/film-state-robustness.spec.mjs` — 11 robustness tests (new).
