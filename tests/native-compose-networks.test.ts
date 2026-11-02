import { expect, test } from "bun:test";
import {
  NativeComposeRenderError,
  renderNativeCompose,
} from "../src/lib/native-compose-renderer.ts";
import { composeFixture } from "./helpers/native-compose.ts";

function topology() {
  const input = composeFixture({
    services: {
      web: {
        image: "fixture/web:1",
        networks: { default: {}, private: { aliases: ["frontend"] } },
      },
      db: {
        image: "fixture/db:1",
        networks: { private: { aliases: ["database"] } },
      },
    },
  });
  input.plan.networks = {
    private: { internal: true },
    unused: { internal: false },
  };
  return input;
}

test("authored bridges preserve internal policy, exact attachments and aliases without unused allocation", () => {
  const input = topology();
  const document = renderNativeCompose(input).document;
  expect(Object.keys(document.networks).sort()).toEqual(["default", "private"]);
  expect(document.networks.private).toEqual({
    name: "hack-net-14-nc03-fixture-a-7-private",
    driver: "bridge",
    internal: true,
    labels: {
      "io.hack.native-config.version": "1",
      "io.hack.native-config.instance": input.runtimeIdentity,
      "io.hack.native-config.owner": input.ownerToken,
    },
  });
  expect(document.services.web?.networks).toEqual({
    default: {},
    private: { aliases: ["frontend"] },
  });
  expect(document.services.db?.networks).toEqual({
    private: { aliases: ["database"] },
  });
});

test("custom-only attachments do not silently add an outbound default bridge", () => {
  const input = topology();
  input.plan.services.web!.networks = { private: {} };
  const document = renderNativeCompose(input).document;
  expect(Object.keys(document.networks)).toEqual(["private"]);
  expect(document.services.web?.networks).toEqual({ private: {} });
});

test("custom bridge names remain disjoint across worktree identities and ambiguous concatenations", () => {
  const a = topology(),
    b = structuredClone(a);
  b.runtimeIdentity = "nc03-fixture-b";
  expect(renderNativeCompose(a).document.networks.private?.name).not.toBe(
    renderNativeCompose(b).document.networks.private?.name
  );
  a.runtimeIdentity = "runtime_a";
  a.plan.networks = { b: { internal: false } };
  a.plan.services.web!.networks = { b: {} };
  a.plan.services.db!.networks = { b: {} };
  b.runtimeIdentity = "runtime";
  b.plan.networks = { a_b: { internal: false } };
  b.plan.services.web!.networks = { a_b: {} };
  b.plan.services.db!.networks = { a_b: {} };
  expect(renderNativeCompose(a).document.networks.b?.name).not.toBe(
    renderNativeCompose(b).document.networks.a_b?.name
  );
});

test("forged plan topology refuses before private value delivery with a fixed error", () => {
  for (const mutate of [
    (input: ReturnType<typeof topology>) => {
      Object.assign(input.plan.networks!, {
        private: { internal: true, external: true },
      });
    },
    (input: ReturnType<typeof topology>) => {
      Object.assign(input.plan.networks!, {
        private: { internal: "private-network-canary" },
      });
    },
    (input: ReturnType<typeof topology>) => {
      Object.assign(input.plan.networks!, { default: { internal: true } });
    },
    (input: ReturnType<typeof topology>) => {
      Object.assign(input.plan.services.web!, { networks: {} });
    },
    (input: ReturnType<typeof topology>) => {
      Object.assign(input.plan.services.web!, { networks: { missing: {} } });
    },
    (input: ReturnType<typeof topology>) => {
      Object.assign(input.plan.services.web!, {
        networks: { private: { ipv4_address: "127.0.0.1" } },
      });
    },
    (input: ReturnType<typeof topology>) => {
      Object.assign(input.plan.services.web!, {
        networks: { private: { aliases: ["db"] } },
      });
    },
    (input: ReturnType<typeof topology>) => {
      Object.assign(input.plan.services.web!, {
        networks: { private: { aliases: ["duplicate", "duplicate"] } },
      });
    },
    (input: ReturnType<typeof topology>) => {
      input.plan.services.db!.networks = { private: { aliases: ["frontend"] } };
    },
  ]) {
    const input = topology();
    mutate(input);
    let valuesRead = false;
    try {
      renderNativeCompose({
        ...input,
        get managedValues() {
          valuesRead = true;
          throw new Error("private-network-canary");
        },
      });
      throw new Error("unexpected render success");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(NativeComposeRenderError);
      expect(String(error)).not.toContain("private-network-canary");
    }
    expect(valuesRead).toBe(false);
  }
});

test("service endpoints refuse a forged disconnected target and accept a shared bridge", () => {
  const input = topology();
  input.plan.services.web!.environment = {
    API: {
      endpoint: { kind: "service", name: "db", port: 8080, protocol: "http" },
    },
  };
  input.environmentPlan.workloads.web = {
    API: {
      kind: "endpoint",
      reference: { kind: "service", name: "db", port: 8080, protocol: "http" },
      target: { kind: "service", name: "db", port: 8080, protocol: "http" },
    },
  };
  expect(renderNativeCompose(input).document.services.web?.environment).toEqual(
    { API: "http://db:8080" }
  );
  input.plan.services.web!.networks = { default: {} };
  expect(() => renderNativeCompose(input)).toThrow(NativeComposeRenderError);
});

test("normalized internal policy must be an own data field, never inherited or a getter", () => {
  let getterReads = 0;
  for (const value of [
    Object.create({ internal: false }),
    {
      get internal() {
        getterReads++;
        throw new Error("private-network-canary");
      },
    },
  ]) {
    const input = topology();
    input.plan.networks!.private = value;
    expect(() => renderNativeCompose(input)).toThrow(NativeComposeRenderError);
  }
  expect(getterReads).toBe(0);
});

test("canonical own constructor keys survive topology rendering without prototype fallback", () => {
  const input = topology();
  input.plan.networks = { constructor: { internal: false } };
  input.plan.services.web!.networks = {
    constructor: { aliases: ["frontend"] },
  };
  input.plan.services.db!.networks = { constructor: {} };
  const document = renderNativeCompose(input).document;
  expect(Object.hasOwn(document.networks, "constructor")).toBe(true);
  expect(
    Object.hasOwn(document.services.web!.networks as object, "constructor")
  ).toBe(true);
  expect(Object.keys(document.networks)).toEqual(["constructor"]);
});
