// The DOM is registered by the preload in site/bunfig.toml, before React loads.
import { expect, mock, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";

// next/image needs the Next.js runtime; a plain <img> keeps the same props.
mock.module("next/image", () => ({
  default: ({ unoptimized: _unoptimized, ...rest }: Record<string, unknown>) =>
    createElement("img", rest),
}));

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
  // Opening moves focus to the Close control.
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Close full size diagram"
  );
  // A close event that arrives while the dialog is open changes nothing.
  act(() => {
    dialog.dispatchEvent(new Event("close"));
  });
  expect(document.querySelector("dialog.diagram-dialog")).toBe(dialog);
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

test("the dialog stays open under StrictMode's repeated effects", async () => {
  const { DiagramFrame } = await import("./diagram-frame");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(DiagramFrame, {
          alt: "Strict flow",
          height: 100,
          src: "/diagrams/def456.dark.svg",
          variant: "dark",
          width: 400,
        })
      )
    );
  });
  act(() => {
    (host.querySelector("button.diagram-expand") as HTMLButtonElement).click();
  });
  // Let any queued close event from a repeated effect be delivered.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const dialog = document.querySelector(
    "dialog.diagram-dialog-dark"
  ) as HTMLDialogElement;
  expect(dialog?.open).toBe(true);
  act(() => {
    root.unmount();
  });
  expect(document.querySelectorAll("dialog").length).toBe(0);
});
