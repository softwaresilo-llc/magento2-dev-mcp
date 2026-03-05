#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exec, execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, relative, resolve, sep } from "path";
import { pathToFileURL } from "url";
import { executePhpScript } from "./php-executor.js";
import { formatPluginAnalysis } from "./plugin-list-formatter.js";
import { detectDockerEnvironment } from "./docker-env.js";
import { registerApiGetTokenTool } from "./tools/api-get-token.js";
import { registerApiCheckTool } from "./tools/api-check.js";
import { registerTranslationCheckTool } from "./tools/translation-check.js";
import { registerModuleIntegrationTestTool } from "./tools/module-integration-test.js";
import { registerCompatibilityCheckTool } from "./tools/compatibility-check.js";
import { registerCopyrightCheckTool } from "./tools/copyright-check.js";
import { registerReleaseCheckTool } from "./tools/release-check.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const magerunBin = process.env.MAGERUN2_COMMAND || 'magerun2';
const dockerEnv = detectDockerEnvironment(process.cwd());
const defaultMailpitBaseUrl = process.env.MAILPIT_BASE_URL || "https://mail.magento248.test";
const chromeBinaryOverride = process.env.MAIL_RENDER_CHROME_COMMAND || "";
const defaultMagentoBaseUrl = process.env.MAGENTO_BASE_URL || "https://magento248.test";

type MailProvider = "mailpit" | "imap" | "api";

interface MailCredentials {
  username?: string;
  password?: string;
  token?: string;
}

interface MailSourceConfig {
  provider: MailProvider;
  baseUrl: string;
  credentials?: MailCredentials;
  insecureTls: boolean;
}

interface MailQueryFilters {
  to?: string;
  subject?: string;
  contains?: string;
}

interface MailQueryConfig {
  messageId?: string;
  limit: number;
  fetchLimit: number;
  filters?: MailQueryFilters;
}

interface MailEvidenceConfig {
  renderImage: boolean;
  renderDir?: string;
  includeHtml: boolean;
  includeText: boolean;
  imageOutput: "path" | "base64";
  imageWidth: number;
  imageHeight: number;
}

interface MailpitPerson {
  Name?: string | null;
  Address?: string | null;
}

interface MailpitMessageSummary {
  ID: string;
  MessageID?: string | null;
  Subject?: string | null;
  Created?: string | null;
  Snippet?: string | null;
  From?: MailpitPerson | null;
  To?: MailpitPerson[] | null;
  Cc?: MailpitPerson[] | null;
  Bcc?: MailpitPerson[] | null;
  Size?: number | null;
}

interface MailpitMessageListResponse {
  total?: number;
  count?: number;
  messages?: MailpitMessageSummary[];
}

interface MailpitMessageDetails extends MailpitMessageSummary {
  Date?: string | null;
  Text?: string | null;
  HTML?: string | null;
}

interface WebapiRouteDescriptor {
  method: string;
  path: string;
  resources: string[];
  serviceMethod: string;
  expectedAuth: "anonymous_expected" | "acl_expected";
}

interface ResolvedSchema {
  type: string;
  required?: string[];
  properties?: Record<string, ResolvedSchema>;
  items?: ResolvedSchema;
}

/**
 * Magento 2 Development MCP Server
 * 
 * This server provides tools for Magento 2 development, including:
 * - DI preferences listing
 * - Future tools for module analysis, configuration inspection, etc.
 */

// Create the MCP server
const server = new McpServer({
  name: "magento2-dev-mcp-server",
  version: "1.0.0"
});

/**
 * Helper function to execute magerun2 commands with consistent error handling.
 * Accepts the subcommand (everything after the binary name, e.g. "cache:clean --all").
 * When a Docker environment is detected, commands are routed through the container
 * with a local fallback. The binary name can be configured via MAGERUN2_COMMAND env var.
 */
async function executeMagerun2Command(subcommand: string, parseJson: boolean = false): Promise<{
  success: true;
  data: any;
  rawOutput: string;
} | {
  success: false;
  error: string;
  isError: true;
}> {
  const fullCommand = `${magerunBin} ${subcommand}`;
  const commands: string[] = [];

  if (dockerEnv) {
    commands.push(...dockerEnv.wrapCommand(fullCommand));
  }
  commands.push(fullCommand); // local fallback always included

  const errors: string[] = [];

  for (const command of commands) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: process.cwd(),
        timeout: 30000 // 30 second timeout
      });

      if (stderr && stderr.trim()) {
        console.error("magerun2 stderr:", stderr);
      }

      if (parseJson) {
        try {
          return { success: true, data: JSON.parse(stdout), rawOutput: stdout };
        } catch (parseError) {
          return {
            success: false,
            error: `Error parsing magerun2 JSON output: ${parseError}\n\nRaw output:\n${stdout}`,
            isError: true
          };
        }
      }

      return { success: true, data: stdout.trim(), rawOutput: stdout };

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`magerun2 command failed: ${command}\n  ${msg}`);
      errors.push(`[${command}] ${msg}`);
      continue;
    }
  }

  // All commands failed — build a helpful error message
  const lastError = errors[errors.length - 1] ?? '';
  const allNotFound = errors.every(e =>
    e.includes("command not found") || e.includes("not recognized") || e.includes("No such file or directory")
  );

  if (allNotFound) {
    let msg = `Error: ${magerunBin} command not found.`;
    if (dockerEnv) {
      msg += `\n\nDocker environment detected (${dockerEnv.type}) but execution failed.\nEnsure the container is running and '${magerunBin}' is available inside it.`;
    } else {
      msg += `\n\nPlease ensure n98-magerun2 is installed and available in your PATH.`;
    }
    msg += `\n\nInstallation instructions: https://github.com/netz98/n98-magerun2`;
    msg += `\n\nDetails:\n${errors.join('\n')}`;
    return { success: false, error: msg, isError: true };
  }

  if (lastError.includes("not a Magento installation") || lastError.includes("app/etc/env.php")) {
    return {
      success: false,
      error: "Error: Current directory does not appear to be a Magento 2 installation. Please run this command from your Magento 2 root directory.",
      isError: true
    };
  }

  return {
    success: false,
    error: `Error executing magerun2 command.\n\nAttempts:\n${errors.join('\n')}`,
    isError: true
  };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function toLower(value: string | undefined | null): string {
  return (value ?? "").toLowerCase();
}

function personToAddress(person: MailpitPerson | null | undefined): string {
  if (!person) {
    return "";
  }
  return (person.Address ?? "").trim();
}

function peopleToAddresses(people: MailpitPerson[] | null | undefined): string[] {
  if (!Array.isArray(people)) {
    return [];
  }
  return people
    .map(personToAddress)
    .filter((address): address is string => address.length > 0);
}

function formatPerson(person: MailpitPerson | null | undefined): { name: string; address: string } {
  return {
    name: (person?.Name ?? "").trim(),
    address: (person?.Address ?? "").trim()
  };
}

function buildMailHeaders(credentials?: MailCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json"
  };

  if (credentials?.token) {
    headers.Authorization = `Bearer ${credentials.token}`;
    return headers;
  }

  if (credentials?.username || credentials?.password) {
    const authValue = Buffer.from(`${credentials?.username ?? ""}:${credentials?.password ?? ""}`).toString("base64");
    headers.Authorization = `Basic ${authValue}`;
  }

  return headers;
}

async function fetchMailpitJson<T>(
  baseUrl: string,
  apiPath: string,
  credentials?: MailCredentials,
  insecureTls: boolean = true
): Promise<T> {
  const previousTlsValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (insecureTls && normalizeBaseUrl(baseUrl).startsWith("https://")) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  let response: Response;
  try {
    response = await fetch(`${normalizeBaseUrl(baseUrl)}${apiPath}`, {
      method: "GET",
      headers: buildMailHeaders(credentials)
    });
  } finally {
    if (insecureTls && normalizeBaseUrl(baseUrl).startsWith("https://")) {
      if (previousTlsValue === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsValue;
      }
    }
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Mail source request failed (${response.status} ${response.statusText}) for ${apiPath}.\n${errorBody}`.trim()
    );
  }

  return await response.json() as T;
}

function messageMatchesFilters(message: MailpitMessageSummary, filters?: MailQueryFilters): boolean {
  if (!filters) {
    return true;
  }

  const subject = toLower(message.Subject);
  const snippet = toLower(message.Snippet);
  const recipientBlob = [
    ...peopleToAddresses(message.To),
    ...peopleToAddresses(message.Cc),
    ...peopleToAddresses(message.Bcc)
  ].join(" ").toLowerCase();

  if (filters.to && !recipientBlob.includes(toLower(filters.to))) {
    return false;
  }

  if (filters.subject && !subject.includes(toLower(filters.subject))) {
    return false;
  }

  if (filters.contains) {
    const needle = toLower(filters.contains);
    const contentBlob = `${subject} ${snippet} ${recipientBlob}`;
    if (!contentBlob.includes(needle)) {
      return false;
    }
  }

  return true;
}

async function detectChromeBinary(): Promise<string | null> {
  if (chromeBinaryOverride.trim().length > 0) {
    return chromeBinaryOverride.trim();
  }

  const candidates = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser"
  ];

  for (const candidate of candidates) {
    try {
      const { stdout } = await execAsync(`command -v ${candidate}`);
      const resolvedBinary = stdout.trim();
      if (resolvedBinary.length > 0) {
        return resolvedBinary;
      }
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

function resolveRenderDir(renderDir?: string): string {
  const defaultRelativeDir = join("tmp", "mail-inspect", "evidence", new Date().toISOString().slice(0, 10));
  const targetDir = renderDir && renderDir.trim().length > 0 ? renderDir : defaultRelativeDir;
  return resolve(process.cwd(), targetDir);
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function renderMailHtmlToImage(
  html: string,
  messageId: string,
  renderDir: string,
  width: number,
  height: number,
  imageOutput: "path" | "base64"
): Promise<{
  htmlPath: string;
  imagePath: string;
  mimeType: "image/png";
  base64?: string;
  chromeBinary: string;
}> {
  await mkdir(renderDir, { recursive: true });

  const safeId = sanitizeForFilename(messageId || "message");
  const timestamp = Date.now();
  const htmlPath = join(renderDir, `${safeId}-${timestamp}.html`);
  const imagePath = join(renderDir, `${safeId}-${timestamp}.png`);

  await writeFile(htmlPath, html, "utf8");

  const chromeBinary = await detectChromeBinary();
  if (!chromeBinary) {
    throw new Error(
      "Image rendering requested, but no Chrome/Chromium binary was found. " +
      "Set MAIL_RENDER_CHROME_COMMAND or install google-chrome/chromium."
    );
  }

  const htmlFileUrl = pathToFileURL(htmlPath).toString();
  const commonArgs = [
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--window-size=${width},${height}`,
    `--screenshot=${imagePath}`,
    htmlFileUrl
  ];

  try {
    await execFileAsync(chromeBinary, ["--headless=new", ...commonArgs], {
      cwd: process.cwd(),
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
    });
  } catch {
    await execFileAsync(chromeBinary, ["--headless", ...commonArgs], {
      cwd: process.cwd(),
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
    });
  }

  const artifact: {
    htmlPath: string;
    imagePath: string;
    mimeType: "image/png";
    base64?: string;
    chromeBinary: string;
  } = {
    htmlPath,
    imagePath,
    mimeType: "image/png",
    chromeBinary
  };

  if (imageOutput === "base64") {
    artifact.base64 = (await readFile(imagePath)).toString("base64");
  }

  return artifact;
}

async function fetchMailpitMessageByIdentifier(
  baseUrl: string,
  identifier: string,
  fetchLimit: number,
  credentials?: MailCredentials,
  insecureTls: boolean = true
): Promise<MailpitMessageDetails | null> {
  try {
    return await fetchMailpitJson<MailpitMessageDetails>(
      baseUrl,
      `/api/v1/message/${encodeURIComponent(identifier)}`,
      credentials,
      insecureTls
    );
  } catch {
    const list = await fetchMailpitJson<MailpitMessageListResponse>(
      baseUrl,
      `/api/v1/messages?limit=${fetchLimit}`,
      credentials,
      insecureTls
    );
    const matchedSummary = (list.messages ?? []).find(
      (message) => message.ID === identifier || message.MessageID === identifier
    );
    if (!matchedSummary?.ID) {
      return null;
    }
    return await fetchMailpitJson<MailpitMessageDetails>(
      baseUrl,
      `/api/v1/message/${encodeURIComponent(matchedSummary.ID)}`,
      credentials,
      insecureTls
    );
  }
}

function parseJsonFromOutput(output: string): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, data: JSON.parse(output) };
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON output: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModuleDirWithinProject(
  moduleDirInput: string,
  allowedPrefixes: string[] = ["app/code/", "vendor/"]
): {
  relativeModuleDir: string;
  absoluteModuleDir: string;
} {
  const projectRoot = resolve(process.cwd());
  const absoluteModuleDir = resolve(projectRoot, moduleDirInput);
  const relativeModuleDir = relative(projectRoot, absoluteModuleDir).replace(/\\/g, "/");
  const rootPrefix = projectRoot.endsWith(sep) ? projectRoot : `${projectRoot}${sep}`;

  if (absoluteModuleDir !== projectRoot && !absoluteModuleDir.startsWith(rootPrefix)) {
    throw new Error("moduleDir must be inside the current project root");
  }

  if (relativeModuleDir.startsWith("..")) {
    throw new Error("moduleDir must not point outside the current project root");
  }

  if (!allowedPrefixes.some((prefix) => relativeModuleDir.startsWith(prefix))) {
    throw new Error(`moduleDir must start with one of: ${allowedPrefixes.join(", ")}`);
  }

  if (!existsSync(absoluteModuleDir)) {
    throw new Error(`moduleDir does not exist: ${relativeModuleDir}`);
  }

  return {
    relativeModuleDir,
    absoluteModuleDir
  };
}

function normalizeModuleDirForApiTools(moduleDirInput: string): {
  relativeModuleDir: string;
  absoluteModuleDir: string;
  absoluteWebapiFile: string;
} {
  const normalized = normalizeModuleDirWithinProject(moduleDirInput);
  const { relativeModuleDir, absoluteModuleDir } = normalized;

  const absoluteWebapiFile = join(absoluteModuleDir, "etc", "webapi.xml");
  if (!existsSync(absoluteWebapiFile)) {
    throw new Error(`webapi.xml not found in moduleDir: ${relativeModuleDir}/etc/webapi.xml`);
  }

  return {
    relativeModuleDir,
    absoluteModuleDir,
    absoluteWebapiFile
  };
}

function normalizeRoutePath(rawPath: string): string {
  return rawPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

function normalizePathPrefix(pathPrefix: string): string {
  if (!pathPrefix.startsWith("/")) {
    return `/${pathPrefix}`;
  }
  return pathPrefix;
}

function parseRouteAttributes(routeTagAttributes: string): Record<string, string> {
  const result: Record<string, string> = {};
  const attributeRegex = /([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attributeRegex.exec(routeTagAttributes)) !== null) {
    result[match[1]] = match[2];
  }
  return result;
}

function parseWebapiRoutesFromXml(xmlContent: string): WebapiRouteDescriptor[] {
  const routes: WebapiRouteDescriptor[] = [];
  const routeRegex = /<route\b([^>]*)>([\s\S]*?)<\/route>/g;
  let match: RegExpExecArray | null;

  while ((match = routeRegex.exec(xmlContent)) !== null) {
    const routeAttributes = parseRouteAttributes(match[1]);
    const routeBody = match[2] ?? "";
    const rawPath = (routeAttributes.url ?? "").trim();
    const rawMethod = (routeAttributes.method ?? "").trim().toUpperCase();
    if (!rawPath || !rawMethod) {
      continue;
    }

    const resources: string[] = [];
    const resourceRegex = /<resource\b[^>]*\bref="([^"]+)"/g;
    let resourceMatch: RegExpExecArray | null;
    while ((resourceMatch = resourceRegex.exec(routeBody)) !== null) {
      const ref = (resourceMatch[1] ?? "").trim();
      if (ref) {
        resources.push(ref);
      }
    }

    const serviceMethodMatch = routeBody.match(/<service\b[^>]*\bmethod="([^"]+)"/);
    const serviceMethod = (serviceMethodMatch?.[1] ?? "").trim();
    const expectedAuth: "anonymous_expected" | "acl_expected" =
      resources.length === 1 && resources[0] === "anonymous" ? "anonymous_expected" : "acl_expected";

    routes.push({
      method: rawMethod,
      path: normalizeRoutePath(rawPath),
      resources,
      serviceMethod,
      expectedAuth
    });
  }

  return routes;
}

async function readModuleWebapiRoutes(moduleAbsoluteDir: string): Promise<WebapiRouteDescriptor[]> {
  const webapiPath = join(moduleAbsoluteDir, "etc", "webapi.xml");
  const xmlContent = await readFile(webapiPath, "utf8");
  return parseWebapiRoutesFromXml(xmlContent);
}

async function withTemporaryInsecureTls<T>(insecureTls: boolean, fn: () => Promise<T>): Promise<T> {
  const previousTlsValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (insecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  try {
    return await fn();
  } finally {
    if (insecureTls) {
      if (previousTlsValue === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsValue;
      }
    }
  }
}

async function fetchJsonFromUrl(url: string, headers: Record<string, string>, insecureTls: boolean): Promise<unknown> {
  return await withTemporaryInsecureTls(insecureTls, async () => {
    const response = await fetch(url, {
      method: "GET",
      headers
    });

    const responseText = await response.text();
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(responseText);
    } catch {
      parsedBody = responseText;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${typeof parsedBody === "string" ? parsedBody : JSON.stringify(parsedBody)}`);
    }

    return parsedBody;
  });
}

function getSchemaPaths(schemaDoc: unknown): Record<string, unknown> {
  if (!isRecord(schemaDoc) || !isRecord(schemaDoc.paths)) {
    return {};
  }
  return schemaDoc.paths;
}

function getSchemaDefinitions(schemaDoc: unknown): Record<string, unknown> {
  if (!isRecord(schemaDoc)) {
    return {};
  }
  if (isRecord(schemaDoc.definitions)) {
    return schemaDoc.definitions;
  }
  if (isRecord(schemaDoc.components) && isRecord(schemaDoc.components.schemas)) {
    return schemaDoc.components.schemas;
  }
  return {};
}

function resolveSchemaObject(schemaNode: unknown, definitions: Record<string, unknown>, depth: number = 0): ResolvedSchema {
  if (depth > 10 || !isRecord(schemaNode)) {
    return { type: "string" };
  }

  if (typeof schemaNode.$ref === "string" && schemaNode.$ref.length > 0) {
    const refKey = schemaNode.$ref.split("/").pop() ?? "";
    const referenced = definitions[refKey];
    if (isRecord(referenced)) {
      return resolveSchemaObject(referenced, definitions, depth + 1);
    }
    return { type: "object" };
  }

  const typeValue = typeof schemaNode.type === "string" ? schemaNode.type : "";

  if (typeValue === "array") {
    return {
      type: "array",
      items: resolveSchemaObject(schemaNode.items, definitions, depth + 1)
    };
  }

  if (typeValue === "object" || isRecord(schemaNode.properties)) {
    const required = Array.isArray(schemaNode.required)
      ? schemaNode.required.filter((item): item is string => typeof item === "string")
      : [];
    const properties: Record<string, ResolvedSchema> = {};

    const rawProps = isRecord(schemaNode.properties) ? schemaNode.properties : {};
    for (const [propertyName, propertySchema] of Object.entries(rawProps)) {
      properties[propertyName] = resolveSchemaObject(propertySchema, definitions, depth + 1);
    }

    return {
      type: "object",
      required,
      properties
    };
  }

  return {
    type: typeValue || "string"
  };
}

function sampleForResolvedSchema(schema: ResolvedSchema): unknown {
  if (schema.type === "object") {
    const payload: Record<string, unknown> = {};
    for (const fieldName of schema.required ?? []) {
      const childSchema = schema.properties?.[fieldName] ?? { type: "string" };
      payload[fieldName] = sampleForResolvedSchema(childSchema);
    }
    return payload;
  }

  if (schema.type === "array") {
    return [sampleForResolvedSchema(schema.items ?? { type: "string" })];
  }

  if (schema.type === "integer") {
    return 1;
  }

  if (schema.type === "number") {
    return 1.0;
  }

  if (schema.type === "boolean") {
    return true;
  }

  return "string";
}

function getSchemaEndpointOperation(
  schemaPaths: Record<string, unknown>,
  routePath: string,
  routeMethod: string
): Record<string, unknown> | null {
  const methodKey = routeMethod.toLowerCase();

  if (isRecord(schemaPaths[routePath]) && isRecord(schemaPaths[routePath][methodKey])) {
    return schemaPaths[routePath][methodKey] as Record<string, unknown>;
  }

  const normalizedTarget = normalizeRoutePath(routePath);
  for (const [pathKey, pathValue] of Object.entries(schemaPaths)) {
    if (!isRecord(pathValue)) {
      continue;
    }
    if (normalizeRoutePath(pathKey) !== normalizedTarget) {
      continue;
    }
    if (isRecord(pathValue[methodKey])) {
      return pathValue[methodKey] as Record<string, unknown>;
    }
  }

  return null;
}

function extractBodySchemaFromOperation(
  operation: Record<string, unknown>,
  definitions: Record<string, unknown>
): ResolvedSchema | null {
  if (Array.isArray(operation.parameters)) {
    for (const parameter of operation.parameters) {
      if (!isRecord(parameter)) {
        continue;
      }
      if (parameter.in === "body") {
        return resolveSchemaObject(parameter.schema, definitions);
      }
    }
  }

  if (isRecord(operation.requestBody) && isRecord(operation.requestBody.content)) {
    const content = operation.requestBody.content;
    const preferred = isRecord(content["application/json"]) ? content["application/json"] : null;
    const firstContentEntry = preferred ?? Object.values(content).find((value) => isRecord(value));
    if (isRecord(firstContentEntry) && isRecord(firstContentEntry.schema)) {
      return resolveSchemaObject(firstContentEntry.schema, definitions);
    }
  }

  return null;
}

function buildEndpointContract(
  route: WebapiRouteDescriptor,
  operation: Record<string, unknown> | null,
  definitions: Record<string, unknown>
): Record<string, unknown> {
  if (!operation) {
    return {
      method: route.method,
      path: route.path,
      missingInSchema: true,
      operationId: "",
      has401Response: false,
      pathParams: [],
      queryParams: [],
      resources: route.resources,
      expectedAuth: route.expectedAuth,
      body: {
        hasBody: false,
        requiredFields: [],
        optionalFields: []
      },
      sampleRequestBody: null
    };
  }

  const parameters = Array.isArray(operation.parameters) ? operation.parameters.filter(isRecord) : [];
  const pathParams = parameters
    .filter((parameter) => parameter.in === "path")
    .map((parameter) => ({
      name: String(parameter.name ?? ""),
      type: String(parameter.type ?? "string"),
      required: Boolean(parameter.required ?? true)
    }));
  const queryParams = parameters
    .filter((parameter) => parameter.in === "query")
    .map((parameter) => ({
      name: String(parameter.name ?? ""),
      type: String(parameter.type ?? "string"),
      required: Boolean(parameter.required ?? false)
    }));

  const responses = isRecord(operation.responses) ? operation.responses : {};
  const has401Response = Object.prototype.hasOwnProperty.call(responses, "401");
  const bodySchema = extractBodySchemaFromOperation(operation, definitions);
  const requiredFields = bodySchema?.type === "object" ? (bodySchema.required ?? []) : [];
  const optionalFields = bodySchema?.type === "object" && bodySchema.properties
    ? Object.keys(bodySchema.properties).filter((field) => !requiredFields.includes(field))
    : [];

  return {
    method: route.method,
    path: route.path,
    missingInSchema: false,
    operationId: String(operation.operationId ?? ""),
    has401Response,
    pathParams,
    queryParams,
    resources: route.resources,
    expectedAuth: route.expectedAuth,
    body: {
      hasBody: bodySchema !== null,
      requiredFields,
      optionalFields
    },
    sampleRequestBody: bodySchema ? sampleForResolvedSchema(bodySchema) : null
  };
}

function buildMarkdownContract(contractPayload: Record<string, unknown>): string {
  const generatedAt = String(contractPayload.generated_at ?? "");
  const source = isRecord(contractPayload.source) ? contractPayload.source : {};
  const endpoints = Array.isArray(contractPayload.endpoints) ? contractPayload.endpoints : [];

  const lines: string[] = [];
  lines.push("# REST API Contract");
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push("");
  lines.push(`Source schema: \`${String(source.schema_url ?? "n/a")}\``);
  lines.push("");
  lines.push(`Schema auth: \`${String(source.schema_auth ?? "none")}\``);
  lines.push("");

  for (const endpointEntry of endpoints) {
    const endpoint = isRecord(endpointEntry) ? endpointEntry : {};
    const method = String(endpoint.method ?? "");
    const path = String(endpoint.path ?? "");
    lines.push(`## \`${method} ${path}\``);
    lines.push(`- Missing in schema: ${Boolean(endpoint.missingInSchema) ? "yes" : "no"}`);
    lines.push(`- Auth hint: ${Boolean(endpoint.has401Response) ? "token/authorization expected" : "no explicit 401 in schema"}`);
    const pathParams = Array.isArray(endpoint.pathParams) ? endpoint.pathParams : [];
    const queryParams = Array.isArray(endpoint.queryParams) ? endpoint.queryParams : [];
    lines.push(`- Path params: ${pathParams.length > 0 ? pathParams.map((param) => `\`${String((isRecord(param) ? param.name : "") ?? "")}\``).join(", ") : "none"}`);
    lines.push(`- Query params: ${queryParams.length > 0 ? queryParams.map((param) => `\`${String((isRecord(param) ? param.name : "") ?? "")}\``).join(", ") : "none"}`);
    const body = isRecord(endpoint.body) ? endpoint.body : {};
    const requiredFields = Array.isArray(body.requiredFields) ? body.requiredFields : [];
    const optionalFields = Array.isArray(body.optionalFields) ? body.optionalFields : [];
    lines.push(`- Required body fields: ${requiredFields.length > 0 ? requiredFields.map((field) => `\`${String(field)}\``).join(", ") : "none"}`);
    lines.push(`- Optional body fields: ${optionalFields.length > 0 ? optionalFields.map((field) => `\`${String(field)}\``).join(", ") : "none"}`);
    if (endpoint.sampleRequestBody !== null && endpoint.sampleRequestBody !== undefined) {
      lines.push("");
      lines.push("Example request body:");
      lines.push("```json");
      lines.push(JSON.stringify(endpoint.sampleRequestBody));
      lines.push("```");
    }
    lines.push("");
  }

  return lines.join("\n");
}

function truncateOutput(value: string, maxChars: number = 12000): string {
  if (value.length <= maxChars) {
    return value;
  }
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n... [truncated ${omitted} chars]`;
}

function parsePassWarnFailCounts(textOutput: string): { passes: number; warnings: number; failures: number } {
  const lines = textOutput.split(/\r?\n/);
  let passes = 0;
  let warnings = 0;
  let failures = 0;

  for (const line of lines) {
    if (line.startsWith("PASS:")) {
      passes += 1;
    } else if (line.startsWith("WARN:")) {
      warnings += 1;
    } else if (line.startsWith("FAIL:")) {
      failures += 1;
    }
  }

  return { passes, warnings, failures };
}

function parsePhpunitStats(output: string): { testsRun: number | null; failures: number } {
  const summaryLine = output.match(/Tests:\s*([0-9]+)[^\n]*/m)?.[0] ?? "";
  if (summaryLine) {
    const testsRun = Number(summaryLine.match(/Tests:\s*([0-9]+)/)?.[1] ?? NaN);
    const failures = Number(summaryLine.match(/Failures:\s*([0-9]+)/)?.[1] ?? 0);
    const errors = Number(summaryLine.match(/Errors:\s*([0-9]+)/)?.[1] ?? 0);
    return {
      testsRun: Number.isFinite(testsRun) ? testsRun : null,
      failures: failures + errors
    };
  }

  const okMatch = output.match(/OK\s+\(([0-9]+)\s+tests?/i);
  if (okMatch) {
    const testsRun = Number(okMatch[1]);
    return {
      testsRun: Number.isFinite(testsRun) ? testsRun : null,
      failures: 0
    };
  }

  return {
    testsRun: null,
    failures: output.includes("FAILURES!") ? 1 : 0
  };
}

function parseCsvTwoColumns(content: string): Array<{ key: string; value: string; line: number }> {
  const rows: Array<{ key: string; value: string; line: number }> = [];
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

async function listFilesRecursively(
  rootDir: string,
  allowedExtensions: Set<string>
): Promise<string[]> {
  const queue = [rootDir];
  const files: string[] = [];

  while (queue.length > 0) {
    const currentDir = queue.shift() as string;
    try {
      const entries = await import("fs/promises").then((fs) =>
        fs.readdir(currentDir, { withFileTypes: true, encoding: "utf8" })
      );
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
  const regex = /__\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[2] ?? "";
    const phrase = raw
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .trim();
    if (phrase.length > 0) {
      phrases.add(phrase);
    }
  }
  return Array.from(phrases);
}

type CompatibilityVersionResult = {
  ok: boolean;
  issues: number;
  notes: string[];
};

function parseVersionParts(version: string): { major: number; minor: number; patch: number; p: number } | null {
  const normalized = version.trim().replace(/^v/i, "");
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-p(\d+))?/i);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    p: Number(match[4] ?? 0)
  };
}

function compareMagentoVersions(left: string, right: string): number {
  const l = parseVersionParts(left);
  const r = parseVersionParts(right);
  if (!l || !r) {
    return left.localeCompare(right);
  }
  if (l.major !== r.major) return l.major - r.major;
  if (l.minor !== r.minor) return l.minor - r.minor;
  if (l.patch !== r.patch) return l.patch - r.patch;
  return l.p - r.p;
}

function evaluateSingleConstraint(version: string, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed || trimmed === "*" || trimmed.toLowerCase() === "x") {
    return true;
  }
  if (trimmed.includes("*") || trimmed.toLowerCase().includes("x")) {
    const prefix = trimmed
      .replace(/\*/g, "")
      .replace(/x/gi, "")
      .replace(/\.$/, "");
    return version.startsWith(prefix);
  }
  if (trimmed.startsWith("^")) {
    const base = trimmed.slice(1);
    const parts = parseVersionParts(base);
    if (!parts) {
      return true;
    }
    const lowerOk = compareMagentoVersions(version, `${parts.major}.${parts.minor}.${parts.patch}-p${parts.p}`) >= 0;
    const upperOk = compareMagentoVersions(version, `${parts.major + 1}.0.0`) < 0;
    return lowerOk && upperOk;
  }
  if (trimmed.startsWith("~")) {
    const base = trimmed.slice(1);
    const parts = parseVersionParts(base);
    if (!parts) {
      return true;
    }
    const lowerOk = compareMagentoVersions(version, `${parts.major}.${parts.minor}.${parts.patch}-p${parts.p}`) >= 0;
    const upperOk = compareMagentoVersions(version, `${parts.major}.${parts.minor + 1}.0`) < 0;
    return lowerOk && upperOk;
  }

  const comparatorMatch = trimmed.match(/^(>=|<=|>|<|==|=|!=)\s*(.+)$/);
  if (comparatorMatch) {
    const operator = comparatorMatch[1];
    const target = comparatorMatch[2].trim();
    const cmp = compareMagentoVersions(version, target);
    switch (operator) {
      case ">=": return cmp >= 0;
      case "<=": return cmp <= 0;
      case ">": return cmp > 0;
      case "<": return cmp < 0;
      case "!=": return cmp !== 0;
      case "=":
      case "==":
      default:
        return cmp === 0;
    }
  }

  return compareMagentoVersions(version, trimmed) === 0;
}

function evaluateConstraintExpression(version: string, expression: string): boolean {
  const groups = expression.split("||").map((group) => group.trim()).filter(Boolean);
  if (groups.length === 0) {
    return true;
  }
  return groups.some((group) => {
    const tokens = group.split(/[\s,]+/).map((token) => token.trim()).filter(Boolean);
    if (tokens.length === 0) {
      return true;
    }
    return tokens.every((token) => evaluateSingleConstraint(version, token));
  });
}

/**
 * Tool: Get DI Preferences List
 *
 * Runs `magerun2 dev:di:preferences:list --format=json global` to get
 * dependency injection preferences in JSON format
 */
server.registerTool(
  "get-di-preferences",
  {
    title: "Get DI Preferences List",
    description: "Get Magento 2 dependency injection preferences list using magerun2",
    inputSchema: {
      scope: z.enum([
        "global",
        "adminhtml",
        "frontend",
        "crontab",
        "webapi_rest",
        "webapi_soap",
        "graphql",
        "doc",
        "admin"
      ])
        .default("global")
        .describe("The scope to get DI preferences for")
    }
  },
  async ({ scope = "global" }) => {
    const command = `dev:di:preferences:list --format=json ${scope}`;
    const result = await executeMagerun2Command(command, true);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    const preferenceCount = Array.isArray(result.data) ? result.data.length : Object.keys(result.data).length;

    return {
      content: [{
        type: "text",
        text: `Found ${preferenceCount} DI preferences for scope '${scope}':\n\n${JSON.stringify(result.data, null, 2)}`
      }]
    };
  }
);

/**
 * Tool: Cache Clean
 *
 * Runs `magerun2 cache:clean` to clear specific or all caches
 */
server.registerTool(
  "cache-clean",
  {
    title: "Cache Clean",
    description: "Clear specific Magento 2 cache types or all caches",
    inputSchema: {
      types: z.array(z.string())
        .optional()
        .describe("Specific cache types to clean (leave empty for all caches)")
    }
  },
  async ({ types }) => {
    const cacheTypesArg = types && types.length > 0 ? types.join(' ') : '';
    const command = `cache:clean ${cacheTypesArg}`.trim();
    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: `Cache clean completed:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Cache Flush
 *
 * Runs `magerun2 cache:flush` to flush specific or all caches
 */
server.registerTool(
  "cache-flush",
  {
    title: "Cache Flush",
    description: "Flush specific Magento 2 cache types or all caches",
    inputSchema: {
      types: z.array(z.string())
        .optional()
        .describe("Specific cache types to flush (leave empty for all caches)")
    }
  },
  async ({ types }) => {
    const cacheTypesArg = types && types.length > 0 ? types.join(' ') : '';
    const command = `cache:flush ${cacheTypesArg}`.trim();
    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: result.isError
      };
    }

    return {
      content: [{
        type: "text",
        text: `Cache flush completed:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Cache Enable
 *
 * Runs `magerun2 cache:enable` to enable specific cache types
 */
server.registerTool(
  "cache-enable",
  {
    title: "Cache Enable",
    description: "Enable specific Magento 2 cache types",
    inputSchema: {
      types: z.array(z.string())
        .min(1)
        .describe("Cache types to enable")
    }
  },
  async ({ types }) => {
    const command = `cache:enable ${types.join(' ')}`;
    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: result.isError
      };
    }

    return {
      content: [{
        type: "text",
        text: `Cache types enabled:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Cache Disable
 *
 * Runs `magerun2 cache:disable` to disable specific cache types
 */
server.registerTool(
  "cache-disable",
  {
    title: "Cache Disable",
    description: "Disable specific Magento 2 cache types",
    inputSchema: {
      types: z.array(z.string())
        .min(1)
        .describe("Cache types to disable")
    }
  },
  async ({ types }) => {
    const command = `cache:disable ${types.join(' ')}`;
    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: result.isError
      };
    }

    return {
      content: [{
        type: "text",
        text: `Cache types disabled:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Cache Status
 *
 * Runs `magerun2 cache:status` to check cache status
 */
server.registerTool(
  "cache-status",
  {
    title: "Cache Status",
    description: "Check the status of Magento 2 cache types",
    inputSchema: {}
  },
  async () => {
    const command = `cache:status`;
    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: result.isError
      };
    }

    return {
      content: [{
        type: "text",
        text: `Cache status:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Cache View
 *
 * Runs `magerun2 cache:view` to inspect cache entries
 */
server.registerTool(
  "cache-view",
  {
    title: "Cache View",
    description: "Inspect specific cache entries in Magento 2",
    inputSchema: {
      key: z.string()
        .describe("Cache key to inspect"),
      type: z.string()
        .optional()
        .describe("Cache type (optional)")
    }
  },
  async ({ key, type }) => {
    const typeArg = type ? `--type=${type}` : '';
    const command = `cache:view ${typeArg} "${key}"`.trim();
    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: result.isError
      };
    }

    return {
      content: [{
        type: "text",
        text: `Cache entry for key "${key}":\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Module List
 *
 * Runs `magerun2 dev:module:list` to list all modules
 */
server.registerTool(
  "dev-module-list",
  {
    title: "Module List",
    description: "List all Magento 2 modules and their status",
    inputSchema: {
      format: z.enum(["table", "json", "csv"])
        .default("table")
        .describe("Output format"),
      enabled: z.boolean()
        .optional()
        .describe("Show only enabled modules"),
      disabled: z.boolean()
        .optional()
        .describe("Show only disabled modules")
    }
  },
  async ({ format = "table", enabled, disabled }) => {
    let command = `dev:module:list --format=${format}`;

    if (enabled) {
      command += ' --only-enabled';
    } else if (disabled) {
      command += ' --only-disabled';
    }

    const result = await executeMagerun2Command(command, format === "json");

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    const responseText = format === "json"
      ? `Module list (${format} format):\n\n${JSON.stringify(result.data, null, 2)}`
      : `Module list (${format} format):\n\n${result.data}`;

    return {
      content: [{
        type: "text",
        text: responseText
      }]
    };
  }
);

/**
 * Tool: Module Observer List
 *
 * Runs `magerun2 dev:module:observer:list` to list module observers
 */
server.registerTool(
  "dev-module-observer-list",
  {
    title: "Module Observer List",
    description: "List all Magento 2 module observers",
    inputSchema: {
      format: z.enum(["table", "json", "csv"])
        .default("table")
        .describe("Output format"),
      event: z.string()
        .optional()
        .describe("Filter by specific event name")
    }
  },
  async ({ format = "table", event }) => {
    let command = `dev:module:observer:list --format=${format}`;

    if (event) {
      command += ` "${event}"`;
    }

    const result = await executeMagerun2Command(command, format === "json");

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    const responseText = format === "json"
      ? `Observer list (${format} format):\n\n${JSON.stringify(result.data, null, 2)}`
      : `Observer list (${format} format):\n\n${result.data}`;

    return {
      content: [{
        type: "text",
        text: responseText
      }]
    };
  }
);

/**
 * Tool: Module Create
 *
 * Runs `magerun2 dev:module:create` to create and register a new Magento module
 */
server.registerTool(
  "dev-module-create",
  {
    title: "Module Create",
    description: "Create and register a new Magento 2 module",
    inputSchema: {
      vendorNamespace: z.string()
        .describe("Namespace (your company prefix)"),
      moduleName: z.string()
        .describe("Name of your module"),
      minimal: z.boolean()
        .optional()
        .describe("Create only module file"),
      addBlocks: z.boolean()
        .optional()
        .describe("Add blocks"),
      addHelpers: z.boolean()
        .optional()
        .describe("Add helpers"),
      addModels: z.boolean()
        .optional()
        .describe("Add models"),
      addSetup: z.boolean()
        .optional()
        .describe("Add SQL setup"),
      addAll: z.boolean()
        .optional()
        .describe("Add blocks, helpers and models"),
      enable: z.boolean()
        .optional()
        .describe("Enable module after creation"),
      modman: z.boolean()
        .optional()
        .describe("Create all files in folder with a modman file"),
      addReadme: z.boolean()
        .optional()
        .describe("Add a readme.md file to generated module"),
      addComposer: z.boolean()
        .optional()
        .describe("Add a composer.json file to generated module"),
      addStrictTypes: z.boolean()
        .optional()
        .describe("Add strict_types declaration to generated PHP files"),
      authorName: z.string()
        .optional()
        .describe("Author for readme.md or composer.json"),
      authorEmail: z.string()
        .optional()
        .describe("Author email for readme.md or composer.json"),
      description: z.string()
        .optional()
        .describe("Description for readme.md or composer.json")
    }
  },
  async ({
    vendorNamespace,
    moduleName,
    minimal,
    addBlocks,
    addHelpers,
    addModels,
    addSetup,
    addAll,
    enable,
    modman,
    addReadme,
    addComposer,
    addStrictTypes,
    authorName,
    authorEmail,
    description
  }) => {
    let command = `dev:module:create "${vendorNamespace}" "${moduleName}"`;

    if (minimal) {
      command += ` --minimal`;
    }

    if (addBlocks) {
      command += ` --add-blocks`;
    }

    if (addHelpers) {
      command += ` --add-helpers`;
    }

    if (addModels) {
      command += ` --add-models`;
    }

    if (addSetup) {
      command += ` --add-setup`;
    }

    if (addAll) {
      command += ` --add-all`;
    }

    if (enable) {
      command += ` --enable`;
    }

    if (modman) {
      command += ` --modman`;
    }

    if (addReadme) {
      command += ` --add-readme`;
    }

    if (addComposer) {
      command += ` --add-composer`;
    }

    if (addStrictTypes) {
      command += ` --add-strict-types`;
    }

    if (authorName) {
      command += ` --author-name="${authorName}"`;
    }

    if (authorEmail) {
      command += ` --author-email="${authorEmail}"`;
    }

    if (description) {
      command += ` --description="${description}"`;
    }

    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: `Module ${vendorNamespace}_${moduleName} created successfully:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: System Info
 *
 * Runs `magerun2 sys:info` to get system information
 */
server.registerTool(
  "sys-info",
  {
    title: "System Info",
    description: "Get Magento 2 system information",
    inputSchema: {
      format: z.enum(["table", "json", "csv"])
        .default("table")
        .describe("Output format")
    }
  },
  async ({ format = "table" }) => {
    const command = `sys:info --format=${format}`;
    const result = await executeMagerun2Command(command, format === "json");

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    const responseText = format === "json"
      ? `System information (${format} format):\n\n${JSON.stringify(result.data, null, 2)}`
      : `System information (${format} format):\n\n${result.data}`;

    return {
      content: [{
        type: "text",
        text: responseText
      }]
    };
  }
);

/**
 * Tool: System Check
 *
 * Runs `magerun2 sys:check` to check system requirements
 */
server.registerTool(
  "sys-check",
  {
    title: "System Check",
    description: "Check Magento 2 system requirements and configuration",
    inputSchema: {}
  },
  async () => {
    const command = `sys:check`;
    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: `System check results:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Config Show
 *
 * Runs `magerun2 config:show` to view system configuration
 */
server.registerTool(
  "config-show",
  {
    title: "Config Show",
    description: "View Magento 2 system configuration values",
    inputSchema: {
      path: z.string()
        .optional()
        .describe("Configuration path to show (optional, shows all if not specified)"),
      scope: z.string()
        .optional()
        .describe("Configuration scope (default, website, store)"),
      scopeId: z.string()
        .optional()
        .describe("Scope ID (website ID or store ID)")
    }
  },
  async ({ path, scope, scopeId }) => {
    let command = `config:show`;

    if (path) {
      command += ` "${path}"`;
    }

    if (scope) {
      command += ` --scope="${scope}"`;
    }

    if (scopeId) {
      command += ` --scope-id="${scopeId}"`;
    }

    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: `Configuration values:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Config Set
 *
 * Runs `magerun2 config:set` to modify system configuration
 */
server.registerTool(
  "config-set",
  {
    title: "Config Set",
    description: "Set Magento 2 system configuration values",
    inputSchema: {
      path: z.string()
        .describe("Configuration path to set"),
      value: z.string()
        .describe("Value to set"),
      scope: z.string()
        .optional()
        .describe("Configuration scope (default, website, store)"),
      scopeId: z.string()
        .optional()
        .describe("Scope ID (website ID or store ID)"),
      encrypt: z.boolean()
        .optional()
        .describe("Encrypt the value")
    }
  },
  async ({ path, value, scope, scopeId, encrypt }) => {
    let command = `config:set "${path}" "${value}"`;

    if (scope) {
      command += ` --scope="${scope}"`;
    }

    if (scopeId) {
      command += ` --scope-id="${scopeId}"`;
    }

    if (encrypt) {
      command += ` --encrypt`;
    }

    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: `Configuration set successfully:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Config Store Get
 *
 * Runs `magerun2 config:store:get` to get store-specific configuration
 */
server.registerTool(
  "config-store-get",
  {
    title: "Config Store Get",
    description: "Get store-specific Magento 2 configuration values",
    inputSchema: {
      path: z.string()
        .describe("Configuration path to get"),
      storeId: z.string()
        .optional()
        .describe("Store ID (optional)")
    }
  },
  async ({ path, storeId }) => {
    let command = `config:store:get "${path}"`;

    if (storeId) {
      command += ` --store-id="${storeId}"`;
    }

    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: `Store configuration value:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Config Store Set
 *
 * Runs `magerun2 config:store:set` to set store-specific configuration
 */
server.registerTool(
  "config-store-set",
  {
    title: "Config Store Set",
    description: "Set store-specific Magento 2 configuration values",
    inputSchema: {
      path: z.string()
        .describe("Configuration path to set"),
      value: z.string()
        .describe("Value to set"),
      storeId: z.string()
        .optional()
        .describe("Store ID (optional)")
    }
  },
  async ({ path, value, storeId }) => {
    let command = `config:store:set "${path}" "${value}"`;

    if (storeId) {
      command += ` --store-id="${storeId}"`;
    }

    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: `Store configuration set successfully:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Database Query
 *
 * Runs `magerun2 db:query` to execute SQL queries
 */
server.registerTool(
  "db-query",
  {
    title: "Database Query",
    description: "Execute SQL queries directly on Magento 2 database",
    inputSchema: {
      query: z.string()
        .describe("SQL query to execute"),
      format: z.enum(["table", "json", "csv"])
        .default("table")
        .describe("Output format")
    }
  },
  async ({ query, format = "table" }) => {
    const command = `db:query --format=${format} "${query}"`;
    const result = await executeMagerun2Command(command, format === "json");

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    const responseText = format === "json"
      ? `Query results (${format} format):\n\n${JSON.stringify(result.data, null, 2)}`
      : `Query results (${format} format):\n\n${result.data}`;

    return {
      content: [{
        type: "text",
        text: responseText
      }]
    };
  }
);

/**
 * Tool: Setup Upgrade
 *
 * Runs `magerun2 setup:upgrade` to upgrade database schema and data
 */
server.registerTool(
  "setup-upgrade",
  {
    title: "Setup Upgrade",
    description: "Run Magento 2 setup upgrade to update database schema and data",
    inputSchema: {
      keepGenerated: z.boolean()
        .optional()
        .describe("Keep generated files during upgrade")
    }
  },
  async ({ keepGenerated }) => {
    let command = `setup:upgrade`;

    if (keepGenerated) {
      command += ` --keep-generated`;
    }

    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: `Setup upgrade completed:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Setup DI Compile
 *
 * Runs `magerun2 setup:di:compile` to compile dependency injection
 */
server.registerTool(
  "setup-di-compile",
  {
    title: "Setup DI Compile",
    description: "Compile Magento 2 dependency injection configuration",
    inputSchema: {}
  },
  async () => {
    const command = `setup:di:compile`;
    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: `DI compilation completed:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Setup DB Status
 *
 * Runs `magerun2 setup:db:status` to check database status
 */
server.registerTool(
  "setup-db-status",
  {
    title: "Setup DB Status",
    description: "Check Magento 2 database status to see if setup:upgrade is needed",
    inputSchema: {}
  },
  async () => {
    const command = `setup:db:status`;
    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: `Database status:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Setup Static Content Deploy
 *
 * Runs `magerun2 setup:static-content:deploy` to deploy static content
 */
server.registerTool(
  "setup-static-content-deploy",
  {
    title: "Setup Static Content Deploy",
    description: "Deploy Magento 2 static content and assets",
    inputSchema: {
      languages: z.array(z.string())
        .optional()
        .describe("Languages to deploy (e.g., ['en_US', 'de_DE'])"),
      themes: z.array(z.string())
        .optional()
        .describe("Themes to deploy"),
      jobs: z.number()
        .optional()
        .describe("Number of parallel jobs"),
      force: z.boolean()
        .optional()
        .describe("Force deployment even if files exist")
    }
  },
  async ({ languages, themes, jobs, force }) => {
    let command = `setup:static-content:deploy`;

    if (languages && languages.length > 0) {
      command += ` ${languages.join(' ')}`;
    }

    if (themes && themes.length > 0) {
      command += ` --theme=${themes.join(' --theme=')}`;
    }

    if (jobs) {
      command += ` --jobs=${jobs}`;
    }

    if (force) {
      command += ` --force`;
    }

    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: `Static content deployment completed:\n\n${result.data}`
      }]
    };
  }
);

/**
 * Tool: Store List (sys:store:list)
 *
 * Runs `magerun2 sys:store:list` to list stores
 */
server.registerTool(
  "sys-store-list",
  {
    title: "Store List",
    description: "List all Magento 2 stores, websites, and store views",
    inputSchema: {
      format: z.enum(["table", "json", "csv"])
        .default("table")
        .describe("Output format")
    }
  },
  async ({ format = "table" }) => {
    const command = `sys:store:list --format=${format}`;
    const result = await executeMagerun2Command(command, format === "json");

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    const responseText = format === "json"
      ? `Store list (${format} format):\n\n${JSON.stringify(result.data, null, 2)}`
      : `Store list (${format} format):\n\n${result.data}`;

    return {
      content: [{
        type: "text",
        text: responseText
      }]
    };
  }
);

/**
 * Tool: Theme List
 *
 * Runs `magerun2 dev:theme:list` to list all available themes
 */
server.registerTool(
  "dev-theme-list",
  {
    title: "Theme List",
    description: "List all available Magento 2 themes",
    inputSchema: {
      format: z.enum(["table", "json", "csv"])
        .default("table")
        .describe("Output format")
    }
  },
  async ({ format = "table" }) => {
    const command = `dev:theme:list --format=${format}`;
    const result = await executeMagerun2Command(command, format === "json");

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    const responseText = format === "json"
      ? `Theme list (${format} format):\n\n${JSON.stringify(result.data, null, 2)}`
      : `Theme list (${format} format):\n\n${result.data}`;

    return {
      content: [{
        type: "text",
        text: responseText
      }]
    };
  }
);

/**
 * Tool: Store Config Base URL List
 *
 * Runs `magerun2 sys:store:config:base-url:list` to list all base URLs
 */
server.registerTool(
  "sys-store-config-base-url-list",
  {
    title: "Store Config Base URL List",
    description: "List all base URLs for Magento 2 stores",
    inputSchema: {
      format: z.enum(["table", "json", "csv"])
        .default("table")
        .describe("Output format")
    }
  },
  async ({ format = "table" }) => {
    const command = `sys:store:config:base-url:list --format=${format}`;
    const result = await executeMagerun2Command(command, format === "json");

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    const responseText = format === "json"
      ? `Base URL list (${format} format):\n\n${JSON.stringify(result.data, null, 2)}`
      : `Base URL list (${format} format):\n\n${result.data}`;

    return {
      content: [{
        type: "text",
        text: responseText
      }]
    };
  }
);

/**
 * Tool: Cron List
 *
 * Runs `magerun2 sys:cron:list` to list cron jobs
 */
server.registerTool(
  "sys-cron-list",
  {
    title: "Cron List",
    description: "List all Magento 2 cron jobs and their configuration",
    inputSchema: {
      format: z.enum(["table", "json", "csv"])
        .default("table")
        .describe("Output format")
    }
  },
  async ({ format = "table" }) => {
    const command = `sys:cron:list --format=${format}`;
    const result = await executeMagerun2Command(command, format === "json");

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    const responseText = format === "json"
      ? `Cron job list (${format} format):\n\n${JSON.stringify(result.data, null, 2)}`
      : `Cron job list (${format} format):\n\n${result.data}`;

    return {
      content: [{
        type: "text",
        text: responseText
      }]
    };
  }
);

/**
 * Tool: URL List
 *
 * Runs `magerun2 sys:url:list` to get all URLs
 */
server.registerTool(
  "sys-url-list",
  {
    title: "URL List",
    description: "Get all Magento 2 URLs",
    inputSchema: {
      format: z.enum(["table", "json", "csv"])
        .default("table")
        .describe("Output format"),
      storeId: z.string()
        .optional()
        .describe("Store ID to filter URLs")
    }
  },
  async ({ format = "table", storeId }) => {
    let command = `sys:url:list --format=${format}`;

    if (storeId) {
      command += ` --store-id=${storeId}`;
    }

    const result = await executeMagerun2Command(command, format === "json");

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    const responseText = format === "json"
      ? `URL list (${format} format):\n\n${JSON.stringify(result.data, null, 2)}`
      : `URL list (${format} format):\n\n${result.data}`;

    return {
      content: [{
        type: "text",
        text: responseText
      }]
    };
  }
);

/**
 * Tool: Website List
 *
 * Runs `magerun2 sys:website:list` to list all websites
 */
server.registerTool(
  "sys-website-list",
  {
    title: "Website List",
    description: "List all Magento 2 websites",
    inputSchema: {
      format: z.enum(["table", "json", "csv"])
        .default("table")
        .describe("Output format")
    }
  },
  async ({ format = "table" }) => {
    const command = `sys:website:list --format=${format}`;
    const result = await executeMagerun2Command(command, format === "json");

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    const responseText = format === "json"
      ? `Website list (${format} format):\n\n${JSON.stringify(result.data, null, 2)}`
      : `Website list (${format} format):\n\n${result.data}`;

    return {
      content: [{
        type: "text",
        text: responseText
      }]
    };
  }
);

/**
 * Tool: Cron Run
 *
 * Runs `magerun2 sys:cron:run` to execute cron jobs
 */
server.registerTool(
  "sys-cron-run",
  {
    title: "Cron Run",
    description: "Run Magento 2 cron jobs",
    inputSchema: {
      job: z.string()
        .optional()
        .describe("Specific cron job to run (optional, runs all if not specified)"),
      group: z.string()
        .optional()
        .describe("Cron group to run")
    }
  },
  async ({ job, group }) => {
    let command = `sys:cron:run`;

    if (job) {
      command += ` "${job}"`;
    }

    if (group) {
      command += ` --group="${group}"`;
    }

    const result = await executeMagerun2Command(command);

    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: result.error
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: `Cron execution completed:\n\n${result.data}`
      }]
    };
  }
);

registerTranslationCheckTool(server);
registerModuleIntegrationTestTool(server);
registerCompatibilityCheckTool(server);
registerCopyrightCheckTool(server);
registerReleaseCheckTool(server);
registerApiGetTokenTool(server, { defaultMagentoBaseUrl });
registerApiCheckTool(server, { defaultMagentoBaseUrl });

/**
 * Tool: API Contract
 *
 * Native API contract extraction from module webapi.xml + Magento schema endpoint.
 */
server.registerTool(
  "api-contract",
  {
    title: "API Contract",
    description: "Generate API contract from Magento schema filtered by moduleDir or pathPrefix",
    inputSchema: {
      moduleDir: z.string()
        .optional()
        .describe("Module directory, e.g. app/code/Vendor/Module or vendor/vendor/module"),
      pathPrefix: z.string()
        .optional()
        .describe("REST path prefix, e.g. /V1/custom-prefix/"),
      baseUrl: z.string()
        .default(defaultMagentoBaseUrl)
        .describe(`Magento base URL (default: ${defaultMagentoBaseUrl})`),
      storeCode: z.string()
        .default("default")
        .describe("Store code for /rest/<store>/schema"),
      schemaFile: z.string()
        .optional()
        .describe("Use pre-fetched schema JSON file"),
      auth: z.enum(["admin", "none"])
        .default("admin")
        .describe("Schema fetch auth mode"),
      token: z.string()
        .optional()
        .describe("Explicit bearer token"),
      adminUsername: z.string()
        .optional()
        .describe("Admin username"),
      adminPassword: z.string()
        .optional()
        .describe("Admin password"),
      format: z.enum(["json", "md"])
        .default("json")
        .describe("Contract output format"),
      artifactPath: z.string()
        .optional()
        .describe("Optional output file path"),
      insecure: z.boolean()
        .default(true)
        .describe("Allow insecure TLS certificates")
    }
  },
  async ({
    moduleDir,
    pathPrefix,
    baseUrl = defaultMagentoBaseUrl,
    storeCode = "default",
    schemaFile,
    auth = "admin",
    token,
    adminUsername,
    adminPassword,
    format = "json",
    artifactPath,
    insecure = true
  }) => {
    if (!moduleDir && !pathPrefix) {
      return {
        content: [{ type: "text", text: "Provide either moduleDir or pathPrefix" }],
        isError: true
      };
    }

    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const normalizedPathPrefix = pathPrefix && pathPrefix.trim().length > 0
      ? normalizePathPrefix(pathPrefix.trim())
      : undefined;

    let normalizedModuleDir: string | undefined;
    let moduleAbsoluteDir: string | undefined;
    if (moduleDir) {
      try {
        const normalizedModule = normalizeModuleDirForApiTools(moduleDir);
        normalizedModuleDir = normalizedModule.relativeModuleDir;
        moduleAbsoluteDir = normalizedModule.absoluteModuleDir;
      } catch (error) {
        return {
          content: [{ type: "text", text: `Invalid moduleDir: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }
    }

    let moduleRoutes: WebapiRouteDescriptor[] = [];
    if (moduleAbsoluteDir) {
      try {
        moduleRoutes = await readModuleWebapiRoutes(moduleAbsoluteDir);
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to read module webapi.xml: ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true
        };
      }
    }

    const schemaUrl = `${normalizedBaseUrl}/rest/${encodeURIComponent(storeCode)}/schema?services=all`;
    const schemaFileAbsolutePath = schemaFile ? resolve(process.cwd(), schemaFile) : null;
    let schemaDocument: unknown | null = null;
    let schemaWarning: string | null = null;

    if (schemaFileAbsolutePath) {
      try {
        const rawSchema = await readFile(schemaFileAbsolutePath, "utf8");
        schemaDocument = JSON.parse(rawSchema);
      } catch (error) {
        schemaWarning = `Could not parse schemaFile '${schemaFileAbsolutePath}': ${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      const headers: Record<string, string> = {
        Accept: "application/json"
      };

      let resolvedToken = (token ?? "").trim();
      if (auth === "admin" && resolvedToken.length === 0) {
        const resolvedAdminUsername = (adminUsername ?? process.env.MAGENTO_ADMIN_USERNAME ?? "root").trim();
        const resolvedAdminPassword = (adminPassword ?? process.env.MAGENTO_ADMIN_PASSWORD ?? "").trim();

        if (!resolvedAdminPassword) {
          schemaWarning = "Missing admin password for schema authentication. Provide token or adminPassword.";
        } else {
          try {
            resolvedToken = await withTemporaryInsecureTls(insecure, async () => {
              const response = await fetch(`${normalizedBaseUrl}/rest/V1/integration/admin/token`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json"
                },
                body: JSON.stringify({
                  username: resolvedAdminUsername,
                  password: resolvedAdminPassword
                })
              });

              const responseBody = await response.text();
              if (!response.ok) {
                throw new Error(`Token request failed (${response.status} ${response.statusText}): ${responseBody}`);
              }

              let parsedTokenResponse: unknown;
              try {
                parsedTokenResponse = JSON.parse(responseBody);
              } catch {
                parsedTokenResponse = responseBody;
              }

              if (typeof parsedTokenResponse === "string" && parsedTokenResponse.trim().length > 0) {
                return parsedTokenResponse.trim();
              }

              if (isRecord(parsedTokenResponse) && typeof parsedTokenResponse.token === "string") {
                return parsedTokenResponse.token;
              }

              throw new Error(`Unexpected token response: ${responseBody}`);
            });
          } catch (error) {
            schemaWarning = `Unable to obtain admin token: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      }

      if (auth === "admin" && resolvedToken.length > 0) {
        headers.Authorization = `Bearer ${resolvedToken}`;
      }

      if (!schemaWarning || auth === "none") {
        try {
          schemaDocument = await fetchJsonFromUrl(schemaUrl, headers, insecure);
        } catch (error) {
          schemaWarning = `Schema fetch failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }

    const schemaPaths = getSchemaPaths(schemaDocument);
    const definitions = getSchemaDefinitions(schemaDocument);
    const schemaHasPaths = Object.keys(schemaPaths).length > 0;
    if (schemaDocument && !schemaHasPaths && !schemaWarning) {
      schemaWarning = "Schema document has no 'paths' object.";
    }

    if (!normalizedModuleDir && normalizedPathPrefix && !schemaHasPaths) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            moduleDir: null,
            pathPrefix: normalizedPathPrefix,
            routeCount: 0,
            artifactPath: artifactPath ? resolve(process.cwd(), artifactPath) : null,
            contract: null,
            error: "Unable to build contract from pathPrefix without a valid schema document.",
            schemaWarning
          }, null, 2)
        }],
        isError: true
      };
    }

    const routesByKey = new Map<string, WebapiRouteDescriptor>();
    const pushRoute = (route: WebapiRouteDescriptor): void => {
      const normalizedPath = normalizeRoutePath(route.path);
      const key = `${route.method.toUpperCase()} ${normalizedPath}`;
      if (!routesByKey.has(key)) {
        routesByKey.set(key, {
          ...route,
          method: route.method.toUpperCase(),
          path: normalizedPath
        });
      }
    };

    if (moduleRoutes.length > 0) {
      for (const route of moduleRoutes) {
        if (normalizedPathPrefix && !normalizeRoutePath(route.path).startsWith(normalizedPathPrefix)) {
          continue;
        }
        pushRoute(route);
      }
    } else if (normalizedPathPrefix && schemaHasPaths) {
      const allowedMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
      for (const [schemaPath, pathNode] of Object.entries(schemaPaths)) {
        if (!isRecord(pathNode)) {
          continue;
        }
        const normalizedSchemaPath = normalizeRoutePath(schemaPath);
        if (!normalizedSchemaPath.startsWith(normalizedPathPrefix)) {
          continue;
        }
        for (const [methodKey, operationValue] of Object.entries(pathNode)) {
          if (!allowedMethods.has(methodKey.toLowerCase()) || !isRecord(operationValue)) {
            continue;
          }
          const responses = isRecord(operationValue.responses) ? operationValue.responses : {};
          const has401Response = Object.prototype.hasOwnProperty.call(responses, "401");
          pushRoute({
            method: methodKey.toUpperCase(),
            path: normalizedSchemaPath,
            resources: [],
            serviceMethod: String(operationValue.operationId ?? ""),
            expectedAuth: has401Response ? "acl_expected" : "anonymous_expected"
          });
        }
      }
    }

    const endpoints = Array.from(routesByKey.values())
      .sort((a, b) => {
        const pathCompare = a.path.localeCompare(b.path);
        if (pathCompare !== 0) {
          return pathCompare;
        }
        return a.method.localeCompare(b.method);
      })
      .map((route) => {
        const operation = schemaHasPaths ? getSchemaEndpointOperation(schemaPaths, route.path, route.method) : null;
        return buildEndpointContract(route, operation, definitions);
      });

    const contractPayload: Record<string, unknown> = {
      generated_at: new Date().toISOString(),
      source: {
        base_url: normalizedBaseUrl,
        store_code: storeCode,
        schema_url: schemaFileAbsolutePath ? null : schemaUrl,
        schema_file: schemaFileAbsolutePath,
        schema_auth: auth,
        schema_available: schemaHasPaths,
        schema_warning: schemaWarning
      },
      filters: {
        moduleDir: normalizedModuleDir ?? null,
        pathPrefix: normalizedPathPrefix ?? null
      },
      endpoints
    };

    const contractOutput = format === "md"
      ? buildMarkdownContract(contractPayload)
      : contractPayload;

    let resolvedArtifactPath: string | null = null;
    if (artifactPath) {
      resolvedArtifactPath = resolve(process.cwd(), artifactPath);
      try {
        await mkdir(dirname(resolvedArtifactPath), { recursive: true });
        await writeFile(
          resolvedArtifactPath,
          format === "md" ? String(contractOutput) : JSON.stringify(contractOutput, null, 2),
          "utf8"
        );
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to write artifact '${resolvedArtifactPath}': ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true
        };
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          moduleDir: normalizedModuleDir ?? null,
          pathPrefix: normalizedPathPrefix ?? null,
          routeCount: endpoints.length,
          artifactPath: resolvedArtifactPath,
          schemaWarning,
          contract: contractOutput
        }, null, 2)
      }]
    };
  }
);

/**
 * Tool: Mail Inspect
 *
 * Reads email messages from a configured source (Mailpit by default), supports
 * targeted lookup by messageId, and can optionally render message HTML to image.
 */
server.registerTool(
  "mail-inspect",
  {
    title: "Mail Inspect",
    description: "Inspect emails from Mailpit/API with source/query/evidence. Supports selecting a specific message by messageId and optional HTML-to-image rendering.",
    inputSchema: {
      source: z.object({
        provider: z.enum(["mailpit", "imap", "api"])
          .default("mailpit")
          .describe("Mail source provider"),
        baseUrl: z.string()
          .optional()
          .describe(`Mail source base URL (default: ${defaultMailpitBaseUrl})`),
        credentials: z.object({
          username: z.string().optional(),
          password: z.string().optional(),
          token: z.string().optional()
        })
          .optional()
          .describe("Optional source credentials. For Mailpit, usually not needed."),
        insecureTls: z.boolean()
          .default(true)
          .describe("Allow insecure TLS certificates (useful for local dev certificates)")
      })
        .optional()
        .describe("Source configuration"),
      query: z.object({
        messageId: z.string()
          .optional()
          .describe("Exact message identifier (Mailpit ID or MessageID). If set, filters are ignored."),
        limit: z.number()
          .int()
          .min(1)
          .max(50)
          .default(1)
          .describe("Max number of messages to return when messageId is not set"),
        fetchLimit: z.number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe("Number of newest messages fetched from source before local filtering"),
        filters: z.object({
          to: z.string().optional().describe("Filter by recipient email (contains, case-insensitive)"),
          subject: z.string().optional().describe("Filter by subject (contains, case-insensitive)"),
          contains: z.string().optional().describe("Filter by subject/snippet/recipient text (contains, case-insensitive)")
        })
          .optional()
          .describe("Optional local filters")
      })
        .optional()
        .describe("Query configuration"),
      evidence: z.object({
        renderImage: z.boolean()
          .default(false)
          .describe("Render HTML body to PNG image"),
        renderDir: z.string()
          .optional()
          .describe("Render output directory (default: tmp/mail-inspect/evidence/YYYY-MM-DD)"),
        includeHtml: z.boolean()
          .default(false)
          .describe("Include full HTML body in output"),
        includeText: z.boolean()
          .default(false)
          .describe("Include full text body in output"),
        imageOutput: z.enum(["path", "base64"])
          .default("path")
          .describe("Image artifact output mode"),
        imageWidth: z.number()
          .int()
          .min(320)
          .max(3840)
          .default(1280)
          .describe("Rendered image width"),
        imageHeight: z.number()
          .int()
          .min(320)
          .max(8000)
          .default(2200)
          .describe("Rendered image height")
      })
        .optional()
        .describe("Evidence configuration")
    }
  },
  async ({ source, query, evidence }) => {
    const sourceConfig: MailSourceConfig = {
      provider: source?.provider ?? "mailpit",
      baseUrl: normalizeBaseUrl(source?.baseUrl ?? defaultMailpitBaseUrl),
      credentials: source?.credentials,
      insecureTls: source?.insecureTls ?? true
    };

    const queryConfig: MailQueryConfig = {
      messageId: query?.messageId?.trim() || undefined,
      limit: query?.limit ?? 1,
      fetchLimit: query?.fetchLimit ?? 50,
      filters: query?.filters
    };

    const evidenceConfig: MailEvidenceConfig = {
      renderImage: evidence?.renderImage ?? false,
      renderDir: evidence?.renderDir,
      includeHtml: evidence?.includeHtml ?? false,
      includeText: evidence?.includeText ?? false,
      imageOutput: evidence?.imageOutput ?? "path",
      imageWidth: evidence?.imageWidth ?? 1280,
      imageHeight: evidence?.imageHeight ?? 2200
    };

    if (sourceConfig.provider === "imap") {
      return {
        content: [{
          type: "text",
          text: "Provider 'imap' is not implemented yet in this MCP server. Use 'mailpit' or a Mailpit-compatible 'api' source."
        }],
        isError: true
      };
    }

    if (!sourceConfig.baseUrl) {
      return {
        content: [{
          type: "text",
          text: "Missing source.baseUrl. Provide a base URL or set MAILPIT_BASE_URL."
        }],
        isError: true
      };
    }

    try {
      let totalAvailable: number | null = null;
      let selectedMessages: MailpitMessageDetails[] = [];

      if (queryConfig.messageId) {
        const message = await fetchMailpitMessageByIdentifier(
          sourceConfig.baseUrl,
          queryConfig.messageId,
          queryConfig.fetchLimit,
          sourceConfig.credentials,
          sourceConfig.insecureTls
        );
        if (message) {
          selectedMessages = [message];
        }
      } else {
        const listResponse = await fetchMailpitJson<MailpitMessageListResponse>(
          sourceConfig.baseUrl,
          `/api/v1/messages?limit=${queryConfig.fetchLimit}`,
          sourceConfig.credentials,
          sourceConfig.insecureTls
        );

        const summaries = listResponse.messages ?? [];
        totalAvailable = typeof listResponse.total === "number" ? listResponse.total : summaries.length;

        const filteredSummaries = summaries
          .filter((message) => messageMatchesFilters(message, queryConfig.filters))
          .slice(0, queryConfig.limit);

        selectedMessages = await Promise.all(
          filteredSummaries.map((message) =>
            fetchMailpitJson<MailpitMessageDetails>(
              sourceConfig.baseUrl,
              `/api/v1/message/${encodeURIComponent(message.ID)}`,
              sourceConfig.credentials,
              sourceConfig.insecureTls
            )
          )
        );
      }

      const renderDirectory = evidenceConfig.renderImage ? resolveRenderDir(evidenceConfig.renderDir) : null;
      const normalizedMessages: Array<Record<string, unknown>> = [];

      for (const message of selectedMessages) {
        const messagePayload: Record<string, unknown> = {
          id: message.ID,
          messageId: message.MessageID ?? "",
          subject: message.Subject ?? "",
          created: message.Created ?? message.Date ?? null,
          from: formatPerson(message.From),
          to: peopleToAddresses(message.To),
          cc: peopleToAddresses(message.Cc),
          bcc: peopleToAddresses(message.Bcc),
          snippet: message.Snippet ?? "",
          size: message.Size ?? null
        };

        if (evidenceConfig.includeText) {
          messagePayload.text = message.Text ?? "";
        }

        if (evidenceConfig.includeHtml) {
          messagePayload.html = message.HTML ?? "";
        }

        if (evidenceConfig.renderImage) {
          if (!message.HTML || message.HTML.trim().length === 0) {
            messagePayload.image = {
              skipped: true,
              reason: "No HTML body available for rendering."
            };
          } else if (renderDirectory) {
            const imageArtifact = await renderMailHtmlToImage(
              message.HTML,
              message.ID,
              renderDirectory,
              evidenceConfig.imageWidth,
              evidenceConfig.imageHeight,
              evidenceConfig.imageOutput
            );

            const imagePayload: Record<string, unknown> = {
              mimeType: imageArtifact.mimeType,
              path: imageArtifact.imagePath,
              htmlPath: imageArtifact.htmlPath,
              chromeBinary: imageArtifact.chromeBinary
            };
            if (imageArtifact.base64) {
              imagePayload.base64 = imageArtifact.base64;
            }
            messagePayload.image = imagePayload;
          }
        }

        normalizedMessages.push(messagePayload);
      }

      const authMode =
        sourceConfig.credentials?.token
          ? "bearer"
          : (sourceConfig.credentials?.username || sourceConfig.credentials?.password)
            ? "basic"
            : "none";

      const responsePayload = {
        success: true,
        source: {
          provider: sourceConfig.provider,
          baseUrl: sourceConfig.baseUrl,
          authMode,
          insecureTls: sourceConfig.insecureTls
        },
        query: {
          messageId: queryConfig.messageId ?? null,
          limit: queryConfig.limit,
          fetchLimit: queryConfig.fetchLimit,
          filters: queryConfig.filters ?? null
        },
        summary: {
          totalAvailable,
          matched: normalizedMessages.length,
          messageFound: queryConfig.messageId ? normalizedMessages.length > 0 : null
        },
        messages: normalizedMessages
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(responsePayload, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `mail-inspect failed: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

/**
 * Tool: Get Plugin List
 *
 * Analyzes Magento 2 plugin (interceptor) configuration for a given class
 * across all scopes in a single execution. When methodName is omitted,
 * scans all public methods of the class.
 */
server.registerTool(
  "dev-plugin-list",
  {
    title: "Get Plugin List",
    description: "Get Magento 2 plugin (interceptor) list for a class across all scopes (global, adminhtml, frontend, crontab, webapi_rest, webapi_soap, graphql). When methodName is provided, analyzes that single method. When omitted, scans all public methods and reports only those with plugins.",
    inputSchema: {
      className: z.string()
        .describe("Fully qualified PHP class or interface name (e.g., 'Magento\\Catalog\\Model\\Product')"),
      methodName: z.string()
        .optional()
        .describe("Method name to inspect (e.g., 'save'). Omit to scan all public methods.")
    }
  },
  async ({ className, methodName }) => {
    const args = [process.cwd(), className];
    if (methodName) {
      args.push(methodName);
    }
    const result = await executePhpScript('get-plugins.php', args);

    if (!result.success) {
      return {
        content: [{ type: "text", text: result.error }],
        isError: true
      };
    }

    return {
      content: [{ type: "text", text: formatPluginAnalysis(result.data) }]
    };
  }
);

/**
 * Start the server
 */
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    // Log to stderr so it doesn't interfere with MCP communication
    console.error("Magento 2 Development MCP Server is running...");
    console.error("Available tools:");
    console.error("DI & Module Tools:");
    console.error("- get-di-preferences: Get DI preferences list");
    console.error("- dev-module-list: List all modules and their status");
    console.error("- dev-module-observer-list: List module observers");
    console.error("- dev-module-create: Create and register a new module");
    console.error("- dev-theme-list: List all available themes");
    console.error("- dev-plugin-list: Get plugin interceptors for a class method");
    console.error("Cache Management:");
    console.error("- cache-clean: Clear specific or all caches");
    console.error("- cache-flush: Flush specific or all caches");
    console.error("- cache-enable: Enable specific cache types");
    console.error("- cache-disable: Disable specific cache types");
    console.error("- cache-status: Check cache status");
    console.error("- cache-view: Inspect cache entries");
    console.error("System Diagnostics:");
    console.error("- sys-info: Get system information");
    console.error("- sys-check: Check system requirements");
    console.error("Configuration:");
    console.error("- config-show: View system configuration");
    console.error("- config-set: Set system configuration");
    console.error("- config-store-get: Get store-specific configuration");
    console.error("- config-store-set: Set store-specific configuration");
    console.error("Database:");
    console.error("- db-query: Execute SQL queries");
    console.error("Setup & Deployment:");
    console.error("- setup-upgrade: Run setup upgrade");
    console.error("- setup-di-compile: Compile DI configuration");
    console.error("- setup-db-status: Check database status");
    console.error("- setup-static-content-deploy: Deploy static content");
    console.error("Store Management:");
    console.error("- sys-store-list: List stores, websites, and store views");
    console.error("- sys-store-config-base-url-list: List all base URLs");
    console.error("- sys-url-list: Get all URLs");
    console.error("- sys-website-list: List all websites");
    console.error("Cron Management:");
    console.error("- sys-cron-list: List cron jobs");
    console.error("- sys-cron-run: Run cron jobs");
    console.error("Web API:");
    console.error("- api-get-token: Create admin/staff/customer API tokens");
    console.error("- api-check: Check module webapi.xml routes with live auth probes");
    console.error("- api-contract: Build filtered API contract from Magento schema");
    console.error("Quality Tools:");
    console.error("- translation-check: Run translation QA checks for modules in vendor/* or app/code/*");
    console.error("- module-integration-test: Run module integration phpunit tests");
    console.error("- compatibility-check: Analyze module compatibility across Magento versions");
    console.error("- copyright-check: Validate module copyright headers");
    console.error("- release-check: Run native release readiness checks for a Magento module");
    console.error("Mail:");
    console.error("- mail-inspect: Inspect Mailpit/API messages and optionally render a specific email to image");
    
  } catch (error) {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error("Shutting down Magento 2 Development MCP Server...");
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error("Shutting down Magento 2 Development MCP Server...");
  process.exit(0);
});

// Start the server
main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
