/**
 * Wait, bounded, until a fixture file at `path` holds complete content, and
 * return what `complete` makes of it.
 *
 * A fixture's writeFileSync or Bun.write creates the file before it writes the
 * bytes, so a wait for existence alone can return while the file is still ""
 * (HACK-1422, HACK-1439). Use this for any handshake whose content is read
 * afterwards. A file that is renamed into place is already complete, so it does
 * not need this helper; neither does a barrier whose content is never read.
 *
 * `complete` returns undefined for content that is not complete yet. Take the
 * value before signaling the writer: a writer killed between creating the file
 * and writing it leaves the file empty for good.
 */
export async function waitForFileContent<T>(opts: {
  readonly path: string;
  readonly complete: (text: string) => T | undefined;
  readonly what: string;
  readonly budgetMs: number;
}): Promise<T> {
  const deadline = performance.now() + opts.budgetMs;
  for (;;) {
    const file = Bun.file(opts.path);
    if (await file.exists()) {
      const value = opts.complete(await file.text());
      if (value !== undefined) {
        return value;
      }
    }
    if (performance.now() >= deadline) {
      throw new Error(
        `Fixture ${opts.what} did not complete within ${opts.budgetMs} ms.`
      );
    }
    await Bun.sleep(10);
  }
}
