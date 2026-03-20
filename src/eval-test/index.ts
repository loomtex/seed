// Eval test — can an LLM produce a working seed instance config from the docs?
//
// Sends the README (and optionally source) to models via OpenRouter,
// asks them to write a seed instance, then validates with nix eval.
//
// Usage:
//   OPENROUTER_API_KEY=... npx tsx src/eval-test/index.ts
//   OPENROUTER_API_KEY=... npx tsx src/eval-test/index.ts --source  # include source tar
//
// Environment:
//   OPENROUTER_API_KEY   Required
//   EVAL_MODELS          Comma-separated model IDs (default: see below)

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

const REPO_ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();

const DEFAULT_MODELS = [
  "anthropic/claude-sonnet-4",
  "openai/gpt-4.1",
  "google/gemini-2.5-pro",
];

const TASK_PROMPT = `You are an AI agent helping a user deploy a web application to the Seed platform.

The user wants:
- A Caddy web server that handles TLS and proxies requests to a Node.js backend
- The Node.js backend is a simple HTTP server on port 3000 that responds with "Hello from Seed!"
- The Node.js server should run as a systemd service
- TLS should use the platform's ACME endpoint

Produce the complete nix files needed: a flake.nix and a web.nix (the instance module).
The flake.nix should use github:loomtex/seed as an input.

Return ONLY the file contents, no explanation. Use this exact format:

--- flake.nix ---
<contents>
--- web.nix ---
<contents>`;

// --- OpenRouter API ---

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ModelResult {
  model: string;
  mode: "readme" | "source";
  prompt: string;
  response: string;
  files: Record<string, string>;
  evalResult: { success: boolean; output: string };
  buildResult?: { success: boolean; output: string };
  usage?: CompletionResult["usage"];
}

interface CompletionResult {
  content: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    total_cost?: number;
  };
}

async function chatCompletion(model: string, messages: Message[]): Promise<CompletionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 4096,
      temperature: 0,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; total_cost?: number };
  };
  return {
    content: json.choices[0]?.message?.content ?? "",
    usage: json.usage,
  };
}

// --- Context builders ---

function readmeContext(): string {
  return readFileSync(join(REPO_ROOT, "README.md"), "utf-8");
}

function sourceContext(): string {
  // Collect relevant source files, excluding infra/, node_modules/, .git/
  const exclude = new Set(["infra", "node_modules", ".git", "result", "site", "patches"]);
  const nixFiles: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (exclude.has(entry)) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".nix")) {
        nixFiles.push(full);
      }
    }
  }

  walk(REPO_ROOT);

  const parts: string[] = [];
  for (const f of nixFiles.sort()) {
    const rel = relative(REPO_ROOT, f);
    const content = readFileSync(f, "utf-8");
    // Skip very large files
    if (content.length > 20000) {
      parts.push(`--- ${rel} --- (truncated, ${content.length} chars)`);
      parts.push(content.slice(0, 5000) + "\n...(truncated)");
    } else {
      parts.push(`--- ${rel} ---`);
      parts.push(content);
    }
  }

  return parts.join("\n");
}

// --- File extraction ---

function extractFiles(response: string): Record<string, string> {
  const files: Record<string, string> = {};
  const pattern = /---\s*(\S+\.nix)\s*---\s*\n([\s\S]*?)(?=\n---\s*\S+\.nix\s*---|$)/g;

  // Also try ```nix fenced blocks with filename headers
  const fencedPattern = /(?:#+\s*)?`?(\S+\.nix)`?\s*\n```nix\n([\s\S]*?)```/g;

  let match;
  while ((match = pattern.exec(response)) !== null) {
    let content = match[2].trim();
    // Strip markdown code fences if present
    content = content.replace(/^```nix\n?/, "").replace(/\n?```$/, "");
    files[match[1]] = content;
  }

  // Fallback to fenced blocks if --- pattern didn't match
  if (Object.keys(files).length === 0) {
    while ((match = fencedPattern.exec(response)) !== null) {
      files[match[1]] = match[2].trim();
    }
  }

  return files;
}

// --- Nix validation ---

function validateNix(
  files: Record<string, string>,
): { evalResult: { success: boolean; output: string }; buildResult?: { success: boolean; output: string } } {
  const tmpDir = mkdtempSync(join(tmpdir(), "seed-eval-"));

  try {
    // Write files
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(tmpDir, name), content);
    }

    // Init git (nix flake requires it)
    execSync("git init && git add -A", { cwd: tmpDir, stdio: "pipe" });

    // Try nix eval
    let evalResult: { success: boolean; output: string };
    try {
      const output = execSync(
        "nix eval .#seeds.web.meta --json 2>&1",
        { cwd: tmpDir, encoding: "utf-8", timeout: 120000 },
      );
      evalResult = { success: true, output: output.trim() };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      evalResult = {
        success: false,
        output: (e.stderr || e.stdout || e.message || "unknown error").slice(-3000),
      };
    }

    return { evalResult };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- Main ---

async function runTest(model: string, mode: "readme" | "source"): Promise<ModelResult> {
  const contextLabel = mode === "readme" ? "README.md" : "README.md + source";
  console.log(`  ${model} (${contextLabel})...`);

  let context: string;
  if (mode === "readme") {
    context = `Here is the Seed platform documentation:\n\n${readmeContext()}`;
  } else {
    const readme = readmeContext();
    const source = sourceContext();
    context = `Here is the Seed platform documentation:\n\n${readme}\n\nHere are the relevant source files:\n\n${source}`;
  }

  const fullPrompt = `${context}\n\n${TASK_PROMPT}`;
  const messages: Message[] = [
    { role: "user", content: fullPrompt },
  ];

  const completion = await chatCompletion(model, messages);
  const files = extractFiles(completion.content);

  if (Object.keys(files).length === 0) {
    return {
      model,
      mode,
      prompt: fullPrompt,
      response: completion.content,
      files: {},
      evalResult: { success: false, output: "no nix files extracted from response" },
      usage: completion.usage,
    };
  }

  const { evalResult, buildResult } = validateNix(files);

  return { model, mode, prompt: fullPrompt, response: completion.content, files, evalResult, buildResult, usage: completion.usage };
}

async function main() {
  const args = process.argv.slice(2);
  const includeSource = args.includes("--source");
  const modelsEnv = process.env.EVAL_MODELS;
  const models = modelsEnv ? modelsEnv.split(",") : DEFAULT_MODELS;
  const modes: Array<"readme" | "source"> = includeSource ? ["readme", "source"] : ["readme"];

  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY not set");
    process.exit(1);
  }

  console.log(`\nSeed eval test`);
  console.log(`Models: ${models.join(", ")}`);
  console.log(`Modes: ${modes.join(", ")}\n`);

  const results: ModelResult[] = [];

  for (const mode of modes) {
    for (const model of models) {
      try {
        const result = await runTest(model, mode);
        results.push(result);
      } catch (err) {
        console.log(`  ${model} (${mode}): ERROR — ${err}`);
        results.push({
          model,
          mode,
          prompt: "",
          response: "",
          files: {},
          evalResult: { success: false, output: `${err}` },
        });
      }
    }
  }

  // Summary
  console.log(`\n${"=".repeat(70)}`);
  console.log("Results:\n");

  const colModel = 40;
  const colMode = 8;
  console.log(
    `  ${"Model".padEnd(colModel)} ${"Mode".padEnd(colMode)} Eval   Tokens     Cost`,
  );
  console.log(`  ${"-".repeat(colModel)} ${"-".repeat(colMode)} ----   ------     ----`);

  for (const r of results) {
    const evalStatus = r.evalResult.success ? "PASS" : "FAIL";
    const tokens = r.usage?.total_tokens ? String(r.usage.total_tokens).padStart(6) : "     ?";
    const cost = r.usage?.total_cost != null ? `$${r.usage.total_cost.toFixed(4)}` : "?";
    console.log(
      `  ${r.model.padEnd(colModel)} ${r.mode.padEnd(colMode)} ${evalStatus}   ${tokens}     ${cost}`,
    );
  }

  // Detail on failures
  const failures = results.filter((r) => !r.evalResult.success);
  if (failures.length > 0) {
    console.log(`\n${"=".repeat(70)}`);
    console.log("Failure details:\n");
    for (const r of failures) {
      console.log(`--- ${r.model} (${r.mode}) ---`);
      if (Object.keys(r.files).length > 0) {
        for (const [name, content] of Object.entries(r.files)) {
          console.log(`\n  ${name}:`);
          for (const line of content.split("\n").slice(0, 30)) {
            console.log(`    ${line}`);
          }
          if (content.split("\n").length > 30) console.log("    ...(truncated)");
        }
      }
      console.log(`\n  eval output:`);
      for (const line of r.evalResult.output.split("\n").slice(0, 20)) {
        console.log(`    ${line}`);
      }
      console.log();
    }
  }

  // Save per-model results to timestamped run directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(REPO_ROOT, "eval-results", timestamp);
  mkdirSync(runDir, { recursive: true });

  for (const r of results) {
    const slug = r.model.replace(/[/.:]/g, "-");
    const dir = join(runDir, `${slug}_${r.mode}`);
    mkdirSync(dir, { recursive: true });

    // Write the full prompt that was sent to the model
    writeFileSync(join(dir, "prompt.txt"), r.prompt);

    // Write generated nix files
    for (const [name, content] of Object.entries(r.files)) {
      writeFileSync(join(dir, name), content + "\n");
    }

    // Write raw response
    writeFileSync(join(dir, "response.txt"), r.response);

    // Write eval result
    writeFileSync(join(dir, "eval.txt"),
      `${r.evalResult.success ? "PASS" : "FAIL"}\n\n${r.evalResult.output}\n`);

    // Write metadata as JSON
    writeFileSync(join(dir, "meta.json"), JSON.stringify({
      model: r.model,
      mode: r.mode,
      evalPass: r.evalResult.success,
      filesGenerated: Object.keys(r.files),
      usage: r.usage ?? null,
    }, null, 2) + "\n");
  }

  console.log(`Results saved to ${runDir}/`);

  const anyFailed = results.some((r) => !r.evalResult.success);
  process.exit(anyFailed ? 1 : 0);
}

main();
