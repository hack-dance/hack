import Link from "next/link";

export default function Home() {
  return (
    <main className="home">
      <a className="home-skip" href="#home-index">
        Skip to the index
      </a>

      <header className="home-opening">
        <h1>
          <Link aria-label="hack.foo — documentation" href="/docs">
            hack.foo
          </Link>
        </h1>
      </header>

      <div className="home-index" id="home-index" tabIndex={-1}>
        <nav aria-label="Homepage">
          <Link href="/docs">Documentation</Link>
          <a href="https://github.com/hack-dance/hack">Source on GitHub</a>
        </nav>

        <section aria-labelledby="home-about">
          <h2 id="home-about">One command runs the whole project</h2>
          <p>
            Services, environment, secrets, local HTTPS and logs belong to the
            same project. Hack runs them from a small <code>.hack/</code> folder
            committed with the repository, so anyone who clones it, teammate or
            agent, is one <code>hack up</code> from a running environment.
          </p>
          <p>
            Every project gets its own trusted local URL. Projects and branches
            run side by side without colliding. Nothing is hosted; your machine
            is the platform.
          </p>
          <p>
            <Link href="/docs/v5/install">Install and get started</Link>
          </p>
        </section>

        <section aria-labelledby="home-docs">
          <h2 id="home-docs">Index</h2>
          <ul className="home-docs">
            <li>
              <Link href="/docs/v5/core">Core concepts</Link>
              <span>Projects, services, instances and local URLs.</span>
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
