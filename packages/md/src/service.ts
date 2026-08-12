import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { ensureStateDir, logPath, stateDir } from './state.ts';

export const SERVICE_LABEL = 'dev.md.daemon';

export function plistPath(): string {
  return path.join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

export function cliPath(): string {
  return path.resolve(import.meta.dir, 'cli.ts');
}

export interface PlistOptions {
  bunPath: string;
  cliPath: string;
  port?: number;
  logFile: string;
  workingDirectory?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildPlist(options: PlistOptions): string {
  const args = [options.bunPath, options.cliPath, 'daemon'];
  if (options.port) args.push('--port', String(options.port));
  const argXml = args.map((a) => `      <string>${escapeXml(a)}</string>`).join('\n');
  const workingDirectory = options.workingDirectory ?? homedir();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${escapeXml(workingDirectory)}</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(options.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(options.logFile)}</string>
    <key>ProcessType</key>
    <string>Background</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
  </dict>
</plist>
`;
}

export function defaultPlistOptions(port?: number): PlistOptions {
  return {
    bunPath: process.execPath,
    cliPath: cliPath(),
    port,
    logFile: logPath(),
    workingDirectory: homedir(),
  };
}

async function launchctl(args: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn({ cmd: ['launchctl', ...args], stdout: 'pipe', stderr: 'pipe' });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stderr };
}

function domainTarget(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export async function installService(port?: number): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('md service is only supported on macOS (launchd)');
  await ensureStateDir();
  const target = plistPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const contents = buildPlist(defaultPlistOptions(port));
  await fs.writeFile(target, contents, 'utf8');

  await launchctl(['bootout', `${domainTarget()}/${SERVICE_LABEL}`]);
  const boot = await launchctl(['bootstrap', domainTarget(), target]);
  if (boot.code !== 0) {
    throw new Error(`launchctl bootstrap failed (${boot.code}): ${boot.stderr.trim()}`);
  }
  await launchctl(['enable', `${domainTarget()}/${SERVICE_LABEL}`]);
  return target;
}

export async function uninstallService(): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('md service is only supported on macOS (launchd)');
  const target = plistPath();
  await launchctl(['bootout', `${domainTarget()}/${SERVICE_LABEL}`]);
  await fs.rm(target, { force: true });
  return target;
}

export function serviceInfo(): { label: string; plist: string; state: string; log: string } {
  return { label: SERVICE_LABEL, plist: plistPath(), state: stateDir(), log: logPath() };
}
