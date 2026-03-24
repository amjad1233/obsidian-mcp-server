# Obsidian MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects AI assistants like Claude to your [Obsidian](https://obsidian.md) vault. Read, write, search, and organize your notes through natural conversation.

Built on the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin.

---

## Quick Start (5 minutes)

> **New to this?** Follow these steps exactly and you'll be up and running. No coding experience needed.

### Step 1: Install the Obsidian Plugin

1. Open **Obsidian**
2. Go to **Settings** (gear icon, bottom-left)
3. Click **Community plugins** in the left sidebar
4. Click **Browse** and search for **"Local REST API"**
5. Click **Install**, then **Enable**
6. Still in the plugin settings, find and **copy your API key** — you'll need it in Step 3

> If you don't see Community plugins, you need to turn off **Restricted mode** first (there's a toggle at the top of the Community plugins page).

### Step 2: Download and Install This Server

Open your terminal (on Mac: search for "Terminal" in Spotlight) and run:

```bash
git clone https://github.com/amjad1233/obsidian-mcp-server.git
cd obsidian-mcp-server
npm install
```

> **Don't have Node.js?** Download it from [nodejs.org](https://nodejs.org) (pick the LTS version). Don't have git? Download from [git-scm.com](https://git-scm.com).

### Step 3: Connect to Claude

Pick **one** of these depending on what you use:

<details>
<summary><strong>Claude Desktop (the app)</strong></summary>

1. Find your config file:
   - **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

2. Open it in any text editor and add the `obsidian` block inside `mcpServers`. If the file is empty or doesn't exist, paste this whole thing:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/full/path/to/obsidian-mcp-server/mcp-server.js"],
      "env": {
        "OBSIDIAN_API_KEY": "paste-your-api-key-here"
      }
    }
  }
}
```

3. Replace `/full/path/to/` with where you cloned the repo (e.g., `/Users/yourname/obsidian-mcp-server/mcp-server.js`)
4. Replace `paste-your-api-key-here` with the API key from Step 1
5. **Restart Claude Desktop**

</details>

<details>
<summary><strong>Claude Code (the CLI)</strong></summary>

1. Create or edit `~/.mcp.json`:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/full/path/to/obsidian-mcp-server/mcp-server.js"],
      "env": {
        "OBSIDIAN_API_KEY": "paste-your-api-key-here"
      }
    }
  }
}
```

2. (Optional) Auto-allow all tools so you don't get prompted each time. Add to `~/.claude/settings.json` under `permissions.allow`:

```json
"mcp__obsidian__obsidian_list_vault",
"mcp__obsidian__obsidian_read_note",
"mcp__obsidian__obsidian_create_note",
"mcp__obsidian__obsidian_update_note",
"mcp__obsidian__obsidian_search_vault",
"mcp__obsidian__obsidian_move_note",
"mcp__obsidian__obsidian_delete_note",
"mcp__obsidian__obsidian_get_tags"
```

3. Start a new Claude Code session

</details>

### Step 4: Test It

Make sure **Obsidian is open**, then ask Claude:

> "List all files in my Obsidian vault"

If you see your files, you're done!

---

## Deployment Checklist

Use this every time you set up the server on a new machine:

- [ ] **Node.js 18+** installed (`node --version`)
- [ ] **Obsidian** installed and open
- [ ] **Local REST API** plugin installed and enabled in Obsidian
- [ ] **API key** copied from plugin settings
- [ ] **Repo cloned** and `npm install` run
- [ ] **Config file** updated (Claude Desktop or Claude Code)
  - [ ] Path to `mcp-server.js` is correct and absolute
  - [ ] API key is pasted (not the placeholder)
- [ ] **Claude restarted** (Desktop: quit and reopen / Code: new session)
- [ ] **Obsidian is running** when you try to use the tools
- [ ] **Test:** ask Claude to list your vault

---

## Features

| Tool | Description |
|------|-------------|
| `obsidian_list_vault` | List all files and folders in the vault (or a subfolder) |
| `obsidian_read_note` | Read a note's full markdown content and frontmatter |
| `obsidian_create_note` | Create a new note with auto-generated frontmatter |
| `obsidian_update_note` | Overwrite or append to an existing note |
| `obsidian_search_vault` | Full-text search across the vault with context excerpts |
| `obsidian_move_note` | Move a note from one path to another |
| `obsidian_delete_note` | Soft-delete (trash) or permanently delete a note |
| `obsidian_get_tags` | Get all tags used across the vault with counts |

## Configuration

The server is configured entirely through environment variables — no secrets in code.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OBSIDIAN_API_KEY` | Yes | — | API key from the Local REST API plugin |
| `OBSIDIAN_HOST` | No | `http://127.0.0.1` | Host where Obsidian REST API is running |
| `OBSIDIAN_PORT` | No | `27123` | Port for the REST API |

## Usage Examples

Once configured, you can ask Claude things like:

- "List everything in my Inbox folder"
- "Read my meeting notes from today"
- "Create a new note in Projects/Website Redesign with these requirements..."
- "Search my vault for anything about quarterly planning"
- "Move that inbox note to my Projects folder"
- "What tags am I using across my vault?"
- "Append today's standup notes to my running log"

## How It Works

```
Claude <-> MCP Protocol (stdio) <-> This Server <-> Obsidian Local REST API <-> Your Vault
```

The server communicates with Claude over stdio using the MCP protocol, and translates tool calls into HTTP requests against the Obsidian Local REST API running on localhost. All note paths are relative to your vault root.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Cannot connect to Obsidian REST API" | Make sure Obsidian is open and the Local REST API plugin is enabled |
| "OBSIDIAN_API_KEY environment variable is not set" | Check your config file — the API key is missing or empty |
| Tools not showing up in Claude | Restart Claude Desktop / start a new Claude Code session |
| "Note already exists" | Use `obsidian_update_note` instead of `obsidian_create_note` |
| "Path traversal is not allowed" | Don't use `../` in paths — all paths are relative to vault root |
| Server won't start | Run `node mcp-server.js` directly to see the error |
| Wrong Node.js version | Run `node --version` — you need 18 or higher |

## Notes

- **Obsidian must be running** with the Local REST API plugin active for the server to work
- All file paths are relative to the vault root (e.g., `Folder/Subfolder/Note.md`)
- `obsidian_create_note` auto-generates YAML frontmatter with `created` timestamp and `tags`
- `obsidian_delete_note` moves to trash by default — pass `permanent: true` for hard delete
- `obsidian_get_tags` scans up to 5,000 markdown files; very large vaults may see partial results

## License

MIT
