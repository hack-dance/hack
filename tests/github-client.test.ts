import { expect, test } from "bun:test";

import { parseGitHubRepoRef } from "../src/control-plane/extensions/github/client.ts";

test("parseGitHubRepoRef parses SSH remote", () => {
  const repo = parseGitHubRepoRef({
    remoteUrl: "git@github.com:hack-dance/hack-cli.git",
  });
  expect(repo).toEqual({
    owner: "hack-dance",
    repo: "hack-cli",
  });
});

test("parseGitHubRepoRef parses HTTPS remote", () => {
  const repo = parseGitHubRepoRef({
    remoteUrl: "https://github.com/hack-dance/hack-cli",
  });
  expect(repo).toEqual({
    owner: "hack-dance",
    repo: "hack-cli",
  });
});

test("parseGitHubRepoRef returns null for non-GitHub remote", () => {
  const repo = parseGitHubRepoRef({
    remoteUrl: "https://example.com/org/repo.git",
  });
  expect(repo).toBeNull();
});
