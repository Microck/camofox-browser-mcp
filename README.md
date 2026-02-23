# camofox-browser-mcp

MCP server for controlling a local
[jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser) instance.

This server exposes the full practical camofox-browser workflow to LLM agents:
tab lifecycle, navigation, interaction, snapshots, screenshots, links, stats,
cookie import, session cleanup, and YouTube transcript extraction.

## Quickstart for AI agents

**OpenCode**

```text
fetch and follow instructions from https://raw.githubusercontent.com/microck/camofox-browser-mcp/master/.opencode/INSTALL.md
```

**Codex**

```text
fetch and follow instructions from https://raw.githubusercontent.com/microck/camofox-browser-mcp/master/.codex/INSTALL.md
```

## Prerequisites

1. Bun installed: <https://bun.sh/docs/installation>
2. A running `camofox-browser` server (default `http://127.0.0.1:9377`)
3. Optional, depending on tools used:
   - `CAMOFOX_API_KEY` for cookie import
   - `CAMOFOX_ADMIN_KEY` for browser stop endpoint

## Installation

### Local development checkout

```bash
git clone https://github.com/microck/camofox-browser-mcp.git
cd camofox-browser-mcp
bun install
bun run typecheck
bun run build
```

### npm package

```bash
bunx camofox-browser-mcp
```

## Configuration

Set these environment variables in your MCP client config.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CAMOFOX_BASE_URL` | yes | `http://127.0.0.1:9377` | Base URL of running camofox-browser server |
| `CAMOFOX_TIMEOUT_MS` | no | `30000` | HTTP timeout for camofox calls |
| `CAMOFOX_DEFAULT_USER_ID` | no | `default-user` | Default `userId` when omitted |
| `CAMOFOX_DEFAULT_SESSION_KEY` | no | `default-session` | Default `sessionKey` when omitted |
| `CAMOFOX_API_KEY` | for `camofox_import_cookies` | unset | Bearer key for `/sessions/:userId/cookies` |
| `CAMOFOX_ADMIN_KEY` | for `camofox_stop_browser` | unset | Admin key sent as `x-admin-key` for `/stop` |

### Example MCP config (local build)

```json
{
  "mcpServers": {
    "camofox-browser-mcp": {
      "command": "bun",
      "args": ["/absolute/path/to/camofox-browser-mcp/dist/index.js"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "CAMOFOX_BASE_URL": "http://127.0.0.1:9377",
        "CAMOFOX_DEFAULT_USER_ID": "default-user",
        "CAMOFOX_DEFAULT_SESSION_KEY": "default-session",
        "CAMOFOX_API_KEY": "",
        "CAMOFOX_ADMIN_KEY": ""
      }
    }
  }
}
```

## Tool coverage

The MCP toolset maps to camofox-browser endpoints from the upstream README.

### Server and session tools

| MCP tool | Endpoint | Notes |
| --- | --- | --- |
| `camofox_health` | `GET /health` | Runtime and browser status |
| `camofox_start_browser` | `POST /start` | Starts browser engine |
| `camofox_stop_browser` | `POST /stop` | Requires admin key |
| `camofox_close_session` | `DELETE /sessions/:userId` | Closes all tabs/context for user |
| `camofox_import_cookies` | `POST /sessions/:userId/cookies` | Requires API key |

### Tab lifecycle tools

| MCP tool | Endpoint | Notes |
| --- | --- | --- |
| `camofox_list_tabs` | `GET /tabs` | Lists open tabs by user |
| `camofox_create_tab` | `POST /tabs` | Creates tab with optional URL |
| `camofox_close_tab` | `DELETE /tabs/:tabId` | Closes one tab |
| `camofox_close_tab_group` | `DELETE /tabs/group/:listItemId` | Closes all tabs in group |
| `camofox_get_stats` | `GET /tabs/:tabId/stats` | Usage stats and visited URLs |

### Navigation and interaction tools

| MCP tool | Endpoint | Notes |
| --- | --- | --- |
| `camofox_navigate_tab` | `POST /tabs/:tabId/navigate` | URL or macro navigation |
| `camofox_wait` | `POST /tabs/:tabId/wait` | Wait for page readiness |
| `camofox_get_snapshot` | `GET /tabs/:tabId/snapshot` | Ref-based accessibility snapshot |
| `camofox_click` | `POST /tabs/:tabId/click` | Click by ref or selector |
| `camofox_type` | `POST /tabs/:tabId/type` | Type text by ref/selector |
| `camofox_press` | `POST /tabs/:tabId/press` | Keyboard press |
| `camofox_scroll` | `POST /tabs/:tabId/scroll` | Vertical scroll |
| `camofox_back` | `POST /tabs/:tabId/back` | History back |
| `camofox_forward` | `POST /tabs/:tabId/forward` | History forward |
| `camofox_refresh` | `POST /tabs/:tabId/refresh` | Page reload |
| `camofox_get_links` | `GET /tabs/:tabId/links` | Extract page links |
| `camofox_screenshot` | `GET /tabs/:tabId/screenshot` | Returns base64 PNG |

### Content extraction tools

| MCP tool | Endpoint | Notes |
| --- | --- | --- |
| `camofox_youtube_transcript` | `POST /youtube/transcript` | Extracts YouTube captions |

## Typical workflow

1. `camofox_start_browser`
2. `camofox_create_tab` (or `camofox_list_tabs` + reuse)
3. `camofox_navigate_tab`
4. `camofox_get_snapshot`
5. Interact with refs: `camofox_click`, `camofox_type`, `camofox_press`, `camofox_scroll`
6. Re-run `camofox_get_snapshot` after major page changes
7. Cleanup with `camofox_close_tab` or `camofox_close_session`

## Macro support

`camofox_navigate_tab` passes `macro` and `query` through to camofox-browser.
Upstream macros include:

- `@google_search`
- `@youtube_search`
- `@amazon_search`
- `@reddit_search`
- `@reddit_subreddit`
- `@wikipedia_search`
- `@twitter_search`
- `@yelp_search`
- `@spotify_search`
- `@netflix_search`
- `@linkedin_search`
- `@instagram_search`
- `@tiktok_search`
- `@twitch_search`

## Troubleshooting

- `camofox_health` fails: check `CAMOFOX_BASE_URL` and confirm backend is running.
- `camofox_import_cookies` 403: set `CAMOFOX_API_KEY` in both backend and MCP env.
- `camofox_stop_browser` 403: set `CAMOFOX_ADMIN_KEY` in both backend and MCP env.
- Missing refs after navigation: call `camofox_get_snapshot` again.

## License

MIT
