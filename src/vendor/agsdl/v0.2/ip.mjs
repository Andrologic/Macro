// Browser equivalent of the IPv6 branch of node:net.isIP used by the reader.
// This validates syntax only; it neither resolves nor connects to the address.
export function isIP(input) {
  if (typeof input !== 'string') return 0;
  const parts = input.split('%');
  if (parts.length > 2 || (parts.length === 2 && !/^[0-9A-Za-z.:-]+$/.test(parts[1]))) return 0;
  let address = parts[0];
  let ipv4Groups = 0;
  if (address.includes('.')) {
    const colon = address.lastIndexOf(':');
    if (colon < 0) return 0;
    const octets = address.slice(colon + 1).split('.');
    if (octets.length !== 4 || octets.some(x => !/^(0|[1-9][0-9]{0,2})$/.test(x) || Number(x) > 255)) return 0;
    address = address.slice(0, colon) + ':0:0';
    ipv4Groups = 2;
  }
  const halves = address.split('::');
  if (halves.length > 2) return 0;
  const groups = halves.flatMap(x => x === '' ? [] : x.split(':'));
  if (groups.some(x => !/^[0-9A-Fa-f]{1,4}$/.test(x))) return 0;
  if (halves.length === 1 ? groups.length !== 8 : groups.length >= 8) return 0;
  // An embedded IPv4 address occupies the final two groups and cannot be followed
  // by compressed groups; replacing the dotted tail above preserves that rule.
  if (ipv4Groups && input.split('%')[0].endsWith('::')) return 0;
  return 6;
}
