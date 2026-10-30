import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  checksums,
  MAX_ARCHIVE,
  metadata,
  object,
  parseJson,
  requireThat,
} from "./integrity.ts";
import { TransferBudget } from "./transfer-budget.ts";

const HOSTS = new Set([
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
export function secureUrl(raw: string) {
  const url = new URL(raw);
  requireThat(
    url.protocol === "https:" &&
      HOSTS.has(url.hostname) &&
      (!url.port || url.port === "443") &&
      !url.username &&
      !url.password &&
      !url.hash,
    "Refusing nonofficial or non-HTTPS download."
  );
  return url;
}
/** Every redirect is allowlisted; shared budgets are owned by the sequence caller. */
export async function download(
  raw: string,
  target: string,
  limit: number,
  sharedBudget?: TransferBudget
) {
  const budget = sharedBudget ?? new TransferBudget();
  try {
    return await downloadWithinBudget(raw, target, limit, budget);
  } finally {
    if (!sharedBudget) {
      budget.close();
    }
  }
}
async function downloadWithinBudget(
  raw: string,
  target: string,
  limit: number,
  budget: TransferBudget
) {
  let url = secureUrl(raw);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let fd: number | undefined;
  let primaryFailure: unknown;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await budget.wait(() =>
        fetch(url, {
          redirect: "manual",
          signal: budget.signal,
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "hack-prerelease-installer",
            "Accept-Encoding": "identity",
          },
        })
      );
      budget.progress();
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        break;
      }
      const location = response.headers.get("location");
      requireThat(
        location && redirects < 5,
        "Missing redirect or redirect budget exceeded."
      );
      const next = secureUrl(new URL(location, url).href);
      const body = response.body;
      response = undefined; // The cancellation below is the sole cleanup attempt for this response.
      if (body) {
        await budget.settleCancellation(() => body.cancel());
      }
      url = next;
    }
    requireThat(response?.ok && response.body, "Release download failed.");
    const declared = response.headers.get("content-length");
    requireThat(
      declared === null || /^[0-9]{1,12}$/.test(declared),
      "Malformed release download length."
    );
    const expected = declared === null ? undefined : Number(declared);
    requireThat(
      expected === undefined || expected <= limit,
      "Release download exceeds its size budget."
    );
    fd = openSync(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    );
    reader = response.body.getReader();
    fchmodSync(fd, 0o600);
    let size = 0;
    for (;;) {
      const activeReader = reader;
      const incoming = await budget.wait(() => activeReader.read());
      if (incoming.done) {
        break;
      }
      const chunk = incoming.value;
      if (chunk.length > 0) {
        budget.progress();
      }
      size += chunk.length;
      requireThat(
        size <= limit && (expected === undefined || size <= expected),
        "Release download exceeds its size budget or declared length."
      );
      let offset = 0;
      while (offset < chunk.length) {
        offset += writeSync(fd, chunk, offset, chunk.length - offset);
      }
    }
    requireThat(
      expected === undefined || size === expected,
      "Release download is incomplete."
    );
    fsyncSync(fd);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      if (reader) {
        const activeReader = reader;
        await budget.settleCancellation(
          () => activeReader.cancel(),
          primaryFailure
        );
      } else if (response?.body) {
        const body = response.body;
        await budget.settleCancellation(() => body.cancel(), primaryFailure);
      }
    } finally {
      try {
        reader?.releaseLock();
      } finally {
        if (fd !== undefined) {
          closeSync(fd);
        }
      }
    }
  }
}
/** The five official downloads share one monotonic total budget, plus bounded cancellation grace. */
export async function officialArchive(
  stage: string,
  version: string,
  budget = new TransferBudget()
) {
  try {
    return await officialArchiveWithinBudget(stage, version, budget);
  } finally {
    budget.close();
  }
}
async function officialArchiveWithinBudget(
  stage: string,
  version: string,
  budget: TransferBudget
) {
  const transfer = (url: string, target: string, limit: number) =>
    download(url, target, limit, budget);
  const repository = "hack-dance/hack";
  const tag = `v${version}`;
  const api = join(stage, "release-api.json");
  await transfer(
    `https://api.github.com/repos/${repository}/releases/tags/${tag}`,
    api,
    2 * 1024 * 1024
  );
  const release = parseJson(readFileSync(api));
  requireThat(
    release.tag_name === tag &&
      release.prerelease === true &&
      release.draft === false &&
      Array.isArray(release.assets),
    "Expected a published, pinned official prerelease."
  );
  const name = `hack-${version}-darwin-arm64-native.tar.gz`;
  const wanted = [name, "SHA256SUMS", "prerelease.json"];
  const selected = new Map<string, string>();
  for (const raw of release.assets) {
    const asset = object(raw);
    requireThat(
      typeof asset.name === "string",
      "Malformed release asset name."
    );
    if (!wanted.includes(asset.name)) {
      continue;
    }
    const expected = `https://github.com/${repository}/releases/download/${tag}/${asset.name}`;
    requireThat(
      !selected.has(asset.name) && asset.browser_download_url === expected,
      "Duplicate or foreign release asset."
    );
    selected.set(asset.name, expected);
  }
  requireThat(
    selected.size === wanted.length,
    "Incomplete official prerelease assets."
  );
  const get = (name: string) => {
    const url = selected.get(name);
    requireThat(url, "Missing asset.");
    return url;
  };
  await transfer(
    get("prerelease.json"),
    join(stage, "release-metadata.json"),
    64 * 1024
  );
  const identity = metadata(
    readFileSync(join(stage, "release-metadata.json")),
    version
  );
  await transfer(
    `https://api.github.com/repos/${repository}/git/ref/tags/${tag}`,
    join(stage, "release-tag.json"),
    64 * 1024
  );
  const reference = parseJson(readFileSync(join(stage, "release-tag.json")));
  const commit = object(reference.object);
  requireThat(
    reference.ref === `refs/tags/${tag}` &&
      commit.type === "commit" &&
      commit.sha === identity.source_revision,
    "Official prerelease tag does not match its source revision."
  );
  await transfer(
    get("SHA256SUMS"),
    join(stage, "release-checksums"),
    64 * 1024
  );
  const checksum = checksums(readFileSync(join(stage, "release-checksums")), [
    name,
  ])[name];
  requireThat(checksum, "Missing archive checksum.");
  const archive = join(stage, name);
  await transfer(get(name), archive, MAX_ARCHIVE);
  return { archive, checksum, releaseMetadata: identity };
}
