# Installation

## For Humans

Paste this into your LLM agent session:

```
Install and configure camofox-browser-mcp by following the instructions here:
https://raw.githubusercontent.com/Microck/camofox-browser-mcp/refs/heads/main/INSTALL.md
```

### Prerequisites

- Node.js 22+ (required for the npm package)
- Optional: Bun (recommended if building from source)
- A running `camofox-browser` server (default `http://127.0.0.1:9377`)
- Optional (depending on tools used):
  - `CAMOFOX_API_KEY` for cookie import (`camofox_import_cookies`)
  - `CAMOFOX_ADMIN_KEY` for stop endpoint (`camofox_stop_browser`)

If you do not have `camofox-browser` installed, follow the upstream instructions:
https://github.com/jo-inc/camofox-browser

### Option 1: npm (recommended)

```bash
npm install -g camofox-browser-mcp
```

### Option 2: build from source (bun)

```bash
git clone https://github.com/Microck/camofox-browser-mcp.git
cd camofox-browser-mcp
bun install
bun run typecheck
bun run build
```

## Configure Your MCP Client

This server uses `stdio` transport (your MCP client runs it as a local process).

### Example (stdio, npm)

```json
{
  "mcpServers": {
    "camofox-browser-mcp": {
      "command": "camofox-browser-mcp",
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

### Example (stdio, local build)

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

## Verify

Restart your MCP client and run a quick smoke test:

- `camofox_health`

If it fails, confirm `camofox-browser` is running and `CAMOFOX_BASE_URL` matches.

## Notes

- Do not commit secrets. Avoid checking in `.env` or client config with tokens/keys.
- If you enable `camofox_stop_browser`, `CAMOFOX_ADMIN_KEY` must match in both:
  - the `camofox-browser` server environment
  - the MCP client config environment for `camofox-browser-mcp`

---

## For LLM Agents

Follow these steps when assisting a user.

### Step 0: Check prerequisites

```bash
node --version
bun --version
```

### Step 1: Ensure camofox-browser is running

- Confirm `http://127.0.0.1:9377/health` responds.
- If not, start `camofox-browser` and re-check.

### Step 2: Install camofox-browser-mcp

- Prefer npm global install.
- If building from source, run `bun run build` and point MCP client at `dist/index.js`.

### Step 3: Configure MCP client

- Ensure `MCP_TRANSPORT_TYPE=stdio`.
- Ensure `CAMOFOX_BASE_URL` points at the running backend.

### Step 4: Smoke test

- Call `camofox_health`.
- If the tool works, proceed with tab flow: `camofox_start_browser`, `camofox_create_tab`, `camofox_navigate_tab`, `camofox_get_snapshot`.
