// Minimal ambient globals used only by the local dev server (src/dev-server.ts),
// which runs under Bun rather than the Cloudflare Workers runtime.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function join(...segments: string[]): string;
}

interface ImportMeta {
  readonly dir: string;
}

declare const Bun: {
  serve(options: {
    port: number;
    fetch: (req: Request) => Response | Promise<Response>;
  }): { port: number };
};

declare const process: {
  env: Record<string, string | undefined>;
  exit(code: number): never;
};
