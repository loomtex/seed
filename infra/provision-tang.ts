import { execFileSync, execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { sshToAge, addNodeToSops, reencryptSecrets } from "./sops.ts";

export interface TangProvisionConfig {
  name: string;
  flakeRef: string; // e.g. "github:joshperry/mynix#seed-tang-atl"
  mynixDir: string;
  cacheBucket?: string;
  cacheEndpoint?: string;
  cachePublicKey?: string;
}

interface SSHKeyPair {
  privateKey: string;
  publicKey: string;
}

function generateSSHKeys(
  comment: string,
  type: "ed25519" | "rsa" = "ed25519"
): SSHKeyPair {
  const tmpDir = mkdtempSync(join(tmpdir(), "ssh-"));
  const keyPath = join(tmpDir, "key");

  const args = ["-t", type, "-C", comment, "-f", keyPath, "-N", ""];
  if (type === "rsa") {
    args.push("-b", "4096");
  }
  execFileSync("ssh-keygen", args, { stdio: "pipe" });

  const privateKey = execFileSync("cat", [keyPath], { encoding: "utf-8" });
  const publicKey = execFileSync("cat", [`${keyPath}.pub`], {
    encoding: "utf-8",
  });

  rmSync(tmpDir, { recursive: true });

  return { privateKey: privateKey.trim(), publicKey: publicKey.trim() };
}

function waitForSSH(
  ip: string,
  { timeout = 600, port = 22, user = "root" } = {}
): void {
  const deadline = Date.now() + timeout * 1000;
  const baseOpts = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=5",
  ];

  const sshArgs = [...baseOpts, "-p", String(port), `${user}@${ip}`, "true"];

  while (Date.now() < deadline) {
    try {
      execFileSync("ssh", sshArgs, { stdio: "pipe", timeout: 15_000 });
      return;
    } catch {
      execFileSync("sleep", ["5"]);
    }
  }
  throw new Error(`SSH to ${ip}:${port} not available after ${timeout}s`);
}

function waitForSSHDown(
  ip: string,
  { timeout = 120 }: { timeout?: number } = {}
): void {
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    try {
      execFileSync(
        "ssh",
        [
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          "-o", "ConnectTimeout=3",
          `root@${ip}`,
          "true",
        ],
        { stdio: "pipe", timeout: 8_000 }
      );
      execFileSync("sleep", ["3"]);
    } catch {
      return;
    }
  }
  pulumi.log.warn(`SSH to ${ip} did not go down within ${timeout}s`);
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Simplified provisioner for tang VMs — no LUKS, no Clevis, no k3s.
export function provisionTang(
  ip: string,
  config: TangProvisionConfig
): { agePublicKey: string } {
  pulumi.log.info(`Provisioning tang ${config.name} at ${ip}...`);

  // Check if already provisioned
  const user = userInfo().username;
  try {
    const hostname = execFileSync("ssh", [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      `${user}@${ip}`,
      "hostname",
    ], { encoding: "utf-8", timeout: 15_000 }).trim();

    if (hostname === config.name) {
      pulumi.log.info(`${config.name}: already provisioned, skipping`);
      const existingPubKey = execFileSync("ssh", [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        `${user}@${ip}`,
        "cat /etc/ssh/ssh_host_ed25519_key.pub",
      ], { encoding: "utf-8", timeout: 15_000 }).trim();
      return { agePublicKey: sshToAge(existingPubKey) };
    }
  } catch {
    pulumi.log.info(`${config.name}: not yet provisioned, proceeding`);
  }

  // 1. Generate SSH host keys
  pulumi.log.info(`${config.name}: generating SSH host keys`);
  const hostEd25519 = generateSSHKeys(`root@${config.name}`, "ed25519");
  const hostRsa = generateSSHKeys(`root@${config.name}`, "rsa");

  // 2. Derive age key
  const agePublicKey = sshToAge(hostEd25519.publicKey);
  pulumi.log.info(`${config.name}: age key = ${agePublicKey}`);

  // 3. Update .sops.yaml
  pulumi.log.info(`${config.name}: updating sops configuration`);
  const sopsYamlPath = join(config.mynixDir, ".sops.yaml");
  addNodeToSops(sopsYamlPath, config.name, agePublicKey);

  // 4. Re-encrypt shared secrets
  pulumi.log.info(`${config.name}: re-encrypting seed-system.yaml`);
  reencryptSecrets(config.mynixDir, "secrets/seed-system.yaml");

  // 5. Commit + push sops changes
  execSync(
    `cd ${shellQuote(config.mynixDir)} && git add .sops.yaml secrets/ && git commit -m "infra: add sops config for ${config.name}" && git push`,
    { stdio: "pipe", timeout: 30_000 }
  );

  // 6. Prepare extra-files (SSH host keys only — no LUKS, no Clevis)
  pulumi.log.info(`${config.name}: preparing extra-files`);
  const extraDir = mkdtempSync(join(tmpdir(), "tang-extra-"));
  const sshDir = join(extraDir, "etc", "ssh");
  mkdirSync(sshDir, { recursive: true });
  writeFileSync(join(sshDir, "ssh_host_ed25519_key"), hostEd25519.privateKey + "\n", { mode: 0o600 });
  writeFileSync(join(sshDir, "ssh_host_ed25519_key.pub"), hostEd25519.publicKey + "\n", { mode: 0o644 });
  writeFileSync(join(sshDir, "ssh_host_rsa_key"), hostRsa.privateKey + "\n", { mode: 0o600 });
  writeFileSync(join(sshDir, "ssh_host_rsa_key.pub"), hostRsa.publicKey + "\n", { mode: 0o644 });

  // 7. Wait for Debian SSH
  pulumi.log.info(`${config.name}: waiting for SSH at ${ip}`);
  waitForSSH(ip, { timeout: 300 });

  // 8. Run nixos-anywhere (no disk encryption, simple install)
  pulumi.log.info(`${config.name}: running nixos-anywhere`);
  execSync(
    [
      "nixos-anywhere",
      "--flake",
      config.flakeRef,
      "--build-on-remote",
      "--extra-files",
      extraDir,
      "--phases",
      "disko,install,reboot",
      `root@${ip}`,
    ].join(" "),
    {
      stdio: "inherit",
      timeout: 1800_000,
      env: {
        ...process.env,
        NIX_CONFIG: "experimental-features = nix-command flakes\ntarball-ttl = 0",
      },
    }
  );

  // 9. Wait for reboot + verify
  pulumi.log.info(`${config.name}: waiting for reboot`);
  waitForSSHDown(ip, { timeout: 120 });
  pulumi.log.info(`${config.name}: waiting for post-install SSH`);
  waitForSSH(ip, { timeout: 300, user });

  const hostname = execFileSync("ssh", [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    `${user}@${ip}`,
    "hostname",
  ], { encoding: "utf-8", timeout: 15_000 }).trim();

  if (hostname !== config.name) {
    pulumi.log.warn(`Expected hostname ${config.name}, got ${hostname}`);
  }

  // Cleanup
  rmSync(extraDir, { recursive: true });

  pulumi.log.info(`${config.name}: provisioning complete`);
  return { agePublicKey };
}
