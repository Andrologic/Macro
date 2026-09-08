import {
  pilotReviewCapture, pilotReviewFiles, pilotReviewRead,
  pilotReviewFresh, pilotReviewRelease,
} from '../tauriIpc';

/** Local primitives; the content host owns authorization, revisions and wire cursors. */
export type ReviewCaptureSource =
  | { kind: 'commits'; base_sha: string; head_sha: string }
  | { kind: 'staged' | 'unstaged' | 'local_total' };
export interface ReviewCaptureRequest {
  source: ReviewCaptureSource;
  /** Include configured raw secrets and their configured encoded forms. Never log this input. */
  secret_values: string[];
  policy_revision: 'visible-1';
}
export interface ReviewCaptureInfo {
  snapshot_id: string;
  source: ReviewCaptureSource;
  head_sha: string | null;
  observed_at: string;
  expires_at: string;
  export_policy_revision: 'visible-1';
  availability: 'complete' | 'partial';
  file_count: number;
}
export interface ReviewCaptureFile {
  file_id: string;
  position: number;
  old_path: string | null;
  new_path: string | null;
  change: 'added' | 'modified' | 'deleted' | 'renamed' | 'type_changed' | 'unchanged';
  old_mode?: '100644' | '100755' | '120000' | '160000';
  new_mode?: '100644' | '100755' | '120000' | '160000';
  content_state: 'text' | 'binary' | 'submodule' | 'withheld' | 'too_large' | 'unsupported';
  patch_bytes: number;
}
export interface ReviewCapturePage {
  capture: ReviewCaptureInfo;
  offset: number;
  total: number;
  next_cursor: string | null;
  items: ReviewCaptureFile[];
}
export interface ReviewCaptureFragment {
  snapshot_id: string;
  file_id: string;
  offset_bytes: number;
  next_offset_bytes: number | null;
  total_bytes: number;
  patch: string;
}
export interface ReviewCaptureBackend {
  capture: typeof pilotReviewCapture;
  files: typeof pilotReviewFiles;
  read: typeof pilotReviewRead;
  fresh: typeof pilotReviewFresh;
  release: typeof pilotReviewRelease;
}
const nativeBackend: ReviewCaptureBackend = {
  capture: pilotReviewCapture, files: pilotReviewFiles, read: pilotReviewRead,
  fresh: pilotReviewFresh, release: pilotReviewRelease,
};

/** Bind each instance to a trusted host scope, then discard it on revocation. */
export function createReviewCaptureService(backend: ReviewCaptureBackend = nativeBackend) {
  const captures = new Set<string>();
  let disposed = false;
  function requireCapture(snapshotId: string) {
    if (disposed || !captures.has(snapshotId)) throw new Error('snapshot_expired');
  }
  return {
    async capture(repoPath: string, request: ReviewCaptureRequest) {
      if (disposed) throw new Error('snapshot_expired');
      const capture = await backend.capture(repoPath, request);
      if (disposed) {
        await backend.release(capture.snapshot_id);
        throw new Error('snapshot_expired');
      }
      captures.add(capture.snapshot_id);
      return capture;
    },
    async files(snapshotId: string, cursor?: string) {
      requireCapture(snapshotId);
      const result = await backend.files(snapshotId, cursor);
      requireCapture(snapshotId);
      return result;
    },
    async read(snapshotId: string, fileId: string, offsetBytes = 0) {
      requireCapture(snapshotId);
      const result = await backend.read(snapshotId, fileId, offsetBytes);
      requireCapture(snapshotId);
      return result;
    },
    async fresh(snapshotId: string, request: ReviewCaptureRequest) {
      requireCapture(snapshotId);
      const result = await backend.fresh(snapshotId, request);
      requireCapture(snapshotId);
      return result;
    },
    async release(snapshotId: string) {
      requireCapture(snapshotId);
      captures.delete(snapshotId);
      await backend.release(snapshotId);
    },
    async dispose() {
      disposed = true;
      const ids = [...captures];
      captures.clear();
      await Promise.all(ids.map((id) => backend.release(id)));
    },
  };
}
