import { existsSync, statSync } from "fs";
import { resolve, relative, sep } from "path";

export interface ResolvedModuleDirectory {
  relativeModuleDir: string;
  absoluteModuleDir: string;
}

export interface ResolveModuleDirOptions {
  cwd?: string;
  requireSubPath?: string;
}

function normalizePath(input: string): string {
  return input.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function isInsideProject(projectRoot: string, absolutePath: string): boolean {
  const rootPrefix = projectRoot.endsWith(sep) ? projectRoot : `${projectRoot}${sep}`;
  return absolutePath === projectRoot || absolutePath.startsWith(rootPrefix);
}

function isValidModulePrefix(pathValue: string): boolean {
  return pathValue.startsWith("app/code/") || pathValue.startsWith("vendor/");
}

function existsDirectory(pathValue: string): boolean {
  if (!existsSync(pathValue)) {
    return false;
  }
  try {
    return statSync(pathValue).isDirectory();
  } catch {
    return false;
  }
}

function resolveCandidate(
  projectRoot: string,
  candidate: string,
  requireSubPath?: string
): ResolvedModuleDirectory | null {
  const normalizedCandidate = normalizePath(candidate);
  if (!normalizedCandidate) {
    return null;
  }

  const absolutePath = resolve(projectRoot, normalizedCandidate);
  if (!isInsideProject(projectRoot, absolutePath)) {
    return null;
  }

  const relativePath = normalizePath(relative(projectRoot, absolutePath));
  if (!isValidModulePrefix(relativePath)) {
    return null;
  }

  if (!existsDirectory(absolutePath)) {
    return null;
  }

  if (requireSubPath) {
    const requiredPath = resolve(absolutePath, requireSubPath);
    if (!existsSync(requiredPath)) {
      return null;
    }
  }

  return {
    relativeModuleDir: relativePath,
    absoluteModuleDir: absolutePath
  };
}

function addUnique(candidates: string[], candidate: string): void {
  const normalized = normalizePath(candidate);
  if (!normalized) {
    return;
  }
  if (!candidates.includes(normalized)) {
    candidates.push(normalized);
  }
}

function createGuessCandidates(moduleDirInput: string): string[] {
  const normalized = normalizePath(moduleDirInput);
  const candidates: string[] = [];
  addUnique(candidates, normalized);

  if (!normalized.startsWith("app/code/") && !normalized.startsWith("vendor/")) {
    const slashParts = normalized.split("/").filter(Boolean);
    if (slashParts.length === 2) {
      const [vendorPart, modulePart] = slashParts;
      addUnique(candidates, `app/code/${vendorPart}/${modulePart}`);
      addUnique(candidates, `vendor/${vendorPart}/${modulePart}`);
      addUnique(candidates, `vendor/${vendorPart.toLowerCase()}/${modulePart.toLowerCase()}`);
    }

    const underscoreParts = normalized.split("_").filter(Boolean);
    if (underscoreParts.length === 2) {
      const [vendorPart, modulePart] = underscoreParts;
      addUnique(candidates, `app/code/${vendorPart}/${modulePart}`);
      addUnique(candidates, `vendor/${vendorPart.toLowerCase()}/${modulePart.toLowerCase()}`);
    }
  }

  return candidates;
}

export function resolveModuleDirectory(
  moduleDirInput: string,
  options: ResolveModuleDirOptions = {}
): ResolvedModuleDirectory {
  const projectRoot = resolve(options.cwd ?? process.cwd());
  const normalizedInput = normalizePath(moduleDirInput);

  if (!normalizedInput) {
    throw new Error("moduleDir is required");
  }

  const tried: string[] = [];
  const candidates = createGuessCandidates(normalizedInput);

  for (const candidate of candidates) {
    const resolved = resolveCandidate(projectRoot, candidate, options.requireSubPath);
    tried.push(candidate);
    if (resolved) {
      return resolved;
    }
  }

  const requireHint = options.requireSubPath ? ` (required: ${options.requireSubPath})` : "";
  throw new Error(
    `Could not resolve moduleDir '${moduleDirInput}'. Tried: ${tried.join(", ")}${requireHint}`
  );
}
