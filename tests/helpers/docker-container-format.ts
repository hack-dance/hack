import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createNativeComposeProbe } from "../../src/lib/native-compose-ownership.ts";

export const DOCKER_FORMAT_CONTAINER_ID = "a".repeat(64);
const HASH = /^[a-f0-9]{64}$/;
const INSPECT_PATH = `/v1.41/containers/${DOCKER_FORMAT_CONTAINER_ID}/json`;
function refuse(): never {
  throw new Error("Synthetic Docker formatting fixture is unsafe or changed.");
}
function sameIdentity(
  a: Awaited<ReturnType<typeof lstat>>,
  b: Awaited<ReturnType<typeof lstat>>
) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
async function binaryIdentity(path: string, hash: string) {
  if (
    !(isAbsolute(path) && HASH.test(hash)) ||
    (await realpath(path)) !== path
  ) {
    refuse();
  }
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o111) === 0 ||
      (stat.mode & 0o022) !== 0 ||
      stat.size <= 0 ||
      stat.size > 128 * 1024 * 1024
    ) {
      refuse();
    }
    const bytes = await file.readFile(),
      current = await file.stat(),
      named = await lstat(path);
    if (
      bytes.byteLength !== stat.size ||
      new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== hash ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      !sameIdentity(stat, current) ||
      !sameIdentity(stat, named) ||
      (await realpath(path)) !== path
    ) {
      refuse();
    }
    return stat;
  } finally {
    await file.close();
  }
}

/**
 * The pinned real Docker client formats only synthetic inspect JSON from this
 * owned Unix socket. No request is forwarded and no caller config is inherited.
 * The existing bounded probe settles each client and both output pipes.
 */
export async function withDockerContainerFormatFixture<T>(opts: {
  readonly binary: string;
  readonly sha256: string;
  readonly container: Readonly<Record<string, unknown>>;
  readonly observe: (probe: (format: string) => Promise<string>) => Promise<T>;
}): Promise<T> {
  const binary = opts.binary,
    sha256 = opts.sha256,
    response = JSON.stringify(opts.container),
    observe = opts.observe;
  if (response.length > 64 * 1024) {
    refuse();
  }
  const anchor = await binaryIdentity(binary, sha256);
  const root = await realpath(await mkdtemp(join(tmpdir(), "docker-fmt-")));
  await chmod(root, 0o700);
  const rootIdentity = await lstat(root),
    config = join(root, "config"),
    socket = join(root, "engine.sock"),
    alias = join(root, "docker");
  const assertRoot = async () => {
    const current = await lstat(root);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== rootIdentity.dev ||
      current.ino !== rootIdentity.ino ||
      current.uid !== rootIdentity.uid ||
      current.mode !== rootIdentity.mode ||
      (await realpath(root)) !== root
    ) {
      refuse();
    }
  };
  let server: ReturnType<typeof Bun.serve> | undefined;
  let unexpected = false;
  try {
    await mkdir(config, { mode: 0o700 });
    await writeFile(join(config, "config.json"), "{}", {
      mode: 0o600,
      flag: "wx",
    });
    await symlink(binary, alias);
    server = Bun.serve({
      unix: socket,
      fetch(request) {
        const url = new URL(request.url);
        if (
          url.pathname === "/_ping" &&
          ["HEAD", "GET"].includes(request.method)
        ) {
          return new Response("OK", {
            headers: { "Api-Version": "1.41", Ostype: "linux" },
          });
        }
        if (request.method === "GET" && url.pathname === INSPECT_PATH) {
          return new Response(response, {
            headers: { "Content-Type": "application/json" },
          });
        }
        unexpected = true;
        return new Response("Synthetic fixture refuses this request", {
          status: 403,
        });
      },
    });
    const socketIdentity = await lstat(socket),
      environment = process.env;
    let owner: ReturnType<typeof createNativeComposeProbe>;
    try {
      // The owner captures this selection synchronously before returning.
      process.env = {
        PATH: root,
        HOME: root,
        DOCKER_CONFIG: config,
        DOCKER_HOST: `unix://${socket}`,
        DOCKER_API_VERSION: "1.41",
      };
      owner = createNativeComposeProbe({ timeoutMs: 15_000 });
    } finally {
      process.env = environment;
    }
    const result = await observe(async (format) => {
      await assertRoot();
      const selected = await lstat(socket);
      if (
        !selected.isSocket() ||
        selected.dev !== socketIdentity.dev ||
        selected.ino !== socketIdentity.ino ||
        (await realpath(alias)) !== binary
      ) {
        refuse();
      }
      return await owner([
        "container",
        "inspect",
        "--format",
        format,
        DOCKER_FORMAT_CONTAINER_ID,
      ]);
    });
    await assertRoot();
    if (
      unexpected ||
      !sameIdentity(anchor, await binaryIdentity(binary, sha256))
    ) {
      refuse();
    }
    return result;
  } finally {
    await server?.stop(true);
    await assertRoot();
    await rm(root, { recursive: true });
  }
}
