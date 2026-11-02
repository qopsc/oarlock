/** A write refused because the file is no longer the one that was read (or, for
 *  a new file, now exists). Nothing was written. */
export class StaleFileError extends Error {
  constructor(readonly path: string) {
    super(
      `${path} changed on disk since it was read (or already exists). Read it again before writing.`,
    );
    this.name = "StaleFileError";
  }
}
