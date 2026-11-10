import { expect, test } from "bun:test";
import { nativeAuthoredUpReadyData } from "../src/lib/native-authored-command.ts";

test.each([
  { branch: null, composeProject: "app" },
  { branch: "feature", composeProject: "app--feature" },
])("authored detached identity uses admitted app name with branch $branch", ({
  branch,
  composeProject,
}) => {
  // The checkout's basename is `checkout`; the compiler-admitted name is `app`.
  expect(
    nativeAuthoredUpReadyData({
      projectName: "app",
      branch,
      readiness: { web: "healthy", seed: "completed" },
    })
  ).toEqual({
    project: "app",
    branch,
    composeProject,
    started: ["web"],
    completed: ["seed"],
  });
});
