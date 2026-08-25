export interface ComposerSubmitKeyModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export const isPrimaryComposerSubmitKey = (
  event: ComposerSubmitKeyModifiers,
): boolean => !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
