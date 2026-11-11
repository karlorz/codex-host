import http from "node:http";

export type WhoisFn = (remoteAddr: string) => Promise<string | undefined>;

const DEFAULT_TAILSCALED_SOCKET = "/var/run/tailscale/tailscaled.sock";

export function createTailscaleWhois(socketPath = DEFAULT_TAILSCALED_SOCKET): WhoisFn {
  return async (remoteAddr) => {
    const path = `/localapi/v0/whois?addr=${encodeURIComponent(remoteAddr)}`;
    const body = await new Promise<string>((resolve, reject) => {
      const request = http.get(
        {
          socketPath,
          host: "local-tailscaled.sock",
          path,
          timeout: 2000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            if ((response.statusCode ?? 500) >= 400) {
              reject(new Error(`whois HTTP ${response.statusCode}`));
              return;
            }
            resolve(Buffer.concat(chunks).toString("utf8"));
          });
        },
      );
      request.on("error", reject);
      request.on("timeout", () => {
        request.destroy();
        reject(new Error("whois timeout"));
      });
    });
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const node = (parsed as { Node?: { StableID?: unknown; ID?: unknown } }).Node;
    if (typeof node?.StableID === "string" && node.StableID) return node.StableID;
    if (typeof node?.ID === "string" && node.ID) return node.ID;
    return undefined;
  };
}
