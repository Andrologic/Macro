import type { InvokeArgs } from '@tauri-apps/api/core';
import type { WebviewResourceRelease } from '../../types/generated/ipc';
import { invoke } from '../tauriRuntimeBridge';

/** The reply proves table absence, not completion of operations holding the resource. */
export async function httpReleaseWebviewResource(
  rid: number,
  runtimeInvoke: <T>(command: string, args?: InvokeArgs) => Promise<T> = invoke,
): Promise<WebviewResourceRelease> {
  const result = await runtimeInvoke<WebviewResourceRelease>('http_release_webview_resource', { rid });
  if (result !== 'removed' && result !== 'alreadyAbsent') throw new Error('Invalid resource release receipt');
  return result;
}
