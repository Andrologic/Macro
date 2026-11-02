/** An AgSDL failure the user can act on. The message stays the text agents read;
 * the key is what the interface shows. */
export class AgsdlUserError extends Error {
  constructor(readonly messageKey: string, message: string) {
    super(message);
    this.name = "AgsdlUserError";
  }
}
