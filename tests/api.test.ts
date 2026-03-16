// Unit tests for the controller management API.
// Tests key index updates, route parsing, and response formatting.
// Run: node --test tests/api.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { updateKeyIndex, handleApiRequest, initApi, updateValidNamespaces } from "../src/controller/api.js";

// Mock KubeClients — we only test routing and key index, not k8s calls
const mockClients = {
  core: {} as any,
  apps: {} as any,
  batch: {} as any,
  custom: {} as any,
  node: {} as any,
};

describe("key index", () => {
  it("returns empty index initially", async () => {
    initApi(mockClients, {} as any, new Set());

    const { status, body } = await simulateRequest("GET", "/api/keys");
    assert.equal(status, 200);
    assert.deepEqual(body.keys, {});
  });

  it("returns updated keys after updateKeyIndex", async () => {
    initApi(mockClients, {} as any, new Set(["s-test123"]));

    updateKeyIndex({
      keys: {
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake": ["s-test123"],
      },
    });

    const { status, body } = await simulateRequest("GET", "/api/keys");
    assert.equal(status, 200);
    assert.deepEqual(body.keys["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake"], ["s-test123"]);
  });

  it("supports multiple namespaces per key", async () => {
    updateKeyIndex({
      keys: {
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake": ["s-ns1", "s-ns2"],
      },
    });

    const { status, body } = await simulateRequest("GET", "/api/keys");
    assert.equal(status, 200);
    assert.equal(body.keys["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake"].length, 2);
  });
});

describe("API routing", () => {
  it("returns false for non-API routes", async () => {
    const req = mockReq("GET", "/refresh");
    const res = mockRes();
    const handled = await handleApiRequest(req, res);
    assert.equal(handled, false);
  });

  it("returns 404 for unknown API routes", async () => {
    initApi(mockClients, {} as any, new Set());
    const { status } = await simulateRequest("GET", "/api/unknown");
    assert.equal(status, 404);
  });

  it("returns 404 for invalid namespace", async () => {
    initApi(mockClients, {} as any, new Set(["s-valid"]));
    const { status } = await simulateRequest("GET", "/api/ns/s-invalid/status");
    assert.equal(status, 404);
  });
});

// --- Test helpers ---

function mockReq(method: string, url: string): any {
  return { method, url, headers: {} };
}

function mockRes(): any {
  let _status = 0;
  let _body = "";
  return {
    writeHead(status: number, headers: Record<string, string>) {
      _status = status;
    },
    end(body?: string) {
      _body = body || "";
    },
    get status() { return _status; },
    get body() { return _body; },
  };
}

async function simulateRequest(method: string, url: string): Promise<{ status: number; body: any }> {
  const req = mockReq(method, url);
  const res = mockRes();
  await handleApiRequest(req, res);
  return {
    status: res.status,
    body: res.body ? JSON.parse(res.body) : null,
  };
}
