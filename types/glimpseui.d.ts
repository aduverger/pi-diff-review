declare module "glimpseui" {
  export interface GlimpseOpenOptions {
    width?: number;
    height?: number;
    title?: string;
  }

  export interface GlimpseWindow {
    on(event: "message", listener: (data: unknown) => void): this;
    on(event: "closed", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    removeListener(event: "message", listener: (data: unknown) => void): this;
    removeListener(event: "closed", listener: () => void): this;
    removeListener(event: "error", listener: (error: Error) => void): this;
    send(js: string): void;
    close(): void;
  }

  export function open(html: string, options?: GlimpseOpenOptions): GlimpseWindow;
}
