/**
 * @fileoverview Barrel file for all tool definitions.
 * This file re-exports all tool definitions for easy import and registration.
 * It also exports an array of all definitions for automated registration.
 * @module src/mcp-server/tools/definitions
 */

import {
  camofoxClickTool,
  camofoxCloseTabTool,
  camofoxCreateTabTool,
  camofoxGetSnapshotTool,
  camofoxHealthTool,
  camofoxImportCookiesTool,
  camofoxListTabsTool,
  camofoxNavigateTabTool,
  camofoxScrollTool,
  camofoxStartBrowserTool,
  camofoxTypeTool,
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
  camofoxClickTool,
  camofoxTypeTool,
  camofoxScrollTool,
  camofoxCloseTabTool,
  camofoxImportCookiesTool,
];
