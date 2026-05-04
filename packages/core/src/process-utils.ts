import { execFile } from 'node:child_process';
import path from 'node:path';
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
  const script = [
    'out_file=$1',
    'err_file=$2',
    'shift 2',
    'if [ -n "$out_file" ]; then',
    '  setsid "$@" >> "$out_file" 2>> "${err_file:-$out_file}" < /dev/null &',
    'else',
    '  setsid "$@" > /dev/null 2>&1 < /dev/null &',
    'fi',
    'printf "%s" "$!"',
  ].join('; ');
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
  const outputFile = options.outputFile ?? '';
  const errorFile = options.errorFile ?? (outputFile ? `${outputFile}.err` : '');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$outFile = $args[0]',
    '$errFile = $args[1]',
    '$file = $args[2]',
    '$argumentList = @()',
    'if ($args.Count -gt 3) { $argumentList = $args[3..($args.Count - 1)] }',
    "$parameters = @{ FilePath = $file; ArgumentList = $argumentList; PassThru = $true; WindowStyle = 'Hidden' }",
    "if ($outFile) { $parameters['RedirectStandardOutput'] = $outFile }",
    "if ($errFile) { $parameters['RedirectStandardError'] = $errFile }",
    '$process = Start-Process @parameters',
    '[Console]::Out.Write($process.Id)',
  ].join('; ');
  const result = await execFileAsync(resolvePowerShellBinary(), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
    outputFile,
    errorFile,
    command,
    ...args,
  ], { encoding: 'utf8' });
  return parseDetachedPid(result.stdout, command);
}

function resolvePowerShellBinary(): string {
  const systemRoot = process.env.SystemRoot?.trim();
  if (systemRoot) {
    return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  return 'powershell.exe';
}

function parseDetachedPid(stdout: string | Buffer | undefined, command: string): number {
  const pid = Number(String(stdout ?? '').trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Failed to launch detached process: ${command}`);
  }
  return pid;
}
