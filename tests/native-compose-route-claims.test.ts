import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NativeComposeRouteAttempt,
  type NativeComposeRouteBinding,
  type NativeComposeRouteClaims,
  type NativeComposeRouteOwner,
  openNativeComposeRouteClaims,
} from "../src/lib/native-compose-route-claims.ts";

const BINDING: NativeComposeRouteBinding = {
  engineId: "fixture-engine:1",
  proxyId: "a".repeat(64),
  networkId: "b".repeat(64),
};
const OWNER: NativeComposeRouteOwner = {
  composeProject: "hack-fixture-one",
  ownerToken: "1".repeat(32),
};
const OTHER: NativeComposeRouteOwner = {
  composeProject: "hack-fixture-two",
  ownerToken: "2".repeat(32),
};
const HOST = "app.fixture.hack.local";
const GENERATION = "c".repeat(32);
const roots: string[] = [];
const stores: NativeComposeRouteClaims[] = [];
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
async function fixture(): Promise<string> {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "native-route-claims-"))
  );
  roots.push(root);
  // Existing Hack home can be 0755. The new route state must still be private.
  await fs.chmod(root, 0o755);
  return root;
}
async function store(root: string, owner = OWNER, binding = BINDING) {
  const result = await openNativeComposeRouteClaims({
    root: join(root, "compose-routing"),
    owner,
    binding,
  });
  stores.push(result);
  return result;
}
function namespace(root: string, binding = BINDING) {
  return join(root, "compose-routing", hash(binding.engineId));
}
function claimPath(root: string, hostname = HOST) {
  return join(namespace(root), "claims", `${hash(hostname)}.json`);
}
function ownerPath(root: string, owner = OWNER) {
  return join(namespace(root), "owners", hash(JSON.stringify(owner)));
}
function attemptPath(
  root: string,
  attempt: NativeComposeRouteAttempt,
  owner = OWNER
) {
  return join(ownerPath(root, owner), "attempts", attempt.reference.attemptId);
}
async function acquire(result: NativeComposeRouteClaims, names = [HOST]) {
  return await result.acquire({
    hostnames: names,
    generationIdentity: GENERATION,
  });
}
async function complete(
  result: NativeComposeRouteClaims,
  attempt: NativeComposeRouteAttempt
) {
  await result.markEffectsPossible(attempt);
  await result.complete({ attempt, assertTransition: async () => {} });
}
async function waitForFile(path: string) {
  const deadline = performance.now() + 5000;
  while (!(await Bun.file(path).exists())) {
    if (performance.now() >= deadline) {
      throw new Error("fixture barrier timed out");
    }
    await Bun.sleep(10);
  }
}
function spawn(source: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
}

test("claims are private complete files and exact immutable references reopen", async () => {
  const root = await fixture();
  const result = await store(root);
  const attempt = await acquire(result, ["z.fixture.hack.local", HOST, HOST]);
  expect(attempt.hostnames).toEqual([HOST, "z.fixture.hack.local"]);
  const info = await fs.lstat(claimPath(root));
  expect(info.mode & 0o777).toBe(0o600);
  expect(info.nlink).toBe(1);
  expect((await fs.lstat(join(root, "compose-routing"))).mode & 0o777).toBe(
    0o700
  );
  expect((await fs.lstat(root)).mode & 0o777).toBe(0o755);
  const reserved = await Bun.file(
    join(attemptPath(root, attempt), "reserved.json")
  ).json();
  expect(reserved.entries[0].anchor.ino).toBe(info.ino);
  expect(reserved.entries[0].anchor.hash).toBe(
    hash(await Bun.file(claimPath(root)).text())
  );
  expect(await (await store(root)).reopen(attempt.reference)).toEqual(attempt);
  expect(
    (await Bun.file(claimPath(root)).text()).includes("generationIdentity")
  ).toBe(false);
});

test("same-owner restart adopts only the pinned claim and keeps old/new union until verified release", async () => {
  const root = await fixture();
  const result = await store(root);
  const first = await acquire(result);
  await complete(result, first);
  const original = await fs.lstat(claimPath(root));
  const second = await result.acquire({
    hostnames: [HOST, "new.fixture.hack.local"],
    generationIdentity: "d".repeat(32),
  });
  expect((await fs.lstat(claimPath(root))).ino).toBe(original.ino);
  await complete(result, second);
  let proved: readonly string[] = [];
  await result.release({
    keepHostnames: ["new.fixture.hack.local"],
    assertAbsent: async (selection) => {
      proved = selection.hostnames;
    },
  });
  expect(proved).toEqual([HOST]);
  expect(await Bun.file(claimPath(root)).exists()).toBe(false);
  expect(
    await Bun.file(claimPath(root, "new.fixture.hack.local")).exists()
  ).toBe(true);
  expect((await result.reopen(first.reference)).phase).toBe("complete");
});

test("foreign same-origin collision refuses before caller effect and preserves owner", async () => {
  const root = await fixture();
  const winner = await store(root);
  const attempt = await acquire(winner);
  const original = await Bun.file(claimPath(root)).text();
  const loser = await store(root, OTHER);
  let effects = 0;
  await expect(
    (async () => {
      await acquire(loser);
      effects += 1;
    })()
  ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_ROUTE_CONFLICT" });
  expect(effects).toBe(0);
  expect(await Bun.file(claimPath(root)).text()).toBe(original);
  expect(await winner.reopen(attempt.reference)).toEqual(attempt);
});

test("real simultaneous independent processes have exactly one hostname winner and effect", async () => {
  const root = await fixture();
  const module = new URL(
    "../src/lib/native-compose-route-claims.ts",
    import.meta.url
  ).href;
  const launched = [OWNER, OTHER].map((owner, index) =>
    spawn(`
    import {openNativeComposeRouteClaims} from ${JSON.stringify(module)};
    const root = ${JSON.stringify(root)};
    const index = ${index};
    const store = await openNativeComposeRouteClaims({ root: root + "/compose-routing", binding: ${JSON.stringify(BINDING)}, owner: ${JSON.stringify(owner)} });
    await Bun.write(root + "/ready-" + index, "ready");
    while (!await Bun.file(root + "/go").exists()) await Bun.sleep(5);
    try {
      const attempt = await store.acquire({hostnames: [${JSON.stringify(HOST)}], generationIdentity: ${JSON.stringify(GENERATION)}});
      await store.markEffectsPossible(attempt);
      await Bun.write(root + "/effect-" + index, "owned synthetic effect");
      await store.complete({attempt, assertTransition: async () => {}});
      console.log("winner");
    } catch (error) { console.log("refused"); }
    await store.close();
  `)
  );
  await Promise.all(
    [0, 1].map((index) => waitForFile(join(root, `ready-${index}`)))
  );
  await Bun.write(join(root, "go"), "go");
  const outputs = await Promise.all(
    launched.map(async (child) => {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(err).toBe("");
      return out.trim();
    })
  );
  expect(outputs.sort()).toEqual(["refused", "winner"]);
  const effects = await Promise.all(
    [0, 1].map((index) => Bun.file(join(root, `effect-${index}`)).exists())
  );
  expect(effects.filter(Boolean)).toHaveLength(1);
  expect((await fs.lstat(claimPath(root))).nlink).toBe(1);
}, 10_000);

test("sorted partial publication rolls back only newly proven claims and leaves adopted claims", async () => {
  const root = await fixture();
  const result = await store(root);
  const old = await acquire(result, ["a.fixture.hack.local"]);
  await complete(result, old);
  const before = await Bun.file(claimPath(root, "a.fixture.hack.local")).text();
  const original = fs.link;
  const order: string[] = [];
  const spy = spyOn(fs, "link").mockImplementation(async (from, to) => {
    order.push(String(to));
    if (String(to) === claimPath(root, "z.fixture.hack.local")) {
      throw new Error("synthetic private failure");
    }
    return await original(from, to);
  });
  try {
    await expect(
      acquire(result, [
        "z.fixture.hack.local",
        "m.fixture.hack.local",
        "a.fixture.hack.local",
      ])
    ).rejects.toThrow("values omitted");
  } finally {
    spy.mockRestore();
  }
  expect(order.indexOf(claimPath(root, "m.fixture.hack.local"))).toBeLessThan(
    order.indexOf(claimPath(root, "z.fixture.hack.local"))
  );
  expect(await Bun.file(claimPath(root, "m.fixture.hack.local")).exists()).toBe(
    false
  );
  expect(await Bun.file(claimPath(root, "z.fixture.hack.local")).exists()).toBe(
    false
  );
  expect(await Bun.file(claimPath(root, "a.fixture.hack.local")).text()).toBe(
    before
  );
  expect((await acquire(result, ["fresh.fixture.hack.local"])).phase).toBe(
    "reserved"
  );
});

test("claim publication completed before reservation can be adopted after interruption", async () => {
  const root = await fixture();
  const result = await store(root);
  const original = fs.link;
  const spy = spyOn(fs, "link").mockImplementation(async (from, to) => {
    if (String(to).endsWith("/reserved.json")) {
      throw new Error("injected before reservation");
    }
    return await original(from, to);
  });
  try {
    await expect(acquire(result)).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
  // The handled failure rolls new claims back. An actual abrupt kill would retain
  // intent+claim; simulate that exact durable prefix using the original intent.
  const attempts = await fs.readdir(join(ownerPath(root), "attempts"));
  const intent = await Bun.file(
    join(ownerPath(root), "attempts", attempts[0] ?? "", "intent.json")
  ).json();
  await fs.rm(join(ownerPath(root), "releases"), { recursive: true });
  await fs.mkdir(join(ownerPath(root), "releases"), { mode: 0o700 });
  await fs.unlink(
    join(ownerPath(root), "attempts", attempts[0] ?? "", "aborted.json")
  );
  await fs.writeFile(claimPath(root), JSON.stringify(intent.claims[0]), {
    mode: 0o600,
  });
  await result.close();
  const reopened = await store(root);
  expect((await acquire(reopened)).phase).toBe("reserved");
});

test("explicit unarmed rollback removes only new claims, persists abort and keeps adopted current names", async () => {
  const root = await fixture();
  const result = await store(root);
  const current = await acquire(result);
  await complete(result, current);
  const before = await Bun.file(claimPath(root)).text();
  const next = await acquire(result, [HOST, "new.fixture.hack.local"]);
  await result.rollback(next);
  expect(await Bun.file(claimPath(root)).text()).toBe(before);
  expect(
    await Bun.file(claimPath(root, "new.fixture.hack.local")).exists()
  ).toBe(false);
  expect((await result.reopen(next.reference)).phase).toBe("aborted");
  await expect(result.markEffectsPossible(next)).rejects.toThrow(
    "values omitted"
  );
  await expect(result.rollback(next)).rejects.toThrow("values omitted");
});

test("rollback refuses reopened or armed attempts and preserves their claims", async () => {
  const root = await fixture();
  const result = await store(root);
  const attempt = await acquire(result);
  const saved = await result.reopen(attempt.reference);
  await expect(result.rollback(saved)).rejects.toThrow("values omitted");
  await result.markEffectsPossible(attempt);
  await expect(result.rollback(attempt)).rejects.toThrow("values omitted");
  expect(await Bun.file(claimPath(root)).exists()).toBe(true);
});

test("binding property order does not create a new namespace or prevent legitimate reopen", async () => {
  const root = await fixture();
  const result = await store(root);
  const attempt = await acquire(result);
  const reordered = await store(root, OWNER, {
    networkId: BINDING.networkId,
    engineId: BINDING.engineId,
    proxyId: BINDING.proxyId,
  });
  expect(await reordered.reopen(attempt.reference)).toEqual(attempt);
});

test("reset owner nonce for same Compose instance cannot adopt previous claims", async () => {
  const root = await fixture();
  await acquire(await store(root));
  const reset = await store(root, { ...OWNER, ownerToken: "f".repeat(32) });
  await expect(acquire(reset)).rejects.toMatchObject({
    code: "E_NATIVE_COMPOSE_ROUTE_CONFLICT",
  });
});

test("armed interrupted process retains claims; reopened snapshot cannot clear it", async () => {
  const root = await fixture();
  const module = new URL(
    "../src/lib/native-compose-route-claims.ts",
    import.meta.url
  ).href;
  const child = spawn(`
    import {openNativeComposeRouteClaims} from ${JSON.stringify(module)};
    const root = ${JSON.stringify(root)};
    const store = await openNativeComposeRouteClaims({root: root + "/compose-routing", binding: ${JSON.stringify(BINDING)}, owner: ${JSON.stringify(OWNER)}});
    const attempt = await store.acquire({hostnames:[${JSON.stringify(HOST)}], generationIdentity:${JSON.stringify(GENERATION)}});
    await store.markEffectsPossible(attempt);
    await Bun.write(root + "/attempt", JSON.stringify(attempt.reference));
    await Bun.sleep(60_000);
  `);
  await waitForFile(join(root, "attempt"));
  child.kill("SIGKILL");
  await child.exited;
  const reopened = await store(root);
  const attempt = await reopened.reopen(
    await Bun.file(join(root, "attempt")).json()
  );
  expect(attempt.phase).toBe("armed");
  let proofCalls = 0;
  await expect(
    reopened.complete({
      attempt,
      assertTransition: async () => {
        proofCalls += 1;
      },
    })
  ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_ROUTE_RETAINED" });
  await expect(
    reopened.release({
      assertAbsent: async () => {
        proofCalls += 1;
      },
    })
  ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_ROUTE_RETAINED" });
  expect(proofCalls).toBe(0);
  expect(await Bun.file(claimPath(root)).exists()).toBe(true);
  await expect(acquire(await store(root, OTHER))).rejects.toMatchObject({
    code: "E_NATIVE_COMPOSE_ROUTE_CONFLICT",
  });
}, 10_000);

test("explicit retained attempt survives new flows and cannot be overridden by an absence callback", async () => {
  const root = await fixture();
  const result = await store(root);
  const attempt = await acquire(result);
  await result.markEffectsPossible(attempt);
  await result.retain(attempt);
  const reopened = await store(root);
  expect((await reopened.reopen(attempt.reference)).phase).toBe("retained");
  const next = await acquire(reopened, [HOST, "new.fixture.hack.local"]);
  await expect(reopened.markEffectsPossible(next)).rejects.toMatchObject({
    code: "E_NATIVE_COMPOSE_ROUTE_RETAINED",
  });
  await expect(
    reopened.release({ assertAbsent: async () => {} })
  ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_ROUTE_RETAINED" });
  expect(await Bun.file(claimPath(root)).exists()).toBe(true);
  expect(
    await Bun.file(claimPath(root, "new.fixture.hack.local")).exists()
  ).toBe(true);
});

test("normal verified release touches only this owner; other claim and network canary survive", async () => {
  const root = await fixture();
  const one = await store(root);
  const two = await store(root, OTHER);
  await complete(one, await acquire(one));
  const otherHost = "other.fixture.hack.local";
  await complete(two, await acquire(two, [otherHost]));
  const otherBefore = await Bun.file(claimPath(root, otherHost)).text();
  const canary = join(root, "network-canary");
  await Bun.write(canary, "network unchanged");
  let proof = false;
  await one.release({
    assertAbsent: async ({ binding, owner, hostnames }) => {
      expect(binding).toEqual(BINDING);
      expect(owner).toEqual(OWNER);
      expect(hostnames).toEqual([HOST]);
      proof = true;
    },
  });
  expect(proof).toBe(true);
  expect(await Bun.file(claimPath(root)).exists()).toBe(false);
  expect(await Bun.file(claimPath(root, otherHost)).text()).toBe(otherBefore);
  expect(await Bun.file(canary).text()).toBe("network unchanged");
  const replacement = await acquire(two);
  expect(replacement.phase).toBe("reserved");
  expect(
    (
      await one.reopen(
        (
          await acquire(one, ["another.fixture.hack.local"])
        ).reference
      )
    ).phase
  ).toBe("reserved");
});

test("failed absence proof retains every claim and does not publish deletion intent", async () => {
  const root = await fixture();
  const result = await store(root);
  await complete(result, await acquire(result));
  await expect(
    result.release({
      assertAbsent: async () => {
        throw new Error("stopped container is still present");
      },
    })
  ).rejects.toThrow("values omitted");
  expect(await Bun.file(claimPath(root)).exists()).toBe(true);
  expect(await fs.readdir(join(ownerPath(root), "releases"))).toEqual([]);
});

for (const change of [
  "inode",
  "symlink",
  "hardlink",
  "mode",
  "malformed",
  "growth",
] as const) {
  test(`saved claim ${change} refuses before effect or deletion proof`, async () => {
    const root = await fixture();
    const result = await store(root);
    const attempt = await acquire(result);
    const path = claimPath(root);
    const text = await Bun.file(path).text();
    if (change === "inode") {
      await fs.unlink(path);
      await fs.writeFile(path, text, { mode: 0o600 });
    }
    if (change === "symlink") {
      await fs.rename(path, `${path}.old`);
      await fs.symlink(`${path}.old`, path);
    }
    if (change === "hardlink") {
      await fs.link(path, `${path}.extra`);
    }
    if (change === "mode") {
      await fs.chmod(path, 0o644);
    }
    if (change === "malformed") {
      await fs.writeFile(path, "{synthetic-private-canary");
    }
    if (change === "growth") {
      await fs.writeFile(path, "x".repeat(65 * 1024));
    }
    let proofs = 0;
    await expect(result.reopen(attempt.reference)).rejects.toThrow(
      "values omitted"
    );
    await expect(
      result.complete({
        attempt,
        assertTransition: async () => {
          proofs += 1;
        },
      })
    ).rejects.toThrow("values omitted");
    await expect(
      result.release({
        assertAbsent: async () => {
          proofs += 1;
        },
      })
    ).rejects.toThrow("values omitted");
    expect(proofs).toBe(0);
    expect(await fs.lstat(path)).toBeDefined();
  });
}

test("growth during descriptor read refuses despite original reported file size", async () => {
  const root = await fixture();
  const result = await store(root);
  const attempt = await acquire(result);
  const original = fs.open;
  const spy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (String(args[0]) === claimPath(root)) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs: Parameters<typeof handle.read>) => {
        await fs.appendFile(claimPath(root), " ");
        return await read(...readArgs);
      };
    }
    return handle;
  });
  try {
    await expect(result.reopen(attempt.reference)).rejects.toThrow(
      "values omitted"
    );
  } finally {
    spy.mockRestore();
  }
});

for (const field of ["proxyId", "networkId"] as const) {
  test(`ingress ${field} replacement keeps stable engine namespace and refuses adoption`, async () => {
    const root = await fixture();
    const result = await store(root);
    await complete(result, await acquire(result));
    const before = await Bun.file(claimPath(root)).text();
    const replaced = await store(root, OWNER, {
      ...BINDING,
      [field]: "f".repeat(64),
    });
    await expect(acquire(replaced)).rejects.toThrow("values omitted");
    expect(await Bun.file(claimPath(root)).text()).toBe(before);
    expect(await fs.readdir(join(root, "compose-routing"))).toEqual([
      hash(BINDING.engineId),
    ]);
  });
}

test("private ancestor replacement refuses and never unlinks through replacement", async () => {
  const root = await fixture();
  const result = await store(root);
  const attempt = await acquire(result);
  await complete(result, attempt);
  const path = join(root, "compose-routing");
  await fs.rename(path, `${path}.old`);
  await fs.symlink(`${path}.old`, path);
  let proof = false;
  await expect(
    result.release({
      assertAbsent: async () => {
        proof = true;
      },
    })
  ).rejects.toThrow("values omitted");
  expect(proof).toBe(false);
  expect(await Bun.file(claimPath(root)).exists()).toBe(true);
});

test("claim replacement in the proof callback cannot authorize deletion of a new inode", async () => {
  const root = await fixture();
  const result = await store(root);
  await complete(result, await acquire(result));
  const before = await Bun.file(claimPath(root)).text();
  await expect(
    result.release({
      assertAbsent: async () => {
        await fs.unlink(claimPath(root));
        await fs.writeFile(claimPath(root), before, { mode: 0o600 });
      },
    })
  ).rejects.toThrow("values omitted");
  expect(await Bun.file(claimPath(root)).text()).toBe(before);
});

test("private reference and journal replacement cannot reopen or authorize effects", async () => {
  const root = await fixture();
  const result = await store(root);
  const attempt = await acquire(result);
  await expect(
    result.reopen({ ...attempt.reference, generationIdentity: "e".repeat(32) })
  ).rejects.toThrow();
  const path = join(attemptPath(root, attempt), "intent.json");
  const text = await Bun.file(path).text();
  await fs.unlink(path);
  await fs.writeFile(path, text, { mode: 0o600 });
  await expect(result.markEffectsPossible(attempt)).rejects.toThrow(
    "values omitted"
  );
  await expect((await store(root)).reopen(attempt.reference)).rejects.toThrow(
    "values omitted"
  );
});

for (const hostname of [
  "APP.example.com",
  "localhost",
  "../evil.example",
  "a.example:443",
  "*.example.com",
  "a.example.",
  "a..example",
  "https://a.example",
  `${"a".repeat(64)}.example`,
]) {
  test(`invalid hostname ${hostname} cannot publish a claim`, async () => {
    const root = await fixture();
    const result = await store(root);
    await expect(acquire(result, [hostname])).rejects.toThrow("values omitted");
    expect(await fs.readdir(join(namespace(root), "claims"))).toEqual([]);
  });
}
