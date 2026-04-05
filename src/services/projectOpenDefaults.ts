import { getDesktopPlatform, type DesktopPlatform } from '../utils/desktopPlatform';

export type ProjectOpenAction = 'editor' | 'terminal' | 'files';

export const getDefaultProjectOpenCommand = (
  action: ProjectOpenAction,
  platform: DesktopPlatform = getDesktopPlatform()
): string => {
  switch (platform) {
    case 'macos':
      if (action === 'editor') {
        return 'open -a "Visual Studio Code"';
      }
      if (action === 'terminal') {
        return 'open -a Terminal';
      }
      return 'open -a Finder';
    case 'windows':
      if (action === 'editor') {
        return 'code';
      }
      if (action === 'terminal') {
        return 'wt -d';
      }
      return 'explorer';
    case 'linux':
      if (action === 'editor') {
        return 'code';
      }
      if (action === 'terminal') {
        return 'x-terminal-emulator --working-directory';
      }
      return 'xdg-open';
    default:
      if (action === 'editor') {
        return 'code';
      }
      if (action === 'terminal') {
        return 'open -a Terminal';
      }
      return 'open';
  }
};
