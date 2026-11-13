import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { TransferBudget } from "./release-transfer-budget.ts";

export type ReleaseFetch = (
  url: string,
  init: RequestInit
) => Promise<Response>;
const OFFICIAL_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
export function officialReleaseUrl(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    !OFFICIAL_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  ) {
    throw new Error(
      "Refusing nonofficial or non-HTTPS download; installation unchanged."
    );
  }
  return url.href;
}
const SHA256 = /^[a-f0-9]{64}$/;
const LENGTH = /^[0-9]{1,12}$/;
class TransferFailure extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}
/** Fresh retries share a deadline. No unverified partial is adopted; uncertain
 * cancellation refuses retry. The request seam is never selected by environment. */
export async function transferRelease(opts: {
  readonly url: string;
  readonly path: string;
  readonly sha256?: string;
  readonly request?: ReleaseFetch;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly idleMs?: number;
  readonly budget?: TransferBudget;
}) {
  const budget =
    opts.budget ??
    new TransferBudget({
      totalMs: opts.timeoutMs ?? 10 * 60_000,
      inactivityMs: opts.idleMs,
    });
  try {
    if (opts.sha256 !== undefined && !SHA256.test(opts.sha256)) {
      throw new Error("Invalid release SHA-256.");
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await transferAttempt({
          ...opts,
          request: opts.request ?? fetch,
          budget,
          limit: opts.maxBytes ?? 512 * 1024 * 1024,
        });
        return;
      } catch (error) {
        if (
          !(error instanceof TransferFailure && error.retryable) ||
          attempt >= 2 ||
          budget.signal.aborted
        ) {
          throw error;
        }
        await budget.wait(() =>
          delay(50 * 2 ** attempt, undefined, { signal: budget.signal })
        );
      }
    }
  } finally {
    if (!opts.budget) {
      budget.close();
    }
  }
}
async function transferAttempt(opts: {
  readonly url: string;
  readonly path: string;
  readonly sha256?: string;
  readonly request: ReleaseFetch;
  readonly budget: TransferBudget;
  readonly limit: number;
}) {
  let url = officialReleaseUrl(opts.url);
  const budget = opts.budget;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let complete = false;
  let primaryFailure: unknown;
  let terminalReadFailure = false;
  let cleanupSettled = false;
  try {
    for (let redirects = 0; ; redirects++) {
      try {
        response = await budget.wait(() =>
          opts.request(url, {
            redirect: "manual",
            signal: budget.signal,
            headers: {
              "user-agent": "hack-cli",
              "accept-encoding": "identity",
            },
          })
        );
      } catch {
        budget.signal.throwIfAborted();
        throw new TransferFailure(
          "Network unavailable or interrupted; installation unchanged. Retry when connectivity returns.",
          !budget.signal.aborted
        );
      }
      budget.progress();
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        break;
      }
      const location = response.headers.get("location");
      if (!location || redirects >= 5) {
        throw new TransferFailure(
          "Release redirect budget exceeded; installation unchanged.",
          false
        );
      }
      url = officialReleaseUrl(new URL(location, url).href);
      const body = response.body;
      response = undefined;
      if (body) {
        await budget.settleCancellation(() => body.cancel());
      }
    }
    if (!(response.ok && response.body)) {
      throw new TransferFailure(
        `Release download failed (${response.status}); installation unchanged.`,
        [502, 503, 504].includes(response.status)
      );
    }
    const header = response.headers.get("content-length");
    if (header !== null && !LENGTH.test(header)) {
      throw new TransferFailure(
        "Malformed release download length; installation unchanged.",
        false
      );
    }
    const expected = header === null ? undefined : Number(header);
    if (expected !== undefined && expected > opts.limit) {
      throw new TransferFailure(
        "Release download exceeds its size budget; installation unchanged.",
        false
      );
    }
    file = await open(
      opts.path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    );
    const hash = createHash("sha256");
    reader = response.body.getReader();
    let size = 0;
    for (;;) {
      const activeReader = reader;
      let chunk: Awaited<ReturnType<typeof activeReader.read>>;
      try {
        chunk = await budget.wait(() =>
          activeReader.read().catch(async (error: unknown) => {
            // A rejected read puts the WHATWG stream in its terminal errored
            // state. cancel() would only reject with that same stored error.
            let terminal = false;
            void activeReader.closed.then(
              () => {
                terminal = true;
              },
              () => {
                terminal = true;
              }
            );
            await Promise.resolve();
            terminalReadFailure = terminal && !budget.signal.aborted;
            throw error;
          })
        );
      } catch {
        budget.signal.throwIfAborted();
        throw new TransferFailure(
          "Release download interrupted; installation unchanged. Retry the update.",
          !budget.signal.aborted
        );
      }
      if (chunk.done) {
        break;
      }
      if (chunk.value.length) {
        budget.progress();
      }
      size += chunk.value.length;
      if (size > opts.limit || (expected !== undefined && size > expected)) {
        throw new TransferFailure(
          "Release download exceeds its size budget or declared length; installation unchanged.",
          false
        );
      }
      hash.update(chunk.value);
      await file.writeFile(chunk.value);
    }
    if (expected !== undefined && expected !== size) {
      throw new TransferFailure(
        "Release download is incomplete; installation unchanged.",
        true
      );
    }
    if (opts.sha256 !== undefined && hash.digest("hex") !== opts.sha256) {
      throw new TransferFailure(
        "Release checksum mismatch; installation unchanged.",
        false
      );
    }
    await file.sync();
    complete = true;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      if (reader) {
        if (!terminalReadFailure) {
          const active = reader;
          await budget.settleCancellation(
            () => active.cancel(),
            primaryFailure
          );
        }
      } else if (response?.body) {
        const body = response.body;
        await budget.settleCancellation(() => body.cancel(), primaryFailure);
      }
      cleanupSettled = true;
    } finally {
      reader?.releaseLock();
      if (file) {
        try {
          if (!complete && cleanupSettled) {
            await removeOwnedPartial(file, opts.path);
          }
        } finally {
          await file.close();
        }
      }
    }
  }
}

async function removeOwnedPartial(
  file: Awaited<ReturnType<typeof open>>,
  path: string
) {
  const owned = await file.stat();
  const current = await lstat(path);
  if (current.dev !== owned.dev || current.ino !== owned.ino) {
    throw new Error("Partial download identity changed; cleanup refused.");
  }
  await unlink(path);
}
