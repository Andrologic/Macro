# Installing Macro

Macro is a Tauri desktop app. The recommended installation path is to download a
published release. Source builds are available for contributors, packagers, and
users who want to rebuild the app locally.

## Download A Release

Open the latest GitHub release:

https://github.com/Andrologic/Macro/releases/latest

For the 0.1 release line, support is focused on the desktop workflow.
Stable GitHub releases include a universal macOS DMG, a Windows NSIS installer,
Linux AppImage/deb/rpm packages, checksums, and GitHub source archives. The
macOS package is signed, notarized, and runs on Apple Silicon and Intel Macs.
The Windows installer is Authenticode-signed, and the Linux packages are smoke
tested on the release runner before their checksums are generated.

After installing, configure your AI providers from the app settings. Macro does
not require provider keys to launch, but agentic workflows need at least one
configured provider.

## Build From Source

### Requirements

- [Bun](https://bun.sh) >= 1.1.0. This repository currently pins `bun@1.1.42`.
- [Rust](https://rustup.rs/) with Cargo, installed through `rustup`.
- Tauri system dependencies for your operating system.
- Python only if you need to run `bun run i18n:generate`.

### Platform Dependencies

**macOS**

- Xcode Command Line Tools: `xcode-select --install`
- Full Xcode is only needed for signed or notarized release builds.
- Universal local builds require both Rust macOS targets,
  `aarch64-apple-darwin` and `x86_64-apple-darwin`.

**Windows**

- Microsoft Visual Studio Build Tools with the Desktop development with C++
  workload.
- WebView2 Runtime. It is already installed on most recent Windows systems.

**Ubuntu/Debian**

```bash
sudo apt update
sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf rpm
```

## Run In Development

From the repository root:

```bash
bun install
bun run version:check
bun run tauri:dev
```

This starts the Tauri desktop app in development mode.

## Build A Desktop Bundle

```bash
bun run tauri:build
```

Tauri writes desktop bundles to:

```text
src-tauri/target/release/bundle/
```

On macOS, build a DMG with:

```bash
bun run tauri:build:dmg
```

The DMG is written to:

```text
src-tauri/target/release/bundle/dmg/
```

On macOS, build a universal DMG for Apple Silicon and Intel Macs with:

```bash
bun run tauri:build:dmg:mac-universal:test
```

The universal DMG is written under:

```text
src-tauri/target/universal-apple-darwin/release/bundle/
```

Official releases use stable `x.y.z` versions only. The GitHub release workflow
builds and smoke-tests Windows with NSIS and Linux with AppImage, deb, and rpm
packages. The `macro-headless` development binary is never included.

## Provider Keys And Local Secrets

No API key is required to compile Macro. Development-only provider keys can be
placed in:

```text
dev/ai-keys.local.json
```

That file is ignored by Git and must not be included in source packages. Do not
put real secrets in `public/`, `.env`, or committed source files.

For day-to-day Tauri development, copy the example file:

```bash
cp dev/ai-keys.local.example.json dev/ai-keys.local.json
```

Then edit it with local provider definitions or development API keys.

## Useful Validation Commands

For source package checks:

```bash
bun run version:check
bun run typecheck
bun run lint
bun run test
cargo test --manifest-path src-tauri/Cargo.toml
bun run build
```

For the full local CI pipeline:

```bash
bun run ci
```
