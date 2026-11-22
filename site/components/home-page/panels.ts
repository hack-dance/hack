import { sample } from "@/lib/home-numbers";

/**
 * The terminal and config panels of the home page, as panel markup: the text
 * as it appears, with a tone around each coloured part (see `term.tsx`).
 * Whitespace is significant, and the text may contain `>` but never `<`.
 * Hack's own timings come from `lib/home-numbers`.
 */

export const agentMachine = `<f>$</f> hack up
<g>✓</g> secrets   <d>6 decrypted      </d><f>from the repo, with the key</f>
<g>✓</g> services  <d>db api jobs web  </d><f>${sample.warmStart.value}</f>
<g>✓</g> remotes   <d>billing          </d><f>ssh</f>
https://myapp.hack.local`;

export const branchStatus = `<f>BRANCH            STATE   ADDRESS</f>
<c0>main</c0>              up      https://myapp.hack.local
<c1>fix-login</c1>         up      https://fix-login.myapp.hack.local
<c2>agent/onboarding</c2>  up      https://agent-onboarding.myapp.hack.local
<c3>agent/checkout</c3>    <f>asleep</f>  https://agent-checkout.myapp.hack.local

<f>4 copies · 3 up · 1 asleep</f>`;

export const lifecycleConfig = `<k>"lifecycle"</k><p>: {</p>
  <k>"before"</k><p>:</p>    <p>[</p><s>"bun run codegen"</s><p>],</p>
  <k>"processes"</k><p>: {</p>
    <k>"worker"</k><p>:</p>   <s>"bun run worker"</s><p>,</p>
    <k>"webhooks"</k><p>:</p> <s>"stripe listen --forward-to api"</s>
  <p>},</p>
  <k>"after"</k><p>:</p>     <p>[</p><s>"bun db:migrate"</s><p>]</p>
<p>}</p>`;

export const lifecycleUp = `<g>✓</g> before    <d>codegen          </d><f>0.4s</f>
<g>✓</g> services  <d>db api jobs web  </d><f>up · ${sample.warmStart.value}</f>
<g>✓</g> process   <d>worker           </d><f>running</f>
<g>✓</g> process   <d>webhooks         </d><f>forwarding to api</f>
<g>✓</g> after     <d>db:migrate       </d><f>2 applied</f>`;

export const remotesConfig = `<k>"requires"</k><p>: {</p>
  <k>"cloud"</k><p>: {</p> <k>"kind"</k><p>:</p> <s>"aws-sso"</s><p>,</p> <k>"profile"</k><p>:</p> <s>"example-dev"</s> <p>}</p>
<p>},</p>
<k>"remotes"</k><p>: {</p>
  <k>"db"</k><p>: {</p>
    <k>"default"</k><p>:</p> <s>"local"</s><p>,</p>
    <k>"env"</k><p>: {</p> <k>"DB_HOST"</k><p>:</p> <s>"{host}"</s><p>,</p>
             <k>"DB_PORT"</k><p>:</p> <s>"{port}"</s> <p>},</p>
    <k>"targets"</k><p>: {</p>
      <k>"local"</k><p>: {</p> <k>"service"</k><p>:</p> <s>"postgres"</s> <p>},</p>
      <k>"qa"</k><p>: {</p>
        <k>"hostname"</k><p>: {</p>
          <k>"env_ref"</k><p>:</p> <s>"REMOTE_DB_HOST"</s> <p>},</p>
        <k>"requires"</k><p>: [</p><s>"cloud"</s><p>],</p>
        <k>"via"</k><p>: {</p> <k>"kind"</k><p>:</p> <s>"aws-ssm"</s><p>,</p>
                 <k>"instance"</k><p>:</p> <s>"i-0123…"</s> <p>}</p>
      <p>}</p>
    <p>}</p>
  <p>}</p>
<p>}</p>`;

export const signInExpired = `<f>$</f> hack up --use db=qa
<a>!</a> cloud  <d>sign-in expired (aws-sso, example-dev)</d>
  <d>db (qa) needs it. run:</d>
  aws sso login --profile example-dev
  <f>run it now? [y/n]</f>`;

export const servicesTable = `<f>SERVICE  KIND    USE      POINTS AT                VIA   STATE</f>
web      local   -        myapp.hack.local         -     running
api      local   -        api.myapp.hack.local     -     running
jobs     local   -        <f>no address</f>               -     running
db       <a>remote</a>  qa       $REMOTE_DB_HOST:5432     ssm   healthy
billing  <a>remote</a>  staging  billing.staging.example  ssh   healthy

<f>5 services · 3 local · 2 remote</f>

<f>$</f> hack use db=local
<g>✓</g> <d>db → local · tunnel closed · api restarted ·</d> <f>${sample.useLocal.value}</f>

<f>$</f> hack use db=qa
<g>✓</g> <d>db → qa · tunnel up · api restarted ·</d> <f>${sample.useRemote.value}</f>

<f>$</f> hack doctor
<f>tunnels</f>
  <d>db (qa)</d>  aws ssm start-session … <f>→ 127.0.0.1:15432</f>`;

export const toolsConfig = `<k>"tools"</k><p>: {</p>
  <k>"runtime"</k><p>:   {</p> <k>"bins"</k><p>: [</p><s>"bun"</s><p>],</p> <k>"version"</k><p>:</p> <s>"pinned"</s><p>,</p> <k>"always"</k><p>:</p> <g>true</g> <p>},</p>
  <k>"cloud-cli"</k><p>: {</p> <k>"bins"</k><p>: [</p><s>"aws"</s><p>, </p><s>"session-manager-plugin"</s><p>],</p>
                 <k>"version"</k><p>:</p> <s>">=2.15"</s> <p>}</p>
<p>}</p>`;

export const toolMissing = `<f>$</f> hack up --use db=qa
<a>!</a> aws  <d>not found (cloud-cli)</d>
  <d>db (qa) needs it. run:</d>
  hack tools install cloud-cli

<f>$</f> hack tools install cloud-cli
<g>✓</g> <d>aws 2.19.4 · session-manager-plugin 1.2.7 · installed with mise ·</d> <f>8.2s</f>

<f>$</f> hack tools plan --format mise > mise.toml   <f># for a sandbox image</f>`;

export const agentsBefore = `## Connecting to the staging database
1. run aws sso login --profile dev  (expires daily)
2. run ./scripts/tunnel.sh staging  (needs the vpn)
3. export DATABASE_URL=postgres://localhost:6543/app
4. restart the api. remember to close the tunnel`;

export const agentCommit = `  <k>"remotes"</k><p>: {</p> <k>"db"</k><p>: {</p> <k>"targets"</k><p>: {</p>
    <k>"local"</k><p>: {</p> <k>"service"</k><p>:</p> <s>"postgres"</s> <p>},</p>
<c3>+   "qa": { "hostname": { "env_ref": "REMOTE_DB_HOST" },</c3>
<c3>+           "via": { "kind": "aws-ssm", "instance": "i-0123…" } }</c3>
  <p>} } }</p>

<f>$</f> hack config validate
<g>✓</g> <d>11 services · 3 remotes · REMOTE_DB_HOST set in qa, production</d>
<f>$</f> git commit -m "db: add the qa target"`;

export const hostExec = `<f>$</f> hack host exec --env production -- bun db:migrate
<a>?</a> db → live  <d>this target asks first. continue?</d> y
<g>✓</g> overlay   <d>production       </d><f>4 values differ from default</f>
<g>✓</g> secrets   <d>4 decrypted      </d><f>for this command only</f>
<g>✓</g> env       <d>9 values         </d><f>injected into the command</f>
<g>✓</g> db        <d>live             </d><f>tunnel up · ${sample.tunnelUp.value}</f>
<g>✓</g> migrate   <d>2 applied        </d><f>4.1s</f>
<g>✓</g> tunnel    <d>closed</d>`;

export const envList = `<f>NAME           SCOPE  FROM         VALUE</f>
API_URL        web    default      https://api.myapp.hack.local
LOG_LEVEL      all    production   warn
REMOTE_DB_HOST api    production   <a>encrypted</a>  <f>← remotes.db</f>
DATABASE_URL   api    production   <a>encrypted</a>
STRIPE_KEY     api    production   <a>encrypted</a>
SESSION_KEY    api    default      <a>encrypted</a>`;

export const worksWith = `<k>[x]</k> compose files   <d>read once, or run as they are</d>
<k>[x]</k> dockerfiles     <d>and any OCI image</d>
<k>[x]</k> any stack       <d>node, python, go, rust, php, ruby</d>
<k>[x]</k> macos           <d>apple silicon</d>
<k>[x]</k> linux           <d>x86_64 and arm64</d>
<k>[x]</k> docker          <d>optional. same config, your engine</d>
<k>[x]</k> agents          <d>claude code, codex, cursor</d>
<k>[x]</k> v4 projects     <d>same commands, same .hack folder</d>`;

export const logs = `<f>12:04:01</f> <g>api </g> listening on :4000
<f>12:04:01</f> <a>jobs</a> worker ready, 4 queues
<f>12:04:02</f> <g>web </g> ready in 812ms
<f>12:04:09</f> <g>api </g> GET /v1/session 200 14ms
<f>12:04:09</f> <g>api </g> POST /v1/search 200 61ms
<f>12:04:11</f> <a>jobs</a> index.refresh done 240ms`;

export const upJson = `<p>{</p>
  <k>"ok"</k><p>:</p> <g>true</g><p>,</p>
  <k>"data"</k><p>: {</p>
    <k>"branch"</k><p>:</p> <s>"agent/onboarding"</s><p>,</p>
    <k>"started"</k><p>: [</p><s>"db"</s><p>, </p><s>"api"</s><p>, </p><s>"jobs"</s><p>, </p><s>"web"</s><p>],</p>
    <k>"durationMs"</k><p>:</p> <a>${sample.warmStartMs.value}</a>
  <p>}</p>
<p>}</p>`;
