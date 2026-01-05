declare module "@charmland/lipgloss" {
  export type Color = string

  export function Color(value: string): Color

  export class Style {
    constructor()
    bold(value: boolean): Style
    foreground(color: Color): Style
    background(color: Color): Style
    render(text: string): string
  }
}
