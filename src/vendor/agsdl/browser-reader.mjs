import { run as upstreamRun } from './experimental/modular-candidate-1/readers/javascript/reader.mjs';
import { contract, validateD } from './tooling/readers/javascript/core.mjs';
import { validateG } from './tooling/readers/javascript/graph.mjs';
import { prepareHashes } from './browser-hash.mjs';
export { parse, stringify } from './experimental/readers/javascript/json.mjs';

export async function run(request) {
  // Own the buffers so callers cannot change bytes while hashing is pending.
  const primary = new Uint8Array(request.primary);
  const annexes = Object.fromEntries(Object.entries(request.annexes ?? {}).map(([id, bytes]) => [id, new Uint8Array(bytes)]));
  await prepareHashes([primary, ...Object.values(annexes)]);
  return upstreamRun({ ...request, primary, annexes }, {
    contract, validateD, validateG,
    processor: { identity: 'macro/agsdl-browser-reader', version: '0.1.0' },
  });
}
