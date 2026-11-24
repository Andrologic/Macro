/**
 * Browser port of AgSDL v0.3.0 tooling/agsdl/permissions.py.
 * Upstream commit bd9f8a5b16923476fd20ac2650bd1729ee151917, Apache-2.0.
 * Modified for Macro: JavaScript collections and regular expressions; no I/O.
 * See ./LICENSE and ../NOTICE.md.
 */
export const ACTIONS = Object.freeze(['read', 'write', 'shell', 'network', 'mcp', 'delegate']);
export const ORDER = Object.freeze({ allow: 0, ask: 1, deny: 2 });
export const PRESETS = Object.freeze({
  'read-only': Object.freeze({ read: 'allow', write: 'deny', shell: 'deny', network: 'deny', mcp: 'deny', delegate: 'deny' }),
  workspace: Object.freeze({ read: 'allow', write: 'allow', shell: 'allow', network: 'deny', mcp: 'allow', delegate: 'allow' }),
  full: Object.freeze(Object.fromEntries(ACTIONS.map(action => [action, 'allow']))),
});
const own = (value, key) => Object.hasOwn(value, key);

export function normalize(permissions) {
  if (permissions == null) return [null, []];
  if (typeof permissions === 'string') return [permissions, []];
  return [permissions.preset ?? null, permissions.rules ?? []];
}

export function outside(permissions) {
  const [preset] = normalize(permissions);
  if (permissions && typeof permissions === 'object' && own(permissions, 'outside')) return permissions.outside;
  return preset === 'full' ? 'read' : 'deny';
}

export function covers_all(rule) {
  if (!own(rule, 'match')) return true;
  if (rule.action === 'read' || rule.action === 'write') return rule.match === '/**';
  return rule.match.length > 0 && [...rule.match].every(char => char === '*');
}

export function shell_denied(permissions) {
  const [preset, rules] = normalize(permissions);
  const shell = rules.filter(rule => rule.action === 'shell');
  if (shell.some(rule => rule.effect === 'deny' && covers_all(rule))) return true;
  if (shell.some(rule => rule.effect !== 'deny')) return false;
  return (preset === null ? 'deny' : PRESETS[preset].shell) === 'deny';
}

export function glob_matches(pattern, text, paths = false, command = false) {
  if (command && pattern.endsWith(' *') && text === pattern.slice(0, -2)) return true;
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    if (paths && pattern.startsWith('**', i)) {
      out += '[\\s\\S]*';
      i++;
    } else if (pattern[i] === '*') {
      out += paths ? '[^/]*' : '[\\s\\S]*';
    } else {
      out += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  // Python re.fullmatch includes newlines in wildcards and consumes all input.
  return new RegExp(`^(?:${out})(?![\\s\\S])`, 'u').test(text);
}

export function effect_for(permissions, action, subject) {
  const [preset, rules] = normalize(permissions);
  const matching = rules.filter(rule => rule.action === action &&
    (!own(rule, 'match') || glob_matches(rule.match, subject, action === 'read' || action === 'write', action === 'shell')));
  if (matching.length) return matching.reduce((effect, rule) => ORDER[rule.effect] > ORDER[effect] ? rule.effect : effect, 'allow');
  return preset === null ? 'deny' : PRESETS[preset][action];
}

export function command_prefix(pattern) {
  const words = pattern.endsWith(' *') ? pattern.slice(0, -2) : pattern;
  // Python str.strip's whitespace set differs from JavaScript trim (notably BOM).
  const whitespace = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;
  return words.length > 0 && !words.includes('*') && !whitespace.test(words);
}

export function effects_in_use(permissions) {
  const [preset, rules] = normalize(permissions);
  return Object.fromEntries(ACTIONS.map(action => {
    const effects = new Set(rules.filter(rule => rule.action === action).map(rule => rule.effect));
    if (!rules.some(rule => rule.action === action && covers_all(rule))) {
      effects.add(preset === null ? 'deny' : PRESETS[preset][action]);
      if (preset === 'workspace' && action === 'write') effects.add('deny');
    }
    return [action, effects];
  }));
}
