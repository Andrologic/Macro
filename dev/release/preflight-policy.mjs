export const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function expectedReleaseTag(version) {
  if (!STABLE_VERSION.test(version)) {
    throw new Error(`Release version must be stable x.y.z; found "${version}".`);
  }
  return `v${version}`;
}

export function packageCommandForPlatform(platform) {
  switch (platform) {
    case 'win32':
      return ['bun', ['run', 'tauri:build:nsis']];
    case 'darwin':
      return ['bun', ['run', 'tauri:build:dmg:mac-universal:test']];
    case 'linux':
      return ['bun', ['dev/tauri-cli.mjs', 'build', '--bundles', 'appimage,deb,rpm']];
    default:
      throw new Error(`Release packaging is unsupported on platform "${platform}".`);
  }
}
