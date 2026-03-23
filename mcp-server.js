#!/usr/bin/env node

/**
 * Obsidian MCP Server
 * Implements the Model Context Protocol for Claude Desktop integration
 * Uses the Obsidian Local REST API plugin
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API_KEY = process.env.OBSIDIAN_API_KEY;
const HOST = process.env.OBSIDIAN_HOST || 'http://127.0.0.1';
const PORT = process.env.OBSIDIAN_PORT || '27123';
const BASE_URL = `${HOST}:${PORT}`;

// --- HTTP helpers ---

async function obsidianFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = {
    'Authorization': `Bearer ${API_KEY}`,
    ...options.headers,
  };

  let res;
  try {
    res = await fetch(url, { ...options, headers });
  } catch (err) {
    throw new Error(
      `Cannot connect to Obsidian REST API at ${BASE_URL}. Is Obsidian running with the Local REST API plugin enabled?`
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Obsidian API ${res.status}: ${body || res.statusText}`);
  }

  return res;
}

async function obsidianJson(path, options = {}) {
  if (!options.headers) options.headers = {};
  options.headers['Accept'] = 'application/json';
  const res = await obsidianFetch(path, options);
  return res.json();
}

async function obsidianText(path, options = {}) {
  const res = await obsidianFetch(path, options);
  return res.text();
}

// --- Tool implementations ---

async function listVault(args) {
  const vaultPath = args?.path || '/';
  const data = await obsidianJson(`/vault/${encodeVaultPath(vaultPath)}`);
  return data;
}

async function readNote(args) {
  if (!args?.path) throw new Error('path is required');
  const content = await obsidianText(`/vault/${encodeVaultPath(args.path)}`, {
    headers: { 'Accept': 'text/markdown' },
  });
  return { path: args.path, content };
}

async function createNote(args) {
  if (!args?.path) throw new Error('path is required');
  if (args.content === undefined) throw new Error('content is required');

  // Check if note already exists
  try {
    await obsidianFetch(`/vault/${encodeVaultPath(args.path)}`, {
      method: 'HEAD',
      headers: { 'Accept': 'text/markdown' },
    });
    throw new Error(`Note already exists at: ${args.path}`);
  } catch (err) {
    if (err.message.includes('already exists')) throw err;
    // 404 means it doesn't exist — good, we can create it
  }

  const now = new Date().toISOString();
  const tags = args.tags ? args.tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(', ') : '';
  const frontmatter = [
    '---',
    `created: ${now}`,
    tags ? `tags: [${args.tags.map((t) => t.replace(/^#/, '')).join(', ')}]` : 'tags: []',
    '---',
    '',
  ].join('\n');

  const body = frontmatter + args.content;

  await obsidianFetch(`/vault/${encodeVaultPath(args.path)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/markdown' },
    body,
  });

  return { status: 'created', path: args.path };
}

async function updateNote(args) {
  if (!args?.path) throw new Error('path is required');
  if (args.content === undefined) throw new Error('content is required');

  const mode = args.mode || 'overwrite';

  if (mode === 'append') {
    await obsidianFetch(`/vault/${encodeVaultPath(args.path)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/markdown',
        'Content-Insertion-Position': 'end',
      },
      body: args.content,
    });
  } else {
    await obsidianFetch(`/vault/${encodeVaultPath(args.path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: args.content,
    });
  }

  return { status: 'updated', path: args.path, mode };
}

async function searchVault(args) {
  if (!args?.query) throw new Error('query is required');

  const data = await obsidianJson(
    `/search/simple/?query=${encodeURIComponent(args.query)}&contextLength=100`
  );

  return data.map((item) => ({
    path: item.filename,
    matches: item.matches?.map((m) => ({
      context: m.match?.content || m.context,
    })),
  }));
}

async function moveNote(args) {
  if (!args?.source) throw new Error('source is required');
  if (!args?.destination) throw new Error('destination is required');

  // Read original content
  const content = await obsidianText(`/vault/${encodeVaultPath(args.source)}`, {
    headers: { 'Accept': 'text/markdown' },
  });

  // Create at new location
  await obsidianFetch(`/vault/${encodeVaultPath(args.destination)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/markdown' },
    body: content,
  });

  // Delete original
  await obsidianFetch(`/vault/${encodeVaultPath(args.source)}`, {
    method: 'DELETE',
  });

  return { status: 'moved', source: args.source, destination: args.destination };
}

async function deleteNote(args) {
  if (!args?.path) throw new Error('path is required');

  const permanent = args.permanent === true;

  await obsidianFetch(`/vault/${encodeVaultPath(args.path)}`, {
    method: 'DELETE',
    headers: permanent ? {} : { 'X-Delete-Method': 'trash' },
  });

  return {
    status: 'deleted',
    path: args.path,
    method: permanent ? 'permanent' : 'trash',
  };
}

async function getTags() {
  // Obsidian REST API doesn't have a dedicated tags endpoint,
  // so we search all markdown files and extract tags
  const files = await obsidianJson('/vault/');
  const tagCounts = {};

  // Get file list and read each for tags
  const mdFiles = collectFiles(files, '').filter((f) => f.endsWith('.md'));

  // Process in batches to avoid overwhelming the API
  const batchSize = 20;
  for (let i = 0; i < mdFiles.length; i += batchSize) {
    const batch = mdFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (filePath) => {
        try {
          const content = await obsidianText(`/vault/${encodeVaultPath(filePath)}`, {
            headers: { 'Accept': 'text/markdown' },
          });
          return extractTags(content);
        } catch {
          return [];
        }
      })
    );
    for (const tags of results) {
      for (const tag of tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
  }

  return Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));
}

// --- Utilities ---

function encodeVaultPath(p) {
  // Trim leading slashes, encode each segment
  return p
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function collectFiles(node, prefix) {
  const results = [];
  if (!node || !node.files) return results;
  for (const f of node.files) {
    const fullPath = prefix ? `${prefix}/${f}` : f;
    results.push(fullPath);
  }
  if (node.children) {
    for (const [dirName, child] of Object.entries(node.children)) {
      const dirPath = prefix ? `${prefix}/${dirName}` : dirName;
      results.push(...collectFiles(child, dirPath));
    }
  }
  return results;
}

function extractTags(content) {
  const tags = new Set();
  // Frontmatter tags: tags: [foo, bar] or tags: foo, bar
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const tagsLine = fmMatch[1].match(/^tags:\s*\[?(.*?)\]?\s*$/m);
    if (tagsLine) {
      tagsLine[1].split(',').forEach((t) => {
        const cleaned = t.trim().replace(/^#/, '');
        if (cleaned) tags.add(cleaned);
      });
    }
  }
  // Inline #tags
  const inlineTags = content.match(/(?:^|\s)#([a-zA-Z][\w/-]*)/g);
  if (inlineTags) {
    for (const t of inlineTags) {
      tags.add(t.trim().replace(/^#/, ''));
    }
  }
  return [...tags];
}

// --- MCP Server ---

class ObsidianMCPServer {
  constructor() {
    this.server = new Server(
      { name: 'obsidian-mcp-server', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'obsidian_list_vault',
          description:
            'Lists all files and folders in the Obsidian vault. Optionally scope to a subfolder.',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description:
                  'Subfolder path to list (relative to vault root). Omit to list entire vault.',
              },
            },
          },
        },
        {
          name: 'obsidian_read_note',
          description:
            'Reads an Obsidian note by path and returns its full markdown content including frontmatter.',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the note relative to vault root (e.g. "00. Inbox/My Note.md")',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'obsidian_create_note',
          description:
            'Creates a new note at the given path. Auto-adds frontmatter with created date and tags. Fails if note already exists.',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path for the new note (e.g. "00. Inbox/New Note.md")',
              },
              content: {
                type: 'string',
                description: 'Markdown content of the note (frontmatter is added automatically)',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional tags to add to the frontmatter',
              },
            },
            required: ['path', 'content'],
          },
        },
        {
          name: 'obsidian_update_note',
          description:
            'Updates an existing note. Can overwrite entirely or append to the end.',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the note to update',
              },
              content: {
                type: 'string',
                description: 'New content (full replacement or text to append)',
              },
              mode: {
                type: 'string',
                enum: ['overwrite', 'append'],
                description: 'Update mode: "overwrite" replaces entire content, "append" adds to end. Default: overwrite.',
              },
            },
            required: ['path', 'content'],
          },
        },
        {
          name: 'obsidian_search_vault',
          description:
            'Full-text search across the Obsidian vault. Returns matching file paths and excerpts.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query string',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'obsidian_move_note',
          description:
            'Moves a note from one path to another. Useful for filing from Inbox to PARA folders.',
          inputSchema: {
            type: 'object',
            properties: {
              source: {
                type: 'string',
                description: 'Current path of the note',
              },
              destination: {
                type: 'string',
                description: 'New path for the note',
              },
            },
            required: ['source', 'destination'],
          },
        },
        {
          name: 'obsidian_delete_note',
          description:
            'Deletes a note. Moves to trash by default (safe delete). Set permanent=true for hard delete.',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the note to delete',
              },
              permanent: {
                type: 'boolean',
                description: 'If true, permanently deletes instead of moving to trash. Default: false.',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'obsidian_get_tags',
          description:
            'Returns all tags used across the vault with their counts, sorted by frequency.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result;
        switch (name) {
          case 'obsidian_list_vault':
            result = await listVault(args);
            break;
          case 'obsidian_read_note':
            result = await readNote(args);
            break;
          case 'obsidian_create_note':
            result = await createNote(args);
            break;
          case 'obsidian_update_note':
            result = await updateNote(args);
            break;
          case 'obsidian_search_vault':
            result = await searchVault(args);
            break;
          case 'obsidian_move_note':
            result = await moveNote(args);
            break;
          case 'obsidian_delete_note':
            result = await deleteNote(args);
            break;
          case 'obsidian_get_tags':
            result = await getTags();
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [
            { type: 'text', text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (error) {
        console.error(`Error in tool ${name}:`, error.message);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { status: 'error', error: error.message, timestamp: new Date().toISOString() },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    });
  }

  setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Obsidian MCP Server started');
  }
}

const server = new ObsidianMCPServer();
server.start().catch((error) => {
  console.error('Failed to start MCP server:', error);
});
