# macOS browser cannot reach a local service

A successful terminal request does not prove that a browser can reach the same
service. On macOS 15 and later, Local Network access is controlled per application;
Apple exempts command-line tools launched from Terminal or SSH. See Apple's
[Local Network privacy explanation](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
and [permission settings guide](https://support.apple.com/guide/mac-help/mchla4f49138/mac).

## `.local` names need a one-time grant outside Safari

New projects use `<project>.hack.local` by default. macOS applies Local Network
privacy by name as well as by address: Apple's TN3179 treats a `.local` lookup
as local network activity because `.local` is the multicast DNS (Bonjour)
namespace. A browser that opens `https://my-app.hack.local` therefore needs
Local Network access, even though Hack's resolver answers with a loopback
address.

- **Safari** opens `.local` names without this permission.
- **Chrome, Firefox and other browsers** need it once per app. macOS asks the
  first time; if you declined, enable it in **System Settings → Privacy &
  Security → Local Network**, then fully quit and reopen the browser.

On macOS, Hack prints one hint line on stderr when a command opens or prints a
`.local` browser URL (`hack open`, `hack branch open`, `hack status` and
`hack projects`, and Doctor's browser check). The hint is shown at most once per
command and never appears inside `--json` output. Hack does not read, request or
change this permission for you.

If you prefer not to grant the permission, use a name outside `.local`:

- **OAuth alias:** enable `oauth.enabled` (or `hack init --oauth`) and open the
  project's `<project>.hack.gy` alias. `hack open` prefers it automatically;
  `hack open --prefer alias` requires it.
- **Custom suffix:** choose a dedicated suffix under `hack.gy`, for example
  `dev.hack.gy`. With the native candidate, run
  `hack global dns preview --domain dev.hack.gy` and then
  `hack global dns activate --domain dev.hack.gy`
  (see [native candidate DNS](native-candidate.md)). With the Docker-backed
  stack, set `hack config set --global default_domain <suffix>` and run
  `hack global install` (see [Initialize a project](init-project.md)).
  Existing project hosts are not migrated automatically.

Avoiding `.local` avoids only the name-based rule. Address-based checks still
apply, so verify the exact origin in the browser as described below.

## Diagnose a browser failure

Run `hack doctor` first. DNS, resolver, Caddy, project services and certificate trust
have separate checks. The browser check remains unverified until you report an
observation; Doctor does not read the browser's permissions or its private data.

## Compare the same URL

Open your local service URL in the affected browser, then report what you observed:

```sh
hack doctor --browser-url https://admin.my-project.hack.local --browser-result fails
```

Use your actual hostname, including a legacy or custom domain if configured. The
URL must be an HTTPS origin (no path beyond `/`, credentials, query or fragment).
Choose a safe, read-only root page that needs no authentication. Doctor makes a bounded request with
normal certificate verification, without browser cookies or following redirects.

`--browser-result` accepts:

| Value | Observation |
| --- | --- |
| `unknown` | You have not checked the browser yet (the default). |
| `works` | The same URL loaded successfully in the affected browser. |
| `fails` | The browser failed; the cause is unknown. |
| `permission-denied` | You observed a Local Network denial or confirmed that the affected app's permission is off. |

If CLI HTTPS succeeds while the browser fails, Doctor identifies a browser-specific
boundary and suggests checking Local Network access. This is a possible cause, not
proof: browser certificate state, proxy settings or extensions can also differ.
A CLI DNS, TLS, connection, redirect or unsuccessful HTTP response keeps the comparison
ambiguous; address those findings before attributing the failure to privacy.
A redirect response proves only that the original endpoint responded, not that
its destination works. Browser results are your report, not an automated test.

## Recover and verify in the browser

1. Open **System Settings → Privacy & Security → Local Network** and inspect the
   affected browser or app. If access is disabled and you intend to allow it,
   enable that app's access yourself.
2. Fully quit and reopen that browser, then open the **same URL** again. If it
   works, rerun the command with `--browser-result works` to record the recheck.
3. If it still fails, retain the exact browser error and compare Doctor's other
   findings. Certificate errors need the
   [macOS certificate trust checks](macos-certificate-trust.md). If the app is
   absent from Local Network settings, absence alone does not establish denial.

Doctor, including `--fix`, does not change these privacy settings or restart your
browser. Do not disable TLS verification, reset system privacy databases or turn
off network security to make the diagnostic pass. The check is macOS-specific;
other platforms report it as not applicable.
