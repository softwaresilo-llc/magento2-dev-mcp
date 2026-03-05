import { execFile } from "child_process";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, resolve } from "path";
import { promisify } from "util";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveModuleDirectory } from "../core/module-resolver.js";
import { parsePhpunitStats, truncateOutput } from "../core/output.js";

const execFileAsync = promisify(execFile);

const BYPASS_FLAGS = [
  "devbypassadminauth/general/enabled",
  "devbypasscustomerauth/general/enabled",
  "devbypassstaffauth/general/enabled"
] as const;

interface IntegrationDbConfig {
  host: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
}

function parseInstallConfigPhp(content: string): IntegrationDbConfig | null {
  const extract = (key: string): string => {
    const regex = new RegExp(`'${key}'\\s*=>\\s*'([^']*)'`);
    return content.match(regex)?.[1]?.trim() ?? "";
  };

  const dbName = extract("db-name");
  const dbUser = extract("db-user");
  const dbPassword = extract("db-password");
  const host = extract("db-host") || "127.0.0.1";

  if (!dbName || !dbUser) {
    return null;
  }

  return {
    host,
    dbName,
    dbUser,
    dbPassword
  };
}

async function runMysqlQuery(config: IntegrationDbConfig, sql: string): Promise<string> {
  const mysqlArgs = [
    "-h",
    config.host,
    "-u",
    config.dbUser,
    `-p${config.dbPassword}`,
    config.dbName,
    "-Nse",
    sql
  ];

  const { stdout } = await execFileAsync("mysql", mysqlArgs, {
    cwd: process.cwd(),
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024
  });

  return stdout.trim();
}

function buildBypassFlagsSelectQuery(): string {
  const paths = BYPASS_FLAGS.map((flag) => `'${flag}'`).join(",");
  return [
    "SELECT path, value",
    "FROM core_config_data",
    "WHERE scope='default'",
    "  AND scope_id=0",
    `  AND path IN (${paths})`,
    "ORDER BY path"
  ].join("\n");
}

function parseBypassValues(raw: string): Map<string, string> {
  const values = new Map<string, string>();
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const [path, value] = line.split(/\t/, 2);
    if (!path) {
      continue;
    }
    values.set(path.trim(), (value ?? "").trim());
  }
  return values;
}

async function verifyBypassFlags(config: IntegrationDbConfig): Promise<{ ok: boolean; details: string[] }> {
  const raw = await runMysqlQuery(config, buildBypassFlagsSelectQuery());
  const values = parseBypassValues(raw);
  const details: string[] = [];
  let ok = true;

  for (const flag of BYPASS_FLAGS) {
    const current = values.get(flag) ?? "<missing>";
    if (current !== "0") {
      ok = false;
      details.push(`${flag}=${current}`);
    }
  }

  return { ok, details };
}

async function applyBypassFlagsFix(config: IntegrationDbConfig): Promise<void> {
  for (const flag of BYPASS_FLAGS) {
    const sql = [
      "UPDATE core_config_data",
      "SET value='0'",
      "WHERE scope='default'",
      "  AND scope_id=0",
      `  AND path='${flag}';`,
      "INSERT INTO core_config_data (scope, scope_id, path, value)",
      `SELECT 'default', 0, '${flag}', '0'`,
      "WHERE NOT EXISTS (",
      "  SELECT 1 FROM core_config_data",
      "  WHERE scope='default' AND scope_id=0",
      `    AND path='${flag}'`,
      ");"
    ].join("\n");
    await runMysqlQuery(config, sql);
  }
}

async function runPhpunit(
  targetPath: string,
  filter: string | undefined,
  noDoNotCacheResult: boolean
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const projectRoot = resolve(process.cwd());
  const dockerPhpScript = join(projectRoot, "docker", "scripts", "php");
  const phpunitConfig = join(projectRoot, "dev", "tests", "integration", "phpunit.xml");

  const args = ["vendor/bin/phpunit", "-c", "dev/tests/integration/phpunit.xml", targetPath];
  if (!noDoNotCacheResult) {
    args.push("--do-not-cache-result");
  }
  if (filter?.trim()) {
    args.push("--filter", filter.trim());
  }

  const candidates: Array<{ cmd: string; args: string[] }> = [];
  if (existsSync(dockerPhpScript)) {
    candidates.push({ cmd: dockerPhpScript, args });
  }
  if (existsSync(join(projectRoot, "vendor", "bin", "phpunit")) && existsSync(phpunitConfig)) {
    candidates.push({ cmd: "vendor/bin/phpunit", args: ["-c", "dev/tests/integration/phpunit.xml", targetPath, ...(noDoNotCacheResult ? [] : ["--do-not-cache-result"]), ...(filter?.trim() ? ["--filter", filter.trim()] : [])] });
  }

  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(candidate.cmd, candidate.args, {
        cwd: projectRoot,
        timeout: 900000,
        maxBuffer: 20 * 1024 * 1024
      });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const typedError = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      lastError = typedError;
      if (typeof typedError.code === "number") {
        return {
          exitCode: typedError.code,
          stdout: typedError.stdout ?? "",
          stderr: typedError.stderr ?? typedError.message
        };
      }
    }
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: lastError ? lastError.message : "No phpunit executable candidate found"
  };
}

export function registerModuleIntegrationTestTool(server: McpServer): void {
  server.registerTool(
    "module-integration-test",
    {
      title: "Module Integration Test",
      description: "Run Magento module integration tests directly from this MCP",
      inputSchema: {
        moduleDir: z.string().describe("Module directory, e.g. app/code/Vendor/Module or vendor/vendor/module"),
        file: z.string().optional().describe("Optional test file under Test/Integration"),
        filter: z.string().optional().describe("Optional phpunit --filter pattern"),
        noDoNotCacheResult: z.boolean().default(false).describe("When true, disables --do-not-cache-result"),
        fixBypassFlags: z.boolean().default(false).describe("Set integration bypass flags to 0 before running"),
        skipBypassFlagsCheck: z.boolean().default(false).describe("Skip integration bypass flag preflight check")
      }
    },
    async ({
      moduleDir,
      file,
      filter,
      noDoNotCacheResult = false,
      fixBypassFlags = false,
      skipBypassFlagsCheck = false
    }) => {
      let resolvedModule;
      try {
        resolvedModule = resolveModuleDirectory(moduleDir);
      } catch (error) {
        return {
          content: [{ type: "text", text: `Invalid moduleDir: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }

      const integrationDir = join(resolvedModule.absoluteModuleDir, "Test", "Integration");
      if (!existsSync(integrationDir)) {
        return {
          content: [{ type: "text", text: `integration test directory not found: ${resolvedModule.relativeModuleDir}/Test/Integration` }],
          isError: true
        };
      }

      let targetRelativePath = `${resolvedModule.relativeModuleDir}/Test/Integration`;
      if (file?.trim()) {
        const filePath = join(integrationDir, file.trim());
        if (!existsSync(filePath)) {
          return {
            content: [{ type: "text", text: `integration test file not found: ${targetRelativePath}/${file.trim()}` }],
            isError: true
          };
        }
        targetRelativePath = `${targetRelativePath}/${file.trim()}`;
      }

      const bypassWarnings: string[] = [];
      if (!skipBypassFlagsCheck || fixBypassFlags) {
        const installConfigPath = join(process.cwd(), "dev", "tests", "integration", "etc", "install-config-mysql.php");
        if (!existsSync(installConfigPath)) {
          return {
            content: [{ type: "text", text: `integration config not found: ${installConfigPath}` }],
            isError: true
          };
        }

        try {
          const configContent = await readFile(installConfigPath, "utf8");
          const dbConfig = parseInstallConfigPhp(configContent);
          if (!dbConfig) {
            return {
              content: [{ type: "text", text: "could not parse integration DB credentials from install-config-mysql.php" }],
              isError: true
            };
          }

          let verification = await verifyBypassFlags(dbConfig);
          if (!verification.ok && fixBypassFlags) {
            await applyBypassFlagsFix(dbConfig);
            verification = await verifyBypassFlags(dbConfig);
          }

          if (!verification.ok && !skipBypassFlagsCheck) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  success: false,
                  phpunitExitCode: 1,
                  testsRun: null,
                  failures: 1,
                  stdout: "",
                  stderr: `Integration bypass flags not in required state: ${verification.details.join(", ")}`
                }, null, 2)
              }],
              isError: true
            };
          }

          if (!verification.ok && skipBypassFlagsCheck) {
            bypassWarnings.push(`Bypass flags not set to 0: ${verification.details.join(", ")}`);
          }
        } catch (error) {
          if (!skipBypassFlagsCheck) {
            return {
              content: [{ type: "text", text: `Bypass flag check failed: ${error instanceof Error ? error.message : String(error)}` }],
              isError: true
            };
          }
          bypassWarnings.push(`Bypass flag check failed but skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const phpunitRun = await runPhpunit(targetRelativePath, filter, noDoNotCacheResult);
      const combinedOutput = `${phpunitRun.stdout}\n${phpunitRun.stderr}`;
      const stats = parsePhpunitStats(combinedOutput);

      const payload = {
        success: phpunitRun.exitCode === 0,
        phpunitExitCode: phpunitRun.exitCode,
        testsRun: stats.testsRun,
        failures: stats.failures,
        stdout: truncateOutput(phpunitRun.stdout),
        stderr: truncateOutput(phpunitRun.stderr),
        warnings: bypassWarnings
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: !payload.success
      };
    }
  );
}
