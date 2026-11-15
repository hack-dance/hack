import { renderJsonInventory } from "../src/cli/json-reference.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import { machineOutputFixtures } from "./lib/machine-output-fixtures.ts";

const path = new URL(
  "../docs/reference/machine-readable-output.md",
  import.meta.url
);
const text = await Bun.file(path).text();
const start = "<!-- json-inventory:start -->";
const end = "<!-- json-inventory:end -->";
if (
  text.split(start).length !== 2 ||
  text.split(end).length !== 2 ||
  text.indexOf(end) <= text.indexOf(start)
) {
  throw new Error("Machine output inventory markers must occur once, in order");
}
const next = `${text.slice(0, text.indexOf(start) + start.length)}\n${renderJsonInventory(CLI_SPEC)}${text.slice(text.indexOf(end))}`;
await Bun.write(path, next);

for (const [name, fixture] of Object.entries(machineOutputFixtures())) {
  await Bun.write(
    new URL(
      `../apps/desktop/core/tests/fixtures/machine-output/${name}`,
      import.meta.url
    ),
    `${JSON.stringify(fixture, null, 2)}\n`
  );
}
