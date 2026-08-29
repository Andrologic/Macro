import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..', '..');
const hooks = readFileSync(resolve(root, 'src-tauri', 'installer-hooks.nsh'), 'utf8');
const config = JSON.parse(readFileSync(resolve(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const smokeTest = readFileSync(resolve(root, 'dev', 'windows', 'test-nsis-installer.ps1'), 'utf8');

describe('Windows NSIS installer policy', () => {
  it('uses the conventional per-user Programs directory for a clean install', () => {
    expect(hooks).toContain('StrCpy $INSTDIR "$LOCALAPPDATA\\Programs\\Macro"');
  });

  it('keeps explicit and existing valid locations but rejects stale registry values', () => {
    expect(hooks).toContain("System::Call 'kernel32::GetCommandLineW() w .R6'");
    expect(hooks).toContain('${GetOptions} $R6 "/D=" $R7');
    expect(hooks).toContain('${If} $INSTDIR != $R8');
    expect(hooks).toContain('${If} $INSTDIR != "$LOCALAPPDATA\\Macro"');
    expect(hooks).toContain('IfFileExists "$R8\\macro.exe" macro_install_location_found 0');
    expect(hooks).toContain('IfFileExists "$R8\\uninstall.exe" macro_install_location_found 0');
    expect(hooks).toContain('ReadRegStr $R8 SHCTX "Software\\macro\\Macro" ""');
    expect(hooks).toContain('RMDir "$R8"');
    expect(hooks).toContain('!define MUI_CUSTOMFUNCTION_GUIINIT MacroResolveInstallLocation');
    expect(hooks.match(/Call MacroResolveInstallLocation/g)).toHaveLength(1);
    expect(hooks.match(/SetOutPath \$INSTDIR/g)).toHaveLength(2);
  });

  it('keeps the configured NSIS languages covered by the smoke test', () => {
    const configuredLanguages = config.bundle.windows.nsis.languages;
    expect(configuredLanguages).toEqual([
      'English',
      'French',
      'Spanish',
      'German',
      'Japanese',
      'Korean',
    ]);
    for (const language of configuredLanguages) {
      expect(smokeTest).toContain(`Name = '${language}'`);
    }
    for (const languageId of [1033, 1036, 1034, 1031, 1041, 1042]) {
      expect(hooks).toContain(`LangString MacroClosePrompt ${languageId}`);
    }
    expect(hooks).toContain('!define MUI_LANGDLL_ALWAYSSHOW');
    expect(smokeTest).toContain("-Name 'Installer Language' -Value ([string]$Language)");
  });

  it('backs up and restores registry state in a finally block', () => {
    expect(smokeTest).toContain('Invoke-RegCommand "export');
    expect(smokeTest).toContain('Invoke-RegCommand "import');
    expect(smokeTest).toMatch(/finally\s*\{\s*try\s*\{\s*Restore-TestState/);
    expect(smokeTest.indexOf('try {')).toBeLessThan(smokeTest.indexOf('New-Item -ItemType Directory -Path $registryBackup'));
    expect(smokeTest).toContain("Recovery files remain in '$testRoot'");
    expect(smokeTest).toContain('The restored key differs from its backup.');
    expect(smokeTest).toContain('if ($FailAfterStateIsolation)');
    expect(smokeTest).toContain('Assert-RegistryClean');
  });
});
