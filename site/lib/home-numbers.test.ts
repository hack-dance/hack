import { expect, test } from "bun:test";
import {
  allFigures,
  COMPARISONS_MEASURED,
  engineChart,
  engineChartMarkup,
  headline,
  idleComparisonMarkup,
  sample,
  usage,
  usageMarkup,
} from "./home-numbers";

const tones = /<\/?[a-z][a-z0-9]*>/g;

/** Panel markup as a reader sees it: the text without its tones. */
function plain(markup: string): string {
  return markup.replace(tones, "");
}

test("no figure is marked as measured yet", () => {
  const figures = allFigures();
  expect(figures.length).toBeGreaterThan(headline.length);
  for (const figure of figures) {
    expect(figure.value).not.toBe("");
    expect(figure.label).not.toBe("");
    expect(figure.measured).toBe(false);
  }
});

test("comparisons with other products are off until they are measured", () => {
  expect(COMPARISONS_MEASURED).toBe(false);
});

test("the strip has five figures with distinct labels", () => {
  expect(headline.map((figure) => figure.value)).toEqual([
    "300ms",
    "2s",
    "500ms",
    "50ms",
    "0",
  ]);
  expect(new Set(headline.map((figure) => figure.label)).size).toBe(5);
});

test("the chart and the sample output agree on the warm start", () => {
  expect(engineChart.hack.total.value).toBe(sample.warmStart.value);
  expect(Number(sample.warmStartMs.value) / 1000).toBeCloseTo(
    Number.parseFloat(sample.warmStart.value),
    1
  );
});

test("by default the warm-start chart draws only Hack's half", () => {
  const chart = plain(engineChartMarkup());
  expect(chart).toBe(
    [
      "                0s        5s        10s       15s",
      "                ├─────────┼─────────┼─────────┤",
      "hack            ████                             2.1s",
      "  engine        █                                0.3s",
      "  db             █                               0.5s",
      "  api, jobs       ██                             together",
      "  web               ██                           0.6s",
      "  plan, images, routes                           skipped",
      "                ├─────────┼─────────┼─────────┤",
    ].join("\n")
  );
  for (const row of [
    engineChart.compose.total,
    ...engineChart.compose.steps,
    engineChart.compose.summary,
  ]) {
    expect(chart).not.toContain(row.value);
  }
  expect(chart).not.toContain("docker compose");
  expect(chart).not.toContain("▒");
});

test("with comparisons on, the chart adds the other half and the summary", () => {
  expect(plain(engineChartMarkup(true))).toBe(
    [
      "                0s        5s        10s       15s",
      "                ├─────────┼─────────┼─────────┤",
      "hack            ████                             2.1s",
      "  engine        █                                0.3s",
      "  db             █                               0.5s",
      "  api, jobs       ██                             together",
      "  web               ██                           0.6s",
      "  plan, images, routes                           skipped",
      "",
      "docker compose  ██████████████████████████████   14.8s",
      "  db            ▒▒▒▒▒▒▒▒▒▒▒                      waits on health",
      "  api                      ▒▒▒▒▒▒▒               3.6s",
      "  jobs                            ▒▒▒▒           2.0s",
      "  web                                 ▒▒▒▒▒▒▒▒   3.9s",
      "                ├─────────┼─────────┼─────────┤",
      "7× faster · one at a time against all at once, and nothing redone",
    ].join("\n")
  );
});

test("the usage panel lines its figures up in columns", () => {
  expect(plain(usageMarkup())).toBe(
    [
      "PROJECT          STATE    MEMORY   CPU    DISK",
      "storefront       up       1.4 GB   3%     2.1 GB",
      "  fix-login      up       0.3 GB   1%     40 MB   shares images, caches",
      "  agent/onboarding asleep 0        0      12 MB",
      "billing-api      asleep   0        0      0.9 GB",
      "engine                    0.2 GB   0.4%   55 MB",
      "                          ──────          ──────",
      "total                     1.9 GB          3.1 GB",
      "",
      "reclaimable  6.2 GB  unused images, stopped copies",
      "",
      "$ hack clean",
      "✓ removed 14 images and 3 stopped copies hack started · 6.2 GB",
      "  left alone: 2 volumes it did not create",
    ].join("\n")
  );
  expect(usage.rows.length).toBe(5);
});

test("the usage panel colours branch copies and sleeping projects", () => {
  const markup = usageMarkup();
  expect(markup).toContain("  <c1>fix-login</c1>");
  expect(markup).toContain("  <c2>agent/onboarding</c2> <a>asleep</a> ");
  expect(markup).toContain("<d>engine</d>");
});

test("the idle comparison gives other products no figure", () => {
  expect(plain(idleComparisonMarkup())).toBe(
    [
      "MEMORY HELD WHILE NOTHING IS HAPPENING",
      "",
      "hack            ██                  0.2 GB",
      "orbstack        ▒▒▒▒▒▒▒▒            to measure",
      "docker desktop  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒   to measure",
      "",
      "DISK FOR A SECOND BRANCH COPY",
      "",
      "hack            █                   40 MB",
      "a second clone  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒      to measure",
      "",
      "same project, same machine, method published",
    ].join("\n")
  );
});
