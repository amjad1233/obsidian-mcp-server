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
const HOST = (process.env.OBSIDIAN_HOST || 'http://127.0.0.1').replace(/:\d+$/, '');
const PORT = process.env.OBSIDIAN_PORT || '27123';
const BASE_URL = `${HOST}:${PORT}`;
const MAX_TAG_SCAN_FILES = 5000;

// --- Validation ---

function validateApiKey() {
  if (!API_KEY) {
    console.error(
      'OBSIDIAN_API_KEY environment variable is not set. ' +
      'Get your API key from Obsidian Settings > Local REST API.'
    );
    process.exit(1);
  }
}

function validatePort() {
  const port = Number(PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid OBSIDIAN_PORT: "${PORT}". Must be a number between 1 and 65535.`);
    process.exit(1);
  }
}

function validateVaultPath(p) {
  if (typeof p !== 'string') throw new Error('path must be a string');
  const normalized = p.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new Error('Path traversal is not allowed');
    }
  }
  if (normalized.startsWith('/') && normalized.length > 1) {
    throw new Error('Path must be relative to vault root');
  }
  return normalized;
}

function sanitizeErrorMessage(msg) {
  if (typeof msg !== 'string') return 'Unknown error';
  return msg
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/ApiKey\s+\S+/gi, 'ApiKey [REDACTED]')
    .replace(/[a-f0-9]{32,}/gi, '[REDACTED]')
    .slice(0, 500);
}

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
    throw new Error(`Obsidian API ${res.status}: ${sanitizeErrorMessage(body) || res.statusText}`);
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
  const vaultPath = args?.path ? validateVaultPath(args.path) : '/';
  const data = await obsidianJson(`/vault/${encodeVaultPath(vaultPath)}`);
  return data;
}

async function readNote(args) {
  if (!args?.path) throw new Error('path is required');
  const safePath = validateVaultPath(args.path);
  const content = await obsidianText(`/vault/${encodeVaultPath(safePath)}`, {
    headers: { 'Accept': 'text/markdown' },
  });
  return { path: safePath, content };
}

async function createNote(args) {
  if (!args?.path) throw new Error('path is required');
  if (typeof args.path !== 'string') throw new Error('path must be a string');
  if (args.content === undefined) throw new Error('content is required');
  if (typeof args.content !== 'string') throw new Error('content must be a string');
  if (args.tags !== undefined && !Array.isArray(args.tags)) throw new Error('tags must be an array');
  const safePath = validateVaultPath(args.path);

  // Check if note already exists by reading it — if it succeeds, the note exists
  let exists = false;
  try {
    const res = await fetch(`${BASE_URL}/vault/${encodeVaultPath(safePath)}`, {
      method: 'HEAD',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'text/markdown',
      },
    });
    exists = res.ok;
  } catch {
    // Connection error — will be caught when we try to PUT below
  }
  if (exists) {
    throw new Error(`Note already exists at: ${safePath}`);
  }

  const now = new Date().toISOString();
  const tagsList = args.tags || [];
  const frontmatter = [
    '---',
    `created: ${now}`,
    `tags: [${tagsList.map((t) => String(t).replace(/^#/, '')).join(', ')}]`,
    '---',
    '',
  ].join('\n');

  const body = frontmatter + args.content;

  await obsidianFetch(`/vault/${encodeVaultPath(safePath)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/markdown' },
    body,
  });

  return { status: 'created', path: safePath };
}

async function updateNote(args) {
  if (!args?.path) throw new Error('path is required');
  if (typeof args.path !== 'string') throw new Error('path must be a string');
  if (args.content === undefined) throw new Error('content is required');
  if (typeof args.content !== 'string') throw new Error('content must be a string');
  const safePath = validateVaultPath(args.path);

  const mode = args.mode || 'overwrite';
  if (mode !== 'overwrite' && mode !== 'append') {
    throw new Error('mode must be "overwrite" or "append"');
  }

  if (mode === 'append') {
    await obsidianFetch(`/vault/${encodeVaultPath(safePath)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/markdown',
        'Content-Insertion-Position': 'end',
      },
      body: args.content,
    });
  } else {
    await obsidianFetch(`/vault/${encodeVaultPath(safePath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: args.content,
    });
  }

  return { status: 'updated', path: safePath, mode };
}

async function searchVault(args) {
  if (!args?.query) throw new Error('query is required');
  if (typeof args.query !== 'string') throw new Error('query must be a string');

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
  if (typeof args.source !== 'string') throw new Error('source must be a string');
  if (typeof args.destination !== 'string') throw new Error('destination must be a string');
  const safeSource = validateVaultPath(args.source);
  const safeDest = validateVaultPath(args.destination);

  // Read original content
  const content = await obsidianText(`/vault/${encodeVaultPath(safeSource)}`, {
    headers: { 'Accept': 'text/markdown' },
  });

  // Create at new location
  await obsidianFetch(`/vault/${encodeVaultPath(safeDest)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/markdown' },
    body: content,
  });

  // Delete original — if this fails, warn but don't lose the data
  try {
    await obsidianFetch(`/vault/${encodeVaultPath(safeSource)}`, {
      method: 'DELETE',
    });
  } catch (err) {
    return {
      status: 'partial',
      warning: `Note copied to ${safeDest} but failed to delete original at ${safeSource}: ${sanitizeErrorMessage(err.message)}`,
      source: safeSource,
      destination: safeDest,
    };
  }

  return { status: 'moved', source: safeSource, destination: safeDest };
}

async function deleteNote(args) {
  if (!args?.path) throw new Error('path is required');
  if (typeof args.path !== 'string') throw new Error('path must be a string');
  const safePath = validateVaultPath(args.path);

  const permanent = args.permanent === true;

  await obsidianFetch(`/vault/${encodeVaultPath(safePath)}`, {
    method: 'DELETE',
    headers: permanent ? {} : { 'X-Delete-Method': 'trash' },
  });

  return {
    status: 'deleted',
    path: safePath,
    method: permanent ? 'permanent' : 'trash',
  };
}

async function getTags() {
  const files = await obsidianJson('/vault/');
  const tagCounts = {};
  let errorCount = 0;

  const mdFiles = collectFiles(files, '').filter((f) => f.endsWith('.md'));

  if (mdFiles.length > MAX_TAG_SCAN_FILES) {
    console.error(
      `Warning: vault has ${mdFiles.length} markdown files, scanning first ${MAX_TAG_SCAN_FILES}`
    );
  }
  const filesToScan = mdFiles.slice(0, MAX_TAG_SCAN_FILES);

  const batchSize = 20;
  for (let i = 0; i < filesToScan.length; i += batchSize) {
    const batch = filesToScan.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (filePath) => {
        try {
          const content = await obsidianText(`/vault/${encodeVaultPath(filePath)}`, {
            headers: { 'Accept': 'text/markdown' },
          });
          return extractTags(content);
        } catch (err) {
          errorCount++;
          console.error(`Warning: could not read ${filePath}: ${sanitizeErrorMessage(err.message)}`);
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

  const result = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));

  if (errorCount > 0) {
    result.unshift({ warning: `${errorCount} file(s) could not be read` });
  }
  if (mdFiles.length > MAX_TAG_SCAN_FILES) {
    result.unshift({
      warning: `Scanned ${MAX_TAG_SCAN_FILES} of ${mdFiles.length} files. Results may be incomplete.`,
    });
  }

  return result;
}

// --- Utilities ---

function encodeVaultPath(p) {
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
        console.error(`Error in tool ${name}:`, sanitizeErrorMessage(error.message));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'error',
                  error: sanitizeErrorMessage(error.message),
                  timestamp: new Date().toISOString(),
                },
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
    validateApiKey();
    validatePort();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Obsidian MCP Server started');
  }
}

const server = new ObsidianMCPServer();
server.start().catch((error) => {
  console.error('Failed to start MCP server:', error);
});
