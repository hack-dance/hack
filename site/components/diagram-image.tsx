import defaultComponents from "fumadocs-ui/mdx";
import type { ComponentProps } from "react";

const diagramSource = /^\/diagrams\/[a-f0-9]+\.(light|dark)\.svg$/;
const DefaultImage = defaultComponents.img;

/**
 * The `img` component for docs pages. A rendered diagram (two SVGs per Mermaid
 * block, written by scripts/docs/diagrams.ts) becomes a plain image carrying
 * `diagram-light` or `diagram-dark`, and global.css shows the one that matches
 * the theme. Every other image keeps the default component.
 */
export function DiagramImage(props: ComponentProps<"img">) {
  const variant =
    typeof props.src === "string"
      ? diagramSource.exec(props.src)?.[1]
      : undefined;
  if (!variant) {
    return <DefaultImage {...props} />;
  }
  return (
    // biome-ignore lint/performance/noImgElement: a static SVG needs no optimisation and must not be rasterised.
    <img
      alt={props.alt ?? ""}
      className={`diagram diagram-${variant}`}
      height={props.height}
      loading="lazy"
      src={props.src}
      width={props.width}
    />
  );
}
