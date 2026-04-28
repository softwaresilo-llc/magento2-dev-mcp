import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveModuleDirectory } from "../core/module-resolver.js";

export interface TranslationCheckResult {
  okTranslations: boolean;
  summary: {
    passes: number;
    warnings: number;
    failures: number;
  };
  missing: Array<Record<string, unknown>>;
  placeholderIssues: Array<Record<string, unknown>>;
  moduleDir: string;
  metrics: {
    sourceFiles: number;
    sourcePhrases: number;
    locales: string[];
  };
  notes?: string[];
  details?: Record<string, unknown>;
  messages?: {
    info: string[];
    pass: string[];
    warn: string[];
    fail: string[];
  };
}

interface CsvEntry {
  key: string;
  value: string;
  line: number;
}

interface CsvLineIssue {
  line: number;
  raw: string;
  expected?: string;
  columns?: number;
}

interface ParsedCsv {
  exists: boolean;
  parseError: string | null;
  entriesExact: Map<string, string>;
  entriesNorm: Map<string, { key: string; value: string; line: number }>;
  duplicates: Array<{ key: string; firstLine: number; line: number }>;
  normalizedDuplicates: Array<{ normalizedKey: string; firstKey: string; firstLine: number; key: string; line: number }>;
  caseVariantKeys: Array<{ normalizedKeyCasefold: string; variants: Array<{ key: string; line: number }> }>;
  emptyKeyLines: number[];
  invalidColumnLines: CsvLineIssue[];
  noncanonicalCsvLines: CsvLineIssue[];
}

interface FallbackEntry {
  key: string;
  value: string;
  package: string;
  path: string;
}

const EXCLUDED_TERMS = ["mageb2b", "softwaresilo"];
const EXCLUDED_EXACT_PHRASES = new Set(["MageB2B", "SoftwareSilo"].map((value) => normalizeForMatch(value)));

function ascendDirectory(pathValue: string, levels: number): string {
  let current = pathValue;
  for (let index = 0; index < levels; index += 1) {
    current = dirname(current);
  }
  return current;
}

function detectProjectRoot(moduleAbsoluteDir: string, moduleRelativeDir: string): string {
  const segments = moduleRelativeDir.split("/").filter(Boolean).length;
  return ascendDirectory(moduleAbsoluteDir, segments);
}

function normalizeForMatch(value: string): string {
  return value
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForUntranslatedMatch(value: string): string {
  return normalizeForMatch(value).toLocaleLowerCase("en-US");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isExcludedPhrase(value: string): boolean {
  return EXCLUDED_EXACT_PHRASES.has(normalizeForMatch(value));
}

function hasExcludedTerm(value: string): boolean {
  const normalized = normalizeForMatch(value).toLowerCase();
  if (!normalized) {
    return false;
  }
  return EXCLUDED_TERMS.some((term) => normalized.includes(term));
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

function escapeCsvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function canonicalCsvLine(key: string, value: string): string {
  return `${escapeCsvField(key)},${escapeCsvField(value)}`;
}

function parseCsvLine(line: string): { columns: string[]; unclosedQuote: boolean } {
  const columns: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
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
  return { columns, unclosedQuote: inQuotes };
}

async function parseLocaleCsv(filePath: string, allowExtraColumns = false): Promise<ParsedCsv> {
  const parsed: ParsedCsv = {
    exists: existsSync(filePath),
    parseError: null,
    entriesExact: new Map(),
    entriesNorm: new Map(),
    duplicates: [],
    normalizedDuplicates: [],
    caseVariantKeys: [],
    emptyKeyLines: [],
    invalidColumnLines: [],
    noncanonicalCsvLines: []
  };

  if (!parsed.exists) {
    return parsed;
  }

  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
    const seenExact = new Map<string, number>();
    const seenNormalized = new Map<string, { key: string; line: number }>();
    const seenCasefold = new Map<string, Map<string, number>>();

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const rawLine = lines[lineIndex] ?? "";
      if (!rawLine.trim()) {
        continue;
      }

      const lineNumber = lineIndex + 1;
      const { columns, unclosedQuote } = parseCsvLine(rawLine);
      if (columns.length < 2 || (!allowExtraColumns && columns.length !== 2) || unclosedQuote) {
        parsed.invalidColumnLines.push({
          line: lineNumber,
          raw: rawLine,
          columns: columns.length
        });
        continue;
      }

      const key = columns[0].trim();
      const value = columns[1].trim();
      if (!allowExtraColumns) {
        const expectedLine = canonicalCsvLine(columns[0], columns[1]);
        if (rawLine !== expectedLine) {
          parsed.noncanonicalCsvLines.push({
            line: lineNumber,
            raw: rawLine,
            expected: expectedLine
          });
        }
      }

      if (!key) {
        parsed.emptyKeyLines.push(lineNumber);
        continue;
      }

      const normalizedKey = normalizeForMatch(key);
      if (isExcludedPhrase(normalizedKey)) {
        continue;
      }

      if (seenExact.has(key)) {
        parsed.duplicates.push({
          key,
          firstLine: seenExact.get(key) as number,
          line: lineNumber
        });
      } else {
        seenExact.set(key, lineNumber);
      }

      if (seenNormalized.has(normalizedKey) && (seenNormalized.get(normalizedKey)?.key !== key)) {
        const previous = seenNormalized.get(normalizedKey) as { key: string; line: number };
        parsed.normalizedDuplicates.push({
          normalizedKey,
          firstKey: previous.key,
          firstLine: previous.line,
          key,
          line: lineNumber
        });
      } else if (!seenNormalized.has(normalizedKey)) {
        seenNormalized.set(normalizedKey, { key, line: lineNumber });
      }

      const casefoldKey = normalizedKey.toLowerCase();
      const variants = seenCasefold.get(casefoldKey) ?? new Map<string, number>();
      if (!variants.has(key)) {
        variants.set(key, lineNumber);
      }
      seenCasefold.set(casefoldKey, variants);

      parsed.entriesExact.set(key, value);
      if (!parsed.entriesNorm.has(normalizedKey)) {
        parsed.entriesNorm.set(normalizedKey, { key, value, line: lineNumber });
      }
    }

    for (const [normalizedKeyCasefold, variants] of seenCasefold.entries()) {
      if (variants.size <= 1) {
        continue;
      }
      parsed.caseVariantKeys.push({
        normalizedKeyCasefold,
        variants: Array.from(variants.entries())
          .map(([key, line]) => ({ key, line }))
          .sort((left, right) => left.line - right.line)
      });
    }
  } catch (error) {
    parsed.parseError = error instanceof Error ? error.message : String(error);
  }

  return parsed;
}

async function listFilesRecursively(rootDir: string, allowedExtensions: Set<string>): Promise<string[]> {
  const queue = [rootDir];
  const files: string[] = [];
  const skipDirectories = new Set([
    ".git",
    ".github",
    ".idea",
    "i18n",
    "docs",
    "doc",
    "dev",
    "test",
    "tests",
    "Test",
    "Tests",
    "node_modules",
    "vendor"
  ]);

  while (queue.length > 0) {
    const currentDir = queue.shift() as string;
    try {
      const entries = await readdir(currentDir, { withFileTypes: true, encoding: "utf8" });
      for (const entry of entries) {
        const absolutePath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (skipDirectories.has(entry.name)) {
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
  const jsRegex = /\$t\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  const htmlI18nSingleRegex = /i18n:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  const htmlI18nDoubleRegex = /i18n:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;

  let match: RegExpExecArray | null;
  while ((match = phpRegex.exec(content)) !== null) {
    const phrase = normalizeForMatch(match[2] ?? "");
    if (phrase) {
      phrases.add(phrase);
    }
  }

  while ((match = jsRegex.exec(content)) !== null) {
    const phrase = normalizeForMatch(match[2] ?? "");
    if (phrase) {
      phrases.add(phrase);
    }
  }

  while ((match = htmlI18nSingleRegex.exec(content)) !== null) {
    const phrase = normalizeForMatch(match[1] ?? "");
    if (phrase) {
      phrases.add(phrase);
    }
  }

  while ((match = htmlI18nDoubleRegex.exec(content)) !== null) {
    const phrase = normalizeForMatch(match[1] ?? "");
    if (phrase) {
      phrases.add(phrase);
    }
  }

  return Array.from(phrases);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseXmlAttributes(attributeText: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const attributeRegex = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = attributeRegex.exec(attributeText)) !== null) {
    attributes.set(match[1], decodeXmlEntities(match[2] ?? ""));
  }

  return attributes;
}

function parseTranslateAttributePhrases(content: string): string[] {
  const phrases = new Set<string>();
  const elementRegex = /<([A-Za-z_:][A-Za-z0-9_.:-]*)([^>]*)>([\s\S]*?)<\/\1>|<([A-Za-z_:][A-Za-z0-9_.:-]*)([^>]*)\/>/g;
  let match: RegExpExecArray | null;

  while ((match = elementRegex.exec(content)) !== null) {
    const openingAttributes = `${match[2] ?? ""} ${match[5] ?? ""}`;
    const attributes = parseXmlAttributes(openingAttributes);
    const translateValue = normalizeForMatch(attributes.get("translate") ?? "").toLowerCase();
    if (!translateValue) {
      continue;
    }

    if (translateValue === "true") {
      const textContent = normalizeForMatch(decodeXmlEntities((match[3] ?? "").replace(/<[^>]+>/g, " ")));
      if (textContent) {
        phrases.add(textContent);
      }
      continue;
    }

    for (const attributeName of translateValue.split(/\s+/).filter(Boolean)) {
      const attributePhrase = normalizeForMatch(attributes.get(attributeName) ?? "");
      if (attributePhrase) {
        phrases.add(attributePhrase);
      }
    }
  }

  return Array.from(phrases);
}

async function detectModuleLocales(moduleAbsoluteDir: string): Promise<string[]> {
  const i18nDir = join(moduleAbsoluteDir, "i18n");
  if (!existsSync(i18nDir)) {
    return [];
  }

  const entries = await readdir(i18nDir, { withFileTypes: true, encoding: "utf8" });
  const locales = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".csv"))
    .map((entry) => entry.name.slice(0, -4))
    .filter(Boolean)
    .sort();

  if (locales.includes("en_US")) {
    return ["en_US", ...locales.filter((locale) => locale !== "en_US")];
  }

  return locales;
}

async function loadJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function resolveDependencyModules(moduleAbsoluteDir: string, projectRoot: string): Promise<Array<{ package: string; path: string }>> {
  const composerPath = join(moduleAbsoluteDir, "composer.json");
  const composerJson = await loadJsonFile(composerPath);
  const requires = typeof composerJson?.require === "object" && composerJson.require !== null
    ? composerJson.require as Record<string, unknown>
    : {};

  const dependencies: Array<{ package: string; path: string }> = [];
  for (const packageName of Object.keys(requires)) {
    if (!packageName.startsWith("mageb2b/")) {
      continue;
    }

    const moduleTail = packageName.slice("mageb2b/".length);
    const modulePath = join(projectRoot, "vendor", "mageb2b", moduleTail);
    if (existsSync(modulePath)) {
      dependencies.push({ package: packageName, path: modulePath });
    }
  }

  return dependencies;
}

async function collectFallbackLocaleEntries(modulePaths: Array<{ package: string; path: string }>, locales: string[]): Promise<Map<string, Map<string, FallbackEntry>>> {
  const result = new Map<string, Map<string, FallbackEntry>>();
  for (const locale of locales) {
    result.set(locale, new Map());
  }

  for (const dependency of modulePaths) {
    for (const locale of locales) {
      const csvPath = join(dependency.path, "i18n", `${locale}.csv`);
      const parsed = await parseLocaleCsv(csvPath);
      if (!parsed.exists || parsed.parseError) {
        continue;
      }

      const localeMap = result.get(locale) as Map<string, FallbackEntry>;
      for (const [normalizedKey, entry] of parsed.entriesNorm.entries()) {
        if (!normalizeForMatch(entry.value) || localeMap.has(normalizedKey)) {
          continue;
        }
        localeMap.set(normalizedKey, {
          key: entry.key,
          value: entry.value,
          package: dependency.package,
          path: csvPath
        });
      }
    }
  }

  return result;
}

async function collectExternalTranslationEntries(projectRoot: string, locales: string[]): Promise<{
  localeEntries: Map<string, Map<string, FallbackEntry>>;
  reservedEntries: Map<string, FallbackEntry>;
  sources: string[];
}> {
  const localeEntries = new Map<string, Map<string, FallbackEntry>>();
  const reservedEntries = new Map<string, FallbackEntry>();
  const sources: string[] = [];
  for (const locale of locales) {
    localeEntries.set(locale, new Map());
  }

  const registerSource = async (csvPath: string, packageName: string, locale?: string): Promise<void> => {
    const parsed = await parseLocaleCsv(csvPath, true);
    if (!parsed.exists || parsed.parseError) {
      return;
    }

    for (const [normalizedKey, entry] of parsed.entriesNorm.entries()) {
      if (!normalizeForMatch(entry.value)) {
        continue;
      }

      if (!reservedEntries.has(normalizedKey)) {
        reservedEntries.set(normalizedKey, {
          key: entry.key,
          value: entry.value,
          package: packageName,
          path: csvPath
        });
      }

      if (locale) {
        const localeMap = localeEntries.get(locale) as Map<string, FallbackEntry>;
        if (!localeMap.has(normalizedKey)) {
          localeMap.set(normalizedKey, {
            key: entry.key,
            value: entry.value,
            package: packageName,
            path: csvPath
          });
        }
      }
    }
  };

  const magentoVendorDir = join(projectRoot, "vendor", "magento");
  if (existsSync(magentoVendorDir)) {
    sources.push(magentoVendorDir);
    const magentoModules = await readdir(magentoVendorDir, { withFileTypes: true, encoding: "utf8" });
    for (const moduleEntry of magentoModules) {
      if (!moduleEntry.isDirectory()) {
        continue;
      }
      const moduleDir = join(magentoVendorDir, moduleEntry.name);
      for (const locale of locales) {
        await registerSource(join(moduleDir, "i18n", `${locale}.csv`), `magento/${moduleEntry.name}`, locale);
      }
      const composerJson = await loadJsonFile(join(moduleDir, "composer.json"));
      if (composerJson?.type === "magento2-language") {
        const packageName = String(composerJson.name ?? moduleEntry.name);
        for (const locale of locales) {
          await registerSource(join(moduleDir, `${locale}.csv`), packageName, locale);
          await registerSource(join(moduleDir, "i18n", `${locale}.csv`), packageName, locale);
        }
      }
    }
  }

  const vendorDir = join(projectRoot, "vendor");
  if (existsSync(vendorDir)) {
    const vendorNamespaces = await readdir(vendorDir, { withFileTypes: true, encoding: "utf8" });
    for (const namespaceEntry of vendorNamespaces) {
      if (!namespaceEntry.isDirectory() || namespaceEntry.name === "magento") {
        continue;
      }
      const namespaceDir = join(vendorDir, namespaceEntry.name);
      let packages;
      try {
        packages = await readdir(namespaceDir, { withFileTypes: true, encoding: "utf8" });
      } catch {
        continue;
      }

      for (const packageEntry of packages) {
        if (!packageEntry.isDirectory()) {
          continue;
        }
        const packageDir = join(namespaceDir, packageEntry.name);
        const composerJson = await loadJsonFile(join(packageDir, "composer.json"));
        if (composerJson?.type !== "magento2-language") {
          continue;
        }
        sources.push(packageDir);
        const packageName = String(composerJson.name ?? `${namespaceEntry.name}/${packageEntry.name}`);
        for (const locale of locales) {
          await registerSource(join(packageDir, `${locale}.csv`), packageName, locale);
          await registerSource(join(packageDir, "i18n", `${locale}.csv`), packageName, locale);
        }
      }
    }
  }

  const appI18nDir = join(projectRoot, "app", "i18n");
  if (existsSync(appI18nDir)) {
    sources.push(appI18nDir);
    const queue = [appI18nDir];
    while (queue.length > 0) {
      const currentDir = queue.shift() as string;
      let entries;
      try {
        entries = await readdir(currentDir, { withFileTypes: true, encoding: "utf8" });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const absolutePath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          queue.push(absolutePath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".csv")) {
          continue;
        }
        const locale = entry.name.slice(0, -4);
        if (!locales.includes(locale)) {
          continue;
        }
        await registerSource(absolutePath, `app/i18n:${dirname(absolutePath).split("/").pop() ?? locale}`, locale);
      }
    }
  }

  return {
    localeEntries,
    reservedEntries,
    sources: Array.from(new Set(sources)).sort()
  };
}

function representativeKey(
  normalizedKey: string,
  sourcePhrases: Set<string>,
  locales: string[],
  localeCsvMaps: Map<string, ParsedCsv>
): string {
  if (sourcePhrases.has(normalizedKey)) {
    return normalizedKey;
  }

  for (const locale of locales) {
    const parsed = localeCsvMaps.get(locale);
    const entry = parsed?.entriesNorm.get(normalizedKey);
    if (entry) {
      return entry.key;
    }
  }

  return normalizedKey;
}

export async function runTranslationCheck(input: {
  moduleDir: string;
  locales?: string[];
  strictSource?: boolean;
}): Promise<TranslationCheckResult> {
  const resolvedModule = resolveModuleDirectory(input.moduleDir);
  const projectRoot = detectProjectRoot(resolvedModule.absoluteModuleDir, resolvedModule.relativeModuleDir);
  const strictSource = input.strictSource ?? true;
  const effectiveLocales = Array.isArray(input.locales) && input.locales.length > 0
    ? input.locales
    : await detectModuleLocales(resolvedModule.absoluteModuleDir);

  let passes = 0;
  let warnings = 0;
  let failures = 0;

  const messages = {
    info: [] as string[],
    pass: [] as string[],
    warn: [] as string[],
    fail: [] as string[]
  };

  const notes: string[] = [];
  const details: Record<string, unknown> = {
    emptyKeyLines: {},
    invalidColumnLines: {},
    noncanonicalCsvLines: {},
    duplicates: {},
    normalizedDuplicates: {},
    caseVariantKeys: {},
    dependencyFallbackModules: [],
    externalFallbackSources: [],
    placeholderMismatches: {},
    coreTranslationCollisions: {},
    localeKeysetMismatch: {},
    sourceMissing: [],
    missingEmpty: [],
    untranslatedValues: {}
  };

  const missing: Array<Record<string, unknown>> = [];
  const placeholderIssues: Array<Record<string, unknown>> = [];

  const info = (message: string): void => {
    messages.info.push(message);
    notes.push(message);
  };
  const pass = (message: string): void => {
    passes += 1;
    messages.pass.push(message);
  };
  const warn = (message: string): void => {
    warnings += 1;
    messages.warn.push(message);
    notes.push(message);
  };
  const fail = (message: string): void => {
    failures += 1;
    messages.fail.push(message);
    notes.push(message);
  };

  if (effectiveLocales.length === 0) {
    fail("no locales configured");
    return {
      okTranslations: false,
      summary: { passes, warnings, failures },
      missing,
      placeholderIssues,
      moduleDir: resolvedModule.relativeModuleDir,
      metrics: { sourceFiles: 0, sourcePhrases: 0, locales: [] },
      notes,
      details,
      messages
    };
  }

  info(`module=${resolvedModule.absoluteModuleDir}`);
  info(`locales=${effectiveLocales.join(",")}`);
  info("excluded_phrases=MageB2B,SoftwareSilo");
  pass(`module directory found: ${resolvedModule.absoluteModuleDir}`);

  const dependencyModules = await resolveDependencyModules(resolvedModule.absoluteModuleDir, projectRoot);
  details.dependencyFallbackModules = dependencyModules.map((dependency) => ({
    package: dependency.package,
    path: dependency.path
  }));
  info(
    dependencyModules.length > 0
      ? `dependency_fallback_modules=${dependencyModules.map((dependency) => dependency.package).join(",")}`
      : "dependency_fallback_modules=none"
  );

  const localeCsvMaps = new Map<string, ParsedCsv>();
  for (const locale of effectiveLocales) {
    const localeFile = join(resolvedModule.absoluteModuleDir, "i18n", `${locale}.csv`);
    const parsed = await parseLocaleCsv(localeFile);
    localeCsvMaps.set(locale, parsed);

    if (!parsed.exists) {
      fail(`missing locale file: ${localeFile}`);
      missing.push({ locale, key: "*", reason: "missing_locale_file", file: localeFile });
      continue;
    }

    pass(`locale file exists: ${localeFile}`);

    if (parsed.parseError) {
      fail(`CSV parse error in ${localeFile}: ${parsed.parseError}`);
      continue;
    }

    pass(`${locale}.csv: parsed ${parsed.entriesExact.size} key(s)`);

    if (parsed.emptyKeyLines.length > 0) {
      (details.emptyKeyLines as Record<string, unknown>)[locale] = parsed.emptyKeyLines;
      fail(`${locale}.csv: empty keys at lines: ${parsed.emptyKeyLines.join(", ")}`);
    } else {
      pass(`${locale}.csv: no empty keys`);
    }

    if (parsed.invalidColumnLines.length > 0) {
      (details.invalidColumnLines as Record<string, unknown>)[locale] = parsed.invalidColumnLines;
      fail(`${locale}.csv: invalid column count in ${parsed.invalidColumnLines.length} row(s)`);
    } else {
      pass(`${locale}.csv: all rows have exactly 2 columns`);
    }

    if (parsed.noncanonicalCsvLines.length > 0) {
      (details.noncanonicalCsvLines as Record<string, unknown>)[locale] = parsed.noncanonicalCsvLines;
      fail(`${locale}.csv: non-canonical CSV quoting in ${parsed.noncanonicalCsvLines.length} row(s)`);
    } else {
      pass(`${locale}.csv: canonical fully-quoted CSV rows`);
    }

    if (parsed.duplicates.length > 0) {
      (details.duplicates as Record<string, unknown>)[locale] = parsed.duplicates;
      fail(`${locale}.csv: duplicate exact key entries (${parsed.duplicates.length})`);
    } else {
      pass(`${locale}.csv: no duplicate exact keys`);
    }

    if (parsed.normalizedDuplicates.length > 0) {
      (details.normalizedDuplicates as Record<string, unknown>)[locale] = parsed.normalizedDuplicates;
      fail(`${locale}.csv: duplicate normalized keys (${parsed.normalizedDuplicates.length})`);
    } else {
      pass(`${locale}.csv: no duplicate normalized keys`);
    }

    if (parsed.caseVariantKeys.length > 0) {
      (details.caseVariantKeys as Record<string, unknown>)[locale] = parsed.caseVariantKeys;
      warn(`${locale}.csv: key variants differ only by case (${parsed.caseVariantKeys.length} group(s))`);
    } else {
      pass(`${locale}.csv: no case-only key variants`);
    }
  }

  const readableLocaleEntries = new Map(
    effectiveLocales
      .map((locale) => [locale, localeCsvMaps.get(locale)] as const)
      .filter(([, parsed]) => Boolean(parsed && parsed.exists && !parsed.parseError))
      .map(([locale, parsed]) => [locale, parsed?.entriesNorm ?? new Map()] as const)
  );
  const moduleKeyUnion = new Set<string>();
  for (const entries of readableLocaleEntries.values()) {
    for (const normalizedKey of entries.keys()) {
      moduleKeyUnion.add(normalizedKey);
    }
  }
  const moduleKeyRepresentatives = new Map<string, string>();
  for (const entries of readableLocaleEntries.values()) {
    for (const [normalizedKey, entry] of entries.entries()) {
      if (!moduleKeyRepresentatives.has(normalizedKey)) {
        moduleKeyRepresentatives.set(normalizedKey, entry.key);
      }
    }
  }
  for (const locale of effectiveLocales) {
    const entries = readableLocaleEntries.get(locale);
    if (!entries) {
      continue;
    }
    const missingModuleKeys = Array.from(moduleKeyUnion)
      .filter((normalizedKey) => !entries.has(normalizedKey))
      .map((normalizedKey) => moduleKeyRepresentatives.get(normalizedKey) ?? normalizedKey)
      .sort();
    if (missingModuleKeys.length > 0) {
      (details.localeKeysetMismatch as Record<string, unknown>)[locale] = {
        missingModuleKeys
      };
      fail(`${locale}: module locale keyset mismatch (${missingModuleKeys.length} key(s) missing compared with other shipped locales)`);
    } else {
      pass(`${locale}: module locale keyset matches other shipped locales`);
    }
  }

  const dependencyLocaleEntries = await collectFallbackLocaleEntries(dependencyModules, effectiveLocales);
  for (const locale of effectiveLocales) {
    const count = dependencyLocaleEntries.get(locale)?.size ?? 0;
    if (count > 0) {
      pass(`${locale}: dependency fallback phrases available: ${count}`);
    } else {
      info(`${locale}: dependency fallback phrases available: 0`);
    }
  }

  const externalEntries = await collectExternalTranslationEntries(projectRoot, effectiveLocales);
  details.externalFallbackSources = externalEntries.sources;
  info(
    externalEntries.sources.length > 0
      ? `external_fallback_sources=${externalEntries.sources.join(",")}`
      : "external_fallback_sources=none"
  );
  if (externalEntries.reservedEntries.size > 0) {
    pass(`reserved Magento/platform phrase keys available: ${externalEntries.reservedEntries.size}`);
  } else {
    info("reserved Magento/platform phrase keys available: 0");
  }

  for (const locale of effectiveLocales) {
    const count = externalEntries.localeEntries.get(locale)?.size ?? 0;
    if (count > 0) {
      pass(`${locale}: core fallback phrases available: ${count}`);
    } else {
      info(`${locale}: core fallback phrases available: 0`);
    }
  }

  for (const locale of effectiveLocales) {
    const parsed = localeCsvMaps.get(locale);
    if (!parsed || parsed.parseError || !parsed.exists) {
      continue;
    }

    const mismatches: Array<Record<string, unknown>> = [];
    const collisions: Array<Record<string, unknown>> = [];

    for (const [normalizedKey, entry] of parsed.entriesNorm.entries()) {
      const expected = placeholderTokens(entry.key);
      const actual = placeholderTokens(entry.value);
      if (!arraysEqual(expected, actual)) {
        const issue = {
          locale,
          key: entry.key,
          value: entry.value,
          line: entry.line,
          expected,
          actual
        };
        mismatches.push(issue);
        placeholderIssues.push(issue);
      }

      let coreEntry = externalEntries.localeEntries.get(locale)?.get(normalizedKey);
      let collisionScope = "locale";
      if (!coreEntry) {
        coreEntry = externalEntries.reservedEntries.get(normalizedKey);
        collisionScope = "global";
      }
      if (!coreEntry) {
        continue;
      }

      collisions.push({
        key: entry.key,
        moduleValue: entry.value,
        coreValue: coreEntry.value,
        sameValue: normalizeForMatch(entry.value) === normalizeForMatch(coreEntry.value),
        corePackage: coreEntry.package,
        corePath: coreEntry.path,
        collisionScope
      });
    }

    if (mismatches.length > 0) {
      (details.placeholderMismatches as Record<string, unknown>)[locale] = mismatches;
      fail(`${locale}: placeholder mismatches in ${mismatches.length} row(s)`);
    } else {
      pass(`${locale}: placeholder tokens match between key and value`);
    }

    if (collisions.length > 0) {
      (details.coreTranslationCollisions as Record<string, unknown>)[locale] = collisions;
      fail(`${locale}: module translations duplicate reserved Magento/platform phrase keys in ${collisions.length} key(s)`);
    }
  }

  const sourceExtensions = new Set(["php", "phtml", "xml", "js", "ts", "tsx", "html"]);
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

  pass(`scanned ${sourceFiles.length} source file(s) for translatable phrases`);
  pass(`collected ${sourcePhrases.size} unique phrase(s) from source files`);

  const baseLocale = effectiveLocales.includes("en_US") ? "en_US" : effectiveLocales[0];
  pass(`base locale: ${baseLocale}`);

  const baseEntries = localeCsvMaps.get(baseLocale)?.entriesNorm ?? new Map();
  const baseDependencyKeys = new Set(dependencyLocaleEntries.get(baseLocale)?.keys() ?? []);
  const baseCoreKeys = new Set(externalEntries.localeEntries.get(baseLocale)?.keys() ?? []);
  const reservedCoreKeys = new Set(externalEntries.reservedEntries.keys());

  const sourceMissing = Array.from(sourcePhrases)
    .filter((normalizedKey) => {
      return !baseEntries.has(normalizedKey)
        && !baseDependencyKeys.has(normalizedKey)
        && !baseCoreKeys.has(normalizedKey)
        && !reservedCoreKeys.has(normalizedKey)
        && !hasExcludedTerm(normalizedKey);
    })
    .sort();
  details.sourceMissing = sourceMissing;

  if (sourceMissing.length > 0) {
    const message = `${baseLocale}: source coverage missing ${sourceMissing.length} phrase(s)`;
    if (strictSource) {
      fail(message);
    } else {
      warn(message);
    }
    for (const phrase of sourceMissing) {
      missing.push({ locale: baseLocale, key: phrase, reason: "source_missing" });
    }
  } else {
    pass(`${baseLocale}: source coverage complete`);
  }

  const allNormalizedKeys = new Set<string>(sourcePhrases);
  for (const locale of effectiveLocales) {
    const parsed = localeCsvMaps.get(locale);
    if (!parsed || parsed.parseError || !parsed.exists) {
      continue;
    }
    for (const normalizedKey of parsed.entriesNorm.keys()) {
      allNormalizedKeys.add(normalizedKey);
    }
  }

  const missingEmpty: Array<Record<string, unknown>> = [];
  const untranslatedValues: Record<string, string[]> = {};

  for (const normalizedKey of Array.from(allNormalizedKeys).sort()) {
    if (hasExcludedTerm(normalizedKey)) {
      continue;
    }

    const displayKey = representativeKey(normalizedKey, sourcePhrases, effectiveLocales, localeCsvMaps);
    const missingLocales: string[] = [];
    const emptyLocales: string[] = [];

    for (const locale of effectiveLocales) {
      const parsed = localeCsvMaps.get(locale);
      if (!parsed || parsed.parseError || !parsed.exists) {
        continue;
      }

      const entry = parsed.entriesNorm.get(normalizedKey);
      const dependencyEntry = dependencyLocaleEntries.get(locale)?.get(normalizedKey);
      const coreEntry = externalEntries.localeEntries.get(locale)?.get(normalizedKey);
      const reservedCoreEntry = externalEntries.reservedEntries.get(normalizedKey);

      if (!entry) {
        if (!dependencyEntry && !coreEntry && !reservedCoreEntry) {
          missingLocales.push(locale);
        }
        continue;
      }

      if (!normalizeForMatch(entry.value)) {
        if (!dependencyEntry && !coreEntry && !reservedCoreEntry) {
          emptyLocales.push(locale);
        }
      }

      if (locale !== baseLocale && sourcePhrases.has(normalizedKey)) {
        if (normalizeForUntranslatedMatch(entry.value) === normalizeForUntranslatedMatch(displayKey)) {
          const fallbackValue = dependencyEntry?.value ?? coreEntry?.value;
          if (!fallbackValue && !externalEntries.reservedEntries.get(normalizedKey)) {
            untranslatedValues[locale] = untranslatedValues[locale] ?? [];
            untranslatedValues[locale].push(displayKey);
          }
        }
      }
    }

    if (missingLocales.length > 0 || emptyLocales.length > 0) {
      const item = {
        key: displayKey,
        normalizedKey,
        missingLocales,
        emptyLocales,
        inSource: sourcePhrases.has(normalizedKey)
      };
      missingEmpty.push(item);

      if (missingLocales.length > 0) {
        for (const locale of missingLocales) {
          missing.push({ locale, key: displayKey, reason: "missing_key" });
        }
      }
      if (emptyLocales.length > 0) {
        for (const locale of emptyLocales) {
          missing.push({ locale, key: displayKey, reason: "empty_value" });
        }
      }
    }
  }

  details.missingEmpty = missingEmpty;
  details.untranslatedValues = Object.fromEntries(
    Object.entries(untranslatedValues).map(([locale, values]) => [locale, Array.from(new Set(values)).sort()])
  );

  for (const [locale, values] of Object.entries(details.untranslatedValues as Record<string, string[]>)) {
    if (values.length > 0) {
      fail(`${locale}: untranslated values (same as source) in ${values.length} key(s)`);
    }
  }

  if (missingEmpty.length > 0) {
    fail(`missing/empty translations found for ${missingEmpty.length} key(s)`);
  } else {
    pass("no missing or empty translations across configured locales");
  }

  return {
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
    notes,
    details,
    messages
  };
}

export function registerTranslationCheckTool(server: McpServer): void {
  server.registerTool(
    "translation-check",
    {
      title: "Translation Check",
      description: "Run module translation QA checks (missing keys, placeholders, source coverage, core collisions, CSV format)",
      inputSchema: {
        moduleDir: z.string().describe("Module directory, e.g. app/code/Vendor/Module or vendor/vendor/module"),
        locales: z.array(z.string()).optional().describe("Optional locale override; when omitted the tool auto-detects locales from i18n/*.csv"),
        strictSource: z.boolean().default(true).describe("When false, source phrase coverage is downgraded from FAIL to WARN")
      }
    },
    async ({ moduleDir, locales, strictSource = true }) => {
      try {
        const payload = await runTranslationCheck({ moduleDir, locales, strictSource });
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          isError: !payload.okTranslations
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
