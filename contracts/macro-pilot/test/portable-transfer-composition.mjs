// Pure contract composition with synthetic authenticated facts, no native pin.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { scenario } from './transfer-decision-vectors.mjs';
import { planDecision, fingerprint } from '../v2/transfer-decision-validate.mjs';
const contractSha=createHash('sha256').update(readFileSync(new URL('../v2/portable-chat-history/portable-chat-history-contract.json',import.meta.url))).digest('hex');
const s=scenario(), clone=structuredClone, ctx=clone(s.context);ctx.supported_context_contracts=[contractSha];
const portableFixture=JSON.parse(readFileSync(new URL('../v2/portable-chat-history/fixtures.json',import.meta.url),'utf8')).descriptor;
assert.equal(portableFixture.content_contract_sha256,contractSha);
const manifest={...s.manifest,content_contract_sha256:contractSha,manifest_sha256:portableFixture.manifest_sha256};
const seal=s.request('seal',s.reserve.result.record.revision,{manifest});
const sealProof=s.attest(seal,'source_sealed',fingerprint('manifest',manifest),fingerprint('frozen',s.frozen),false,ctx);
const accepted=s.call(seal,s.reserve.result.ledger,s.reserve.result.record,[sealProof],ctx);
assert.equal(accepted.result.record.manifest.content_contract_sha256,contractSha);
for(const supported_context_contracts of [[],['0'.repeat(64)]])assert.equal(planDecision(seal,s.reserve.result.ledger,s.reserve.result.record,{...accepted.context,supported_context_contracts}).code,'unsupported_context');
const prepared={...s.prepared,manifest_digest:fingerprint('manifest',manifest)};
const ready=s.request('ready',accepted.result.record.revision,{prepared});
const readyProof=s.attest(ready,'target_pinned',fingerprint('prepared',prepared),fingerprint('manifest',manifest),true,ctx);
const pinned=s.call(ready,accepted.result.ledger,accepted.result.record,[readyProof],ctx);
const commit=s.request('commit',pinned.result.record.revision,{});
const proofs=[s.attest(commit,'source_maintained',fingerprint('frozen',s.frozen),fingerprint('manifest',manifest),false,ctx),s.attest(commit,'target_maintained',fingerprint('prepared',prepared),fingerprint('prepared',prepared),true,ctx)];
const committed=s.call(commit,pinned.result.ledger,pinned.result.record,proofs,ctx);assert.equal(committed.result.receipt.outcome,'committed');
for(const [request,previous,context]of [[ready,accepted,pinned.context],[commit,pinned,committed.context]]){
 for(const supported_context_contracts of [[],['0'.repeat(64)]])assert.equal(planDecision(request,previous.result.ledger,previous.result.record,{...context,supported_context_contracts}).code,'unsupported_context');
}
const wrong=clone(ready);wrong.body.prepared.manifest_digest='f'.repeat(64);assert.equal(planDecision(wrong,accepted.result.ledger,accepted.result.record,pinned.context).valid,false);
assert.deepEqual(ctx.supported_context_contracts,[contractSha]);
console.log(JSON.stringify({contractSha,configuredSyntheticOnly:true,normalSupportEnabled:false,emptyAndUnknownRefuse:['seal','ready','commit'],realNativeAttestation:false}));
