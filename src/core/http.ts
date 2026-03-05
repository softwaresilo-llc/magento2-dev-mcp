export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function withTemporaryInsecureTls<T>(
  insecureTls: boolean,
  fn: () => Promise<T>
): Promise<T> {
  const previousTlsValue = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (insecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  try {
    return await fn();
  } finally {
    if (!insecureTls) {
      // no-op
    } else if (previousTlsValue === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsValue;
    }
  }
}

export interface HttpRequestResult {
  statusCode: number;
  statusText: string;
  bodyText: string;
}

export async function performHttpRequest(
  url: string,
  options: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    insecureTls?: boolean;
  }
): Promise<HttpRequestResult> {
  const insecureTls = options.insecureTls ?? true;

  return await withTemporaryInsecureTls(insecureTls, async () => {
    const response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body
    });

    const bodyText = await response.text();
    return {
      statusCode: response.status,
      statusText: response.statusText,
      bodyText
    };
  });
}

export function parseJsonLenient(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}
