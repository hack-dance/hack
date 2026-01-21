export async function* readLinesFromStream(
  stream: ReadableStream<Uint8Array> | null
): AsyncGenerator<string> {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) {
        break;
      }
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
  }
}
