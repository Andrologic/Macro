import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT_DIR = process.cwd();
const SRC_DIR = join(ROOT_DIR, 'src');

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return walk(fullPath);
    }

    return fullPath;
  });

describe('notification conventions', () => {
  it('keeps the root AGENTS.md instruction file present', () => {
    expect(existsSync(join(ROOT_DIR, 'AGENTS.md'))).toBe(true);
  });

  it('keeps notification template consumers on direct imports to avoid chunk barrel warnings', () => {
    const checks = [
      {
        filePath: join(SRC_DIR, 'components/layout/NotificationCenterPopover.tsx'),
        disallowedImport: "from '../ui/notifications'",
      },
      {
        filePath: join(SRC_DIR, 'components/settings/views/NotificationsView.tsx'),
        disallowedImport: "from '../../ui/notifications'",
      },
      {
        filePath: join(SRC_DIR, 'components/ui/toastService.tsx'),
        disallowedImport: "from './notifications'",
      },
    ];

    const offenders = checks
      .filter(({ filePath, disallowedImport }) =>
        readFileSync(filePath, 'utf8').includes(disallowedImport)
      )
      .map(({ filePath }) => filePath);

    expect(offenders).toEqual([]);
  });

  it('avoids direct toast usage in feature code outside infrastructure and tests', () => {
    const offenders = walk(SRC_DIR)
      .filter((filePath) => /\.(ts|tsx)$/.test(filePath))
      .filter((filePath) => !filePath.endsWith('toastService.tsx'))
      .filter((filePath) => !/\.test\.(ts|tsx)$/.test(filePath))
      .filter((filePath) => {
        const source = readFileSync(filePath, 'utf8');
        return (
          /import\s+\{\s*toast\s*\}\s+from\s+['"].*toastService['"]/.test(source) ||
          /\btoast\.(success|info|warning|error)\(/.test(source)
        );
      });

    expect(offenders).toEqual([]);
  });
});
