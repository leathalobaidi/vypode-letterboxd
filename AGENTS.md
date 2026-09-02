# Swipe for Letterboxd agent instructions

## Project

Swipe is a Manifest V3 Chrome/Brave extension written in plain JavaScript. Preserve the no-build runtime, keep browser permissions narrow, and treat actions on a Letterboxd account as security- and privacy-sensitive.

## Agent skills

### Issue tracker

Issues and specifications live in the GitHub repository. See `docs/agents/issue-tracker.md`.

### Domain docs

This is a single-context repository. Read a root `CONTEXT.md` and relevant records under `docs/adr/` when they exist. See `docs/agents/domain.md`.

### Installed review skills

The project-local Matt Pocock skills under `.agents/skills/` are pinned and editable. Their source is recorded in `.agents/skills/README.md`. Use:

- `code-review` for separate Standards and Spec reviews against an explicit Git fixed point.
- `diagnosing-bugs` for difficult or intermittent failures, beginning with a red-capable reproduction.
- `tdd` with `codebase-design` for regression fixes at observable seams.
- `improve-codebase-architecture` only as a separate maintainability exercise, never as an automatic release refactor.

Do not let a review sub-agent invoke `code-review` recursively. Verify every reported finding against the cited code before changing anything.

## Release review

Before calling a candidate ready:

1. Read `docs/agents/review-checklist.md` and the candidate's specification.
2. Pin the comparison with full commit IDs and review committed changes. Review staged or unstaged changes separately because the installed `code-review` skill compares the fixed point with `HEAD`.
3. Run `npm run release:check`.
4. Keep real Chrome/Brave validation in the release process; the DOM harness does not reproduce every extension, media, permission, focus, or network behaviour.
