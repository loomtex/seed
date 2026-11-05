// Tests for pool-manager/vm.ts clhRequest and controller/pool-client.ts poolExec —
// a hung CLH must fail, and only pool infrastructure failures are retried.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { clhRequest } from "../pool-manager/vm.js";
import { poolExec } from "../controller/pool-client.js";
import { TransientApiError } from "../shared/kube.js";

describe("clhRequest", () => {
  const dir = mkdtempSync(join(tmpdir(), "clh-test-"));
  const socket = join(dir, "api.sock");
  // Answers /ok, never answers anything else (a hung CLH).
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") { res.writeHead(204); res.end(); }
  });

  before(() => new Promise<void>((resolve) => { server.listen(socket, resolve); }));
  after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a response from a live CLH", async () => {
    const resp = await clhRequest(socket, "GET", "/ok");
    assert.equal(resp.status, 204);
  });

  it("rejects when CLH never answers", async () => {
    await assert.rejects(
      clhRequest(socket, "PUT", "/api/v1/vm.resume", undefined, 50),
      /CLH PUT \/api\/v1\/vm\.resume timed out after 50ms/,
    );
  });
});

describe("poolExec", () => {
  let status = 200;
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(status === 200 ? '{"exitCode":1,"stdout":"","stderr":"eval failed"}' : '{"error":"boom"}');
  });
  let url = "";

  before(() => new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  }));
  after(() => { server.closeAllConnections(); server.close(); });

  const request = { command: ["true"] };

  it("returns a failed command as a normal result", async () => {
    status = 200;
    assert.equal((await poolExec(url, request)).exitCode, 1);
  });

  it("treats 503 (no VM came up) as transient", async () => {
    status = 503;
    await assert.rejects(poolExec(url, request), TransientApiError);
  });

  it("does not retry a 500 (e.g. an eval timeout)", async () => {
    status = 500;
    await assert.rejects(poolExec(url, request), (err: Error) => {
      assert.ok(!(err instanceof TransientApiError));
      assert.match(err.message, /pool manager returned 500/);
      return true;
    });
  });

  it("treats an unreachable pool manager as transient", async () => {
    await assert.rejects(poolExec("http://127.0.0.1:1", request), TransientApiError);
  });
});
