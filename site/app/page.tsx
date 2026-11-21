import { ThemeSwitch } from "fumadocs-ui/layouts/shared/slots/theme-switch";
import { Doto, Geist_Mono } from "next/font/google";
import Image from "next/image";
import Link from "next/link";
import { Fragment } from "react";
import { HomeConsole } from "@/components/home-page/console";
import { CopyButton } from "@/components/home-page/copy-button";
import { HomeExplorer } from "@/components/home-page/explorer";
import {
  agentCommit,
  agentMachine,
  agentsBefore,
  branchStatus,
  envList,
  hostExec,
  lifecycleConfig,
  lifecycleUp,
  logs,
  remotesConfig,
  servicesTable,
  signInExpired,
  toolMissing,
  toolsConfig,
  upJson,
  worksWith,
} from "@/components/home-page/panels";
import { Term } from "@/components/home-page/term";
import {
  descriptionParts,
  installCommand,
  prereleaseTag,
  releaseUrl,
  stableInstallCommand,
  stableTag,
  taglineLines,
} from "@/lib/home";
import {
  COMPARISONS_MEASURED,
  engineChartMarkup,
  headline,
  idleComparison,
  idleComparisonMarkup,
  sample,
  usageMarkup,
} from "@/lib/home-numbers";
import rootPackage from "../../package.json";
import versions from "../../scripts/docs/versions.json";

const mono = Geist_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-home-mono",
});

/** The dot-matrix face of the big numerals. */
const dots = Doto({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-home-dots",
  weight: ["600", "800"],
});

const GITHUB = "https://github.com/hack-dance/hack";
const CHANGELOG = `${GITHUB}/releases`;

/** The same release the v5 install page is pinned to. */
const nextTag = prereleaseTag(versions.v5.label);
const install = installCommand(nextTag);

/** The stable line, from the root package; absent if it is not a plain release. */
const stable = stableTag(rootPackage.version);

/** Splits a line into words and the runs of space between them. */
const spaces = /(\s+)/;

/**
 * The install lines as words and the spaces between them, so that a narrow
 * screen wraps a line between words. Only the download address, which has no
 * spaces, may break inside itself. A line that starts a command gets a prompt
 * mark; the mark is not part of the text a reader selects or copies.
 */
const installLines = install.split("\n").map((line, row) => ({
  command: !line.startsWith(" "),
  parts: line
    .split(spaces)
    .filter((text) => text !== "")
    .map((text, position) => ({ position, text })),
  row,
}));

/** Screenshots of the desktop app, from `apps/desktop/screenshots/window`. */
const APP_SHOT = { height: 1440, width: 2240 };
const APP_SHOT_SIZES = "(max-width: 860px) 100vw, 1028px";

function Fig({ children, number }: { children: string; number: string }) {
  return (
    <p className="fig micro">
      <b>{number}</b> {children}
    </p>
  );
}

/** A link into the docs, shown as its route. */
function DocLink({ href }: { href: string }) {
  return (
    <Link className="inl" href={href}>
      {href.slice(1)}
    </Link>
  );
}

function InstallAndDoors() {
  return (
    <div className="cta">
      <div className="install">
        <div className="install-head">
          <span className="micro">v5 prerelease</span>
          <CopyButton
            label="Copy the v5 prerelease install commands"
            text={install}
          />
        </div>
        <pre>
          <code>
            {installLines.map(({ command, parts, row }) => (
              <Fragment key={row}>
                {row > 0 ? "\n" : null}
                {command ? (
                  <span aria-hidden="true" className="f mark">
                    ${" "}
                  </span>
                ) : null}
                {parts.map(({ position, text }) =>
                  text.includes("/") || text.trim() === "" ? (
                    text
                  ) : (
                    <span className="word" key={position}>
                      {text}
                    </span>
                  )
                )}
              </Fragment>
            ))}
          </code>
        </pre>
        <div className="install-head">
          <span className="micro">stable v4</span>
          <CopyButton
            label="Copy the stable v4 install command"
            text={stableInstallCommand}
          />
        </div>
        <pre>
          <code>
            <span aria-hidden="true" className="f mark">
              ${" "}
            </span>
            {stableInstallCommand}
          </code>
        </pre>
      </div>
      <div className="doors">
        <Link className="door" href="/docs">
          <span className="micro">read</span>
          <span>Docs</span>
        </Link>
        <a className="door" href={GITHUB}>
          <span className="micro">source</span>
          <span>GitHub</span>
        </a>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <div className={`home ${mono.variable} ${dots.variable}`}>
      <a className="home-skip" href="#home-index">
        Skip to the index
      </a>

      <header className="wrap top">
        <Link className="logo" href="/">
          hack
        </Link>
        <nav aria-label="Site">
          <Link href="/docs">Docs</Link>
          <a href={GITHUB}>GitHub</a>
          <a className="hide" href={CHANGELOG}>
            Changelog
          </a>
          <ThemeSwitch />
          <a className="go" href="#install">
            Install
          </a>
        </nav>
      </header>

      <main>
        <div className="wrap hero">
          <div className="hero-meta micro">
            <a href={releaseUrl(nextTag)}>
              <b>hack next</b> &nbsp;{nextTag}
            </a>
            {stable ? (
              <a href={releaseUrl(stable)}>
                <b>hack stable</b> &nbsp;{stable}
              </a>
            ) : null}
          </div>
          <h1>
            <span>{taglineLines[0]}</span>
            <span>{taglineLines[1]}.</span>
          </h1>
          <p className="sub">
            {descriptionParts.lead} <b>{descriptionParts.emphasis}</b>{" "}
            {descriptionParts.tail}
          </p>
          <InstallAndDoors />

          <HomeConsole />

          <div className="nums">
            {headline.map((figure) => (
              <div key={figure.label}>
                <b>{figure.value}</b>
                <span>{figure.label}</span>
              </div>
            ))}
          </div>
        </div>

        <section className="wrap">
          <Fig number="02">real projects</Fig>
          <h2>Less setup. More hacking.</h2>
          <p className="lede">
            Real projects are messier than a compose file. Half the stack is
            local and half lives behind a VPN, a bastion or a session tunnel.
            Which half changes with what you're working on. So every repo grows
            its own pile: tunnel scripts, sign-in rituals, a wiki page called
            "local setup", three terminal tabs nobody dares close.
          </p>
          <p className="lede">
            Hack replaces the pile. You describe the mess once, in the repo, and
            change it with one line. More often, your agent does.{" "}
            <DocLink href="/docs/v5/core" />
          </p>
          <div className="ledger">
            <div className="head micro">
              <span>by hand, in every project</span>
              <span>with hack</span>
            </div>
            <div>
              <span>
                Tunnel scripts, port-forwards and hosts-file edits. Custom, per
                project.
              </span>
              <span>
                Say how each remote is reached. Hack opens the path, routes the
                real hostname through it, and closes it with the project.
              </span>
            </div>
            <div>
              <span>
                Watchers, workers, migrations and webhook forwarders in stray
                tabs.
              </span>
              <span>
                Declared once. <code>hack up</code> starts them in order,{" "}
                <code>hack down</code> stops them.
              </span>
            </div>
            <div>
              <span>
                Cloud sign-in expires mid-task. You find out from a stack trace.
              </span>
              <span>
                Hack checks sign-in before it starts anything and tells you
                which one ran out.
              </span>
            </div>
            <div>
              <span>
                One service is remote today and local tomorrow. Edit env files,
                restart, hope.
              </span>
              <span>
                <code>hack use db=qa</code>. One command, and the app never
                notices.
              </span>
            </div>
            <div>
              <span>A new teammate loses a day to setup.</span>
              <span>
                Clone, <code>hack up</code>.
              </span>
            </div>
            <div>
              <span>
                "What's actually running, and where does it point?" Nobody
                knows.
              </span>
              <span>
                <code>hack ps</code> and the desktop app show every service,
                where it runs and where it points.
              </span>
            </div>
          </div>
        </section>

        <section className="wrap">
          <Fig number="03">a real project</Fig>
          <h2>
            Eleven services, three remotes, two helpers. One{" "}
            <span className="nowrap">.hack/ folder.</span>
          </h2>
          <p className="lede">
            Pick a file to see what it adds. Then start it.{" "}
            <DocLink href="/docs/v5/guides/init-project" />
          </p>
          <HomeExplorer />
        </section>

        <section className="wrap">
          <div className="split">
            <div className="text">
              <Fig number="04">branches and worktrees</Fig>
              <h2>Every branch, running side by side.</h2>
              <p>
                A worktree gives an agent the files. Hack gives it a running
                app: its own services, database, address and logs.
              </p>
              <p>
                <b>Three agents, three copies.</b> Nobody's tests hit somebody
                else's branch.
              </p>
              <p className="more">
                <DocLink href="/docs/v5/guides/parallel-work" />
              </p>
            </div>
            <div className="box">
              <span className="title">hack status</span>
              <Term>{branchStatus}</Term>
            </div>
          </div>
        </section>

        <section className="wrap">
          <div className="split flip">
            <div className="text">
              <Fig number="05">lifecycle</Fig>
              <h2>Everything around the containers, too.</h2>
              <p>
                The codegen that runs first, the worker beside the API, the
                webhook forwarder, the migration after boot. Declared once, run
                every time.
              </p>
              <ul className="plus">
                <li>
                  <b>Owned, not orphaned.</b> <code>hack down</code> stops
                  exactly what <code>hack up</code> started.
                </li>
              </ul>
              <p className="more">
                <DocLink href="/docs/v5/lifecycle" />
              </p>
            </div>
            <div className="stack">
              <div className="box">
                <span className="title">.hack/hack.config.json</span>
                <Term>{lifecycleConfig}</Term>
              </div>
              <div className="box">
                <span className="title">hack up</span>
                <Term>{lifecycleUp}</Term>
              </div>
            </div>
          </div>
        </section>

        <section className="wrap">
          <div className="head2">
            <div className="text">
              <Fig number="06">remote services</Fig>
              <h2>Local or remote. One view, one switch.</h2>
              <p>
                A database in a cloud account, an API that only answers inside a
                private network, a search cluster that's local some days and
                shared on others. Declare them and they sit beside your local
                services: where each points, whether it answers.
              </p>
            </div>
            <div className="text side">
              <ul className="plus">
                <li>
                  <b>One switch per remote.</b> <code>hack use db=qa</code> for
                  this worktree, <code>hack up --use db=local</code> for one
                  run. Two worktrees can point at different places.
                </li>
                <li>
                  <b>Sign-in checked first.</b> A stale sign-in stops the start
                  in a second, with the command to run.
                </li>
                <li>
                  <b>Hack owns the tunnel.</b> Starts it, waits until it works,
                  shares one between checkouts, stops it with the last one. SSH
                  bastions, AWS Session Manager, the Cloud SQL proxy, or any
                  command.
                </li>
                <li>
                  <b>Real hostnames keep working.</b> Inside your containers the
                  real name reaches the tunnel, with the remote's own
                  certificate.
                </li>
              </ul>
            </div>
          </div>
          <div className="below cols">
            <div className="stack">
              <div className="box">
                <span className="title">.hack/hack.config.json</span>
                <Term>{remotesConfig}</Term>
              </div>
              <div className="box">
                <span className="title">hack up, sign-in expired</span>
                <Term>{signInExpired}</Term>
              </div>
            </div>
            <div className="box">
              <span className="title">hack ps</span>
              <Term>{servicesTable}</Term>
            </div>
          </div>
        </section>

        <section className="wrap">
          <div className="split flip">
            <div className="text">
              <Fig number="07">host tools</Fig>
              <h2>The tools your project assumes, written down.</h2>
              <p>
                A cloud CLI for the tunnel, a runtime at a pinned version, a
                database client for one script. Nobody lists them, so a new
                engineer finds out one failed command at a time.
              </p>
              <ul className="plus">
                <li>
                  <b>Checked when needed.</b> Working on local targets never
                  asks for the tunnel CLI.
                </li>
                <li>
                  <b>
                    <code>hack up</code> never installs anything.
                  </b>{" "}
                  Something missing? It stops first and gives you the exact
                  command.
                </li>
                <li>
                  <b>Your version pins stay yours.</b> Hack installs through
                  mise or Homebrew, and reads your <code>mise.toml</code>.
                </li>
                <li>
                  <b>What Hack checked is what it runs.</b> No more "works in my
                  shell".
                </li>
              </ul>
            </div>
            <div className="stack">
              <div className="box">
                <span className="title">.hack/hack.config.json</span>
                <Term>{toolsConfig}</Term>
              </div>
              <div className="box">
                <span className="title">hack up, a tool is missing</span>
                <Term>{toolMissing}</Term>
              </div>
            </div>
          </div>
        </section>

        <section className="wrap">
          <div className="split">
            <div className="text">
              <Fig number="08">env, secrets and overlays</Fig>
              <h2>Run anything against any environment.</h2>
              <p>
                Settings and secrets live in the repo: plain YAML, secrets
                encrypted one value at a time. An overlay is a named set of what
                differs: <code>qa</code>, <code>staging</code>,{" "}
                <code>production</code>.
              </p>
              <p>
                <b>Injected, not copied.</b> <code>hack up</code> hands every
                service its values, and <code>hack host exec</code> does the
                same for any command. No <code>.env</code> files to pass around.
              </p>
              <p>
                <b>Pick the overlay per command.</b> A production migration is
                one line.
              </p>
              <ul className="plus">
                <li>
                  <b>Travels with the repo.</b> One key outside git unlocks it
                  on any machine.
                </li>
                <li>
                  <b>A key per overlay, if you want one.</b> Give an agent a key
                  that opens <code>qa</code> and not <code>production</code>.
                </li>
                <li>
                  <b>
                    <code>hack env list</code> shows names, never values.
                  </b>{" "}
                  Reading a secret takes an explicit ask.
                </li>
              </ul>
              <p className="more">
                <DocLink href="/docs/v5/env" />
              </p>
            </div>
            <div className="stack">
              <div className="box">
                <span className="title">hack host exec --env production</span>
                <Term>{hostExec}</Term>
              </div>
              <div className="box">
                <span className="title">hack env list --env production</span>
                <Term>{envList}</Term>
              </div>
            </div>
          </div>
        </section>

        <section className="wrap">
          <div className="split flip">
            <div className="text">
              <Fig number="09">places</Fig>
              <h2>A sandbox is just a computer.</h2>
              <p>
                So is a laptop, and so is a CI runner. None of them comes with
                your project. <b>Hack is the part that travels.</b>
              </p>
              <p className="more">
                <DocLink href="/docs/v5/guides/cloud-environments" />
              </p>
            </div>
            <ul className="menu">
              <li>
                <b>your machine</b>
                <span>
                  Apple Silicon or Linux. Hack's own engine, Docker optional.
                </span>
              </li>
              <li>
                <b>every worktree</b>
                <span>Its own running copy at its own HTTPS address.</span>
              </li>
              <li>
                <b>your team</b>
                <span>
                  Clone, <code>hack up</code>. Same services, same secrets.
                </span>
              </li>
              <li>
                <b>ci</b>
                <span>
                  The stack your tests need, from the file you already have.
                </span>
              </li>
              <li>
                <b>agent sandboxes</b>
                <span>
                  Hack starts the project inside whichever one you use.
                </span>
              </li>
            </ul>
          </div>
        </section>

        <section className="wrap">
          <Fig number="10">cloud agents</Fig>
          <h2 className="wide">
            Give it the key. <span className="nowrap">Type hack up.</span>
          </h2>
          <p className="lede">
            Setting up a cloud environment for an agent is a project of its own,
            repeated for every provider. With a Hack config in the repo it is
            two steps, the same two everywhere.
          </p>

          <div className="versus">
            <div>
              <p className="micro vs-label">today, for each provider</p>
              <ul className="chores">
                <li>
                  Find where this one wants its setup: a dashboard field, a JSON
                  file, a Dockerfile, a "skill".
                </li>
                <li>
                  Install the runtimes, the package manager, the database
                  client.
                </li>
                <li>
                  Start Postgres. Wait for it. Create the database. Migrate.
                  Seed.
                </li>
                <li>
                  Start Redis, the queue, the API, the worker and the web app,
                  in the right order.
                </li>
                <li>
                  Copy fourteen variables. Paste six secrets into a web form,
                  one at a time.
                </li>
                <li>
                  Learn that this provider's "secrets" never reach your process.
                </li>
                <li>
                  Sign in to the cloud. Open the tunnel to staging. Keep it
                  open.
                </li>
                <li>Save a snapshot. Find it stale a week later.</li>
                <li>Do all of it again for the next provider.</li>
              </ul>
            </div>
            <div>
              <p className="micro vs-label">with hack in the repo</p>
              <ol className="two">
                <li>
                  <span className="n">1</span>
                  <span className="what">Add one secret</span>
                  <code>HACK_ENV_SECRET_KEY</code>
                </li>
                <li>
                  <span className="n">2</span>
                  <span className="what">Set the start command</span>
                  <code>hack up</code>
                </li>
              </ol>
              <div className="box">
                <span className="title">the agent's machine</span>
                <Term>{agentMachine}</Term>
              </div>
              <p className="vs-note">
                Give it the project key, or a key that opens only the overlays
                it should see.
              </p>
              <p className="vs-note">
                The sandbox image gets the project's tools from the same config:{" "}
                <code>hack tools plan</code>.
              </p>
              <p className="vs-note">
                On a Mac or a Linux box, Hack's own engine. In a sandbox that
                can't start a VM, the machine's Docker. Same config either way.
              </p>
            </div>
          </div>

          <p className="tally">
            Nine chores, for every provider. Or two steps, once.
          </p>

          <div className="where">
            <p className="micro">agent products</p>
            <ul className="tags">
              <li>Claude Code on the web</li>
              <li>Codex cloud</li>
              <li>Cursor cloud agents</li>
              <li>GitHub Copilot agent</li>
              <li>Devin</li>
            </ul>
            <p className="micro">sandboxes and dev boxes</p>
            <ul className="tags">
              <li>GitHub Codespaces</li>
              <li>Daytona</li>
              <li>boat.dev</li>
              <li>E2B</li>
              <li>any box you can SSH into</li>
            </ul>
          </div>
          <p className="more">
            <DocLink href="/docs/v5/guides/cloud-environments" />
          </p>
        </section>

        <section className="wrap">
          <div className="head2">
            <div className="text">
              <Fig number="11">for agents</Fig>
              <h2>Give your agent somewhere to write it down.</h2>
              <p>
                An agent learns how your project really runs: the tunnel it
                needs, the order things start in, the sign-in that expires.
                Today that ends up in a prompt file and a folder of scripts.
              </p>
              <p>
                <b>With Hack it goes in the config.</b> The next agent, and the
                next person, start from what the last one learned.
              </p>
            </div>
            <div className="text side">
              <ul className="plus">
                <li>
                  <b>A schema, not prose.</b> It can't half-describe a tunnel.
                </li>
                <li>
                  <b>Checked before it runs.</b>{" "}
                  <code>hack config validate</code>.
                </li>
                <li>
                  <b>Changes in a diff.</b> How the project runs gets reviewed
                  like code.
                </li>
              </ul>
              <p className="more">
                <DocLink href="/docs/v5/guides/agent-first-setup" />
              </p>
            </div>
          </div>
          <div className="below">
            <div className="pair">
              <div className="box">
                <span className="title">AGENTS.md, before</span>
                <Term className="d">{agentsBefore}</Term>
              </div>
              <div className="box">
                <span className="title">after: an agent's commit</span>
                <Term>{agentCommit}</Term>
              </div>
            </div>
          </div>
        </section>

        <section className="wrap">
          <div className="split flip">
            <div className="text">
              <Fig number="12">the engine</Fig>
              <h2>Its own engine. Built to not wait.</h2>
              <p>
                Hack runs your containers in its own small Linux VM. The engine
                is written in Rust.
              </p>
              <ul className="plus">
                <li>
                  <b>Parallel.</b> Everything that can start together does.
                </li>
                <li>
                  <b>Skips what didn't change.</b> Plan, images, routes.
                </li>
              </ul>
              <p className="more">
                <DocLink href="/docs/v5/native/overview" />
              </p>
            </div>
            <div className="box">
              <span className="title">same project, warm start</span>
              <Term>{engineChartMarkup()}</Term>
            </div>
          </div>
        </section>

        <section className="wrap">
          <div className="head2">
            <div className="text">
              <Fig number="13">resources</Fig>
              <h2>Easy on your machine.</h2>
              <p>Ten branches shouldn't cost ten times the memory and disk.</p>
            </div>
            <div className="text side">
              <ul className="plus">
                <li>
                  <b>Memory follows use.</b> The engine grows with your services
                  and hands memory back when they stop needing it.
                </li>
                <li>
                  <b>Idle projects sleep.</b> No CPU, memory returned, awake in{" "}
                  {sample.idleWake.value}.
                </li>
                <li>
                  <b>Copies share.</b> A second copy reuses images and caches,
                  and costs {idleComparison.secondCopyDisk.value}.
                </li>
                <li>
                  <b>Cleanup leaves yours alone.</b> Hack removes only what it
                  started and can prove it owns.
                </li>
                <li>
                  <b>It says why your machine is slow.</b>{" "}
                  <code>hack doctor</code> names the emulated image and the file
                  watcher that polls.
                </li>
              </ul>
            </div>
          </div>
          <div className={COMPARISONS_MEASURED ? "below cols" : "below"}>
            {COMPARISONS_MEASURED ? (
              <div className="box">
                <span className="title">idle, one project up</span>
                <Term>{idleComparisonMarkup()}</Term>
              </div>
            ) : null}
            <div className="box">
              <span className="title">hack usage</span>
              <Term>{usageMarkup()}</Term>
            </div>
          </div>
        </section>

        <section className="wrap">
          <div className="split flip">
            <div className="text">
              <Fig number="14">compatibility</Fig>
              <h2>Bring what you have.</h2>
              <p>
                Keep your Compose file and your Dockerfiles. Hack reads the
                Compose file or runs it as it is, on its own engine or on
                Docker.
              </p>
              <p className="more">
                <DocLink href="/docs/v5/native/existing-compose-project" />
              </p>
            </div>
            <div className="box">
              <span className="title">works with</span>
              <Term>{worksWith}</Term>
            </div>
          </div>
        </section>

        <section className="wrap">
          <Fig number="15">logs and automation</Fig>
          <h2>See everything. Script anything.</h2>
          <p className="lede">
            <DocLink href="/docs/v5/guides/run-project" /> &nbsp;{" "}
            <DocLink href="/docs/v5/guides/machine-output" />
          </p>
          <div className="pair spaced">
            <div className="box">
              <span className="title">hack logs --since 5m --no-follow</span>
              <Term>{logs}</Term>
              <p className="box-note">
                Logs, traces, timings and resource use for every service. Read
                them in the terminal, a local dashboard or the desktop app.
              </p>
            </div>
            <div className="box">
              <span className="title">hack up --json</span>
              <Term>{upJson}</Term>
              <p className="box-note">
                The commands agents use speak JSON, never wait on a prompt, and
                fail with a code an agent can act on. So an agent can start,
                test and tear down its own copy.
              </p>
            </div>
          </div>
        </section>

        <section className="wrap">
          <div className="head2">
            <div className="text">
              <Fig number="16">desktop app</Fig>
              <h2>The same engine, with a window.</h2>
              <p>
                A native app for macOS and Linux. Every project, branch and
                service in one place: what's running, where it points, what it's
                using.
              </p>
            </div>
            <div className="text side">
              <ul className="plus">
                <li>
                  <b>A real terminal.</b> Logs, and shells into any service, in
                  the panel below.
                </li>
                <li>
                  <b>Overlays side by side.</b> Secrets stay hidden until you
                  ask.
                </li>
              </ul>
              <p className="more">
                <DocLink href="/docs/v5/guides/desktop-app" />
              </p>
            </div>
          </div>
          <div className="below">
            <figure className="shot">
              <Image
                alt="The Hack desktop app: a list of running projects and branches on the left, the storefront project's four services in a table, and a log terminal below"
                className="only-dark"
                height={APP_SHOT.height}
                sizes={APP_SHOT_SIZES}
                src="/home-page/panel-open-dark.png"
                width={APP_SHOT.width}
              />
              <Image
                alt="The Hack desktop app in its light theme, showing a running project and its services"
                className="only-light"
                height={APP_SHOT.height}
                sizes={APP_SHOT_SIZES}
                src="/home-page/running-light.png"
                width={APP_SHOT.width}
              />
            </figure>
          </div>
        </section>

        <section className="wrap">
          <Fig number="17">scope</Fig>
          <h2>What Hack isn't.</h2>
          <div className="three">
            <div className="box">
              <h3>Not hosted</h3>
              <p>
                No account, nothing to sign in to. It runs on machines you
                already have.
              </p>
            </div>
            <div className="box">
              <h3>Not a sandbox</h3>
              <p>
                Hack runs your project. It doesn't wall anything off. Bring your
                own sandbox and run Hack inside it.
              </p>
            </div>
            <div className="box">
              <h3>Not a deploy tool</h3>
              <p>
                Hack doesn't ship your code. It touches production only when you
                name it in a command.
              </p>
            </div>
          </div>
        </section>

        <section className="wrap">
          <Fig number="18">quick start</Fig>
          <h2>Three commands.</h2>
          <p className="lede">
            <DocLink href="/docs/v5/getting-started" />
          </p>
          <div className="three">
            <div className="box">
              <span className="title">1</span>
              <h3 className="cmd">
                <span className="f">$</span> hack init
              </h3>
              <p>
                Reads your repo, and your Compose file if you have one, and
                writes the config. Commit it.
              </p>
            </div>
            <div className="box">
              <span className="title">2</span>
              <h3 className="cmd">
                <span className="f">$</span> hack up
              </h3>
              <p>
                Starts the whole project and gives it an address.{" "}
                <code>hack down</code> stops it and keeps your data.
              </p>
            </div>
            <div className="box">
              <span className="title">3</span>
              <h3 className="cmd">
                <span className="f">$</span> hack up{" "}
                <span className="f"># somewhere else</span>
              </h3>
              <p>
                A worktree, a teammate's laptop, CI, a sandbox. Same file, same
                project.
              </p>
            </div>
          </div>
        </section>

        <section className="wrap" id="home-index" tabIndex={-1}>
          <Fig number="19">documentation</Fig>
          <h2>Everything else is in the docs.</h2>
          <ul className="index">
            <li>
              <Link href="/docs/v5/install">Install and first project</Link>
              <span>Set up a machine, start a repo, open it, stop it.</span>
            </li>
            <li>
              <Link href="/docs/v5/core">Core concepts</Link>
              <span>Projects, services, instances and local addresses.</span>
            </li>
            <li>
              <Link href="/docs/v5/guides/parallel-work">
                Branches and worktrees
              </Link>
              <span>
                A running copy per branch, and what a copy still shares.
              </span>
            </li>
            <li>
              <Link href="/docs/v5/env">Environment and secrets</Link>
              <span>Committed settings, encrypted values, overlays.</span>
            </li>
            <li>
              <Link href="/docs/v5/lifecycle">Lifecycle</Link>
              <span>
                Hooks, tunnels and host helpers that start with the project.
              </span>
            </li>
            <li>
              <Link href="/docs/v5/sessions">Sessions</Link>
              <span>Terminal workspaces that outlive the window.</span>
            </li>
            <li>
              <Link href="/docs/v5/integrations">Agent integrations</Link>
              <span>
                JSON output, the plugin, its skills and the MCP server.
              </span>
            </li>
            <li>
              <Link href="/docs/v5/native/overview">Native engine</Link>
              <span>What it is, what it runs, how to try it.</span>
            </li>
            <li>
              <Link href="/docs/v5/guides/desktop-app">Desktop app</Link>
              <span>Projects, services, logs and env in a window.</span>
            </li>
            <li>
              <Link href="/docs/v5/reference/cli">CLI reference</Link>
              <span>Every command and option.</span>
            </li>
            <li>
              <Link href="/docs/v5/upgrade">Upgrade from v4</Link>
              <span>Same commands, same folder, new engine underneath.</span>
            </li>
          </ul>
        </section>

        <div className="wrap end" id="install">
          <h2>
            Run your <span className="nowrap">project.</span>
          </h2>
          <InstallAndDoors />
          <p className="end-note">
            macOS on Apple Silicon, and Linux. Nothing hosted, no account.
          </p>
        </div>
      </main>

      <footer>
        <div className="wrap">
          <span className="micro">hack 5.0 · end of sheet</span>
          <nav aria-label="Footer">
            <Link href="/docs">docs</Link>
            <a href={GITHUB}>github</a>
            <a href={CHANGELOG}>changelog</a>
            <Link href="/docs/v4">v4 docs</Link>
            <a href="/llms.txt">llms.txt</a>
            <a href="/llms-full.txt">markdown corpus</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
