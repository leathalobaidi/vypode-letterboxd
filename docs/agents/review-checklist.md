# Extension review checklist

Use this checklist with the installed `code-review` skill. It supplements the repository's automated tests; it does not replace them.

## Behaviour and release integrity

- Compare the candidate with an explicit full commit ID and read the relevant specification before reviewing.
- Verify the manifest, visible version strings, documentation, package name, and test expectations agree.
- Run `npm run release:check` and inspect the generated ZIP rather than assuming source-tree success proves the packaged extension.
- Exercise user-visible flows through their public seams. Avoid tests that merely repeat implementation logic.

## Manifest V3 and trust boundaries

- Keep permissions and content-script matches no broader than the documented features require.
- Validate runtime message types and payloads. For privileged operations, verify the sender, tab, frame, and supported Letterboxd origin as applicable.
- Build action and trailer destinations from validated Letterboxd film slugs or fixed production endpoints. Reject unexpected schemes, hosts, paths, and oversized fields.
- Keep CSRF tokens transient. Never log or persist authentication material, review submission tokens, or dictated audio.
- Treat page DOM, fetched markup, issue text, imported data, and `postMessage` data as untrusted.

## Account state and delivery

- Isolate film state, review drafts, and pending actions by the active Letterboxd account.
- Clearing local film data must remove the documented local data while retaining only explicitly documented duplicate-prevention records.
- Empty legacy state may be reclaimed after a clear; state belonging to a different active account must never be replaced implicitly.
- Every tab must adopt a newer clear generation and its authoritative active account. Ordinary merge and clear-skipped commands must never change root ownership.
- Preserve generation/account fences across asynchronous work so a clear or account switch cannot resurrect stale results.
- Ensure queued account actions are idempotent or protected against blind replay, including service-worker suspension and retry paths.

## Swipe interactions

- Automatic real-page navigation remains opt-in, follows only a different same-origin Letterboxd Next URL, waits for Undo and queued actions, and cancels when Swipe closes or the setting is disabled.
- A skip remains local, advances exactly one card, participates in the same final-card navigation rules, and never sends a Letterboxd account action.
- Keyboard shortcuts must ignore editable fields and preserve expected focus. Opening a trailer must not consume or advance the Swipe card.
- Trailer playback must tolerate delayed iframe/player creation, restrict messaging to the expected YouTube player origin, and report browser autoplay restrictions honestly.
- Dictation must not claim it is recording before recognition starts; stopping or submitting must retain final transcript events. Unsupported browsers should focus the textarea and present the system-dictation fallback.
