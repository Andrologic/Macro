import { NumberToken, decode, equal, fail, type ExactValue } from './exact';
import type { ExactJsonText } from './contracts';

export type DispatchValue = null | boolean | string | number | DispatchValue[] | { [key: string]: DispatchValue };
/** Optional boundary for the existing ordinary Macro dispatch DTOs.
 * Core compilation/storage never call this. A conversion must round-trip exactly,
 * or the trusted adapter rejects the effect before dispatch instead of rounding it.
 */
export function toDispatchValue(json: ExactJsonText): DispatchValue {
  const convert = (value: ExactValue): DispatchValue => {
    if (value instanceof NumberToken) {
      const ordinary = Number(value.raw);
      if (!Number.isFinite(ordinary) || !equal(value, ordinary)) return fail('UNSUPPORTED', '', 'Macro dispatch cannot represent this exact JSON number.');
      return ordinary;
    }
    if (Array.isArray(value)) return value.map(convert);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, convert(child)]));
    return value;
  };
  return convert(decode(json));
}
