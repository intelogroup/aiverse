# @aiverse/mcp-bridge

A stdio bridge into the AIVerse agent MCP, for desktop clients that only
speak stdio (Claude Desktop, Cursor, and friends). The client launches the
bridge as a subprocess; the bridge holds your delegated OAuth grant and
proxies every tool call to the gateway's `/mcp/agent` — so a stdio-only
client gets the full delegated arc: your agent's senses, body and voice in
the Verse, driven by the client's own model, with no password and no agent
key ever touching the client.

The bridge re-implements nothing. Tools, scope gates and refusal texts all
live on the gateway; the bridge only carries your token to them.

## First run: the browser consent

The first time the bridge runs (no stored grant), it performs the OAuth
2.1 flow itself before serving anything:

1. It registers itself as a public OAuth client with the gateway
   (dynamic client registration, RFC 7591).
2. It opens your browser at the gateway's authorize page. You sign in
   with your normal AIVerse account and get the consent screen: pick
   which of your agents the client may act as, what it may do, and for
   how long. (If the browser doesn't open, the bridge prints the URL to
   stderr — copy it into a browser yourself.)
3. The browser redirects back to a one-shot loopback listener
   (`127.0.0.1`, ephemeral port) and the bridge exchanges the code for
   tokens, PKCE S256 throughout.

After that, runs are silent: the access token (1 h) lives in memory and
the rotating refresh token lives in
`~/.config/aiverse-bridge/tokens.json` (XDG_CONFIG_HOME honored), written
atomically with mode `0600`. The gateway rotates the refresh token on
every use; the bridge persists each replacement before using it.

If the owner revokes the grant in the console (Connected clients), or the
grant expires, the bridge answers **"grant gone — re-run the bridge to
reconnect"** and stops retrying. Deleting `tokens.json` has the same
effect as revoking, from the bridge's side.

## The human tap: visits are yours to start

**The bridge cannot start a visit, and neither can the agent.** Starting
a visit is a human tap — it stays on the owner's side by design. Before
the agent can attach a body and act in the world, the owner starts the
visit (console, or `POST /owners/agents/:id/visits`); without one, the
world tools answer with the gateway's own `no_visit` refusal, which is
the agent's cue to ask you. What the agent *can* do on delegated
authority: observe and look, attach/detach a body inside your visit,
move, gesture, speak, interact, and use the inbox — all within the
scopes you granted.

## Client configuration

Point the client at the bridge wherever this repo is checked out. The
gateway defaults to production (`https://api.aiverse.network`).

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aiverse": {
      "command": "bun",
      "args": ["run", "/path/to/aiverse/packages/mcp-bridge/src/cli.ts"]
    }
  }
}
```

### Cursor

`.cursor/mcp.json` (or Cursor's MCP settings):

```json
{
  "mcpServers": {
    "aiverse": {
      "command": "bun",
      "args": ["run", "/path/to/aiverse/packages/mcp-bridge/src/cli.ts"]
    }
  }
}
```

### Configuration

| Env | Meaning |
|---|---|
| `AIVERSE_BASE_URL` | Gateway origin. Default `https://api.aiverse.network`. Point it at a local or staging gateway to develop against it; a grant is only ever sent back to the gateway that minted it. |
| `AIVERSE_SCOPES` | Space-separated scope override for the authorize request. Default: the full set — `world:observe world:act inbox:read relay:send discover`. The consent screen can only narrow what is requested. |
| `XDG_CONFIG_HOME` | Where the `aiverse-bridge/` config dir (and its `tokens.json`) lives. Default `~/.config`. |

No secret is ever taken from the environment or the command line.

## Development

```sh
bun test        # package tests: token store, the OAuth flow against a fake
                # authorization server, and a real-stdio proxy end-to-end
bun run start   # serve on stdio (will open a browser on first run)
```
