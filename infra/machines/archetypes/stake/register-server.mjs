// Seed registration endpoint — receives phone-home POSTs from netboot machines.
// POST /register → writes { mac, ip, serial, timestamp } to /var/lib/seed-register/<mac>.json
// GET /machines → returns all registered machines as JSON array

import { createServer } from "node:http";
import { writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PORT = 8081;
const STATE_DIR = "/var/lib/seed-register";

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/register") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (!data.mac || !data.ip) {
          res.writeHead(400);
          res.end("Missing mac or ip");
          return;
        }
        const record = {
          mac: data.mac,
          ip: data.ip,
          serial: data.serial || "unknown",
          timestamp: new Date().toISOString(),
        };
        const filename = data.mac.replace(/:/g, "-") + ".json";
        writeFileSync(join(STATE_DIR, filename), JSON.stringify(record, null, 2));
        console.log(`Registered: ${data.ip} (MAC: ${data.mac}, serial: ${data.serial})`);
        res.writeHead(200);
        res.end("OK");
      } catch (err) {
        res.writeHead(400);
        res.end("Invalid JSON");
      }
    });
  } else if (req.method === "GET" && req.url === "/machines") {
    try {
      const machines = readdirSync(STATE_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try {
            return JSON.parse(readFileSync(join(STATE_DIR, f), "utf-8"));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(machines, null, 2));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    }
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Registration endpoint listening on :${PORT}`);
});
