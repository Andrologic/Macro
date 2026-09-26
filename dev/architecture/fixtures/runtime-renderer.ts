import type { Model } from './type-model';

export type RenderOptions = { compact?: boolean };
export function renderModel(model: Model, options: RenderOptions) {
  return `${model.id}:${options.compact ? 'compact' : 'full'}`;
}
