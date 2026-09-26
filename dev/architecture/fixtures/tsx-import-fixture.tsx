import type { Model } from './type-model';
import { renderModel, type RenderOptions } from './runtime-renderer';
import './side-effect';

export function render(model: Model, options: RenderOptions) {
  return <section>{renderModel(model, options)}</section>;
}
