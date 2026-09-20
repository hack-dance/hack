/* Ordinary in-container application traffic; no relay or credential protocol. */
#include <arpa/inet.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
int main(int argc, char **argv) {
    if (argc != 3 || strcmp(argv[1], "25252") ||
        (strcmp(argv[2], "success") && strcmp(argv[2], "refuse") && strcmp(argv[2], "idle"))) return 64;
    signal(SIGPIPE, SIG_IGN);
    alarm(10);
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 65;
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_port = htons(25252);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address))) return 66;
    if (!strcmp(argv[2], "idle")) {
        unsigned char byte;
        ssize_t n;
        do { n = read(fd, &byte, 1); } while (n < 0 && errno == EINTR);
        close(fd);
        if (n != 0) return 69;
        puts("container-tcp-idle-closed-v1");
        return 0;
    }
    unsigned char payload[65536], input[4096];
    for (size_t i = 0; i < sizeof(payload); ++i) payload[i] = (unsigned char)(i % 251);
    size_t sent = 0, received = 0;
    int failed = 0;
    while (sent < sizeof(payload)) {
        ssize_t n = write(fd, payload + sent, sizeof(payload) - sent);
        if (n > 0) sent += (size_t)n;
        else if (n < 0 && errno == EINTR) continue;
        else { failed = 1; break; }
    }
    if (shutdown(fd, SHUT_WR) && errno != ENOTCONN) failed = 1;
    for (;;) {
        ssize_t n = read(fd, input, sizeof(input));
        if (!n) break;
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { failed = 1; break; }
        for (ssize_t i = 0; i < n; ++i) {
            if (received >= sizeof(payload) || input[i] != (unsigned char)(received % 251)) failed = 1;
            ++received;
        }
        if (received > sizeof(payload)) break;
    }
    close(fd);
    if (!strcmp(argv[2], "refuse")) {
        if (received) return 67;
        puts("container-tcp-refused-v1");
        return 0;
    }
    if (failed || sent != sizeof(payload) || received != sizeof(payload)) return 68;
    puts("container-tcp-echo-v1");
    return 0;
}
