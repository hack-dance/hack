import defaultComponents from "fumadocs-ui/mdx";
import type { ComponentProps } from "react";
import { DiagramFrame, type DiagramVariant } from "./diagram-frame";

const diagramSource = /^\/diagrams\/[a-f0-9]+\.(light|dark)\.svg$/;
const DefaultImage = defaultComponents.img;

/**
 * The `img` component for docs pages. A rendered diagram (two SVGs per Mermaid
 * block, written by scripts/docs/diagrams.ts) becomes a framed image carrying
 * `diagram-light` or `diagram-dark` with a control that opens it full size;
 * global.css shows the frame that matches the theme. Every other image keeps
 * the default component.
 */
export function DiagramImage(props: ComponentProps<"img">) {
  const variant =
    typeof props.src === "string"
      ? (diagramSource.exec(props.src)?.[1] as DiagramVariant | undefined)
      : undefined;
  if (!(variant && typeof props.src === "string")) {
    return <DefaultImage {...props} />;
  }
  return (
    <DiagramFrame
      alt={props.alt ?? ""}
      height={Number(props.height)}
      src={props.src}
      variant={variant}
      width={Number(props.width)}
    />
  );
}
