/**
 * Preload for a source CLI child (`bun --preload <this> index.ts update`) that
 * answers the GitHub "latest release" lookup with a release far newer than
 * any real one, so `hack update` reaches its install confirmation without the
 * network. The release lists the tarball for this platform; any other fetch
 * (including the tarball download) throws, so nothing is downloaded.
 */
const LATEST_URL =
  "https://api.github.com/repos/hack-dance/hack/releases/latest";
const VERSION = "999.0.0";

function targetSuffix(): string {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  return `${platform}-${arch}`;
}

function requestUrl(input: unknown): string {
  if (input instanceof Request) {
    return input.url;
  }
  return String(input);
}

const stubFetch = async (input: unknown): Promise<Response> => {
  if (requestUrl(input) !== LATEST_URL) {
    throw new Error("release-fetch-stub: unexpected fetch");
  }
  return Response.json({
    tag_name: `v${VERSION}`,
    assets: [
      {
        name: `hack-${VERSION}-${targetSuffix()}.tar.gz`,
        browser_download_url: "https://release-fetch-stub.invalid/hack.tar.gz",
      },
    ],
  });
};

globalThis.fetch = Object.assign(stubFetch, {
  preconnect: () => undefined,
}) as unknown as typeof globalThis.fetch;
