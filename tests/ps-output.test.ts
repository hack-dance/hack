import { expect, test } from "bun:test";
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
