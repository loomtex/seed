// seed-sign — sign a plant invite code with a seed identity key
//
// Usage:
//   seed-sign <invite-code> <identity-key-file>
//
// Produces a base64-encoded SSH signature suitable for the plant command:
//   ssh seed.loom.farm plant <flake-uri> <invite-code> <signature>

import { execFileSync } from "node:child_process";

function usage(): never {
  process.stderr.write(
    "usage: seed-sign <invite-code> <identity-key-file>\n" +
    "\n" +
    "Sign a plant invite code with your seed identity private key.\n" +
    "Outputs a base64 signature for use with the plant command.\n" +
    "\n" +
    "Example:\n" +
    "  SIG=$(seed-sign a3f8c2e1 .seed-identity-key)\n" +
    "  ssh seed.loom.farm plant silo:my-app a3f8c2e1 \"$SIG\"\n"
  );
  process.exit(1);
}

const inviteCode = process.argv[2];
const keyFile = process.argv[3];

if (!inviteCode || !keyFile || inviteCode === "--help" || inviteCode === "-h") {
  usage();
}

try {
  // ssh-keygen -Y sign reads the message from stdin
  const armoredSig = execFileSync(
    "ssh-keygen",
    ["-Y", "sign", "-n", "seed", "-f", keyFile],
    { input: inviteCode, encoding: "utf-8" },
  ).trim();

  // Base64-encode the entire armored signature (the plant API expects this)
  const b64 = Buffer.from(armoredSig).toString("base64");
  process.stdout.write(b64 + "\n");
} catch (e: any) {
  process.stderr.write(`error: failed to sign — ${e.message}\n`);
  process.exit(1);
}
