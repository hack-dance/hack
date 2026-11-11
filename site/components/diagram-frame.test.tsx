import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register the DOM before React loads.
GlobalRegistrator.register();

import { expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

// next/image needs the Next.js runtime; a plain <img> keeps the same props.
mock.module("next/image", () => ({
  default: ({ unoptimized: _unoptimized, ...rest }: Record<string, unknown>) =>
    createElement("img", rest),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

test("the control opens a modal dialog, zoom works, and closing removes it", async () => {
  const { DiagramFrame } = await import("./diagram-frame");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      createElement(DiagramFrame, {
        alt: "Example flow",
        height: 100,
        src: "/diagrams/abc123.light.svg",
        variant: "light",
        width: 400,
      })
    );
  });
  // Nothing but the inline image and its control before opening.
  expect(document.querySelectorAll("dialog").length).toBe(0);
  expect(host.querySelectorAll("img.diagram.diagram-light").length).toBe(1);
  const control = host.querySelector(
    "button.diagram-expand"
  ) as HTMLButtonElement;
  expect(control.getAttribute("aria-label")).toBe(
    "Open diagram full size: Example flow"
  );

  act(() => {
    control.click();
  });
  const dialog = document.querySelector(
    "dialog.diagram-dialog"
  ) as HTMLDialogElement;
  expect(dialog).not.toBeNull();
  expect(dialog.parentElement).toBe(document.body); // portal, not inside the paragraph
  expect(dialog.open).toBe(true);
  expect(dialog.classList.contains("diagram-dialog-light")).toBe(true);
  const full = dialog.querySelector("img.diagram-full") as HTMLImageElement;
  expect(full.getAttribute("src")).toBe("/diagrams/abc123.light.svg");
  expect(full.style.width).toBe("100%");
  // The inline image count is unchanged: the full-size image has another class.
  expect(document.querySelectorAll("img.diagram.diagram-light").length).toBe(1);

  const button = (label: string) =>
    dialog.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
  expect(button("Zoom out").disabled).toBe(true);
  act(() => {
    button("Zoom in").click();
  });
  expect(full.style.width).toBe("150%");
  expect(dialog.querySelector("output")?.textContent).toBe("150%");
  act(() => {
    button("Reset zoom").click();
  });
  expect(full.style.width).toBe("100%");

  // Escape on a modal dialog makes the browser close it and fire "close".
  control.blur();
  act(() => {
    dialog.close();
  });
  expect(document.querySelectorAll("dialog").length).toBe(0);
  expect(document.activeElement).toBe(control);

  // Reopen and use the Close button: it closes through the element, so the
  // dialog is closed (not just removed) and focus is back on the control.
  act(() => {
    control.click();
  });
  const again = document.querySelector(
    "dialog.diagram-dialog"
  ) as HTMLDialogElement;
  expect(again.open).toBe(true);
  let closeEvents = 0;
  again.addEventListener("close", () => {
    closeEvents += 1;
  });
  control.blur();
  act(() => {
    (
      again.querySelector(
        'button[aria-label="Close full size diagram"]'
      ) as HTMLButtonElement
    ).click();
  });
  expect(closeEvents).toBe(1);
  expect(again.open).toBe(false);
  expect(document.querySelectorAll("dialog").length).toBe(0);
  expect(document.activeElement).toBe(control);
  act(() => {
    root.unmount();
  });
});
