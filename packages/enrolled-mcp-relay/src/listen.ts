import { isIPv4 } from "node:net";

export function isLoopbackIPv4(value: string): boolean {
  return value === "127.0.0.1";
}

export async function bindListeningPort(
  server: {
    once(event: "error", listener: (error: Error) => void): unknown;
    off(event: "error", listener: (error: Error) => void): unknown;
    listen(port: number, host: string, callback: () => void): unknown;
    address(): string | { port: number } | null;
  },
  port: number,
  host: string,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return address && typeof address === "object" ? address.port : port;
}

export function assertRelayBindAddresses(mcpListen: string, linkListen: string): void {
  if (!isLoopbackIPv4(mcpListen)) {
    throw new Error("--mcp-listen must be 127.0.0.1 so Caddy is the only public path");
  }
  if (!isLoopbackIPv4(linkListen) && !isIPv4(linkListen)) {
    throw new Error("--link-listen must be 127.0.0.1 or an IPv4 address");
  }
  if (linkListen === "0.0.0.0") {
    throw new Error("--link-listen must not be 0.0.0.0");
  }
}

export function publicRelayRequiresOauth(linkListen: string): boolean {
  return !isLoopbackIPv4(linkListen);
}
