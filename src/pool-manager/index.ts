// Pool manager HTTP server — manages a pool of CLH VMs for
// hardware-isolated nix eval/build execution.
//
// Endpoints:
//   POST /exec  — execute a command in a pool VM
//   GET /health — pool status (idle/busy/total)
//
// Env vars:
//   SEED_POOL_SIZE        — number of warm VM slots (default 2)
//   SEED_POOL_PORT        — HTTP API port (default 9877)
//   SEED_POOL_KERNEL      — path to guest kernel (vmlinux)
//   SEED_POOL_INITRAMFS   — path to guest initramfs (cpio.gz)
//   SEED_CLH_BINARY       — path to cloud-hypervisor binary
//   SEED_VIRTIOFSD_BINARY — path to virtiofsd binary

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { log } from "../shared/kube.js";
import { Pool, type PoolConfig } from "./pool.js";
import type { ExecRequest } from "./vm.js";

const COMPONENT = "pool-manager";

function loadConfig(): PoolConfig {
  const kernelPath = process.env["SEED_POOL_KERNEL"];
  if (!kernelPath) throw new Error("SEED_POOL_KERNEL must be set");

  const initramfsPath = process.env["SEED_POOL_INITRAMFS"];
  if (!initramfsPath) throw new Error("SEED_POOL_INITRAMFS must be set");

  const clhBinary = process.env["SEED_CLH_BINARY"] || "cloud-hypervisor";
  const virtiofsdBinary = process.env["SEED_VIRTIOFSD_BINARY"] || "virtiofsd";

  return {
    poolSize: parseInt(process.env["SEED_POOL_SIZE"] || "2", 10),
    kernelPath,
    initramfsPath,
    clhBinary,
    virtiofsdBinary,
    vcpus: 2,
    memory: "2G",
    workDir: "/run/seed-pool",
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const port = parseInt(process.env["SEED_POOL_PORT"] || "9877", 10);

  log(COMPONENT, `starting (poolSize=${config.poolSize}, port=${port})`);

  const pool = new Pool(config);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(COMPONENT, "shutting down");
    await pool.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => { shutdown(); });
  process.on("SIGINT", () => { shutdown(); });

  // Start pool initialization (async — server starts immediately, /exec
  // will wait until pool is ready)
  const poolReady = pool.start().catch((err) => {
    log(COMPONENT, `fatal: pool initialization failed: ${err}`);
    process.exit(1);
  });

  // HTTP server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        const status = pool.status();
        const body = JSON.stringify(status);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
        });
        res.end(body);
        return;
      }

      if (req.method === "POST" && req.url === "/exec") {
        // Wait for pool to be ready if still initializing
        await poolReady;

        // Read request body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks).toString();

        let request: ExecRequest;
        try {
          request = JSON.parse(body) as ExecRequest;
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON" }));
          return;
        }

        if (!request.command || !Array.isArray(request.command) || request.command.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "command must be a non-empty array" }));
          return;
        }

        log(COMPONENT, `exec: ${request.command.join(" ")}`);
        const result = await pool.exec(request);

        const responseBody = JSON.stringify(result);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(responseBody)),
        });
        res.end(responseBody);
        return;
      }

      // 404 for everything else
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(COMPONENT, `request error: ${msg}`);

      if (!res.headersSent) {
        const errorBody = JSON.stringify({ error: msg });
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(errorBody)),
        });
        res.end(errorBody);
      }
    }
  });

  server.listen(port, "0.0.0.0", () => {
    log(COMPONENT, `listening on 0.0.0.0:${port}`);
  });
}

main().catch((err) => {
  log(COMPONENT, `fatal: ${err}`);
  process.exit(1);
});
