const SPECIAL_KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: 'Space',
  ' ': 'Space',
  comma: ',',
  period: '.',
  slash: '/',
};

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift']);

const normalizeKeyToken = (token: string): string => {
  const trimmed = token.trim();
  if (!trimmed) return '';
  const alias = SPECIAL_KEY_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed;
};

export const normalizeBinding = (binding: string): string => {
  const rawParts = binding
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);

  const hasMod = rawParts.some((part) => part.toLowerCase() === 'mod');
  const hasCtrl = rawParts.some((part) => part.toLowerCase() === 'ctrl');
  const hasMeta = rawParts.some((part) => part.toLowerCase() === 'meta' || part.toLowerCase() === 'cmd');
  const hasAlt = rawParts.some((part) => part.toLowerCase() === 'alt' || part.toLowerCase() === 'option');
  const hasShift = rawParts.some((part) => part.toLowerCase() === 'shift');
  const keyPart = rawParts.find(
    (part) => !['mod', 'ctrl', 'meta', 'cmd', 'alt', 'option', 'shift'].includes(part.toLowerCase())
  );
  const normalizedKey = normalizeKeyToken(keyPart || '');

  const tokens: string[] = [];
  if (hasMod) tokens.push('Mod');
  if (hasCtrl) tokens.push('Ctrl');
  if (hasMeta) tokens.push('Meta');
  if (hasAlt) tokens.push('Alt');
  if (hasShift) tokens.push('Shift');
  if (normalizedKey) tokens.push(normalizedKey);

  return tokens.join('+');
};

export const eventToBinding = (event: KeyboardEvent): string | null => {
  if (MODIFIER_KEYS.has(event.key)) return null;

  const key = event.key === ' ' ? 'Space' : normalizeKeyToken(event.key);
  if (!key) return null;

  const isMac = navigator.platform.toLowerCase().includes('mac');
  const parts: string[] = [];

  if (isMac ? event.metaKey : event.ctrlKey) {
    parts.push('Mod');
  }
  if ((isMac && event.ctrlKey) || (!isMac && event.metaKey)) {
    parts.push(isMac ? 'Ctrl' : 'Meta');
  }
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(key);

  return normalizeBinding(parts.join('+'));
};

export const formatBindingForDisplay = (binding: string | null): string => {
  if (!binding) return 'Unassigned';
  const isMac = navigator.platform.toLowerCase().includes('mac');
  return binding
    .split('+')
    .map((token) => {
      if (token === 'Mod') return isMac ? 'Cmd' : 'Ctrl';
      if (token === 'Meta') return isMac ? 'Ctrl' : 'Win';
      if (token === 'Space') return 'Space';
      return token;
    })
    .join(' + ');
};

export const bindingMatchesEvent = (binding: string, event: KeyboardEvent): boolean => {
  const normalized = normalizeBinding(binding);
  if (!normalized) return false;

  const parts = normalized.split('+');
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));
  const eventBinding = eventToBinding(event);
  if (!eventBinding) return false;

  const eventParts = eventBinding.split('+');
  const eventKey = eventParts[eventParts.length - 1];
  const eventModifiers = new Set(eventParts.slice(0, -1));

  if (key !== eventKey) return false;
  if (modifiers.size !== eventModifiers.size) return false;
  for (const modifier of modifiers) {
    if (!eventModifiers.has(modifier)) return false;
  }
  return true;
};

export const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
};
