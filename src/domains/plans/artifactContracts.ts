import type { PlanNode, PlanNodeArtifactContract } from '../../types';

export const sanitizeId = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '') || `artifact-${Date.now()}`;

export const normalizeArtifactContracts = (
  node: Pick<PlanNode, 'artifactContracts'>,
): PlanNodeArtifactContract[] =>
  (node.artifactContracts || [])
    .filter((contract) =>
      Boolean(
        contract &&
          typeof contract.id === 'string' &&
          contract.id.trim().length > 0 &&
          typeof contract.title === 'string' &&
          contract.title.trim().length > 0,
      ),
    )
    .map((contract) => ({
      id: sanitizeId(contract.id),
      title: contract.title.trim(),
      kind: typeof contract.kind === 'string' && contract.kind.trim() ? contract.kind.trim() : 'note',
      ...(typeof contract.description === 'string' && contract.description.trim()
        ? { description: contract.description.trim() }
        : {}),
      required: true,
    }));
