import { expect, spyOn, test } from "bun:test";
import { emitOpenOrigin } from "../src/commands/project.ts";

test("open refuses a confirmed loopback failure before JSON or browser output", async () => {
  for (const json of [true, false]) {
    const write = spyOn(process.stdout, "write");
    try {
      await expect(
        emitOpenOrigin({
          url: "https://app.example.test",
          json,
          origin: "compose",
          checkLoopback: async () =>
            "port 443 on loopback is not reaching the Hack proxy",
        })
      ).rejects.toMatchObject({
        code: "E_GLOBAL_INFRA_DOWN",
        message: "port 443 on loopback is not reaching the Hack proxy",
      });
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  }
});

test("native loopback origin bypasses Compose DNS, Docker and CA probes even if a proxy failure would be reported", async () => {
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  let checks = 0;
  try {
    expect(
      await emitOpenOrigin({
        url: "https://127.0.0.1",
        json: true,
        origin: "native",
        checkLoopback: async () => {
          checks += 1;
          return "port 443 on loopback is not reaching the Hack proxy";
        },
      })
    ).toBe(0);
    expect(checks).toBe(0);
    expect(write).toHaveBeenCalledWith(
      `${JSON.stringify({ url: "https://127.0.0.1" }, null, 2)}\n`
    );
  } finally {
    write.mockRestore();
  }
});

test("open keeps the URL and adds a DNS hint when the host has no address", async () => {
  const hint = "app.example.test has no address on this machine";
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect(
      await emitOpenOrigin({
        url: "https://app.example.test",
        json: true,
        origin: "compose",
        checkLoopback: async () => null,
        checkResolution: async () => hint,
      })
    ).toBe(0);
    expect(write).toHaveBeenCalledWith(
      `${JSON.stringify(
        { url: "https://app.example.test", dns: "unresolved", hint },
        null,
        2
      )}\n`
    );
    write.mockClear();
    // A host that resolves keeps the exact earlier JSON shape.
    expect(
      await emitOpenOrigin({
        url: "https://app.example.test",
        json: true,
        origin: "compose",
        checkLoopback: async () => null,
        checkResolution: async () => null,
      })
    ).toBe(0);
    expect(write).toHaveBeenCalledWith(
      `${JSON.stringify({ url: "https://app.example.test" }, null, 2)}\n`
    );
  } finally {
    write.mockRestore();
  }
});
