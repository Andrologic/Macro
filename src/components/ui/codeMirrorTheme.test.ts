import { describe, expect, it } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { defaultTheme } from '../theme/ThemeProvider';
import { createCodeMirrorDiffTheme } from './codeMirrorTheme';

// Inspect the emitted style module: hover is a stylesheet rule, not an inline style.
describe('CodeMirror diff collapsed lines', () => {
  it.each([
    ['dark', '#6366f1', 'rgba(99, 102, 241, 0.820)'],
    ['light', '#4f46e5', 'rgba(79, 70, 229, 0.980)'],
    ['light', '#abc', 'rgba(170, 187, 204, 0.980)'],
  ] as const)('emits a valid primary hover for %s with %s', (type, primary, expected) => {
    const state = EditorState.create({ extensions: [createCodeMirrorDiffTheme({
      ...defaultTheme, type, colors: { ...defaultTheme.colors, primary },
    })] });
    const rules = state.facet(EditorView.styleModule).flat().map((module) => module.getRules()).join('\n');
    const hover = rules.match(/\.cm-collapsedLines:hover\s*\{([^}]+)\}/)?.[1];
    expect(hover).toContain(`background-color: ${expected}`);
    expect(hover).not.toContain('NaN');
    expect(rules).toContain('.cm-merge-revert button');
  });
});
