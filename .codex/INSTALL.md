# install camofox-browser-mcp (codex)

follow these steps exactly.

## 1) install prerequisites

```bash
bun --version
```

if bun is missing, install bun first:
https://bun.sh/docs/installation

## 2) clone and build

```bash
git clone https://github.com/microck/camofox-browser-mcp.git
cd camofox-browser-mcp
bun install
bun run typecheck
bun run build
```

## 3) run camofox-browser

you need a running camofox-browser server locally:

```bash
camofox-browser
```

default endpoint is `http://127.0.0.1:9377`.

## 4) configure codex mcp

add this server entry to your mcp config:

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
        "CAMOFOX_API_KEY": ""
      }
    }
  }
}
```

## 5) optional: enable cookie import

set `CAMOFOX_API_KEY` in both:
- your camofox-browser process environment
- this mcp server environment

then use `camofox_import_cookies` before creating or navigating tabs.
