# Contributing to ClipCargo

ClipCargo is a local-first Windows desktop application. The product boundary is documented in [`docs/OPTIMIZATION-DIRECTION.md`](docs/OPTIMIZATION-DIRECTION.md); changes should preserve the native JavaScript, Rust, SQLite and Chrome Native Messaging architecture.

## Before opening a pull request

Run these checks from the repository root:

```powershell
npm ci
npm run check
npm run package:store-extension
```

The CI workflow repeats the source, extension, Rust and version-contract checks on Windows. A release is created from a `vMAJOR.MINOR.PATCH` tag after the version in `package.json`, `extension/manifest.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` is aligned.

Do not commit `node_modules`, Rust targets, installers, generated reports, local databases, component binaries, or browser profiles. Do not add credentials or cookies to issues, logs, fixtures, or pull requests.

## Product rules

- Keep media and task behavior out of HTML event handlers when a reusable application boundary is appropriate.
- Keep downloads, media processing, and component installation local and explicit.
- Do not add watermark removal, copy Concat assets, or introduce React/Vue without a new product decision.
- Keep the main navigation and settings navigation in their fixed left-side positions; do not move them between side, top, or bottom layouts.
- Avoid over-explaining the interface: menu items and controls use short labels, with help text only for genuinely ambiguous, risky, or contextual actions. Do not append explanatory microcopy to menu items.
- Include a regression test for queue, bridge, task, media-path, or release behavior that changes.
