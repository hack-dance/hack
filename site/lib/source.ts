import { v4, v5 } from "collections/server";
import { loader } from "fumadocs-core/source";
export const sources = {
  v5: loader({ baseUrl: "/docs/v5", source: v5.toFumadocsSource() }),
  v4: loader({ baseUrl: "/docs/v4", source: v4.toFumadocsSource() }),
};
export const source = sources.v5;
export type DocsVersion = keyof typeof sources;
