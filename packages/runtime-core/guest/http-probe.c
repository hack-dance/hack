#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stopping;
static void stop(int signal_number) { (void)signal_number; stopping = 1; }
static uint64_t millis(clockid_t clock) {
    struct timespec value;
    if (clock_gettime(clock, &value) || value.tv_sec < 0) _exit(125);
    return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000;
}
static uint64_t number(const char *text, uint64_t min, uint64_t max) {
    if (!*text) _exit(125);
    uint64_t n = 0;
    for (; *text; text++) {
        if (*text < '0' || *text > '9' || n > (max - (*text - '0')) / 10) _exit(125);
        n = n * 10 + (*text - '0');
    }
    if (n < min || n > max) _exit(125);
    return n;
}
static bool wait_socket(int fd, short events, uint64_t deadline) {
    while (!stopping) {
        uint64_t now = millis(CLOCK_MONOTONIC);
        if (now >= deadline) return false;
        struct pollfd p = {.fd = fd, .events = events};
        int result = poll(&p, 1, (int)(deadline - now));
        if (result < 0 && errno == EINTR) continue;
        return result > 0 && (p.revents & (events | POLLHUP)) && !(p.revents & (POLLERR | POLLNVAL));
    }
    return false;
}
static bool request(int port, const char *path, uint64_t timeout) {
    uint64_t deadline = millis(CLOCK_MONOTONIC) + timeout;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return false;
    bool ok = false;
    if (fcntl(fd, F_SETFL, O_NONBLOCK) || fcntl(fd, F_SETFD, FD_CLOEXEC)) goto done;
    struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons((uint16_t)port)};
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
        if (errno != EINPROGRESS || !wait_socket(fd, POLLOUT, deadline)) goto done;
        int error = 0;
        socklen_t size = sizeof(error);
        if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) || error) goto done;
    }
    char message[1024];
    int length = snprintf(message, sizeof(message), "GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nConnection: close\r\n\r\n", path, port);
    if (length < 0 || (size_t)length >= sizeof(message)) goto done;
    size_t sent = 0;
    while (sent < (size_t)length) {
        if (!wait_socket(fd, POLLOUT, deadline)) goto done;
        ssize_t n = send(fd, message + sent, (size_t)length - sent, 0);
        if (n < 0 && (errno == EAGAIN || errno == EINTR)) continue;
        if (n <= 0) goto done;
        sent += (size_t)n;
    }
    char headers[8193];
    size_t used = 0;
    while (used < sizeof(headers) - 1) {
        if (!wait_socket(fd, POLLIN, deadline)) goto done;
        ssize_t n = recv(fd, headers + used, sizeof(headers) - 1 - used, 0);
        if (n < 0 && (errno == EAGAIN || errno == EINTR)) continue;
        if (n <= 0) goto done;
        size_t end = used + (size_t)n;
        bool complete = false;
        while (used < end) {
            if (!headers[used++]) goto done;
            if (used >= 4 && !memcmp(headers + used - 4, "\r\n\r\n", 4)) { complete = true; break; }
        }
        if (complete) {
            ok = used >= 16 && (!memcmp(headers, "HTTP/1.1 ", 9) || !memcmp(headers, "HTTP/1.0 ", 9)) &&
                headers[9] == '2' && headers[10] >= '0' && headers[10] <= '9' &&
                headers[11] >= '0' && headers[11] <= '9' && headers[12] == ' ';
            goto done;
        }
    }
done:
    close(fd);
    return ok && !stopping;
}
static bool private_regular(int fd) {
    struct stat st;
    return !fstat(fd, &st) && S_ISREG(st.st_mode) && st.st_uid == geteuid() &&
        (st.st_mode & 0777) == 0600 && st.st_nlink == 1;
}
static bool publish(int directory, const char *generation, uint64_t sequence, int health, uint64_t failures, uint64_t elapsed) {
    int fd = openat(directory, "status.pending", O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0 || !private_regular(fd)) { if (fd >= 0) close(fd); return false; }
    char line[256];
    int length = snprintf(line, sizeof(line), "v1 %s %llu %d %llu %llu %llu\n", generation,
        (unsigned long long)sequence, health, (unsigned long long)failures,
        (unsigned long long)millis(CLOCK_REALTIME), (unsigned long long)elapsed);
    bool ok = length > 0 && (size_t)length < sizeof(line) && write(fd, line, (size_t)length) == length;
    if (close(fd)) ok = false;
    // Ephemeral status is atomically replaced, never a durable readiness receipt.
    return ok && !renameat(directory, "status.pending", directory, "status");
}
int main(int argc, char **argv) {
    if (argc != 9) return 125;
    int port = (int)number(argv[1], 1, 65535);
    size_t path_length = strlen(argv[2]);
    if (!path_length || path_length > 512 || argv[2][0] != '/') return 125;
    for (size_t i = 0; i < path_length; i++) if (argv[2][i] <= 32 || argv[2][i] >= 127 || argv[2][i] == '#') return 125;
    uint64_t interval = number(argv[3], 10, 3600000);
    uint64_t timeout = number(argv[4], 1, 60000);
    uint64_t retries = number(argv[5], 1, 100);
    uint64_t grace = number(argv[6], 0, 3600000);
    if (strlen(argv[8]) != 32) return 125;
    for (int i = 0; i < 32; i++) if (!((argv[8][i] >= '0' && argv[8][i] <= '9') || (argv[8][i] >= 'a' && argv[8][i] <= 'f'))) return 125;
    struct rlimit core = {.rlim_cur = 0, .rlim_max = 0};
    if (setrlimit(RLIMIT_CORE, &core)) return 125;
    umask(0077);
    struct sigaction action = {.sa_handler = stop};
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) return 125;
    action.sa_handler = SIG_IGN;
    if (sigaction(SIGPIPE, &action, NULL)) return 125;
    int directory = open(argv[7], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat st;
    if (directory < 0 || fstat(directory, &st) || st.st_uid != geteuid() || (st.st_mode & 0777) != 0700) return 125;
    int lock = openat(directory, "lock", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (lock < 0 || !private_regular(lock) || flock(lock, LOCK_EX | LOCK_NB)) return 125;
    // A generation can start once only; restart must supply a fresh tmpfs directory.
    if (fstatat(directory, "status", &st, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) return 125;
    uint64_t start = millis(CLOCK_MONOTONIC), sequence = 0, failures = 0;
    int health = 2;
    bool ever_healthy = false;
    if (!publish(directory, argv[8], sequence, health, failures, 0)) return 125;
    while (!stopping) {
        uint64_t begun = millis(CLOCK_MONOTONIC);
        bool success = request(port, argv[2], timeout);
        if (stopping) break;
        uint64_t finished = millis(CLOCK_MONOTONIC);
        if (success) { failures = 0; health = 1; ever_healthy = true; }
        else if (ever_healthy || finished - start >= grace) {
            if (failures < retries) failures++;
            if (failures >= retries) health = 0;
        }
        if (!publish(directory, argv[8], ++sequence, health, failures, finished - begun)) return 125;
        uint64_t next = begun + interval;
        while (!stopping && millis(CLOCK_MONOTONIC) < next) {
            uint64_t delay = next - millis(CLOCK_MONOTONIC);
            if (delay > interval) break;
            struct timespec pause = {.tv_sec = (time_t)(delay / 1000), .tv_nsec = (long)(delay % 1000) * 1000000};
            if (nanosleep(&pause, NULL) && errno != EINTR) return 125;
        }
    }
    close(lock);
    close(directory);
    return 0;
}
