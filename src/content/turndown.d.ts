declare module "turndown" {
  class TurndownService {
    turndown(html: string): string
  }

  export = TurndownService
}
