import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveModuleDirectory } from "../core/module-resolver.js";
import { buildProbePath, readModuleWebapiRoutes, WebapiRouteDescriptor } from "../core/webapi.js";
import { normalizeBaseUrl, performHttpRequest } from "../core/http.js";
import { requestMagentoToken } from "../core/magento-auth.js";

interface ApiCheckOptions {
  defaultMagentoBaseUrl: string;
}

interface ProbeResult {
  status: number | null;
  snippet: string;
}

function isAuthFail(status: number | null): boolean {
  return status === 401 || status === 403;
}

function classify(
  noneStatus: number | null,
  adminStatus: number | null,
  staffStatus: number | null,
  hasStaffProbe: boolean
): string {
  const noneFail = isAuthFail(noneStatus);
  const adminFail = isAuthFail(adminStatus);
  const staffFail = hasStaffProbe ? isAuthFail(staffStatus) : true;

  if (!noneFail) {
    return "anonymous_public";
  }

  if (adminStatus !== null && !adminFail) {
    return "admin_acl";
  }

  if (hasStaffProbe && staffStatus !== null && !staffFail) {
    if (noneFail && (adminStatus === null || adminFail)) {
      return "staff_token_required";
    }
    return "staff_access";
  }

  return "auth_blocked";
}

function classifyVerdict(
  expectedAuth: "anonymous_expected" | "acl_expected",
  noneStatus: number | null,
  adminStatus: number | null
): { verdict: "PASS" | "FAIL"; reason: string } {
  if (expectedAuth === "anonymous_expected") {
    if (isAuthFail(noneStatus)) {
      return { verdict: "FAIL", reason: "Expected anonymous route, but no-auth probe returned auth error" };
    }
    return { verdict: "PASS", reason: "Anonymous access behaves as expected" };
  }

  if (!isAuthFail(noneStatus)) {
    return { verdict: "FAIL", reason: "Expected protected route, but no-auth probe was not blocked" };
  }

  if (adminStatus === null || isAuthFail(adminStatus)) {
    return { verdict: "FAIL", reason: "Expected admin access, but admin probe was blocked" };
  }

  return { verdict: "PASS", reason: "Protected route behavior matches expectation" };
}

async function probeRoute(
  baseUrl: string,
  route: WebapiRouteDescriptor,
  authMode: "none" | "admin" | "staff",
  tokens: { adminToken: string; staffToken: string },
  insecure: boolean
): Promise<ProbeResult> {
  if (authMode === "staff" && !tokens.staffToken) {
    return {
      status: null,
      snippet: "staff token not available"
    };
  }

  const probePath = buildProbePath(route);
  const fullUrl = probePath.startsWith("/V1/")
    ? `${normalizeBaseUrl(baseUrl)}/rest${probePath}`
    : `${normalizeBaseUrl(baseUrl)}${probePath}`;

  const headers: Record<string, string> = {
    Accept: "application/json"
  };

  if (authMode === "admin") {
    headers.Authorization = `Bearer ${tokens.adminToken}`;
  } else if (authMode === "staff") {
    headers.Authorization = `Bearer ${tokens.staffToken}`;
  }

  let body: string | undefined;
  if (["POST", "PUT", "PATCH"].includes(route.method)) {
    headers["Content-Type"] = "application/json";
    body = "{}";
  }

  try {
    const response = await performHttpRequest(fullUrl, {
      method: route.method,
      headers,
      body,
      insecureTls: insecure
    });

    const flatSnippet = response.bodyText.replace(/\s+/g, " ").trim().slice(0, 200);
    return {
      status: response.statusCode,
      snippet: flatSnippet
    };
  } catch (error) {
    return {
      status: null,
      snippet: error instanceof Error ? error.message : String(error)
    };
  }
}

export function registerApiCheckTool(server: McpServer, options: ApiCheckOptions): void {
  server.registerTool(
    "api-check",
    {
      title: "API Check",
      description: "Check module REST routes from webapi.xml against live auth behavior",
      inputSchema: {
        moduleDir: z.string().describe("Module directory, e.g. app/code/Vendor/Module or vendor/vendor/module"),
        baseUrl: z
          .string()
          .default(options.defaultMagentoBaseUrl)
          .describe(`Magento base URL (default: ${options.defaultMagentoBaseUrl})`),
        adminUsername: z.string().optional().describe("Admin username"),
        adminPassword: z.string().optional().describe("Admin password"),
        staffEmail: z.string().optional().describe("Staff email (optional)"),
        staffPassword: z.string().optional().describe("Staff password (required when staffEmail is provided)"),
        insecure: z.boolean().default(true).describe("Allow insecure TLS certificates")
      }
    },
    async ({
      moduleDir,
      baseUrl = options.defaultMagentoBaseUrl,
      adminUsername,
      adminPassword,
      staffEmail,
      staffPassword,
      insecure = true
    }) => {
      if (staffEmail && !staffPassword) {
        return {
          content: [{ type: "text", text: "staffPassword is required when staffEmail is provided" }],
          isError: true
        };
      }

      let resolvedModule;
      try {
        resolvedModule = resolveModuleDirectory(moduleDir, { requireSubPath: "etc/webapi.xml" });
      } catch (error) {
        return {
          content: [{ type: "text", text: `Invalid moduleDir: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }

      let routes: WebapiRouteDescriptor[] = [];
      try {
        routes = await readModuleWebapiRoutes(resolvedModule.absoluteModuleDir);
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to parse webapi.xml: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        };
      }

      const adminTokenResult = await requestMagentoToken({
        type: "admin",
        username: (adminUsername ?? process.env.MAGENTO_ADMIN_USERNAME ?? "root").trim(),
        password: (adminPassword ?? process.env.MAGENTO_ADMIN_PASSWORD ?? "4g9a78czi").trim(),
        baseUrl,
        insecure
      });

      if (!adminTokenResult.success) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              moduleDir: resolvedModule.relativeModuleDir,
              summary: { routeCount: routes.length, failures: routes.length, warnings: 0, passed: 0, classes: {} },
              routes: [],
              error: `Admin token failed: ${adminTokenResult.error}`
            }, null, 2)
          }],
          isError: true
        };
      }

      let staffToken = "";
      let staffTokenError: string | null = null;
      if (staffEmail) {
        const staffTokenResult = await requestMagentoToken({
          type: "staff",
          email: staffEmail,
          password: staffPassword ?? "",
          baseUrl,
          insecure
        });
        if (!staffTokenResult.success) {
          staffTokenError = staffTokenResult.error;
        } else {
          staffToken = staffTokenResult.token;
        }
      }

      const routePayload: Array<Record<string, unknown>> = [];
      let failures = 0;

      for (const route of routes) {
        const [noneProbe, adminProbe, staffProbe] = await Promise.all([
          probeRoute(baseUrl, route, "none", { adminToken: adminTokenResult.token, staffToken }, insecure),
          probeRoute(baseUrl, route, "admin", { adminToken: adminTokenResult.token, staffToken }, insecure),
          probeRoute(baseUrl, route, "staff", { adminToken: adminTokenResult.token, staffToken }, insecure)
        ]);

        const classification = classify(
          noneProbe.status,
          adminProbe.status,
          staffProbe.status,
          Boolean(staffEmail)
        );

        const verdictInfo = classifyVerdict(route.expectedAuth, noneProbe.status, adminProbe.status);
        if (verdictInfo.verdict === "FAIL") {
          failures += 1;
        }

        routePayload.push({
          verdict: verdictInfo.verdict,
          method: route.method,
          path: route.path,
          probePath: buildProbePath(route),
          expectedAuth: route.expectedAuth,
          classification,
          httpStatuses: {
            none: noneProbe.status,
            admin: adminProbe.status,
            staff: staffProbe.status
          },
          resources: route.resources,
          notes: {
            none: noneProbe.snippet,
            admin: adminProbe.snippet,
            staff: staffProbe.snippet,
            verdict: verdictInfo.reason
          }
        });
      }

      const routeCount = routes.length;
      const payload = {
        success: failures === 0,
        moduleDir: resolvedModule.relativeModuleDir,
        summary: {
          routeCount,
          failures,
          warnings: staffTokenError ? 1 : 0,
          passed: Math.max(routeCount - failures, 0),
          classes: {
            anonymous_public: routePayload.filter((row) => row.classification === "anonymous_public").length,
            admin_acl: routePayload.filter((row) => row.classification === "admin_acl").length,
            staff_token_required: routePayload.filter((row) => row.classification === "staff_token_required").length,
            staff_access: routePayload.filter((row) => row.classification === "staff_access").length,
            auth_blocked: routePayload.filter((row) => row.classification === "auth_blocked").length
          }
        },
        routes: routePayload,
        executionError: staffTokenError
          ? {
              message: `Staff token unavailable: ${staffTokenError}`
            }
          : null
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: !payload.success
      };
    }
  );
}
