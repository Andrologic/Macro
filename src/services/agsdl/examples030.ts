/** Authored examples describe requests; installation and admission belong to native Preflight. */
export function productExample030(kind: 'release' | 'feature' | 'hotfix' | 'bugfix') {
  const missions = {
    release: 'Check the release prerequisites, review status and supplied installers. Run the project-provided checks that your permissions allow. Collect evidence and unresolved checks. Do not publish.',
    feature: 'Understand the requested feature and acceptance criteria, plan the work, implement it and run the relevant project-provided checks. Address review findings and report evidence and unavailable checks.',
    hotfix: 'Reproduce the urgent incident, diagnose its cause, implement a focused correction and verify the regression. Address review findings and report evidence and remaining risks.',
    bugfix: 'Reproduce the defect and expected behavior, diagnose its cause, correct it and run relevant regression checks. Address review findings and report evidence and unavailable checks.',
  };
  return {
    contract: 'agsdl-0.3.0', id: `example-${kind}`, title: kind[0].toUpperCase() + kind.slice(1),
    content: { projectGuidance: { value: 'Supply trusted project conventions, acceptance criteria and actual verification commands before launch. Imported evidence belongs in resources.' } },
    agents: {
      implement: { harness: 'codex', permissions: kind === 'release' ? 'read-only' : 'workspace',
        instructions: [{ value: missions[kind] }, { ref: 'projectGuidance' }],
        results: { report: { mediaType: 'text/plain', required: true } } },
      review: { harness: 'claude-code', permissions: 'read-only',
        instructions: 'Independently inspect the change and the supplied report against acceptance criteria. Choose ready only with sufficient evidence and no blocking findings; otherwise choose revise. Report findings and checks you could not perform.',
        results: { report: { mediaType: 'text/plain', required: true } } },
    },
    flow: { entry: 'implement', steps: {
      implement: { type: 'agent', agent: 'implement', maxVisits: 3, prompt: missions[kind],
        next: { step: 'review', message: { prompt: 'Review this candidate independently.', resources: { report: { from: ['results', 'report'] } } } } },
      review: { type: 'agent', agent: 'review', instance: 'new', next: {
        ready: [], revise: { step: 'implement', message: { prompt: 'Address these findings, then verify the complete mission.', resources: { findings: { from: ['results', 'report'] } } } },
      } },
    } },
  };
}

const reader = (instructions: string) => ({ harness: 'codex', permissions: 'read-only', instructions });
/** Complete, non-selectable guide examples. The product template ids stay backward compatible. */
export function authoringPatterns030(): Record<string, Record<string, unknown>> {
  return {
    assistant: { contract: 'agsdl-0.3.0', id: 'assistant', agents: { assistant: reader('Answer using the supplied information. State unknowns.') } },
    instructs: { contract: 'agsdl-0.3.0', id: 'instructs', agents: {
      lead: { ...reader('Define a bounded review mission. Submit instructions for the reviewer.'), instructs: true },
      reviewer: reader('Inspect the supplied mission and evidence. Report actual findings.'),
    }, flow: { entry: 'plan', steps: {
      plan: { type: 'agent', agent: 'lead', next: 'review' },
      review: { type: 'agent', agent: 'reviewer', prompt: 'Review the supplied material.' },
    } } },
    fanout: { contract: 'agsdl-0.3.0', id: 'fanout', agents: { reviewer: reader('Review the file named in item. Report findings; do not edit.'), summary: reader('Summarize the branch reports, including failures.') },
      flow: { entry: 'files', steps: {
        files: { type: 'call', command: 'git diff --name-only', parse: 'lines', next: { passed: { step: 'review', each: ['data', 'value'], max: 100, concurrency: 2 }, failed: 'summary' } },
        review: { type: 'agent', agent: 'reviewer', instance: 'new', next: 'gather' },
        gather: { type: 'join', failures: 'keep', remaining: 'wait', next: { done: 'summary', incomplete: 'summary' } },
        summary: { type: 'agent', agent: 'summary' },
      } } },
    quorum: { contract: 'agsdl-0.3.0', id: 'quorum', agents: { lead: reader('Prepare the material to review.'), reviewer: reader('Review independently. Submit choice approve or reject with reasons.'), summary: reader('Report the vote and the evidence. Do not publish.') },
      flow: { entry: 'prepare', steps: {
        prepare: { type: 'agent', agent: 'lead', next: ['first', 'second'] },
        first: { type: 'agent', agent: 'reviewer', instance: 'new', next: { approve: 'vote', reject: 'vote' } },
        second: { type: 'agent', agent: 'reviewer', instance: 'new', next: { approve: 'vote', reject: 'vote' } },
        vote: { type: 'join', quorum: { count: 1, accept: ['approve'] }, remaining: 'finish', next: { reached: 'summary', missed: 'summary' } },
        summary: { type: 'agent', agent: 'summary' },
      } } },
    composition: { contract: 'agsdl-0.3.0', id: 'composition', agents: { reviewer: reader('Review independently. Submit ready or revise.') },
      compositions: { review: { parameters: ['reviewer'], entry: 'inspect', outputs: ['ready', 'revise'], steps: {
        inspect: { type: 'agent', agent: { parameter: 'reviewer' }, instance: 'new', next: { ready: { output: 'ready' }, revise: { output: 'revise' } } },
      } } }, flow: { entry: 'review', steps: { review: { type: 'compose', composition: 'review', agents: { reviewer: 'reviewer' }, next: { ready: [], revise: [] } } } } },
    approval: { contract: 'agsdl-0.3.0', id: 'approval', agents: { writer: { ...reader('Prepare notes for human review.'), results: { notes: { required: true, mediaType: 'text/plain' } } }, reviewer: reader('Read the notes and the human comment. Describe the agreed next action; do not publish.') },
      flow: { entry: 'write', steps: {
        write: { type: 'agent', agent: 'writer', next: { step: 'approve', message: { prompt: 'Review these notes.', resources: { notes: { from: ['results', 'notes'] } } } } },
        approve: { type: 'approval', title: 'Accept these notes?', timeoutMs: 3600000, next: { accept: 'report', revise: { step: 'report', message: { prompt: 'Describe the requested revision.', resources: { comment: { from: ['comment'] }, notes: { from: ['message', 'resources', 'notes'] } } } } } },
        report: { type: 'agent', agent: 'reviewer', prompt: 'Report the decision and comment without performing external actions.' },
      } } },
  };
}
