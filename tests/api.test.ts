// Unit tests for the controller management API.
// Tests key index updates, route parsing, and response formatting.
// Run: node --test tests/api.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { updateKeyIndex, handleApiRequest, initApi, updateValidNamespaces, parseLogLine } from "../src/controller/api.js";

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

describe("parseLogLine", () => {
  it("extracts timestamp + unit-prefixed message from journal JSON", () => {
    const line = JSON.stringify({
      __REALTIME_TIMESTAMP: "1780358887852000",
      UNIT: "sshd.service",
      MESSAGE: "Accepted publickey",
    });
    const { ts, msg } = parseLogLine(line);
    assert.equal(ts, "2026-06-02T00:08:07.852Z");
    assert.equal(msg, "sshd.service: Accepted publickey");
  });

  it("produces the slice the shell's jq renderer formats (MM-DD HH:MM:SS)", () => {
    // The shell renders `.ts[5:19] | gsub("T";" ")`. Pin that contract here so a
    // change to the ISO shape can't silently break the shell's timestamp column.
    const { ts } = parseLogLine(
      JSON.stringify({ __REALTIME_TIMESTAMP: "1780358887852000", MESSAGE: "x" }),
    );
    assert.equal(ts.slice(5, 19).replace("T", " "), "06-02 00:08:07");
  });

  it("falls back to SYSLOG_IDENTIFIER when UNIT is absent", () => {
    const { msg } = parseLogLine(
      JSON.stringify({ SYSLOG_IDENTIFIER: "kernel", MESSAGE: "boot" }),
    );
    assert.equal(msg, "kernel: boot");
  });

  it("leaves the message unprefixed when there is no unit identifier", () => {
    const { ts, msg } = parseLogLine(JSON.stringify({ MESSAGE: "bare message" }));
    assert.equal(ts, "");
    assert.equal(msg, "bare message");
  });

  it("emits an empty timestamp when __REALTIME_TIMESTAMP is missing or invalid", () => {
    assert.equal(parseLogLine(JSON.stringify({ MESSAGE: "a" })).ts, "");
    assert.equal(
      parseLogLine(JSON.stringify({ __REALTIME_TIMESTAMP: "0", MESSAGE: "a" })).ts,
      "",
    );
    assert.equal(
      parseLogLine(JSON.stringify({ __REALTIME_TIMESTAMP: "notnum", MESSAGE: "a" })).ts,
      "",
    );
  });

  it("passes non-JSON lines through verbatim with no timestamp", () => {
    const raw = "[    0.000000] Linux version 6.18";
    assert.deepEqual(parseLogLine(raw), { ts: "", msg: raw });
  });

  it("passes JSON without a MESSAGE field through as the raw line", () => {
    const line = JSON.stringify({ __REALTIME_TIMESTAMP: "1780358887852000", PRIORITY: "6" });
    assert.deepEqual(parseLogLine(line), { ts: "", msg: line });
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
