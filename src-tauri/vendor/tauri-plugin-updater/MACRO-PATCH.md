# Local updater extension

Source: `tauri-plugin-updater` 2.10.1, copied from the local Cargo registry.
The upstream licenses are included beside this file.

Macro adds `Updater::update_from_release` to reconstruct the native installation
context from cached release metadata without HTTP requests. `check` uses the
same constructor after its normal remote discovery and version comparison.
The platform-specific installers remain upstream code.

Macro verifies the cached package size, SHA-256 and Minisign signature before
calling `Update::install`. The reconstructed download URL is unused.

When updating this dependency, preserve the offline constructor and its test,
or replace it with an equivalent upstream API before removing this patch.
