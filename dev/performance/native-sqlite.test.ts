import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sourceFingerprint, stageVerifiedBinary, validateNativeArgs, validateContentBaseline, validateCurrentContentBaseline, nativeContentFixture } from './native-sqlite';

test('native fingerprint detects untracked and tracked source changes, excludes Cargo outputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'macro-native-provenance-'));
  try {
    execFileSync('git', ['init', '--template='], { cwd: root, stdio: 'ignore' });
    mkdirSync(join(root, 'src-tauri/target'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'src-tauri/target/\n');
    writeFileSync(join(root, 'src-tauri/source.rs'), 'first');
    const first = sourceFingerprint(root);
    writeFileSync(join(root, 'src-tauri/source.rs'), 'second');
    expect(sourceFingerprint(root)).not.toBe(first);
    execFileSync('git', ['add', '.'], { cwd: root });
    const staged = sourceFingerprint(root);
    writeFileSync(join(root, 'src-tauri/target/output'), 'build');
    expect(sourceFingerprint(root)).toBe(staged);
    writeFileSync(join(root, 'src-tauri/new.rs'), 'new untracked source');
    expect(sourceFingerprint(root)).not.toBe(staged);
    rmSync(join(root, 'src-tauri/new.rs'));
    expect(sourceFingerprint(root)).toBe(staged);
    writeFileSync(join(root, 'src-tauri/source.rs'), 'changed tracked source');
    expect(sourceFingerprint(root)).not.toBe(staged);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('rejects a cache replacement between build and copy, accepts only this invocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'macro-native-stage-test-'));
  try {
    const source = join(root, 'shared-binary');
    const staged = join(root, 'private-binary');
    const expected = { sourceSha256: 'source-A', buildNonce: 'build-A' };
    const readIdentity = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(source, JSON.stringify(expected));
    // A's build finished. B replaces the shared executable before A's copy.
    writeFileSync(source, JSON.stringify({ sourceSha256: 'source-B', buildNonce: 'build-B' }));
    expect(() => stageVerifiedBinary(source, staged, expected, readIdentity)).toThrow('identity mismatch');
    // Even another build of identical sources must not be attributed to A.
    writeFileSync(source, JSON.stringify({ ...expected, buildNonce: 'build-B' }));
    expect(() => stageVerifiedBinary(source, staged, expected, readIdentity)).toThrow('identity mismatch');
    writeFileSync(source, JSON.stringify(expected));
    stageVerifiedBinary(source, staged, expected, readIdentity);
    writeFileSync(source, JSON.stringify({ sourceSha256: 'later', buildNonce: 'later' }));
    expect(readIdentity(staged)).toEqual(expected);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native content pilot is explicit and cannot silently shorten the campaign', () => {
  for (const args of [[], ['--self-test'], ['--diagnostics'], ['--content-baseline'], ['--content-baseline', '--pilot']]) {
    expect(() => validateNativeArgs(args)).not.toThrow();
  }
  for (const args of [['--pilot'], ['--content-baseline', '--samples=3'], ['--diagnostics', '--pilot'], ['--content-baseline', '--content-baseline']]) {
    expect(() => validateNativeArgs(args)).toThrow('Usage');
  }
});

function contentPilot() {
  const names = ['get_message','list_messages_bounded','count_exportable','catalog_metadata','serde_get_message',
    'serde_all_messages','serde_catalog_metadata','update_stream_commit','import100_commit','delete100_commit','provenance_cas','provenance_get'];
  const flags = Object.fromEntries(['empty_and_missing','timestamp_id_ties','all_14_fields','unicode_preview_future_latest',
    'duplicate_and_foreign_key_errors','metadata_failure_rolls_back_message_and_fts','wal_reader_and_writer_wait',
    'commit_file_reopen_exact_content_metadata_fts'].map(key=>[key,true]));
  return {schema:3,mode:'content-baseline',pilot:true,reference_eligible:false,warmup:1,samples:3,fixture_sha256:'a'.repeat(64),
    contract_checks:{...flags,rows_after_reopen:4},admission_controls:{seven_payload_fields_refused:true,sql_rejection_before_fetch:true,fetch_probe_negative_control:true,legacy_receipt_not_projected:true,cas_conflict_refused:true},
    cases:[100,1000,10000].map(size => ({initial_messages:size,final_messages:size,bounded_admitted:size<10000,
      runtime:{migrations:[1,3,4,5,6,7,8,9,10,11,12],journal_mode:'wal',synchronous:1,foreign_keys:1},
      checks:{exact_14_fields:true,missing:true,writes_and_resets:true,metadata_fts:true,reopen:true,integrity:true,cleanup:true},
      cells:Object.fromEntries([...names,...(size<10000?['serde_bounded_messages']:[])].map(name => [name,{
        raw_ms:[1,2,3],summary:{unit:'ms',count:3,p50:2,p95:3,max:3},outcomes:Array.from({length:3},()=>{
          const outcome:Record<string,unknown>={};
          if (['get_message','provenance_get'].includes(name)) Object.assign(outcome,{rows:1,outcome:'ok'});
          if (name==='count_exportable') outcome.rows=size;
          if (name==='catalog_metadata') outcome.conversations=1;
          if (name.startsWith('serde_')) outcome.bytes=42;
          if (name==='list_messages_bounded') Object.assign(outcome,size<10000?{rows:size,outcome:'ok'}:{rows_returned:0,outcome:'resource_limit'});
          if (['update_stream_commit','import100_commit','delete100_commit','provenance_cas'].includes(name))
            Object.assign(outcome,{start_rows:size+(name==='delete100_commit'?100:0),end_rows:size+(name==='import100_commit'?100:0)});
          if (name==='import100_commit') outcome.inserted=100;
          if (name==='delete100_commit') outcome.deleted=100;
          if (name==='provenance_cas') outcome.applied=true;
          return outcome;
        }),
      }]))})),
  };
}
test('rejects incomplete, relabelled, miscounted and incorrect native content evidence', () => {
  expect(() => validateContentBaseline(contentPilot(), true)).not.toThrow();
  expect(() => validateContentBaseline(contentPilot(), false)).toThrow();
  const truncated = contentPilot(); truncated.cases.pop();
  expect(() => validateContentBaseline(truncated,true)).toThrow('cases');
  const dropped = contentPilot(); delete dropped.cases[0].cells.get_message;
  expect(() => validateContentBaseline(dropped,true)).toThrow('cells');
  const short = contentPilot(); short.cases[0].cells.get_message.raw_ms.pop();
  expect(() => validateContentBaseline(short,true)).toThrow('samples');
  const falseSummary = contentPilot(); falseSummary.cases[0].cells.get_message.summary.p95=1;
  expect(() => validateContentBaseline(falseSummary,true)).toThrow('summary');
  const falseCount = contentPilot(); falseCount.cases[0].cells.count_exportable.outcomes[0].rows=0;
  expect(() => validateContentBaseline(falseCount,true)).toThrow('count');
  const missingCheck = contentPilot(); missingCheck.cases[0].checks.cleanup=false;
  expect(() => validateContentBaseline(missingCheck,true)).toThrow('checks');
});

test('rejects audit adversaries starting with a valid content report', () => {
  const valid=contentPilot();
  expect(()=>validateContentBaseline(valid,true)).not.toThrow();
  const mutations:Array<(value:ReturnType<typeof contentPilot>)=>void>=[
    v=>{v.cases[0].cells.list_messages_bounded.outcomes[0].rows=0;},
    v=>{v.cases[0].cells.list_messages_bounded.outcomes[0].rows=1;},
    v=>{v.cases[2].cells.list_messages_bounded.outcomes[0].rows_returned=10000;},
    v=>{v.cases[2].cells.list_messages_bounded.outcomes[0].rows=0;},
    v=>{v.cases[0].cells.import100_commit.outcomes[0].inserted=0;},
    v=>{v.cases[0].cells.delete100_commit.outcomes[0].deleted=0;},
    v=>{for(const key of Object.keys(v.contract_checks)) if(key!=='all_14_fields'&&key!=='rows_after_reopen') Reflect.deleteProperty(v.contract_checks,key);},
    v=>{v.cases[0].cells.provenance_get.outcomes[0].rows=0;},
  ];
  for (const pilot of [true,false]) {
    const report=structuredClone(valid);
    if (!pilot) {
      report.pilot=false;report.reference_eligible=true;report.warmup=10;report.samples=100;
      for(const entry of report.cases) for(const cell of Object.values(entry.cells)) {
        const outcomes=cell.outcomes;
        cell.raw_ms=Array.from({length:100},(_,i)=>i%3+1);
        cell.outcomes=Array.from({length:100},(_,i)=>structuredClone(outcomes[i%3]));
        cell.summary={unit:'ms',count:100,p50:2,p95:3,max:3};
      }
    }
    expect(()=>validateContentBaseline(report,pilot)).not.toThrow();
    for (const mutate of mutations) {
      const altered=structuredClone(report);mutate(altered);
      expect(()=>validateContentBaseline(altered,pilot)).toThrow();
    }
    for (const key of Object.keys(report.contract_checks)) {
      const altered=structuredClone(report);
      Reflect.deleteProperty(altered.contract_checks,key);
      expect(()=>validateContentBaseline(altered,pilot)).toThrow('contract');
    }
  }
});

function nativePilot() {
  const legacy = contentPilot();
  const report = {...legacy, schema:4, fixture:nativeContentFixture, percentile:'nearest-rank',
    raw_observation_order:'execution order, warmup excluded'};
  report.fixture_sha256 = createHash('sha256').update(nativeContentFixture)
    .update(readFileSync(new URL('../../src-tauri/examples/performance-sqlite/content_baseline.rs', import.meta.url))).digest('hex');
  Object.assign(report.admission_controls, {native_large_receipt_refused:true,native_prefix_exact:true,
    native_missing_suffix_refused:true,native_stale_token_refused:true});
  for (const entry of report.cases) {
    entry.runtime.migrations.push(13);
    Object.assign(entry.checks,{native_fields_positions_tokens:true,native_mutations_before_reset:true,
      native_admission_bytes:true,native_reopen:true});
    const size = entry.initial_messages;
    for (const name of ['native_version','native_metadata_open100','native_metadata_after50','native_window50']) {
      const outcome:Record<string,unknown> = {outcome:'ok'};
      if (name === 'native_version') outcome.token = {version:1,incarnation:'a'.repeat(32),revision:'123'};
      else {
        Object.assign(outcome,{serialized_bytes:42,admission_estimate_bytes:4096});
        if (name === 'native_window50') Object.assign(outcome,{rows:50,consumed_count:50,start_position:size-50});
        else {
          const offset = name === 'native_metadata_open100' ? 0 : 50;
          Object.assign(outcome,{offset,rows:Math.min(100,size-offset),opening:offset===0,has_more:size>offset+100});
        }
      }
      entry.cells[name] = {raw_ms:[1,2,3],summary:{unit:'ms',count:3,p50:2,p95:3,max:3},
        outcomes:Array.from({length:3},()=>structuredClone(outcome))};
    }
  }
  return report;
}

test('keeps historical evidence valid and rejects mixed native protocol identities', () => {
  expect(()=>validateContentBaseline(contentPilot(),true)).not.toThrow();
  expect(()=>validateCurrentContentBaseline(contentPilot(),true)).toThrow('protocol 4');
  const valid = nativePilot();
  expect(()=>validateContentBaseline(valid,true)).not.toThrow();
  expect(()=>validateCurrentContentBaseline(valid,true)).not.toThrow();
  const altered = nativePilot(); altered.fixture_sha256 = 'b'.repeat(64);
  expect(()=>validateCurrentContentBaseline(altered,true)).toThrow('hash');
  const oldRuntime = nativePilot(); oldRuntime.cases[0].runtime.migrations.pop();
  expect(()=>validateContentBaseline(oldRuntime,true)).toThrow('runtime');
  const oldProtocol = nativePilot(); oldProtocol.schema=3;
  expect(()=>validateContentBaseline(oldProtocol,true)).toThrow('runtime');
  const oldFixture = nativePilot(); oldFixture.fixture = 'content-v2:synthetic;schema12';
  expect(()=>validateContentBaseline(oldFixture,true)).toThrow('fixture');
  const newRuntime = contentPilot(); newRuntime.cases[0].runtime.migrations.push(13);
  expect(()=>validateContentBaseline(newRuntime,true)).toThrow('runtime');
});

test('rejects missing native controls, truncated pages, unsafe tokens and byte/count mismatches', () => {
  const mutations:Array<(value:ReturnType<typeof nativePilot>)=>void> = [
    v=>{delete v.cases[0].cells.native_version;},
    v=>{Reflect.deleteProperty(v.admission_controls,'native_prefix_exact');},
    v=>{Reflect.deleteProperty(v.cases[0].checks,'native_mutations_before_reset');},
    v=>{v.cases[0].cells.native_metadata_after50.outcomes[0].rows=100;},
    v=>{v.cases[0].cells.native_metadata_after50.outcomes[0].opening=true;},
    v=>{v.cases[2].cells.native_metadata_open100.outcomes[0].has_more=false;},
    v=>{v.cases[0].cells.native_window50.outcomes[0].consumed_count=49;},
    v=>{v.cases[0].cells.native_window50.outcomes[0].start_position=0;},
    v=>{v.cases[0].cells.native_window50.outcomes[0].serialized_bytes=4097;},
    v=>{v.cases[0].cells.native_window50.outcomes[0].admission_estimate_bytes=4_194_305;},
    v=>{v.cases[0].cells.native_version.outcomes[0].token={version:1,incarnation:'a'.repeat(32),revision:'01'};},
    v=>{v.cases[0].cells.native_version.outcomes[0].token={version:1,incarnation:'a'.repeat(32),revision:'9223372036854775808'};},
  ];
  for (const mutate of mutations) {
    const report=nativePilot(); mutate(report);
    expect(()=>validateContentBaseline(report,true)).toThrow();
  }
});
