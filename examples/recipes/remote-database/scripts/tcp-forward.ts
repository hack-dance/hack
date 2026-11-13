// Stand-in for a database proxy such as `ssh -N -L`, a cloud SQL proxy or a
// port-forwarding session. It forwards LISTEN_HOST:LISTEN_PORT to UPSTREAM.
// It exists to try the recipe; use a real proxy for real traffic.
const [upstreamHost, upstreamPort] = (process.env.DB_PROXY_UPSTREAM ?? "").split(":");

/** One side of a connection: its peer and the bytes the peer has not taken yet. */
type Side = { peer?: Bun.Socket<Side>; backlog: Uint8Array[] };

/** Write to a socket, keeping whatever it does not accept for its drain event. */
function send(socket: Bun.Socket<Side>, chunk: Uint8Array): void {
  if (socket.data.backlog.length > 0) {
    socket.data.backlog.push(chunk);
    return;
  }
  const written = socket.write(chunk);
  if (written < chunk.byteLength) {
    socket.data.backlog.push(chunk.subarray(Math.max(written, 0)));
  }
}

function flush(socket: Bun.Socket<Side>): void {
  while (socket.data.backlog.length > 0) {
    const chunk = socket.data.backlog[0];
    if (!chunk) {
      return;
    }
    const written = socket.write(chunk);
    if (written < chunk.byteLength) {
      socket.data.backlog[0] = chunk.subarray(Math.max(written, 0));
      return;
    }
    socket.data.backlog.shift();
  }
}

if (!upstreamHost || !upstreamPort) {
  console.log("no remote database selected; proxy idle");
  setInterval(() => {}, 1 << 30);
} else {
  const listen = {
    hostname: process.env.DB_PROXY_LISTEN_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PROXY_LISTEN_PORT ?? 15432),
  };
  // Bytes from the client that arrive before the upstream connection opens.
  const early = new WeakMap<Bun.Socket<Side>, Uint8Array[]>();
  Bun.listen<Side>({
    ...listen,
    socket: {
      async open(client) {
        client.data = { backlog: [] };
        early.set(client, []);
        try {
          const upstream = await Bun.connect<Side>({
            hostname: upstreamHost,
            port: Number(upstreamPort),
            socket: {
              data(socket, chunk) {
                if (socket.data.peer) {
                  send(socket.data.peer, chunk);
                }
              },
              drain(socket) {
                flush(socket);
              },
              close() {
                client.end();
              },
            },
          });
          upstream.data = { peer: client, backlog: [] };
          client.data.peer = upstream;
          for (const chunk of early.get(client) ?? []) {
            send(upstream, chunk);
          }
          early.delete(client);
        } catch {
          console.log("cannot reach the remote database");
          client.end();
        }
      },
      data(client, chunk) {
        if (client.data.peer) {
          send(client.data.peer, chunk);
        } else {
          early.get(client)?.push(chunk);
        }
      },
      drain(client) {
        flush(client);
      },
      close(client) {
        client.data.peer?.end();
      },
    },
  });
  console.log(`proxy ${listen.hostname}:${listen.port} -> remote database`);
}
