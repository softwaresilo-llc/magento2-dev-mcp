import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
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

const DEFAULT_VERSIONS = ["2.4.4", "2.4.5", "2.4.6", "2.4.7", "2.4.8"];

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

async function discoverVersionsFromDocsDir(magentoDocsDir: string): Promise<string[]> {
  if (!existsSync(magentoDocsDir)) {
    return [];
  }

  const entries = await readdir(magentoDocsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .map(normalizeVersion)
    .filter((name) => /^\d+\.\d+\.\d+(?:-p\d+)?$/.test(name));
}

function collectMagentoConstraints(composerJson: Record<string, unknown>): Array<{ packageName: string; constraint: string }> {
  const constraints: Array<{ packageName: string; constraint: string }> = [];
  const sections = [composerJson.require, composerJson["require-dev"]];

  for (const section of sections) {
    if (!isRecord(section)) {
      continue;
    }

    for (const [packageName, constraintValue] of Object.entries(section)) {
      if (typeof constraintValue !== "string") {
        continue;
      }

      if (
        packageName === "magento/product-community-edition" ||
        packageName === "magento/framework" ||
        packageName.startsWith("magento/module-")
      ) {
        constraints.push({
          packageName,
          constraint: constraintValue
        });
      }
    }
  }

  return constraints;
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
      let resolvedModule;
      try {
        resolvedModule = resolveModuleDirectory(moduleDir);
      } catch (error) {
        return {
          content: [{ type: "text", text: `Invalid moduleDir: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }

      const composerPath = join(resolvedModule.absoluteModuleDir, "composer.json");
      if (!existsSync(composerPath)) {
        return {
          content: [{ type: "text", text: `composer.json not found: ${resolvedModule.relativeModuleDir}/composer.json` }],
          isError: true
        };
      }

      let composerJson: Record<string, unknown>;
      try {
        composerJson = JSON.parse(await readFile(composerPath, "utf8")) as Record<string, unknown>;
      } catch (error) {
        return {
          content: [{ type: "text", text: `Invalid composer.json: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }

      const constraints = collectMagentoConstraints(composerJson);

      let effectiveVersions: string[] = [];
      if (Array.isArray(versions) && versions.length > 0) {
        effectiveVersions = versions.map(normalizeVersion);
      } else if (magentoDocsDir?.trim()) {
        effectiveVersions = await discoverVersionsFromDocsDir(magentoDocsDir.trim());
      }
      if (effectiveVersions.length === 0) {
        effectiveVersions = [...DEFAULT_VERSIONS];
      }

      const uniqueVersions = Array.from(new Set(effectiveVersions));
      const versionResults: Record<string, VersionResult> = {};

      for (const version of uniqueVersions) {
        const notes: string[] = [];
        let issues = 0;

        for (const constraint of constraints) {
          const matches = evaluateConstraintExpression(version, constraint.constraint);
          if (!matches) {
            issues += 1;
            notes.push(`${constraint.packageName} requires '${constraint.constraint}'`);
          }
        }

        versionResults[version] = {
          ok: issues === 0,
          issues,
          notes
        };
      }

      const totalIssues = Object.values(versionResults).reduce((sum, row) => sum + row.issues, 0);
      const workerErrors: Array<Record<string, unknown>> = [];
      const summary = {
        ok: totalIssues === 0,
        checked_versions: uniqueVersions,
        worker_failures: 0,
        issues_total: totalIssues
      };

      const payload = {
        versionResults,
        workerErrors,
        summary,
        success: summary.ok,
        metadata: {
          moduleDir: resolvedModule.relativeModuleDir,
          constraints,
          outputFormat: format
        }
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: !payload.success
      };
    }
  );
}
