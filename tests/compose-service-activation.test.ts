import { expect, test } from "bun:test";
import {
  composeServiceActivation,
  requiredObservedServices,
} from "../src/lib/compose-service-activation.ts";

test("inactive profiles stay optional while observed and transitively required services participate", () => {
  const activation = composeServiceActivation({
    services: {
      api: { depends_on: ["helper"] },
      helper: {
        profiles: ["tools"],
        depends_on: { init: {}, extra: { required: false } },
      },
      init: { profiles: ["tools"], depends_on: ["helper"] },
      extra: { profiles: ["tools"] },
      docs: { profiles: ["docs"] },
    },
  });
  const names = Object.keys(activation.profiles);
  expect(
    [...requiredObservedServices({ names, observed: [], activation })].sort()
  ).toEqual(["api", "helper", "init"]);
  expect(
    [
      ...requiredObservedServices({ names, observed: ["docs"], activation }),
    ].sort()
  ).toEqual(["api", "docs", "helper", "init"]);
});
