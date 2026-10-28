import Link from "next/link";
export default function Home() {
  return (
    <main className="home">
      <nav aria-label="Main">
        <strong>hack</strong>
        <Link href="/docs">Docs</Link>
        <a href="https://github.com/hack-dance/hack">GitHub</a>
      </nav>
      <p>LOCAL DEVELOPMENT, TOGETHER</p>
      <h1>Your machine is the platform.</h1>
      <p className="intro">
        One command runs the whole project — services, env, secrets, TLS, logs —
        at its own local HTTPS URL.
      </p>
      <div className="actions">
        <Link className="primary" href="/docs/guides/getting-started">
          Get started
        </Link>
        <Link className="secondary" href="/docs/core">
          Explore the CLI
        </Link>
      </div>
      <pre>
        <code>{"cd your-project\nhack init\nhack up --detach\nhack open"}</code>
      </pre>
      <section aria-label="What Hack manages" className="grid">
        <article>
          <h2>A URL for every project</h2>
          <p>
            Local HTTPS and per-service domains, with shared routing
            infrastructure.
          </p>
        </article>
        <article>
          <h2>Env that travels with the repo</h2>
          <p>
            Committed configuration and encrypted secrets. Keep the decryption
            key separate.
          </p>
        </article>
        <article>
          <h2>Parallel everything</h2>
          <p>
            Branch instances and linked worktrees let projects run side by side.
          </p>
        </article>
      </section>
      <section>
        <h2>Start with stable. Explore v5 deliberately.</h2>
        <p>
          Docker Compose is the supported setup guide. The v5 native candidate
          is experimental, with separate installation and explicit project
          adoption.
        </p>
        <div className="actions">
          <Link className="secondary" href="/docs/guides/getting-started">
            Stable setup
          </Link>
          <Link className="secondary" href="/docs/guides/v5-dogfooding">
            v5 dogfooding guide
          </Link>
        </div>
      </section>
      <footer>
        <p>
          Local-first CLI. Optional agent integrations. No hosted account
          required.
        </p>
        <p>
          <a href="/llms.txt">LLM index</a> ·{" "}
          <a href="/llms-full.txt">Public Markdown corpus</a>
        </p>
      </footer>
    </main>
  );
}
