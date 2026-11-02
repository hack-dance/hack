import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdoptionDependencyFirstPrepare,
  adoptionDependencyStagedReadAllowed,
  captureAdoptionDependencyFirstPrepare,
} from "./e2e/scenarios/native-compose-adoption-dependency-staged-read.ts";

const CANARY = "synthetic-private-staged-read-canary";
const token = "a".repeat(32);
let root: string;
let first: AdoptionDependencyFirstPrepare;
let generations: string;
let saved: string;
let receiptPath: string;
let args: string[];
let receipt: Record<string, unknown>;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "adoption-staged-read-")));
  await mkdir(join(root, ".hack"), { mode: 0o700 });
  await writeFile(
    join(root, ".hack/docker-compose.yml"),
    `services:\n  db:\n    image: ${CANARY}\n`,
    { mode: 0o600 }
  );
  first = await captureAdoptionDependencyFirstPrepare({ projectRoot: root });
  const state = join(root, ".hack/.internal/legacy-compose-adoption-v1");
  generations = join(state, "generations");
  await mkdir(join(generations, token), { recursive: true, mode: 0o700 });
  saved = join(generations, token, "legacy-compose.yml");
  await writeFile(saved, first.source.text, { mode: 0o600 });
  receiptPath = join(state, "receipt.json");
  receipt = {
    adoption_receipt_version: 1,
    kind: "legacy-compose-adopted",
    checkout: { root: first.root, project: first.project },
    prepared: null,
    publication: null,
    pendingOperation: null,
  };
  await writeReceipt();
  args = [
    "compose",
    "--project-name",
    "fixture",
    "--project-directory",
    join(root, ".hack"),
    "--env-file",
    "/dev/null",
    "--profile",
    "*",
    "--file",
    saved,
    "config",
    "--no-env-resolution",
    "--hash",
    "*",
  ];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function writeReceipt() {
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
}
function admitted() {
  return adoptionDependencyStagedReadAllowed({
    args,
    project: "fixture",
    first,
  });
}

test("first staged hash read is read-only, exact-byte bound and leaves the empty receipt unchanged", async () => {
  const original = await readFile(receiptPath);
  expect(await admitted()).toBe(true);
  expect(await readFile(receiptPath)).toEqual(original);
  expect(await readFile(saved, "utf8")).toBe(first.source.text);
});

test("an existing orphan store cannot be captured as a newly issued first preparation", async () => {
  await expect(
    captureAdoptionDependencyFirstPrepare({ projectRoot: root })
  ).rejects.toThrow("first-prepare capture refused; values omitted");
});

for (const [name, change] of [
  [
    "second token",
    async () => {
      await mkdir(join(generations, "b".repeat(32)), { mode: 0o700 });
    },
  ],
  [
    "non-token sibling",
    async () => {
      await writeFile(join(generations, "extra"), CANARY);
    },
  ],
  [
    "different private bytes",
    async () => {
      await writeFile(saved, `${first.source.text}\n`);
    },
  ],
  [
    "missing staged file",
    async () => {
      await rm(saved);
    },
  ],
  [
    "missing receipt",
    async () => {
      await rm(receiptPath);
    },
  ],
  [
    "same-byte source replacement",
    async () => {
      const path = join(root, ".hack/docker-compose.yml");
      await rename(path, `${path}.old`);
      await writeFile(path, first.source.text, { mode: 0o600 });
    },
  ],
  [
    "source drift",
    async () => {
      await writeFile(
        join(root, ".hack/docker-compose.yml"),
        `${first.source.text}\n`
      );
    },
  ],
  [
    "source unsafe mode",
    async () => {
      await chmod(join(root, ".hack/docker-compose.yml"), 0o666);
    },
  ],
  [
    "staged symlink",
    async () => {
      await rename(saved, `${saved}.old`);
      await symlink(`${saved}.old`, saved);
    },
  ],
  [
    "staged hardlink",
    async () => {
      await link(saved, `${saved}.link`);
    },
  ],
  [
    "staged unsafe mode",
    async () => {
      await chmod(saved, 0o644);
    },
  ],
  [
    "generation unsafe mode",
    async () => {
      await chmod(join(generations, token), 0o755);
    },
  ],
  [
    "generation symlink",
    async () => {
      const path = join(generations, token);
      await rename(path, `${path}.old`);
      await symlink(`${path}.old`, path);
    },
  ],
  [
    "internal ancestor symlink",
    async () => {
      const path = join(root, ".hack/.internal");
      await rename(path, `${path}.old`);
      await symlink(`${path}.old`, path);
    },
  ],
  [
    "receipt symlink",
    async () => {
      await rename(receiptPath, `${receiptPath}.old`);
      await symlink(`${receiptPath}.old`, receiptPath);
    },
  ],
  [
    "receipt hardlink",
    async () => {
      await link(receiptPath, `${receiptPath}.link`);
    },
  ],
  [
    "receipt private canary",
    async () => {
      await writeFile(receiptPath, CANARY);
    },
  ],
  [
    "prepared receipt",
    async () => {
      receipt.prepared = { id: token };
      await writeReceipt();
    },
  ],
  [
    "pending receipt",
    async () => {
      receipt.pendingOperation = { operation: "stop" };
      await writeReceipt();
    },
  ],
  [
    "publication receipt",
    async () => {
      receipt.publication = { phase: "active" };
      await writeReceipt();
    },
  ],
  [
    "foreign checkout",
    async () => {
      receipt.checkout = { root: { dev: 0, ino: 1 }, project: first.project };
      await writeReceipt();
    },
  ],
  [
    "unknown receipt field",
    async () => {
      receipt.private = CANARY;
      await writeReceipt();
    },
  ],
  [
    "container start",
    async () => {
      args = ["container", "start", "c".repeat(64)];
    },
  ],
  [
    "Compose mutation",
    async () => {
      args.splice(11, 4, "up", "--detach");
    },
  ],
  [
    "alternate input",
    async () => {
      args[10] = `${saved}.old`;
    },
  ],
  [
    "alternate argv",
    async () => {
      args.push("--profiles");
    },
  ],
] as const) {
  test(`staged-only read refuses ${name} without forwarding or leaking values`, async () => {
    await change();
    let forwarded = 0;
    if (await admitted()) {
      forwarded++;
    }
    expect(forwarded).toBe(0);
  });
}
