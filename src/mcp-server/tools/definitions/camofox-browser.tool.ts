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

const WEB_SEARCH_MACROS = {
  google: '@google_search',
  youtube: '@youtube_search',
  amazon: '@amazon_search',
  reddit: '@reddit_search',
  wikipedia: '@wikipedia_search',
  twitter: '@twitter_search',
  yelp: '@yelp_search',
  spotify: '@spotify_search',
  netflix: '@netflix_search',
  linkedin: '@linkedin_search',
  instagram: '@instagram_search',
  tiktok: '@tiktok_search',
  twitch: '@twitch_search',
} as const;

const WebSearchEngineSchema = z
  .enum([
    'google',
    'youtube',
    'amazon',
    'reddit',
    'wikipedia',
    'twitter',
    'yelp',
    'spotify',
    'netflix',
    'linkedin',
    'instagram',
    'tiktok',
    'twitch',
  ])
  .describe('Search engine selector mapped to a camofox macro.');

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

  const json = (await response.json());
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

async function requestCamofoxBinary({
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
}): Promise<{ buffer: Buffer; contentType: string | null }> {
  const url = buildCamofoxUrl(path, query);
  logger.debug(`Calling camofox binary endpoint ${method} ${url}`, appContext);

  const response = await fetchWithTimeout(url, config.camofox.timeoutMs, appContext, {
    method,
    headers: {
      Accept: '*/*',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type'),
  };
}

async function requestCamofoxAct({
  tabId,
  userId,
  appContext,
  kind,
  params,
}: {
  tabId: string;
  userId: string;
  appContext: RequestContext;
  kind: string;
  params?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  return requestCamofoxJson({
    method: 'POST',
    path: '/act',
    appContext,
    body: {
      kind,
      targetId: tabId,
      userId,
      ...(params ?? {}),
    },
  });
}

const PressInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id where keypress should happen.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    key: z.string().min(1).describe('Keyboard key to press (for example Enter, Escape, ArrowDown).'),
  })
  .describe('Press a keyboard key in the active tab context.');

const PressOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    key: z.string().describe('Pressed key.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from /tabs/:tabId/press.'),
  })
  .describe('Keypress action result.');

export const camofoxPressTool: ToolDefinition<
  typeof PressInputSchema,
  typeof PressOutputSchema
> = {
  name: 'camofox_press',
  title: 'Camofox Press Key',
  description:
    'Presses a keyboard key in the target tab (for example Enter, Escape, ArrowDown).',
  inputSchema: PressInputSchema,
  outputSchema: PressOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const response = await requestCamofoxJson({
      method: 'POST',
      path: `/tabs/${encodeURIComponent(input.tabId)}/press`,
      appContext,
      body: {
        userId: resolveUserId(input.userId),
        key: input.key,
      },
    });

    return {
      tabId: input.tabId,
      key: input.key,
      response,
    };
  }),
};

const WaitInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id to wait on.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(120000)
      .default(10000)
      .describe('Maximum wait time in milliseconds.'),
    waitForNetwork: z
      .boolean()
      .default(true)
      .describe('If true, also waits for network idle when possible.'),
  })
  .describe('Wait until page is ready after navigation or dynamic updates.');

const WaitOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    ready: z.boolean().describe('Whether the page reached ready state.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from /tabs/:tabId/wait.'),
  })
  .describe('Page readiness wait result.');

export const camofoxWaitTool: ToolDefinition<
  typeof WaitInputSchema,
  typeof WaitOutputSchema
> = {
  name: 'camofox_wait',
  title: 'Camofox Wait',
  description:
    'Waits for the target tab page to settle, useful after navigations and async content updates.',
  inputSchema: WaitInputSchema,
  outputSchema: WaitOutputSchema,
  annotations: TOOL_ANNOTATIONS_READ_ONLY,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const response = await requestCamofoxJson({
      method: 'POST',
      path: `/tabs/${encodeURIComponent(input.tabId)}/wait`,
      appContext,
      body: {
        userId: resolveUserId(input.userId),
        timeout: input.timeoutMs,
        waitForNetwork: input.waitForNetwork,
      },
    });

    return {
      tabId: input.tabId,
      ready: getBoolean(response.ready) ?? false,
      response,
    };
  }),
};

const HistoryNavInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id to navigate in history.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
  })
  .describe('Navigate browser history within a tab.');

const HistoryNavOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    url: z.string().optional().describe('Current URL after the history action.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from the history endpoint.'),
  })
  .describe('History navigation result.');

export const camofoxBackTool: ToolDefinition<
  typeof HistoryNavInputSchema,
  typeof HistoryNavOutputSchema
> = {
  name: 'camofox_back',
  title: 'Camofox Back',
  description: 'Navigates one step back in the tab history.',
  inputSchema: HistoryNavInputSchema,
  outputSchema: HistoryNavOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const response = await requestCamofoxJson({
      method: 'POST',
      path: `/tabs/${encodeURIComponent(input.tabId)}/back`,
      appContext,
      body: { userId: resolveUserId(input.userId) },
    });

    return {
      tabId: input.tabId,
      ...(getString(response.url) ? { url: getString(response.url) } : {}),
      response,
    };
  }),
};

export const camofoxForwardTool: ToolDefinition<
  typeof HistoryNavInputSchema,
  typeof HistoryNavOutputSchema
> = {
  name: 'camofox_forward',
  title: 'Camofox Forward',
  description: 'Navigates one step forward in the tab history.',
  inputSchema: HistoryNavInputSchema,
  outputSchema: HistoryNavOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const response = await requestCamofoxJson({
      method: 'POST',
      path: `/tabs/${encodeURIComponent(input.tabId)}/forward`,
      appContext,
      body: { userId: resolveUserId(input.userId) },
    });

    return {
      tabId: input.tabId,
      ...(getString(response.url) ? { url: getString(response.url) } : {}),
      response,
    };
  }),
};

export const camofoxRefreshTool: ToolDefinition<
  typeof HistoryNavInputSchema,
  typeof HistoryNavOutputSchema
> = {
  name: 'camofox_refresh',
  title: 'Camofox Refresh',
  description: 'Reloads the current page in the target tab.',
  inputSchema: HistoryNavInputSchema,
  outputSchema: HistoryNavOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const response = await requestCamofoxJson({
      method: 'POST',
      path: `/tabs/${encodeURIComponent(input.tabId)}/refresh`,
      appContext,
      body: { userId: resolveUserId(input.userId) },
    });

    return {
      tabId: input.tabId,
      ...(getString(response.url) ? { url: getString(response.url) } : {}),
      response,
    };
  }),
};

const LinkItemSchema = z
  .object({
    url: z.string().describe('Absolute URL for the extracted link.'),
    text: z.string().describe('Link text content (possibly empty).'),
  })
  .describe('Extracted page link item.');

const GetLinksInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id where links should be extracted.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe('Maximum number of links to return in this page.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Offset into the extracted links list.'),
  })
  .describe('Extract links from the current page with pagination support.');

const GetLinksOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    links: z.array(LinkItemSchema).describe('Extracted link items.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from /tabs/:tabId/links.'),
  })
  .describe('Link extraction result.');

export const camofoxGetLinksTool: ToolDefinition<
  typeof GetLinksInputSchema,
  typeof GetLinksOutputSchema
> = {
  name: 'camofox_get_links',
  title: 'Camofox Get Links',
  description: 'Extracts and paginates HTTP links from the current tab page.',
  inputSchema: GetLinksInputSchema,
  outputSchema: GetLinksOutputSchema,
  annotations: TOOL_ANNOTATIONS_READ_ONLY,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const response = await requestCamofoxJson({
      method: 'GET',
      path: `/tabs/${encodeURIComponent(input.tabId)}/links`,
      appContext,
      query: {
        userId: resolveUserId(input.userId),
        limit: input.limit,
        offset: input.offset,
      },
    });

    const links = Array.isArray(response.links)
      ? response.links
          .filter((entry): entry is Record<string, unknown> => isRecord(entry))
          .map((entry) => ({
            url: getString(entry.url) ?? '',
            text: getString(entry.text) ?? '',
          }))
      : [];

    return {
      tabId: input.tabId,
      links,
      response,
    };
  }),
};

const ScreenshotInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id for screenshot capture.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    fullPage: z
      .boolean()
      .default(false)
      .describe('If true, captures the full scrollable page.'),
  })
  .describe('Capture a PNG screenshot from the target tab.');

const ScreenshotOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    mimeType: z.string().describe('MIME type reported by the endpoint.'),
    imageBase64: z.string().describe('Base64 encoded PNG screenshot payload.'),
    bytes: z.number().int().describe('Binary screenshot payload size in bytes.'),
  })
  .describe('Screenshot capture result.');

export const camofoxScreenshotTool: ToolDefinition<
  typeof ScreenshotInputSchema,
  typeof ScreenshotOutputSchema
> = {
  name: 'camofox_screenshot',
  title: 'Camofox Screenshot',
  description: 'Captures a PNG screenshot for the target tab.',
  inputSchema: ScreenshotInputSchema,
  outputSchema: ScreenshotOutputSchema,
  annotations: TOOL_ANNOTATIONS_READ_ONLY,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const binary = await requestCamofoxBinary({
      method: 'GET',
      path: `/tabs/${encodeURIComponent(input.tabId)}/screenshot`,
      appContext,
      query: {
        userId: resolveUserId(input.userId),
        fullPage: input.fullPage,
      },
    });

    return {
      tabId: input.tabId,
      mimeType: binary.contentType ?? 'image/png',
      imageBase64: binary.buffer.toString('base64'),
      bytes: binary.buffer.byteLength,
    };
  }),
};

const StatsInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id to inspect.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
  })
  .describe('Fetch tab statistics and usage metadata.');

const StatsOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    url: z.string().optional().describe('Current tab URL.'),
    sessionKey: z.string().optional().describe('Session key/tab group identifier.'),
    listItemId: z.string().optional().describe('Legacy alias for session key.'),
    visitedUrls: z.array(z.string()).describe('Previously visited URLs tracked for the tab.'),
    toolCalls: z.number().int().describe('Number of interactions performed on this tab.'),
    refsCount: z.number().int().describe('Number of active element refs currently tracked.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from /tabs/:tabId/stats.'),
  })
  .describe('Tab statistics result.');

export const camofoxGetStatsTool: ToolDefinition<
  typeof StatsInputSchema,
  typeof StatsOutputSchema
> = {
  name: 'camofox_get_stats',
  title: 'Camofox Get Stats',
  description: 'Returns per-tab stats including visited URLs, tool call count, and ref count.',
  inputSchema: StatsInputSchema,
  outputSchema: StatsOutputSchema,
  annotations: TOOL_ANNOTATIONS_READ_ONLY,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const response = await requestCamofoxJson({
      method: 'GET',
      path: `/tabs/${encodeURIComponent(input.tabId)}/stats`,
      appContext,
      query: { userId: resolveUserId(input.userId) },
    });

    const visitedUrls = Array.isArray(response.visitedUrls)
      ? response.visitedUrls.filter((entry): entry is string => typeof entry === 'string')
      : [];

    return {
      tabId: input.tabId,
      ...(getString(response.url) ? { url: getString(response.url) } : {}),
      ...(getString(response.sessionKey)
        ? { sessionKey: getString(response.sessionKey) }
        : {}),
      ...(getString(response.listItemId)
        ? { listItemId: getString(response.listItemId) }
        : {}),
      visitedUrls,
      toolCalls: getNumber(response.toolCalls) ?? 0,
      refsCount: getNumber(response.refsCount) ?? 0,
      response,
    };
  }),
};

const CloseGroupInputSchema = z
  .object({
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    sessionKey: z
      .string()
      .optional()
      .describe('Preferred tab group identifier to close.'),
    listItemId: z
      .string()
      .optional()
      .describe('Legacy tab group identifier alias for sessionKey.'),
  })
  .describe('Close all tabs in a tab group/session key.');

const CloseGroupOutputSchema = z
  .object({
    userId: z.string().describe('Resolved user id.'),
    sessionKey: z.string().describe('Closed group key.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from DELETE /tabs/group/:listItemId.'),
  })
  .describe('Close tab group result.');

export const camofoxCloseTabGroupTool: ToolDefinition<
  typeof CloseGroupInputSchema,
  typeof CloseGroupOutputSchema
> = {
  name: 'camofox_close_tab_group',
  title: 'Camofox Close Tab Group',
  description: 'Closes every tab in a specific session key/tab group.',
  inputSchema: CloseGroupInputSchema,
  outputSchema: CloseGroupOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const sessionKey = input.sessionKey ?? input.listItemId;
    if (!sessionKey || sessionKey.trim().length === 0) {
      throw new McpError(
        JsonRpcErrorCode.InvalidParams,
        'Provide sessionKey or listItemId to close a tab group.',
      );
    }

    const userId = resolveUserId(input.userId);
    const response = await requestCamofoxJson({
      method: 'DELETE',
      path: `/tabs/group/${encodeURIComponent(sessionKey)}`,
      appContext,
      body: { userId },
    });

    return {
      userId,
      sessionKey,
      response,
    };
  }),
};

const CloseSessionInputSchema = z
  .object({
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
  })
  .describe('Close an entire user browser session and all related tabs.');

const CloseSessionOutputSchema = z
  .object({
    userId: z.string().describe('Closed user id.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from DELETE /sessions/:userId.'),
  })
  .describe('Close session result.');

export const camofoxCloseSessionTool: ToolDefinition<
  typeof CloseSessionInputSchema,
  typeof CloseSessionOutputSchema
> = {
  name: 'camofox_close_session',
  title: 'Camofox Close Session',
  description: 'Closes all tabs and browser context state for a user session.',
  inputSchema: CloseSessionInputSchema,
  outputSchema: CloseSessionOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const userId = resolveUserId(input.userId);
    const response = await requestCamofoxJson({
      method: 'DELETE',
      path: `/sessions/${encodeURIComponent(userId)}`,
      appContext,
    });

    return {
      userId,
      response,
    };
  }),
};

const HoverInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id where hover should happen.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    ref: z
      .string()
      .optional()
      .describe('Snapshot element ref such as e1. Preferred over CSS selector.'),
    selector: z
      .string()
      .optional()
      .describe('Fallback CSS selector when ref is unavailable.'),
  })
  .describe('Hover over an element to trigger tooltips, menus, or hover states.');

const HoverOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    hovered: z.boolean().describe('Whether hover was acknowledged.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from /act hover action.'),
  })
  .describe('Hover action result.');

export const camofoxHoverTool: ToolDefinition<
  typeof HoverInputSchema,
  typeof HoverOutputSchema
> = {
  name: 'camofox_hover',
  title: 'Camofox Hover',
  description:
    'Hovers over a page element using either a snapshot ref or CSS selector.',
  inputSchema: HoverInputSchema,
  outputSchema: HoverOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    if (!input.ref && !input.selector) {
      throw new McpError(
        JsonRpcErrorCode.InvalidParams,
        'Provide either ref or selector for hover.',
      );
    }

    const response = await requestCamofoxAct({
      tabId: input.tabId,
      userId: resolveUserId(input.userId),
      appContext,
      kind: 'hover',
      params: {
        ...(input.ref ? { ref: input.ref } : {}),
        ...(input.selector ? { selector: input.selector } : {}),
      },
    });

    return {
      tabId: input.tabId,
      hovered: getBoolean(response.ok) ?? true,
      response,
    };
  }),
};

const ScrollElementInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id containing the target scrollable element.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    ref: z
      .string()
      .describe('Element ref to scroll into view, typically from camofox_get_snapshot.'),
  })
  .describe('Scroll an element into view using its snapshot ref.');

const ScrollElementOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    scrolled: z.boolean().describe('Whether scroll action was acknowledged.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from /act scrollIntoView action.'),
  })
  .describe('Element scroll result.');

export const camofoxScrollElementTool: ToolDefinition<
  typeof ScrollElementInputSchema,
  typeof ScrollElementOutputSchema
> = {
  name: 'camofox_scroll_element',
  title: 'Camofox Scroll Element',
  description: 'Scrolls a referenced element into view within the active tab.',
  inputSchema: ScrollElementInputSchema,
  outputSchema: ScrollElementOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const response = await requestCamofoxAct({
      tabId: input.tabId,
      userId: resolveUserId(input.userId),
      appContext,
      kind: 'scrollIntoView',
      params: { ref: input.ref },
    });

    return {
      tabId: input.tabId,
      scrolled: getBoolean(response.ok) ?? true,
      response,
    };
  }),
};

const WaitForTextInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id to monitor for text appearance.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    text: z.string().min(1).describe('Text to wait for on the page.'),
  })
  .describe('Wait until specific text appears in the page.');

const WaitForTextOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    matched: z.boolean().describe('Whether the text wait operation completed.'),
    url: z.string().optional().describe('Current URL when wait finished.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from /act wait action.'),
  })
  .describe('Wait-for-text result.');

export const camofoxWaitForTextTool: ToolDefinition<
  typeof WaitForTextInputSchema,
  typeof WaitForTextOutputSchema
> = {
  name: 'camofox_wait_for_text',
  title: 'Camofox Wait For Text',
  description: 'Waits for specific text to appear in a tab using backend /act wait.',
  inputSchema: WaitForTextInputSchema,
  outputSchema: WaitForTextOutputSchema,
  annotations: TOOL_ANNOTATIONS_READ_ONLY,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const response = await requestCamofoxAct({
      tabId: input.tabId,
      userId: resolveUserId(input.userId),
      appContext,
      kind: 'wait',
      params: { text: input.text },
    });

    return {
      tabId: input.tabId,
      matched: getBoolean(response.ok) ?? true,
      ...(getString(response.url) ? { url: getString(response.url) } : {}),
      response,
    };
  }),
};

const NavigateAndSnapshotInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id to navigate before snapshot capture.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    sessionKey: z
      .string()
      .optional()
      .describe('Optional session key used if navigate auto-creates tab context.'),
    url: z.string().url().optional().describe('Direct URL target.'),
    macro: z.string().optional().describe('Macro target such as @google_search.'),
    query: z.string().optional().describe('Macro query value.'),
    waitTimeoutMs: z
      .number()
      .int()
      .min(1)
      .max(120000)
      .default(10000)
      .describe('Maximum wait time in milliseconds after navigation.'),
    waitForNetwork: z
      .boolean()
      .default(true)
      .describe('If true, includes network-idle wait before snapshot.'),
    includeScreenshot: z
      .boolean()
      .optional()
      .describe('If true, includes base64 screenshot payload in snapshot response.'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Optional snapshot offset for large pages.'),
  })
  .describe('Navigate to a target and immediately return a fresh snapshot.');

const NavigateAndSnapshotOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    url: z.string().describe('Final URL represented by the snapshot.'),
    snapshot: z.string().describe('Accessibility snapshot text.'),
    refsCount: z.number().int().describe('Number of refs captured in snapshot.'),
    truncated: z.boolean().describe('Whether snapshot output was truncated.'),
    hasMore: z.boolean().optional().describe('Whether more snapshot chunks are available.'),
    nextOffset: z.number().int().optional().describe('Next snapshot offset if available.'),
    navigateResponse: z
      .record(z.string(), z.unknown())
      .describe('Raw response from navigate call.'),
    waitResponse: z
      .record(z.string(), z.unknown())
      .describe('Raw response from wait call.'),
    snapshotResponse: z
      .record(z.string(), z.unknown())
      .describe('Raw response from snapshot call.'),
  })
  .describe('Combined navigate, wait, snapshot result.');

export const camofoxNavigateAndSnapshotTool: ToolDefinition<
  typeof NavigateAndSnapshotInputSchema,
  typeof NavigateAndSnapshotOutputSchema
> = {
  name: 'navigate_and_snapshot',
  title: 'Camofox Navigate And Snapshot',
  description:
    'Navigates to a URL or macro target, waits for readiness, then captures a snapshot.',
  inputSchema: NavigateAndSnapshotInputSchema,
  outputSchema: NavigateAndSnapshotOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    if (!input.url && !input.macro) {
      throw new McpError(
        JsonRpcErrorCode.InvalidParams,
        'Provide either url or macro for navigate_and_snapshot.',
      );
    }

    const userId = resolveUserId(input.userId);

    const navigateResponse = await requestCamofoxJson({
      method: 'POST',
      path: `/tabs/${encodeURIComponent(input.tabId)}/navigate`,
      appContext,
      body: {
        userId,
        ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
        ...(input.url ? { url: input.url } : {}),
        ...(input.macro ? { macro: input.macro } : {}),
        ...(input.query ? { query: input.query } : {}),
      },
    });

    const waitResponse = await requestCamofoxJson({
      method: 'POST',
      path: `/tabs/${encodeURIComponent(input.tabId)}/wait`,
      appContext,
      body: {
        userId,
        timeout: input.waitTimeoutMs,
        waitForNetwork: input.waitForNetwork,
      },
    });

    const snapshotResponse = await requestCamofoxJson({
      method: 'GET',
      path: `/tabs/${encodeURIComponent(input.tabId)}/snapshot`,
      appContext,
      query: {
        userId,
        includeScreenshot: input.includeScreenshot,
        offset: input.offset,
      },
    });

    const url = getString(snapshotResponse.url);
    const snapshot = getString(snapshotResponse.snapshot);
    const refsCount = getNumber(snapshotResponse.refsCount);
    const truncated = getBoolean(snapshotResponse.truncated);

    if (!url || snapshot === undefined || refsCount === undefined || truncated === undefined) {
      throw new McpError(
        JsonRpcErrorCode.SerializationError,
        'navigate_and_snapshot could not parse snapshot response fields.',
        { snapshotResponse },
      );
    }

    return {
      tabId: input.tabId,
      url,
      snapshot,
      refsCount,
      truncated,
      hasMore: getBoolean(snapshotResponse.hasMore),
      nextOffset: getNumber(snapshotResponse.nextOffset),
      navigateResponse,
      waitResponse,
      snapshotResponse,
    };
  }),
};

const ScrollAndSnapshotInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id to scroll before snapshot capture.'),
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
    includeScreenshot: z
      .boolean()
      .optional()
      .describe('If true, includes screenshot payload in snapshot response.'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Optional snapshot offset for large pages.'),
  })
  .describe('Scroll a page and immediately return an updated snapshot.');

const ScrollAndSnapshotOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    url: z.string().describe('URL represented by the snapshot.'),
    snapshot: z.string().describe('Accessibility snapshot text.'),
    refsCount: z.number().int().describe('Number of refs captured in snapshot.'),
    truncated: z.boolean().describe('Whether snapshot output was truncated.'),
    hasMore: z.boolean().optional().describe('Whether more snapshot chunks are available.'),
    nextOffset: z.number().int().optional().describe('Next snapshot offset if available.'),
    scrollResponse: z
      .record(z.string(), z.unknown())
      .describe('Raw response from scroll call.'),
    snapshotResponse: z
      .record(z.string(), z.unknown())
      .describe('Raw response from snapshot call.'),
  })
  .describe('Combined scroll and snapshot result.');

export const camofoxScrollAndSnapshotTool: ToolDefinition<
  typeof ScrollAndSnapshotInputSchema,
  typeof ScrollAndSnapshotOutputSchema
> = {
  name: 'scroll_and_snapshot',
  title: 'Camofox Scroll And Snapshot',
  description: 'Scrolls the page and returns a fresh snapshot in one call.',
  inputSchema: ScrollAndSnapshotInputSchema,
  outputSchema: ScrollAndSnapshotOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const userId = resolveUserId(input.userId);

    const scrollResponse = await requestCamofoxJson({
      method: 'POST',
      path: `/tabs/${encodeURIComponent(input.tabId)}/scroll`,
      appContext,
      body: {
        userId,
        direction: input.direction,
        amount: input.amount,
      },
    });

    const snapshotResponse = await requestCamofoxJson({
      method: 'GET',
      path: `/tabs/${encodeURIComponent(input.tabId)}/snapshot`,
      appContext,
      query: {
        userId,
        includeScreenshot: input.includeScreenshot,
        offset: input.offset,
      },
    });

    const url = getString(snapshotResponse.url);
    const snapshot = getString(snapshotResponse.snapshot);
    const refsCount = getNumber(snapshotResponse.refsCount);
    const truncated = getBoolean(snapshotResponse.truncated);

    if (!url || snapshot === undefined || refsCount === undefined || truncated === undefined) {
      throw new McpError(
        JsonRpcErrorCode.SerializationError,
        'scroll_and_snapshot could not parse snapshot response fields.',
        { snapshotResponse },
      );
    }

    return {
      tabId: input.tabId,
      url,
      snapshot,
      refsCount,
      truncated,
      hasMore: getBoolean(snapshotResponse.hasMore),
      nextOffset: getNumber(snapshotResponse.nextOffset),
      scrollResponse,
      snapshotResponse,
    };
  }),
};

const TypeAndSubmitInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id where typing should happen.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    text: z.string().describe('Text to type before submit keypress.'),
    ref: z.string().optional().describe('Snapshot element ref to target.'),
    selector: z.string().optional().describe('Fallback CSS selector.'),
    submitKey: z.string().min(1).default('Enter').describe('Keyboard key used for submission.'),
  })
  .describe('Type into an input and submit with a keypress in one call.');

const TypeAndSubmitOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    typed: z.boolean().describe('Whether typing request succeeded.'),
    submitKey: z.string().describe('Key used for submission.'),
    typeResponse: z
      .record(z.string(), z.unknown())
      .describe('Raw response from /tabs/:tabId/type.'),
    pressResponse: z
      .record(z.string(), z.unknown())
      .describe('Raw response from /tabs/:tabId/press.'),
  })
  .describe('Type-and-submit result.');

export const typeAndSubmitTool: ToolDefinition<
  typeof TypeAndSubmitInputSchema,
  typeof TypeAndSubmitOutputSchema
> = {
  name: 'type_and_submit',
  title: 'Camofox Type And Submit',
  description:
    'Types text into an input and sends a submit keypress (default Enter) in one call.',
  inputSchema: TypeAndSubmitInputSchema,
  outputSchema: TypeAndSubmitOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    if (!input.ref && !input.selector) {
      throw new McpError(
        JsonRpcErrorCode.InvalidParams,
        'Provide either ref or selector for type_and_submit.',
      );
    }

    const userId = resolveUserId(input.userId);
    const typeResponse = await requestCamofoxJson({
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

    const pressResponse = await requestCamofoxJson({
      method: 'POST',
      path: `/tabs/${encodeURIComponent(input.tabId)}/press`,
      appContext,
      body: {
        userId,
        key: input.submitKey,
      },
    });

    return {
      tabId: input.tabId,
      typed: getBoolean(typeResponse.ok) ?? true,
      submitKey: input.submitKey,
      typeResponse,
      pressResponse,
    };
  }),
};

const FillFormFieldSchema = z
  .object({
    ref: z.string().optional().describe('Snapshot ref for the input field.'),
    selector: z.string().optional().describe('Fallback CSS selector for the input field.'),
    value: z.string().describe('Value to fill into the field.'),
  })
  .describe('Single form field input descriptor.');

const FillFormInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id where form filling occurs.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    fields: z.array(FillFormFieldSchema).describe('List of fields to fill in order.'),
    submitRef: z.string().optional().describe('Optional submit button ref.'),
    submitSelector: z.string().optional().describe('Optional submit button selector.'),
  })
  .describe('Fill multiple form inputs, with optional submit click.');

const FillFormOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    filledCount: z.number().int().describe('Number of fields filled successfully.'),
    submitted: z.boolean().describe('Whether a submit click was executed.'),
    fieldResponses: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Raw responses from field type calls in order.'),
    submitResponse: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Raw submit click response when submit target is provided.'),
  })
  .describe('Fill-form result.');

export const fillFormTool: ToolDefinition<
  typeof FillFormInputSchema,
  typeof FillFormOutputSchema
> = {
  name: 'fill_form',
  title: 'Camofox Fill Form',
  description:
    'Fills multiple form fields in sequence and optionally clicks a submit target.',
  inputSchema: FillFormInputSchema,
  outputSchema: FillFormOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const userId = resolveUserId(input.userId);
    const fieldResponses: Record<string, unknown>[] = [];

    for (const field of input.fields) {
      if (!field.ref && !field.selector) {
        throw new McpError(
          JsonRpcErrorCode.InvalidParams,
          'Each fill_form field requires either ref or selector.',
        );
      }

      const response = await requestCamofoxJson({
        method: 'POST',
        path: `/tabs/${encodeURIComponent(input.tabId)}/type`,
        appContext,
        body: {
          userId,
          text: field.value,
          ...(field.ref ? { ref: field.ref } : {}),
          ...(field.selector ? { selector: field.selector } : {}),
        },
      });
      fieldResponses.push(response);
    }

    const submitRef = input.submitRef;
    const submitSelector = input.submitSelector;
    const submitResponse =
      submitRef || submitSelector
        ? await requestCamofoxJson({
            method: 'POST',
            path: `/tabs/${encodeURIComponent(input.tabId)}/click`,
            appContext,
            body: {
              userId,
              ...(submitRef ? { ref: submitRef } : {}),
              ...(submitSelector ? { selector: submitSelector } : {}),
            },
          })
        : undefined;

    return {
      tabId: input.tabId,
      filledCount: fieldResponses.length,
      submitted: Boolean(submitResponse),
      fieldResponses,
      ...(submitResponse ? { submitResponse } : {}),
    };
  }),
};

const BatchClickEntrySchema = z
  .object({
    ref: z.string().optional().describe('Element ref target for this click.'),
    selector: z.string().optional().describe('CSS selector target for this click.'),
  })
  .describe('Single click instruction.');

const BatchClickInputSchema = z
  .object({
    tabId: z.string().min(1).describe('Tab id where batched clicks are executed.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    actions: z
      .array(BatchClickEntrySchema)
      .describe('Ordered list of click actions to execute.'),
    delayMs: z
      .number()
      .int()
      .min(0)
      .max(60000)
      .default(0)
      .describe('Delay between click actions in milliseconds.'),
  })
  .describe('Execute multiple click actions sequentially with per-item results.');

const BatchClickResultItemSchema = z
  .object({
    index: z.number().int().describe('Index of the action in the request list.'),
    ok: z.boolean().describe('Whether the click succeeded.'),
    response: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Raw click response when successful.'),
    error: z.string().optional().describe('Error message when click failed.'),
  })
  .describe('Result item for one batched click action.');

const BatchClickOutputSchema = z
  .object({
    tabId: z.string().describe('Target tab id.'),
    results: z.array(BatchClickResultItemSchema).describe('Per-action click results.'),
  })
  .describe('Batch-click result.');

export const batchClickTool: ToolDefinition<
  typeof BatchClickInputSchema,
  typeof BatchClickOutputSchema
> = {
  name: 'batch_click',
  title: 'Camofox Batch Click',
  description:
    'Executes multiple click actions in sequence and returns per-action outcomes.',
  inputSchema: BatchClickInputSchema,
  outputSchema: BatchClickOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const userId = resolveUserId(input.userId);
    const results: Array<{
      index: number;
      ok: boolean;
      response?: Record<string, unknown>;
      error?: string;
    }> = [];

    for (const [index, action] of input.actions.entries()) {
      try {
        if (!action.ref && !action.selector) {
          throw new McpError(
            JsonRpcErrorCode.InvalidParams,
            'Each batch_click action requires either ref or selector.',
          );
        }

        const response = await requestCamofoxJson({
          method: 'POST',
          path: `/tabs/${encodeURIComponent(input.tabId)}/click`,
          appContext,
          body: {
            userId,
            ...(action.ref ? { ref: action.ref } : {}),
            ...(action.selector ? { selector: action.selector } : {}),
          },
        });

        results.push({ index, ok: true, response });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ index, ok: false, error: message });
      }

      if (input.delayMs > 0 && index < input.actions.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, input.delayMs));
      }
    }

    return {
      tabId: input.tabId,
      results,
    };
  }),
};

const WebSearchInputSchema = z
  .object({
    query: z.string().min(1).describe('Search query string.'),
    engine: WebSearchEngineSchema.default('google'),
    tabId: z
      .string()
      .optional()
      .describe('Optional existing tab id. If omitted, a new tab is created.'),
    userId: z
      .string()
      .optional()
      .describe('Optional user id. Defaults to CAMOFOX_DEFAULT_USER_ID.'),
    sessionKey: z
      .string()
      .optional()
      .describe('Optional session key used when creating a tab.'),
  })
  .describe('Navigate a tab to a search result page using camofox macros.');

const WebSearchOutputSchema = z
  .object({
    tabId: z.string().describe('Resolved tab id used for navigation.'),
    createdTab: z.boolean().describe('Whether a new tab was created for this search.'),
    engine: WebSearchEngineSchema,
    macro: z.string().describe('Underlying camofox macro used for the search.'),
    query: z.string().describe('Search query value.'),
    url: z.string().describe('URL after navigation.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw navigation response payload.'),
  })
  .describe('Web-search navigation result.');

export const webSearchTool: ToolDefinition<
  typeof WebSearchInputSchema,
  typeof WebSearchOutputSchema
> = {
  name: 'web_search',
  title: 'Camofox Web Search',
  description:
    'Runs a web search macro (Google/YouTube/etc.) by navigating an existing or new tab.',
  inputSchema: WebSearchInputSchema,
  outputSchema: WebSearchOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const userId = resolveUserId(input.userId);
    const sessionKey = resolveSessionKey(input.sessionKey);
    const macro = WEB_SEARCH_MACROS[input.engine];

    let tabId = input.tabId;
    let createdTab = false;

    if (!tabId) {
      const createResponse = await requestCamofoxJson({
        method: 'POST',
        path: '/tabs',
        appContext,
        body: { userId, sessionKey },
      });
      const createdTabId = pickTabId(createResponse);
      if (!createdTabId) {
        throw new McpError(
          JsonRpcErrorCode.SerializationError,
          'web_search could not parse tabId from tab creation response.',
          { createResponse },
        );
      }
      tabId = createdTabId;
      createdTab = true;
    }

    const response = await requestCamofoxJson({
      method: 'POST',
      path: `/tabs/${encodeURIComponent(tabId)}/navigate`,
      appContext,
      body: {
        userId,
        macro,
        query: input.query,
      },
    });

    const url = getString(response.url);
    if (!url) {
      throw new McpError(
        JsonRpcErrorCode.SerializationError,
        'web_search could not parse url from navigation response.',
        { response },
      );
    }

    return {
      tabId,
      createdTab,
      engine: input.engine,
      macro,
      query: input.query,
      url,
      response,
    };
  }),
};

export const serverStatusTool: ToolDefinition<
  typeof HealthInputSchema,
  typeof HealthOutputSchema
> = {
  name: 'server_status',
  title: 'Server Status (Alias)',
  description: 'Compatibility alias for camofox_health.',
  inputSchema: HealthInputSchema,
  outputSchema: HealthOutputSchema,
  annotations: TOOL_ANNOTATIONS_READ_ONLY,
  logic: camofoxHealthTool.logic,
};

export const listTabsTool: ToolDefinition<
  typeof ListTabsInputSchema,
  typeof ListTabsOutputSchema
> = {
  name: 'list_tabs',
  title: 'List Tabs (Alias)',
  description: 'Compatibility alias for camofox_list_tabs.',
  inputSchema: ListTabsInputSchema,
  outputSchema: ListTabsOutputSchema,
  annotations: TOOL_ANNOTATIONS_READ_ONLY,
  logic: camofoxListTabsTool.logic,
};

export const createTabTool: ToolDefinition<
  typeof CreateTabInputSchema,
  typeof CreateTabOutputSchema
> = {
  name: 'create_tab',
  title: 'Create Tab (Alias)',
  description: 'Compatibility alias for camofox_create_tab.',
  inputSchema: CreateTabInputSchema,
  outputSchema: CreateTabOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: camofoxCreateTabTool.logic,
};

export const navigateTool: ToolDefinition<
  typeof NavigateTabInputSchema,
  typeof NavigateTabOutputSchema
> = {
  name: 'navigate',
  title: 'Navigate (Alias)',
  description: 'Compatibility alias for camofox_navigate_tab.',
  inputSchema: NavigateTabInputSchema,
  outputSchema: NavigateTabOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: camofoxNavigateTabTool.logic,
};

export const snapshotTool: ToolDefinition<
  typeof SnapshotInputSchema,
  typeof SnapshotOutputSchema
> = {
  name: 'snapshot',
  title: 'Snapshot (Alias)',
  description: 'Compatibility alias for camofox_get_snapshot.',
  inputSchema: SnapshotInputSchema,
  outputSchema: SnapshotOutputSchema,
  annotations: TOOL_ANNOTATIONS_READ_ONLY,
  logic: camofoxGetSnapshotTool.logic,
};

export const typeTextTool: ToolDefinition<
  typeof TypeInputSchema,
  typeof TypeOutputSchema
> = {
  name: 'type_text',
  title: 'Type Text (Alias)',
  description: 'Compatibility alias for camofox_type.',
  inputSchema: TypeInputSchema,
  outputSchema: TypeOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: camofoxTypeTool.logic,
};

export const closeTabTool: ToolDefinition<
  typeof CloseTabInputSchema,
  typeof CloseTabOutputSchema
> = {
  name: 'close_tab',
  title: 'Close Tab (Alias)',
  description: 'Compatibility alias for camofox_close_tab.',
  inputSchema: CloseTabInputSchema,
  outputSchema: CloseTabOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: camofoxCloseTabTool.logic,
};

export const goBackTool: ToolDefinition<
  typeof HistoryNavInputSchema,
  typeof HistoryNavOutputSchema
> = {
  name: 'go_back',
  title: 'Go Back (Alias)',
  description: 'Compatibility alias for camofox_back.',
  inputSchema: HistoryNavInputSchema,
  outputSchema: HistoryNavOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: camofoxBackTool.logic,
};

export const goForwardTool: ToolDefinition<
  typeof HistoryNavInputSchema,
  typeof HistoryNavOutputSchema
> = {
  name: 'go_forward',
  title: 'Go Forward (Alias)',
  description: 'Compatibility alias for camofox_forward.',
  inputSchema: HistoryNavInputSchema,
  outputSchema: HistoryNavOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: camofoxForwardTool.logic,
};

export const refreshTool: ToolDefinition<
  typeof HistoryNavInputSchema,
  typeof HistoryNavOutputSchema
> = {
  name: 'refresh',
  title: 'Refresh (Alias)',
  description: 'Compatibility alias for camofox_refresh.',
  inputSchema: HistoryNavInputSchema,
  outputSchema: HistoryNavOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: camofoxRefreshTool.logic,
};

const StopInputSchema = z
  .object({
    adminKey: z
      .string()
      .optional()
      .describe('Optional admin key override. Defaults to CAMOFOX_ADMIN_KEY.'),
  })
  .describe('Stop the browser engine and clear all sessions.');

const StopOutputSchema = z
  .object({
    stopped: z.boolean().describe('Whether stop operation was acknowledged.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from POST /stop.'),
  })
  .describe('Stop browser result.');

export const camofoxStopBrowserTool: ToolDefinition<
  typeof StopInputSchema,
  typeof StopOutputSchema
> = {
  name: 'camofox_stop_browser',
  title: 'Camofox Stop Browser',
  description: 'Stops the camofox browser engine and clears all active sessions.',
  inputSchema: StopInputSchema,
  outputSchema: StopOutputSchema,
  annotations: TOOL_ANNOTATIONS_MUTATING,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const adminKey = input.adminKey ?? config.camofox.adminKey;
    if (!adminKey) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        'CAMOFOX_ADMIN_KEY is required for camofox_stop_browser.',
      );
    }

    const response = await requestCamofoxJson({
      method: 'POST',
      path: '/stop',
      appContext,
      headers: { 'x-admin-key': adminKey },
    });

    return {
      stopped: getBoolean(response.stopped) ?? getBoolean(response.ok) ?? false,
      response,
    };
  }),
};

const YoutubeTranscriptInputSchema = z
  .object({
    url: z.string().url().describe('YouTube video URL to extract captions from.'),
    languages: z
      .array(z.string().min(1))
      .optional()
      .describe('Optional preferred language codes in priority order, e.g. ["en"].'),
  })
  .describe('Extract transcript text from a YouTube video via camofox-browser backend.');

const YoutubeTranscriptOutputSchema = z
  .object({
    status: z.string().optional().describe('Backend status string, usually ok or error.'),
    transcript: z.string().optional().describe('Extracted transcript text when available.'),
    totalWords: z
      .number()
      .int()
      .optional()
      .describe('Total number of words in transcript, if provided.'),
    response: z
      .record(z.string(), z.unknown())
      .describe('Raw response from /youtube/transcript.'),
  })
  .describe('YouTube transcript extraction result.');

export const camofoxYoutubeTranscriptTool: ToolDefinition<
  typeof YoutubeTranscriptInputSchema,
  typeof YoutubeTranscriptOutputSchema
> = {
  name: 'camofox_youtube_transcript',
  title: 'Camofox YouTube Transcript',
  description:
    'Extracts available YouTube captions/transcript text for a provided video URL.',
  inputSchema: YoutubeTranscriptInputSchema,
  outputSchema: YoutubeTranscriptOutputSchema,
  annotations: TOOL_ANNOTATIONS_READ_ONLY,
  logic: withToolAuth(CAMOFOX_SCOPE, async (input, appContext, _sdkContext) => {
    const response = await requestCamofoxJson({
      method: 'POST',
      path: '/youtube/transcript',
      appContext,
      body: {
        url: input.url,
        ...(input.languages ? { languages: input.languages } : {}),
      },
    });

    return {
      ...(getString(response.status) ? { status: getString(response.status) } : {}),
      ...(getString(response.transcript)
        ? { transcript: getString(response.transcript) }
        : {}),
      ...(getNumber(response.total_words) !== undefined
        ? { totalWords: getNumber(response.total_words) }
        : {}),
      response,
    };
  }),
};
