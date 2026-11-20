# Guest stream protocol

The experimental host and guest exchange length-prefixed JSON on a private byte
stream. The four-byte unsigned length uses network byte order. Both directions
limit payloads to 65536 bytes and reject unknown fields. The caller owns the
transport deadline and the handshake. The first request carries the host's
inclusive version range. Version 1 addresses commands by boot ID, agent
incarnation and execution ID. Treat command arguments, environment and child
output as confidential. The codec returns fixed errors without peer data.

On Unix, the host client negotiates on an already connected stream. It exposes
the boot and agent identities before accepting one request, then consumes the
session. One absolute deadline covers negotiation and the request/reply
exchange. The runtime exposes the client under its optional guest-agent-client
feature. Callers own connection establishment, execution IDs and recovery.
