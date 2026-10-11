import { expect, test } from "bun:test";
import { readBoundedStream } from "../src/lib/shell.ts";

class Overflow extends Error {
  readonly code = "E_TEST_OVERFLOW";
}
function overflow(): never {
  throw new Overflow("budget");
}
function stream(
  chunks: readonly Uint8Array[],
  onCancel?: () => void
): ReadableStream<Uint8Array> {
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(next);
    },
    cancel() {
      onCancel?.();
    },
  });
}
const bytes = (text: string) => new TextEncoder().encode(text);

test("readBoundedStream concatenates chunks within the budget and releases the lock", async () => {
  const source = stream([bytes("ab"), bytes("cd"), bytes("e")]);
  const result = await readBoundedStream(source, 5, undefined, overflow);
  expect(new TextDecoder().decode(result)).toBe("abcde");
  expect(result.byteLength).toBe(5);
  expect(source.locked).toBe(false);
  expect(
    await readBoundedStream(
      stream([]),
      0,
      new AbortController().signal,
      overflow
    )
  ).toHaveLength(0);
});

test("readBoundedStream invokes the caller's refusal once the budget is exceeded", async () => {
  let cancelled = 0;
  const source = stream([bytes("abc"), bytes("def")], () => {
    cancelled += 1;
  });
  const failure = await readBoundedStream(source, 5, undefined, overflow).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(Overflow);
  expect(cancelled).toBe(1);
  expect(source.locked).toBe(false);
});

test("readBoundedStream cancels an already aborted or later aborted read", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let cancelled = 0;
  const first = stream([bytes("abc")], () => {
    cancelled += 1;
  });
  await readBoundedStream(first, 16, aborted.signal, overflow);
  expect(cancelled).toBe(1);

  const controller = new AbortController();
  let release: (() => void) | undefined;
  const pending = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    cancel() {
      cancelled += 1;
      release?.();
    },
  });
  const read = readBoundedStream(pending, 16, controller.signal, overflow);
  controller.abort();
  expect(await read).toHaveLength(0);
  expect(cancelled).toBe(2);
  expect(pending.locked).toBe(false);
});

test("readBoundedStream admits output exactly at the limit and refuses one byte past it", async () => {
  const exact = await readBoundedStream(
    stream([bytes("abc"), bytes("de")]),
    5,
    undefined,
    overflow
  );
  expect(new TextDecoder().decode(exact)).toBe("abcde");

  let cancelled = 0;
  const past = stream([bytes("abc"), bytes("def")], () => {
    cancelled += 1;
  });
  const failure = await readBoundedStream(past, 5, undefined, overflow).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(Overflow);
  expect(cancelled).toBe(1);
});

test("readBoundedStream propagates a stream error and releases the lock", async () => {
  class SourceFailure extends Error {}
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new SourceFailure("source"));
    },
  });
  const controller = new AbortController();
  const failure = await readBoundedStream(
    source,
    16,
    controller.signal,
    overflow
  ).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(SourceFailure);
  expect(source.locked).toBe(false);
  // A later abort must not throw once the listener has been removed.
  controller.abort();
});
