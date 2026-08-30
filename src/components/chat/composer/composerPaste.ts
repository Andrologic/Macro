export interface ComposerPasteEvent {
  clipboardData: Pick<DataTransfer, 'items' | 'files'>;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export const consumeComposerImagePaste = (
  event: ComposerPasteEvent,
): File[] => {
  const itemFiles = Array.from(event.clipboardData.items || [])
    .filter((item) => item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  const transferredFiles = Array.from(event.clipboardData.files || [])
    .filter((file) => file.type.startsWith('image/'));
  const files = itemFiles.length > 0 ? itemFiles : transferredFiles;

  if (files.length === 0) return [];

  event.preventDefault();
  event.stopPropagation();
  return files;
};
