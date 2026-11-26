<div align="center">
  <img src="src-tauri/icons/128x128.png" alt="ClipCargo" width="128">
  <h1>ClipCargo</h1>
  <p>A Windows desktop app for collecting web video pages you choose, then organizing, downloading, processing, and playing media locally.</p>
  <p><strong>English</strong> · <a href="README.zh-CN.md">中文</a></p>
  <p>
    <a href="https://github.com/Imoot-TT/ClipCargo/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Imoot-TT/ClipCargo/actions/workflows/ci.yml/badge.svg"></a>
    <img alt="Desktop version" src="https://img.shields.io/badge/desktop-latest-5364d9">
    <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20x64-0078d4">
    <img alt="Browser extension" src="https://img.shields.io/badge/browser-Chrome-4285f4">
    <img alt="License" src="https://img.shields.io/badge/license-proprietary-555b6e">
  </p>
</div>

---

## Download

[Download the latest ClipCargo for Windows x64](https://github.com/Imoot-TT/ClipCargo/releases/latest)

The Chrome extension will be installed from the Chrome Web Store after its review is complete. The ZIP in the release is the package submitted to the store, not a normal user installation file.

## Features

- Collect a web video page only when you explicitly choose to do so.
- Send the page link from the Chrome extension to ClipCargo on the same device.
- Assign items to projects and manage the collection inbox locally.
- Download, process, organize, and play collected media in the desktop app.
- Keep browser-extension queue data locally until the desktop app confirms receipt.

## Privacy

The browser extension processes only the URL, title, and project name for pages you actively collect. It communicates locally with ClipCargo on the same device and does not upload media files or page content to a remote server. Read the full [Privacy Policy](extension/PRIVACY_POLICY.md).

## License

ClipCargo is proprietary software. See the [End User License Agreement](docs/END_USER_LICENSE_AGREEMENT.md) and [LICENSE](LICENSE).

## Development and releases

The repository uses Windows CI for source checks, Rust tests, extension packaging, and version consistency. Tagged releases (`vMAJOR.MINOR.PATCH`) build the Windows installer and Chrome Web Store package, publish SHA-256 checksums, and attach them to the GitHub release. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [release checklist](docs/RELEASE-CHECKLIST.md).

## Independent product

ClipCargo is an independent product. It has no product, installation-package, or data dependency on Basic, Quick, or any other repository.
