/** externalApps IPC DTOs. Kept separate for generated Rust binding integration. */

export type ExternalOpenAction = "editor" | "terminal" | "files";

export type ExternalAppKind = "none" | "builtin" | "detected";

export interface ExternalAppOptionDto {
  id: string;
  label: string;
  action: ExternalOpenAction;
  kind: ExternalAppKind;
}

export interface ExternalAppCatalogDto {
  editor: ExternalAppOptionDto[];
  terminal: ExternalAppOptionDto[];
  files: ExternalAppOptionDto[];
}
