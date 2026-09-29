let last: { marker: string; token: string } | undefined;
for (let i = 0; i < 200; i++) {
  last = (await (
    await fetch("http://web:3000", { signal: AbortSignal.timeout(2000) })
  ).json()) as { marker: string; token: string };
  if (last.marker !== "compiled-source" || last.token.length !== 36) {
    throw new Error("Wrong build or persistent data");
  }
}
console.log(JSON.stringify({ ...last, requests: 200 }));
