import { expect, test } from "bun:test";

import { urlOpenerAvailable } from "../src/lib/os.ts";

test("Linux needs xdg-open to open a URL; macOS and Windows always have an opener", () => {
  expect(urlOpenerAvailable({ platform: "linux", which: () => null })).toBe(
    false
  );
  expect(
    urlOpenerAvailable({ platform: "linux", which: () => "/usr/bin/xdg-open" })
  ).toBe(true);
  expect(urlOpenerAvailable({ platform: "darwin", which: () => null })).toBe(
    true
  );
  expect(urlOpenerAvailable({ platform: "win32", which: () => null })).toBe(
    true
  );
});
