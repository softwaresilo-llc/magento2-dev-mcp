export interface DockerEnvironment {
  type: string;
  containerRoot: string;
  phpService: string;
  mysqlService: string;
  wrapCommand(cmd: string): string[];
  buildMysqlCommand(args: string[]): string;
  buildPhpCommands(scriptPath: string, args: string[]): string[];
}

/**
 * Escape a string for safe use inside single-quoted shell arguments.
 * Uses the standard end-quote, escaped-quote, re-open-quote pattern: '\''
 */
export function shellQuote(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function createDockerEnv(
  type: string,
  containerRoot: string,
  phpService: string,
  mysqlService: string,
  wrapCommand: (cmd: string) => string,
  wrapMysqlCommand: (cmd: string) => string,
): DockerEnvironment {
  return {
    type,
    containerRoot,
    phpService,
    mysqlService,
    wrapCommand(cmd: string): string[] {
      return [wrapCommand(cmd)];
    },
    buildMysqlCommand(args: string[]): string {
      const quotedArgs = args.map(a => shellQuote(a)).join(' ');
      return wrapMysqlCommand(`mysql ${quotedArgs}`);
    },
    buildPhpCommands(scriptPath: string, args: string[]): string[] {
      const quotedArgs = args.map(a => shellQuote(a)).join(' ');
      return [wrapCommand(`php ${scriptPath} ${quotedArgs}`)];
    },
  };
}

function getBooleanEnv(name: string, defaultValue: boolean): boolean {
  const rawValue = process.env[name]?.trim().toLowerCase();
  if (!rawValue) {
    return defaultValue;
  }

  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  throw new Error(`${name} must be set to "true" or "false".`);
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured when MAGENTO2_USE_COMPOSE=true.`);
  }

  return value;
}

export function getLocalPhpBinary(): string {
  return process.env.MAGENTO2_PHP_BIN?.trim() || "php";
}

export function getLocalMysqlBinary(): string {
  return process.env.MAGENTO2_MYSQL_BIN?.trim() || "mysql";
}

/**
 * Resolve Docker execution settings from explicit environment configuration.
 * Returns null when local binaries should be used.
 */
export function detectDockerEnvironment(_projectRoot: string): DockerEnvironment | null {
  if (!getBooleanEnv("MAGENTO2_USE_COMPOSE", false)) {
    return null;
  }

  const containerRoot = process.env.MAGENTO2_CONTAINER_ROOT?.trim() || "/var/www/html";
  const phpService = getRequiredEnv("MAGENTO2_PHP_SERVICE");
  const mysqlService = getRequiredEnv("MAGENTO2_MYSQL_SERVICE");

  return createDockerEnv(
    "docker-compose",
    containerRoot,
    phpService,
    mysqlService,
    (cmd) => `docker compose exec -T ${phpService} sh -lc ${shellQuote(`cd ${containerRoot} && ${cmd}`)}`,
    (cmd) => `docker compose exec -T ${mysqlService} sh -lc ${shellQuote(cmd)}`,
  );
}
