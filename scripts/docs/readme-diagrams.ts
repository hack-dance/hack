/** GitHub cannot render every Pele type, so README diagrams carry checked SVGs. */
import { resolve } from "node:path";
import { renderDiagram } from "./diagrams";

const repositoryRoot = resolve(import.meta.dir, "../..");
const names = ["project", "first-run"] as const;

/** Pele 1.9.0 architecture has no class syntax; tag only these curated nodes. */
function applyProjectClasses(svg: string): string {
  let result = svg;
  for (const [id, semantic] of [
    ["compose", "live"],
    ["services", "live"],
    ["native", "idle"],
  ] as const) {
    const node = `<g class="pele-node pele-service" data-id="${id}"`;
    if (result.split(node).length !== 2) {
      throw new Error(`Expected one README architecture node: ${id}`);
    }
    result = result.replace(
      node,
      `<g class="pele-node pele-service ${semantic}" data-id="${id}"`
    );
  }
  return result;
}

/** Re-render sources with the site's pinned renderer and compare or write both themes. */
export async function readmeDiagrams(options: {
  readonly check: boolean;
}): Promise<void> {
  const readme = await Bun.file(resolve(repositoryRoot, "README.md")).text();
  for (const name of names) {
    const base = `docs/assets/readme/${name}`;
    const source = await Bun.file(
      resolve(repositoryRoot, `${base}.mmd`)
    ).text();
    const rendered = await renderDiagram(source);
    for (const mode of ["light", "dark"] as const) {
      const file = `${base}.${mode}.svg`;
      if (!readme.includes(`./${file}`)) {
        throw new Error(`README is missing its ${mode} picture: ${file}`);
      }
      const target = resolve(repositoryRoot, file);
      const svg =
        name === "project"
          ? applyProjectClasses(rendered[mode])
          : rendered[mode];
      if (options.check) {
        if (
          !(await Bun.file(target).exists()) ||
          (await Bun.file(target).text()) !== svg
        ) {
          throw new Error(
            `Stale README diagram: ${file}; run bun run docs:readme-diagrams`
          );
        }
      } else {
        await Bun.write(target, svg);
      }
    }
  }
  console.log(
    `${options.check ? "Checked" : "Rendered"} README diagrams in both themes.`
  );
}

if (import.meta.main) {
  await readmeDiagrams({ check: process.argv.includes("--check") });
}
