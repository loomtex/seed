// HTTP webhook handler with HMAC-SHA256 verification.
// Accepts POST /refresh to trigger cache-busting reconciliation.
// Parses GitHub push payload to identify which flake changed.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { log } from "../shared/kube.js";

export type RefreshCallback = (flakePath: string) => void;

/**
 * Match a GitHub repository full_name (e.g. "loomtex/seed") against
 * known flake paths (e.g. "github:loomtex/seed").
 * Returns the matched flake path, or null if no match.
 */
function matchFlake(repoFullName: string, flakePaths: string[]): string | null {
  for (const fp of flakePaths) {
    const match = fp.match(/^github:([^#]+)/);
    if (match && match[1] === repoFullName) return fp;
  }
  return null;
}

/** Start the webhook HTTP server. */
export function startWebhookServer(
  port: number,
  secretFile: string,
  flakePaths: string[],
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

    // Parse GitHub payload to identify which flake changed
    let matchedFlake: string | null = null;
    try {
      const payload = JSON.parse(body.toString());
      const repoFullName = payload?.repository?.full_name;
      if (repoFullName) {
        matchedFlake = matchFlake(repoFullName, flakePaths);
        if (matchedFlake) {
          log("webhook", `matched repo ${repoFullName} → ${matchedFlake}`);
        } else {
          log("webhook", `no matching flake for repo ${repoFullName}`);
        }
      }
    } catch {
      log("webhook", "failed to parse webhook payload, triggering all flakes");
    }

    if (matchedFlake) {
      onRefresh(matchedFlake);
    } else {
      // No match or parse failure — trigger all flakes
      for (const fp of flakePaths) {
        onRefresh(fp);
      }
    }

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
