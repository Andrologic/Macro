import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sourceFingerprint, stageVerifiedBinary, validateNativeArgs, validateContentBaseline } from './native-sqlite';

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
    'serde_all_messages','serde_catalog_metadata','update_stream_commit','import100_commit','delete100_commit','provenance_cas'];
  return {schema:3,mode:'content-baseline',pilot:true,reference_eligible:false,warmup:1,samples:3,fixture_sha256:'a'.repeat(64),
    contract_checks:{all_14_fields:true},admission_controls:{all_counted_large_fields_refused:true,sql_rejection_before_fetch:true,fetch_probe_negative_control:true,legacy_receipt_not_projected:true,cas_conflict_refused:true},
    cases:[100,1000,10000].map(size => ({initial_messages:size,final_messages:size,bounded_admitted:size<10000,
      runtime:{migrations:[1,3,4,5,6,7,8,9,10,11,12],journal_mode:'wal',synchronous:1,foreign_keys:1},
      checks:{exact_14_fields:true,missing:true,writes_and_resets:true,metadata_fts:true,reopen:true,integrity:true,cleanup:true},
      cells:Object.fromEntries([...names,...(size<10000?['serde_bounded_messages']:[])].map(name => [name,{
        raw_ms:[1,2,3],summary:{unit:'ms',count:3,p50:2,p95:3,max:3},outcomes:Array.from({length:3},()=>({
          rows:name==='count_exportable'?size:1,outcome:name==='list_messages_bounded'&&size===10000?'resource_limit':'ok',
          conversations:1,bytes:42,start_rows:size+(name==='delete100_commit'?100:0),end_rows:size+(name==='import100_commit'?100:0),applied:true,
        })),
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
