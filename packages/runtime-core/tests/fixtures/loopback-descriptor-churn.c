/* Exercise the production inspector against kernel-visible socket-to-pipe reuse. */
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>
#include "../../host/loopback-identity.c"

static atomic_int done = 0;
static void *churn(void *arg) {
    (void)arg;
    while (!atomic_load(&done)) {
        int fds[2];
        if (!socketpair(AF_UNIX, SOCK_STREAM, 0, fds)) {
            close(fds[0]);
            close(fds[1]);
        }
        if (!pipe(fds)) {
            close(fds[0]);
            close(fds[1]);
        }
    }
    return NULL;
}
int main(void) {
    alarm(10);
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in addr = {0};
    addr.sin_len = sizeof(addr);
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(fd, (void *)&addr, sizeof(addr)) || listen(fd, 16)) return 2;
    socklen_t len = sizeof(addr);
    if (getsockname(fd, (void *)&addr, &len)) return 3;
    pthread_t thread;
    if (pthread_create(&thread, NULL, churn, NULL)) return 4;
    int passed = 0;
    for (int i = 0; i < 2000; i++) {
        struct hack_loopback_identity result;
        if (hack_loopback_inspect(getpid(), ntohs(addr.sin_port), 0, &result) == 0 &&
                result.descriptor == fd && result.generation != 0) passed++;
    }
    atomic_store(&done, 1);
    pthread_join(thread, NULL);
    close(fd);
    printf("verified=%d total=2000\n", passed);
    return passed == 2000 ? 0 : 5;
}
