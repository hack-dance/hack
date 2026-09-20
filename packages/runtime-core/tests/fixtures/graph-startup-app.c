/* Graph application: readiness is impossible until its first dependency succeeds. */
#include <arpa/inet.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
static int bounded(int fd) {
    struct timeval timeout = {5, 0};
    return setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) ||
           setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
}
static int connect_port(unsigned short port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(port);
    if (bounded(fd) || connect(fd, (struct sockaddr *)&address, sizeof(address))) {
        close(fd); return -1;
    }
    return fd;
}
static int send_all(int fd, const unsigned char *bytes, size_t size) {
    size_t used = 0;
    while (used < size) {
        ssize_t n = write(fd, bytes + used, size - used);
        if (n > 0) used += (size_t)n;
        else if (n < 0 && errno == EINTR) continue;
        else return -1;
    }
    return 0;
}
static int dependency(unsigned short port) {
    int fd = connect_port(port);
    if (fd < 0) return 70;
    unsigned char payload[65536], input[4096];
    for (size_t i = 0; i < sizeof(payload); ++i) payload[i] = (unsigned char)(i % 251);
    if (send_all(fd, payload, sizeof(payload)) || shutdown(fd, SHUT_WR)) { close(fd); return 71; }
    size_t received = 0;
    for (;;) {
        ssize_t n = read(fd, input, sizeof(input));
        if (!n) break;
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { close(fd); return 72; }
        for (ssize_t i = 0; i < n; ++i) {
            if (received >= sizeof(payload) || input[i] != payload[received]) { close(fd); return 73; }
            ++received;
        }
    }
    close(fd);
    return received == sizeof(payload) ? 0 : 74;
}
static const unsigned char healthy[] = "graph-dependency-ready-v1\n";
static int health(void) {
    int fd = connect_port(28080);
    if (fd < 0) return 75;
    unsigned char response[sizeof(healthy)];
    size_t used = 0;
    for (;;) {
        ssize_t n = read(fd, response + used, sizeof(response) - used);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { close(fd); return 76; }
        if (!n) break;
        used += (size_t)n;
        if (used == sizeof(response)) { close(fd); return 77; }
    }
    close(fd);
    return used == sizeof(healthy)-1 && !memcmp(response, healthy, used) ? 0 : 78;
}
int main(int argc, char **argv) {
    if (argc != 2 || (strcmp(argv[1], "serve") && strcmp(argv[1], "serve-two") && strcmp(argv[1], "health"))) return 64;
    signal(SIGPIPE, SIG_IGN);
    alarm(!strcmp(argv[1], "health") ? 3 : 60);
    if (!strcmp(argv[1], "health")) return health();
    int result = dependency(25252);
    if (result) return result;
    if (!strcmp(argv[1], "serve-two")) {
        result = dependency(25253);
        if (result) return result;
    }
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 79;
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(28080);
    if (bind(fd, (struct sockaddr *)&address, sizeof(address)) || listen(fd, 4)) { close(fd); return 80; }
    for (unsigned int count = 0; count < 256; ++count) {
        int peer = accept(fd, NULL, NULL);
        if (peer < 0) { if (errno == EINTR) continue; close(fd); return 81; }
        if (bounded(peer) || send_all(peer, healthy, sizeof(healthy)-1)) { close(peer); close(fd); return 82; }
        close(peer);
    }
    close(fd);
    return 83;
}
