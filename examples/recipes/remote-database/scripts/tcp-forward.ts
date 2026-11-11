// Stand-in for a database proxy such as `ssh -N -L`, a cloud SQL proxy or a
// port-forwarding session. It forwards LISTEN_HOST:LISTEN_PORT to UPSTREAM.
const [upstreamHost, upstreamPort] = (process.env.DB_PROXY_UPSTREAM ?? "").split(":");
if (!upstreamHost || !upstreamPort) {
  console.log("no remote database selected; proxy idle");
  setInterval(() => {}, 1 << 30);
} else {
  const listen = {
    hostname: process.env.DB_PROXY_LISTEN_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PROXY_LISTEN_PORT ?? 15432),
  };
  type Pair = { peer?: Bun.Socket<Pair>; pending: Uint8Array[] };
  Bun.listen<Pair>({
    ...listen,
    socket: {
      async open(client) {
        client.data = { pending: [] };
        const upstream = await Bun.connect<Pair>({
          hostname: upstreamHost,
          port: Number(upstreamPort),
          socket: {
            data(_socket, chunk) {
              client.write(chunk);
            },
            close() {
              client.end();
            },
          },
        });
        upstream.data = { peer: client, pending: [] };
        client.data.peer = upstream;
        for (const chunk of client.data.pending) {
          upstream.write(chunk);
        }
      },
      data(client, chunk) {
        if (client.data.peer) {
          client.data.peer.write(chunk);
        } else {
          client.data.pending.push(chunk);
        }
      },
      close(client) {
        client.data.peer?.end();
      },
    },
  });
  console.log(`proxy ${listen.hostname}:${listen.port} -> remote database`);
}
