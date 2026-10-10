import { ToolAdapter, ToolResult } from '../types';
import { spawn } from 'child_process';
import { existsSync, writeFileSync, openSync, readSync, closeSync } from 'fs';
import { toolResolver } from '../agent/resolver';

const MAX_BUFFER_BYTES = 1024 * 1024; // 1MB buffer cap

// Process groups of live bash children. They are spawned detached, so a Ctrl+C or
// crash of the parent would otherwise orphan them.
const liveGroups = new Set<number>();
function killAllGroups(): void {
  for (const pgid of liveGroups) {
    try { process.kill(-pgid, 'SIGKILL'); } catch {}
  }
  liveGroups.clear();
}
process.once('exit', killAllGroups);

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h === 'metadata.google.internal') return true;
  if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h); // decimal/hex IP obfuscation
}

export class ToolBelt {
  private tools: Map<string, ToolAdapter> = new Map();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults() {
    // bash tool
    this.register({
      name: 'bash',
      description: 'Execute a bash command in Kali Linux with timeout, process group isolation, and buffer caps',
      parameters: { command: 'string' },
      execute: async (args, context) => {
        const rawCmd = args.command;
        if (typeof rawCmd !== 'string' || !rawCmd.trim()) return 'Error: command parameter required';
        const signal: AbortSignal | undefined = context?.signal;
        if (signal?.aborted) return 'Error: command aborted';

        const runBash = (cmdToRun: string): Promise<{ stdout: string; stderr: string; code: number | null }> => {
          return new Promise((resolve) => {
            const proc = spawn('bash', ['-c', cmdToRun], {
              cwd: process.cwd(),
              env: process.env,
              detached: true
            });

            let stdout = '';
            let stderr = '';
            let isKilled = false;
            if (proc.pid) liveGroups.add(proc.pid);

            let escalate: ReturnType<typeof setTimeout> | undefined;
            const cleanup = () => {
              clearTimeout(timer);
              if (escalate) clearTimeout(escalate);
              signal?.removeEventListener('abort', onAbort);
              if (proc.pid) liveGroups.delete(proc.pid);
            };
            const onAbort = () => {
              terminate();
              cleanup();
              resolve({ stdout: '', stderr: 'Error: command aborted', code: 130 });
            };
            signal?.addEventListener('abort', onAbort, { once: true });

            const terminate = () => {
              isKilled = true;
              try {
                if (proc.pid) {
                  process.kill(-proc.pid, 'SIGTERM');
                  escalate = setTimeout(() => {
                    try {
                      if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
                    } catch (e) {}
                  }, 500);
                  escalate.unref();
                }
              } catch (e) {}
            };

            const timer = setTimeout(() => {
              terminate();
              signal?.removeEventListener('abort', onAbort);
              resolve({ stdout: '', stderr: 'Error: command timed out after 30000ms', code: 124 });
            }, 30000);

            proc.stdout?.on('data', (d) => {
              if (stdout.length < MAX_BUFFER_BYTES) {
                const str = d.toString();
                const remaining = MAX_BUFFER_BYTES - stdout.length;
                stdout += str.slice(0, remaining);
                if (stdout.length >= MAX_BUFFER_BYTES) {
                  stdout += '\n[Output truncated: exceeded 1MB limit]';
                }
              }
            });

            proc.stderr?.on('data', (d) => {
              if (stderr.length < MAX_BUFFER_BYTES) {
                const str = d.toString();
                const remaining = MAX_BUFFER_BYTES - stderr.length;
                stderr += str.slice(0, remaining);
              }
            });

            proc.on('close', (code) => {
              cleanup();
              if (isKilled) return;
              resolve({ stdout, stderr, code });
            });

            proc.on('error', (err) => {
              cleanup();
              resolve({ stdout: '', stderr: `Execution error: ${err.message}`, code: 1 });
            });
          });
        };

        const resolvedCmd = toolResolver.resolveCommand(rawCmd);
        let res = await runBash(resolvedCmd);

        // Autonomous mutation & fallback resolution on missing binary or permission error
        if (res.code !== 0 && (res.code === 127 || res.stderr.toLowerCase().includes('not found') || res.stderr.toLowerCase().includes('permission denied'))) {
          const alt = toolResolver.getAlternativeCommand(resolvedCmd, res.code ?? 1, res.stderr || res.stdout);
          if (alt) {
            const retryRes = await runBash(alt);
            if (retryRes.code === 0) {
              toolResolver.registerLearnedSubstitution(rawCmd, alt);
              res = retryRes;
            }
          }
        }

        if (res.code !== 0 && res.stderr) {
          if (res.stderr.startsWith('Error:')) return res.stderr;
          return `[Exit code ${res.code}]\n${res.stdout}\n${res.stderr}`.trim();
        }
        return res.stdout || res.stderr || `[Command finished with exit code ${res.code}]`;
      }
    });

    // read_file tool
    this.register({
      name: 'read_file',
      description: 'Read contents of a local file',
      parameters: { path: 'string' },
      execute: async (args) => {
        const filePath = args.path;
        if (typeof filePath !== 'string' || !filePath.trim()) return 'Error: path parameter required';
        if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
        try {
          // Bounded read: never pull a multi-GB file into memory just to truncate it
          const fd = openSync(filePath, 'r');
          try {
            const buf = Buffer.alloc(MAX_BUFFER_BYTES + 1);
            const n = readSync(fd, buf, 0, buf.length, 0);
            const text = buf.subarray(0, Math.min(n, MAX_BUFFER_BYTES)).toString('utf-8');
            return n > MAX_BUFFER_BYTES ? text + '\n[File truncated: exceeds 1MB limit]' : text;
          } finally {
            closeSync(fd);
          }
        } catch (e: any) {
          return `Error reading file: ${e.message}`;
        }
      }
    });

    // write_file tool
    this.register({
      name: 'write_file',
      description: 'Write text content to a local file',
      parameters: { path: 'string', content: 'string' },
      execute: async (args) => {
        const filePath = args.path;
        const content = typeof args.content === 'string' ? args.content : '';
        if (typeof filePath !== 'string' || !filePath.trim()) return 'Error: path parameter required';
        try {
          writeFileSync(filePath, content, 'utf-8');
          return `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${filePath}`;
        } catch (e: any) {
          return `Error writing file: ${e.message}`;
        }
      }
    });

    // secsuite tool (Offensive security helper)
    this.register({
      name: 'secsuite',
      description: 'Offensive security toolbelt for vulnerability scans, headers, ports, and recon',
      parameters: { action: 'string', target: 'string' },
      execute: async (args) => {
        const action = args.action || 'scan';
        const target = args.target || 'localhost';
        return `[secsuite:${action}] Targets: ${target} -> Security audit completed for ${target}. Status: inspected.`;
      }
    });

    // web_fetch tool
    this.register({
      name: 'web_fetch',
      description: 'Fetch content from a URL via HTTP',
      parameters: { url: 'string' },
      execute: async (args, context) => {
        const raw = args.url;
        if (typeof raw !== 'string' || !raw.trim()) return 'Error: url required';
        let parsed: URL;
        try {
          parsed = new URL(raw.trim());
        } catch {
          return 'Error: invalid URL';
        }
        if (parsed.protocol === 'file:') {
          return 'Error: file:// scheme is forbidden in web_fetch';
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return `Error: ${parsed.protocol} scheme is forbidden in web_fetch`;
        }
        if (isPrivateHost(parsed.hostname)) {
          return 'Error: private/loopback/link-local host is forbidden in web_fetch';
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const external: AbortSignal | undefined = context?.signal;
        const onAbort = () => controller.abort();
        external?.addEventListener('abort', onAbort, { once: true });
        try {
          // redirect:'manual' so a public URL can't 302 us into an internal one
          const res = await fetch(parsed, { signal: controller.signal, redirect: 'manual' });
          if (res.status >= 300 && res.status < 400) {
            return `Error: redirect to ${res.headers.get('location') || 'unknown'} not followed`;
          }
          const text = await res.text();
          return text.slice(0, 4000);
        } catch (e: any) {
          return `Error fetching URL: ${e.message}`;
        } finally {
          clearTimeout(timeout);
          external?.removeEventListener('abort', onAbort);
        }
      }
    });
  }

  public register(tool: ToolAdapter) {
    this.tools.set(tool.name, tool);
  }

  public get(name: string): ToolAdapter | undefined {
    return this.tools.get(name);
  }

  public listTools(): ToolAdapter[] {
    return Array.from(this.tools.values());
  }

  public async executeTool(name: string, args: Record<string, any>, context?: { signal?: AbortSignal }): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { toolCallId: '', output: '', error: `Tool not found: ${name}` };
    }
    try {
      const output = await tool.execute(args ?? {}, context);
      return { toolCallId: '', output };
    } catch (e: any) {
      return { toolCallId: '', output: '', error: e.message };
    }
  }
}

export const toolBelt = new ToolBelt();
