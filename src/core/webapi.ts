import { readFile } from "fs/promises";
import { join } from "path";

export interface WebapiRouteDescriptor {
  method: string;
  path: string;
  resources: string[];
  serviceMethod: string;
  expectedAuth: "anonymous_expected" | "acl_expected";
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

export function normalizeRoutePath(rawPath: string): string {
  return rawPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

export function parseWebapiRoutesFromXml(xmlContent: string): WebapiRouteDescriptor[] {
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

export async function readModuleWebapiRoutes(moduleAbsoluteDir: string): Promise<WebapiRouteDescriptor[]> {
  const webapiPath = join(moduleAbsoluteDir, "etc", "webapi.xml");
  const xmlContent = await readFile(webapiPath, "utf8");
  return parseWebapiRoutesFromXml(xmlContent);
}

export function buildProbePath(route: WebapiRouteDescriptor): string {
  let probePath = route.path.replace(/\{[^}]+\}/g, "1");

  if (route.method === "GET" && route.serviceMethod === "getList") {
    const joiner = probePath.includes("?") ? "&" : "?";
    probePath = `${probePath}${joiner}searchCriteria[currentPage]=1&searchCriteria[pageSize]=1`;
  }

  return probePath;
}
