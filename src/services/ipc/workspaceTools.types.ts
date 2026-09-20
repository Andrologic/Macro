/** workspaceTools IPC DTOs. Kept separate for generated Rust binding integration. */

export interface ToolValidationResultDto {
  allowed: boolean;
  reason?: string | null;
  enforce_macro_only_writes: boolean;
}

export interface ToolModePolicyDto {
  allowed_tool_ids: string[];
  enforce_macro_only_writes: boolean;
  capabilities?: string[];
}

export type WorkspaceScope = "default" | "metadata" | "direct";
