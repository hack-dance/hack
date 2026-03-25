import { afterEach, describe, expect, test } from "bun:test";
import { createGatewayClient } from "../src/control-plane/sdk/gateway-client.ts";

const originalFetch = globalThis.fetch;
type FetchMock = (
  ...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

const installFetchMock = ({ mock }: { mock: FetchMock }) => {
  globalThis.fetch = mock as unknown as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("gateway client error parsing", () => {
  test("uses error string as message when response omits message field", async () => {
    installFetchMock({
      mock: async () =>
        new Response(JSON.stringify({ error: "bootstrap_clone_failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    });

    const client = createGatewayClient({
      baseUrl: "http://127.0.0.1:7788",
      token: "test-token",
      timeoutMs: 500,
    });
    const response = await client.ensureNodeWorkspace({
      project: "hack-cli",
    });

    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected failed response");
    }
    expect(response.status).toBe(500);
    expect(response.error.message).toBe("bootstrap_clone_failed");
    expect(response.error.code).toBe("bootstrap_clone_failed");
  });

  test("prefers explicit message field when provided", async () => {
    installFetchMock({
      mock: async () =>
        new Response(
          JSON.stringify({
            error: "bootstrap_clone_failed",
            message: "clone failed: permission denied",
          }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          }
        ),
    });

    const client = createGatewayClient({
      baseUrl: "http://127.0.0.1:7788",
      token: "test-token",
      timeoutMs: 500,
    });
    const response = await client.ensureNodeWorkspace({
      project: "hack-cli",
    });

    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error("Expected failed response");
    }
    expect(response.status).toBe(500);
    expect(response.error.message).toBe("clone failed: permission denied");
    expect(response.error.code).toBe("bootstrap_clone_failed");
  });

  test("serializes github bootstrap auth in workspace ensure payload", async () => {
    const captured = { body: undefined as Record<string, unknown> | undefined };
    installFetchMock({
      mock: async (_input, init) => {
        if (typeof init?.body === "string") {
          captured.body = JSON.parse(init.body) as Record<string, unknown>;
        }
        return new Response(
          JSON.stringify({
            workspace: {
              projectId: "project-id",
              projectName: "hack-cli",
              projectRoot: "/workspace/hack-cli",
              projectDir: "/workspace/hack-cli/.hack",
              branch: "main",
            },
            bootstrap_auth_source: "controller_github_token",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const client = createGatewayClient({
      baseUrl: "http://127.0.0.1:7788",
      token: "test-token",
      timeoutMs: 500,
    });
    const response = await client.ensureNodeWorkspace({
      project: "hack-cli",
      bootstrap: {
        repoUrl: "git@github.com:hack-dance/hack-cli.git",
        projectName: "hack-cli",
        githubAuth: {
          token: "gho_test",
          owner: "hack-dance",
          repo: "hack-cli",
        },
      },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error("Expected successful workspace response");
    }
    expect(response.data.bootstrapAuthSource).toBe("controller_github_token");
    if (captured.body === undefined) {
      throw new Error("Expected workspace request payload to be captured");
    }
    expect(captured.body.bootstrap).toEqual({
      repo_url: "git@github.com:hack-dance/hack-cli.git",
      project_name: "hack-cli",
      github_auth: {
        token: "gho_test",
        owner: "hack-dance",
        repo: "hack-cli",
      },
    });
  });

  test("serializes node git probe payload and parses response", async () => {
    const captured = { body: undefined as Record<string, unknown> | undefined };
    installFetchMock({
      mock: async (_input, init) => {
        if (typeof init?.body === "string") {
          captured.body = JSON.parse(init.body) as Record<string, unknown>;
        }
        return new Response(
          JSON.stringify({
            repo_url: "git@github.com:hack-dance/hack-cli.git",
            ok: true,
            auth_source: "native_git",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const client = createGatewayClient({
      baseUrl: "http://127.0.0.1:7788",
      token: "test-token",
      timeoutMs: 500,
    });
    const response = await client.probeNodeGitAccess({
      repoUrl: "git@github.com:hack-dance/hack-cli.git",
      githubAuth: {
        token: "gho_test",
        owner: "hack-dance",
        repo: "hack-cli",
      },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error("Expected successful probe response");
    }
    expect(response.data.authSource).toBe("native_git");
    if (captured.body === undefined) {
      throw new Error("Expected probe request payload to be captured");
    }
    expect(captured.body).toEqual({
      repo_url: "git@github.com:hack-dance/hack-cli.git",
      github_auth: {
        token: "gho_test",
        owner: "hack-dance",
        repo: "hack-cli",
      },
    });
  });

  test("encodes control-plane path segments before issuing requests", async () => {
    const captured = { pathname: "" };
    installFetchMock({
      mock: async (input) => {
        const url =
          typeof input === "string"
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL(input.url);
        captured.pathname = url.pathname;
        return new Response(JSON.stringify({ jobs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const client = createGatewayClient({
      baseUrl: "http://127.0.0.1:7788",
      token: "test-token",
      timeoutMs: 500,
    });
    const response = await client.listJobs({
      projectId: "abc123def456/../../v1/status",
    });

    expect(response.ok).toBe(true);
    expect(captured.pathname).toBe(
      "/control-plane/projects/abc123def456%2F..%2F..%2Fv1%2Fstatus/jobs"
    );
  });
});
