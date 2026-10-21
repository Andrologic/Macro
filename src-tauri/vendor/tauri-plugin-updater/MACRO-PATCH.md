# Local updater extension

Source: `tauri-plugin-updater` 2.13.3, downloaded from the official crates.io
package. The upstream licenses are included beside this file.

Macro adds `Updater::update_from_release` to reconstruct the native installation
context from cached release metadata without HTTP requests. The upstream `check`
method retains its own constructor after remote discovery and version comparison.
The platform-specific installers remain upstream code.

Macro verifies the cached package size, SHA-256, Minisign signature and signed
version before calling `Update::install`. The reconstructed download URL is
unused. The test `cached_release_reconstruction_does_not_contact_the_channel`
guards this offline path.

When updating this dependency, preserve the offline constructor and its test,
or replace it with an equivalent upstream API before removing this patch.
