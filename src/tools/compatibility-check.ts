import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveModuleDirectory } from "../core/module-resolver.js";
import { evaluateConstraintExpression } from "../core/version-constraints.js";
import { isRecord } from "../core/output.js";

interface VersionResult {
  ok: boolean;
  issues: number;
  notes: string[];
}

interface SnapshotInfo {
  label: string;
  dir: string;
  magentoVersion: string;
  frameworkVersion: string;
}

export interface CompatibilityCheckResult {
  versionResults: Record<string, VersionResult>;
  workerErrors: Array<Record<string, unknown>>;
  summary: {
    ok: boolean;
    checked_versions: string[];
    worker_failures: number;
    issues_total: number;
    target_versions: string[];
    excluded_versions_by_constraints: string[];
  };
  success: boolean;
  metadata: {
    moduleDir: string;
    constraints: Array<{ packageName: string; constraint: string }>;
    outputFormat: "text" | "json";
    magentoDocsDir: string;
    checkedVersionsMeta: Array<{ label: string; magentoVersion: string; frameworkVersion: string }>;
    excludedVersionReasons: Array<{ label: string; reasons: string[] }>;
  };
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "").replace(/^magento2-/, "");
}

function normalizeVersionLabel(version: string): string {
  const normalized = normalizeVersion(version);
  return normalized.startsWith("magento2-") ? normalized : `magento2-${normalized}`;
}

function requestedVersionMatches(snapshot: SnapshotInfo, requested: string[]): boolean {
  if (requested.length === 0) {
    return true;
  }

  const label = snapshot.label;
  const magentoVersion = snapshot.magentoVersion;

  return requested.some((item) => {
    const normalized = normalizeVersion(item);
    const normalizedLabel = normalizeVersionLabel(item);

    return label === normalizedLabel
      || magentoVersion === normalized
      || magentoVersion.startsWith(`${normalized}-`)
      || label === item.trim()
      || label.startsWith(`${normalizedLabel}-`);
  });
}

async function readComposerPackageVersion(composerFile: string): Promise<string> {
  if (!existsSync(composerFile)) {
    return "";
  }

  try {
    const raw = await readFile(composerFile, "utf8");
    const decoded = JSON.parse(raw) as Record<string, unknown>;
    return typeof decoded.version === "string" ? decoded.version.trim() : "";
  } catch {
    return "";
  }
}

function detectDefaultMagentoDocsDir(projectRoot: string): string {
  const candidate = join(projectRoot, "docs", "magento2");
  return existsSync(candidate) ? candidate : "";
}

async function collectVersionSnapshots(baseDir: string, versions?: string[]): Promise<SnapshotInfo[]> {
  if (!baseDir || !existsSync(baseDir)) {
    return [];
  }

  const requested = Array.isArray(versions) ? versions.map((item) => item.trim()).filter(Boolean) : [];
  const entries = await readdir(baseDir, { withFileTypes: true });
  const snapshots: SnapshotInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("magento2-")) {
      continue;
    }

    const dir = join(baseDir, entry.name);
    const composerFile = join(dir, "composer.json");
    const autoloadFile = join(dir, "vendor", "autoload.php");
    if (!existsSync(composerFile) || !existsSync(autoloadFile)) {
      continue;
    }

    const magentoVersion = await readComposerPackageVersion(composerFile);
    const frameworkVersion = await readComposerPackageVersion(join(dir, "vendor", "magento", "framework", "composer.json"))
      || await readComposerPackageVersion(join(dir, "lib", "internal", "Magento", "Framework", "composer.json"));

    const snapshot: SnapshotInfo = {
      label: entry.name,
      dir,
      magentoVersion,
      frameworkVersion
    };

    if (requestedVersionMatches(snapshot, requested)) {
      snapshots.push(snapshot);
    }
  }

  snapshots.sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true }));
  return snapshots;
}

function collectMagentoConstraints(composerJson: Record<string, unknown>): Array<{ packageName: string; constraint: string }> {
  const constraints: Array<{ packageName: string; constraint: string }> = [];
  const require = composerJson.require;

  if (!isRecord(require)) {
    return constraints;
  }

  for (const [packageName, constraintValue] of Object.entries(require)) {
    if (typeof constraintValue !== "string") {
      continue;
    }

    if (packageName === "magento/framework" || packageName.startsWith("magento/")) {
      constraints.push({
        packageName,
        constraint: constraintValue.trim()
      });
    }
  }

  return constraints;
}

async function resolveSnapshotPackageVersion(snapshot: SnapshotInfo, packageName: string): Promise<string> {
  const normalized = packageName.trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  if (
    normalized === "magento/product-community-edition"
    || normalized === "magento/product-enterprise-edition"
    || normalized === "magento/project-community-edition"
    || normalized === "magento/project-enterprise-edition"
    || normalized === "magento/magento2-base"
  ) {
    return snapshot.magentoVersion;
  }

  if (normalized === "magento/framework") {
    return snapshot.frameworkVersion;
  }

  if (normalized.startsWith("magento/")) {
    return readComposerPackageVersion(join(snapshot.dir, "vendor", ...normalized.split("/"), "composer.json"));
  }

  return "";
}

export async function runCompatibilityCheck(input: {
  moduleDir: string;
  magentoDocsDir?: string;
  versions?: string[];
  format?: "text" | "json";
}): Promise<CompatibilityCheckResult> {
  const resolvedModule = resolveModuleDirectory(input.moduleDir);
  const format = input.format ?? "json";
  const projectRoot = resolve(process.cwd());
  const magentoDocsDir = input.magentoDocsDir?.trim()
    ? resolve(projectRoot, input.magentoDocsDir.trim())
    : detectDefaultMagentoDocsDir(projectRoot);

  const composerPath = join(resolvedModule.absoluteModuleDir, "composer.json");
  if (!existsSync(composerPath)) {
    throw new Error(`composer.json not found: ${resolvedModule.relativeModuleDir}/composer.json`);
  }

  let composerJson: Record<string, unknown>;
  try {
    composerJson = JSON.parse(await readFile(composerPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid composer.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  const constraints = collectMagentoConstraints(composerJson);
  if (!magentoDocsDir) {
    throw new Error("Magento snapshot docs directory not found. Provide magentoDocsDir or ensure docs/magento2 exists.");
  }

  const snapshots = await collectVersionSnapshots(magentoDocsDir, input.versions);
  if (snapshots.length === 0) {
    throw new Error(`No Magento snapshots found in ${magentoDocsDir}`);
  }

  const selectedSnapshots: SnapshotInfo[] = [];
  const excludedVersionReasons: Array<{ label: string; reasons: string[] }> = [];
  const workerErrors: Array<Record<string, unknown>> = [];

  for (const snapshot of snapshots) {
    const reasons: string[] = [];

    for (const constraint of constraints) {
      const snapshotVersion = await resolveSnapshotPackageVersion(snapshot, constraint.packageName);
      if (!snapshotVersion) {
        workerErrors.push({
          version: snapshot.label,
          packageName: constraint.packageName,
          message: `Snapshot package version not found for ${constraint.packageName}`
        });
        continue;
      }

      if (!evaluateConstraintExpression(snapshotVersion, constraint.constraint)) {
        reasons.push(`${constraint.packageName} ${snapshotVersion} !~ ${constraint.constraint}`);
      }
    }

    if (reasons.length === 0) {
      selectedSnapshots.push(snapshot);
    } else {
      excludedVersionReasons.push({ label: snapshot.label, reasons });
    }
  }

  const versionResults: Record<string, VersionResult> = {};
  for (const snapshot of selectedSnapshots) {
    versionResults[snapshot.magentoVersion || snapshot.label] = {
      ok: true,
      issues: 0,
      notes: constraints.length === 0
        ? ["No Magento composer constraints declared in module"]
        : [`Constraints satisfied for ${snapshot.label}`]
    };
  }

  const totalIssues = Object.values(versionResults).reduce((sum, row) => sum + row.issues, 0);
  const checkedVersions = snapshots.map((snapshot) => snapshot.magentoVersion || snapshot.label);
  const checkedVersionsMeta = snapshots.map((snapshot) => ({
    label: snapshot.label,
    magentoVersion: snapshot.magentoVersion,
    frameworkVersion: snapshot.frameworkVersion
  }));

  const summary = {
    ok: totalIssues === 0 && selectedSnapshots.length > 0,
    checked_versions: checkedVersions,
    worker_failures: workerErrors.length,
    issues_total: totalIssues,
    target_versions: checkedVersions,
    excluded_versions_by_constraints: excludedVersionReasons.map((item) => item.label)
  };

  return {
    versionResults,
    workerErrors,
    summary,
    success: summary.ok,
    metadata: {
      moduleDir: resolvedModule.relativeModuleDir,
      constraints,
      outputFormat: format,
      magentoDocsDir,
      checkedVersionsMeta,
      excludedVersionReasons
    }
  };
}

export function registerCompatibilityCheckTool(server: McpServer): void {
  server.registerTool(
    "compatibility-check",
    {
      title: "Compatibility Check",
      description: "Analyze module composer constraints against target Magento versions",
      inputSchema: {
        moduleDir: z.string().describe("Module directory, e.g. app/code/Vendor/Module or vendor/vendor/module"),
        magentoDocsDir: z.string().optional().describe("Optional path containing Magento version directories"),
        versions: z.array(z.string()).optional().describe("Optional list of target versions"),
        format: z.enum(["text", "json"]).default("json").describe("Output format")
      }
    },
    async ({ moduleDir, magentoDocsDir, versions, format = "json" }) => {
      try {
        const payload = await runCompatibilityCheck({ moduleDir, magentoDocsDir, versions, format });
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          isError: !payload.success
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Invalid moduleDir: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }
    }
  );
}
