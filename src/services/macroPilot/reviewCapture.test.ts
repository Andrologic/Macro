import { describe, expect, it, mock } from 'bun:test';
import { createReviewCaptureService, type ReviewCaptureBackend, type ReviewCaptureInfo, type ReviewCaptureRequest } from './reviewCapture';
const request: ReviewCaptureRequest = { source: { kind: 'unstaged' }, secret_values: [], policy_revision: 'visible-1' };
const info: ReviewCaptureInfo = { revision_token: 'revision', snapshot_id: 'snapshot', source: request.source, head_sha: null, observed_at: '2026-01-01T00:00:00Z', expires_at: '2026-01-01T00:05:00Z', export_policy_revision: 'visible-1', availability: 'complete', file_count: 0 };
function backend(): ReviewCaptureBackend {
  return {
    capture: mock(async () => info),
    files: mock(async () => ({ capture: info, offset: 0, total: 0, items: [], next_cursor: null })),
    read: mock(async () => ({ snapshot_id: 'snapshot', file_id: 'file', offset_bytes: 0, next_offset_bytes: null, total_bytes: 0, patch: '' })),
    fresh: mock(async () => true), release: mock(async () => {}),
  };
}
describe('native review capture scope', () => {
  it('rejects a foreign handle and drops an in-flight page after disposal', async () => {
    const native = backend(); const service = createReviewCaptureService(native);
    await expect(service.files('foreign')).rejects.toThrow('snapshot_expired');
    expect(native.files).not.toHaveBeenCalled();
    await service.capture('repo', request);
    let resolve!: (value: Awaited<ReturnType<ReviewCaptureBackend['files']>>) => void;
    native.files = mock(() => new Promise<Awaited<ReturnType<ReviewCaptureBackend['files']>>>((done) => { resolve = done; }));
    const pending = service.files('snapshot');
    await service.dispose();
    resolve({ capture: info, offset: 0, total: 0, items: [], next_cursor: null });
    await expect(pending).rejects.toThrow('snapshot_expired');
    expect(native.release).toHaveBeenCalledWith('snapshot');
  });
  it('releases a capture that finishes after scope revocation', async () => {
    const native = backend(); let resolve!: (value: ReviewCaptureInfo) => void;
    native.capture = mock(() => new Promise<ReviewCaptureInfo>((done) => { resolve = done; }));
    const service = createReviewCaptureService(native);
    const pending = service.capture('repo', request);
    await service.dispose(); resolve(info);
    await expect(pending).rejects.toThrow('snapshot_expired');
    expect(native.release).toHaveBeenCalledWith('snapshot');
  });
});
