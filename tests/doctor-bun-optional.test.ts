import { expect, test } from "bun:test";

import { bunCheckOptional } from "../src/commands/doctor.ts";

test("a compiled CLI does not need Bun on PATH; a source run does", () => {
  expect(bunCheckOptional("/$bunfs/root/hack")).toBe(true);
  expect(bunCheckOptional("/home/dev/hack/index.ts")).toBe(false);
});
