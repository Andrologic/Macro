import type { RunActionResult030, RunHumanReceipt030, RunHumanRequest030, RunHumanResolution030, RunHumanState030, RunHumanSubmission030 } from '../../types/agsdlRunUi030';
import type { HumanDraftStorage030 } from '../../services/agsdl/humanRequests030';

export const humanScope030 = { systemStartId: 'synthetic-run', source: { owner: { projectId: 'synthetic-project', planId: 'release', branch: 'develop' }, revision: '12', sourceSha256: 'a'.repeat(64) } };
export const occurrence030 = { kind: 'available' as const, scope: { ...humanScope030, snapshotId: 'capture' }, activationId: 'activation-distinct-from-work' };
export function humanFixture030(overrides: Partial<RunHumanRequest030> = {}): RunHumanRequest030 {
  return {
    scope: humanScope030, id: 'release-choice', revision: '0', workIds: ['public-human-work'],
    occurrences: [{ workId: 'public-human-work', activation: occurrence030 }],
    content: { kind: 'flowChoice', title: 'Publier cette version ?', description: 'Relisez le contenu avant de choisir la suite.',
      messageJson: '{ "prompt": "Vérifiez les notes de version.", "resources": { "notes": "Corrections et améliorations" }, "item": { "n": 900719925474099312345 } }',
      choices: ['publier', 'réviser', 'refuser'] },
    state: { kind: 'open' },
    clock: { kind: 'available', value: { openedAtMs: '90071992547409930000', observedAtMs: '90071992547409940000', timeoutMs: '60000',
      works: [{ workId: 'public-human-work', machineElapsedMs: '5000', machineRemainingMs: '115000', machinePaused: true }] } },
    ...overrides,
  };
}
export function resolutionFixture030(overrides: Partial<RunHumanResolution030> = {}): RunHumanResolution030 {
  return { reason: 'person', receiptId: 'resolution', resolvedAtMs: '90071992547409945000', accepted: true,
    answer: { answer: { kind: 'approval', choice: 'refuser', comment: 'Une réponse négative reste un choix normal.' }, origin: 'syntheticPerson', receivedAtMs: '90071992547409944000' },
    ...overrides } as RunHumanResolution030;
}
export function memoryDraftStorage030(): HumanDraftStorage030 {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
}

/** Test double only. It records exact inputs, never exercises IPC or providers. */
export function humanTransportDouble030(initial = humanFixture030()) {
  let current = initial;
  const submissions: RunHumanSubmission030[] = [];
  let mode: 'received' | 'conflict' | 'closed' | 'uncertain' | 'invalid' = 'received';
  let readsFail = false;
  return {
    submissions,
    setCurrent(value: RunHumanRequest030) { current = value; },
    setMode(value: typeof mode) { mode = value; },
    failReads(value: boolean) { readsFail = value; },
    async read() { if (readsFail) throw new Error('read unavailable'); return current; },
    async submit(input: RunHumanSubmission030): Promise<RunActionResult030<'flowChoice'>> {
      submissions.push(structuredClone(input));
      if (mode === 'uncertain') throw new Error('acknowledgement lost');
      if (mode === 'conflict') {
        current = { ...current, revision: (BigInt(current.revision) + 1n).toString() };
        return { kind: 'refused', refusal: { code: 'REVISION_CONFLICT', message: 'La demande a été actualisée.', currentRevision: current.revision } };
      }
      if (mode === 'invalid') return { kind: 'refused', refusal: { code: 'INPUT_CONSTRAINT', message: 'Réponse non conforme au format attesté.', currentRevision: current.revision } };
      if (mode === 'closed') return { kind: 'refused', refusal: { code: 'REQUEST_CLOSED', message: 'Cette demande a déjà reçu une décision.', currentRevision: current.revision } };
      const state: RunHumanState030 = { kind: 'submitted', receiptId: 'submission', answer: { answer: input.answer, origin: 'syntheticPerson', receivedAtMs: '90071992547409944000' } };
      current = { ...current, revision: (BigInt(current.revision) + 1n).toString(), state };
      const receipt: RunHumanReceipt030 = { scope: current.scope, requestId: current.id, receiptId: 'submission', revision: current.revision, state };
      return { kind: 'received', receipt };
    },
  };
}
