import { expect, test } from "bun:test";
import { scopedHackCommand } from "../src/lib/printed-shell-command.ts";
import { psServiceState, renderPs } from "../src/ui/ps-output.ts";
import { createTextOutput } from "../src/ui/text-output.ts";

test("ps uses service columns and a count in both layouts", () => {
  const rows = [
    {
      service: "db",
      state: psServiceState({ state: "Running", health: "Healthy" }),
      address: null,
      remote: {
        kind: "remote",
        use: "qa",
        pointsAt: "$REMOTE_DB_HOST:5432",
        via: "tunnel",
      },
    },
  ];
  const lines: string[] = [];
  const output = createTextOutput({
    tty: false,
    write: (text) => lines.push(text),
  });
  renderPs({ rows, output });
  expect(lines.join("")).toBe(
    "SERVICE  ADDRESS     STATE\ndb       no address  healthy\n\n1 service\n"
  );
  lines.length = 0;
  renderPs({ rows, output, hasRemotes: true });
  expect(lines.join("")).toBe(
    "SERVICE  KIND    USE  POINTS AT             VIA     STATE\ndb       remote  qa   $REMOTE_DB_HOST:5432  tunnel  healthy\n\n1 service\n"
  );
});

test("a known empty service list ends with a start hint", () => {
  const lines: string[] = [];
  const output = createTextOutput({
    tty: false,
    write: (text) => lines.push(text),
  });
  renderPs({ rows: [], output, hintWhenEmpty: true });
  expect(lines.join("")).toBe(
    "SERVICE  ADDRESS  STATE\n\n0 services\nnothing running. try: hack up\n"
  );
});

test("replicas are named and multiple routes stay copyable", () => {
  const chunks: string[] = [];
  const output = createTextOutput({
    tty: false,
    write: (line) => {
      chunks.push(line);
    },
  });
  const row = {
    service: "web",
    state: "running",
    address: null,
    addresses: ["http://sample.hack.local", "https://secure.sample.hack.local"],
  };
  renderPs({ rows: [row, { ...row, state: "exited (1)" }], output });
  expect(chunks.join("")).toContain("web (1/2)  http://sample.hack.local +1");
  expect(chunks.join("")).toContain("web (2/2)  http://sample.hack.local +1");
  expect(chunks.join("")).toEndWith("\n1 service\n");
  chunks.length = 0;
  renderPs({ rows: [row], wide: true, output });
  expect(chunks.join("")).toContain(
    "http://sample.hack.local, https://secure.sample.hack.local"
  );
});

test("running services without health probes keep their lifecycle state", () => {
  expect(psServiceState({ state: "running", health: "none" })).toBe("running");
});

test("recovery commands keep leading dashes inside their option value", () => {
  expect(scopedHackCommand("down", { path: "-leading" })).toBe(
    "hack down --path=-leading"
  );
});
