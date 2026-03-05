import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join, relative } from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveModuleDirectory } from "../core/module-resolver.js";

const ALLOWED_EXTENSIONS = new Set(["php", "phtml", "js", "xml"]);

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

function extractHeaderComment(content: string, extension: string): string {
  if (extension === "xml") {
    const xmlCommentMatch = content.match(/<!--([\s\S]*?)-->/);
    return xmlCommentMatch?.[0] ?? "";
  }

  const commentMatch = content.match(/\/\*[\s\S]*?\*\//);
  return commentMatch?.[0] ?? "";
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
    return { ok: false, reason: "empty_or_missing_comment_block" };
  }

  const positions: number[] = [];
  const missing: string[] = [];

  for (const requiredLine of requiredLines) {
    const idx = lines.indexOf(requiredLine);
    if (idx === -1) {
      missing.push(requiredLine);
    } else {
      positions.push(idx);
    }
  }

  if (missing.length > 0) {
    return { ok: false, reason: `missing_lines: ${missing.join(" | ")}` };
  }

  const ordered = positions.every((value, index) => index === 0 || positions[index - 1] <= value);
  if (!ordered) {
    return { ok: false, reason: "required_lines_out_of_order" };
  }

  return { ok: true, reason: "" };
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
          if (entry.name === "vendor" || entry.name === ".git" || entry.name === "node_modules") {
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
      let resolvedModule;
      try {
        resolvedModule = resolveModuleDirectory(moduleDir, { requireSubPath: "etc/module.xml" });
      } catch (error) {
        return {
          content: [{ type: "text", text: `Invalid moduleDir: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }

      const requestedExtensions = (extensions ?? ["php", "phtml", "js", "xml"])
        .map((value) => value.trim().toLowerCase().replace(/^\./, ""))
        .filter(Boolean);

      const invalidExtensions = requestedExtensions.filter((ext) => !ALLOWED_EXTENSIONS.has(ext));
      const validExtensions = new Set(requestedExtensions.filter((ext) => ALLOWED_EXTENSIONS.has(ext)));

      if (validExtensions.size === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              okCopyright: false,
              summary: { passes: 0, warnings: 0, failures: 1 },
              missingHeaders: [],
              invalidFiles: [],
              invalidExtensions,
              moduleDir: resolvedModule.relativeModuleDir,
              format
            }, null, 2)
          }],
          isError: true
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
        return {
          content: [{ type: "text", text: `Could not read module name from ${resolvedModule.relativeModuleDir}/etc/module.xml` }],
          isError: true
        };
      }

      const files = await listFilesRecursively(resolvedModule.absoluteModuleDir, validExtensions);
      const missingHeaders: Array<Record<string, unknown>> = [];

      for (const filePath of files) {
        const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase() : "";
        const content = await readFile(filePath, "utf8");
        const headerBlock = extractHeaderComment(content, ext);
        const validation = validateHeaderBlock(headerBlock, moduleName);

        if (!validation.ok) {
          missingHeaders.push({
            file: relative(process.cwd(), filePath),
            reason: validation.reason
          });
        }
      }

      const failures = missingHeaders.length;
      const warnings = invalidExtensions.length > 0 ? 1 : 0;
      const passes = failures === 0 ? 1 : 0;

      const payload = {
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

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: !payload.okCopyright
      };
    }
  );
}
