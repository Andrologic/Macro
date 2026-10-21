export interface DesignMetadata {
  version: 1;
  kind: 'system' | 'blueprint';
  purpose: string;
  context: string;
  rules: Array<{ id: string; title: string; instructions: string }>;
  requirements: Array<{ id: string; label: string; description: string; value: string; targetPath?: string }>;
  origin?: { planId: string; name: string; revision: number; branchName?: string };
}
export interface AgsdlDisplayMetadata {
  title?: string;
  cards?: Record<string, { title?: string; description?: string; macroGroup?: string; macroTaskId?: string; macroLegacyNodeId?: string; macroStatus?: string }>;
}
export interface AgsdlMigrationMetadata {
  version: 1;
  from: 'macro-legacy-plan' | 'agsdl-0.1.0';
  issues: string[];
  /** Original artifact and evidence remain available for deliberate remapping. */
  original?: unknown;
}
export interface AgsdlEnvelopeMetadata {
  design?: DesignMetadata;
  display?: AgsdlDisplayMetadata;
  migration?: AgsdlMigrationMetadata;
}

/** Macro editor metadata. The AgSDL document itself remains unmodified source text. */
export interface AgsdlEditorDocument {
  revision: number;
  source: string;
  annexes: Record<string, string>;
  design?: DesignMetadata;
  display?: AgsdlDisplayMetadata;
  migration?: AgsdlMigrationMetadata;
}

export interface AgsdlChange {
  op: "set" | "remove";
  path: string;
  /** JSON text, so opaque numbers never have to round-trip through JS floats. */
  valueJson?: string;
}

export interface AgsdlFinding {
  rule: string;
  outcome: string;
  details: string;
  location: { pointer?: string; byte?: number };
  /** Source pointer of the composition use associated with this finding. */
  invocation?: string;
}

export interface AgsdlResult {
  input: string;
  unit: string;
  verdict: string;
  findings: AgsdlFinding[];
  [key: string]: unknown;
}

export interface AgsdlReport {
  operation: string;
  results: AgsdlResult[];
  [key: string]: unknown;
}

export interface AgsdlGraphNode {
  id: string;
  path: string;
  title: string;
  subtitle: string;
  kind: string;
  outputs: string[];
  position: { x: number; y: number };
  external?: boolean;
}

export interface AgsdlGraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  path: string;
  handle?: string;
}
