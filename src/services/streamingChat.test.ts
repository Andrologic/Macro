import { describe, expect, it } from 'bun:test';
import {
  CREATE_PLAN_TOOL,
  GENERATE_PLAN_TOOL,
  UPDATE_PLAN_TOOL,
} from './streamingChat';

describe('streamingChat Architect tool contracts', () => {
  it('does not require title for plan_create and exposes label support', () => {
    const properties = CREATE_PLAN_TOOL.function.parameters.properties as Record<string, unknown>;
    const required = CREATE_PLAN_TOOL.function.parameters.required as string[];

    expect(required).not.toContain('title');
    expect(properties.label).toBeDefined();
    expect(String(CREATE_PLAN_TOOL.function.description)).toContain('generated identifier');
  });

  it('documents plan_title as a label alias for strategy generation', () => {
    const planTitleProperty = (
      GENERATE_PLAN_TOOL.function.parameters.properties as Record<string, { description?: string }>
    ).plan_title;

    expect(String(GENERATE_PLAN_TOOL.function.description)).toContain('plan/<plan-id>');
    expect(String(planTitleProperty.description)).toContain('secondary plan label');
  });

  it('documents plan_update title as a legacy alias without changing canonical ids', () => {
    const properties = UPDATE_PLAN_TOOL.function.parameters.properties as Record<
      string,
      { description?: string }
    >;

    expect(properties.label).toBeDefined();
    expect(String(properties.title.description).toLowerCase()).toContain('legacy alias');
    expect(String(UPDATE_PLAN_TOOL.function.description)).toContain('never rename the canonical id or slug');
  });
});
