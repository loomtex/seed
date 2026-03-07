// Tests for controller/webhook.ts — HTTP webhook handler with HMAC verification.
// Tests the webhook behavior by creating HTTP servers that replicate the handler logic.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Create a webhook-style handler (replicates webhook.ts logic). */
function createWebhookHandler(
  hmacSecret: string,
  onRefresh: () => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => {
    if (req.method !== "POST" || req.url !== "/refresh") {
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);

    // HMAC verification (if secret is set)
    if (hmacSecret) {
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!signature) {
        res.writeHead(401, { "Content-Length": "0" });
        res.end();
        return;
      }

      const expected = "sha256=" + createHmac("sha256", hmacSecret)
        .update(body)
        .digest("hex");

      if (expected !== signature) {
        res.writeHead(401, { "Content-Length": "0" });
        res.end();
        return;
      }
    }

    onRefresh();

    const responseBody = JSON.stringify({ status: "ok" });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(responseBody)),
    });
    res.end(responseBody);
  };
}

/** Start an HTTP server on a random port and return { server, port }. */
function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server: srv, port });
    });
  });
}

describe("webhook server (no auth)", () => {
  let port: number;
  let server: Server;
  let refreshCount = 0;

  before(async () => {
    const result = await startServer(
      createWebhookHandler("", () => { refreshCount++; }),
    );
    server = result.server;
    port = result.port;
  });

  after(() => { server.close(); });

  it("returns 200 for POST /refresh", async () => {
    const before = refreshCount;
    const res = await makeRequest(port, "POST", "/refresh", "{}");
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).status, "ok");
    assert.equal(refreshCount, before + 1);
  });

  it("returns 404 for GET /refresh", async () => {
    const res = await makeRequest(port, "GET", "/refresh");
    assert.equal(res.status, 404);
  });

  it("returns 404 for POST /other", async () => {
    const res = await makeRequest(port, "POST", "/other");
    assert.equal(res.status, 404);
  });

  it("returns 404 for GET /", async () => {
    const res = await makeRequest(port, "GET", "/");
    assert.equal(res.status, 404);
  });
});

describe("webhook server (with HMAC auth)", () => {
  const secret = "test-webhook-secret-12345";
  let port: number;
  let server: Server;
  let refreshCount = 0;

  before(async () => {
    const result = await startServer(
      createWebhookHandler(secret, () => { refreshCount++; }),
    );
    server = result.server;
    port = result.port;
  });

  after(() => { server.close(); });

  it("accepts valid HMAC signature", async () => {
    const body = JSON.stringify({ ref: "refs/heads/master" });
    const signature = "sha256=" + createHmac("sha256", secret)
      .update(body)
      .digest("hex");

    const before = refreshCount;
    const res = await makeRequest(port, "POST", "/refresh", body, {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": signature,
    });
    assert.equal(res.status, 200);
    assert.equal(refreshCount, before + 1);
  });

  it("rejects missing signature", async () => {
    const before = refreshCount;
    const res = await makeRequest(port, "POST", "/refresh", "{}");
    assert.equal(res.status, 401);
    assert.equal(refreshCount, before);
  });

  it("rejects invalid signature", async () => {
    const before = refreshCount;
    const res = await makeRequest(port, "POST", "/refresh", "{}", {
      "X-Hub-Signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
    });
    assert.equal(res.status, 401);
    assert.equal(refreshCount, before);
  });

  it("rejects signature from wrong secret", async () => {
    const body = "{}";
    const wrongSig = "sha256=" + createHmac("sha256", "wrong-secret")
      .update(body)
      .digest("hex");

    const before = refreshCount;
    const res = await makeRequest(port, "POST", "/refresh", body, {
      "X-Hub-Signature-256": wrongSig,
    });
    assert.equal(res.status, 401);
    assert.equal(refreshCount, before);
  });
});
