export interface ComposerSubmitKeyModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
    which?: number;
  };
}

export const isComposerCompositionEvent = (
  event: ComposerSubmitKeyModifiers | null,
  compositionActive = false,
): boolean => {
  return Boolean(
    compositionActive ||
    event?.isComposing ||
    event?.nativeEvent?.isComposing ||
    event?.keyCode === 229 ||
    event?.which === 229 ||
    event?.nativeEvent?.keyCode === 229 ||
    event?.nativeEvent?.which === 229,
  );
};

export const isPrimaryComposerSubmitKey = (
  event: ComposerSubmitKeyModifiers | null,
  compositionActive = false,
): boolean => {
  if (isComposerCompositionEvent(event, compositionActive)) return false;
  if (!event) return false;
  return !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
};
