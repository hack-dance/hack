import { expect, spyOn, test } from "bun:test";
import { JSON_COMMAND_SHAPES } from "../src/cli/json-contracts.ts";
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
  expect(JSON_COMMAND_SHAPES.open).toBe("legacy-object");
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

test("open keeps the URL and adds the DNS notice; a resolving host keeps the exact earlier JSON", async () => {
  const hint = "app.example.test has no address on this machine";
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    for (const dns of ["unresolved", "unconfigured"] as const) {
      write.mockClear();
      expect(
        await emitOpenOrigin({
          url: "https://app.example.test",
          json: true,
          origin: "compose",
          checkLoopback: async () => null,
          checkResolution: async () => ({ dns, hint }),
        })
      ).toBe(0);
      expect(write).toHaveBeenCalledWith(
        `${JSON.stringify(
          { url: "https://app.example.test", dns, hint },
          null,
          2
        )}\n`
      );
    }
    write.mockClear();
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

test("a native origin with a hostname never runs the DNS check", async () => {
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  let checks = 0;
  try {
    expect(
      await emitOpenOrigin({
        url: "https://app.example.test",
        json: true,
        origin: "native",
        checkLoopback: async () => null,
        checkResolution: async () => {
          checks += 1;
          return { dns: "unresolved", hint: "must not be used" };
        },
      })
    ).toBe(0);
    expect(checks).toBe(0);
    expect(write).toHaveBeenCalledWith(
      `${JSON.stringify({ url: "https://app.example.test" }, null, 2)}\n`
    );
  } finally {
    write.mockRestore();
  }
});

test("with no URL opener (a server or sandbox) stdout is exactly the URL and notes go to stderr", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const writeErr = spyOn(process.stderr, "write").mockImplementation(
    (chunk) => {
      err.push(String(chunk));
      return true;
    }
  );
  try {
    expect(
      await emitOpenOrigin({
        url: "https://hello.hack",
        json: false,
        origin: "compose",
        checkLoopback: async () => null,
        checkResolution: async () => ({
          dns: "unresolved",
          hint: "hello.hack has no address on this machine",
        }),
        openerAvailable: () => false,
      })
    ).toBe(0);
    expect(out).toEqual(["https://hello.hack\n"]);
    expect(err.join("")).toContain("hello.hack has no address on this machine");
    expect(err.join("")).toContain("No program to open URLs");
  } finally {
    write.mockRestore();
    writeErr.mockRestore();
  }
});
