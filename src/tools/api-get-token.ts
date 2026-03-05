import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requestMagentoToken } from "../core/magento-auth.js";

interface ApiGetTokenOptions {
  defaultMagentoBaseUrl: string;
}

export function registerApiGetTokenTool(server: McpServer, options: ApiGetTokenOptions): void {
  server.registerTool(
    "api-get-token",
    {
      title: "API Get Token",
      description: "Create admin/staff/customer token directly via Magento REST endpoints",
      inputSchema: {
        type: z.enum(["admin", "staff", "customer"]).describe("Token type"),
        password: z.string().describe("Password for the selected account"),
        username: z.string().optional().describe("Username/email for admin/customer"),
        email: z.string().optional().describe("Email for staff token"),
        baseUrl: z
          .string()
          .default(options.defaultMagentoBaseUrl)
          .describe(`Magento base URL (default: ${options.defaultMagentoBaseUrl})`),
        insecure: z.boolean().default(true).describe("Allow insecure TLS certificates")
      }
    },
    async ({ type, password, username, email, baseUrl = options.defaultMagentoBaseUrl, insecure = true }) => {
      try {
        const tokenResult = await requestMagentoToken({
          type,
          password,
          username,
          email,
          baseUrl,
          insecure
        });

        const payload = {
          success: tokenResult.success,
          type: tokenResult.type,
          endpoint: tokenResult.endpoint,
          statusCode: tokenResult.statusCode,
          token: tokenResult.token,
          error: tokenResult.error
        };

        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          isError: !payload.success
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              type,
              endpoint: "",
              statusCode: 0,
              token: "",
              error: error instanceof Error ? error.message : String(error)
            }, null, 2)
          }],
          isError: true
        };
      }
    }
  );
}
