# ClipCargo Third-Party Notices

Last reviewed: 2026-11-09

This document records the third-party components used or downloaded by ClipCargo. It is an engineering inventory, not legal advice. A distribution release still requires a license review against the exact binaries shipped or downloaded by that release.

## ClipCargo application

- Current package metadata: `UNLICENSED`.
- A proprietary/commercial license has not yet been selected and added to the repository.

## yt-dlp Windows executable

- Binary: `yt-dlp.exe`, downloaded from the official latest GitHub release.
- Integrity: checked against the release `SHA2-256SUMS` before installation.
- Upstream project license: Unlicense.
- Windows PyInstaller executable: GPL-3.0-or-later combined work because it includes GPL-licensed dependencies.
- Project: https://github.com/yt-dlp/yt-dlp
- Release notices: https://github.com/yt-dlp/yt-dlp/blob/master/THIRD_PARTY_LICENSES.txt
- Installer output: `yt-dlp.manifest.json` and `yt-dlp-NOTICE.txt` are written beside the binary.

## Deno

- Binary: official Windows x64 Deno release archive.
- Integrity: checked against the official `.sha256sum` before installation.
- License: MIT.
- Project: https://github.com/denoland/deno
- License text: https://github.com/denoland/deno/blob/main/LICENSE.md
- Installer output: `deno.manifest.json` and `deno-NOTICE.txt` are written beside the binary.

## FFmpeg / ffprobe

- Binary distribution: Gyan.dev `ffmpeg-release-essentials.zip`.
- Integrity: checked against the publisher's SHA-256 file before installation.
- Actual audited build: FFmpeg 9.0.2 essentials build with `--enable-gpl`, `--enable-version3`, `--enable-static`, `--enable-libx264`, and `--enable-libx265`.
- Applicable binary license: GPL-3.0-or-later.
- Upstream legal guidance: https://ffmpeg.org/legal.html
- Binary/build source: https://www.gyan.dev/ffmpeg/builds/
- Installer output: the archive's `LICENSE` and `README.txt` are extracted as `FFmpeg-LICENSE.txt` and `FFmpeg-README.txt`; `FFmpeg-NOTICE.txt` and a manifest are also written beside the executables.

## Lucide icons

- Package: `lucide-static`.
- License: ISC.
- License file: `src/assets/icons/LUCIDE-LICENSE`.

## Rust and JavaScript dependencies

- JavaScript package lock and Rust lockfile pin the dependency versions used by the project.
- Run `npm run licenses` to regenerate the locked dependency inventory and deduplicated license-text bundle.
- Generated inventory: `docs/generated/dependency-license-inventory.json`.
- Generated license text bundle: `docs/generated/DEPENDENCY-LICENSES.txt`.
- Packages without a local license file remain listed explicitly in the generated inventory and require release review.

## Release blockers

Before public or commercial distribution:

1. Choose and add the ClipCargo application license and copyright notice.
2. Review every dependency flagged without local license text in the generated inventory and obtain any required notice text.
3. Verify that the exact yt-dlp executable's full bundled third-party license file is distributed or made directly accessible.
4. Retain the exact FFmpeg license/build files extracted by the installer and provide the corresponding source in the manner required by GPLv3.
5. Obtain release counsel review for GPL obligations, codec patents, platform terms, and the planned commercial distribution model.
