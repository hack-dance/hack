# Guest stream protocol

The experimental host and guest exchange length-prefixed JSON on a private byte
stream. The four-byte unsigned length uses network byte order. Both directions
limit payloads to 65536 bytes and reject unknown fields. The caller owns the
transport deadline and the handshake. The first request carries the host's
inclusive version range. Version 1 addresses commands by boot ID, agent
incarnation and execution ID. Treat command arguments, environment and child
output as confidential. The codec returns fixed errors without peer data.
