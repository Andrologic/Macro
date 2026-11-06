/** Browser port of AgSDL v0.3.0 graph.py, Apache-2.0. See LICENSE. */
export type Address = string;
export type PointerParts = (string | number)[];
export type Declaration = Record<string, unknown>;
export type RouteKind = 'normal' | 'error';
export type TargetKind = 'step' | 'output';
export type RouteItem = [TargetKind, string, unknown, PointerParts, Declaration | null];
export type RouteTarget = [TargetKind, string, unknown, PointerParts];
export type StepRoute = [RouteKind, string | null, unknown, PointerParts];
export type ResolvedTarget = [Address, unknown, PointerParts, Declaration | null];
export type InBranch = Map<string | null, Set<string>>;
export type Adjacency = Map<Address, Edge[]>;
export interface JoinInfo {
  origin: Address;
  branches: Map<Address, Set<Address>>;
  names: Map<Address, string>;
  fanout: Set<Address>;
}
export type JoinProblem = ['JOIN', PointerParts, Address, string];
export type ForkProblem = [PointerParts, Address, string];
export class Scope {
  constructor(steps: Record<string, Declaration>, pointer: PointerParts, prefix: Address, composition?: string | null, bindings?: Record<string, string | null> | null, compose?: Address | null, parent?: Scope | null);
  steps: Record<string, Declaration>;
  pointer: PointerParts;
  prefix: Address;
  composition: string | null;
  bindings: Record<string, string | null>;
  compose: Address | null;
  parent: Scope | null;
}
export class Node {
  constructor(addr: Address, decl: Declaration | null, scope: Scope, name: string);
  addr: Address;
  decl: Declaration | null;
  scope: Scope;
  name: string;
  type: string;
  pointer: PointerParts;
  agent: string | null;
}
export class Edge {
  constructor(src: Address, dst: Address, kind: RouteKind, key: string | null, message: unknown, pointer: PointerParts, fanout?: Declaration | null);
  src: Address;
  dst: Address;
  kind: RouteKind;
  key: string | null;
  message: unknown;
  pointer: PointerParts;
  fanout: Declaration | null;
  each: unknown;
}
export class Graph {
  constructor(document: Declaration, in_branch?: InBranch | null, covered?: Set<string> | null);
  document: Declaration;
  in_branch: InBranch;
  covered: Set<string>;
  compositions: Record<string, Declaration>;
  nodes: Map<Address, Node>;
  composes: Map<Address, [Declaration, Scope | null, Scope]>;
  edges: Edge[];
  root: Address | null;
  static for_flow(document: Declaration, in_branch?: InBranch | null, covered?: Set<string> | null): Graph;
  static flow_error_covered(document: Declaration, branch_members?: Iterable<string>): Set<string>;
  static for_scope(document: Declaration, composition?: string | null, covered?: Set<string> | null): Graph;
  static for_composition(document: Declaration, name: string, in_branch?: InBranch | null): Graph;
  _local_target(scope: Scope, kind: TargetKind, name: string): Address | null;
  _add_scope(scope: Scope, stack: string[]): void;
  resolve(scope: Scope, name: string): Address | null;
  _targets(scope: Scope, kind: TargetKind, name: string, message: unknown, pointer: PointerParts, fanout: Declaration | null): ResolvedTarget[];
  _inherited_error(scope: Scope, name: string): [Scope, unknown, PointerParts] | null;
  _connect(): void;
  successors(): Adjacency;
  predecessors(): Adjacency;
  reachable(start: Address, blocked?: Iterable<Address>): Set<Address>;
  reaching(target: Address, blocked?: Iterable<Address>): Set<Address>;
  dominators(): Map<Address, Set<Address>>;
  immediate_dominators(): Map<Address, Address>;
}
export function addressParts(addr: Address): string[];
export function compare_addresses(left: Address, right: Address): number;
export function route_items(route: unknown, pointer: PointerParts): Generator<RouteItem>;
export function route_targets(route: unknown, pointer: PointerParts): Generator<RouteTarget>;
export function step_routes(decl: Declaration, pointer: PointerParts): Generator<StepRoute>;
export function local_name(addr: Address, prefix: Address): string;
export function route_groups(graph: Graph, addr: Address, succ: Adjacency): Map<string, Address[]>;
export function open_body_forks(graph: Graph, infos: Map<Address, JoinInfo>): ForkProblem[];
export function join_origin(graph: Graph, join: Address, idom: Map<Address, Address>, succ: Adjacency): Address;
export function analyse_joins(graph: Graph): [Map<Address, JoinInfo>, JoinProblem[]];
