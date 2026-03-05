import { execFile } from "child_process";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, resolve } from "path";
import { promisify } from "util";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveModuleDirectory } from "../core/module-resolver.js";
import { truncateOutput } from "../core/output.js";
import { runCompatibilityCheck } from "./compatibility-check.js";
import { runCopyrightCheck } from "./copyright-check.js";
import { runTranslationCheck } from "./translation-check.js";

const execFileAsync = promisify(execFile);

interface ReleaseGateResult {
  status: "PASS" | "WARN" | "FAIL";
  details: string;
  meta?: unknown;
}

function parseVersion(value: string): number[] | null {
  if (!/^\d+(?:\.\d+){2,3}$/.test(value.trim())) {
    return null;
  }
  return value.trim().split(".").map((part) => Number(part));
}

function compareVersions(left: string, right: string): number {
  const l = parseVersion(left);
  const r = parseVersion(right);
  if (!l || !r) {
    return left.localeCompare(right);
  }
  const len = Math.max(l.length, r.length);
  for (let i = 0; i < len; i += 1) {
    const a = l[i] ?? 0;
    const b = r[i] ?? 0;
    if (a !== b) {
      return a - b;
    }
  }
  return 0;
}

function isNextAllowedVersion(version: string, latest: string): boolean {
  const candidate = parseVersion(version);
  const base = parseVersion(latest);
  if (!candidate || !base) {
    return false;
  }
  const length = Math.max(candidate.length, base.length);
  while (candidate.length < length) candidate.push(0);
  while (base.length < length) base.push(0);
  let diffIndex = -1;
  for (let i = 0; i < length; i += 1) {
    if (candidate[i] !== base[i]) {
      diffIndex = i;
      break;
    }
  }
  if (diffIndex === -1) {
    return false;
  }
  if (candidate[diffIndex] !== (base[diffIndex] + 1)) {
    return false;
  }
  for (let i = diffIndex + 1; i < length; i += 1) {
    if (candidate[i] !== 0) {
      return false;
    }
  }
  return true;
}

function highestVersion(values: string[]): string | null {
  const clean = values.filter((value) => parseVersion(value));
  if (clean.length === 0) {
    return null;
  }
  return clean.sort(compareVersions).at(-1) ?? null;
}

function readVersionFromComposerJson(content: string): string {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  return typeof parsed.version === "string" ? parsed.version.trim() : "";
}

function readSetupVersionFromModuleXml(content: string): string {
  return content.match(/<module\b[^>]*\bsetup_version="([^"]+)"/i)?.[1]?.trim() ?? "";
}

function extractChangelogEntries(content: string): Array<{ version: string; date: string }> {
  const entries: Array<{ version: string; date: string }> = [];
  const regex = /^## \[(\d+\.\d+\.\d+(?:\.\d+)?)\] - (\d{4}-\d{2}-\d{2})\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    entries.push({ version: match[1], date: match[2] });
  }
  return entries;
}

async function gitLines(moduleDir: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", moduleDir, ...args], {
    cwd: process.cwd(),
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function gitOutput(moduleDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", moduleDir, ...args], {
    cwd: process.cwd(),
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout.trim();
}

async function runUnitPhpunit(moduleRelativeDir: string, moduleAbsoluteDir: string): Promise<ReleaseGateResult> {
  const phpunitConfig = join(moduleAbsoluteDir, "phpunit.xml");
  if (!existsSync(phpunitConfig)) {
    return { status: "FAIL", details: `phpunit.xml not found: ${moduleRelativeDir}/phpunit.xml` };
  }

  const phpunitConfigContent = await readFile(phpunitConfig, "utf8");
  const unitSuites = Array.from(phpunitConfigContent.matchAll(/<testsuite\b[^>]*name="([^"]*Unit[^"]*)"/gi)).map((match) => match[1]);
  if (unitSuites.length === 0) {
    return { status: "FAIL", details: `No Unit testsuite found in ${moduleRelativeDir}/phpunit.xml` };
  }

  const projectRoot = resolve(process.cwd());
  const dockerPhp = join(projectRoot, "docker", "scripts", "php");
  const localPhpunit = join(projectRoot, "vendor", "bin", "phpunit");
  const safeId = moduleRelativeDir.replace(/[\/\s]+/g, "__");
  const coverageRel = `tmp/release-check-coverage-${safeId}.xml`;

  const suiteArg = unitSuites.join(",");
  const candidates: Array<{ cmd: string; args: string[] }> = [];
  if (existsSync(dockerPhp)) {
    candidates.push({
      cmd: dockerPhp,
      args: ["-d", "xdebug.mode=coverage", "vendor/bin/phpunit", "-c", `${moduleRelativeDir}/phpunit.xml`, "--testsuite", suiteArg, "--do-not-cache-result", "--coverage-filter", moduleRelativeDir, "--coverage-clover", coverageRel]
    });
  }
  if (existsSync(localPhpunit)) {
    candidates.push({
      cmd: localPhpunit,
      args: ["-c", `${moduleRelativeDir}/phpunit.xml`, "--testsuite", suiteArg, "--do-not-cache-result", "--coverage-filter", moduleRelativeDir, "--coverage-clover", join(projectRoot, coverageRel)]
    });
  }

  let finalStdout = "";
  let finalStderr = "";
  let exitCode = 1;
  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(candidate.cmd, candidate.args, {
        cwd: projectRoot,
        timeout: 900000,
        maxBuffer: 20 * 1024 * 1024
      });
      finalStdout = stdout;
      finalStderr = stderr;
      exitCode = 0;
      break;
    } catch (error) {
      const typed = error as Error & { stdout?: string; stderr?: string; code?: number | string };
      finalStdout = typed.stdout ?? "";
      finalStderr = typed.stderr ?? typed.message;
      exitCode = typeof typed.code === "number" ? typed.code : 1;
      if (typeof typed.code === "number") {
        break;
      }
    }
  }

  if (exitCode !== 0) {
    return {
      status: "FAIL",
      details: `Unit phpunit failed (exit ${exitCode})`,
      meta: {
        stdout: truncateOutput(finalStdout),
        stderr: truncateOutput(finalStderr)
      }
    };
  }

  const coveragePath = join(projectRoot, coverageRel);
  if (!existsSync(coveragePath)) {
    return { status: "FAIL", details: `Coverage report missing: ${coverageRel}` };
  }

  const coverageXml = await readFile(coveragePath, "utf8");
  const metricsMatch = coverageXml.match(/<metrics[^>]*statements="(\d+)"[^>]*coveredstatements="(\d+)"[^>]*methods="(\d+)"[^>]*coveredmethods="(\d+)"/i);
  if (!metricsMatch) {
    return { status: "FAIL", details: "Unable to parse clover coverage metrics" };
  }

  const statements = Number(metricsMatch[1]);
  const coveredStatements = Number(metricsMatch[2]);
  const methods = Number(metricsMatch[3]);
  const coveredMethods = Number(metricsMatch[4]);
  const linePct = statements === 0 ? 100 : (coveredStatements * 100) / statements;
  const methodPct = methods === 0 ? 100 : (coveredMethods * 100) / methods;
  const is100 = coveredStatements === statements && coveredMethods === methods;
  return {
    status: is100 ? "PASS" : "WARN",
    details: is100
      ? `Unit phpunit passed with 100% coverage (lines ${coveredStatements}/${statements}, methods ${coveredMethods}/${methods})`
      : `Unit phpunit passed but coverage is below 100% (lines ${linePct.toFixed(2)}%, methods ${methodPct.toFixed(2)}%)`
  };
}

async function runPhpcs(moduleRelativeDir: string, phpcsStandard: string, phpcsPaths?: string): Promise<ReleaseGateResult> {
  const projectRoot = resolve(process.cwd());
  const dockerPhp = join(projectRoot, "docker", "scripts", "php");
  const localPhpcs = join(projectRoot, "vendor", "bin", "phpcs");
  const targets = (phpcsPaths?.trim() ? phpcsPaths.trim().split(/\s+/) : [moduleRelativeDir]);
  const baseArgs = ["-q", `--standard=${phpcsStandard}`, ...targets];

  const candidates: Array<{ cmd: string; args: string[] }> = [];
  if (existsSync(dockerPhp)) {
    candidates.push({ cmd: dockerPhp, args: ["vendor/bin/phpcs", ...baseArgs] });
  }
  if (existsSync(localPhpcs)) {
    candidates.push({ cmd: localPhpcs, args: baseArgs });
  }

  let stderr = "";
  let stdout = "";
  let exitCode = 1;
  for (const candidate of candidates) {
    try {
      const result = await execFileAsync(candidate.cmd, candidate.args, {
        cwd: projectRoot,
        timeout: 900000,
        maxBuffer: 20 * 1024 * 1024
      });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = 0;
      break;
    } catch (error) {
      const typed = error as Error & { stdout?: string; stderr?: string; code?: number | string };
      stdout = typed.stdout ?? "";
      stderr = typed.stderr ?? typed.message;
      exitCode = typeof typed.code === "number" ? typed.code : 1;
      if (typeof typed.code === "number") {
        break;
      }
    }
  }

  return {
    status: exitCode === 0 ? "PASS" : "WARN",
    details: exitCode === 0 ? "PHPCS passed" : `PHPCS reported issues (exit ${exitCode})`,
    meta: exitCode === 0 ? undefined : { stdout: truncateOutput(stdout), stderr: truncateOutput(stderr) }
  };
}

export function registerReleaseCheckTool(server: McpServer): void {
  server.registerTool(
    "release-check",
    {
      title: "Release Check",
      description: "Run native release readiness checks for a Magento module",
      inputSchema: {
        moduleDir: z.string().describe("Module directory, e.g. app/code/Vendor/Module or vendor/vendor/module"),
        remote: z.string().default("origin").describe("Git remote name"),
        allowedBranches: z.array(z.string()).default(["master"]).describe("Allowed release branches"),
        version: z.string().optional().describe("Expected release version"),
        phpcsStandard: z.string().default("Magento2").describe("PHPCS standard"),
        phpcsPaths: z.string().optional().describe("Optional PHPCS target paths")
      }
    },
    async ({ moduleDir, remote = "origin", allowedBranches = ["master"], version, phpcsStandard = "Magento2", phpcsPaths }) => {
      try {
        const resolvedModule = resolveModuleDirectory(moduleDir, { requireSubPath: "composer.json" });
        const moduleXmlPath = join(resolvedModule.absoluteModuleDir, "etc", "module.xml");
        const changelogPath = join(resolvedModule.absoluteModuleDir, "CHANGELOG.md");
        const composerContent = await readFile(join(resolvedModule.absoluteModuleDir, "composer.json"), "utf8");
        const composerVersion = readVersionFromComposerJson(composerContent);

        const gateResults: Record<string, ReleaseGateResult> = {};
        const blockingFindings: string[] = [];
        const warnings: string[] = [];

        const setGate = (name: string, result: ReleaseGateResult): void => {
          gateResults[name] = result;
          if (result.status === "FAIL") {
            blockingFindings.push(`${name}: ${result.details}`);
          } else if (result.status === "WARN") {
            warnings.push(`${name}: ${result.details}`);
          }
        };

        setGate("composerVersion", composerVersion
          ? { status: parseVersion(composerVersion) ? "PASS" : "FAIL", details: composerVersion ? `composer.json version ${composerVersion}` : "Missing composer.json version" }
          : { status: "FAIL", details: "Missing composer.json version" });

        if (version) {
          setGate("expectedVersion", version === composerVersion
            ? { status: "PASS", details: `Requested version matches composer.json (${version})` }
            : { status: "FAIL", details: `Requested version ${version} does not match composer.json ${composerVersion}` });
        }

        if (existsSync(moduleXmlPath)) {
          const setupVersion = readSetupVersionFromModuleXml(await readFile(moduleXmlPath, "utf8"));
          setGate("moduleXmlVersion", setupVersion === composerVersion
            ? { status: "PASS", details: `module.xml setup_version matches composer.json (${setupVersion})` }
            : { status: "FAIL", details: `module.xml setup_version '${setupVersion || "<missing>"}' does not match composer.json '${composerVersion || "<missing>"}'` });
        } else {
          setGate("moduleXmlVersion", { status: "FAIL", details: `module.xml not found: ${resolvedModule.relativeModuleDir}/etc/module.xml` });
        }

        if (existsSync(changelogPath)) {
          const changelogEntries = extractChangelogEntries(await readFile(changelogPath, "utf8"));
          if (changelogEntries.length === 0) {
            setGate("changelog", { status: "FAIL", details: "No changelog headers found" });
          } else {
            const latestEntry = changelogEntries[0];
            const maxVersion = highestVersion(changelogEntries.map((entry) => entry.version));
            const today = new Date().toISOString().slice(0, 10);
            if (!changelogEntries.some((entry) => entry.version === composerVersion)) {
              setGate("changelogVersion", { status: "FAIL", details: `CHANGELOG.md has no entry for ${composerVersion}` });
            } else {
              setGate("changelogVersion", { status: maxVersion === composerVersion ? "PASS" : "FAIL", details: maxVersion === composerVersion ? `Newest CHANGELOG.md entry matches ${composerVersion}` : `Newest CHANGELOG.md entry is ${maxVersion}, expected ${composerVersion}` });
            }
            setGate("changelogDate", latestEntry.date === today
              ? { status: "PASS", details: `Newest CHANGELOG.md entry matches today's date (${today})` }
              : { status: "FAIL", details: `Newest CHANGELOG.md date ${latestEntry.date} does not match today ${today}` });
          }
        } else {
          setGate("changelog", { status: "FAIL", details: `CHANGELOG.md not found: ${resolvedModule.relativeModuleDir}/CHANGELOG.md` });
        }

        try {
          const branch = await gitOutput(resolvedModule.absoluteModuleDir, ["symbolic-ref", "-q", "--short", "HEAD"]);
          if (!branch) {
            setGate("branch", { status: "FAIL", details: "Detached HEAD is not allowed" });
          } else if (!allowedBranches.includes(branch)) {
            setGate("branch", { status: "FAIL", details: `Current branch '${branch}' is not allowed (${allowedBranches.join(", ")})` });
          } else {
            setGate("branch", { status: "PASS", details: `Current branch allowed: ${branch}` });

            const statusPorcelain = await gitOutput(resolvedModule.absoluteModuleDir, ["status", "--porcelain"]);
            setGate("workingTree", statusPorcelain
              ? { status: "FAIL", details: "Working tree is not clean" }
              : { status: "PASS", details: "Working tree clean" });

            const remotes = await gitLines(resolvedModule.absoluteModuleDir, ["remote"]);
            if (!remotes.includes(remote)) {
              setGate("remote", { status: "FAIL", details: `Remote '${remote}' not configured` });
            } else {
              setGate("remote", { status: "PASS", details: `Remote '${remote}' exists` });
              try {
                await execFileAsync("git", ["-C", resolvedModule.absoluteModuleDir, "fetch", "--prune", remote], { cwd: process.cwd(), timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
                setGate("remoteFetch", { status: "PASS", details: `Remote fetch ok: ${remote}` });
              } catch (error) {
                setGate("remoteFetch", { status: "FAIL", details: `Remote fetch failed for ${remote}: ${error instanceof Error ? error.message : String(error)}` });
              }

              const localTags = await gitLines(resolvedModule.absoluteModuleDir, ["tag", "--list"]);
              const remoteTagsOutput = await gitLines(resolvedModule.absoluteModuleDir, ["ls-remote", "--tags", remote]);
              const remoteTags = remoteTagsOutput
                .map((line) => line.split(/\s+/)[1] ?? "")
                .map((ref) => ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, ""))
                .filter((value) => /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value));
              const highestTag = highestVersion([...localTags, ...remoteTags]);
              const tagExists = localTags.includes(composerVersion) || remoteTags.includes(composerVersion);
              setGate("tagExists", !tagExists
                ? { status: "PASS", details: `Tag ${composerVersion} does not exist yet` }
                : { status: "FAIL", details: `Tag ${composerVersion} already exists` });

              if (highestTag) {
                setGate("versionStep", isNextAllowedVersion(composerVersion, highestTag)
                  ? { status: "PASS", details: `Version ${composerVersion} is the next allowed step after ${highestTag}` }
                  : { status: "FAIL", details: `Version ${composerVersion} is not the next allowed step after ${highestTag}` });
              } else {
                setGate("versionStep", { status: "PASS", details: `No previous numeric tags found; ${composerVersion} can be the first release` });
              }
            }
          }
        } catch (error) {
          setGate("git", { status: "FAIL", details: `Git checks failed: ${error instanceof Error ? error.message : String(error)}` });
        }

        setGate("unitTests", await runUnitPhpunit(resolvedModule.relativeModuleDir, resolvedModule.absoluteModuleDir));
        setGate("phpcs", await runPhpcs(resolvedModule.relativeModuleDir, phpcsStandard, phpcsPaths));

        const copyrightResult = await runCopyrightCheck({ moduleDir: resolvedModule.relativeModuleDir });
        setGate("copyright", {
          status: copyrightResult.okCopyright ? "PASS" : "FAIL",
          details: `failures=${copyrightResult.summary.failures} warnings=${copyrightResult.summary.warnings}`,
          meta: copyrightResult
        });

        const translationResult = await runTranslationCheck({ moduleDir: resolvedModule.relativeModuleDir });
        setGate("translations", {
          status: translationResult.okTranslations ? "PASS" : "FAIL",
          details: `failures=${translationResult.summary.failures} warnings=${translationResult.summary.warnings}`,
          meta: translationResult
        });

        const compatibilityResult = await runCompatibilityCheck({ moduleDir: resolvedModule.relativeModuleDir });
        setGate("compatibility", {
          status: compatibilityResult.success ? "PASS" : (compatibilityResult.summary.issues_total > 0 ? "WARN" : "FAIL"),
          details: `issues=${compatibilityResult.summary.issues_total}`,
          meta: compatibilityResult
        });

        const ready = Object.values(gateResults).every((result) => result.status !== "FAIL");
        const payload = {
          ready,
          moduleDir: resolvedModule.relativeModuleDir,
          version: composerVersion,
          remote,
          allowedBranches,
          gateResults,
          summary: {
            pass: Object.values(gateResults).filter((result) => result.status === "PASS").length,
            warn: Object.values(gateResults).filter((result) => result.status === "WARN").length,
            fail: Object.values(gateResults).filter((result) => result.status === "FAIL").length
          },
          blockingFindings,
          warnings
        };

        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          isError: !ready
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `release-check failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }
    }
  );
}
