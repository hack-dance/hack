/**
 * A minimal UDP DNS client for read-only probes (`hack doctor`, `hack global
 * status --observe`): one question to one server, bounded by a timeout,
 * answering the first A or AAAA address or null. Sends nothing else.
 */
export async function queryDnsARecord(opts: {
  readonly hostname: string;
  readonly server: string;
  readonly port: number;
  readonly timeoutMs: number;
}): Promise<string | null> {
  // Try AAAA (IPv6) first, then fall back to A (IPv4)
  const ipv6 = await queryDnsRecord({ ...opts, recordType: "AAAA" });
  if (ipv6) {
    return ipv6;
  }
  return await queryDnsRecord({ ...opts, recordType: "A" });
}

export async function queryDnsRecord(opts: {
  readonly hostname: string;
  readonly server: string;
  readonly port: number;
  readonly timeoutMs: number;
  readonly recordType: "A" | "AAAA";
}): Promise<string | null> {
  const { createSocket } = await import("node:dgram");

  const id = Math.floor(Math.random() * 65_535);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x01_00, 2); // recursion desired
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(0, 10); // ARCOUNT

  const qname = encodeDnsName(opts.hostname);
  // A = 0x0001, AAAA = 0x001c, IN = 0x0001
  const qtype = opts.recordType === "AAAA" ? 0x00_1c : 0x00_01;
  const question = Buffer.concat([
    qname,
    Buffer.from([(qtype >> 8) & 0xff, qtype & 0xff, 0x00, 0x01]),
  ]);
  const packet = Buffer.concat([header, question]);

  return await new Promise<string | null>((resolve) => {
    const socket = createSocket("udp4");
    const eventfulSocket = socket as typeof socket & {
      on(
        eventName: "message",
        listener: (msg: Buffer<ArrayBufferLike>) => void
      ): typeof socket;
    };

    const finish = (value: string | null) => {
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const timeout = setTimeout(() => finish(null), opts.timeoutMs);

    eventfulSocket.on("message", (msg) => {
      clearTimeout(timeout);
      finish(
        parseDnsResponse({ msg, expectedId: id, recordType: opts.recordType })
      );
    });

    socket.send(packet, opts.port, opts.server, (err: Error | null) => {
      if (err) {
        clearTimeout(timeout);
        finish(null);
      }
    });
  });
}

function encodeDnsName(hostname: string): Buffer {
  const parts = hostname.split(".").filter((p) => p.length > 0);
  const bytes: number[] = [];
  for (const part of parts) {
    const buf = Buffer.from(part, "utf8");
    bytes.push(buf.length);
    for (const b of buf) {
      bytes.push(b);
    }
  }
  bytes.push(0);
  return Buffer.from(bytes);
}

function parseDnsResponse(opts: {
  readonly msg: Buffer;
  readonly expectedId: number;
  readonly recordType: "A" | "AAAA";
}): string | null {
  const header = parseDnsHeader(opts.msg);
  if (!header) {
    return null;
  }
  if (header.id !== opts.expectedId) {
    return null;
  }

  const answersOffset = skipDnsQuestions({
    msg: opts.msg,
    offset: header.offsetAfterHeader,
    qd: header.qd,
  });
  if (answersOffset === null) {
    return null;
  }

  return parseDnsAnswers({
    msg: opts.msg,
    offset: answersOffset,
    an: header.an,
    recordType: opts.recordType,
  });
}

type DnsHeader = {
  readonly id: number;
  readonly qd: number;
  readonly an: number;
  readonly offsetAfterHeader: number;
};

function parseDnsHeader(msg: Buffer): DnsHeader | null {
  if (msg.length < 12) {
    return null;
  }
  return {
    id: msg.readUInt16BE(0),
    qd: msg.readUInt16BE(4),
    an: msg.readUInt16BE(6),
    offsetAfterHeader: 12,
  };
}

function skipDnsQuestions(opts: {
  readonly msg: Buffer;
  readonly offset: number;
  readonly qd: number;
}): number | null {
  let offset = opts.offset;
  for (let i = 0; i < opts.qd; i += 1) {
    offset = skipDnsName(opts.msg, offset);
    offset += 4; // QTYPE + QCLASS
    if (offset > opts.msg.length) {
      return null;
    }
  }
  return offset;
}

type DnsAnswerHeader = {
  readonly type: number;
  readonly klass: number;
  readonly rdlength: number;
  readonly rdataOffset: number;
  readonly nextOffset: number;
};

function readDnsAnswerHeader(opts: {
  readonly msg: Buffer;
  readonly offset: number;
}): DnsAnswerHeader | null {
  if (opts.offset + 10 > opts.msg.length) {
    return null;
  }
  const type = opts.msg.readUInt16BE(opts.offset);
  const klass = opts.msg.readUInt16BE(opts.offset + 2);
  const rdlength = opts.msg.readUInt16BE(opts.offset + 8);
  const rdataOffset = opts.offset + 10;
  const nextOffset = rdataOffset + rdlength;
  if (nextOffset > opts.msg.length) {
    return null;
  }
  return { type, klass, rdlength, rdataOffset, nextOffset };
}

function parseDnsAnswers(opts: {
  readonly msg: Buffer;
  readonly offset: number;
  readonly an: number;
  readonly recordType: "A" | "AAAA";
}): string | null {
  const expectedType = opts.recordType === "AAAA" ? 28 : 1;
  const expectedRdlength = opts.recordType === "AAAA" ? 16 : 4;

  let offset = opts.offset;
  for (let i = 0; i < opts.an; i += 1) {
    offset = skipDnsName(opts.msg, offset);

    const header = readDnsAnswerHeader({ msg: opts.msg, offset });
    if (!header) {
      return null;
    }

    if (
      header.type === expectedType &&
      header.klass === 1 &&
      header.rdlength === expectedRdlength
    ) {
      return opts.recordType === "A"
        ? parseDnsARecord({ msg: opts.msg, rdataOffset: header.rdataOffset })
        : parseDnsAAAARecord({
            msg: opts.msg,
            rdataOffset: header.rdataOffset,
          });
    }

    offset = header.nextOffset;
  }

  return null;
}

function parseDnsARecord(opts: {
  readonly msg: Buffer;
  readonly rdataOffset: number;
}): string {
  const a = opts.msg[opts.rdataOffset];
  const b = opts.msg[opts.rdataOffset + 1];
  const c = opts.msg[opts.rdataOffset + 2];
  const d = opts.msg[opts.rdataOffset + 3];
  return `${a}.${b}.${c}.${d}`;
}

function parseDnsAAAARecord(opts: {
  readonly msg: Buffer;
  readonly rdataOffset: number;
}): string {
  const parts: string[] = [];
  for (let j = 0; j < 16; j += 2) {
    const word = opts.msg.readUInt16BE(opts.rdataOffset + j);
    parts.push(word.toString(16));
  }

  const ipv6 = parts.join(":");
  return ipv6 === "0:0:0:0:0:0:0:1" ? "::1" : ipv6;
}

function skipDnsName(buf: Buffer, startOffset: number): number {
  let offset = startOffset;
  while (offset < buf.length) {
    const len = buf[offset];
    if (len === undefined) {
      return offset;
    }
    if ((len & 0b1100_0000) === 0b1100_0000) {
      return offset + 2; // pointer
    }
    if (len === 0) {
      return offset + 1;
    }
    offset += 1 + len;
  }
  return offset;
}
