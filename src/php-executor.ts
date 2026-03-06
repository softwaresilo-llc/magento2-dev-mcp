import { exec, ExecOptions } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readdirSync, copyFileSync, mkdirSync, rmSync } from "fs";
import { detectDockerEnvironment, getLocalPhpBinary, shellQuote, type DockerEnvironment } from "./docker-env.js";

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type PhpScriptResult =
  | { success: true; data: any }
  | { success: false; error: string; isError: true };

/**
 * Execute a PHP command, log stderr, and return parsed JSON output.
 * Throws on exec failure or JSON parse failure.
 */
async function runPhpCommand(command: string, execOptions: ExecOptions): Promise<any> {
  const { stdout, stderr } = await execAsync(command, execOptions);

  if (stderr && String(stderr).trim()) {
    console.error("PHP script stderr:", stderr);
  }

  return JSON.parse(String(stdout));
}

/**
 * Execute a PHP script inside the configured Docker container.
 */
async function executeViaDocker(
  dockerEnv: DockerEnvironment,
  scriptName: string,
  args: string[],
  phpSourceDir: string,
  projectRoot: string,
  execOptions: ExecOptions,
): Promise<PhpScriptResult> {
  const tmpDir = join(projectRoot, 'var', 'tmp', 'mcp-php');
  try {
    // Copy PHP scripts to project root (which is Docker-mounted)
    mkdirSync(tmpDir, { recursive: true });
    for (const file of readdirSync(phpSourceDir)) {
      copyFileSync(join(phpSourceDir, file), join(tmpDir, file));
    }

    const containerArgs = [...args];
    containerArgs[0] = dockerEnv.containerRoot;
    const containerScriptPath = `${dockerEnv.containerRoot}/var/tmp/mcp-php/${scriptName}`;
    const command = dockerEnv.buildPhpCommands(containerScriptPath, containerArgs)[0];

    try {
      const data = await runPhpCommand(command, execOptions);
      return { success: true, data };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to execute PHP script via ${dockerEnv.type} using PHP service "${dockerEnv.phpService}".\n\nError: ${errorMessage}`,
        isError: true,
      };
    }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Execute a PHP script using the local PHP binary.
 */
async function executeViaLocalPhp(
  scriptName: string,
  args: string[],
  phpSourceDir: string,
  execOptions: ExecOptions,
  dockerEnvType: string | null,
): Promise<PhpScriptResult> {
  try {
    const scriptPath = join(phpSourceDir, scriptName);
    const phpBin = getLocalPhpBinary();
    const command = `${shellQuote(phpBin)} ${shellQuote(scriptPath)} ${args.map(a => shellQuote(a)).join(' ')}`;
    const data = await runPhpCommand(command, execOptions);
    return { success: true, data };
  } catch (localError) {
    const errorMessage = localError instanceof Error ? localError.message : String(localError);

    if (dockerEnvType) {
      return {
        success: false,
        error: `Failed to execute PHP script via ${dockerEnvType} Docker environment.\n\nError: ${errorMessage}`,
        isError: true,
      };
    }

    if (errorMessage.includes("command not found") || errorMessage.includes("not recognized")) {
      return {
        success: false,
        error: "Error: PHP not found. Please ensure PHP is available in your PATH, or run from a Docker-based Magento environment (Warden, DDEV, docker-magento, or docker-compose).",
        isError: true,
      };
    }

    return {
      success: false,
      error: `Error executing PHP script: ${errorMessage}`,
      isError: true,
    };
  }
}

/**
 * Execute a PHP analysis script, trying Docker first, then local PHP.
 */
export async function executePhpScript(scriptName: string, args: string[]): Promise<PhpScriptResult> {
  const phpSourceDir = join(__dirname, '..', 'php');
  const projectRoot = process.cwd();
  const dockerEnv = detectDockerEnvironment(projectRoot);
  const execOptions = { cwd: projectRoot, timeout: 60000, maxBuffer: 10 * 1024 * 1024 };

  if (dockerEnv) {
    return executeViaDocker(dockerEnv, scriptName, args, phpSourceDir, projectRoot, execOptions);
  }

  return executeViaLocalPhp(scriptName, args, phpSourceDir, execOptions, null);
}
