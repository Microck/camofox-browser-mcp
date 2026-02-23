/**
 * @fileoverview Barrel file for all tool definitions.
 * This file re-exports all tool definitions for easy import and registration.
 * It also exports an array of all definitions for automated registration.
 * @module src/mcp-server/tools/definitions
 */

import {
  camofoxBackTool,
  camofoxClickTool,
  camofoxCloseSessionTool,
  camofoxCloseTabGroupTool,
  camofoxCloseTabTool,
  camofoxCreateTabTool,
  camofoxForwardTool,
  camofoxGetLinksTool,
  camofoxGetSnapshotTool,
  camofoxGetStatsTool,
  camofoxHealthTool,
  camofoxImportCookiesTool,
  camofoxListTabsTool,
  camofoxNavigateTabTool,
  camofoxPressTool,
  camofoxRefreshTool,
  camofoxScreenshotTool,
  camofoxScrollTool,
  camofoxStartBrowserTool,
  camofoxStopBrowserTool,
  camofoxTypeTool,
  camofoxWaitTool,
  camofoxYoutubeTranscriptTool,
} from './camofox-browser.tool.js';

/**
 * An array containing all tool definitions for easy iteration.
 * Includes both regular tools and task-based tools (experimental).
 */
export const allToolDefinitions = [
  camofoxHealthTool,
  camofoxStartBrowserTool,
  camofoxListTabsTool,
  camofoxCreateTabTool,
  camofoxNavigateTabTool,
  camofoxGetSnapshotTool,
  camofoxWaitTool,
  camofoxClickTool,
  camofoxTypeTool,
  camofoxPressTool,
  camofoxScrollTool,
  camofoxBackTool,
  camofoxForwardTool,
  camofoxRefreshTool,
  camofoxGetLinksTool,
  camofoxScreenshotTool,
  camofoxGetStatsTool,
  camofoxCloseTabTool,
  camofoxCloseTabGroupTool,
  camofoxCloseSessionTool,
  camofoxStopBrowserTool,
  camofoxYoutubeTranscriptTool,
  camofoxImportCookiesTool,
];
