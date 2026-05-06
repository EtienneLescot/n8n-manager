import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface StartDetachedProcessOptions {
  outputFile?: string;
  errorFile?: string;
}

export async function startDetachedProcess(
  command: string,
  args: string[],
  options: StartDetachedProcessOptions = {},
): Promise<number> {
  if (process.platform === 'win32') {
    return startDetachedProcessOnWindows(command, args, options);
  }
  return startDetachedProcessOnUnix(command, args, options);
}

async function startDetachedProcessOnUnix(
  command: string,
  args: string[],
  options: StartDetachedProcessOptions,
): Promise<number> {
  const outputFile = options.outputFile ?? '';
  const errorFile = options.errorFile ?? outputFile;
  // Keep branch commands on the same line so flattened shell scripts stay valid POSIX sh.
  const script = [
    'out_file=$1',
    'err_file=$2',
    'shift 2',
    'if [ -n "$out_file" ]; then setsid "$@" >> "$out_file" 2>> "${err_file:-$out_file}" < /dev/null &',
    'else setsid "$@" > /dev/null 2>&1 < /dev/null &',
    'fi',
    'printf "%s" "$!"',
  ].join('\n');
  const result = await execFileAsync('sh', [
    '-c',
    script,
    'n8n-manager-detach',
    outputFile,
    errorFile,
    command,
    ...args,
  ], { encoding: 'utf8' });
  return parseDetachedPid(result.stdout, command);
}

async function startDetachedProcessOnWindows(
  command: string,
  args: string[],
  options: StartDetachedProcessOptions,
): Promise<number> {
  const outputFile = options.outputFile;
  const errorFile = options.errorFile ?? (outputFile ? `${outputFile}.err` : undefined);
  const stdout = outputFile ? fs.openSync(outputFile, 'a') : 'ignore';
  const stderr = errorFile ? fs.openSync(errorFile, 'a') : 'ignore';

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', stdout, stderr],
      windowsHide: true,
    });
    await waitForWindowsDetachedSpawn(child, command);
    child.unref();
    return parseDetachedPid(String(child.pid ?? ''), command);
  } finally {
    if (typeof stdout === 'number') fs.closeSync(stdout);
    if (typeof stderr === 'number' && stderr !== stdout) fs.closeSync(stderr);
  }
}

function waitForWindowsDetachedSpawn(child: ReturnType<typeof spawn>, command: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off('error', onError);
      child.off('spawn', onSpawn);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  }).catch((error) => {
    throw error instanceof Error ? error : new Error(`Failed to launch detached process: ${command}`);
  });
}

function parseDetachedPid(stdout: string | Buffer | undefined, command: string): number {
  const pid = Number(String(stdout ?? '').trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Failed to launch detached process: ${command}`);
  }
  return pid;
}
