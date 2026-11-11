"use client";

import { Maximize2, Minus, Plus, RotateCcw, X } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type DiagramVariant = "light" | "dark";

interface DiagramProps {
  readonly alt: string;
  readonly height: number;
  readonly src: string;
  readonly variant: DiagramVariant;
  readonly width: number;
}

const zoomSteps = [1, 1.5, 2, 3, 4] as const;

/**
 * One rendered diagram with a control that opens it full size. The inline image
 * keeps its intrinsic size, and the control sits over its corner, so adding the
 * control moves nothing on the page.
 */
export function DiagramFrame(props: DiagramProps) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`diagram-frame diagram-frame-${props.variant}`}>
      <Image
        alt={props.alt}
        className={`diagram diagram-${props.variant}`}
        height={props.height}
        src={props.src}
        unoptimized
        width={props.width}
      />
      <button
        aria-haspopup="dialog"
        aria-label={`Open diagram full size: ${props.alt}`}
        className="diagram-expand"
        onClick={() => setOpen(true)}
        title="Open full size"
        type="button"
      >
        <Maximize2 aria-hidden="true" size={16} />
      </button>
      {open ? (
        <DiagramDialog {...props} onClose={() => setOpen(false)} />
      ) : null}
    </span>
  );
}

/**
 * The full-size view: a native modal dialog, so Escape closes it, focus stays
 * inside it and returns to the opening control afterwards. It renders through a
 * portal and only while open, so the page HTML never contains it. Zoom changes
 * the image width and the stage scrolls, which pans with a mouse, the keyboard
 * or touch.
 */
function DiagramDialog({
  alt,
  height,
  onClose,
  src,
  variant,
  width,
}: DiagramProps & { readonly onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) {
      element.showModal();
    }
    return () => {
      if (element?.open) {
        element.close();
      }
    };
  }, []);
  const zoom = zoomSteps[step] ?? 1;
  return createPortal(
    <dialog
      aria-label={alt}
      className={`diagram-dialog diagram-dialog-${variant}`}
      onClose={onClose}
      ref={dialog}
    >
      <div className="diagram-dialog-bar">
        <button
          aria-label="Zoom out"
          disabled={step === 0}
          onClick={() => setStep((value) => Math.max(0, value - 1))}
          type="button"
        >
          <Minus aria-hidden="true" size={18} />
        </button>
        <output aria-live="polite">{Math.round(zoom * 100)}%</output>
        <button
          aria-label="Zoom in"
          disabled={step === zoomSteps.length - 1}
          onClick={() =>
            setStep((value) => Math.min(zoomSteps.length - 1, value + 1))
          }
          type="button"
        >
          <Plus aria-hidden="true" size={18} />
        </button>
        <button
          aria-label="Reset zoom"
          disabled={step === 0}
          onClick={() => setStep(0)}
          type="button"
        >
          <RotateCcw aria-hidden="true" size={18} />
        </button>
        <button
          aria-label="Close full size diagram"
          autoFocus
          className="diagram-dialog-close"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the scroll area must take focus so arrow keys pan the diagram. */}
      <div className="diagram-dialog-stage" tabIndex={0}>
        <Image
          alt={alt}
          className="diagram-full"
          height={height}
          src={src}
          style={{ width: `${zoom * 100}%`, maxWidth: "none", height: "auto" }}
          unoptimized
          width={width}
        />
      </div>
    </dialog>,
    document.body
  );
}
