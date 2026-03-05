import { normalizeBaseUrl, parseJsonLenient, performHttpRequest } from "./http.js";
import { isRecord } from "./output.js";

export interface TokenRequestInput {
  type: "admin" | "staff" | "customer";
  password: string;
  username?: string;
  email?: string;
  baseUrl: string;
  insecure: boolean;
}

export interface TokenRequestResult {
  success: boolean;
  type: "admin" | "staff" | "customer";
  endpoint: string;
  statusCode: number;
  token: string;
  error: string;
}

function resolveEndpointAndPayload(input: TokenRequestInput): {
  endpoint: string;
  payload: Record<string, string>;
} {
  if (input.type === "admin") {
    if (!input.username?.trim()) {
      throw new Error("username is required for type 'admin'");
    }
    return {
      endpoint: "/rest/V1/integration/admin/token",
      payload: {
        username: input.username.trim(),
        password: input.password
      }
    };
  }

  if (input.type === "customer") {
    if (!input.username?.trim()) {
      throw new Error("username is required for type 'customer'");
    }
    return {
      endpoint: "/rest/V1/integration/customer/token",
      payload: {
        username: input.username.trim(),
        password: input.password
      }
    };
  }

  if (!input.email?.trim()) {
    throw new Error("email is required for type 'staff'");
  }

  return {
    endpoint: "/rest/V1/staff/token",
    payload: {
      email: input.email.trim(),
      password: input.password
    }
  };
}

export async function requestMagentoToken(input: TokenRequestInput): Promise<TokenRequestResult> {
  const { endpoint, payload } = resolveEndpointAndPayload(input);
  const url = `${normalizeBaseUrl(input.baseUrl)}${endpoint}`;

  const response = await performHttpRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload),
    insecureTls: input.insecure
  });

  const parsed = parseJsonLenient(response.bodyText);

  let token = "";
  let error = "";

  if (typeof parsed === "string") {
    token = parsed.trim();
  } else if (isRecord(parsed)) {
    if (typeof parsed.token === "string") {
      token = parsed.token.trim();
    }
    if (!token && typeof parsed.message === "string") {
      error = parsed.message;
    }
    if (!token && typeof parsed.error === "string") {
      error = parsed.error;
    }
  }

  const success = response.statusCode >= 200 && response.statusCode < 300 && token.length > 0;
  if (!success && !error) {
    error = "token could not be extracted";
  }

  return {
    success,
    type: input.type,
    endpoint: url,
    statusCode: response.statusCode,
    token: success ? token : "",
    error: success ? "" : error
  };
}
