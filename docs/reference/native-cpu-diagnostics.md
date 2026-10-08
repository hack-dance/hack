# Passive CLI CPU diagnostics

An optional diagnostic launcher may preopen an empty report file and set
`HACK_NATIVE_CPU_REPORT_FD` to its inherited descriptor, from 3 through 255. The
descriptor must refer to the launcher's exact regular file, owned by the current
user, with mode `0600`, one link and zero bytes. The CLI admits that identity once
and checks it again before one final write capped at 512 KiB. It never creates, truncates,
renames or removes a report path. The launcher owns the descriptor and private
report directory. This bounds bytes and attempts, not filesystem latency or
durability. The outer launcher must enforce its own deadline and reap the CLI;
admitting a regular descriptor does not promise a blocked write cannot delay exit.

This capability is opt-in and fails open for the command. Missing, invalid,
changed or unwritable report descriptors do not replace the product's result or
trigger runtime cleanup. The launch-only environment variable is consumed before
ordinary children inherit the CLI environment, so a nested CLI cannot arm a
reused descriptor from that flag. The descriptor transport control proves the
original descriptor and a bounded remap scan through 255; it does not claim
general closure of every possible descriptor.

The version 1 JSON report contains cumulative process CPU since birth, the CLI
exit status, registration counts and numeric child observations. Each child has
one sequence number, a fixed `compiler`, `docker`, `compose`, `other` or
`unclassified` category, its actual reaped exit status, CPU milliseconds and
maximum resident bytes. It contains no command arguments, environment values,
process IDs, executable paths, resource identities or subprocess output. Existing
command callbacks retain their ordering and reuse the same usage sample.

Compiler and ownership probes observe usage after their existing streams and
exit cleanup finish. Noninteractive shell commands and lock-owner inspections
also register their existing child completions. TTY supervisors, internal HTTPS
owners and uninstrumented spawn paths are outside this diagnostic scope. No new
probes, per-child files, clocks or synchronization calls are added.

`recordsComplete` means every registered child has exactly one usable numeric
observation and an explicit exit status. Missing, pending, duplicate,
unclassified or overflowing observations make it false. A known nonzero exit
can have complete accounting; this does not mean the command succeeded. Reports
are bounded to 2,048 registrations and 512 KiB without imposing limits on the
product workload.

The report alone does not prove complete process-tree accounting. A controlled
non-TTY experiment must independently compare cumulative self CPU plus child CPU
with a reaped outer `wait4` observation, prove waited descendants are included,
and refuse missing or excessive residual accounting. Quiet-host admission,
readiness, data correctness and exact owned cleanup remain separate requirements
for performance comparisons. These diagnostics establish attribution, not an
application, VM, or performance improvement claim.
