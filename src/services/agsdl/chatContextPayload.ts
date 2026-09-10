/** Only AgSDL selection payloads are model context; other hidden fields can be presentation metadata. */
export function agsdlContextForModel(hiddenContext: string | undefined): string | undefined {
  return hiddenContext?.startsWith("<agsdl_selection>\n") ? hiddenContext : undefined;
}
