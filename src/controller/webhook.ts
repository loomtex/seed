// HTTP webhook handler with HMAC-SHA256 verification.
// Accepts POST /refresh to trigger cache-busting reconciliation.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { log } from "../shared/kube.js";

export type RefreshCallback = () => void;

/** Start the webhook HTTP server. */
export function startWebhookServer(
  port: number,
  secretFile: string,
  onRefresh: RefreshCallback,
): void {
  let hmacSecret = "";

  // Load secret on startup
  if (secretFile) {
    readFile(secretFile, "utf-8")
      .then((s) => {
        hmacSecret = s.trim();
        log("webhook", `loaded HMAC secret from ${secretFile}`);
      })
      .catch((err) => {
        log("webhook", `failed to load secret from ${secretFile}: ${err}`);
      });
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== "/refresh") {
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
      return;
    }

    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    // Verify HMAC-SHA256 signature if secret is configured
    if (hmacSecret) {
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!signature) {
        log("webhook", "rejected: missing signature");
        res.writeHead(401, { "Content-Length": "0" });
        res.end();
        return;
      }

      const expected = "sha256=" + createHmac("sha256", hmacSecret)
        .update(body)
        .digest("hex");

      if (expected !== signature) {
        log("webhook", "rejected: invalid signature");
        res.writeHead(401, { "Content-Length": "0" });
        res.end();
        return;
      }
    }

    log("webhook", "refresh triggered");
    onRefresh();

    const responseBody = JSON.stringify({ status: "ok" });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(responseBody)),
    });
    res.end(responseBody);
  });

  server.listen(port, "0.0.0.0", () => {
    log("webhook", `listening on 0.0.0.0:${port}`);
  });
}
