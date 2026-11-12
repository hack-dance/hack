# Native startup test distribution

The startup fixture tests are split across three files so CI can schedule their
cases independently. Each file creates its own harness from
`tests/helpers/native-authored-start-fixture.ts`: case ownership, temporary
roots, environment restoration and settlement stay local to that harness. Each
file also drains its own overrun bodies and their owned cleanup at teardown.
Importing the helper registers no tests.

The original file passed 62 macOS cases in 9m05s in
[CI run 43135239769](https://github.com/hack-dance/hack/actions/runs/43135239769).
The reported case times total 544.79 seconds. The cost is distributed across
real fixture start/stop cycles: the slowest cancellation case took 57.43 seconds,
and persistent-process and hook-retirement cases took 42–48 seconds. Two cases
also deliberately exceed the compiler's ten-second default deadline. Those
waits, assertions, ownership guards and case budgets are preserved.

Registration blocks were balanced using those recorded case times. Their sums
are approximately 181.41, 181.99 and 181.41 seconds; the shard duration table
uses 182-second estimates. These are sums of unchanged historical cases, not
measured durations of the new files. Extra process/module startup and actual
host load remain to be measured. Splitting changes scheduling; it does not
claim lower runner-minutes or a shorter full Docker-bound CI run.

The partition preserves all 49 test-registration sites, including loops that
expand to the measured cases and platform-conditional cases. Test registration
ASTs were compared before and after extraction. The lifecycle and recovery
files retain the existing macOS pool classification through their shared helper.
Full pushes still discover and run every file exactly once.

Local Linux checks cover the portable cases, source/registration preservation,
typechecking and shard coverage. macOS-only cases skip on Linux. A successful
hosted macOS run is still required to qualify their behavior and new timing;
this change does not qualify a real VM on an Apple Silicon machine.
