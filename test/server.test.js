import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'mcp-server.js');

// Helper to send JSON-RPC messages to the MCP server over stdio
class MCPClient {
  constructor() {
    this.proc = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
  }

  async start(env = {}) {
    this.proc = spawn('node', [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OBSIDIAN_API_KEY: 'test-key',
        OBSIDIAN_HOST: 'http://127.0.0.1',
        OBSIDIAN_PORT: '27124',
        ...env,
      },
    });

    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      this._processBuffer();
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 5000);
      this.proc.stderr.on('data', (data) => {
        if (data.toString().includes('started')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      this.proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  _processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      } catch {
        // ignore non-JSON lines
      }
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.pending.set(id, resolve);
      this.proc.stdin.write(msg + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout waiting for response to ${method}`));
        }
      }, 5000);
    });
  }

  async initialize() {
    await this.send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    const notif = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    this.proc.stdin.write(notif + '\n');
  }

  async stop() {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      await Promise.race([
        once(this.proc, 'exit'),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }
  }
}

// Helper to get error body from a tool call response
function getError(res) {
  assert.ok(res.result, 'Expected result');
  assert.equal(res.result.isError, true);
  return JSON.parse(res.result.content[0].text);
}

describe('Obsidian MCP Server', () => {
  let client;

  before(async () => {
    client = new MCPClient();
    await client.start();
    await client.initialize();
  });

  after(async () => {
    await client.stop();
  });

  describe('tools/list', () => {
    it('should return all 8 tools', async () => {
      const res = await client.send('tools/list', {});
      assert.ok(res.result, 'Expected result in response');
      assert.ok(Array.isArray(res.result.tools), 'Expected tools array');
      assert.equal(res.result.tools.length, 8);

      const toolNames = res.result.tools.map((t) => t.name).sort();
      assert.deepEqual(toolNames, [
        'obsidian_create_note',
        'obsidian_delete_note',
        'obsidian_get_tags',
        'obsidian_list_vault',
        'obsidian_move_note',
        'obsidian_read_note',
        'obsidian_search_vault',
        'obsidian_update_note',
      ]);
    });

    it('each tool should have a valid inputSchema', async () => {
      const res = await client.send('tools/list', {});
      for (const tool of res.result.tools) {
        assert.ok(tool.inputSchema, `${tool.name} missing inputSchema`);
        assert.equal(tool.inputSchema.type, 'object', `${tool.name} schema type should be object`);
        assert.ok(tool.description, `${tool.name} missing description`);
      }
    });

    it('required fields should be set correctly', async () => {
      const res = await client.send('tools/list', {});
      const tools = Object.fromEntries(res.result.tools.map((t) => [t.name, t]));

      assert.deepEqual(tools.obsidian_read_note.inputSchema.required, ['path']);
      assert.deepEqual(tools.obsidian_create_note.inputSchema.required, ['path', 'content']);
      assert.deepEqual(tools.obsidian_update_note.inputSchema.required, ['path', 'content']);
      assert.deepEqual(tools.obsidian_search_vault.inputSchema.required, ['query']);
      assert.deepEqual(tools.obsidian_move_note.inputSchema.required, ['source', 'destination']);
      assert.deepEqual(tools.obsidian_delete_note.inputSchema.required, ['path']);
      assert.equal(tools.obsidian_list_vault.inputSchema.required, undefined);
      assert.equal(tools.obsidian_get_tags.inputSchema.required, undefined);
    });
  });

  describe('tools/call error handling', () => {
    it('should return error for unknown tool', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_nonexistent',
        arguments: {},
      });
      const body = getError(res);
      assert.ok(body.error.includes('Unknown tool'));
    });

    it('should return connection error when Obsidian is not reachable', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_list_vault',
        arguments: {},
      });
      const body = getError(res);
      assert.ok(
        body.error.includes('Cannot connect') || body.error.includes('ECONNREFUSED'),
        `Expected connection error, got: ${body.error}`
      );
    });

    it('should return error when required param is missing', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_read_note',
        arguments: {},
      });
      const body = getError(res);
      assert.ok(body.error.includes('path is required'));
    });

    it('should validate obsidian_create_note requires content', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_create_note',
        arguments: { path: 'test.md' },
      });
      const body = getError(res);
      assert.ok(body.error.includes('content is required'));
    });

    it('should validate obsidian_move_note requires both params', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_move_note',
        arguments: { source: 'a.md' },
      });
      const body = getError(res);
      assert.ok(body.error.includes('destination is required'));
    });

    it('should validate obsidian_search_vault requires query', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_search_vault',
        arguments: {},
      });
      const body = getError(res);
      assert.ok(body.error.includes('query is required'));
    });
  });

  describe('path traversal protection', () => {
    it('should reject paths with ..', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_read_note',
        arguments: { path: '../../../etc/passwd' },
      });
      const body = getError(res);
      assert.ok(body.error.includes('Path traversal is not allowed'));
    });

    it('should reject paths with .. in the middle', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_read_note',
        arguments: { path: 'folder/../../../etc/passwd' },
      });
      const body = getError(res);
      assert.ok(body.error.includes('Path traversal is not allowed'));
    });

    it('should reject dot segments', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_delete_note',
        arguments: { path: './../../secret.md' },
      });
      const body = getError(res);
      assert.ok(body.error.includes('Path traversal is not allowed'));
    });

    it('should reject traversal in move source', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_move_note',
        arguments: { source: '../secret.md', destination: 'inbox/note.md' },
      });
      const body = getError(res);
      assert.ok(body.error.includes('Path traversal is not allowed'));
    });

    it('should reject traversal in move destination', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_move_note',
        arguments: { source: 'inbox/note.md', destination: '../../etc/cron.d/evil' },
      });
      const body = getError(res);
      assert.ok(body.error.includes('Path traversal is not allowed'));
    });
  });

  describe('input type validation', () => {
    it('should reject non-string path for read_note', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_read_note',
        arguments: { path: 123 },
      });
      const body = getError(res);
      assert.ok(body.error.includes('path must be a string'));
    });

    it('should reject non-string content for create_note', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_create_note',
        arguments: { path: 'test.md', content: 123 },
      });
      const body = getError(res);
      assert.ok(body.error.includes('content must be a string'));
    });

    it('should reject non-array tags for create_note', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_create_note',
        arguments: { path: 'test.md', content: 'hello', tags: 'not-an-array' },
      });
      const body = getError(res);
      assert.ok(body.error.includes('tags must be an array'));
    });

    it('should reject non-string query for search', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_search_vault',
        arguments: { query: 42 },
      });
      const body = getError(res);
      assert.ok(body.error.includes('query must be a string'));
    });

    it('should reject invalid mode for update_note', async () => {
      const res = await client.send('tools/call', {
        name: 'obsidian_update_note',
        arguments: { path: 'test.md', content: 'hello', mode: 'invalid' },
      });
      const body = getError(res);
      assert.ok(body.error.includes('mode must be'));
    });
  });

  describe('error sanitization', () => {
    it('should not leak secrets in error responses', async () => {
      // The server uses a test API key, verify it never appears in errors
      const res = await client.send('tools/call', {
        name: 'obsidian_list_vault',
        arguments: {},
      });
      const body = getError(res);
      assert.ok(!body.error.includes('test-key'), 'Error should not contain API key');
    });
  });
});

describe('Startup validation', () => {
  it('should exit if OBSIDIAN_API_KEY is not set', async () => {
    const proc = spawn('node', [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OBSIDIAN_API_KEY: '',
        OBSIDIAN_HOST: 'http://127.0.0.1',
        OBSIDIAN_PORT: '27124',
      },
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const [code] = await once(proc, 'exit');
    assert.equal(code, 1, 'Should exit with code 1');
    assert.ok(stderr.includes('OBSIDIAN_API_KEY'), 'Should mention missing API key');
  });

  it('should exit if OBSIDIAN_PORT is invalid', async () => {
    const proc = spawn('node', [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OBSIDIAN_API_KEY: 'test-key',
        OBSIDIAN_HOST: 'http://127.0.0.1',
        OBSIDIAN_PORT: 'not-a-number',
      },
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const [code] = await once(proc, 'exit');
    assert.equal(code, 1, 'Should exit with code 1');
    assert.ok(stderr.includes('Invalid OBSIDIAN_PORT'), 'Should mention invalid port');
  });
});
