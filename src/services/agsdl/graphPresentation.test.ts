import { describe, expect, it } from 'bun:test';
import { graphGroups, graphNeighborhood, presentGraph } from './graphPresentation';
import { layoutViewer, type ViewerEdge } from './graphLayout';
import type { ViewerCard } from './viewer';
const card = (path: string, group?: string): ViewerCard => ({ path, id: path, title: path, kind: 'invoke', mission: '', unresolved: false, inputs: [], outputs: [], branches: [], details: group ? { annotations: { macroGroup: group } } : {} });
const edge = (source: string, target: string, extra: Partial<ViewerEdge> = {}): ViewerEdge => ({ id: `${source}-${target}`, source, target, label: 'success', dependency: false, ...extra });

describe('graph reading projection', () => {
  it('never guesses groups and keeps explicit titles and members', () => {
    const cards = [card('a'), card('b', 'Quality'), card('c', 'Quality')];
    expect(graphGroups(cards)).toEqual([{ id: 'macro-group:Quality', title: 'Quality', members: cards.slice(1) }]);
  });
  it('folds only display nodes and preserves all real incoming/outgoing relations', () => {
    const cards = [card('a'), card('b', 'Quality'), card('c', 'Quality'), card('d')];
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'c'), edge('c', 'd')];
    const before = JSON.stringify({ cards, edges });
    const folded = presentGraph(cards, edges, new Set(['macro-group:Quality']), 'overview');
    expect(folded.cards.map(card => card.path)).toEqual(['a', 'd', 'macro-group:Quality']);
    expect(folded.edges).toHaveLength(2);
    expect(folded.edges[0].originals.map(edge => edge.id)).toEqual(['a-b', 'a-c']);
    expect(folded.edges[1].originals[0].id).toBe('c-d');
    expect(presentGraph(cards, edges, new Set(), 'overview').edges.map(edge => edge.id)).toEqual(edges.map(edge => edge.id));
    expect(JSON.stringify({ cards, edges })).toBe(before);
  });
  it('exchanges show only actual declared transfers, never infer them from routing', () => {
    const cards = [card('a'), card('b'), card('c')];
    const edges = [edge('a', 'b'), edge('c', 'a', { exchangeOnly: true }), edge('b', 'c', { transfers: ['report'] }), edge('a', 'c', { exchangeOnly: true, transfers: ['context'] })];
    expect(presentGraph(cards, edges, new Set(), 'overview').edges.map(edge => edge.id)).toEqual(['a-b', 'b-c']);
    expect(presentGraph(cards, edges, new Set(), 'exchanges').edges.map(edge => edge.id)).toEqual(['b-c', 'a-c']);
  });
  it('handles cyclic folded relations without overlap or fabricated bypasses', () => {
    const cards = [card('a', 'Quality'), card('b', 'Quality'), card('c')];
    const projected = presentGraph(cards, [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')], new Set(['macro-group:Quality']), 'overview');
    const layout = layoutViewer(projected.cards, projected.edges);
    expect(new Set(layout.nodes.map(node => JSON.stringify(node.position))).size).toBe(2);
    expect(projected.edges.map(edge => edge.originals[0].id)).toEqual(['b-c', 'c-a']);
  });
  it('highlights only neighbors of the focused card or exact edge endpoints', () => {
    const edges = [edge('a', 'b'), edge('b', 'c')];
    expect([...graphNeighborhood('a', edges).nodes]).toEqual(['a', 'b']);
    expect([...graphNeighborhood('b-c', edges).edges]).toEqual(['b-c']);
  });
});
