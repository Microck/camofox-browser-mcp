# camofox-browser-mcp
<p>
  <a href="https://github.com/Microck/opencode-studio"><img src="https://img.shields.io/badge/opencode-studio-brown?logo=data%3Aimage%2Fpng%3Bbase64%2CiVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAABiElEQVR4nF2Sv0tWcRTGPyeVIpCWwmyJGqQagsqCsL2hhobsD3BvdWhoj%2F6CiIKaoqXBdMjKRWwQgqZ%2BokSvkIhg9BOT9xPn9Vx79cD3cu6953zP8zznCQB1V0S01d3AKeAKcBVYA94DjyJioru2k9SHE%2Bqc%2Bkd9rL7yf7TUm%2BpQ05yPUM%2Bo626Pp%2BqE2q7GGfWrOpjNnWnAOPAGeAK8Bb4U5D3AJ%2BAQsAAMAHfVvl7gIrAf2Kjiz8BZYB3YC%2FwFpoGDwHfgEnA0oU7tgHiheEShyXxY%2FVn%2Fn6ljye8DcBiYAloRcV3tAdrV1xMRG%2Bo94DywCAwmx33AJHASWK7iiAjzNFOBl7WapPYtYdyo8RlLqVpOVPvq9KoH1NUuOneycaRefqnP1ftdUyiOt5KS%2BqLWdDpVzTXMl5It4Jr6u%2BQ%2FnhyBc8C7jpowGxGvmxuPqT9qyYuFIKdP71B8WT3SOKexXLrntvqxq3BefaiuFMQ0wqZftxl3M78MjBasfiDN%2FSAi0kFbtf8ACtKBWZBDoJEAAAAASUVORK5CYII%3D" alt="Add with OpenCode Studio" /></a>
</p>

mcp server for controlling a local
[jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser) instance.

it gives your llm direct tools for reliable browsing on hard-to-automate sites,
with full control over tab lifecycle and page interaction.

## quickstart for ai agents

**opencode**
tell opencode:
```
fetch and follow instructions from https://raw.githubusercontent.com/microck/camofox-browser-mcp/master/.opencode/INSTALL.md
```

**codex**
tell codex:
```
fetch and follow instructions from https://raw.githubusercontent.com/microck/camofox-browser-mcp/master/.codex/INSTALL.md
```

## features

- **tab lifecycle**: create, list, navigate, and close tabs with stable IDs.
- **interaction by refs**: snapshot + click/type/scroll using `e1`, `e2`, ... refs.
- **cookie import**: load browser cookies into camofox sessions for authenticated browsing.
- **stdio mcp**: drop-in local MCP server for Claude Code, OpenCode, Codex, etc.

## usage

### tools

- `camofox_health`
- `camofox_start_browser`
- `camofox_list_tabs`
- `camofox_create_tab`
- `camofox_navigate_tab`
- `camofox_get_snapshot`
- `camofox_click`
- `camofox_type`
- `camofox_scroll`
- `camofox_close_tab`
- `camofox_import_cookies`

### example

```json
{
  "name": "camofox_create_tab",
  "arguments": {
    "url": "https://example.com"
  }
}
```

## configuration

minimum env vars:

```bash
CAMOFOX_BASE_URL=http://127.0.0.1:9377
CAMOFOX_DEFAULT_USER_ID=default-user
CAMOFOX_DEFAULT_SESSION_KEY=default-session
```

for cookie import endpoints, set:

```bash
CAMOFOX_API_KEY=your-camofox-api-key
```

mcp client config example:

```json
{
  "mcpServers": {
    "camofox-browser-mcp": {
      "command": "bun",
      "args": ["/home/ubuntu/workspace/tools/camofox-browser-mcp/dist/index.js"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "CAMOFOX_BASE_URL": "http://127.0.0.1:9377",
        "CAMOFOX_DEFAULT_USER_ID": "default-user",
        "CAMOFOX_DEFAULT_SESSION_KEY": "default-session",
        "CAMOFOX_API_KEY": ""
      }
    }
  }
}
```

## installation

```bash
git clone https://github.com/microck/camofox-browser-mcp.git
cd camofox-browser-mcp
bun install
bun run typecheck
bun run build
```

## license

mit
