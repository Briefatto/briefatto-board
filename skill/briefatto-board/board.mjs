#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempDisposableSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { env, execPath, platform } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageName = "briefatto-board";
const skillDir = dirname(fileURLToPath(import.meta.url));
const checkoutFile = ".checkout-path";
const checkoutPath = join(skillDir, checkoutFile);
const root = resolve(skillDir, "..", "..");
const installedPackage = (project) => join(project, "node_modules", packageName);
const repo = existsSync(checkoutPath)
  ? resolve(readFileSync(checkoutPath, "utf8").trim())
  : basename(root) === ".claude" ? installedPackage(dirname(root)) : root;
const cli = join(repo, "dist", "board", "cli.js");
const checkout = existsSync(checkoutPath) || existsSync(join(repo, "src", "board", "cli.ts"));
const args = process.argv.slice(2);
const installing = args[0] === "install";

function npm(args, options) {
  if (platform !== "win32") return execFileSync("npm", args, options);
  // Windows npm shims are batch files. Run npm through Node without shell quoting.
  const roots = [dirname(execPath), ...(env.PATH ?? "").split(delimiter).filter(Boolean)];
  const npmCli = [env.npm_execpath, ...roots.map((dir) => join(dir, "node_modules", "npm", "bin", "npm-cli.js"))]
    .find((file) => file && basename(file) === "npm-cli.js" && existsSync(file));
  if (!npmCli) throw new Error("Could not find npm. Install Node.js with npm and retry.");
  return execFileSync(execPath, [npmCli, ...args], options);
}

function installPackage(project) {
  const installed = installedPackage(project);
  if (existsSync(installed) && realpathSync(installed) === realpathSync(repo)) return;

  // Keep a project-relative dependency so the launcher and npm install both work after npx cache cleanup.
  const staging = mkdtempDisposableSync(join(tmpdir(), "briefatto-board-"));
  try {
    const result = npm(["pack", "--ignore-scripts", "--json", "--pack-destination", staging.path],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    const source = join(staging.path, JSON.parse(result)[0].filename);
    const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
    const archives = join(project, ".claude", packageName);
    mkdirSync(archives, { recursive: true });
    const archive = join(archives, `${digest}.tgz`);
    copyFileSync(source, archive);
    const spec = "./" + relative(project, archive).split(sep).join("/");
    npm(["install", "--prefix", project, "--save-dev", "--include=dev", "--ignore-scripts", "--no-audit",
      "--no-fund", "--prefer-offline", spec], { cwd: project, stdio: "inherit" });
  } finally {
    staging.remove();
  }
}

if (installing && args.length !== 1) {
  console.error("Run `briefatto-board install` from your project root.");
  process.exit(2);
}
if (!existsSync(cli)) {
  console.error(checkout
    ? `board: Build the checkout at ${repo} with npm ci and npm run build, then retry.`
    : "board: Briefatto Board is missing. Run npm install in your project, or rerun the Briefatto Board installer.");
  process.exit(2);
}
if (installing) {
  try {
    const project = resolve(".");
    if (!checkout) installPackage(project);
    const source = join(repo, "skill", packageName);
    const destination = join(project, ".claude", "skills", packageName);
    mkdirSync(destination, { recursive: true });
    for (const name of ["SKILL.md", "board.mjs"]) {
      const from = join(source, name);
      const to = join(destination, name);
      if (from !== to) copyFileSync(from, to);
    }
    const marker = join(destination, checkoutFile);
    if (checkout) writeFileSync(marker, `${repo}\n`);
    else rmSync(marker, { force: true });
    const { installStandingInstructions } = await import(pathToFileURL(join(dirname(cli), "standing.js")).href);
    installStandingInstructions(project);
    console.log(`Installed briefatto-board at ${destination}`);
  } catch (error) {
    console.error(`board: ${error.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const result = spawnSync(execPath, [cli, ...args], { stdio: "inherit" });
if (result.error) console.error(`board: ${result.error.message}`);
process.exit(result.status ?? 1);
