import { defineConfig, defineDocs } from "fumadocs-mdx/config";
export const v5 = defineDocs({ dir: "content/docs/v5" });
export const v4 = defineDocs({ dir: "content/docs/v4" });
export default defineConfig({
  mdxOptions: {
    // Keep image `src` a plain string so DiagramImage can recognise rendered
    // diagrams; sizes are still read from `public/`.
    remarkImageOptions: { useImport: false },
  },
});
