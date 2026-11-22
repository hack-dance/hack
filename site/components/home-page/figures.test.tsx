// The DOM is registered by the preload in site/bunfig.toml, before React loads.
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";

// next/link needs the Next.js runtime; a plain <a> keeps the same props.
mock.module("next/link", () => ({
  default: (props: Record<string, unknown>) => createElement("a", props),
}));

/** Canvas calls by name, so a test can tell that the scene drew. */
const drawn = new Map<string, number>();
const context = new Proxy(
  {},
  {
    get: (_target, name) => () => {
      drawn.set(String(name), (drawn.get(String(name)) ?? 0) + 1);
    },
    set: () => true,
  }
);

const original = {
  getContext: HTMLCanvasElement.prototype.getContext,
  matchMedia: window.matchMedia,
};

beforeAll(() => {
  // The test DOM has no 2D canvas. A recording stand-in lets the scene run.
  HTMLCanvasElement.prototype.getContext = (() =>
    context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  // Reduced motion: no scripted intro, and services start without a stagger.
  window.matchMedia = ((query: string) => ({
    addEventListener: () => undefined,
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = original.getContext;
  window.matchMedia = original.matchMedia;
});

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function mount(component: () => React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(StrictMode, null, createElement(component)));
    await wait(50);
  });
  return {
    host,
    async unmount() {
      await act(async () => {
        root.unmount();
        await wait(50);
      });
      host.remove();
    },
  };
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!found) {
    throw new Error(`No button with the text: ${text}`);
  }
  return found;
}

test("the console starts a copy, lists it, and stops cleanly", async () => {
  const { HomeConsole } = await import("./console");
  drawn.clear();
  const { host, unmount } = await mount(HomeConsole);
  const out = host.querySelector(".out") as HTMLElement;
  const lines = () =>
    Array.from(out.children)
      .filter((child) => child.tagName === "DIV")
      .map((child) => child.textContent);

  // Strict mode mounts twice; the second mount starts from an empty terminal.
  expect(lines()).toEqual([
    "a pretend terminal. try hack up, or the keys below.",
  ]);
  expect(host.querySelectorAll(".scene .tip").length).toBe(1);
  expect(host.querySelector(".prompt span")?.textContent).toBe(
    "~/code/myapp $"
  );
  expect(drawn.get("stroke") ?? 0).toBeGreaterThan(0);

  await act(async () => {
    button(host, "hack up").click();
    await wait(2000);
  });
  expect(lines().slice(1)).toEqual([
    "~/code/myapp $ hack up",
    "✓ engine  ready         0.3s",
    "✓ db      postgres:17   0.5s",
    "✓ api     healthy       0.7s",
    "✓ jobs    running       0.6s",
    "✓ web     healthy       0.6s",
    "https://myapp.hack.local  up in 2.1s · hack engine",
  ]);
  expect(host.querySelector(".hud.bl")?.textContent).toBe("main");

  await act(async () => {
    button(host, "new worktree").click();
    await wait(1400);
  });
  expect(host.querySelector(".prompt span")?.textContent).toBe(
    "~/code/myapp-fix-login $"
  );

  await act(async () => {
    button(host, "hack use db=qa").click();
    button(host, "status").click();
    await wait(50);
  });
  expect(lines().slice(-4)).toEqual([
    "~/code/myapp-fix-login $ hack status",
    "BRANCH            STATE   ADDRESS",
    "main              up      https://myapp.hack.local",
    "fix-login         up      https://fix-login.myapp.hack.local  db → remote",
  ]);
  // The tunnel to the remote database carries its bits as text.
  expect(drawn.get("fillText") ?? 0).toBeGreaterThan(0);

  const input = host.querySelector("input") as HTMLInputElement;
  input.value = "hack deploy";
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
    );
    await wait(50);
  });
  expect(lines().at(-1)).toBe(
    "not in this demo. the real one is one page away: hack.foo/docs/v5/install"
  );
  expect(out.querySelector("a")?.getAttribute("href")).toBe("/docs/v5/install");

  await unmount();
  expect(document.querySelectorAll(".tip").length).toBe(0);
  const settled = drawn.get("clearRect") ?? 0;
  await wait(120);
  expect(drawn.get("clearRect") ?? 0).toBe(settled);
});

test("the explorer lights what a file brings, and starts and stops the project", async () => {
  const { HomeExplorer } = await import("./explorer");
  drawn.clear();
  const { host, unmount } = await mount(HomeExplorer);
  const note = () => host.querySelector(".note")?.textContent;
  const count = () => host.querySelector(".hud.tr")?.textContent;
  const pressed = () =>
    Array.from(host.querySelectorAll('.tree button[aria-pressed="true"]')).map(
      (item) => item.textContent
    );

  expect(host.querySelectorAll(".tree button").length).toBe(12);
  expect(pressed()).toEqual(["storefront/"]);
  expect(note()).toBe(
    "storefront/ · eleven services, three remotes and two host helpers, from one folder."
  );
  await act(async () => {
    await wait(60);
  });
  expect(count()).toBe("11 local · 2 remote · 2 host helpers");

  await act(async () => {
    button(host, "apps/api/").click();
    await wait(30);
  });
  expect(pressed()).toEqual(["├─ apps/api/            graphql api"]);
  expect(note()).toBe(
    "apps/api · calls billing, which only exists remotely. Hack keeps that path open."
  );

  await act(async () => {
    button(host, "hack up --use db=qa").click();
    await wait(60);
  });
  expect(count()).toBe("10 local · 3 remote · 2 host helpers");

  await act(async () => {
    button(host, "hack down").click();
    await wait(60);
  });
  expect(count()).toBe("stopped");
  expect(note()).toBe(
    "hack down · everything hack started is stopped. Data is kept."
  );

  await act(async () => {
    button(host, "everything local").click();
    await wait(60);
  });
  expect(count()).toBe("11 local · 2 remote · 2 host helpers");

  await unmount();
  expect(document.querySelectorAll(".tip").length).toBe(0);
  const settled = drawn.get("clearRect") ?? 0;
  await wait(120);
  expect(drawn.get("clearRect") ?? 0).toBe(settled);
});
