import { RangeSetBuilder, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter } from '@codemirror/view';

export interface CodeViewerLineHighlight {
  lineNumber: number;
  lineClass: string;
  gutterClass?: string;
}

class DiffGutterMarker extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof DiffGutterMarker && other.elementClass === this.elementClass;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `cm-gutterElement ${this.elementClass}`;
    return span;
  }
}

const gutterMarkerCache = new Map<string, DiffGutterMarker>();

const getGutterMarker = (className: string): DiffGutterMarker => {
  const existing = gutterMarkerCache.get(className);
  if (existing) {
    return existing;
  }

  const marker = new DiffGutterMarker(className);
  gutterMarkerCache.set(className, marker);
  return marker;
};

const buildLineDecorationSet = (doc: Text, lineHighlights: CodeViewerLineHighlight[]) => {
  const builder = new RangeSetBuilder<Decoration>();

  lineHighlights.forEach(({ lineNumber, lineClass }) => {
    if (!lineClass || !Number.isFinite(lineNumber) || lineNumber < 1 || lineNumber > doc.lines) {
      return;
    }

    const line = doc.line(lineNumber);
    builder.add(
      line.from,
      line.from,
      Decoration.line({
        attributes: { class: lineClass },
      })
    );
  });

  return builder.finish();
};

const buildGutterMarkers = (doc: Text, lineHighlights: CodeViewerLineHighlight[]) => {
  const markers: Array<[number, number, GutterMarker]> = [];

  lineHighlights.forEach(({ lineNumber, gutterClass }) => {
    if (!gutterClass || !Number.isFinite(lineNumber) || lineNumber < 1 || lineNumber > doc.lines) {
      return;
    }

    const line = doc.line(lineNumber);
    markers.push([line.from, line.from, getGutterMarker(gutterClass)]);
  });

  return markers;
};

export const createCodeMirrorDiffHighlightExtension = (
  doc: Text,
  lineHighlights: CodeViewerLineHighlight[]
): Extension[] => {
  const lineDecorations = EditorView.decorations.of(buildLineDecorationSet(doc, lineHighlights));

  if (lineHighlights.length === 0) {
    return [lineDecorations];
  }

  const gutterMarkersResult = buildGutterMarkers(doc, lineHighlights);

  const gutterExtension = gutter({
    class: 'cm-diff-gutter',
    markers() {
      const builder = new RangeSetBuilder<GutterMarker>();
      for (const [from, to, marker] of gutterMarkersResult) {
        builder.add(from, to, marker);
      }
      return builder.finish();
    },
  });

  return [lineDecorations, gutterExtension];
};

export const codeMirrorDiffHighlightBaseTheme = EditorView.baseTheme({
  '&dark .cm-line.cm-diff-removed': {
    backgroundColor: 'rgba(248, 81, 73, 0.17)',
    boxShadow: 'inset 3px 0 0 rgb(248 81 73 / 0.95)',
  },
  '&dark .cm-line.cm-diff-modified-left': {
    backgroundColor: 'rgba(248, 81, 73, 0.24)',
    boxShadow: 'inset 4px 0 0 rgb(248 81 73 / 1)',
  },
  '&dark .cm-line.cm-diff-added': {
    backgroundColor: 'rgba(46, 160, 67, 0.18)',
    boxShadow: 'inset 3px 0 0 rgb(46 160 67 / 0.95)',
  },
  '&dark .cm-line.cm-diff-modified-right': {
    backgroundColor: 'rgba(46, 160, 67, 0.25)',
    boxShadow: 'inset 4px 0 0 rgb(46 160 67 / 1)',
  },
  '&dark .cm-gutterElement.cm-diff-gutter-removed': {
    backgroundColor: 'rgba(248, 81, 73, 0.18)',
    color: '#ffd7d5',
  },
  '&dark .cm-gutterElement.cm-diff-gutter-modified-left': {
    backgroundColor: 'rgba(248, 81, 73, 0.26)',
    color: '#fff0ef',
  },
  '&dark .cm-gutterElement.cm-diff-gutter-added': {
    backgroundColor: 'rgba(46, 160, 67, 0.18)',
    color: '#c8f2d1',
  },
  '&dark .cm-gutterElement.cm-diff-gutter-modified-right': {
    backgroundColor: 'rgba(46, 160, 67, 0.26)',
    color: '#f2fff4',
  },
  '&dark .cm-line.cm-diff-staged-removed': {
    backgroundColor: 'rgba(248, 81, 73, 0.11)',
    boxShadow: 'inset 3px 0 0 rgba(248, 81, 73, 0.58)',
  },
  '&dark .cm-line.cm-diff-staged-added': {
    backgroundColor: 'rgba(46, 160, 67, 0.12)',
    boxShadow: 'inset 3px 0 0 rgba(46, 160, 67, 0.56)',
  },
  '&dark .cm-gutterElement.cm-diff-gutter-staged-removed': {
    backgroundColor: 'rgba(248, 81, 73, 0.12)',
    color: '#f5c5c2',
  },
  '&dark .cm-gutterElement.cm-diff-gutter-staged-added': {
    backgroundColor: 'rgba(46, 160, 67, 0.12)',
    color: '#c1e8ca',
  },
  '&light .cm-line.cm-diff-removed': {
    backgroundColor: 'rgba(248, 81, 73, 0.12)',
    boxShadow: 'inset 3px 0 0 rgb(207 34 46 / 0.85)',
  },
  '&light .cm-line.cm-diff-modified-left': {
    backgroundColor: 'rgba(248, 81, 73, 0.18)',
    boxShadow: 'inset 4px 0 0 rgb(207 34 46 / 0.95)',
  },
  '&light .cm-line.cm-diff-added': {
    backgroundColor: 'rgba(46, 160, 67, 0.12)',
    boxShadow: 'inset 3px 0 0 rgb(26 127 55 / 0.85)',
  },
  '&light .cm-line.cm-diff-modified-right': {
    backgroundColor: 'rgba(46, 160, 67, 0.18)',
    boxShadow: 'inset 4px 0 0 rgb(26 127 55 / 0.95)',
  },
  '&light .cm-gutterElement.cm-diff-gutter-removed': {
    backgroundColor: 'rgba(248, 81, 73, 0.14)',
    color: '#8c2f39',
  },
  '&light .cm-gutterElement.cm-diff-gutter-modified-left': {
    backgroundColor: 'rgba(248, 81, 73, 0.2)',
    color: '#7a2430',
  },
  '&light .cm-gutterElement.cm-diff-gutter-added': {
    backgroundColor: 'rgba(46, 160, 67, 0.14)',
    color: '#1f5e32',
  },
  '&light .cm-gutterElement.cm-diff-gutter-modified-right': {
    backgroundColor: 'rgba(46, 160, 67, 0.2)',
    color: '#144926',
  },
  '&light .cm-line.cm-diff-staged-removed': {
    backgroundColor: 'rgba(248, 81, 73, 0.08)',
    boxShadow: 'inset 3px 0 0 rgba(207, 34, 46, 0.42)',
  },
  '&light .cm-line.cm-diff-staged-added': {
    backgroundColor: 'rgba(46, 160, 67, 0.08)',
    boxShadow: 'inset 3px 0 0 rgba(26, 127, 55, 0.4)',
  },
  '&light .cm-gutterElement.cm-diff-gutter-staged-removed': {
    backgroundColor: 'rgba(248, 81, 73, 0.1)',
    color: '#9d5660',
  },
  '&light .cm-gutterElement.cm-diff-gutter-staged-added': {
    backgroundColor: 'rgba(46, 160, 67, 0.1)',
    color: '#3f7651',
  },
});
