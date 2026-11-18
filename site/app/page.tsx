import Link from "next/link";
import {
  description,
  installCommand,
  prereleaseTag,
  tagline,
} from "@/lib/home";
import versions from "../../scripts/docs/versions.json";

/** The same release the v5 install page is pinned to. */
const install = installCommand(prereleaseTag(versions.v5.label));

/**
 * Words and the spaces between them, so that a narrow screen wraps the command
 * between words. Only the download address, which has no spaces, may break
 * inside itself. The text a reader copies is unchanged.
 */
const installParts = install
  .split(/(\s+)/)
  .filter((text) => text !== "")
  .map((text, position) => ({ position, text }));

export default function Home() {
  return (
    <main className="home">
      <a className="home-skip" href="#home-index">
        Skip to the index
      </a>

      <header className="home-header">
        <Link className="home-name" href="/">
          hack.foo
        </Link>
        <nav aria-label="Homepage">
          <Link href="/docs">Documentation</Link>
          <a href="https://github.com/hack-dance/hack">Source on GitHub</a>
        </nav>
      </header>

      <section aria-labelledby="home-about">
        <h1 id="home-about">{tagline}.</h1>
        <p>{description}</p>
        <pre className="home-install">
          <code>
            {installParts.map(({ position, text }) =>
              text.includes("/") || text.trim() === "" ? (
                text
              ) : (
                <span className="home-word" key={position}>
                  {text}
                </span>
              )
            )}
          </code>
        </pre>
        <p className="home-note">
          The v5 prerelease, for Apple Silicon macOS. It installs beside stable
          v4 and leaves it alone.{" "}
          <Link href="/docs/v5/install">Install and get started</Link>
        </p>
      </section>

      <div className="home-index" id="home-index" tabIndex={-1}>
        <section aria-labelledby="home-docs">
          <h2 id="home-docs">Index</h2>
          <ul className="home-docs">
            <li>
              <Link href="/docs/v5/core">Core concepts</Link>
              <span>Projects, services, instances and local URLs.</span>
            </li>
            <li>
              <Link href="/docs/v5/guides/parallel-work">
                Work on another branch
              </Link>
              <span>
                An instance per branch; on Compose, a git worktree gets one
                automatically.
              </span>
            </li>
            <li>
              <Link href="/docs/v5/env">Environment &amp; secrets</Link>
              <span>Committed configuration with encrypted values.</span>
            </li>
            <li>
              <Link href="/docs/v5/lifecycle">Lifecycle</Link>
              <span>
                Hooks, tunnels and host helpers that start with the project.
              </span>
            </li>
            <li>
              <Link href="/docs/v5/sessions">Sessions</Link>
              <span>Persistent terminal workspaces per project.</span>
            </li>
            <li>
              <Link href="/docs/v5/integrations">Agent integrations</Link>
              <span>Optional: the plugin, its skills and the MCP server.</span>
            </li>
            <li>
              <Link href="/docs/v5/reference/cli">CLI reference</Link>
              <span>Commands and options.</span>
            </li>
            <li>
              <Link href="/docs/v5/upgrade">Upgrade from v4</Link>
              <span>
                Compose stays the default; the native backend is beta.
              </span>
            </li>
          </ul>
        </section>

        <footer>
          <Link href="/docs/v4">v4 docs</Link>
          <a href="/llms.txt">LLM index</a>
          <a href="/llms-full.txt">Public Markdown corpus</a>
        </footer>
      </div>
    </main>
  );
}
