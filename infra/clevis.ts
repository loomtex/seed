import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fetch Tang server advertisement (public signing keys).
// Returns the advertisement JSON for non-interactive JWE creation.
export function fetchTangAdvertisement(tangUrl: string): string {
  const result = execFileSync("curl", ["-sfS", `${tangUrl}/adv`], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  return result.trim();
}

// Create a Clevis JWE that encrypts the given passphrase to a Tang server.
// Uses nix-shell for clevis/jose tools. Operates non-interactively by
// pre-fetching the Tang advertisement.
export function createClevisJWE(
  passphrase: string,
  tangUrl: string
): string {
  // Fetch Tang advertisement first (non-interactive)
  const adv = fetchTangAdvertisement(tangUrl);
  const tmpDir = mkdtempSync(join(tmpdir(), "clevis-"));
  const advFile = join(tmpDir, "tang-adv.json");
  writeFileSync(advFile, adv);

  // Create JWE using clevis via nix-shell
  const tangConfig = JSON.stringify({ url: tangUrl, adv: advFile });
  const jwe = execSync(
    `echo -n ${shellQuote(passphrase)} | nix-shell -p clevis jose --run ${shellQuote(`clevis encrypt tang '${tangConfig}'`)}`,
    {
      encoding: "utf-8",
      timeout: 60_000,
      env: { ...process.env, NIX_CONFIG: "experimental-features = nix-command flakes" },
    }
  );

  return jwe.trim();
}

// Generate a cryptographically random passphrase (base64, 32 bytes).
export function generateLuksPassphrase(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
