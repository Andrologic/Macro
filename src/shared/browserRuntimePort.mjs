/** The launcher and browser must reject the same noncanonical port values. */
export function browserRuntimePort(value) {
  if (value === undefined) return 1430;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) {
    throw new Error('The browser bridge port must be a canonical decimal integer from 1 to 65535.');
  }
  return Number(value);
}
