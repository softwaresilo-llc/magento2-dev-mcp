#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RuntimeCliOptions {
  useCompose?: string;
  phpService?: string;
  mysqlService?: string;
  containerRoot?: string;
  phpBin?: string;
  mysqlBin?: string;
  magerun2Command?: string;
}

function readFlagValue(args: string[], index: number): { value: string; consumed: number } {
  const arg = args[index] ?? '';
  const equalsIndex = arg.indexOf('=');
  if (equalsIndex >= 0) {
    return {
      value: arg.slice(equalsIndex + 1),
      consumed: 1
    };
  }

  const nextValue = args[index + 1];
  if (typeof nextValue !== 'string' || nextValue.startsWith('--')) {
    throw new Error(`Missing value for ${arg}`);
  }

  return {
    value: nextValue,
    consumed: 2
  };
}

function parseRuntimeCliOptions(args: string[]): RuntimeCliOptions {
  const options: RuntimeCliOptions = {};

  for (let index = 0; index < args.length;) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('--')) {
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v') {
      index += 1;
      continue;
    }

    let parsed;
    switch (arg.split('=')[0]) {
      case '--use-compose':
        parsed = readFlagValue(args, index);
        options.useCompose = parsed.value;
        index += parsed.consumed;
        break;
      case '--php-service':
        parsed = readFlagValue(args, index);
        options.phpService = parsed.value;
        index += parsed.consumed;
        break;
      case '--mysql-service':
        parsed = readFlagValue(args, index);
        options.mysqlService = parsed.value;
        index += parsed.consumed;
        break;
      case '--container-root':
        parsed = readFlagValue(args, index);
        options.containerRoot = parsed.value;
        index += parsed.consumed;
        break;
      case '--php-bin':
        parsed = readFlagValue(args, index);
        options.phpBin = parsed.value;
        index += parsed.consumed;
        break;
      case '--mysql-bin':
        parsed = readFlagValue(args, index);
        options.mysqlBin = parsed.value;
        index += parsed.consumed;
        break;
      case '--magerun2-command':
        parsed = readFlagValue(args, index);
        options.magerun2Command = parsed.value;
        index += parsed.consumed;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function applyRuntimeCliOptions(options: RuntimeCliOptions): void {
  if (typeof options.useCompose === 'string') {
    process.env.MAGENTO2_USE_COMPOSE = options.useCompose;
  }
  if (typeof options.phpService === 'string') {
    process.env.MAGENTO2_PHP_SERVICE = options.phpService;
  }
  if (typeof options.mysqlService === 'string') {
    process.env.MAGENTO2_MYSQL_SERVICE = options.mysqlService;
  }
  if (typeof options.containerRoot === 'string') {
    process.env.MAGENTO2_CONTAINER_ROOT = options.containerRoot;
  }
  if (typeof options.phpBin === 'string') {
    process.env.MAGENTO2_PHP_BIN = options.phpBin;
  }
  if (typeof options.mysqlBin === 'string') {
    process.env.MAGENTO2_MYSQL_BIN = options.mysqlBin;
  }
  if (typeof options.magerun2Command === 'string') {
    process.env.MAGERUN2_COMMAND = options.magerun2Command;
  }
}

// Display usage information
function showUsage() {
  const packagePath = join(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));

  console.log(`
${packageJson.name} v${packageJson.version}
${packageJson.description}

USAGE:
  npx @elgentos/magento2-dev-mcp

REQUIREMENTS:
  - Node.js ${packageJson.engines.node}
  - n98-magerun2 installed and accessible via PATH
  - Valid Magento 2 installation in the working directory

CONFIGURATION:
  Add this server to your AI agent's MCP configuration:

  {
    "mcpServers": {
      "magento2-dev": {
        "command": "npx",
        "args": ["@elgentos/magento2-dev-mcp"],
        "cwd": "/path/to/your/magento2/project"
      }
    }
  }

  Or for local development:
  {
    "mcpServers": {
      "magento2-dev": {
        "command": "node",
        "args": [
          "node_modules/@elgentos/magento2-dev-mcp/dist/cli.js",
          "--use-compose=true",
          "--php-service=php-fpm",
          "--mysql-service=mysql"
        ],
        "cwd": "/path/to/your/magento2/project"
      }
    }
  }

CLI PARAMETERS:
  --use-compose=true|false  Choose docker compose services or local binaries
  --php-service=<name>      PHP service name for docker compose mode
  --mysql-service=<name>    MySQL service name for docker compose mode
  --container-root=<path>   Magento root inside the PHP container
                            (default: "/var/www/html")
  --php-bin=<path>          Local PHP binary for non-compose mode
                            (default: "php")
  --mysql-bin=<path>        Local MySQL binary for non-compose mode
                            (default: "mysql")
  --magerun2-command=<cmd>  Override the magerun2 binary name or path
                            (default: "magerun2")

ENVIRONMENT VARIABLES:
  CLI parameters override these values when provided.

  MAGENTO2_USE_COMPOSE  When "true", execute commands through docker compose using
                        explicit service names. When "false", use local binaries.
                        (default: "false")
  MAGENTO2_PHP_SERVICE  Docker compose PHP service name used when
                        MAGENTO2_USE_COMPOSE=true
  MAGENTO2_MYSQL_SERVICE Docker compose MySQL service name used when
                        MAGENTO2_USE_COMPOSE=true
  MAGENTO2_CONTAINER_ROOT Container worktree path inside the PHP container
                        (default: "/var/www/html")
  MAGENTO2_PHP_BIN      Local PHP binary used when MAGENTO2_USE_COMPOSE=false
                        (default: "php")
  MAGENTO2_MYSQL_BIN    Local MySQL binary used when MAGENTO2_USE_COMPOSE=false
                        (default: "mysql")
  MAGERUN2_COMMAND    Override the magerun2 binary name or path
                      (default: "magerun2")
                      Example: MAGERUN2_COMMAND=n98-magerun2

EXECUTION MODES:
  Local binaries:
    MAGENTO2_USE_COMPOSE=false

  Docker compose:
    MAGENTO2_USE_COMPOSE=true
    MAGENTO2_PHP_SERVICE=<php service>
    MAGENTO2_MYSQL_SERVICE=<mysql service>

AVAILABLE TOOLS:
  - Cache Management: clean, flush, enable, disable, status, view
  - Module Tools: list, create, observer-list
  - System Info: info, check, store-list, url-list, website-list
  - Configuration: show, set, store-get, store-set
  - Database: query
  - Web API: api-get-token, api-check, api-contract
  - Quality Tools: translation-check, module-integration-test, compatibility-check, copyright-check, release-check
  - Mail: mail-inspect (source/query/evidence with optional email image rendering)
  - Setup: upgrade, di-compile, db-status, static-content-deploy
  - Cron: list, run
  - DI Tools: get-di-preferences, dev-plugin-list

For detailed documentation, visit:
${packageJson.homepage}
`);
}

// Check command line arguments
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  showUsage();
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  const packagePath = join(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  console.log(packageJson.version);
  process.exit(0);
}

try {
  applyRuntimeCliOptions(parseRuntimeCliOptions(args));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.error('Run with --help to see supported parameters.');
  process.exit(1);
}

// If no special arguments, start the MCP server by importing the main module
// This will execute the main() function at the bottom of index.js
async function startServer() {
  try {
    // Import using absolute path to avoid module resolution issues
    const indexPath = join(__dirname, 'index.js');
    await import(indexPath);
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    console.error('Error details:', error);
    console.error('Attempted to import from:', join(__dirname, 'index.js'));
    console.error('Current working directory:', process.cwd());
    console.error('__dirname:', __dirname);
    process.exit(1);
  }
}

startServer();
