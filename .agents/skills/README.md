# Pinned Matt Pocock skills

These project-local skills were installed from [`mattpocock/skills`](https://github.com/mattpocock/skills) at commit `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`.

Installed directories:

- `setup-matt-pocock-skills`
- `code-review`
- `diagnosing-bugs`
- `tdd`
- `codebase-design`
- `improve-codebase-architecture`
- `domain-modeling` (supporting dependency for the architecture survey)
- `grilling` (supporting dependency for the architecture survey)

They were installed with Codex's `skill-installer` Git sparse-checkout path. Updates are intentionally manual: inspect a new upstream commit, reinstall with an explicit `--ref`, and review the resulting diff before committing it. Do not replace this pin with an unattended `@latest` update.

Upstream license: MIT; a copy is included as `LICENSE.mattpocock`. These skills guide agent behaviour; they do not replace the project's test suite, packaged-extension checks, Chrome/Brave validation, or security review.
