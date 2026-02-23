/**
 * @fileoverview Tool definitions for controlling a local camofox-browser server.
 * @module src/mcp-server/tools/definitions/camofox-browser.tool
 */
import fs from 'node:fs';

import { z } from 'zod';

import { config } from '@/config/index.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import type {
  ToolAnnotations,
  ToolDefinition,
} from '@/mcp-server/tools/utils/index.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  fetchWithTimeout,
  type RequestContext,
  logger,
} from '@/utils/index.js';

const TOOL_ANNOTATIONS_READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const TOOL_ANNOTATIONS_MUTATING: ToolAnnotations = {
  readOnlyHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const CAMOFOX_SCOPE = ['tool:camofox:use'];

const SameSiteSchema = z
  .enum(['Strict', 'Lax', 'None'])
  .describe('Cookie SameSite value.');

const CookieSchema = z
  .object({
    name: z.string().min(1).describe('Cookie name.'),
    value: z.string().describe('Cookie value.'),
    domain: z.string().min(1).describe('Cookie domain.'),
    path: z.string().optional().describe('Cookie path.'),
    expires: z
      .number()
      .optional()
      .describe('Cookie expiry as unix timestamp in seconds. Use -1 for session cookies.'),
    httpOnly: z.boolean().optional().describe('Whether the cookie is HttpOnly.'),
    secure: z.boolean().optional().describe('Whether the cookie is Secure.'),
    sameSite: SameSiteSchema.optional(),
  })
  .describe('Playwright-compatible cookie object.');

type CamofoxCookie = z.infer<typeof CookieSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function resolveUserId(userId?: string): string {
  return userId && userId.trim().length > 0
    ? userId
    : config.camofox.defaultUserId;
}

function resolveSessionKey(sessionKey?: string): string {
  return sessionKey && sessionKey.trim().length > 0
    ? sessionKey
    : config.camofox.defaultSessionKey;
}

function buildCamofoxUrl(
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const url = new URL(path, config.camofox.baseUrl);
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined) {
        return;
      }
      url.searchParams.set(key, String(value));
    });
  }
  return url.toString();
}

async function requestCamofoxJson({
  method,
  path,
  appContext,
  body,
  query,
  headers,
}: {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  appContext: RequestContext;
  body?: Record<string, unknown>;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
}): Promise<Record<string, unknown>> {
  const url = buildCamofoxUrl(path, query);
  logger.debug(`Calling camofox endpoint ${method} ${url}`, appContext);

  const response = await fetchWithTimeout(url, config.camofox.timeoutMs, appContext, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const json = (await response.json()) as unknown;
  if (!isRecord(json)) {
    throw new McpError(
      JsonRpcErrorCode.SerializationError,
      `Expected JSON object from camofox endpoint ${path}.`,
      { responseType: typeof json },
    );
  }

  return json;
}

function normalizeCookies(cookies: unknown[]): CamofoxCookie[] {
  return cookies
    .map((cookie): CamofoxCookie | null => {
      if (!isRecord(cookie)) {
        return null;
      }

      const name = getString(cookie.name);
      const value = getString(cookie.value);
      const domain = getString(cookie.domain);

      if (!name || !domain || value === undefined) {
        return null;
      }

      const sameSiteRaw = getString(cookie.sameSite);
      const sameSite =
        sameSiteRaw === 'Strict' || sameSiteRaw === 'Lax' || sameSiteRaw === 'None'
          ? sameSiteRaw
          : undefined;

      const expiresValue =
        getNumber(cookie.expires) ?? getNumber(cookie.expirationDate);

      const normalized: CamofoxCookie = {
        name,
        value,
        domain,
        ...(getString(cookie.path) ? { path: getString(cookie.path) } : {}),
        ...(expiresValue !== undefined ? { expires: expiresValue } : {}),
        ...(getBoolean(cookie.httpOnly) !== undefined
          ? { httpOnly: getBoolean(cookie.httpOnly) }
          : {}),
        ...(getBoolean(cookie.secure) !== undefined
          ? { secure: getBoolean(cookie.secure) }
          : {}),
        ...(sameSite ? { sameSite } : {}),
      };

      return normalized;
    })
    .filter((cookie): cookie is CamofoxCookie => cookie !== null);
}

function loadCookiesFromFile(cookiesFilePath: string): CamofoxCookie[] {
  try {
    const rawText = fs.readFileSync(cookiesFilePath, 'utf-8');
    const parsed = JSON.parse(rawText) as unknown;

    if (Array.isArray(parsed)) {
      return normalizeCookies(parsed);
    }

    if (isRecord(parsed) && Array.isArray(parsed.cookies)) {
      return normalizeCookies(parsed.cookies);
    }

    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'Cookie file must be a JSON array of cookies or an object containing a cookies array.',
      { cookiesFilePath },
    );
  } catch (error: unknown) {
    if (error instanceof McpError) {
      throw error;
    }

    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'Failed to read or parse cookie file.',
      {
        cookiesFilePath,
        cause: error instanceof Error ? error.message : String(error),
      },
      { cause: error },
    );
  }
}

function pickTabId(response: Record<string, unknown>): string | undefined {
  return getString(response.tabId) ?? getString(response.targetId);
}

async function importCookiesIfProvided({
  userId,
  cookies,
  cookiesFilePath,
  appContext,
}: {
  userId: string;
  cookies: CamofoxCookie[] | undefined;
  cookiesFilePath: string | undefined;
  appContext: RequestContext;
}): Promise<{ imported: boolean; count: number; response?: Record<string, unknown> }> {
  const normalizedCookiePath = cookiesFilePath?.trim();
  const fileCookies = normalizedCookiePath
    ? loadCookiesFromFile(normalizedCookiePath)
    : [];
  const allCookies = [...(cookies ?? []), ...fileCookies];

  if (allCookies.length === 0) {
    return { imported: false, count: 0 };
  }

  if (!config.camofox.apiKey) {
    throw new McpError(
      JsonRpcErrorCode.ConfigurationError,
      'CAMOFOX_API_KEY is required to import cookies.',
    );
  }

  const response = await requestCamofoxJson({
    method: 'POST',
    path: `/sessions/${encodeURIComponent(userId)}/cookies`,
    appContext,
    body: { cookies: allCookies },
    headers: { Authorization: `Bearer ${config.camofox.apiKey}` },
  });

  return {
    imported: true,
    count: allCookies.length,
    response,
  };
}

const HealthInputSchema = z
  .object({})
  .describe('No input. Returns health and runtime status from camofox-browser.');

const HealthOutputSchema = z
  .object({
    health: z
      .record(z.string(), z.unknown())
      .describe('Raw health payload returned by camofox-browser.'),
  })
  .describe('Health status result.');

export const camofoxHealthTool: ToolDefinition<
  typeof HealthInputSchema,
  typeof HealthOutputSchema
> = {
  name: 'camofox_health',
  title: 'Camofox Health',
  description:
    'Checks whether the local camofox-browser server is reachable and reports browser runtime status.',
  inputSchema: HealthInputSchema,
  outputSchema: HealthOutputSchema,
  annotations: TOOL_ANNOTATIONS_READ_ONLY,
  logic: withToolAuth(CAMOFOX_SCOPE, async (_input, appContext, _sdkContext) => {
    const health = await requestCamofoxJson({
      method: 'GET',
      path: '/health',
      appContext,
    });

    return { health };
  }),
};

const StartInputSchema = z
  .object({})
  .describe('No input. Starts the camofox browser engine if needed.');

const StartOutputSchema = z
  .object({
    started: z.boolean().describe('Whether the endpoint acknowledged startup.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from the /start endpoint.'),
  })
  .describe('Start browser result.');

export const camofoxStartBrowserTool: ToolDefinition<
  typeof StartInputSchema,
  typeof StartOutputSchema
> = {
  name: 'camofox_start_browser',
  title: 'Camofox Start Browser',
  description:
    'Starts the camofox browser engine and returns startup status for the local server.',
  inputSchema: StartInputSchema,
  outputSchema: StartOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (_input, appContext, _sdkContext) => {
    const response = await requestCamofoxJson({
      method: 'POST',
      path: '/start',
      appContext,
      body: {},
    });

    return {
      started: getBoolean(response.ok) ?? true,
      response,
    };
  }),
};

const ListTabsInputSchema = z
  .object({
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
  })
  .describe('List open tabs for a user session.');

const ListTabsOutputSchema = z
  .object({
    userId: z.string().describe('Resolved user id used for the request.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response returned by /tabs.'),
  })
  .describe('Current open tabs and metadata.');

export const camofoxListTabsTool: ToolDefinition<
  typeof ListTabsInputSchema,
  typeof ListTabsOutputSchema
> = {
  name: 'camofox_list_tabs',
  title: 'Camofox List Tabs',
  description:
    'Lists currently open tabs for a user in camofox-browser, including tab identifiers and URLs.',
  inputSchema: ListTabsInputSchema,
  outputSchema: ListTabsOutputSchema,
  annotations: TOOL_ANNOTATIONS_READ_ONLY,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const userId = resolveUserId(input.userId);
    const response = await requestCamofoxJson({
      method: 'GET',
      path: '/tabs',
      appContext,
      query: { userId },
    });

    return {
      userId,
      response,
    };
  }),
};

const CreateTabInputSchema = z
  .object({
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    sessionKey: z
      .string()
      .optional()
      .describe('Optional session key for grouping tabs. Defaults to CAMOFOX_DEFAULT_SESSION_KEY.'),
    url: z
      .string()
      .url()
      .optional()
      .describe('Optional initial URL to open in the newly created tab.'),
  })
  .describe('Create a new browser tab in camofox-browser.');

const CreateTabOutputSchema = z
  .object({
    userId: z.string().describe('Resolved user id.'),
    sessionKey: z.string().describe('Resolved session key.'),
    tabId: z.string().describe('Created tab id.'),
    url: z.string().describe('Current URL of the tab after creation.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response returned by /tabs.'),
  })
  .describe('New tab creation result.');

export const camofoxCreateTabTool: ToolDefinition<
  typeof CreateTabInputSchema,
  typeof CreateTabOutputSchema
> = {
  name: 'camofox_create_tab',
  title: 'Camofox Create Tab',
  description:
    'Creates a new tab in camofox-browser, optionally navigated to a provided URL.',
  inputSchema: CreateTabInputSchema,
  outputSchema: CreateTabOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const userId = resolveUserId(input.userId);
    const sessionKey = resolveSessionKey(input.sessionKey);
    const response = await requestCamofoxJson({
      method: 'POST',
      path: '/tabs',
      appContext,
      body: {
        userId,
        sessionKey,
        ...(input.url ? { url: input.url } : {}),
      },
    });

    const tabId = pickTabId(response);
    const url = getString(response.url);

    if (!tabId || !url) {
      throw new McpError(
        JsonRpcErrorCode.SerializationError,
        'camofox /tabs response is missing tabId or url.',
        { response },
      );
    }

    return {
      userId,
      sessionKey,
      tabId,
      url,
      response,
    };
  }),
};

const NavigateTabInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id to navigate.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    sessionKey: z
      .string()
      .optional()
      .describe('Optional session key used if the tab is auto-created by /navigate.'),
    url: z.string().url().optional().describe('Direct URL to navigate to.'),
    macro: z
      .string()
      .optional()
      .describe('Optional search macro such as @twitter_search or @google_search.'),
    query: z
      .string()
      .optional()
      .describe('Query text used by macro-based navigation.'),
  })
  .describe('Navigate a tab to a URL or macro target.');

const NavigateTabOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    url: z.string().describe('URL after navigation.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response returned by /tabs/:tabId/navigate.'),
  })
  .describe('Navigation result.');

export const camofoxNavigateTabTool: ToolDefinition<
  typeof NavigateTabInputSchema,
  typeof NavigateTabOutputSchema
> = {
  name: 'camofox_navigate_tab',
  title: 'Camofox Navigate Tab',
  description:
    'Navigates an existing tab to a URL or a supported macro destination in camofox-browser.',
  inputSchema: NavigateTabInputSchema,
  outputSchema: NavigateTabOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    if (!input.url && !input.macro) {
      throw new McpError(
        JsonRpcErrorCode.InvalidParams,
        'Provide either url or macro for navigation.',
      );
    }

    const response = await requestCamofoxJson({
      method: 'POST',
      path: `/tabs/${encodeURIComponent(input.tabId)}/navigate`,
      appContext,
      body: {
        userId: resolveUserId(input.userId),
        ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
        ...(input.url ? { url: input.url } : {}),
        ...(input.macro ? { macro: input.macro } : {}),
        ...(input.query ? { query: input.query } : {}),
      },
    });

    const url = getString(response.url);
    if (!url) {
      throw new McpError(
        JsonRpcErrorCode.SerializationError,
        'camofox navigate response is missing url.',
        { response },
      );
    }

    return {
      tabId: input.tabId,
      url,
      response,
    };
  }),
};

const SnapshotInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id for the snapshot request.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    includeScreenshot: z
      .boolean()
      .optional()
      .describe('If true, includes a base64 screenshot in the response.'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Snapshot pagination offset for long pages.'),
  })
  .describe('Get an accessibility snapshot with stable element refs.');

const SnapshotOutputSchema = z
  .object({
    tabId: z.string().describe('Tab id used for snapshot retrieval.'),
    url: z.string().describe('Page URL represented by this snapshot.'),
    snapshot: z.string().describe('Accessibility snapshot text with refs like e1, e2.'),
    refsCount: z.number().int().describe('Number of interactive refs in the snapshot.'),
    truncated: z.boolean().describe('Whether the snapshot was truncated due to length.'),
    hasMore: z
      .boolean()
      .optional()
      .describe('Whether additional snapshot data is available via offset.'),
    nextOffset: z
      .number()
      .int()
      .optional()
      .describe('Next offset to request if hasMore is true.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response payload from /tabs/:tabId/snapshot.'),
  })
  .describe('Snapshot result.');

export const camofoxGetSnapshotTool: ToolDefinition<
  typeof SnapshotInputSchema,
  typeof SnapshotOutputSchema
> = {
  name: 'camofox_get_snapshot',
  title: 'Camofox Get Snapshot',
  description:
    'Retrieves an accessibility snapshot for a tab, including interactive element refs for reliable automation.',
  inputSchema: SnapshotInputSchema,
  outputSchema: SnapshotOutputSchema,
  annotations: TOOL_ANNOTATIONS_READ_ONLY,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const response = await requestCamofoxJson({
      method: 'GET',
      path: `/tabs/${encodeURIComponent(input.tabId)}/snapshot`,
      appContext,
      query: {
        userId: resolveUserId(input.userId),
        includeScreenshot: input.includeScreenshot,
        offset: input.offset,
      },
    });

    const url = getString(response.url);
    const snapshot = getString(response.snapshot);
    const refsCount = getNumber(response.refsCount);
    const truncated = getBoolean(response.truncated);

    if (!url || snapshot === undefined || refsCount === undefined || truncated === undefined) {
      throw new McpError(
        JsonRpcErrorCode.SerializationError,
        'Snapshot response did not include required fields.',
        { response },
      );
    }

    return {
      tabId: input.tabId,
      url,
      snapshot,
      refsCount,
      truncated,
      hasMore: getBoolean(response.hasMore),
      nextOffset: getNumber(response.nextOffset),
      response,
    };
  }),
};

const ClickInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id where the click should happen.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    ref: z
      .string()
      .optional()
      .describe('Snapshot element ref such as e1. Preferred over CSS selectors.'),
    selector: z
      .string()
      .optional()
      .describe('Fallback CSS selector if no ref is available.'),
  })
  .describe('Click an element in a tab by ref or selector.');

const ClickOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    url: z
      .string()
      .optional()
      .describe('Current URL after click, if returned by camofox-browser.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from /tabs/:tabId/click.'),
  })
  .describe('Click action result.');

export const camofoxClickTool: ToolDefinition<
  typeof ClickInputSchema,
  typeof ClickOutputSchema
> = {
  name: 'camofox_click',
  title: 'Camofox Click',
  description:
    'Clicks a page element in the target tab using either a snapshot ref or CSS selector.',
  inputSchema: ClickInputSchema,
  outputSchema: ClickOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    if (!input.ref && !input.selector) {
      throw new McpError(
        JsonRpcErrorCode.InvalidParams,
        'Provide either ref or selector for click.',
      );
    }

    const response = await requestCamofoxJson({
      method: 'POST',
      path: `/tabs/${encodeURIComponent(input.tabId)}/click`,
      appContext,
      body: {
        userId: resolveUserId(input.userId),
        ...(input.ref ? { ref: input.ref } : {}),
        ...(input.selector ? { selector: input.selector } : {}),
      },
    });

    return {
      tabId: input.tabId,
      ...(getString(response.url) ? { url: getString(response.url) } : {}),
      response,
    };
  }),
};

const TypeInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id where typing should happen.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    text: z.string().describe('Text to type.'),
    ref: z
      .string()
      .optional()
      .describe('Snapshot element ref where text should be typed.'),
    selector: z
      .string()
      .optional()
      .describe('Fallback CSS selector for typing.'),
    pressEnter: z
      .boolean()
      .optional()
      .describe('If true, presses Enter after typing completes.'),
  })
  .describe('Type text into an input element, optionally followed by Enter.');

const TypeOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    typed: z.boolean().describe('Whether the type request completed.'),
    pressedEnter: z.boolean().describe('Whether Enter was pressed afterwards.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from /tabs/:tabId/type.'),
    pressResponse: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Raw response from /tabs/:tabId/press when pressEnter=true.'),
  })
  .describe('Type action result.');

export const camofoxTypeTool: ToolDefinition<
  typeof TypeInputSchema,
  typeof TypeOutputSchema
> = {
  name: 'camofox_type',
  title: 'Camofox Type',
  description:
    'Types text into an element identified by ref or selector, with optional Enter key submission.',
  inputSchema: TypeInputSchema,
  outputSchema: TypeOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    if (!input.ref && !input.selector) {
      throw new McpError(
        JsonRpcErrorCode.InvalidParams,
        'Provide either ref or selector for typing.',
      );
    }

    const userId = resolveUserId(input.userId);
    const response = await requestCamofoxJson({
      method: 'POST',
      path: `/tabs/${encodeURIComponent(input.tabId)}/type`,
      appContext,
      body: {
        userId,
        text: input.text,
        ...(input.ref ? { ref: input.ref } : {}),
        ...(input.selector ? { selector: input.selector } : {}),
      },
    });

    const pressResponse = input.pressEnter
      ? await requestCamofoxJson({
          method: 'POST',
          path: `/tabs/${encodeURIComponent(input.tabId)}/press`,
          appContext,
          body: {
            userId,
            key: 'Enter',
          },
        })
      : undefined;

    return {
      tabId: input.tabId,
      typed: true,
      pressedEnter: Boolean(input.pressEnter),
      response,
      ...(pressResponse ? { pressResponse } : {}),
    };
  }),
};

const ScrollInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id to scroll.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    direction: z
      .enum(['up', 'down'])
      .default('down')
      .describe('Scroll direction.'),
    amount: z
      .number()
      .int()
      .min(1)
      .default(700)
      .describe('Scroll amount in pixels.'),
  })
  .describe('Scroll the active page within a tab.');

const ScrollOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from /tabs/:tabId/scroll.'),
  })
  .describe('Scroll action result.');

export const camofoxScrollTool: ToolDefinition<
  typeof ScrollInputSchema,
  typeof ScrollOutputSchema
> = {
  name: 'camofox_scroll',
  title: 'Camofox Scroll',
  description:
    'Scrolls a tab vertically by a configurable amount, useful for loading additional content.',
  inputSchema: ScrollInputSchema,
  outputSchema: ScrollOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const response = await requestCamofoxJson({
      method: 'POST',
      path: `/tabs/${encodeURIComponent(input.tabId)}/scroll`,
      appContext,
      body: {
        userId: resolveUserId(input.userId),
        direction: input.direction,
        amount: input.amount,
      },
    });

    return {
      tabId: input.tabId,
      response,
    };
  }),
};

const CloseTabInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id to close.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
  })
  .describe('Close a tab in camofox-browser.');

const CloseTabOutputSchema = z
  .object({
    tabId: z.string().describe('Closed tab id.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from DELETE /tabs/:tabId.'),
  })
  .describe('Close tab result.');

export const camofoxCloseTabTool: ToolDefinition<
  typeof CloseTabInputSchema,
  typeof CloseTabOutputSchema
> = {
  name: 'camofox_close_tab',
  title: 'Camofox Close Tab',
  description:
    'Closes an open tab and frees related resources in the selected user session.',
  inputSchema: CloseTabInputSchema,
  outputSchema: CloseTabOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const response = await requestCamofoxJson({
      method: 'DELETE',
      path: `/tabs/${encodeURIComponent(input.tabId)}`,
      appContext,
      body: {
        userId: resolveUserId(input.userId),
      },
    });

    return {
      tabId: input.tabId,
      response,
    };
  }),
};

const ImportCookiesInputSchema = z
  .object({
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    cookies: z
      .array(CookieSchema)
      .optional()
      .describe('Cookie objects to import directly.'),
    cookiesFilePath: z
      .string()
      .optional()
      .describe('Path to a JSON cookie export file. Supports array format and {cookies:[...]} format.'),
  })
  .describe('Import cookies into camofox-browser for authenticated sessions.');

const ImportCookiesOutputSchema = z
  .object({
    userId: z.string().describe('Resolved user id receiving cookies.'),
    imported: z.boolean().describe('Whether any cookies were imported.'),
    count: z.number().int().describe('Number of cookies submitted.'),
    response: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Raw response from /sessions/:userId/cookies when imported=true.'),
  })
  .describe('Cookie import result.');

export const camofoxImportCookiesTool: ToolDefinition<
  typeof ImportCookiesInputSchema,
  typeof ImportCookiesOutputSchema
> = {
  name: 'camofox_import_cookies',
  title: 'Camofox Import Cookies',
  description:
    'Imports cookies into a camofox-browser session from direct input or a local JSON cookie file.',
  inputSchema: ImportCookiesInputSchema,
  outputSchema: ImportCookiesOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const userId = resolveUserId(input.userId);
    const imported = await importCookiesIfProvided({
      userId,
      cookies: input.cookies,
      cookiesFilePath: input.cookiesFilePath,
      appContext,
    });

    return {
      userId,
      imported: imported.imported,
      count: imported.count,
      ...(imported.response ? { response: imported.response } : {}),
    };
  }),
};
