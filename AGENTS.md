# Nicotine+ Wasm

- Keep upstream code in place. Prefer changes in the npm package or relay
  over edits to `pynicotine/`. Preserve upstream license notices and use
  AGPL-3.0-only for new fork code.
- Keep networking outbound-only. The browser connects through a private relay.
  Run protocol tests with fixtures and keep live Soulseek credentials out of CI.
- Use the checks in `.github/workflows/fork-ci.yml`. Run builds and browser
  suites in GitHub Actions when working on a Raspberry Pi.
- Target `master`. Use Conventional Commits for PR titles and squash merge
  with the title as the commit message.
  Upstream syncs use `.github/upstream-release` as their merge base. Update the
  pin only when the corresponding release content lands. Keep the fork README
  during a sync, and review other upstream conflicts.
