/* Owned fixture: ordinary application bytes only. Credentials remain on stdin
 * for the production child; this probe implements no relay or crypto protocol. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif

static volatile sig_atomic_t child_pid = -1;
static void expire(int signal_number) {
    (void)signal_number;
    if (child_pid > 0) kill((pid_t)child_pid, SIGKILL);
    _exit(124);
}
static int finish_child(void) {
    int status = 0;
    pid_t result;
    do { result = waitpid((pid_t)child_pid, &status, 0); } while (result < 0 && errno == EINTR);
    child_pid = -1;
    return result > 0 && WIFEXITED(status) ? WEXITSTATUS(status) : 125;
}
int main(int argc, char **argv) {
    if (argc != 2 || (strcmp(argv[1], "success") && strcmp(argv[1], "refuse"))) return 64;
    int expect_refusal = !strcmp(argv[1], "refuse");
    signal(SIGPIPE, SIG_IGN);
    signal(SIGALRM, expire);
    alarm(15);
    int sockets[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets)) return 65;
    pid_t parent = getpid();
    pid_t child = fork();
    if (child < 0) return 66;
    if (child == 0) {
#ifdef __linux__
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) _exit(126);
#else
        (void)parent;
#endif
        close(sockets[0]);
        if (sockets[1] != 3 && dup2(sockets[1], 3) < 0) _exit(126);
        if (sockets[1] != 3) close(sockets[1]);
        if (fcntl(3, F_SETFD, 0) < 0) _exit(126);
        int nullfd = open("/dev/null", O_WRONLY);
        if (nullfd < 0 || dup2(nullfd, STDOUT_FILENO) < 0 || dup2(nullfd, STDERR_FILENO) < 0) _exit(126);
        if (nullfd > 3) close(nullfd);
        signal(SIGALRM, SIG_DFL);
        alarm(14);
        execl("/tmp/hack-relay-guest", "hack-relay-guest", "--slot", "0", "--application-fd", "3", (char *)NULL);
        _exit(127);
    }
    child_pid = child;
    close(sockets[1]);
    close(STDIN_FILENO);
    unsigned char bytes[65536];
    for (size_t i = 0; i < sizeof(bytes); ++i) bytes[i] = (unsigned char)(i % 251);
    size_t sent = 0;
    int io_failed = 0;
    while (sent < sizeof(bytes)) {
        ssize_t n = write(sockets[0], bytes + sent, sizeof(bytes) - sent);
        if (n > 0) sent += (size_t)n;
        else if (n < 0 && errno == EINTR) continue;
        else { io_failed = 1; break; }
    }
    if (shutdown(sockets[0], SHUT_WR) && errno != ENOTCONN) io_failed = 1;
    size_t received = 0;
    unsigned char input[4096];
    int mismatch = 0;
    for (;;) {
        ssize_t n = read(sockets[0], input, sizeof(input));
        if (!n) break;
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { io_failed = 1; break; }
        for (ssize_t i = 0; i < n; ++i) {
            if (received >= sizeof(bytes) || input[i] != (unsigned char)(received % 251)) mismatch = 1;
            ++received;
        }
        if (received > sizeof(bytes)) break;
    }
    close(sockets[0]);
    int code = finish_child();
    alarm(0);
    if (expect_refusal) {
        if (code != 1 || received != 0) return 67;
        puts("production-guest-refused-v1");
        return 0;
    }
    if (code != 0 || io_failed || mismatch || sent != sizeof(bytes) || received != sizeof(bytes)) return 68;
    puts("production-guest-echo-v1");
    return 0;
}
