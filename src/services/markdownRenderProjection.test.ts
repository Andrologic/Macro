import { describe, expect, it } from 'bun:test';
import type { ToolTrace } from '../types';
import { buildAssistantMessagePresentation } from './chatDbMappers';
import {
  buildRenderState, projectAssistantReflections,
  REFLECTION_MAX_BLOCKS, REFLECTION_SOURCE_MAX_BYTES,
} from './markdownRenderProjection';

const render = (content: string, toolTraces?: ToolTrace[], isStreaming = false) =>
  projectAssistantReflections({ content, toolTraces, isStreaming, presentation: 'renderer' });
const persisted = (content: string, hasHiddenContext = false, toolTraces?: ToolTrace[]) =>
  projectAssistantReflections({ content, hasHiddenContext, toolTraces, presentation: 'persisted' });
const trace = (visible_offset?: number): ToolTrace => ({
  tool_call_id: 'call', tool_name: 'read_file', status: 'done', visible_offset,
});

describe('assistant renderer reflection projection', () => {
  it('exports only actual thinking blocks in render order, including interrupted history', () => {
    const content = 'Intro\n<think> première é🙂 </think>\nAnswer\n<thinking> deuxième';
    const projection = persisted(content);
    expect(projection).toEqual({ state: 'ready', blocks: [
      { renderBlockIndex: 1, order: 0, content: 'première é🙂', partial: false },
      { renderBlockIndex: 3, order: 1, content: 'deuxième', partial: true },
    ] });
    const blocks = buildRenderState(buildAssistantMessagePresentation(content).content, false);
    expect(projection.blocks.map((block) => block.content)).toEqual(
      blocks.filter((block) => block.type === 'thinking').map((block) => block.content),
    );
  });

  it('preserves permissive tags, mismatched closing names and orphan closing blocks', () => {
    expect(render(' historical </ THINKING > body < ThInK > é </thinking>< thinking > tail')).toEqual({
      state: 'ready', blocks: [
        { renderBlockIndex: 0, order: 0, content: 'historical', partial: false },
        { renderBlockIndex: 2, order: 1, content: 'é', partial: false },
        { renderBlockIndex: 3, order: 2, content: 'tail', partial: true },
      ],
    });
    expect(render('<think attr="ignored">plain')).toEqual({ state: 'absent', blocks: [] });
  });

  it('does not invent empty reflections or change renderer fence handling', () => {
    expect(render('<think> \n </think>answer<think>')).toEqual({ state: 'absent', blocks: [] });
    expect(render('```text\n<think>as displayed</think>\n```').blocks[0]?.content).toBe('as displayed');
  });

  it('uses structured tool anchors and excludes tool detail from reflections', () => {
    const first = '<think>é🙂</think>';
    const tools = [{ ...trace(first.length), detail: '<think>argument</think>', recovery_state: 'unknown' as const }];
    expect(render(first + '<thinking>next', tools)).toEqual({ state: 'ready', blocks: [
      { renderBlockIndex: 0, order: 0, content: 'é🙂', partial: false },
      { renderBlockIndex: 2, order: 1, content: 'next', partial: true },
    ] });
    expect(render(first + '<thinking>next', tools)).toEqual(render(first + '<thinking>next', [trace(first.length)]));
  });

  it('preserves the actual renderer split when a tool anchors inside a thinking block', () => {
    const first = '<think>first';
    const content = first + 'second</think>answer';
    expect(render(content, [trace(first.length)])).toEqual({ state: 'ready', blocks: [
      { renderBlockIndex: 0, order: 0, content: 'first', partial: true },
      { renderBlockIndex: 2, order: 1, content: 'second', partial: false },
    ] });
  });

  it('retains malformed active anchors before entering the renderer grouping loop', () => {
    for (const offset of [NaN, Infinity, 'bad', {}, true]) {
      const tool = { ...trace(), visible_offset: offset } as ToolTrace;
      expect(render('<think>visible</think>', [tool])).toEqual({ state: 'withheld', blocks: [] });
    }
    expect(render('<think>visible</think>', [{ ...trace(), visible_offset: null } as unknown as ToolTrace]).blocks[0]?.content).toBe('visible');
  });

  it('keeps snapshots independent of trimming changes during an append', () => {
    const original = render('<think>é🙂 ');
    const appended = render('<think>é🙂 suite');
    expect(original.blocks[0]?.content).toBe('é🙂');
    expect(appended.blocks[0]?.content).toBe('é🙂 suite');
    expect(new TextEncoder().encode(original.blocks[0]?.content).byteLength).toBe(6);
    expect(original.blocks[0]?.partial).toBe(true);
  });

  it('applies the real persisted questionnaire presentation, including malformed quick replies', () => {
    for (const choices of ['- one\n- two\n- <think>choice</think>', '- <think>choice</think>']) {
      const raw = `<think>reflection</think>\n[quick-replies]\n${choices}\n[/quick-replies]`;
      expect(persisted(raw)).toEqual(render(buildAssistantMessagePresentation(raw).content));
      expect(persisted(raw).blocks.map((block) => block.content)).toEqual(['reflection']);
      expect(persisted(raw, true)).toEqual({ state: 'withheld', blocks: [] });
    }
    const content = '  <think>visible</think>  ';
    expect(persisted(content, true)).toEqual({ state: 'withheld', blocks: [] });
    expect(persisted(content.trim(), true).blocks[0]?.content).toBe('visible');
  });

  it('retains ambiguous tool payloads and displayed questionnaire choices', () => {
    for (const content of [
      '<think>safe</think><tool_call>{"name":"read","arguments":{"query":"<think>argument</think>"}}</tool_call>',
      '<tool_call>read<arg_value><think>argument</think></arg_value></tool_call>',
      '<tool_result><think>result</think></tool_result>',
      '[TOOL] read_file (<think>argument</think>)',
      '[quick-replies]\n- <think>choice</think>\n[/quick-replies]',
    ]) expect(render(content)).toEqual({ state: 'withheld', blocks: [] });
    const escaped = '<tool_call>' + JSON.stringify({ name: 'read', arguments: { query: '<think>argument</think>' } }).replaceAll('<', '\\u003c') + '</tool_call>';
    expect(buildRenderState(escaped, false).some((block) => block.type === 'thinking')).toBe(true);
    expect(render(escaped)).toEqual({ state: 'withheld', blocks: [] });
    expect(render('<tool_call>{"name":"read","arguments":{"path":"example"}}</tool_call><think>visible</think>').blocks[0]?.content).toBe('visible');
  });

  it('checks UTF-8 source bytes and total reflection count before returning any text', () => {
    expect(render('é'.repeat(REFLECTION_SOURCE_MAX_BYTES / 2))).toEqual({ state: 'absent', blocks: [] });
    expect(render('é'.repeat(REFLECTION_SOURCE_MAX_BYTES / 2) + 'a')).toEqual({ state: 'source_too_large', blocks: [] });
    expect(render('<think>a</think>'.repeat(REFLECTION_MAX_BLOCKS)).blocks).toHaveLength(REFLECTION_MAX_BLOCKS);
    expect(render('<think>a</think>'.repeat(REFLECTION_MAX_BLOCKS + 1))).toEqual({ state: 'source_too_large', blocks: [] });
    expect(render('<think>safe</think>', Array.from({ length: REFLECTION_MAX_BLOCKS + 1 }, () => trace()))).toEqual({ state: 'source_too_large', blocks: [] });
  });
});

it('bounds dense parser allocations before building the renderer block array',() => {
  for (const content of ['<think>a</think>'.repeat(1000),'<think>visible</think>\n'+ '[TOOL] a\n'.repeat(1000),'<think>visible</think>'+ '[{},]'.repeat(2000),'\n'.repeat(5000)+'<think>visible</think>']) {
    expect(render(content)).toEqual({state:'source_too_large',blocks:[]});
  }
});

it('retains real multi-line tool labels and old web/diagnostic payloads in history and active projection',async () => {
  const {createStreamAccumulator}=await import('./ai/streamAccumulator');
  const {formatToolUsageLabel}=await import('./ai/toolPresentation');
  const acc=createStreamAccumulator({onToken:()=>{}});
  acc.beginToolTrace('call','terminal_run');
  acc.appendSystemChunk(formatToolUsageLabel('terminal_run',{command:'ordinary first line\n<think>argument only</think>'}));
  const result=acc.buildResult();
  for (const presentation of ['renderer','persisted'] as const) {
    expect(projectAssistantReflections({content:result.visibleContent,toolTraces:result.toolTraces,presentation,hasHiddenContext:false})).toEqual({state:'withheld',blocks:[]});
  }
  for (const content of ['🔍 **Recherche web:** "first\n<think>query only</think>"','🔧 **Tool:** terminal_run (first\n<think>argument only</think>)','[System: diagnostic\n<think>diagnostic only</think>','<tool_context tool="read">\n<think>tool result only</think>\n</tool_context>']) {
    expect(render(content)).toEqual({state:'withheld',blocks:[]});expect(persisted(content)).toEqual({state:'withheld',blocks:[]});
  }
  expect(render('<think>visible before tool</think>\n[TOOL] read_file (ordinary)')).toMatchObject({state:'ready',blocks:[{content:'visible before tool'}]});
});
