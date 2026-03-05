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
      case ">=":
        return cmp >= 0;
      case "<=":
        return cmp <= 0;
      case ">":
        return cmp > 0;
      case "<":
        return cmp < 0;
      case "!=":
        return cmp !== 0;
      case "=":
      case "==":
      default:
        return cmp === 0;
    }
  }

  return compareMagentoVersions(version, trimmed) === 0;
}

export function evaluateConstraintExpression(version: string, expression: string): boolean {
  const groups = expression
    .split("||")
    .map((group) => group.trim())
    .filter(Boolean);

  if (groups.length === 0) {
    return true;
  }

  return groups.some((group) => {
    const tokens = group
      .split(/[\s,]+/)
      .map((token) => token.trim())
      .filter(Boolean);

    if (tokens.length === 0) {
      return true;
    }

    return tokens.every((token) => evaluateSingleConstraint(version, token));
  });
}
