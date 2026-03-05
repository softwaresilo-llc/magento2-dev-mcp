import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, relative } from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveModuleDirectory } from "../core/module-resolver.js";

interface CsvEntry {
  key: string;
  value: string;
  line: number;
}

function parseCsvTwoColumns(content: string): CsvEntry[] {
  const rows: CsvEntry[] = [];
  const lines = content.split(/\r?\n/);

  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo];
    if (!line.trim()) {
      continue;
    }

    const columns: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }

      if (char === "," && !inQuotes) {
        columns.push(current);
        current = "";
        continue;
      }

      current += char;
    }

    columns.push(current);
    if (columns.length < 2) {
      continue;
    }

    rows.push({
      key: columns[0].trim(),
      value: columns[1].trim(),
      line: lineNo + 1
    });
  }

  return rows;
}

function placeholderTokens(value: string): string[] {
  const matches = value.match(/%(?:\d+|[bcdeEfFgGosuxX])/g) ?? [];
  return Array.from(new Set(matches)).sort();
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

function normalizePhrase(value: string): string {
  return value
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\s+/g, " ")
    .trim();
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

function extractPhrasesFromSourceContent(content: string): string[] {
  const phrases = new Set<string>();

  const phpRegex = /__\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = phpRegex.exec(content)) !== null) {
    const phrase = normalizePhrase(match[2] ?? "");
    if (phrase.length > 0) {
      phrases.add(phrase);
    }
  }

  const jsRegex = /\$t\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  while ((match = jsRegex.exec(content)) !== null) {
    const phrase = normalizePhrase(match[2] ?? "");
    if (phrase.length > 0) {
      phrases.add(phrase);
    }
  }

  return Array.from(phrases);
}

function parseTranslateAttributePhrases(content: string): string[] {
  const phrases = new Set<string>();

  const simpleAttrRegex = /translate\s*=\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = simpleAttrRegex.exec(content)) !== null) {
    const values = (match[1] ?? "").split(/\s+/).map((item) => normalizePhrase(item)).filter(Boolean);
    for (const value of values) {
      phrases.add(value);
    }
  }

  return Array.from(phrases);
}

export function registerTranslationCheckTool(server: McpServer): void {
  server.registerTool(
    "translation-check",
    {
      title: "Translation Check",
      description: "Run module translation QA checks (missing keys, placeholders, source coverage)",
      inputSchema: {
        moduleDir: z
          .string()
          .describe("Module directory, e.g. app/code/Vendor/Module or vendor/vendor/module"),
        locales: z
          .array(z.string())
          .optional()
          .describe("Locales to validate, e.g. ['en_US','de_DE','es_ES']"),
        strictSource: z
          .boolean()
          .default(true)
          .describe("When false, source phrase coverage is downgraded from FAIL to WARN"),
        format: z
          .enum(["text", "json"])
          .default("json")
          .describe("Output format")
      }
    },
    async ({ moduleDir, locales, strictSource = true, format = "json" }) => {
      let resolvedModule;
      try {
        resolvedModule = resolveModuleDirectory(moduleDir);
      } catch (error) {
        return {
          content: [{ type: "text", text: `Invalid moduleDir: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }

      const effectiveLocales = Array.isArray(locales) && locales.length > 0
        ? locales
        : ["en_US", "de_DE", "es_ES"];

      let passes = 0;
      let warnings = 0;
      let failures = 0;

      const missing: Array<Record<string, unknown>> = [];
      const placeholderIssues: Array<Record<string, unknown>> = [];
      const notes: string[] = [];

      const localeMaps = new Map<string, Map<string, { value: string; line: number }>>();
      for (const locale of effectiveLocales) {
        const localeFile = join(resolvedModule.absoluteModuleDir, "i18n", `${locale}.csv`);
        if (!existsSync(localeFile)) {
          failures += 1;
          missing.push({
            locale,
            key: "*",
            reason: "missing_locale_file",
            file: relative(process.cwd(), localeFile)
          });
          continue;
        }

        const csvContent = await readFile(localeFile, "utf8");
        const rows = parseCsvTwoColumns(csvContent);
        const translations = new Map<string, { value: string; line: number }>();
        const seenKeys = new Set<string>();

        for (const row of rows) {
          if (!row.key) {
            failures += 1;
            missing.push({
              locale,
              key: "",
              reason: "empty_key",
              line: row.line
            });
            continue;
          }

          if (seenKeys.has(row.key)) {
            warnings += 1;
            notes.push(`${locale}: duplicate key '${row.key}' (line ${row.line})`);
            continue;
          }
          seenKeys.add(row.key);

          const expected = placeholderTokens(row.key);
          const actual = placeholderTokens(row.value);
          if (!arraysEqual(expected, actual)) {
            failures += 1;
            placeholderIssues.push({
              locale,
              key: row.key,
              value: row.value,
              line: row.line,
              expected,
              actual
            });
          }

          translations.set(row.key, { value: row.value, line: row.line });
        }

        localeMaps.set(locale, translations);
      }

      const sourceExtensions = new Set(["php", "phtml", "xml", "js", "ts", "tsx"]);
      const sourceFiles = await listFilesRecursively(resolvedModule.absoluteModuleDir, sourceExtensions);
      const sourcePhrases = new Set<string>();
      for (const sourceFile of sourceFiles) {
        const content = await readFile(sourceFile, "utf8");
        for (const phrase of extractPhrasesFromSourceContent(content)) {
          sourcePhrases.add(phrase);
        }
        if (sourceFile.endsWith(".xml")) {
          for (const phrase of parseTranslateAttributePhrases(content)) {
            sourcePhrases.add(phrase);
          }
        }
      }

      for (const phrase of sourcePhrases) {
        for (const locale of effectiveLocales) {
          const localeMap = localeMaps.get(locale);
          if (!localeMap) {
            continue;
          }

          const translation = localeMap.get(phrase);
          if (!translation || !translation.value) {
            if (strictSource) {
              failures += 1;
            } else {
              warnings += 1;
            }
            missing.push({
              locale,
              key: phrase,
              reason: translation ? "empty_value" : "missing_key"
            });
            continue;
          }

          if (locale !== "en_US" && normalizePhrase(translation.value) === normalizePhrase(phrase)) {
            warnings += 1;
            notes.push(`${locale}: untranslated value '${phrase}'`);
          }
        }
      }

      if (failures === 0 && warnings === 0) {
        passes += 1;
      } else if (failures === 0) {
        passes += 1;
      }

      const payload = {
        okTranslations: failures === 0,
        summary: {
          passes,
          warnings,
          failures
        },
        missing,
        placeholderIssues,
        moduleDir: resolvedModule.relativeModuleDir,
        metrics: {
          sourceFiles: sourceFiles.length,
          sourcePhrases: sourcePhrases.size,
          locales: effectiveLocales
        },
        notes: format === "text" ? notes : undefined
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: !payload.okTranslations
      };
    }
  );
}
