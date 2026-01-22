declare module "qrcode-terminal" {
  interface GenerateOptions {
    small?: boolean;
  }

  function generate(text: string, opts?: GenerateOptions): void;
  function generate(
    text: string,
    opts: GenerateOptions | undefined,
    callback: (qrcode: string) => void
  ): void;

  export { generate };
}
