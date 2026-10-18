import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ignore from 'ignore';
import { checkCancelled } from './protocol';

export const MAX_FILE_BYTES = 64 * 1024;
export interface FileSnapshot { content: string | undefined; disk: string | undefined }
const SKIP_DIRS = new Set(['.git', '.svn', '.hg', '.ssh', '.aws', '.azure', '.openjarvis', 'node_modules', '.venv', 'venv', 'dist', 'build', 'coverage', '.vscode-test']);
const SECRET_NAME = /^(?:\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.pypirc|\.netrc)$/i;
const SECRET_EXT = /\.(?:pem|key|p12|pfx|keystore|db|sqlite|sqlite3)$/i;

export function relativePath(input: string, allowRoot = false): string {
  if (typeof input !== 'string' || input.includes('\0') || input.includes('\\') || input.includes(':') || input.startsWith('/')) throw new Error('Use a relative workspace path with forward slashes.');
  const parts = input.split('/');
  if (parts.some(p => p === '..')) throw new Error('Path traversal is blocked.');
  const result = parts.filter(p => p !== '.' && p !== '').join('/');
  if (!result && !allowRoot) throw new Error('A file path is required.');
  if (result.split('/').some(p => SKIP_DIRS.has(p) || SECRET_NAME.test(p) || SECRET_EXT.test(p))) throw new Error('This path is excluded from agent access.');
  return result;
}

export function replacementText(current: string | undefined, original: string, replacement: string): string {
  if (typeof original !== 'string' || typeof replacement !== 'string') throw new Error('original and replacement must be strings.');
  if (current === undefined) {
    if (original !== '') throw new Error('A new file must use an empty original string.');
    if (!replacement) throw new Error('A new file must have content.');
    return replacement;
  }
  if (!original && current) throw new Error('For an existing file, provide the exact text to replace.');
  const index = current.indexOf(original);
  if (index < 0) throw new Error('Original text does not match. Read the current file and try again.');
  if (original && current.indexOf(original, index + original.length) >= 0) throw new Error('Original text appears more than once. Include more surrounding context.');
  const updated = current.slice(0, index) + replacement + current.slice(index + original.length);
  if (updated === current) throw new Error('The proposal makes no change.');
  return updated;
}

export class WorkspaceFiles {
  private constructor(readonly root: string, private readonly openText?: (absolute: string) => string | undefined) {}
  static async open(root: string, openText?: (absolute: string) => string | undefined): Promise<WorkspaceFiles> {
    return new WorkspaceFiles(await fs.realpath(root), openText);
  }

  private async ignored(relative: string, directory: boolean): Promise<boolean> {
    const parts = relative.split('/');
    for (let depth = 0; depth < parts.length; depth++) {
      const parent = path.join(this.root, ...parts.slice(0, depth));
      for (const name of depth === 0 ? ['.gitignore', '.openjarvisignore'] : ['.gitignore']) {
        try {
          const stat = await fs.lstat(path.join(parent, name));
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) continue;
          const rules = ignore().add(await fs.readFile(path.join(parent, name), 'utf8'));
          if (rules.ignores(parts.slice(depth).join('/') + (directory ? '/' : ''))) return true;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    return false;
  }

  async resolve(input: string, allowMissing = false, allowRoot = false): Promise<string> {
    const rel = relativePath(input, allowRoot);
    let absolute = this.root;
    let directory = true;
    for (const part of rel ? rel.split('/') : []) {
      absolute = path.join(absolute, part);
      try {
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) throw new Error('Symbolic links are excluded from agent access.');
        if (stat.isFile() && stat.nlink > 1) throw new Error('Hard-linked files are excluded from agent access.');
        if (!stat.isFile() && !stat.isDirectory()) throw new Error('Only regular files and directories are supported.');
        directory = stat.isDirectory();
      } catch (error) {
        if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        directory = false;
      }
    }
    if (rel && await this.ignored(rel, directory)) throw new Error('This path is excluded by .gitignore or .openjarvisignore.');
    return absolute;
  }

  async read(input: string): Promise<string> {
    const absolute = await this.resolve(input);
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Only text files up to 64 KB can be read.');
    const text = this.openText?.(absolute) ?? new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(absolute));
    if (text.includes('\0') || Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Binary or oversized file excluded.');
    return text;
  }

  async existing(input: string): Promise<string | undefined> {
    const absolute = await this.resolve(input, true);
    try { await fs.lstat(absolute); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return this.read(input);
  }

  async snapshot(input: string): Promise<FileSnapshot> {
    const absolute = await this.resolve(input, true);
    const content = await this.existing(input);
    if (content === undefined) return { content: undefined, disk: undefined };
    const data = await fs.readFile(absolute);
    if (data.length > MAX_FILE_BYTES) throw new Error('File size changed; read it again.');
    return { content, disk: data.toString('base64') };
  }

  async unchanged(input: string, snapshot: FileSnapshot): Promise<boolean> {
    const current = await this.snapshot(input);
    return current.content === snapshot.content && current.disk === snapshot.disk;
  }

  async list(input: string, filter: string, signal: AbortSignal, limit = 200): Promise<{ files: string[]; truncated: boolean }> {
    const absolute = await this.resolve(input, false, true);
    const files: string[] = [];
    let visited = 0;
    let truncated = false;
    const walk = async (folder: string): Promise<void> => {
      checkCancelled(signal);
      if (truncated) return;
      const entries = (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        checkCancelled(signal);
        if (++visited > 5000 || files.length >= limit) { truncated = true; return; }
        const rel = path.relative(this.root, path.join(folder, entry.name)).split(path.sep).join('/');
        if (entry.isSymbolicLink()) continue;
        let resolved: string;
        try { resolved = await this.resolve(rel); } catch { continue; }
        if (entry.isDirectory()) await walk(resolved);
        else if (entry.isFile() && (!filter || rel.toLowerCase().includes(filter.toLowerCase()))) files.push(rel);
        if (truncated) return;
      }
    };
    await walk(absolute);
    return { files, truncated };
  }

  async search(query: string, input: string, signal: AbortSignal): Promise<unknown> {
    if (!query || query.length > 500) throw new Error('Search text must contain 1 to 500 characters.');
    const list = await this.list(input, '', signal, 1000);
    const matches: { path: string; line: number; text: string }[] = [];
    for (const file of list.files) {
      checkCancelled(signal);
      let text: string;
      try { text = await this.read(file); } catch { continue; }
      for (const [index, line] of text.split('\n').entries()) {
        if (line.includes(query)) matches.push({ path: file, line: index + 1, text: line.slice(0, 600) });
        if (matches.length === 50) return { matches, truncated: true };
      }
    }
    return { matches, truncated: list.truncated };
  }
}
