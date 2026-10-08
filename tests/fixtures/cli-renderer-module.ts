class RenderableCanary {}

function callCanary(): never {
  throw new Error("Renderer loading canary must stop before renderer calls.");
}

export {
  RenderableCanary as TextRenderable,
  RenderableCanary as BoxRenderable,
  RenderableCanary as ScrollBoxRenderable,
  RenderableCanary as InputRenderable,
  RenderableCanary as SelectRenderable,
  RenderableCanary as StyledText,
  RenderableCanary as RGBA,
  callCanary as createCliRenderer,
  callCanary as createTextAttributes,
  callCanary as dim,
  callCanary as fg,
  callCanary as t,
};
export const RenderableEvents = {};
export const SelectRenderableEvents = {};

process.stderr.write("renderer-loading-canary\n");
throw new Error("Renderer loading canary reached.");
