# Manage helpers and tunnels

Use a lifecycle process when the project needs a long-running host helper, such as
a development tunnel or database proxy. Use an up-before hook for a finite setup
or authentication check. This makes the dependency visible in project configuration
instead of relying on an extra terminal tab.

Read [Lifecycle](../../lifecycle.md) for this version's concrete configuration
schema and examples. Keep tool installation separate from login: a cloud SSO login
may require the person to complete its browser flow, and credentials must not be
committed or printed. Check the approved CLI profile and target before starting a
tunnel. A listener existing on a port does not prove it is the correct tunnel.

Native host processes and host hooks get the shell's environment plus the
project's selected values, with one exception: an inherited variable whose name
is not a portable identifier (letters, digits and `_`, not starting with a digit)
is not passed on. Bash creates such names for exported functions (`export -f
name` sets `BASH_FUNC_name%%`), so `hack up` from that shell starts normally, but
the helper does not inherit the function; define it in the helper's own script.
A project configuration that sets such a name is refused before anything starts,
and the error names the variable. `hack host exec` still passes the shell's
environment on unchanged, and `hack run` is unaffected.

Declare readiness and ownership using the supported lifecycle contract. Reuse an
existing healthy listener only when the configuration explicitly supports adoption;
shutdown must preserve externally owned processes. Confirm the helper's expected
connection and the app's health after startup. No tunnel, public endpoint or cloud
login is created by reading this guide.
