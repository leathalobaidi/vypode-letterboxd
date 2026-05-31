# Vypode for Letterboxd — Autonomous Hardening Report (v6.0 → v6.0.1)

**Date:** 2026-05-31
**Scope:** Audit → adversarial test harness → chaos testing → expert persona panel → fixes → re-test, run as an autonomous loop until two consecutive full suites passed with no new blocking *engineering* issue.
**Result:** Suite green ×3 consecutive runs — **51 unit + 9 e2e = 60 tests, 0 failures.** Two real crash bugs found and fixed; two resilience improvements added; one flaky test in the new harness found and fixed.

---

## 1. Readiness verdict

**Yes — ready for a real first-time user, for what the product actually claims to be: a local, read-mostly companion for filtering and triaging your own Letterboxd history.** The data layer is unusually disciplined (prototype-pollution-safe, partial-sync-safe, corrupted-storage-safe after this pass), the action queue has correct optimistic-undo/commit semantics, and the sync path now degrades gracefully under throttling instead of aborting. The unresolved items below are *product-scope and platform-risk* decisions (onboarding depth, the undocumented review-submit endpoint, a rewatch/diary model), not correctness blockers — they are owner calls, logged as tickets, not silently shipped.

---

## 2. What was actually executed (not simulated)

Every PASS below comes from a test that ran against the **real** `film-state.js` / `content.js` in a `linkedom`+`vm` sandbox with mocked `chrome.storage` and a controllable `fetch`. Nothing here is asserted by inspection alone.

- Existing harness: `tests/unit/*.spec.mjs`, `tests/e2e/extension-self-test.spec.mjs`
- **New** data-layer chaos: `tests/unit/film-state-hardening.spec.mjs` (18 tests)
- **New** content-layer chaos: `tests/e2e/chaos.spec.mjs` (4 tests)

---

## 3. PASS/FAIL matrix

### Data layer (`film-state-hardening.spec.mjs`) — all PASS
| # | Test | Property proven |
|---|------|-----------------|
| 1 | Prototype-pollution slugs rejected | `__proto__`/`constructor`/`prototype` never enter registry; `Object.prototype` stays clean |
| 2 | `setFlag`/`updateFilm` ignore unsafe slugs | write API guarded |
| 3 | Migration strips unsafe slugs on disk | v1→v2 migration sanitises |
| 4 | Malformed import won't clear flags | missing boolean ⇒ existing `true` preserved |
| 5 | Explicit `false`+newer ts wins | intentional override still works |
| 6 | Invalid JSON / missing-slugs import | fails safely, no throw |
| 7 | **Corrupted storage shapes load empty** | string/number/array/`slugs:string`/`_meta:number` no longer crash (BUG-1, BUG-2) |
| 8 | Concurrent cross-tab write merged on flush | last-writer-wins per flag; other tab's newer like preserved |
| 9 | `reconcileFlags` safety | only `collectionSync`-sourced flags cleared, never user actions |
| 10 | Every status filter individually | watched/liked/watchlist/rated/reviewed/skipped/missing-rating |
| 11 | Genre + date + search combine; reset restores | combined filtering correct |
| 12 | Zero-result filter | returns `[]`, no throw |
| 13 | Unicode titles searchable | `東京` and romanised both match |
| 14 | All sort orders | rating / year / watchedAt / title / updated |
| 15 | `getGenres` sorted + de-duped | taxonomy correct |
| 16 | 10,000-film history | stats/filter/sort/search correct at scale |
| 17 | Empty registry | sane empty state object |
| 18 | `chrome.runtime.lastError` on save captured | surfaced via `getLastStorageError()` |

### Content layer (`chaos.spec.mjs`) — all PASS
| # | Test | Property proven |
|---|------|-----------------|
| 1 | Offline sync (fetch rejects) | fails safely, **flags preserved**, "Sync failed" surfaced |
| 2 | HTTP 500 mid-sync | treated as incomplete, flags preserved |
| 3 | **429 throttle retried** (Retry-After honoured) | sync completes instead of aborting (FIX-3) |
| 4 | Listing with no pagination | never fetches an invented `/page/2/` |

### Pre-existing suite — all PASS (unchanged behaviour)
Popup stats rendering, settings DB search/genre/date/sort/detail, clear-skipped/clear-all, signed-out gating of sync + review submit, deck hide-watched/liked + persist-skipped, version string, manifest permissions.

---

## 4. Bug log (found → fixed → covered)

| ID | Severity | Found by | Bug | Fix | Test |
|----|----------|----------|-----|-----|------|
| **BUG-1** | High | data-layer chaos | `migrateData` did `for…in raw.slugs` then assigned to indices when `slugs` was a **string** → `TypeError: Cannot assign to read only property '0'`; rejected `init()` ⇒ extension fails to load on corrupted profile | type-guard `raw.slugs && typeof === 'object'` in both `migrateData` and `loadFromStorage` (`film-state.js:100,201`) | hardening #7 |
| **BUG-2** | High | data-layer chaos | non-object `_meta` (e.g. `{_meta: 5}`) → `Cannot create property 'version' on number` in migration; same load-crash class | coerce `_meta` to object at top of `migrateData`; guard `meta` assignment in `loadFromStorage` (`film-state.js:98,196`) | hardening #7 |
| **BUG-3** | Low (test) | full-suite ×2 | new chaos sync test flaked: fixed `tick(30)` occasionally fired before the async sync settled | replaced fixed delay with `waitFor(syncSettled)` polling | chaos #1–3 stable ×3 |

> The two earlier-claimed 6.0 fixes were independently **verified present and correct** in the live source during audit (overlay `Boolean(?.)`, partial-sync guard, cap-as-incomplete, unsafe-slug rejection, malformed-import guard, undo-commit guard, beforeunload flush/warn, poster fallback, single-film no-toggle-off, no-invented-pagination) — see audit table in the session.

---

## 5. Resilience improvements added (from the persona panel, in-scope)

| ID | Change | Driver | File | Test |
|----|--------|--------|------|------|
| **FIX-3** | `fetchWithRetry`: 429/503 honour `Retry-After` then exponential backoff (cap 8s / 30s); a throttled page retries instead of aborting the whole sync | Bill Gates #2, Letterboxd CEO #3 | `content.js` (`fetchAllCollectionFilms`) | chaos #3 |
| **FIX-4** | Review-text enrichment throttled: 4→2 concurrent workers + 250ms inter-request pause + retry-aware fetch | Letterboxd CEO #2 | `content.js` (`hydrateReviewText`) | covered indirectly; load-reduction |

---

## 6. Expert review panel — verdicts, objections, resolutions

Each persona read the real code and cited `file:line`. "Blocking" objections that are **engineering correctness/safety** were resolved this pass; "blocking" objections that are **product scope or platform-strategy** are logged as owner decisions (resolving them would be unilaterally redefining the product, which is out of scope for a hardening pass).

### Steve Jobs — *Rework* (first-run experience)
1. [BLOCKING·product] Popup shows six "–" stats + control legend before any data exists (`popup.html:152-182`). → **Ticket T1.**
2. [BLOCKING·product] Headline feature (your history) is ~6 taps deep behind the settings panel (`content.js` settings region). → **Ticket T2.**
3. [non-blocking] Empty states read as errors, not invitations. → **Ticket T3.**

### Peter Thiel — *Rework* (defensibility)
1. [BLOCKING·strategy] Registry mirrors data Letterboxd already owns; no proprietary data/network. → **Ticket T4** (capture proprietary swipe-decision signal).
2. [BLOCKING·platform] Write-path depends on undocumented `/api/v0/production-log-entries`. → overlaps **Ticket T7**.
3. [non-blocking] The swipe-triage deck is the one non-obvious primitive; lead with it. → **Ticket T5** (reposition README thesis).

### Bill Gates — *Revise* (robustness) — **partly resolved**
1. [BLOCKING·perf] `writeToStorage` re-serialises the **entire** registry on every save → O(n) write amplification at 10k films. → **Ticket T6** (dirty-tracking / sharded keys). *Not fixed this pass — correct fix is a storage-format change with migration risk; doing it hastily is worse than logging it.*
2. [BLOCKING·resilience] No 429 handling; throttle ⇒ total sync failure. → **RESOLVED (FIX-3).**
3. [non-blocking] Reconcile-vs-userAction same-millisecond tie could clobber a live user flag (`film-state.js:134` `>=`). → **Ticket T8** (source-priority tie-break).
4. [non-blocking] Unthrottled review fan-out. → **RESOLVED (FIX-4).**

### Letterboxd CEO — *Revise* (platform respect) — **partly resolved**
1. [BLOCKING·platform] `submitReview` POSTs to internal `/api/v0/…` as the session; self-dates entries to today. → **Ticket T7** (route via on-page controls or explicit per-action confirm; don't auto-stamp date). *Owner decision — this is the product's core write feature.*
2. [non-blocking] Review fan-out throttle. → **RESOLVED (FIX-4).**
3. [non-blocking] No global request budget / backoff. → **partly RESOLVED (FIX-3);** global budget = **Ticket T9.**
4. [doc] Disclose request volume + ToS posture in README. → **Ticket T10.**

### Werner Herzog — *Revise* (emotional truth)
1. [BLOCKING·product] Popup is a six-cell scoreboard; "Skipped" weighted like "Liked"; no "hours in the dark". → **Ticket T11.**
2. [BLOCKING·product] Detail view prints "No review text stored." where memory should live. → **Ticket T12.**
3. [non-blocking] Microcopy is mechanical; never names the film back. → **Ticket T13.**

### Quentin Tarantino — *Revise* (cinephile depth)
1. [BLOCKING·product] No rewatch model — one `watched`/`watchedAt`; logging a film twice destroys the first date (`film-state.js:39,371`). → **Ticket T14.**
2. [BLOCKING·product] Genres `.slice(0,3)`; `extractProfileFilms` scrapes no genres/director; no tags. → **Ticket T15.**
3. [non-blocking] Half-stars parse but no rating-band filter / ascending sort. → **Ticket T16.**

---

## 7. Ticket backlog (prioritised, for owner decision)

**Platform risk (decide before store submission)**
- **T7** — Reconsider `submitReview` against undocumented `/api/v0/`; route via real on-page controls or gate behind explicit confirmation; stop auto-stamping diary date to today.
- **T10** — README: disclose authenticated request volume during Sync + ToS "use at your own risk" note.
- **T9** — Global per-sync request budget on top of FIX-3 backoff.

**Robustness (engineering, post-6.0.1)**
- **T6** — Dirty-track / shard storage writes so a single `setFlag` isn't an N-entry rewrite at 10k films.
- **T8** — Source-priority tie-break in `mergeEntryForSave` so reconcile can't overwrite a same-ms user flag.

**Product depth (roadmap)**
- **T14** — Rewatch/diary model: `viewings[]` + `watchCount`; stop overwriting `watchedAt`.
- **T15** — Capture director+genre in `extractProfileFilms`; remove `.slice(0,3)`; add tags + tag filter.
- **T16** — Rating-band filter (`≥4`, `=3.5`) + ascending rating sort.

**First-run & emotion (roadmap)**
- **T1/T2/T3** — Onboarding: primary "Sync now" CTA, surface history sooner, invitational empty states.
- **T11/T12/T13** — One human stat ("films since {oldest}"), invitational detail-view copy, name the film in toasts.
- **T4/T5** — Capture proprietary swipe-decision signal; reposition thesis around high-throughput triage.

---

## 8. Assumptions made (per autonomy grant)

1. **Scope = correctness/safety hardening**, not a product redesign. Persona "blocking" objections that are scope/strategy/platform calls were logged as tickets, not unilaterally implemented — implementing T7 (changing the review-submit mechanism) or T14 (rewatch model) would redefine the product and risk the green suite.
2. **Test harness = the existing `linkedom`+`vm` approach**, not a real headless-Chrome + unpacked-extension Puppeteer rig. The repo has no Playwright/Puppeteer and no Chrome guaranteed in this environment; extending the *real* in-repo harness is honest and reproducible. A true browser-driver rig is itself a ticket if desired.
3. **Corrupted-storage crashes are High severity** — they reject `init()` and can break extension load for a real user, so they were fixed immediately and version-bumped.
4. **A patch bump to 6.0.1 is warranted** because user-facing crash bugs shipped; visible/package/manifest strings updated accordingly and the version assertion test updated to match.
5. **Mock pages return a single-film page with no profile-film items**, so a "successful" sync in tests yields 0 films — sync-failure and retry tests assert on durable UI state and request patterns, not on imported counts.
6. **"Two consecutive clean loops"** was interpreted as the *engineering* suite: two+ consecutive full-suite passes with no new failing test and no unresolved blocking *correctness/safety* finding. Product/strategy objections are intentionally open.

---

## 9. Deliverables index
- Repaired/ hardened source: `film-state.js` (BUG-1, BUG-2), `content.js` (FIX-3, FIX-4)
- Test harness + chaos generators: `tests/unit/film-state-hardening.spec.mjs`, `tests/e2e/chaos.spec.mjs`
- This report: `HARDENING-REPORT.md`
- Commands: `npm test` (full), `npm run test:unit`, `npm run test:e2e`
