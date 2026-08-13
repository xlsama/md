import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { ensureStateDir, logPath } from './state.ts';

export const SERVICE_LABEL = 'dev.md.daemon';
export const WINDOWS_TASK_NAME = 'md daemon';

export function plistPath(): string {
  return path.join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

export function systemdUnitPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.trim() !== '' ? path.resolve(xdg) : path.join(homedir(), '.config');
  return path.join(base, 'systemd', 'user', 'md.service');
}

export function cliPath(): string {
  return path.resolve(import.meta.dir, 'cli.ts');
}

// A compiled single-file binary has no `cli.ts` on disk — `import.meta.dir` points
// into Bun's virtual filesystem — and the executable itself takes the subcommand.
function isStandaloneBinary(): boolean {
  return !existsSync(cliPath());
}

export function serviceArgv(port?: number): string[] {
  const argv = isStandaloneBinary() ? [process.execPath] : [process.execPath, cliPath()];
  argv.push('daemon');
  if (port) argv.push('--port', String(port));
  return argv;
}

export interface PlistOptions {
  argv?: string[];
  bunPath?: string;
  cliPath?: string;
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

function plistArgs(options: PlistOptions): string[] {
  if (options.argv) return options.argv;
  const args = [options.bunPath ?? process.execPath, options.cliPath ?? cliPath(), 'daemon'];
  if (options.port) args.push('--port', String(options.port));
  return args;
}

export function buildPlist(options: PlistOptions): string {
  const argXml = plistArgs(options)
    .map((a) => `      <string>${escapeXml(a)}</string>`)
    .join('\n');
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
    argv: serviceArgv(port),
    bunPath: process.execPath,
    cliPath: cliPath(),
    port,
    logFile: logPath(),
    workingDirectory: homedir(),
  };
}

export interface SystemdOptions {
  argv: string[];
  logFile: string;
  workingDirectory?: string;
}

// systemd splits ExecStart on whitespace unless the argument is quoted.
function quoteSystemd(value: string): string {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/(["\\])/g, '\\$1')}"` : value;
}

export function buildSystemdUnit(options: SystemdOptions): string {
  return `[Unit]
Description=md — local Markdown editor daemon
After=default.target

[Service]
Type=simple
ExecStart=${options.argv.map(quoteSystemd).join(' ')}
WorkingDirectory=${options.workingDirectory ?? homedir()}
Restart=always
RestartSec=2
StandardOutput=append:${options.logFile}
StandardError=append:${options.logFile}

[Install]
WantedBy=default.target
`;
}

export function defaultSystemdOptions(port?: number): SystemdOptions {
  return {
    argv: serviceArgv(port),
    logFile: logPath(),
    workingDirectory: homedir(),
  };
}

// schtasks takes the whole command line as one /TR value, and its parser wants
// inner quotes backslash-escaped.
export function windowsTaskCommand(port?: number): string {
  return serviceArgv(port)
    .map((a) => (/\s/.test(a) ? `\\"${a}\\"` : a))
    .join(' ');
}

async function run(cmd: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stderr };
}

function domainTarget(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

async function installLaunchd(port?: number): Promise<string> {
  const target = plistPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buildPlist(defaultPlistOptions(port)), 'utf8');

  await run(['launchctl', 'bootout', `${domainTarget()}/${SERVICE_LABEL}`]);
  const boot = await run(['launchctl', 'bootstrap', domainTarget(), target]);
  if (boot.code !== 0) {
    throw new Error(`launchctl bootstrap failed (${boot.code}): ${boot.stderr.trim()}`);
  }
  await run(['launchctl', 'enable', `${domainTarget()}/${SERVICE_LABEL}`]);
  return target;
}

async function uninstallLaunchd(): Promise<string> {
  const target = plistPath();
  await run(['launchctl', 'bootout', `${domainTarget()}/${SERVICE_LABEL}`]);
  await fs.rm(target, { force: true });
  return target;
}

async function installSystemd(port?: number): Promise<string> {
  const target = systemdUnitPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buildSystemdUnit(defaultSystemdOptions(port)), 'utf8');

  const reload = await run(['systemctl', '--user', 'daemon-reload']);
  if (reload.code !== 0) {
    throw new Error(`systemctl daemon-reload failed (${reload.code}): ${reload.stderr.trim()}`);
  }
  const enable = await run(['systemctl', '--user', 'enable', '--now', 'md.service']);
  if (enable.code !== 0) {
    throw new Error(`systemctl enable failed (${enable.code}): ${enable.stderr.trim()}`);
  }
  return target;
}

async function uninstallSystemd(): Promise<string> {
  const target = systemdUnitPath();
  await run(['systemctl', '--user', 'disable', '--now', 'md.service']);
  await fs.rm(target, { force: true });
  await run(['systemctl', '--user', 'daemon-reload']);
  return target;
}

async function installWindowsTask(port?: number): Promise<string> {
  const create = await run([
    'schtasks',
    '/Create',
    '/TN',
    WINDOWS_TASK_NAME,
    '/TR',
    windowsTaskCommand(port),
    '/SC',
    'ONLOGON',
    '/F',
  ]);
  if (create.code !== 0) {
    throw new Error(`schtasks /Create failed (${create.code}): ${create.stderr.trim()}`);
  }
  return `Task Scheduler: ${WINDOWS_TASK_NAME}`;
}

async function uninstallWindowsTask(): Promise<string> {
  await run(['schtasks', '/Delete', '/TN', WINDOWS_TASK_NAME, '/F']);
  return `Task Scheduler: ${WINDOWS_TASK_NAME}`;
}

function unsupported(): never {
  throw new Error(`md service is not supported on ${process.platform}`);
}

export async function installService(port?: number): Promise<string> {
  await ensureStateDir();
  switch (process.platform) {
    case 'darwin':
      return installLaunchd(port);
    case 'linux':
      return installSystemd(port);
    case 'win32':
      return installWindowsTask(port);
    default:
      unsupported();
  }
}

export async function uninstallService(): Promise<string> {
  switch (process.platform) {
    case 'darwin':
      return uninstallLaunchd();
    case 'linux':
      return uninstallSystemd();
    case 'win32':
      return uninstallWindowsTask();
    default:
      unsupported();
  }
}

export function serviceConfig(port?: number): { target: string; contents: string } {
  switch (process.platform) {
    case 'darwin':
      return { target: plistPath(), contents: buildPlist(defaultPlistOptions(port)) };
    case 'linux':
      return { target: systemdUnitPath(), contents: buildSystemdUnit(defaultSystemdOptions(port)) };
    case 'win32':
      return {
        target: `Task Scheduler: ${WINDOWS_TASK_NAME}`,
        contents: `schtasks /Create /TN "${WINDOWS_TASK_NAME}" /TR "${windowsTaskCommand(port)}" /SC ONLOGON /F\n`,
      };
    default:
      unsupported();
  }
}
