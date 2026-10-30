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
          <h2 id="home-about">Run the whole project</h2>
          <p>
            Services, environment, secrets, local HTTPS and logs belong to the
            same project. Hack runs them from <code>.hack/</code> configuration
            kept in your repository.
          </p>
          <p>
            Run projects and branches side by side, each at its own local URL.
            The setup guide explains the runtime and platform prerequisites
            before you start.
          </p>
          <p>
            <Link href="/docs/getting-started">Install and get started</Link>
          </p>
        </section>

        <section aria-labelledby="home-docs">
          <h2 id="home-docs">Index</h2>
          <ul className="home-docs">
            <li>
              <Link href="/docs/core">Core workflows</Link>
              <span>Set up, run and inspect a project.</span>
            </li>
            <li>
              <Link href="/docs/env">Environment &amp; secrets</Link>
              <span>Configuration and encrypted values.</span>
            </li>
            <li>
              <Link href="/docs/lifecycle">Lifecycle</Link>
              <span>Startup hooks and host processes.</span>
            </li>
            <li>
              <Link href="/docs/reference/cli">CLI reference</Link>
              <span>Commands and options.</span>
            </li>
          </ul>
        </section>

        <footer>
          <a href="/llms.txt">LLM index</a>
          <a href="/llms-full.txt">Public Markdown corpus</a>
        </footer>
      </div>
    </main>
  );
}
