// Exercise the production sample transition and cadence with a monotonic fake
// clock. Networking and publication are covered by http-probe-host regressions.
#define main resident_probe_main
#include "../../guest/http-probe.c"
#undef main

int main(int argc, char **argv) {
    if (argc != 6) return 125;
    uint64_t grace = number(argv[1], 0, 3600000);
    uint64_t interval = number(argv[2], 10, 3600000);
    uint64_t timeout = number(argv[3], 1, 60000);
    uint64_t retries = number(argv[4], 1, 100);
    uint64_t ready_after = number(argv[5], 0, 3600000);
    uint64_t now = 0, failures = 0;
    int health = 2;
    bool ever_healthy = false;
    puts("0 2 0");
    while (now <= 300000) {
        uint64_t begun = now;
        bool success = begun >= ready_after;
        // A failed sample consumes the full reviewed request timeout.
        now += success ? 0 : timeout;
        sample_health(success, now, grace, retries, &failures, &health, &ever_healthy);
        printf("%llu %d %llu\n", (unsigned long long)now, health,
            (unsigned long long)failures);
        uint64_t next = begun + sample_period(true, ever_healthy, interval);
        if (next > now) now = next;
    }
    return 0;
}
