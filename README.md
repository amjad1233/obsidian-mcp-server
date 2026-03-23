# Obsidian MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects AI assistants like Claude to your [Obsidian](https://obsidian.md) vault. Read, write, search, and organize your notes through natural conversation.

Built on the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin.

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

## Prerequisites

1. [Obsidian](https://obsidian.md) installed and running
2. [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin installed and enabled
3. Node.js 18+

### Getting Your API Key

1. Open Obsidian Settings
2. Go to **Community Plugins** > **Local REST API**
3. Copy the API key shown in the plugin settings

## Installation

```bash
git clone https://github.com/amjad1233/obsidian-mcp-server.git
cd obsidian-mcp-server
npm install
```

## Configuration

The server is configured entirely through environment variables — no secrets in code.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OBSIDIAN_API_KEY` | Yes | — | API key from the Local REST API plugin |
| `OBSIDIAN_HOST` | No | `http://127.0.0.1` | Host where Obsidian REST API is running |
| `OBSIDIAN_PORT` | No | `27123` | Port for the REST API |

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/path/to/obsidian-mcp-server/mcp-server.js"],
      "env": {
        "OBSIDIAN_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Claude Code

Add to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/path/to/obsidian-mcp-server/mcp-server.js"],
      "env": {
        "OBSIDIAN_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Optionally auto-allow the tools in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__obsidian__obsidian_list_vault",
      "mcp__obsidian__obsidian_read_note",
      "mcp__obsidian__obsidian_create_note",
      "mcp__obsidian__obsidian_update_note",
      "mcp__obsidian__obsidian_search_vault",
      "mcp__obsidian__obsidian_move_note",
      "mcp__obsidian__obsidian_delete_note",
      "mcp__obsidian__obsidian_get_tags"
    ]
  }
}
```

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

## Notes

- **Obsidian must be running** with the Local REST API plugin active for the server to work
- All file paths are relative to the vault root (e.g., `Folder/Subfolder/Note.md`)
- `obsidian_create_note` auto-generates YAML frontmatter with `created` timestamp and `tags`
- `obsidian_delete_note` moves to trash by default — pass `permanent: true` for hard delete
- `obsidian_get_tags` scans the entire vault (frontmatter + inline `#tags`), so it may be slow on very large vaults

## License

MIT
