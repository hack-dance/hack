import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type NativeComposeGeneration,
  type NativeComposeGenerationStore,
  type NativeComposeMutation,
  type NativeComposeReservation,
  openNativeComposeGenerationStore,
} from "../src/lib/native-compose-generation.ts";
import {
  type NativeComposeRouteClaims,
  openNativeComposeRouteClaims,
} from "../src/lib/native-compose-route-claims.ts";

const REVISION = createHash("sha256").update("synthetic input").digest("hex");
const fixtures: string[] = [];
const stores: NativeComposeGenerationStore[] = [];
const routeStores: NativeComposeRouteClaims[] = [];
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(routeStores.splice(0).map((store) => store.close()));
  await Promise.all(
    fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture(): Promise<string> {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "native-compose-generation-"))
  );
  fixtures.push(parent);
  const root = join(parent, "checkout");
  await mkdir(join(root, ".hack"), { recursive: true });
  await writeFile(
    join(root, ".hack", "hack.project.json"),
    JSON.stringify({ schema_version: 1, name: "fixture" })
  );
  return root;
}
async function store(
  root: string,
  instance: string | null = null,
  mode?: "prepare" | "saved"
) {
  const result = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance,
    mode,
  });
  stores.push(result);
  return result;
}
function document(
  reservation: NativeComposeReservation,
  value = "synthetic-secret"
) {
  const labels = {
    "io.hack.native-config.version": "1",
    "io.hack.native-config.instance": reservation.identity.composeProject,
    "io.hack.native-config.owner": reservation.identity.ownerToken,
  };
  return JSON.stringify({
    name: reservation.identity.composeProject,
    services: {
      app: {
        image: "fixture:1",
        environment: { TOKEN: value },
        labels: {
          ...labels,
          "io.hack.native-config.generation": reservation.generationId,
          "io.hack.native-config.workload": "service",
        },
      },
    },
    volumes: {
      data: { labels: { ...labels, "io.hack.native-config.storage": "data" } },
    },
    networks: { default: { labels } },
  });
}
async function publish(
  mutation: NativeComposeMutation,
  assertFresh: () => Promise<void> = async () => {}
) {
  const reservation = mutation.reserveGeneration();
  return await mutation.publish({
    reservation,
    composeJson: document(reservation),
    profiles: ["dev"],
    inputRevision: REVISION,
    assertFresh,
  });
}
async function activate(
  owner: NativeComposeGenerationStore
): Promise<NativeComposeGeneration> {
  return await owner.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    await mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
    });
    return generation;
  });
}
function receiptPath(owner: NativeComposeGenerationStore) {
  return join(
    owner.identity.checkoutRoot,
    ".hack",
    ".internal",
    "native-compose",
    owner.identity.instanceId,
    "receipt.json"
  );
}
async function rejected(effect: Promise<unknown>, code: string) {
  await expect(effect).rejects.toMatchObject({ code });
}

async function routeStore(
  root: string,
  owner: { readonly composeProject: string; readonly ownerToken: string }
) {
  const result = await openNativeComposeRouteClaims({
    root: join(root, "claims"),
    binding: {
      engineId: "fixture-engine:1",
      proxyId: "a".repeat(64),
      networkId: "b".repeat(64),
    },
    owner: {
      composeProject: owner.composeProject,
      ownerToken: owner.ownerToken,
    },
  });
  routeStores.push(result);
  return result;
}

test.each([
  "complete",
  "failed",
] as const)("dependent route finalizer %s preserves receipt ordering and hostname handoff", async (outcome) => {
  const root = await fixture();
  const owner = await store(root);
  const old = await activate(owner);
  const claims = await routeStore(root, owner.identity);
  const foreign = await routeStore(root, {
    composeProject: "foreign-finalizer-fixture",
    ownerToken: "e".repeat(32),
  });
  const oldHost = "old.fixture.test";
  const newHost = "new.fixture.test";
  const oldClaim = await claims.acquire({
    hostnames: [oldHost],
    generationIdentity: old.generationId,
  });
  await claims.markEffectsPossible(oldClaim);
  await claims.complete({
    attempt: oldClaim,
    assertTransition: async () => {},
  });
  let ownershipChecks = 0;
  await owner.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    const attempt = await claims.acquire({
      hostnames: [oldHost, newHost],
      generationIdentity: generation.generationId,
    });
    const effect = mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {
        ownershipChecks += 1;
      },
      effect: async () => {
        await claims.markEffectsPossible(attempt);
        return { outcome: "complete", value: 0 };
      },
      beforeComplete: async () => {
        const pending = await owner.loadCurrent();
        expect(pending.generation?.generationId).toBe(old.generationId);
        expect(pending.pending?.generationId).toBe(generation.generationId);
        expect(ownershipChecks).toBe(3);
        await claims.complete({
          attempt,
          assertTransition: async () => {
            if (outcome === "failed") {
              throw new Error("private-finalizer-canary");
            }
          },
        });
        await claims.release({
          keepHostnames: [newHost],
          assertAbsent: async () => {},
        });
        const handoff = await foreign.acquire({
          hostnames: [oldHost],
          generationIdentity: "f".repeat(32),
        });
        await foreign.rollback(handoff);
      },
    });
    if (outcome === "failed") {
      await rejected(effect, "E_NATIVE_COMPOSE_UNCERTAIN");
      await claims.retain(attempt);
      expect((await claims.reopen(attempt.reference)).phase).toBe("retained");
      for (const hostname of [oldHost, newHost]) {
        await expect(
          foreign.acquire({
            hostnames: [hostname],
            generationIdentity: "f".repeat(32),
          })
        ).rejects.toThrow();
      }
      await rejected(publish(mutation), "E_NATIVE_COMPOSE_UNCERTAIN");
    } else {
      expect(await effect).toEqual({ outcome: "complete", value: 0 });
    }
    const saved = await owner.loadCurrent();
    expect(saved.generation?.generationId).toBe(
      outcome === "complete" ? generation.generationId : old.generationId
    );
    expect(saved.pending?.generationId ?? null).toBe(
      outcome === "complete" ? null : generation.generationId
    );
    expect(ownershipChecks).toBe(outcome === "complete" ? 4 : 3);
    expect(await Bun.file(receiptPath(owner)).text()).not.toContain(
      "private-finalizer-canary"
    );
  });
});

test.each([
  "incomplete",
  "ownership-changed",
  "pending-changed",
] as const)("dependent finalizer refuses %s effects before claim completion", async (mode) => {
  const owner = await store(await fixture());
  const old = await activate(owner);
  let checks = 0;
  let finalizers = 0;
  await owner.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    const effect = mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {
        checks += 1;
        if (mode === "ownership-changed" && checks === 3) {
          throw new Error("ownership changed after reap");
        }
      },
      effect: async () => {
        if (mode === "pending-changed") {
          const receipt = JSON.parse(await Bun.file(receiptPath(owner)).text());
          receipt.pending.token = "d".repeat(32);
          await Bun.write(receiptPath(owner), JSON.stringify(receipt));
        }
        return {
          outcome: mode === "incomplete" ? "uncertain" : "complete",
          value: 0,
        };
      },
      beforeComplete: async () => {
        finalizers += 1;
      },
    });
    if (mode === "incomplete") {
      expect(await effect).toEqual({ outcome: "uncertain", value: 0 });
    } else {
      await rejected(effect, "E_NATIVE_COMPOSE_UNCERTAIN");
    }
    expect(finalizers).toBe(0);
    const saved = await owner.loadCurrent();
    expect(saved.generation?.generationId).toBe(old.generationId);
    expect(saved.pending?.generationId).toBe(generation.generationId);
  });
});

test("ownership drift during the finalizer retains pending generation intent", async () => {
  const owner = await store(await fixture());
  const old = await activate(owner);
  let owned = true;
  let finalizers = 0;
  await owner.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    await rejected(
      mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {
          if (!owned) {
            throw new Error("private-post-finalizer-ownership-canary");
          }
        },
        effect: async () => ({ outcome: "complete", value: 0 }),
        beforeComplete: async () => {
          finalizers += 1;
          owned = false;
        },
      }),
      "E_NATIVE_COMPOSE_UNCERTAIN"
    );
    expect(finalizers).toBe(1);
    const saved = await owner.loadCurrent();
    expect(saved.generation?.generationId).toBe(old.generationId);
    expect(saved.pending?.generationId).toBe(generation.generationId);
    expect(await Bun.file(receiptPath(owner)).text()).not.toContain(
      "private-post-finalizer-ownership-canary"
    );
  });
});

test("effect captures its dependent finalizer before the first asynchronous check", async () => {
  const owner = await store(await fixture());
  const events: string[] = [];
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  await owner.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    const options = {
      generation,
      operation: "up" as const,
      assertFresh: async () => {
        entered.resolve();
        await resume.promise;
      },
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete" as const, value: 0 }),
      beforeComplete: async () => {
        events.push("original");
      },
    };
    const effect = mutation.runEffect(options);
    await entered.promise;
    options.beforeComplete = async () => {
      events.push("replacement");
    };
    resume.resolve();
    expect(await effect).toEqual({ outcome: "complete", value: 0 });
    expect(events).toEqual(["original"]);
    expect((await owner.loadCurrent()).pending).toBeNull();
  });
});

test("SIGKILL after route retirement preserves the pending stop generation for idempotent recovery", async () => {
  const root = await fixture();
  const owner = await store(root);
  const generation = await owner.withMutation(async (mutation) => {
    const published = await publish(mutation);
    await mutation.runEffect({
      generation: published,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => ({ outcome: "uncertain", value: 1 }),
    });
    return published;
  });
  const claims = await routeStore(root, owner.identity);
  const attempt = await claims.acquire({
    hostnames: ["crash.fixture.test"],
    generationIdentity: generation.generationId,
  });
  await claims.markEffectsPossible(attempt);
  await claims.retain(attempt);
  const generationModule = new URL(
    "../src/lib/native-compose-generation.ts",
    import.meta.url
  ).href;
  const claimsModule = new URL(
    "../src/lib/native-compose-route-claims.ts",
    import.meta.url
  ).href;
  const binding = {
    engineId: "fixture-engine:1",
    proxyId: "a".repeat(64),
    networkId: "b".repeat(64),
  };
  const claimOwner = {
    composeProject: owner.identity.composeProject,
    ownerToken: owner.identity.ownerToken,
  };
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import {openNativeComposeGenerationStore} from ${JSON.stringify(generationModule)};
    import {openNativeComposeRouteClaims} from ${JSON.stringify(claimsModule)};
    const owner=await openNativeComposeGenerationStore({projectRoot:${JSON.stringify(root)},instance:null,mode:"saved"});
    const claims=await openNativeComposeRouteClaims({root:${JSON.stringify(join(root, "claims"))},binding:${JSON.stringify(binding)},owner:${JSON.stringify(claimOwner)}});
    const generation=await owner.loadPending();
    if(!generation) throw new Error("missing recovery generation");
    await owner.withMutation(m=>m.runEffect({generation,operation:"down",recoverPending:true,assertOwned:async()=>{},effect:async()=>({outcome:"complete",value:0}),beforeComplete:async()=>{
      await claims.recoverStopped({references:[${JSON.stringify(attempt.reference)}],assertAbsent:async()=>{}});
      await Bun.write(${JSON.stringify(join(root, "claims-retired"))},"retired");
      process.kill(process.pid,"SIGKILL");
    }}));
  `,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  children.push(child);
  expect(await child.exited).toBe(137);
  expect(await Bun.file(join(root, "claims-retired")).text()).toBe("retired");
  expect((await claims.reopen(attempt.reference)).phase).toBe("stopped");
  expect((await owner.loadCurrent()).pending?.generationId).toBe(
    generation.generationId
  );
  const foreign = await routeStore(root, {
    composeProject: "foreign-crash-fixture",
    ownerToken: "e".repeat(32),
  });
  const replacement = await foreign.acquire({
    hostnames: ["crash.fixture.test"],
    generationIdentity: "f".repeat(32),
  });
  await owner.recoverInterruptedLock();
  let proofs = 0;
  await owner.withMutation((mutation) =>
    mutation.runEffect({
      generation,
      operation: "down",
      recoverPending: true,
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
      beforeComplete: () =>
        claims.recoverStopped({
          references: [attempt.reference],
          assertAbsent: async ({ hostnames }) => {
            expect(hostnames).toEqual([]);
            proofs += 1;
          },
        }),
    })
  );
  expect(proofs).toBe(1);
  const saved = await owner.loadCurrent();
  expect(saved.pending).toBeNull();
  expect(saved.generation?.generationId).toBe(generation.generationId);
  expect(saved.stopped).toBe(true);
  expect((await foreign.reopen(replacement.reference)).phase).toBe("reserved");
  await foreign.rollback(replacement);
}, 10_000);

test("finite host intent is private, durable before effects, and cleared after verified completion", async () => {
  const owner = await store(await fixture());
  await owner.withMutation(async (mutation) => {
    expect(
      await mutation.runBeforeHooks({
        assertFresh: async () => {},
        effect: async () => {
          const saved = await owner.loadCurrent();
          expect(saved.generation).toBeNull();
          expect(saved.beforeHooksPending).toBe(true);
          const receipt = JSON.parse(await Bun.file(receiptPath(owner)).text());
          expect(Object.keys(receipt.beforeHooks)).toEqual(["token"]);
          expect(receipt.beforeHooks.token).toMatch(/^[a-f0-9]{32}$/);
          return { outcome: "complete", value: 17 };
        },
      })
    ).toEqual({ outcome: "complete", value: 17 });
  });
  expect((await owner.loadCurrent()).beforeHooksPending).toBe(false);
});

test("uncertain host completion survives reopen, blocks publication and replay, and retaining down cannot clear it", async () => {
  const root = await fixture();
  const owner = await store(root);
  const generation = await activate(owner);
  await owner.withMutation(async (mutation) => {
    await mutation.runBeforeHooks({
      assertFresh: async () => {},
      effect: async () => ({ outcome: "uncertain", value: 1 }),
    });
    await rejected(publish(mutation), "E_NATIVE_COMPOSE_UNCERTAIN");
    await rejected(
      mutation.runBeforeHooks({
        assertFresh: async () => {},
        effect: async () => {
          throw new Error("replayed");
        },
      }),
      "E_NATIVE_COMPOSE_UNCERTAIN"
    );
    await rejected(
      mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => {
          throw new Error("started");
        },
      }),
      "E_NATIVE_COMPOSE_UNCERTAIN"
    );
  });
  const saved = await store(root, null, "saved");
  expect((await saved.loadCurrent()).beforeHooksPending).toBe(true);
  await saved.withMutation(async (mutation) => {
    await mutation.runEffect({
      generation: (await saved.loadCurrent()).generation ?? generation,
      operation: "down",
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
    });
  });
  const after = await saved.loadCurrent();
  expect(after.stopped).toBe(true);
  expect(after.beforeHooksPending).toBe(true);
});

test("host exception and freshness failure after journaling preserve redacted uncertainty", async () => {
  for (const mode of ["effect", "freshness"] as const) {
    const owner = await store(await fixture());
    let checks = 0;
    let effects = 0;
    await owner.withMutation(async (mutation) => {
      await rejected(
        mutation.runBeforeHooks({
          assertFresh: async () => {
            if (++checks === 2 && mode === "freshness") {
              throw new Error("synthetic-private-value");
            }
          },
          effect: async () => {
            effects++;
            throw new Error("synthetic-private-value");
          },
        }),
        "E_NATIVE_COMPOSE_UNCERTAIN"
      );
    });
    expect(effects).toBe(mode === "effect" ? 1 : 0);
    expect((await owner.loadCurrent()).beforeHooksPending).toBe(true);
    expect(await Bun.file(receiptPath(owner)).text()).not.toContain(
      "synthetic-private-value"
    );
  }
});

test("random reservation precedes render; exact immutable document and private receipts survive reopen", async () => {
  const root = await fixture();
  const owner = await store(root);
  const generation = await activate(owner);
  expect(generation.generationId).toMatch(/^[a-f0-9]{32}$/);
  expect(generation.generationId).not.toBe(REVISION.slice(0, 32));
  expect(generation.profiles).toEqual(["dev"]);
  expect((await lstat(generation.composeFile)).mode & 0o777).toBe(0o600);
  expect((await lstat(dirname(generation.composeFile))).mode & 0o777).toBe(
    0o700
  );
  const reopened = await store(root, null, "saved");
  expect(reopened.identity).toEqual(owner.identity);
  const saved = await reopened.loadCurrent();
  expect(saved.stopped).toBe(false);
  expect(saved.generation?.composeFile).toBe(generation.composeFile);
  expect(saved.pending).toBeNull();
  if (!saved.generation) {
    throw new Error("Missing saved fixture generation");
  }
  await reopened.withLease({
    generation: saved.generation,
    run: async (pinned) => {
      const privateDocument = await reopened.readGenerationDocument(pinned);
      expect(privateDocument.name).toBe(generation.identity.composeProject);
      expect(Object.keys(privateDocument.services ?? {})).toEqual(["app"]);
    },
  });
  expect(JSON.stringify(saved)).not.toContain(REVISION);
  expect(JSON.stringify(saved)).not.toContain("synthetic-secret");
  expect(await readdir(dirname(generation.composeFile))).toEqual([
    "compose.json",
    "manifest.json",
  ]);
});

test("generation accepts only the fixed external ingress and never claims it as owned", async () => {
  const root = await fixture();
  const owner = await store(root);
  await owner.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const content = JSON.parse(document(reservation));
    content.networks.ingress = { name: "hack-dev", external: true };
    const generation = await mutation.publish({
      reservation,
      composeJson: JSON.stringify(content),
      profiles: [],
      inputRevision: REVISION,
      assertFresh: async () => {},
    });
    expect(
      (await owner.readGenerationDocument(generation)).networks
    ).toMatchObject({ ingress: { name: "hack-dev", external: true } });
  });
  for (const invalid of [
    { name: "foreign", external: true },
    { name: "hack-dev", external: false },
    { name: "hack-dev", external: true, labels: {} },
  ]) {
    await owner.withMutation(async (mutation) => {
      const reservation = mutation.reserveGeneration();
      const content = JSON.parse(document(reservation));
      content.networks.ingress = invalid;
      await rejected(
        mutation.publish({
          reservation,
          composeJson: JSON.stringify(content),
          profiles: [],
          inputRevision: REVISION,
          assertFresh: async () => {},
        }),
        "E_NATIVE_COMPOSE_STATE"
      );
    });
  }
});

test("complete cold run retains its dependency generation for saved observation and stop", async () => {
  const root = await fixture();
  const owner = await store(root);
  const generation = await owner.withMutation(async (mutation) => {
    const published = await publish(mutation);
    const result = await mutation.runEffect({
      generation: published,
      operation: "run",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 7 }),
    });
    expect(result).toEqual({ outcome: "complete", value: 7 });
    return published;
  });
  const saved = await store(root, null, "saved");
  const current = await saved.loadCurrent();
  expect(current.generation?.generationId).toBe(generation.generationId);
  expect(current.stopped).toBe(false);
  expect(current.pending).toBeNull();
  if (!current.generation) {
    throw new Error("Missing cold-run generation");
  }
  const savedGeneration = current.generation;
  await saved.withMutation((mutation) =>
    mutation.runEffect({
      generation: savedGeneration,
      operation: "down",
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
    })
  );
  expect((await saved.loadCurrent()).stopped).toBe(true);
  expect(await Bun.file(generation.composeFile).exists()).toBe(true);
});

test("run of another generation refuses before effects or intent when current exists", async () => {
  const root = await fixture();
  const owner = await store(root);
  const current = await activate(owner);
  let effects = 0;
  await owner.withMutation(async (mutation) => {
    const other = await publish(mutation);
    await rejected(
      mutation.runEffect({
        generation: other,
        operation: "run",
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => {
          effects += 1;
          return { outcome: "complete", value: 0 };
        },
      }),
      "E_NATIVE_COMPOSE_STATE"
    );
  });
  expect(effects).toBe(0);
  const saved = await owner.loadCurrent();
  expect(saved.generation?.generationId).toBe(current.generationId);
  expect(saved.pending).toBeNull();
});

test("complete run of the saved generation preserves the current anchor", async () => {
  const root = await fixture();
  const owner = await store(root);
  const generation = await activate(owner);
  const before = JSON.parse(await Bun.file(receiptPath(owner)).text()) as {
    current: unknown;
  };
  await owner.withMutation((mutation) =>
    mutation.runEffect({
      generation,
      operation: "run",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
    })
  );
  const after = JSON.parse(await Bun.file(receiptPath(owner)).text()) as {
    current: unknown;
  };
  expect(after.current).toEqual(before.current);
  const current = await owner.loadCurrent();
  expect(current.generation?.generationId).toBe(generation.generationId);
  expect(current.stopped).toBe(false);
  expect(current.pending).toBeNull();
});

test("same authored names use distinct instance projects and files", async () => {
  const root = await fixture();
  const first = await store(root);
  const branch = await store(root, "feature");
  const firstGeneration = await activate(first);
  const branchGeneration = await activate(branch);
  expect(first.identity.composeProject).not.toBe(
    branch.identity.composeProject
  );
  expect(firstGeneration.composeFile).not.toBe(branchGeneration.composeFile);
  await rejected(
    first.withMutation((mutation) =>
      mutation.runEffect({
        generation: branchGeneration,
        operation: "down",
        assertOwned: async () => {},
        effect: async () => ({ outcome: "complete", value: 0 }),
      })
    ),
    "E_NATIVE_COMPOSE_STATE"
  );
  expect((await branch.loadCurrent()).stopped).toBe(false);
});

test("saved observation needs no authored decode or environment access; stop retains generations/data", async () => {
  const root = await fixture();
  const owner = await store(root);
  const generation = await activate(owner);
  await writeFile(join(root, ".hack", "hack.project.json"), "invalid now");
  const marker = join(root, "retained-data");
  await writeFile(marker, "database marker");
  const saved = await store(root, null, "saved");
  const current = (await saved.loadCurrent()).generation;
  expect(current).not.toBeNull();
  if (!current) {
    throw new Error("Missing fixture generation");
  }
  await saved.withMutation((mutation) =>
    mutation.runEffect({
      generation: current,
      operation: "down",
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
    })
  );
  expect((await saved.loadCurrent()).stopped).toBe(true);
  expect(await Bun.file(generation.composeFile).text()).toContain("fixture:1");
  expect(await Bun.file(marker).text()).toBe("database marker");
  await rejected(
    saved.withMutation(async (mutation) => await publish(mutation)),
    "E_NATIVE_COMPOSE_STATE"
  );
});

test("saved open with no receipt creates no runtime directories", async () => {
  const root = await fixture();
  await rejected(
    openNativeComposeGenerationStore({
      projectRoot: root,
      instance: null,
      mode: "saved",
    }),
    "E_NATIVE_COMPOSE_STATE"
  );
  expect(
    await Bun.file(join(root, ".hack", ".internal", "receipt.json")).exists()
  ).toBe(false);
  expect(await readdir(join(root, ".hack"))).toEqual(["hack.project.json"]);
});

test("freshness refusal before publication/effect produces no engine callback", async () => {
  const owner = await store(await fixture());
  let effects = 0;
  await rejected(
    owner.withMutation((mutation) =>
      publish(mutation, async () => {
        throw new Error("synthetic-secret");
      })
    ),
    "E_NATIVE_COMPOSE_STALE"
  );
  await owner.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    await rejected(
      mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {
          throw new Error("changed");
        },
        assertOwned: async () => {},
        effect: async () => {
          effects += 1;
          return { outcome: "complete", value: 0 };
        },
      }),
      "E_NATIVE_COMPOSE_STALE"
    );
  });
  expect(effects).toBe(0);
  expect((await owner.loadCurrent()).pending).toBeNull();
});

test("publication interrupted after immutable files cannot become current or overwrite a successor", async () => {
  const owner = await store(await fixture());
  let checks = 0;
  await rejected(
    owner.withMutation((mutation) =>
      publish(mutation, async () => {
        checks += 1;
        if (checks === 2) {
          throw new Error("changed");
        }
      })
    ),
    "E_NATIVE_COMPOSE_STALE"
  );
  expect((await owner.loadCurrent()).generation).toBeNull();
  const generations = join(dirname(receiptPath(owner)), "generations");
  const abandoned = await readdir(generations);
  expect(abandoned).toHaveLength(1);
  await activate(owner);
  expect(await readdir(generations)).toHaveLength(2);
  expect(
    await Bun.file(
      join(generations, abandoned[0] ?? "missing", "compose.json")
    ).exists()
  ).toBe(true);
});

test("failed Compose outcome stays uncertain and cannot be silently replayed", async () => {
  const owner = await store(await fixture());
  let generation: NativeComposeGeneration | undefined;
  await owner.withMutation(async (mutation) => {
    generation = await publish(mutation);
    expect(
      await mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => ({ outcome: "uncertain", value: 1 }),
      })
    ).toEqual({ outcome: "uncertain", value: 1 });
  });
  expect((await owner.loadCurrent()).pending?.operation).toBe("up");
  expect((await owner.loadPending())?.generationId).toBe(
    generation?.generationId
  );
  await rejected(
    owner.withMutation((mutation) => publish(mutation)),
    "E_NATIVE_COMPOSE_UNCERTAIN"
  );
});

test("thrown effect is redacted; explicit saved owned down can reconcile pending without freshness", async () => {
  const root = await fixture();
  const owner = await store(root);
  await rejected(
    owner.withMutation(async (mutation) => {
      const generation = await publish(mutation);
      await mutation.runEffect({
        generation,
        operation: "run",
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => {
          throw new Error("synthetic-secret");
        },
      });
    }),
    "E_NATIVE_COMPOSE_UNCERTAIN"
  );
  await writeFile(join(root, ".hack", "hack.project.json"), "invalid");
  const saved = await store(root, null, "saved");
  const pending = await saved.loadPending();
  if (!pending) {
    throw new Error("Missing pending generation");
  }
  let stops = 0;
  await saved.withMutation((mutation) =>
    mutation.runEffect({
      generation: pending,
      operation: "down",
      recoverPending: true,
      assertOwned: async () => {},
      effect: async () => {
        stops += 1;
        expect((await saved.loadCurrent()).pending?.recoveryToken).toMatch(
          /^[a-f0-9]{32}$/
        );
        return { outcome: "complete", value: 0 };
      },
    })
  );
  expect(stops).toBe(1);
  expect((await saved.loadCurrent()).pending).toBeNull();
  expect(await Bun.file(pending.composeFile).exists()).toBe(true);
});

test("failed recovery preserves the original pending generation", async () => {
  const owner = await store(await fixture());
  await owner.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    await mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => ({ outcome: "uncertain", value: 1 }),
    });
  });
  const generation = await owner.loadPending();
  if (!generation) {
    throw new Error("Missing pending generation");
  }
  await owner.withMutation((mutation) =>
    mutation.runEffect({
      generation,
      operation: "down",
      recoverPending: true,
      assertOwned: async () => {},
      effect: async () => ({ outcome: "uncertain", value: 1 }),
    })
  );
  expect((await owner.loadCurrent()).pending?.operation).toBe("up");
  expect((await owner.loadCurrent()).pending?.generationId).toBe(
    generation.generationId
  );
});

test("second freshness failure after journaling preserves intent and invokes no effect", async () => {
  const owner = await store(await fixture());
  let checks = 0;
  let effects = 0;
  await rejected(
    owner.withMutation(async (mutation) => {
      const generation = await publish(mutation);
      await mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {
          checks += 1;
          if (checks === 2) {
            throw new Error("changed");
          }
        },
        assertOwned: async () => {},
        effect: async () => {
          effects += 1;
          return { outcome: "complete", value: 0 };
        },
      });
    }),
    "E_NATIVE_COMPOSE_UNCERTAIN"
  );
  expect(effects).toBe(0);
  expect((await owner.loadCurrent()).pending?.operation).toBe("up");
});

test("lease pins old generation while a successor publishes; observations work while mutation is busy", async () => {
  const root = await fixture();
  const owner = await store(root);
  const old = await activate(owner);
  const saved = await store(root, null, "saved");
  await owner.withLease({
    generation: old,
    run: async (pinned) => {
      const leases = join(dirname(receiptPath(owner)), "leases");
      expect(await readdir(leases)).toHaveLength(1);
      await owner.withMutation(async (mutation) => {
        expect((await saved.loadCurrent()).generation?.generationId).toBe(
          old.generationId
        );
        await rejected(
          saved.withMutation(async () => {}),
          "E_NATIVE_COMPOSE_BUSY"
        );
        const next = await publish(mutation);
        await mutation.runEffect({
          generation: next,
          operation: "restart",
          assertFresh: async () => {},
          assertOwned: async () => {},
          effect: async () => ({ outcome: "complete", value: 0 }),
        });
        expect(next.generationId).not.toBe(pinned.generationId);
      });
      expect(await Bun.file(pinned.composeFile).exists()).toBe(true);
    },
  });
  expect(
    await readdir(join(dirname(receiptPath(owner)), "leases"))
  ).toHaveLength(0);
  expect(await Bun.file(old.composeFile).exists()).toBe(true);
});

test("parallel operations inside one mutation refuse before double application", async () => {
  const owner = await store(await fixture());
  await owner.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    let finish: (() => void) | undefined;
    const held = new Promise<void>((resolveDone) => {
      finish = resolveDone;
    });
    const first = mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => {
        await held;
        return { outcome: "complete", value: 0 };
      },
    });
    await rejected(
      mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => ({ outcome: "complete", value: 0 }),
      }),
      "E_NATIVE_COMPOSE_BUSY"
    );
    finish?.();
    await first;
  });
});

for (const mutation of [
  "symlink",
  "hardlink",
  "permissions",
  "content",
  "replacement",
] as const) {
  test(`document ${mutation} tamper refuses before effect`, async () => {
    const owner = await store(await fixture());
    const generation = await activate(owner);
    const path = generation.composeFile;
    if (mutation === "symlink") {
      await rename(path, `${path}.old`);
      await symlink(`${path}.old`, path);
    }
    if (mutation === "hardlink") {
      await link(path, `${path}.linked`);
    }
    if (mutation === "permissions") {
      await chmod(path, 0o644);
    }
    if (mutation === "content") {
      await writeFile(path, "{}", { mode: 0o600 });
    }
    if (mutation === "replacement") {
      const text = await Bun.file(path).text();
      await unlink(path);
      await writeFile(path, text, { mode: 0o600 });
    }
    let effects = 0;
    await rejected(
      owner.withMutation((context) =>
        context.runEffect({
          generation,
          operation: "down",
          assertOwned: async () => {},
          effect: async () => {
            effects += 1;
            return { outcome: "complete", value: 0 };
          },
        })
      ),
      "E_NATIVE_COMPOSE_STATE"
    );
    expect(effects).toBe(0);
  });
}

test("manifest replacement/changed digest is rejected by saved receipt anchor", async () => {
  const root = await fixture();
  const owner = await store(root);
  const generation = await activate(owner);
  const path = join(dirname(generation.composeFile), "manifest.json");
  const original = await Bun.file(path).text();
  await unlink(path);
  await writeFile(path, original, { mode: 0o600 });
  const saved = await store(root, null, "saved");
  await rejected(saved.loadCurrent(), "E_NATIVE_COMPOSE_STATE");
});

for (const changed of [
  "version",
  "extra",
  "instance",
  "private-hash",
] as const) {
  test(`receipt ${changed} tamper is refused`, async () => {
    const root = await fixture();
    const owner = await store(root);
    await activate(owner);
    const path = receiptPath(owner);
    const value: Record<string, unknown> = JSON.parse(
      await Bun.file(path).text()
    );
    if (changed === "version") {
      value.version = 2;
    }
    if (changed === "extra") {
      value.extra = "invented";
    }
    if (changed === "instance") {
      value.identity = { ...owner.identity, instance: "other" };
    }
    if (changed === "private-hash") {
      value.current = {
        generationId: "a".repeat(32),
        manifestHash: "secret",
        manifest: { dev: 1, ino: 1 },
      };
    }
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await rejected(owner.loadCurrent(), "E_NATIVE_COMPOSE_STATE");
  });
}

test("private directory rebound after preparation cannot authorize an effect", async () => {
  const root = await fixture();
  const owner = await store(root);
  const generation = await activate(owner);
  const privateRoot = join(root, ".hack", ".internal", "native-compose");
  await rename(privateRoot, `${privateRoot}.old`);
  await symlink(`${privateRoot}.old`, privateRoot);
  let effects = 0;
  await rejected(
    owner.withMutation((mutation) =>
      mutation.runEffect({
        generation,
        operation: "down",
        assertOwned: async () => {},
        effect: async () => {
          effects += 1;
          return { outcome: "complete", value: 0 };
        },
      })
    ),
    "E_NATIVE_COMPOSE_STATE"
  );
  expect(effects).toBe(0);
});

test("wrong reservation and forged generation/labels never reach an effect", async () => {
  const owner = await store(await fixture());
  await owner.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    await rejected(
      mutation.publish({
        reservation: { ...reservation },
        composeJson: document(reservation),
        profiles: [],
        inputRevision: REVISION,
        assertFresh: async () => {},
      }),
      "E_NATIVE_COMPOSE_STATE"
    );
    const altered = JSON.parse(document(reservation));
    altered.services.app.labels["io.hack.native-config.generation"] =
      "b".repeat(32);
    await rejected(
      mutation.publish({
        reservation,
        composeJson: JSON.stringify(altered),
        profiles: [],
        inputRevision: REVISION,
        assertFresh: async () => {},
      }),
      "E_NATIVE_COMPOSE_STATE"
    );
    const generation = await publish(mutation);
    await rejected(
      mutation.runEffect({
        generation: { ...generation },
        operation: "down",
        assertOwned: async () => {},
        effect: async () => ({ outcome: "complete", value: 0 }),
      }),
      "E_NATIVE_COMPOSE_STATE"
    );
  });
});

test("mixed inputs and symlinked checkout refuse without creating managed state", async () => {
  const root = await fixture();
  await writeFile(join(root, ".hack", "docker-compose.yml"), "services: {}");
  await rejected(
    openNativeComposeGenerationStore({ projectRoot: root, instance: null }),
    "E_NATIVE_COMPOSE_STATE"
  );
  await unlink(join(root, ".hack", "docker-compose.yml"));
  const alias = `${root}-alias`;
  await symlink(root, alias);
  await rejected(
    openNativeComposeGenerationStore({ projectRoot: alias, instance: null }),
    "E_NATIVE_COMPOSE_STATE"
  );
  expect(await readdir(join(root, ".hack"))).toEqual(["hack.project.json"]);
});

async function interruptedWriter(root: string, hooks = false) {
  const source = join(
    import.meta.dir,
    "../src/lib/native-compose-generation.ts"
  );
  const engineProgram = [
    `import { openNativeComposeGenerationStore } from ${JSON.stringify(source)};`,
    "const owner = await openNativeComposeGenerationStore({ projectRoot: process.env.NC03_FIXTURE_ROOT, instance: null });",
    "await owner.withMutation(async (m) => {",
    "const reservation = m.reserveGeneration();",
    'const labels = { "io.hack.native-config.version": "1", "io.hack.native-config.instance": reservation.identity.composeProject, "io.hack.native-config.owner": reservation.identity.ownerToken, "io.hack.native-config.generation": reservation.generationId, "io.hack.native-config.workload": "service" };',
    'const generation = await m.publish({ reservation, composeJson: JSON.stringify({name: reservation.identity.composeProject, services: { app: { image: "fixture:1", labels } }}), profiles: [], inputRevision: "a".repeat(64), assertFresh: async () => {} });',
    'await m.runEffect({ generation, operation: "up", assertFresh: async () => {}, assertOwned: async () => {}, effect: async () => {',
    'process.stdout.write("pending\\n");',
    "await new Promise(() => { setInterval(() => {}, 60000); });",
    'return { outcome: "complete", value: 0 }; }}); });',
  ].join("\n");
  const hookProgram = [
    `import { openNativeComposeGenerationStore } from ${JSON.stringify(source)};`,
    "const owner = await openNativeComposeGenerationStore({ projectRoot: process.env.NC03_FIXTURE_ROOT, instance: null });",
    "await owner.withMutation(async (m) => { await m.runBeforeHooks({ assertFresh: async () => {}, effect: async () => {",
    'process.stdout.write("pending\\n");',
    "await new Promise(() => { setInterval(() => {}, 60000); });",
    'return { outcome: "complete", value: 0 }; }}); });',
  ].join("\n");
  const program = hooks ? hookProgram : engineProgram;
  const child = Bun.spawn([process.execPath, "--eval", program], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NC03_FIXTURE_ROOT: root },
  });
  children.push(child);
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const reader = child.stdout.getReader();
  try {
    const read = await reader.read();
    if (read.done || new TextDecoder().decode(read.value) !== "pending\n") {
      throw new Error(
        `Fixture writer did not reach durable intent: ${await new Response(child.stderr).text()}`
      );
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  return child;
}

test("SIGKILL before a hook PID is published leaves durable intent that dead-lock recovery cannot replay", async () => {
  const root = await fixture();
  const child = await interruptedWriter(root, true);
  child.kill("SIGKILL");
  await child.exited;
  const saved = await store(root, null, "saved");
  await saved.recoverInterruptedLock();
  const owner = await store(root);
  const current = await owner.loadCurrent();
  expect(current.generation).toBeNull();
  expect(current.beforeHooksPending).toBe(true);
  await owner.withMutation(async (mutation) => {
    await rejected(
      mutation.runBeforeHooks({
        assertFresh: async () => {},
        effect: async () => {
          throw new Error("must not replay");
        },
      }),
      "E_NATIVE_COMPOSE_UNCERTAIN"
    );
  });
});

test("SIGKILL leaves durable intent; explicit same-boot dead-owner recovery unblocks retaining stop", async () => {
  const root = await fixture();
  const child = await interruptedWriter(root);
  const saved = await store(root, null, "saved");
  const generation = await saved.loadPending();
  if (!generation) {
    throw new Error("Missing killed writer generation");
  }
  await rejected(saved.recoverInterruptedLock(), "E_NATIVE_COMPOSE_BUSY");
  await rejected(
    saved.withMutation(async () => {}),
    "E_NATIVE_COMPOSE_BUSY"
  );
  child.kill("SIGKILL");
  await child.exited;
  expect((await saved.loadCurrent()).pending?.operation).toBe("up");
  await rejected(
    saved.withMutation(async () => {}),
    "E_NATIVE_COMPOSE_BUSY"
  );
  await saved.recoverInterruptedLock();
  expect((await saved.loadCurrent()).pending?.generationId).toBe(
    generation.generationId
  );
  await rejected(
    saved.withMutation(async (mutation) => {
      await mutation.runEffect({
        generation,
        operation: "down",
        assertOwned: async () => {},
        effect: async () => ({ outcome: "complete", value: 0 }),
      });
    }),
    "E_NATIVE_COMPOSE_UNCERTAIN"
  );
  await saved.withMutation((mutation) =>
    mutation.runEffect({
      generation,
      operation: "down",
      recoverPending: true,
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
    })
  );
  expect((await saved.loadCurrent()).pending).toBeNull();
  expect(await Bun.file(generation.composeFile).exists()).toBe(true);
});

for (const unsafe of [
  "empty-owner",
  "wrong-boot",
  "unknown-birth",
  "symlink-owner",
  "recovery-guard",
] as const) {
  test(`explicit dead-lock recovery refuses ${unsafe}`, async () => {
    const root = await fixture();
    const child = await interruptedWriter(root);
    child.kill("SIGKILL");
    await child.exited;
    const saved = await store(root, null, "saved");
    const lock = join(dirname(receiptPath(saved)), "mutation.lock");
    const ownerPath = join(lock, "owner");
    if (unsafe === "empty-owner") {
      await writeFile(ownerPath, "", { mode: 0o600 });
    }
    if (unsafe === "wrong-boot" || unsafe === "unknown-birth") {
      const receipt = JSON.parse(await Bun.file(ownerPath).text());
      if (unsafe === "wrong-boot") {
        receipt.bootId = "00000000-0000-0000-0000-000000000000";
      } else {
        receipt.birth = null;
      }
      await writeFile(ownerPath, JSON.stringify(receipt), { mode: 0o600 });
    }
    if (unsafe === "symlink-owner") {
      await rename(ownerPath, `${ownerPath}.old`);
      await symlink(`${ownerPath}.old`, ownerPath);
    }
    if (unsafe === "recovery-guard") {
      await mkdir(join(dirname(lock), "recovery.lock"), { mode: 0o700 });
    }
    await expect(saved.recoverInterruptedLock()).rejects.toThrow();
    expect(await readdir(dirname(lock))).toContain("mutation.lock");
    expect((await saved.loadCurrent()).pending?.operation).toBe("up");
  });
}

test("real linked worktree verifies shared repository but keeps checkout instance/data namespace separate", async () => {
  const root = await fixture();
  const git = async (args: readonly string[]) => {
    const child = Bun.spawn(["git", "-C", root, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
  };
  await git(["init", "-q"]);
  await git(["add", ".hack/hack.project.json"]);
  await git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const linkedRoot = join(dirname(root), "linked");
  await git(["worktree", "add", "-q", "-b", "feature", linkedRoot]);
  const primary = await store(root);
  const linked = await store(linkedRoot, "feature");
  expect(primary.identity.repositoryRoot).toBe(linked.identity.repositoryRoot);
  expect(primary.identity.checkoutRoot).not.toBe(linked.identity.checkoutRoot);
  expect(primary.identity.composeProject).not.toBe(
    linked.identity.composeProject
  );
  const primaryGeneration = await activate(primary);
  const linkedGeneration = await activate(linked);
  expect(primaryGeneration.composeFile).not.toBe(linkedGeneration.composeFile);
});

test("orphan recovery guard with absent mutation lock blocks admission and explicit recovery", async () => {
  const root = await fixture();
  const owner = await store(root);
  await activate(owner);
  const guard = join(dirname(receiptPath(owner)), "recovery.lock");
  await mkdir(guard, { mode: 0o700 });
  await rejected(
    owner.withMutation(async () => {}),
    "E_NATIVE_COMPOSE_BUSY"
  );
  await rejected(owner.recoverInterruptedLock(), "E_NATIVE_COMPOSE_BUSY");
  const saved = await store(root, null, "saved");
  expect((await saved.loadCurrent()).generation).not.toBeNull();
  expect(await readdir(dirname(guard))).toContain("recovery.lock");
});

test("checkout configuration directory replacement refuses saved rebinding", async () => {
  const root = await fixture();
  const owner = await store(root);
  await activate(owner);
  const old = join(root, ".hack.old");
  await rename(join(root, ".hack"), old);
  await mkdir(join(root, ".hack"));
  await rename(join(old, ".internal"), join(root, ".hack", ".internal"));
  await writeFile(join(root, ".hack", "hack.project.json"), "{}");
  await rejected(
    openNativeComposeGenerationStore({
      projectRoot: root,
      instance: null,
      mode: "saved",
    }),
    "E_NATIVE_COMPOSE_STATE"
  );
});

test("owner label cannot adopt a replaced store's retained namespace", async () => {
  const owner = await store(await fixture());
  await owner.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const value = JSON.parse(document(reservation));
    value.volumes.data.labels["io.hack.native-config.owner"] = "b".repeat(32);
    await rejected(
      mutation.publish({
        reservation,
        composeJson: JSON.stringify(value),
        profiles: [],
        inputRevision: REVISION,
        assertFresh: async () => {},
      }),
      "E_NATIVE_COMPOSE_STATE"
    );
  });
});

test("reserved workload discriminator accepts jobs without inferring readiness", async () => {
  const owner = await store(await fixture());
  const generation = await owner.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const value = JSON.parse(document(reservation));
    value.services.app.labels["io.hack.native-config.workload"] = "job";
    return await mutation.publish({
      reservation,
      composeJson: JSON.stringify(value),
      profiles: [],
      inputRevision: REVISION,
      assertFresh: async () => {},
    });
  });
  await owner.withLease({
    generation,
    run: async (pinned) => {
      expect(await owner.readGenerationDocument(pinned)).toMatchObject({
        services: {
          app: { labels: { "io.hack.native-config.workload": "job" } },
        },
      });
    },
  });
  expect((await owner.loadCurrent()).generation).toBeNull();
});

test("private artifact ignore is created and rebinding refuses effects", async () => {
  const owner = await store(await fixture());
  const generation = await activate(owner);
  const ignore = join(dirname(dirname(receiptPath(owner))), ".gitignore");
  expect(await Bun.file(ignore).text()).toBe("*\n");
  await writeFile(ignore, "!x", { mode: 0o600 });
  await rejected(
    owner.withMutation((mutation) =>
      mutation.runEffect({
        generation,
        operation: "down",
        assertOwned: async () => {},
        effect: async () => ({ outcome: "complete", value: 0 }),
      })
    ),
    "E_NATIVE_COMPOSE_STATE"
  );
});

test("ownership callback failure is redacted and leaves no engine intent", async () => {
  const owner = await store(await fixture());
  await owner.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    await rejected(
      mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {
          throw new Error("synthetic-secret");
        },
        effect: async () => ({ outcome: "complete", value: 0 }),
      }),
      "E_NATIVE_COMPOSE_STATE"
    );
  });
  expect((await owner.loadCurrent()).pending).toBeNull();
});

for (const unsafe of [
  "primitive",
  "missing-label",
  "missing-workload",
  "unknown-workload",
  "duplicate-profile",
  "revision",
  "oversized",
] as const) {
  test(`publication rejects ${unsafe} before private generation files`, async () => {
    const owner = await store(await fixture());
    await owner.withMutation(async (mutation) => {
      const reservation = mutation.reserveGeneration();
      let composeJson = document(reservation);
      if (unsafe === "primitive") {
        composeJson = "null";
      }
      if (unsafe === "missing-label") {
        const value = JSON.parse(composeJson);
        value.services.app.labels["io.hack.native-config.instance"] = undefined;
        composeJson = JSON.stringify(value);
      }
      if (unsafe === "missing-workload" || unsafe === "unknown-workload") {
        const value = JSON.parse(composeJson);
        value.services.app.labels["io.hack.native-config.workload"] =
          unsafe === "missing-workload" ? undefined : "worker";
        composeJson = JSON.stringify(value);
      }
      if (unsafe === "oversized") {
        composeJson = document(reservation, "x".repeat(8 * 1024 * 1024));
      }
      await rejected(
        mutation.publish({
          reservation,
          composeJson,
          profiles: unsafe === "duplicate-profile" ? ["dev", "dev"] : [],
          inputRevision: unsafe === "revision" ? "invalid" : REVISION,
          assertFresh: async () => {},
        }),
        "E_NATIVE_COMPOSE_STATE"
      );
    });
    expect(
      await readdir(join(dirname(receiptPath(owner)), "generations"))
    ).toHaveLength(0);
  });
}
