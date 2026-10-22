import type { AgsdlChange, DesignMetadata, AgsdlDisplayMetadata, AgsdlEnvelopeMetadata } from '../../types/agsdl';
export type { DesignMetadata, AgsdlDisplayMetadata, AgsdlMigrationMetadata, AgsdlEnvelopeMetadata } from '../../types/agsdl';
import { AGSDL_CONTRACT, LEGACY_AGSDL_CONTRACT, object, readDocument, applyChanges, sourceAt } from './document';

export class DesignMetadataError extends Error {
  constructor() { super('The design metadata is malformed or uses an unsupported version. Its original contents have been preserved.'); this.name = 'DesignMetadataError'; }
}
export const defaultDesign = (): DesignMetadata => ({ version: 1, kind: 'system', purpose: '', context: '', rules: [], requirements: [] });
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string');
function valid(value: unknown): value is DesignMetadata {
  if (!isRecord(value) || value.version !== 1 || (value.kind !== 'system' && value.kind !== 'blueprint') || !strings(value, ['purpose', 'context'])) return false;
  if (!Array.isArray(value.rules) || !Array.isArray(value.requirements)) return false;
  if (!value.rules.every(item => isRecord(item) && strings(item, ['id', 'title', 'instructions']) && item.id !== '')) return false;
  if (!value.requirements.every(item => isRecord(item) && strings(item, ['id', 'label', 'description', 'value']) && item.id !== '' && (item.targetPath === undefined || typeof item.targetPath === 'string'))) return false;
  if (new Set(value.rules.map(item => item.id)).size !== value.rules.length || new Set(value.requirements.map(item => item.id)).size !== value.requirements.length) return false;
  return value.origin === undefined || (isRecord(value.origin) && strings(value.origin, ['planId', 'name']) && Number.isSafeInteger(value.origin.revision) && Number(value.origin.revision) >= 0 && (value.origin.branchName === undefined || typeof value.origin.branchName === 'string'));
}
function annotations(source: string): Record<string, unknown> {
  const root = readDocument(source).root;
  if (!isRecord(root)) throw new DesignMetadataError();
  if (root.annotations !== undefined && !isRecord(root.annotations)) throw new DesignMetadataError();
  return object(root.annotations);
}
/** Missing metadata is a draft; malformed or future versions remain explicitly unreadable. */
export function readDesign(source: string, metadata?: DesignMetadata): DesignMetadata {
  const doc = readDocument(source);
  const value = doc.contract === AGSDL_CONTRACT ? metadata : annotations(source).macroDesign;
  if (value === undefined) return defaultDesign();
  if (!valid(value)) throw new DesignMetadataError();
  return structuredClone(value);
}
/** Patch owned fields only, keeping opaque fields and unrelated source spans intact. */
export function designChanges(source: string, design: DesignMetadata): AgsdlChange[] {
  if (!valid(design)) throw new DesignMetadataError();
  design = updateDesignMetadata(readDesign(source), design);
  if (readDocument(source).contract === AGSDL_CONTRACT) throw new Error('AgSDL 0.2 design metadata belongs in the editor envelope. Use setDesign.');
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
        return sourceAt(applyChanges(`{"contract":"${LEGACY_AGSDL_CONTRACT}","row":${raw}}`, edits), '/row');
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
/** Validate the owned presentation fields while preserving unknown metadata. */
export function validDisplayMetadata(value: unknown): value is AgsdlDisplayMetadata {
  if (!isRecord(value) || (value.title !== undefined && typeof value.title !== 'string')) return false;
  if (value.cards === undefined) return true;
  const fields = ['title', 'description', 'macroGroup', 'macroTaskId', 'macroLegacyNodeId', 'macroStatus'];
  return isRecord(value.cards) && Object.values(value.cards).every(card =>
    isRecord(card) && fields.every(field => card[field] === undefined || typeof card[field] === 'string'));
}
/** Omission during an ordinary edit must not detach a launched copy from its blueprint. */
export function retainDesignOrigin(previous: DesignMetadata | undefined, next: DesignMetadata | undefined): DesignMetadata | undefined {
  if (!previous?.origin) return next;
  return { ...(next ?? previous), origin: { ...previous.origin, ...next?.origin } };
}
/** Preserve unrelated metadata and row extensions while updating owned design fields. */
export function updateDesignMetadata(previous: DesignMetadata | undefined, design: DesignMetadata): DesignMetadata {
  if (!valid(design) || (previous !== undefined && !valid(previous))) throw new DesignMetadataError();
  const merged = { ...structuredClone(previous), ...structuredClone(design) };
  for (const key of ['rules', 'requirements'] as const) {
    const rows = new Map((previous?.[key] ?? []).map(item => [item.id, item]));
    // Assign through a record because the two arrays have distinct row contracts.
    (merged as unknown as Record<string, unknown>)[key] = design[key].map(item => {
      const row = { ...structuredClone(rows.get(item.id)), ...structuredClone(item) };
      if (key === 'requirements' && !Object.hasOwn(item, 'targetPath')) delete (row as Record<string, unknown>).targetPath;
      return row;
    });
  }
  merged.origin = retainDesignOrigin(previous, design)?.origin;
  if (merged.origin === undefined) delete merged.origin;
  return merged;
}
/** Source text is immutable when only Macro design metadata changes in 0.2. */
export function withDocumentDesign(source: string, design: DesignMetadata, metadata: AgsdlEnvelopeMetadata = {}): { source: string } & AgsdlEnvelopeMetadata {
  if (readDocument(source).contract === AGSDL_CONTRACT) return { ...structuredClone(metadata), source, design: updateDesignMetadata(metadata.design, design) };
  return { ...structuredClone(metadata), source: withDesign(source, design) };
}
export function createEmptySystem(_title: string): string {
  return JSON.stringify({ contract: AGSDL_CONTRACT, id: `system-${crypto.randomUUID()}`, agents: {}, configurations: {}, bindings: {} }, null, 2);
}
export function createEmptySystemDocument(title: string): { source: string; annexes: Record<string, string> } & AgsdlEnvelopeMetadata {
  return { source: createEmptySystem(title), annexes: {}, design: defaultDesign(), display: { title } };
}
/** Migration requires a separately authored target and a reviewed loss list. */
export function manualMigrationInventory(source: string) {
  const doc = readDocument(source);
  if (doc.contract !== LEGACY_AGSDL_CONTRACT) throw new Error('Manual migration inventory requires an AgSDL 0.1 document.');
  return {
    from: LEGACY_AGSDL_CONTRACT,
    to: AGSDL_CONTRACT,
    originalSource: source,
    original: structuredClone(doc),
    requiresAuthoring: ['system-boundary-and-identities', 'typed-relations-and-dependencies', 'prompt-versus-resources', 'persistent-agent-lifecycle', 'flow-data-and-failure-paths', 'configuration-bindings-and-evidence', 'authority-and-approval-controls'],
  };
}

/** Explicit historical fixture and editor support for the unchanged 0.1 edition. */
export function createLegacyEmptySystem(title: string): string {
  return JSON.stringify({ contract: LEGACY_AGSDL_CONTRACT, root: { key: { scope: 'macro', id: crypto.randomUUID(), version: '1' }, kind: 'System', annotations: { title, macroDesign: defaultDesign() } }, definitions: [], relations: [], exports: [], dependencies: [], unresolved: [], extensions: [] }, null, 2);
}

/** Apply a changed adaptation only to its already-authored, existing string slot. */
export function adaptationChanges(source: string, previous: DesignMetadata, design: DesignMetadata): AgsdlChange[] {
  const doc = readDocument(source);
  if (doc.contract !== AGSDL_CONTRACT) return [];
  const old = new Map(previous.requirements.map(item => [item.id, item]));
  const changedDeclarations = new Set<string>();
  const changes: AgsdlChange[] = design.requirements.flatMap(item => {
    const before = old.get(item.id);
    if (!item.targetPath || item.targetPath !== before?.targetPath || item.value === before.value) return [];
    const value: unknown = JSON.parse(sourceAt(source, item.targetPath));
    if (typeof value !== 'string') throw new Error('The adaptation target must be an existing string value.');
    if (value === item.value) return [];
    const declaration = /^(\/(?:configurations|bindings)\/[^/]+)\//.exec(item.targetPath)?.[1];
    if (declaration) changedDeclarations.add(declaration);
    return [{ op: 'set' as const, path: item.targetPath, valueJson: JSON.stringify(item.value) }];
  });
  // Support assertions describe the exact declaration before adaptation.
  for (const path of changedDeclarations) {
    const [, catalog, name] = path.split('/');
    const declaration = object(object(doc[catalog])[name.replaceAll('~1', '/').replaceAll('~0', '~')]);
    if (declaration.claims !== undefined) changes.push({ op: 'remove', path: `${path}/claims` });
  }
  return changes;
}
