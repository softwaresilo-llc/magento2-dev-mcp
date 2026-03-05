import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join, relative } from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveModuleDirectory } from "../core/module-resolver.js";

export interface CopyrightCheckResult {
  okCopyright: boolean;
  summary: {
    passes: number;
    warnings: number;
    failures: number;
  };
  missingHeaders: Array<Record<string, unknown>>;
  invalidFiles: Array<Record<string, unknown>>;
  invalidExtensions: string[];
  moduleDir: string;
  scannedFiles: number;
}

const ALLOWED_EXTENSIONS = new Set(["php", "phtml", "js", "xml"]);
const SKIP_DIRS = new Set(["vendor", ".git", "node_modules", ".github", ".idea", "generated", "var", "pub"]);

function normalizeCommentLines(block: string): string[] {
  const lines: string[] = [];

  for (const rawLine of block.split(/\r?\n/)) {
    let line = rawLine.replace(/\uFEFF/g, "").trim();

    if (line.startsWith("<!--")) {
      line = line.slice(4).trim();
    }
    if (line.endsWith("-->")) {
      line = line.slice(0, -3).trim();
    }
    if (line.startsWith("/*")) {
      line = line.slice(2).trim();
    }
    if (line.endsWith("*/")) {
      line = line.slice(0, -2).trim();
    }
    if (line.startsWith("*")) {
      line = line.slice(1).trim();
    }

    if (line.length > 0) {
      lines.push(line);
    }
  }

  return lines;
}

function validateHeaderBlock(block: string, moduleName: string): { ok: boolean; reason: string } {
  const requiredLines = [
    `@package ${moduleName}`,
    "@author SoftwareSilo LLC <info@softwaresilo.io>",
    "@copyright SoftwareSilo LLC",
    "@license https://www.mageb2b.de/en/license-terms"
  ];

  const lines = normalizeCommentLines(block);
  if (lines.length === 0) {
    return { ok: false, reason: "empty comment block" };
  }

  const atLines = lines.filter((line) => line.startsWith("@"));
  if (atLines.length === 0) {
    return { ok: false, reason: "no @ tags in comment block" };
  }
  if (atLines[0] !== requiredLines[0]) {
    return { ok: false, reason: `first @ tag must be '${requiredLines[0]}'` };
  }

  const positions: number[] = [];
  const missing: string[] = [];
  for (const requiredLine of requiredLines) {
    const index = lines.indexOf(requiredLine);
    if (index === -1) {
      missing.push(requiredLine);
    } else {
      positions.push(index);
    }
  }

  if (missing.length > 0) {
    return { ok: false, reason: `missing required lines: ${missing.join(", ")}` };
  }

  const ordered = positions.every((value, index) => index === 0 || positions[index - 1] <= value);
  if (!ordered) {
    return { ok: false, reason: "required lines are not in expected order" };
  }

  return { ok: true, reason: "" };
}

function looksLikeHeaderCandidate(block: string): boolean {
  const normalized = normalizeCommentLines(block).join("\n").toLowerCase();
  return normalized.includes("@package")
    || normalized.includes("@author softwaresilo llc <info@softwaresilo.io>")
    || normalized.includes("@copyright softwaresilo llc")
    || normalized.includes("@license https://www.mageb2b.de/en/license-terms");
}

function findTopCommentBlocks(content: string, extension: string): Array<{ startLine: number; block: string }> {
  const topRegion = content.split(/\r?\n/).slice(0, 140).join("\n");
  const pattern = extension === "xml" ? /<!--[\s\S]*?-->/g : /\/\*[\s\S]*?\*\//g;
  const maxStartLine = extension === "xml" ? 30 : 25;
  const matches = Array.from(topRegion.matchAll(pattern));

  return matches
    .map((match) => {
      const startIndex = match.index ?? 0;
      const startLine = topRegion.slice(0, startIndex).split("\n").length;
      return {
        startLine,
        block: match[0]
      };
    })
    .filter((item) => item.startLine <= maxStartLine);
}

async function listFilesRecursively(rootDir: string, allowedExtensions: Set<string>): Promise<string[]> {
  const queue = [rootDir];
  const files: string[] = [];

  while (queue.length > 0) {
    const currentDir = queue.shift() as string;
    try {
      const entries = await readdir(currentDir, { withFileTypes: true, encoding: "utf8" });
      for (const entry of entries) {
        const absolutePath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
            continue;
          }
          queue.push(absolutePath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const extension = entry.name.includes(".")
          ? entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase()
          : "";

        if (allowedExtensions.has(extension)) {
          files.push(absolutePath);
        }
      }
    } catch {
      continue;
    }
  }

  return files;
}

function readModuleNameFromModuleXml(content: string): string {
  const match = content.match(/<module\b[^>]*\bname="([^"]+)"/i);
  return match?.[1]?.trim() ?? "";
}

export async function runCopyrightCheck(input: {
  moduleDir: string;
  extensions?: string[];
  format?: "text" | "json";
}): Promise<CopyrightCheckResult> {
  const resolvedModule = resolveModuleDirectory(input.moduleDir, { requireSubPath: "etc/module.xml" });

  const requestedExtensions = (input.extensions ?? ["php", "phtml", "js", "xml"])
    .map((value) => value.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);

  const invalidExtensions = requestedExtensions.filter((ext) => !ALLOWED_EXTENSIONS.has(ext));
  const validExtensions = new Set(requestedExtensions.filter((ext) => ALLOWED_EXTENSIONS.has(ext)));

  if (validExtensions.size === 0) {
    return {
      okCopyright: false,
      summary: { passes: 0, warnings: 0, failures: 1 },
      missingHeaders: [],
      invalidFiles: [],
      invalidExtensions,
      moduleDir: resolvedModule.relativeModuleDir,
      scannedFiles: 0
    };
  }

  const moduleXmlPath = join(resolvedModule.absoluteModuleDir, "etc", "module.xml");
  let moduleName = "";
  try {
    const moduleXml = await readFile(moduleXmlPath, "utf8");
    moduleName = readModuleNameFromModuleXml(moduleXml);
  } catch {
    moduleName = "";
  }

  if (!moduleName) {
    throw new Error(`Could not read module name from ${resolvedModule.relativeModuleDir}/etc/module.xml`);
  }

  const files = await listFilesRecursively(resolvedModule.absoluteModuleDir, validExtensions);
  const missingHeaders: Array<Record<string, unknown>> = [];

  for (const filePath of files) {
    const extension = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase() : "";
    const content = await readFile(filePath, "utf8");
    const topBlocks = findTopCommentBlocks(content, extension);

    if (topBlocks.length === 0) {
      missingHeaders.push({
        file: relative(process.cwd(), filePath),
        extension,
        reason: `no comment block found in top section`
      });
      continue;
    }

    const candidates = topBlocks.filter((item) => looksLikeHeaderCandidate(item.block));
    if (candidates.length === 0) {
      const maxStartLine = extension === "xml" ? 30 : 25;
      missingHeaders.push({
        file: relative(process.cwd(), filePath),
        extension,
        reason: `no copyright header candidate in top ${maxStartLine} lines`
      });
      continue;
    }

    let valid = false;
    const reasons: string[] = [];

    for (const candidate of candidates) {
      const validation = validateHeaderBlock(candidate.block, moduleName);
      if (validation.ok) {
        valid = true;
        break;
      }
      reasons.push(`line ${candidate.startLine}: ${validation.reason}`);
    }

    if (!valid) {
      missingHeaders.push({
        file: relative(process.cwd(), filePath),
        extension,
        reason: reasons.join(" ; ") || "header block invalid"
      });
    }
  }

  const failures = missingHeaders.length;
  const warnings = invalidExtensions.length > 0 ? 1 : 0;
  const passes = failures === 0 ? 1 : 0;

  return {
    okCopyright: failures === 0,
    summary: {
      passes,
      warnings,
      failures
    },
    missingHeaders,
    invalidFiles: missingHeaders,
    invalidExtensions,
    moduleDir: resolvedModule.relativeModuleDir,
    scannedFiles: files.length
  };
}

export function registerCopyrightCheckTool(server: McpServer): void {
  server.registerTool(
    "copyright-check",
    {
      title: "Copyright Check",
      description: "Validate required copyright headers in module files",
      inputSchema: {
        moduleDir: z.string().describe("Module directory, e.g. app/code/Vendor/Module or vendor/vendor/module"),
        extensions: z.array(z.string()).optional().describe("Optional file extensions, e.g. ['php','phtml','js','xml']"),
        format: z.enum(["text", "json"]).default("json").describe("Output format")
      }
    },
    async ({ moduleDir, extensions, format = "json" }) => {
      try {
        const payload = await runCopyrightCheck({ moduleDir, extensions, format });
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          isError: !payload.okCopyright
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
