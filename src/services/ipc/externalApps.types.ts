import type { OmitFields } from './compatibility.types';
import type {
ExternalAppCatalogDto as NativeExternalAppCatalogDto,
ExternalAppOptionDto as NativeExternalAppOptionDto
} from '../../types/generated/ipc';

/** externalApps IPC contracts and explicit frontend adaptations of generated native bindings. */

export type ExternalOpenAction = "editor" | "terminal" | "files";

export type ExternalAppKind = "none" | "builtin" | "detected";

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type ExternalAppOptionDto = OmitFields<NativeExternalAppOptionDto, "action" | "kind"> & {
  action: ExternalOpenAction;
  kind: ExternalAppKind;
};

/** Frontend compatibility: preserves adapted fields and omission rules. */
export type ExternalAppCatalogDto = OmitFields<NativeExternalAppCatalogDto, "editor" | "terminal" | "files"> & {
  editor: ExternalAppOptionDto[];
  terminal: ExternalAppOptionDto[];
  files: ExternalAppOptionDto[];
};
