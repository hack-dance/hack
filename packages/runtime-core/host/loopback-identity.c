/* SDK-owned libproc layouts stay in C; Rust sees only this small fixed-width ABI. */
#include <arpa/inet.h>
#include <errno.h>
#include <libproc.h>
#include <stdint.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <unistd.h>

struct hack_loopback_identity {
    uint64_t generation;
    int32_t descriptor;
    int32_t accepted;
};

/* A bounded snapshot, never authorization on its own. Caller binds process identity. */
int hack_loopback_inspect(int32_t pid, uint16_t port, uint16_t peer_port,
        struct hack_loopback_identity *result) {
    if (pid <= 1 || !port || !result) return -1;
    struct proc_fdinfo descriptors[4096];
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, descriptors, sizeof(descriptors));
    if (bytes <= 0 || bytes >= (int)sizeof(descriptors) ||
            bytes % (int)sizeof(descriptors[0])) return -1;
    struct hack_loopback_identity found = {0, -1, 0};
    for (int index = 0; index < bytes / (int)sizeof(descriptors[0]); index++) {
        if (descriptors[index].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
        struct socket_fdinfo socket = {0};
        int socket_bytes = proc_pidfdinfo(pid, descriptors[index].proc_fd, PROC_PIDFDSOCKETINFO,
                &socket, sizeof(socket));
        if (socket_bytes != sizeof(socket)) {
            /* Closed or reused-as-nonsocket descriptors cannot prove socket ownership.
               Unknown failures and short successful reads still refuse the snapshot. */
            if (socket_bytes <= 0 && (errno == EBADF || errno == ENOTSOCK)) continue;
            return -1;
        }
        if (socket.psi.soi_family != AF_INET || socket.psi.soi_kind != SOCKINFO_TCP) continue;
        const struct tcp_sockinfo *tcp = &socket.psi.soi_proto.pri_tcp;
        const struct in_sockinfo *ip = &tcp->tcpsi_ini;
        if (ntohs((uint16_t)ip->insi_lport) != port) continue;
        if (tcp->tcpsi_state == TSI_S_LISTEN) {
            if (found.descriptor >= 0 || !ip->insi_gencnt ||
                    ip->insi_laddr.ina_46.i46a_addr4.s_addr != htonl(INADDR_LOOPBACK) ||
                    (socket.psi.soi_options & SO_REUSEPORT)) return -1;
            found.generation = ip->insi_gencnt;
            found.descriptor = descriptors[index].proc_fd;
        /* A live accepted descriptor can finish sending before identity inspection.
           FIN_WAIT still permits receiving the request. Keep exact tuple, process
           and listener identity checks; do not admit arbitrary closing states. */
        } else if (peer_port &&
                (tcp->tcpsi_state == TSI_S_ESTABLISHED ||
                 tcp->tcpsi_state == TSI_S_FIN_WAIT_1 ||
                 tcp->tcpsi_state == TSI_S_FIN_WAIT_2) &&
                ntohs((uint16_t)ip->insi_fport) == peer_port &&
                ip->insi_laddr.ina_46.i46a_addr4.s_addr == htonl(INADDR_LOOPBACK) &&
                ip->insi_faddr.ina_46.i46a_addr4.s_addr == htonl(INADDR_LOOPBACK)) {
            found.accepted = 1;
        }
    }
    if (found.descriptor < 0) return -1;
    *result = found;
    return 0;
}
