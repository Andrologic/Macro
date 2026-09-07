/** Macro editor metadata. The AgSDL document itself remains unmodified source text. */
export interface AgsdlEditorDocument {
  revision: number;
  source: string;
  annexes: Record<string, string>;
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
