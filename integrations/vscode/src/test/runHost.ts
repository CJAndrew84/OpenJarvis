import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openjarvis-host-'));
  try {
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'sample.ts'), 'const answer = 42;\n');
    await runTests({
      version: '1.95.3',
      extensionDevelopmentPath: path.resolve(__dirname, '../..'),
      extensionTestsPath: path.resolve(__dirname, 'host.test.js'),
      launchArgs: [workspace, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--no-sandbox', '--user-data-dir', path.join(root, 'user'), '--extensions-dir', path.join(root, 'extensions')],
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
