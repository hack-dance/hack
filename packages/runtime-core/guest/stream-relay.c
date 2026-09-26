#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <errno.h>
#include <dirent.h>
#include <limits.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#ifdef __linux__
#include <sched.h>
#include <sys/syscall.h>
#endif

#define CONNECTIONS 32
#define CAPACITY 16384
/* Guest CPU contention may delay the reservation ACK; bound it independently of stream idle. */
#define HANDSHAKE_TIMEOUT_MS 5000
struct flow {
    int fd[2], connecting, awaiting, publishing, eof[2], shut[2];
    size_t used[2];
    unsigned char data[2][CAPACITY];
    int64_t activity;
};
static struct flow flows[CONNECTIONS];
static volatile sig_atomic_t stopping;
static int target_watch = -1;
static int publish_mode, publish_unix;
static struct sockaddr_un frontend;
static struct sockaddr_un upstream;
static int wakeup[2] = {-1, -1};
static void stop(int signal_number) {
    (void)signal_number;
    int saved = errno;
    stopping = 1;
    /* A pending byte closes the signal-before-poll race, including idle listeners. */
    if (wakeup[1] >= 0) { ssize_t ignored = write(wakeup[1], "x", 1); (void)ignored; }
    errno = saved;
}
static int64_t now_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts)) return -1;
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static int64_t handshake_budget(long idle) {
    return idle < HANDSHAKE_TIMEOUT_MS ? idle : HANDSHAKE_TIMEOUT_MS;
}
static int configure(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0 ||
        fcntl(fd, F_SETFD, FD_CLOEXEC) < 0 ? -1 : 0;
}
static void release(struct flow *flow) {
    for (int side = 0; side < 2; side++) if (flow->fd[side] >= 0) close(flow->fd[side]);
    memset(flow, 0, sizeof(*flow));
    flow->fd[0] = flow->fd[1] = -1;
}
static int private_upstream(struct stat *value) {
    return lstat(upstream.sun_path, value) || !S_ISSOCK(value->st_mode) ||
        value->st_uid != geteuid() || (value->st_mode & 0077) || value->st_nlink != 1 ? -1 : 0;
}
static int private_parent(const char *path) {
    char parent[PATH_MAX];
    if (path[0] != '/' || strlen(path) >= sizeof(parent)) return -1;
    strcpy(parent, path);
    char *slash = strrchr(parent, '/');
    if (slash == parent || !slash[1]) return -1;
    *slash = 0;
    struct stat directory;
    return lstat(parent, &directory) || !S_ISDIR(directory.st_mode) ||
        directory.st_uid != geteuid() || (directory.st_mode & 0077) ? -1 : 0;
}
/* A receipt becomes authoritative only after both file and directory are durable. */
static int socket_receipt(const char *socket_path, const char *kind,
        const struct stat *socket_owned, const unsigned char *token,
        char *path, struct stat *owned, int *bound) {
    if (snprintf(path, PATH_MAX, "%s.identity", socket_path) >= PATH_MAX) return -1;
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) return -1;
    int failed = fstat(fd, owned) != 0;
    if (!failed) {
        *bound = 1;
        char value[256];
        int length = snprintf(value, sizeof(value), "%s %ld %" PRIuMAX " %" PRIuMAX " %.32s\n",
            kind, (long)getpid(), (uintmax_t)socket_owned->st_dev,
            (uintmax_t)socket_owned->st_ino, token);
        if (length <= 0 || length >= (int)sizeof(value) ||
            write(fd, value, (size_t)length) != length || fsync(fd)) failed = 1;
        char parent[PATH_MAX];
        strcpy(parent, socket_path); *strrchr(parent, '/') = 0;
        int directory = open(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (directory < 0 || fsync(directory)) failed = 1;
        if (directory >= 0) close(directory);
    }
    close(fd);
    return failed ? -1 : 0;
}
static int connect_target(struct flow *flow, const struct sockaddr_in *target) {
    struct stat before, after;
    if (publish_mode && private_upstream(&before)) return -1;
    flow->fd[1] = socket(publish_mode ? AF_UNIX : AF_INET, SOCK_STREAM, 0);
    if (flow->fd[1] < 0 || configure(flow->fd[1])) return -1;
    int connected = publish_mode
        ? connect(flow->fd[1], (const struct sockaddr *)&upstream, sizeof(upstream))
        : connect(flow->fd[1], (const struct sockaddr *)target, sizeof(*target));
    if (connected && errno != EINPROGRESS) return -1;
    if (publish_mode && (private_upstream(&after) || before.st_dev != after.st_dev || before.st_ino != after.st_ino)) return -1;
    flow->connecting = connected != 0;
    return 0;
}
static int number(const char *text, long limit, long *out) {
    char *end;
    if (!*text || strspn(text, "0123456789") != strlen(text)) return -1;
    errno = 0;
    long value = strtol(text, &end, 10);
    if (errno || *end || value < 1 || value > limit) return -1;
    *out = value;
    return 0;
}
static int close_inherited(void) {
#ifdef __linux__
    const char *path = "/proc/self/fd";
#else
    const char *path = "/dev/fd";
#endif
    DIR *directory = opendir(path);
    if (!directory) return -1;
    struct dirent *entry;
    while ((entry = readdir(directory))) {
        long fd;
        if (!number(entry->d_name, INT_MAX, &fd) && fd > 2 && fd != dirfd(directory))
            close((int)fd);
    }
    return closedir(directory);
}
#ifdef __linux__
static void process_path(char path[64], long pid, const char *suffix) {
    char digits[24];
    size_t cursor = sizeof(digits)-1;
    digits[cursor] = 0;
    do { digits[--cursor] = (char)('0' + pid % 10); pid /= 10; } while (pid);
    strcpy(path, "/proc/");
    strcat(path, digits+cursor);
    strcat(path, suffix);
}
static long process_start(long pid) {
    char path[64], buffer[4096];
    process_path(path, pid, "/stat");
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t size = read(fd, buffer, sizeof(buffer)-1);
    close(fd);
    if (size <= 0 || size == (ssize_t)sizeof(buffer)-1) return -1;
    buffer[size] = 0;
    char *tail = strrchr(buffer, ')'), *save = NULL;
    if (!tail) return -1;
    char *field = strtok_r(tail+1, " \n", &save);
    for (int index = 3; field && index < 22; index++) field = strtok_r(NULL, " \n", &save);
    long value;
    return field && !number(field, LONG_MAX, &value) ? value : -1;
}
#endif
/* Pin a network namespace and watch its init process without an idle polling timer. */
static int pin_target(long pid, long start) {
#ifdef __linux__
    if (pid <= 1 || process_start(pid) != start) return -1;
    int watch = (int)syscall(SYS_pidfd_open, (pid_t)pid, 0);
    if (watch < 0) return -1;
    char path[64];
    process_path(path, pid, "/ns/net");
    int ns = open(path, O_RDONLY | O_CLOEXEC);
    struct stat target_ns, current_ns;
    struct pollfd observed = {watch, POLLIN, 0};
    int failed = ns < 0 || fstat(ns, &target_ns) || stat("/proc/self/ns/net", &current_ns) ||
        (target_ns.st_dev == current_ns.st_dev && target_ns.st_ino == current_ns.st_ino) ||
        process_start(pid) != start || poll(&observed, 1, 0) != 0 || setns(ns, CLONE_NEWNET);
    if (ns >= 0) close(ns);
    if (!failed) failed = process_start(pid) != start || poll(&observed, 1, 0) != 0;
    if (failed) { close(watch); return -1; }
    target_watch = watch;
    return 0;
#else
    (void)pid; (void)start;
    return -1;
#endif
}
/* Never signal a numeric PID: retain the process handle through identity checks and exit. */
static int stop_owned(long pid, long start) {
#ifdef __linux__
    if (pid <= 1 || pid == (long)getpid() || process_start(pid) != start) return 78;
    int watch = (int)syscall(SYS_pidfd_open, (pid_t)pid, 0);
    if (watch < 0) return 78;
    char path[64];
    process_path(path, pid, "/exe");
    struct stat target_exe, self_exe;
    struct pollfd observed = {watch, POLLIN, 0};
    int refused = stat(path, &target_exe) || stat("/proc/self/exe", &self_exe) ||
        target_exe.st_dev != self_exe.st_dev || target_exe.st_ino != self_exe.st_ino ||
        process_start(pid) != start || poll(&observed, 1, 0) != 0;
    if (refused) { close(watch); return 78; }
    if (syscall(SYS_pidfd_send_signal, watch, SIGTERM, NULL, 0)) { close(watch); return 78; }
    int64_t deadline = now_ms();
    if (deadline < 0) { close(watch); return 70; }
    deadline += 5000;
    int result = 70;
    for (;;) {
        int64_t now = now_ms();
        if (now < 0 || now >= deadline) break;
        int ready = poll(&observed, 1, (int)(deadline-now));
        if (ready > 0) { if (observed.revents & POLLIN) result = 0; break; }
        if (ready == 0 || errno != EINTR) break;
    }
    close(watch);
    return result;
#else
    (void)pid; (void)start;
    return 78;
#endif
}
int main(int argc, char **argv) {
    char *publish_args[8];
    struct sockaddr_un control = {0};
    struct stat control_owned, receipt_owned, frontend_receipt_owned;
    char receipt_path[PATH_MAX] = {0};
    int receipt_bound = 0, frontend_receipt_bound = 0;
    char frontend_receipt_path[PATH_MAX] = {0};
    unsigned char stop_message[39] = {0};
    int control_fd = -1, control_bound = 0;
    if (argc >= 2 && (!strcmp(argv[1], "--publish") || !strcmp(argv[1], "--publish-unix"))) {
        publish_unix = !strcmp(argv[1], "--publish-unix");
        if (argc != 6 && argc != 9) return 64;
        if (argc == 9) {
            if (strcmp(argv[6], "--control") || argv[7][0] != '/' ||
                strlen(argv[7]) >= sizeof(control.sun_path) || strlen(argv[8]) != 32 ||
                strspn(argv[8], "0123456789abcdef") != 32) return 64;
            control.sun_family = AF_UNIX;
            strcpy(control.sun_path, argv[7]);
            char parent[sizeof(control.sun_path)];
            strcpy(parent, argv[7]);
            char *slash = strrchr(parent, '/');
            if (slash == parent || !slash[1]) return 64;
            *slash = 0;
            struct stat directory;
            if (lstat(parent, &directory) || !S_ISDIR(directory.st_mode) ||
                directory.st_uid != geteuid() || (directory.st_mode & 0077)) return 78;
            memcpy(stop_message, "HKSTOP1", 7); memcpy(stop_message+7, argv[8], 32);
        }
        if (publish_unix) {
            if (argv[2][0] != '/' || strlen(argv[2]) >= sizeof(frontend.sun_path)) return 64;
            if (private_parent(argv[2])) return 78;
            frontend.sun_family = AF_UNIX; strcpy(frontend.sun_path, argv[2]);
        }
        /* Both publishers share upstream parsing; the Unix frontend has no TCP port. */
        publish_args[0] = argv[0]; publish_args[1] = argv[3];
        publish_args[2] = "127.0.0.1"; publish_args[3] = publish_unix ? "1" : argv[2];
        publish_args[4] = argv[5]; publish_args[5] = "--reservation";
        publish_args[6] = argv[4]; publish_args[7] = NULL;
        argv = publish_args; argc = 7; publish_mode = 1;
    }
    if (argc >= 2 && !strcmp(argv[1], "--stop")) {
        long pid, start;
        if (argc != 4 || number(argv[2], INT_MAX, &pid) || number(argv[3], LONG_MAX, &start)) return 64;
        if (close_inherited()) return 70;
        return stop_owned(pid, start);
    }
    struct sockaddr_un local = {0};
    struct sockaddr_in target = {0};
    struct stat owned, current;
    long port, idle, target_pid = 0, target_start = 0;
    if (argc < 5 || argv[1][0] != '/' || strlen(argv[1]) >= sizeof(local.sun_path) ||
        number(argv[3], 65535, &port) || number(argv[4], 60000, &idle) ||
        inet_pton(AF_INET, argv[2], &target.sin_addr) != 1) return 64;
    int option = 5;
    if (argc >= 8 && !strcmp(argv[5], "--netns")) {
        if (number(argv[6], INT_MAX, &target_pid) || number(argv[7], LONG_MAX, &target_start) ||
            strcmp(argv[2], "127.0.0.1")) return 64;
        option = 8;
    }
    unsigned char header[36] = {0};
    int guarded = 0;
    if (argc == option+2 && !strcmp(argv[option], "--reservation")) {
        const char *token = argv[option+1];
        if (strlen(token) != 32 || strspn(token, "0123456789abcdef") != 32) return 64;
        memcpy(header, "HKR1", 4); memcpy(header+4, token, 32);
        guarded = 1; option += 2;
    }
    if (argc != option) return 64;
    target.sin_family = AF_INET;
    target.sin_port = htons((uint16_t)port);
    local.sun_family = AF_UNIX;
    memcpy(local.sun_path, argv[1], strlen(argv[1]) + 1);
    if (publish_mode) { upstream = local; if (private_upstream(&current)) return 78; }
    if (close_inherited()) return 70;
    if (target_pid && pin_target(target_pid, target_start)) return 78;
    if (pipe(wakeup) || configure(wakeup[0]) || configure(wakeup[1])) return 70;
    struct sigaction action = {0};
    action.sa_handler = stop;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) return 70;
    signal(SIGPIPE, SIG_IGN);
    for (int i = 0; i < CONNECTIONS; i++) flows[i].fd[0] = flows[i].fd[1] = -1;
    int listener = socket(publish_mode && !publish_unix ? AF_INET : AF_UNIX, SOCK_STREAM, 0);
    const char *listen_path = publish_unix ? frontend.sun_path : (publish_mode ? NULL : argv[1]);
    if (listener < 0) return 70;
    umask(0077);
    int reuse = 1;
    if (publish_mode && !publish_unix && setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse))) { close(listener); return 70; }
    const struct sockaddr *address = publish_unix ? (struct sockaddr *)&frontend :
        (publish_mode ? (struct sockaddr *)&target : (struct sockaddr *)&local);
    socklen_t address_size = publish_mode && !publish_unix ? sizeof(target) : sizeof(local);
    if (configure(listener) || bind(listener, address, address_size)) {
        close(listener);
        return 73;
    }
    if (listen_path && lstat(listen_path, &owned)) { close(listener); return 73; }
    int failed = listen(listener, CONNECTIONS) != 0;
    if (!failed && publish_unix && socket_receipt(frontend.sun_path, "HKPF1", &owned,
            header+4, frontend_receipt_path, &frontend_receipt_owned, &frontend_receipt_bound)) failed = 1;
    if (!failed && control.sun_family) {
        control_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
        if (control_fd < 0 || configure(control_fd) ||
            bind(control_fd, (struct sockaddr *)&control, sizeof(control))) failed = 1;
        else if (lstat(control.sun_path, &control_owned)) failed = 1;
        else control_bound = 1;
        if (!failed) {
            if (socket_receipt(control.sun_path, "HKPC1", &control_owned, stop_message+7,
                    receipt_path, &receipt_owned, &receipt_bound)) failed = 1;
        }
    }
    if (!failed) { puts("ready"); fflush(stdout); }
    while (!stopping && !failed) {
        struct pollfd descriptors[4 + 2 * CONNECTIONS];
        descriptors[3 + 2 * CONNECTIONS] = (struct pollfd){control_fd, POLLIN, 0};
        descriptors[2 + 2 * CONNECTIONS] = (struct pollfd){target_watch, POLLIN, 0};
        descriptors[1 + 2 * CONNECTIONS] = (struct pollfd){wakeup[0], POLLIN, 0};
        descriptors[0] = (struct pollfd){listener, POLLIN, 0};
        int timeout = -1;
        int64_t now = now_ms();
        if (now < 0) { failed = 1; break; }
        for (int i = 0; i < CONNECTIONS; i++) {
            struct flow *flow = &flows[i];
            if (flow->fd[0] >= 0) {
                int64_t budget = flow->awaiting || flow->publishing ? handshake_budget(idle) : idle;
                int64_t remaining = budget - (now - flow->activity);
                if (remaining <= 0) release(flow);
                else if (timeout < 0 || remaining < timeout) timeout = (int)remaining;
            }
            for (int side = 0; side < 2; side++) {
                short events = 0;
                if (flow->fd[side] >= 0) {
                    if (flow->awaiting) events = side == 0 ? POLLIN : 0;
                    else if (flow->connecting) events = side == 1 ? POLLOUT : 0;
                    else if (flow->publishing) events = side == 1 ? (flow->publishing == 1 ? POLLOUT : POLLIN) : 0;
                    else {
                        if (!flow->eof[side] && flow->used[side] < CAPACITY) events |= POLLIN;
                        if (flow->used[1-side]) events |= POLLOUT;
                    }
                }
                descriptors[1 + i*2 + side] = (struct pollfd){events ? flow->fd[side] : -1, events, 0};
            }
        }
        int result = poll(descriptors, 4 + 2*CONNECTIONS, timeout);
        if (result < 0) { if (errno == EINTR) continue; failed = 1; break; }
        if (stopping || descriptors[2 + 2*CONNECTIONS].revents) break;
        if (descriptors[3 + 2*CONNECTIONS].revents & (POLLERR | POLLHUP | POLLNVAL)) { failed = 1; break; }
        if (descriptors[3 + 2*CONNECTIONS].revents & POLLIN) {
            unsigned char message[sizeof(stop_message)+1];
            ssize_t size = recv(control_fd, message, sizeof(message), 0);
            if (size == (ssize_t)sizeof(stop_message) && !memcmp(message, stop_message, sizeof(stop_message))) break;
        }
        /* Process only descriptors from this poll before accepting new flows. */
        for (int i = 0; i < CONNECTIONS; i++) {
            struct flow *flow = &flows[i];
            if (flow->fd[0] < 0) continue;
            for (int side = 0; side < 2 && flow->fd[0] >= 0; side++) {
                short events = descriptors[1 + i*2 + side].revents;
                if (!events) continue;
                if (flow->awaiting) {
                    if (now_ms()-flow->activity >= handshake_budget(idle)) { release(flow); break; }
                    if (events & (POLLERR | POLLNVAL)) { release(flow); break; }
                    if (side == 0 && (events & (POLLIN | POLLHUP))) {
                        ssize_t n = recv(flow->fd[0], flow->data[0]+flow->used[0],
                            sizeof(header)-flow->used[0], 0);
                        if (n > 0) {
                            flow->used[0] += (size_t)n;
                            if (memcmp(flow->data[0], header, flow->used[0])) { release(flow); break; }
                            if (flow->used[0] == sizeof(header)) {
                                flow->awaiting = 0; flow->used[0] = 0;
                                flow->data[1][0] = 1; flow->used[1] = 1;
                                flow->activity = now_ms();
                                if (connect_target(flow, &target)) { release(flow); break; }
                            }
                        } else if (!n || (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK)) {
                            release(flow); break;
                        }
                    }
                    continue;
                }
                if (flow->connecting && side == 1) {
                    int error = 0;
                    socklen_t length = sizeof(error);
                    if (getsockopt(flow->fd[1], SOL_SOCKET, SO_ERROR, &error, &length) || error) release(flow);
                    else flow->connecting = 0;
                    continue;
                }
                if (flow->publishing) {
                    int64_t checked = now_ms();
                    if (checked < 0 || checked-flow->activity >= handshake_budget(idle) ||
                        (events & (POLLERR | POLLNVAL))) { release(flow); break; }
                    if (flow->publishing == 1 && (events & POLLOUT)) {
                        ssize_t n = send(flow->fd[1], flow->data[0], flow->used[0], 0);
                        if (n > 0) {
                            flow->used[0] -= (size_t)n;
                            memmove(flow->data[0], flow->data[0]+n, flow->used[0]);
                            if (!flow->used[0]) flow->publishing = 2;
                        } else if (n < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) { release(flow); break; }
                    } else if (flow->publishing == 2 && (events & (POLLIN | POLLHUP))) {
                        unsigned char ack;
                        ssize_t n = recv(flow->fd[1], &ack, 1, 0);
                        if (n == 1 && ack == 1) { flow->publishing = 0; flow->activity = now_ms(); }
                        else if (n >= 0 || (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK)) { release(flow); break; }
                    } else if (events & POLLHUP) { release(flow); break; }
                    continue;
                }
                if (events & (POLLERR | POLLNVAL)) { release(flow); break; }
                if ((events & POLLOUT) && flow->used[1-side]) {
                    ssize_t n = send(flow->fd[side], flow->data[1-side], flow->used[1-side], 0);
                    if (n > 0) {
                        flow->used[1-side] -= (size_t)n;
                        memmove(flow->data[1-side], flow->data[1-side]+n, flow->used[1-side]);
                        flow->activity = now_ms();
                    } else if (n < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) { release(flow); break; }
                }
                if ((events & (POLLIN | POLLHUP)) && !flow->eof[side] && flow->used[side] < CAPACITY) {
                    ssize_t n = recv(flow->fd[side], flow->data[side]+flow->used[side], CAPACITY-flow->used[side], 0);
                    if (n > 0) { flow->used[side] += (size_t)n; flow->activity = now_ms(); }
                    else if (!n) flow->eof[side] = 1;
                    else if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) { release(flow); break; }
                }
            }
            if (flow->fd[0] < 0) continue;
            for (int side = 0; side < 2; side++) {
                if (flow->eof[side] && !flow->used[side] && !flow->shut[1-side]) {
                    shutdown(flow->fd[1-side], SHUT_WR);
                    flow->shut[1-side] = 1;
                }
            }
            if (flow->eof[0] && flow->eof[1] && !flow->used[0] && !flow->used[1]) release(flow);
        }
        if (descriptors[0].revents & (POLLERR | POLLHUP | POLLNVAL)) { failed = 1; break; }
        if (descriptors[0].revents & POLLIN) {
            for (int accepted = 0; accepted < CONNECTIONS; accepted++) {
                int client = accept(listener, NULL, NULL);
                if (client < 0) break;
                int index;
                for (index = 0; index < CONNECTIONS && flows[index].fd[0] >= 0; index++) {}
                if (index == CONNECTIONS || configure(client)) { close(client); continue; }
                struct flow *flow = &flows[index];
                flow->fd[0] = client;
                flow->awaiting = guarded && !publish_mode;
                if (publish_mode) { flow->publishing = 1; memcpy(flow->data[0], header, sizeof(header)); flow->used[0] = sizeof(header); }
                if (!flow->awaiting && connect_target(flow, &target)) { release(flow); continue; }
                flow->activity = now_ms();
            }
        }
    }
    close(listener);
    if (control_fd >= 0) close(control_fd);
    if (control_bound && !lstat(control.sun_path, &current) && S_ISSOCK(current.st_mode) &&
        current.st_dev == control_owned.st_dev && current.st_ino == control_owned.st_ino) unlink(control.sun_path);
    if (receipt_bound && !lstat(receipt_path, &current) && S_ISREG(current.st_mode) &&
        current.st_dev == receipt_owned.st_dev && current.st_ino == receipt_owned.st_ino) unlink(receipt_path);
    for (int i = 0; i < CONNECTIONS; i++) release(&flows[i]);
    if (listen_path && !lstat(listen_path, &current) && S_ISSOCK(current.st_mode) &&
        owned.st_dev == current.st_dev && owned.st_ino == current.st_ino) unlink(listen_path);
    if (frontend_receipt_bound && !lstat(frontend_receipt_path, &current) && S_ISREG(current.st_mode) &&
        current.st_dev == frontend_receipt_owned.st_dev && current.st_ino == frontend_receipt_owned.st_ino)
        unlink(frontend_receipt_path);
    if (target_watch >= 0) close(target_watch);
    close(wakeup[0]);
    close(wakeup[1]);
    return failed ? 70 : 0;
}
