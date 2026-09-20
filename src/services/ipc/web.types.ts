import type { OmitFields } from './compatibility.types';
import type {
WebFetchResourceDto as NativeNativeWebFetchResource,
WebSearchResultDto as NativeNativeWebSearchResult,
WebSearchSecretStatus as NativeWebSearchSecretStatus
} from '../../types/generated/ipc';

/** web IPC contracts and explicit frontend adaptations of generated native bindings. */

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type WebSearchSecretStatus = OmitFields<NativeWebSearchSecretStatus, "provider"> & {
  provider: 'tavily' | 'brave';
};

export type NativeWebSearchResult = NativeNativeWebSearchResult;

export type NativeWebFetchResource = NativeNativeWebFetchResource;
