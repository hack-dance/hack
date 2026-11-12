/** Probe the installed renderer; generated audit evidence is kept outside the repository. */
import { resolve } from "node:path";
import examples from "../../site/diagram-examples.json";
import { renderDiagram } from "./diagrams";

const output = process.argv[2];
if (!output) {
  throw new Error("Pass an existing evidence directory");
}
type AuditResult = (typeof examples)[number] & { readonly name: string } & (
    | { readonly renders: true }
    | { readonly renders: false; readonly error: string }
  );
const results: AuditResult[] = [];
for (const [index, example] of examples.entries()) {
  const name = `h2075-${String(index + 1).padStart(2, "0")}`;
  try {
    const rendered = await renderDiagram(example.source);
    for (const mode of ["light", "dark"] as const) {
      await Bun.write(resolve(output, `${name}.${mode}.svg`), rendered[mode]);
    }
    results.push({ ...example, name, renders: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ ...example, name, renders: false, error: message });
  }
}
await Bun.write(
  resolve(output, "h2075-diagram-audit.json"),
  `${JSON.stringify(results, null, 2)}\n`
);
for (const result of results) {
  console.log(`${result.type}: ${result.renders ? "renders" : "failed"}`);
  if ("error" in result) {
    console.log(result.source);
    console.log(result.error);
  }
}
