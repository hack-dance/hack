import { expect, test } from "bun:test";

import { __testOnlyNodeWorkspaceBootstrap } from "../src/daemon/routes/node.ts";

const {
  buildGitHubCloneEnv,
  parseGitHubRepoFromRemote,
  parseWorkspaceBootstrapGitHubAuth,
  resolveGitHubFallbackRepoUrl,
} = __testOnlyNodeWorkspaceBootstrap;

test("parseWorkspaceBootstrapGitHubAuth requires token", () => {
  expect(parseWorkspaceBootstrapGitHubAuth({ owner: "hack-dance" })).toBeNull();
  expect(
    parseWorkspaceBootstrapGitHubAuth({
      token: "gho_test",
      owner: "hack-dance",
      repo: "hack-cli",
    })
  ).toEqual({
    token: "gho_test",
    owner: "hack-dance",
    repo: "hack-cli",
  });
});

test("parseGitHubRepoFromRemote parses ssh and https remotes", () => {
  expect(
    parseGitHubRepoFromRemote({
      repoUrl: "git@github.com:hack-dance/hack-cli.git",
    })
  ).toEqual({ owner: "hack-dance", repo: "hack-cli" });
  expect(
    parseGitHubRepoFromRemote({
      repoUrl: "https://github.com/hack-dance/hack-cli",
    })
  ).toEqual({ owner: "hack-dance", repo: "hack-cli" });
  expect(
    parseGitHubRepoFromRemote({
      repoUrl: "https://gitlab.com/hack-dance/hack-cli",
    })
  ).toBeNull();
});

test("resolveGitHubFallbackRepoUrl prefers explicit auth owner/repo", () => {
  expect(
    resolveGitHubFallbackRepoUrl({
      repoUrl: "git@github.com:wrong/old.git",
      githubAuth: {
        token: "gho_test",
        owner: "hack-dance",
        repo: "hack-cli",
      },
    })
  ).toBe("https://github.com/hack-dance/hack-cli.git");
});

test("buildGitHubCloneEnv configures extraheader auth", () => {
  const env = buildGitHubCloneEnv({ token: "gho_secret" });
  expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  expect(env.GIT_CONFIG_COUNT).toBe("1");
  expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
  expect(env.GIT_CONFIG_VALUE_0).toBeDefined();
  if (env.GIT_CONFIG_VALUE_0 === undefined) {
    throw new Error("Expected git extraheader value to be set");
  }
  expect(env.GIT_CONFIG_VALUE_0.startsWith("Authorization: Basic ")).toBe(true);
  const encoded = env.GIT_CONFIG_VALUE_0.replace("Authorization: Basic ", "");
  expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(
    "x-access-token:gho_secret"
  );
});
