import type { AgsdlChange } from '../../types/agsdl';
import { AGSDL_CONTRACT, object, readDocument, applyChanges, sourceAt } from './document';

export interface DesignMetadata {
  version: 1;
  kind: 'system' | 'blueprint';
  purpose: string;
  context: string;
  rules: Array<{ id: string; title: string; instructions: string }>;
  requirements: Array<{ id: string; label: string; description: string; value: string; targetPath?: string }>;
  origin?: { planId: string; name: string; revision: number };
}
export class DesignMetadataError extends Error {
  constructor() { super('The design metadata is malformed or uses an unsupported version. Its original contents have been preserved.'); this.name = 'DesignMetadataError'; }
}
const defaults = (): DesignMetadata => ({ version: 1, kind: 'system', purpose: '', context: '', rules: [], requirements: [] });
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string');
function valid(value: unknown): value is DesignMetadata {
  if (!isRecord(value) || value.version !== 1 || (value.kind !== 'system' && value.kind !== 'blueprint') || !strings(value, ['purpose', 'context'])) return false;
  if (!Array.isArray(value.rules) || !Array.isArray(value.requirements)) return false;
  if (!value.rules.every(item => isRecord(item) && strings(item, ['id', 'title', 'instructions']) && item.id !== '')) return false;
  if (!value.requirements.every(item => isRecord(item) && strings(item, ['id', 'label', 'description', 'value']) && item.id !== '' && (item.targetPath === undefined || typeof item.targetPath === 'string'))) return false;
  if (new Set(value.rules.map(item => item.id)).size !== value.rules.length || new Set(value.requirements.map(item => item.id)).size !== value.requirements.length) return false;
  return value.origin === undefined || (isRecord(value.origin) && strings(value.origin, ['planId', 'name']) && Number.isSafeInteger(value.origin.revision) && Number(value.origin.revision) >= 0);
}
function annotations(source: string): Record<string, unknown> {
  const root = readDocument(source).root;
  if (!isRecord(root)) throw new DesignMetadataError();
  if (root.annotations !== undefined && !isRecord(root.annotations)) throw new DesignMetadataError();
  return object(root.annotations);
}
/** Missing metadata is a draft; malformed or future versions remain explicitly unreadable. */
export function readDesign(source: string): DesignMetadata {
  const value = annotations(source).macroDesign;
  if (value === undefined) return defaults();
  if (!valid(value)) throw new DesignMetadataError();
  return structuredClone(value);
}
/** Patch owned fields only, keeping opaque fields and unrelated source spans intact. */
export function designChanges(source: string, design: DesignMetadata): AgsdlChange[] {
  if (!valid(design)) throw new DesignMetadataError();
  const previous = readDesign(source);
  const root = object(readDocument(source).root);
  if (root.annotations === undefined) return [{ op: 'set', path: '/root/annotations', valueJson: JSON.stringify({ macroDesign: design }) }];
  if (annotations(source).macroDesign === undefined) return [{ op: 'set', path: '/root/annotations/macroDesign', valueJson: JSON.stringify(design) }];
  const changes: AgsdlChange[] = [];
  for (const key of ['version', 'kind', 'purpose', 'context', 'rules', 'requirements', 'origin'] as const) {
    const next: unknown = design[key];
    if (key === 'rules' || key === 'requirements') {
      const old = new Map(previous[key].map((item, index) => [item.id, index]));
      const fields = key === 'rules' ? ['id', 'title', 'instructions'] : ['id', 'label', 'description', 'value', 'targetPath'];
      const rows = design[key].map(item => {
        const index = old.get(item.id);
        if (index === undefined) return JSON.stringify(item);
        const raw = sourceAt(source, `/root/annotations/macroDesign/${key}/${index}`);
        const before = object(previous[key][index]), after = object(item);
        const edits: AgsdlChange[] = fields.filter(field => before[field] !== after[field]).map(field => after[field] === undefined
          ? { op: 'remove', path: `/row/${field}` }
          : { op: 'set', path: `/row/${field}`, valueJson: JSON.stringify(after[field]) });
        if (!edits.length) return raw;
        return sourceAt(applyChanges(`{"contract":"${AGSDL_CONTRACT}","row":${raw}}`, edits), '/row');
      });
      const valueJson = `[${rows.join(',')}]`;
      if (JSON.stringify(previous[key]) !== JSON.stringify(JSON.parse(valueJson))) changes.push({ op: 'set', path: `/root/annotations/macroDesign/${key}`, valueJson });
      continue;
    }
    if (JSON.stringify(previous[key]) === JSON.stringify(next)) continue;
    changes.push(next === undefined ? { op: 'remove', path: `/root/annotations/macroDesign/${key}` } : { op: 'set', path: `/root/annotations/macroDesign/${key}`, valueJson: JSON.stringify(next) });
  }
  return changes;
}
export function withDesign(source: string, design: DesignMetadata): string {
  const changes = designChanges(source, design);
  return changes.length ? applyChanges(source, changes) : source;
}
export function createEmptySystem(title: string): string {
  return JSON.stringify({ contract: AGSDL_CONTRACT, root: { key: { scope: 'macro', id: crypto.randomUUID(), version: '1' }, kind: 'System', annotations: { title, macroDesign: defaults() } }, definitions: [], relations: [], exports: [], dependencies: [], unresolved: [], extensions: [] }, null, 2);
}
