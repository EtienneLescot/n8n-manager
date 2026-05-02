import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
];

const JSON_INDENT = 2;

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function formatJson(json) {
  return `${JSON.stringify(json, null, JSON_INDENT)}\n`;
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function segmentToRegex(segment) {
  return new RegExp(`^${escapeRegex(segment).replace(/\*/g, '[^/]*')}$`);
}

async function resolveWorkspaceDirectories(currentDir, segments, segmentIndex = 0) {
  if (segmentIndex >= segments.length) {
    return [currentDir];
  }

  const segment = segments[segmentIndex];

  if (segment === '**') {
    const results = new Set(await resolveWorkspaceDirectories(currentDir, segments, segmentIndex + 1));
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const nextDir = path.join(currentDir, entry.name);
      for (const match of await resolveWorkspaceDirectories(nextDir, segments, segmentIndex)) {
        results.add(match);
      }
    }

    return [...results].sort();
  }

  if (!segment.includes('*')) {
    const nextDir = path.join(currentDir, segment);
    if (!(await pathExists(nextDir))) {
      return [];
    }

    return resolveWorkspaceDirectories(nextDir, segments, segmentIndex + 1);
  }

  const matcher = segmentToRegex(segment);
  const entries = await readdir(currentDir, { withFileTypes: true });
  const matches = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !matcher.test(entry.name)) {
      continue;
    }

    matches.push(...(await resolveWorkspaceDirectories(path.join(currentDir, entry.name), segments, segmentIndex + 1)));
  }

  return matches.sort();
}

function getWorkspacePatterns(rootPackageJson) {
  if (Array.isArray(rootPackageJson.workspaces)) {
    return rootPackageJson.workspaces;
  }

  if (Array.isArray(rootPackageJson.workspaces?.packages)) {
    return rootPackageJson.workspaces.packages;
  }

  throw new Error('Root package.json must define workspaces as an array or workspaces.packages.');
}

function hasGitDiff(workspaceRoot, args) {
  try {
    execFileSync('git', args, {
      cwd: workspaceRoot,
      stdio: 'ignore',
    });

    return false;
  } catch (error) {
    if (error.status === 1) {
      return true;
    }

    throw error;
  }
}

function getDiffPatch(beforePath, afterPath, workspaceRoot) {
  try {
    return execFileSync(
      'git',
      ['diff', '--no-index', '--no-prefix', '--', beforePath, afterPath],
      {
        cwd: workspaceRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    if (error.status === 1) {
      return error.stdout ?? '';
    }

    throw error;
  }
}

async function stagePatchedManifest({ workspaceRoot, relativeManifestPath, beforeContent, afterContent }) {
  const tempRoot = await mkdtemp(path.join(workspaceRoot, '.git', 'n8n-manager-sync-'));
  const beforePath = path.join(tempRoot, 'before.json');
  const afterPath = path.join(tempRoot, 'after.json');

  try {
    await writeFile(beforePath, beforeContent, 'utf8');
    await writeFile(afterPath, afterContent, 'utf8');

    const beforeLabel = toPosixPath(path.relative(workspaceRoot, beforePath));
    const afterLabel = toPosixPath(path.relative(workspaceRoot, afterPath));
    let patch = getDiffPatch(beforePath, afterPath, workspaceRoot);

    if (!patch.trim()) {
      return;
    }

    patch = patch
      .replaceAll(beforeLabel, relativeManifestPath)
      .replaceAll(afterLabel, relativeManifestPath);

    execFileSync('git', ['apply', '--cached', '--whitespace=nowarn', '-p0'], {
      cwd: workspaceRoot,
      input: patch,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function stageChangedManifests(workspaceRoot, changedEntries) {
  const safeToAdd = [];
  const failedToStage = [];

  for (const entry of changedEntries) {
    if (!entry.hadUnstagedChangesBefore) {
      safeToAdd.push(entry.relativeManifestPath);
      continue;
    }

    try {
      await stagePatchedManifest({
        workspaceRoot,
        relativeManifestPath: entry.relativeManifestPath,
        beforeContent: entry.beforeContent,
        afterContent: entry.afterContent,
      });
    } catch (error) {
      failedToStage.push(`${entry.relativeManifestPath}: ${error.message}`);
    }
  }

  if (safeToAdd.length > 0) {
    execFileSync('git', ['add', '--', ...safeToAdd], {
      cwd: workspaceRoot,
      stdio: 'ignore',
    });
  }

  if (failedToStage.length > 0) {
    throw new Error(
      [
        'Dependency sync updated package manifests, but some files already had unstaged edits and could not be staged safely.',
        ...failedToStage.map((line) => `- ${line}`),
        'Stage those manifest changes manually to keep unrelated unstaged edits out of the commit.',
      ].join('\n'),
    );
  }
}

function alignInternalDependencies(manifest, internalVersions) {
  let changed = false;

  for (const fieldName of SUPPORTED_DEPENDENCY_FIELDS) {
    const section = manifest[fieldName];
    if (!section || typeof section !== 'object') {
      continue;
    }

    for (const [dependencyName, dependencySpec] of Object.entries(section)) {
      const internalVersion = internalVersions.get(dependencyName);
      if (!internalVersion || dependencySpec === internalVersion) {
        continue;
      }

      section[dependencyName] = internalVersion;
      changed = true;
    }
  }

  return changed;
}

export async function getPackages(workspaceRoot = process.cwd()) {
  const rootPackageJson = await readJsonFile(path.join(workspaceRoot, 'package.json'));
  const workspacePatterns = getWorkspacePatterns(rootPackageJson);
  const workspaceDirectories = new Set();

  for (const pattern of workspacePatterns) {
    const normalizedPattern = pattern.replace(/\\/g, '/').replace(/\/$/, '');
    const segments = normalizedPattern.split('/').filter(Boolean);
    for (const directory of await resolveWorkspaceDirectories(workspaceRoot, segments)) {
      workspaceDirectories.add(directory);
    }
  }

  const manifestPaths = [];
  for (const workspaceDirectory of [...workspaceDirectories].sort()) {
    const manifestPath = path.join(workspaceDirectory, 'package.json');
    if (await pathExists(manifestPath)) {
      manifestPaths.push(manifestPath);
    }
  }

  const packages = [];
  const seenPackageNames = new Set();

  for (const manifestPath of manifestPaths.sort()) {
    const manifest = await readJsonFile(manifestPath);
    if (!manifest.name || !manifest.version) {
      throw new Error(`Workspace manifest ${toPosixPath(path.relative(workspaceRoot, manifestPath))} must define both name and version.`);
    }

    if (seenPackageNames.has(manifest.name)) {
      throw new Error(`Duplicate workspace package name detected: ${manifest.name}`);
    }

    seenPackageNames.add(manifest.name);
    const packageDir = path.dirname(manifestPath);

    packages.push({
      name: manifest.name,
      version: manifest.version,
      manifest,
      manifestPath,
      packageDir,
      workspacePath: toPosixPath(path.relative(workspaceRoot, packageDir)),
    });
  }

  return packages;
}

export async function syncDependencyManifests({
  workspaceRoot = process.cwd(),
  mode = 'check',
  stage = false,
  silent = false,
} = {}) {
  if (!['check', 'write'].includes(mode)) {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  if (stage && mode !== 'write') {
    throw new Error('--stage can only be used together with --write.');
  }

  const packages = await getPackages(workspaceRoot);
  const internalVersions = new Map(packages.map((pkg) => [pkg.name, pkg.version]));
  const changedEntries = [];

  for (const pkg of packages) {
    const beforeContent = await readFile(pkg.manifestPath, 'utf8');
    const changed = alignInternalDependencies(pkg.manifest, internalVersions);
    if (!changed) {
      continue;
    }

    changedEntries.push({
      manifestPath: pkg.manifestPath,
      relativeManifestPath: toPosixPath(path.relative(workspaceRoot, pkg.manifestPath)),
      beforeContent,
      afterContent: formatJson(pkg.manifest),
      hadUnstagedChangesBefore: stage
        ? hasGitDiff(workspaceRoot, ['diff', '--quiet', '--', toPosixPath(path.relative(workspaceRoot, pkg.manifestPath))])
        : false,
    });
  }

  if (changedEntries.length > 0 && !silent) {
    console.log('Out-of-sync internal dependencies detected in:');
    for (const entry of changedEntries) {
      console.log(`- ${entry.relativeManifestPath}`);
    }
  }

  if (mode === 'write') {
    for (const entry of changedEntries) {
      await writeFile(entry.manifestPath, entry.afterContent, 'utf8');
    }

    if (stage && changedEntries.length > 0) {
      await stageChangedManifests(workspaceRoot, changedEntries);
    }
  }

  return {
    changed: changedEntries.length > 0,
    changedFiles: changedEntries.map((entry) => entry.relativeManifestPath),
    packages,
  };
}

function parseArguments(argv) {
  let mode = null;
  let stage = false;

  for (const argument of argv) {
    if (argument === '--check') {
      mode = 'check';
      continue;
    }

    if (argument === '--write') {
      mode = 'write';
      continue;
    }

    if (argument === '--stage') {
      stage = true;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!mode) {
    throw new Error('Expected exactly one mode: --check or --write.');
  }

  if (stage && mode !== 'write') {
    throw new Error('--stage can only be used together with --write.');
  }

  return { mode, stage };
}

async function main() {
  const { mode, stage } = parseArguments(process.argv.slice(2));
  const result = await syncDependencyManifests({
    workspaceRoot: process.cwd(),
    mode,
    stage,
  });

  if (mode === 'check' && result.changed) {
    process.exitCode = 1;
  }
}

const isDirectInvocation = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectInvocation) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
