/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal Compose interpolation fixtures. */
import { expect, test } from "bun:test";
import { resolveNativeComposeText } from "../src/backends/native-compose-interpolation.ts";

function resolved(text: string, managed: readonly string[] = []) {
  return resolveNativeComposeText({ text, managed: new Set(managed) });
}

test("unset references select defaults and drop alternatives, as native execution does", () => {
  expect(resolved("api.example.test")).toBe("api.example.test");
  expect(resolved("${UNSET_PREFIX:+x-}api.example.test")).toBe(
    "api.example.test"
  );
  expect(resolved("${API_HOST:-api.example.test}")).toBe("api.example.test");
  expect(resolved("${A:-${B:-${C:-${D:-deep}}}}.example.test")).toBe(
    "deep.example.test"
  );
  // An unselected word is validated but its references are not required.
  expect(resolved("${A:+${B}}api.example.test")).toBe("api.example.test");
  expect(resolved("cost$$5")).toBe("cost$5");
  expect(resolved("${A:-a$$b}")).toBe("a$b");
});

test("text native execution would refuse, or cannot know yet, is unknown", () => {
  for (const text of [
    "${REQUIRED}",
    "$REQUIRED.example.test",
    "${A:-${REQUIRED}}",
    "${A:?message}",
    "${A-word}",
    "${A:}",
    "${1BAD:-x}",
    "${A:-{literal}}",
    "${A:-$B}",
    "${unclosed",
    "trailing$",
    "${A:-${B:-${C:-${D:-${E:-x}}}}}",
    // Bound to the reviewed project name only after review.
    "${COMPOSE_PROJECT_NAME:-api}.example.test",
    "${COMPOSE_PROJECT_NAME}",
  ]) {
    expect(resolved(text)).toBeNull();
  }
  // A Hack-managed name is delivered privately and never interpolated.
  expect(resolved("${SECRET:-api.example.test}", ["SECRET"])).toBeNull();
  expect(resolved("${A:+${SECRET}}", ["SECRET"])).toBeNull();
  // The project name in an unselected word does not matter.
  expect(resolved("${A:+${COMPOSE_PROJECT_NAME}}x")).toBe("x");
});
