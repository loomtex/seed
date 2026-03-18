// Acceptance test runner — discovers tests, executes against live cluster, reports results.

import { ssh, k8sClients, type TestContext, type AcceptanceTest, type TestResult } from "./helpers.js";
import { tests as cacheTests } from "./cache.test.js";
import { tests as podsTests } from "./pods.test.js";
import { tests as networkTests } from "./network.test.js";
import { tests as controllerTests } from "./controller.test.js";

const allTests: AcceptanceTest[] = [
  ...cacheTests,
  ...podsTests,
  ...networkTests,
  ...controllerTests,
];

// --- CLI ---

function usage(): never {
  console.log(`Usage: seed-acceptance [--category <name>] [--list]

Environment:
  SEED_NODES        Comma-separated SSH hostnames (default: seed-atl1-1,seed-atl1-2,seed-atl1-3)
  SEED_S3_BUCKET    Binary cache bucket (default: seed-nix-cache)
  SEED_S3_ENDPOINT  S3 endpoint (default: atl2.vultrobjects.com)
  KUBECONFIG        k8s config path (default: ~/.kube/config)`);
  process.exit(0);
}

function parseArgs(argv: string[]): { category?: string; list: boolean } {
  let category: string | undefined;
  let list = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--category" && i + 1 < argv.length) {
      category = argv[++i];
    } else if (argv[i] === "--list") {
      list = true;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      usage();
    }
  }

  return { category, list };
}

// --- Runner ---

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let tests = allTests;
  if (args.category) {
    tests = tests.filter((t) => t.category === args.category);
    if (tests.length === 0) {
      const categories = [...new Set(allTests.map((t) => t.category))];
      console.error(`No tests in category "${args.category}". Available: ${categories.join(", ")}`);
      process.exit(1);
    }
  }

  if (args.list) {
    for (const t of tests) {
      console.log(`[${t.category}] ${t.name}`);
    }
    process.exit(0);
  }

  // Build context
  const nodes = (process.env.SEED_NODES ?? "seed-atl1-1,seed-atl1-2,seed-atl1-3").split(",");
  const s3 = {
    bucket: process.env.SEED_S3_BUCKET ?? "seed-nix-cache",
    endpoint: process.env.SEED_S3_ENDPOINT ?? "atl2.vultrobjects.com",
  };

  let k8s;
  try {
    k8s = k8sClients();
  } catch (err) {
    console.error(`Failed to initialize k8s client: ${err}`);
    process.exit(1);
  }

  const ctx: TestContext = { nodes, k8s, ssh, s3 };

  // Run tests
  console.log(`\nRunning ${tests.length} acceptance test(s)...\n`);

  let passed = 0;
  let failed = 0;
  const failures: { name: string; message: string }[] = [];

  for (const test of tests) {
    const label = `[${test.category}] ${test.name}`;
    let result: TestResult;
    try {
      result = await test.run(ctx);
    } catch (err) {
      result = { pass: false, message: `exception: ${err}` };
    }

    if (result.pass) {
      console.log(`  PASS  ${label}`);
      console.log(`        ${result.message}`);
      passed++;
    } else {
      console.log(`  FAIL  ${label}`);
      for (const line of result.message.split("\n")) {
        console.log(`        ${line}`);
      }
      failed++;
      failures.push({ name: test.name, message: result.message });
    }
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed, ${tests.length} total`);

  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) {
      console.log(`  - ${f.name}`);
    }
  }

  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

main();
