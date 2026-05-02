import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SUPPORTED_DEPENDENCY_FIELDS,
  getPackages,
  syncDependencyManifests,
} from '../sync-dependencies.mjs';

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function formatJson(json) {
  return `${JSON.stringify(json, null, 2)}\n`;
}

function parseArguments(argv) {
  const options = {
    workspaceRoot: process.cwd(),
    baseRef: 'origin/main',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--workspace-root') {
      options.workspaceRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    if (argument === '--base-ref') {
      options.baseRef = argv[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function runGit(workspaceRoot, args) {
  return execFileSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryRunGit(workspaceRoot, args) {
  try {
    return runGit(workspaceRoot, args);
  } catch {
    return null;
  }
}

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Cannot patch-bump non-stable version: ${version}`);
  }

  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

function getInternalDependencyNames(pkg, packageNames) {
  const dependencyNames = new Set();

  for (const fieldName of SUPPORTED_DEPENDENCY_FIELDS) {
    const section = pkg.manifest[fieldName];
    if (!section || typeof section !== 'object') {
      continue;
    }

    for (const dependencyName of Object.keys(section)) {
      if (packageNames.has(dependencyName)) {
        dependencyNames.add(dependencyName);
      }
    }
  }

  return [...dependencyNames].sort();
}

function detectDependencyCycles(packagesByName) {
  const packageNames = new Set(packagesByName.keys());
  const visitState = new Map();
  const stack = [];

  function visit(packageName) {
    const state = visitState.get(packageName) ?? 0;
    if (state === 1) {
      const cycleStart = stack.indexOf(packageName);
      const cycle = [...stack.slice(cycleStart), packageName].join(' -> ');
      throw new Error(`Internal dependency cycle detected: ${cycle}`);
    }

    if (state === 2) {
      return;
    }

    visitState.set(packageName, 1);
    stack.push(packageName);

    const pkg = packagesByName.get(packageName);
    for (const dependencyName of getInternalDependencyNames(pkg, packageNames)) {
      visit(dependencyName);
    }

    stack.pop();
    visitState.set(packageName, 2);
  }

  for (const packageName of [...packagesByName.keys()].sort()) {
    visit(packageName);
  }
}

function buildDependentsMap(packagesByName) {
  const packageNames = new Set(packagesByName.keys());
  const dependents = new Map();

  for (const packageName of packageNames) {
    dependents.set(packageName, []);
  }

  for (const pkg of packagesByName.values()) {
    for (const dependencyName of getInternalDependencyNames(pkg, packageNames)) {
      dependents.get(dependencyName).push(pkg);
    }
  }

  for (const values of dependents.values()) {
    values.sort((left, right) => left.workspacePath.localeCompare(right.workspacePath));
  }

  return dependents;
}

function alignInternalDependencySpecs(pkg, packagesByName) {
  let changed = false;

  for (const fieldName of SUPPORTED_DEPENDENCY_FIELDS) {
    const section = pkg.manifest[fieldName];
    if (!section || typeof section !== 'object') {
      continue;
    }

    for (const [dependencyName, dependencySpec] of Object.entries(section)) {
      const dependencyPackage = packagesByName.get(dependencyName);
      if (!dependencyPackage || dependencySpec === dependencyPackage.version) {
        continue;
      }

      section[dependencyName] = dependencyPackage.version;
      changed = true;
    }
  }

  return changed;
}

function buildAlignmentChangelogEntry(packageName, previousVersion, nextVersion, releaseDate) {
  const compareUrl = `https://github.com/EtienneLescot/n8n-manager/compare/${packageName}-v${previousVersion}...${packageName}-v${nextVersion}`;
  return [
    `## [${nextVersion}](${compareUrl}) (${releaseDate})`,
    '',
    '',
    '### Bug Fixes',
    '',
    '* Internal dependency alignment only.',
    '',
  ].join('\n');
}

function prependChangelogEntry(changelogContent, entry) {
  const header = '# Changelog\n\n';
  if (!changelogContent.startsWith(header)) {
    return `${header}${entry}\n${changelogContent.replace(/^\s*/, '')}`;
  }

  const body = changelogContent.slice(header.length).replace(/^\s*/, '');
  return `${header}${entry}\n${body}`;
}

async function readBaseManifest(workspaceRoot, baseRef) {
  const mergeBase = tryRunGit(workspaceRoot, ['merge-base', 'HEAD', baseRef]);
  const refsToTry = [mergeBase, baseRef].filter(Boolean);

  for (const ref of refsToTry) {
    const manifestContent = tryRunGit(workspaceRoot, ['show', `${ref}:.release-please-manifest.json`]);
    if (manifestContent) {
      return JSON.parse(manifestContent);
    }
  }

  throw new Error(`Unable to read .release-please-manifest.json from ${baseRef}.`);
}

async function main() {
  const { workspaceRoot, baseRef } = parseArguments(process.argv.slice(2));
  const packages = await getPackages(workspaceRoot);
  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));

  detectDependencyCycles(packagesByName);

  const baseManifest = await readBaseManifest(workspaceRoot, baseRef);
  const dependentsByPackage = buildDependentsMap(packagesByName);
  const originalManifestContents = new Map();
  const propagatedChangelogUpdates = [];
  const packagesWithVersionChanges = new Set();

  for (const pkg of packages) {
    originalManifestContents.set(pkg.name, await readFile(pkg.manifestPath, 'utf8'));

    const baseVersion = baseManifest[pkg.workspacePath];
    if (!baseVersion || baseVersion !== pkg.version) {
      packagesWithVersionChanges.add(pkg.name);
    }
  }

  const queue = [...packagesWithVersionChanges].sort();
  const queuedPackages = new Set(queue);

  while (queue.length > 0) {
    const changedPackageName = queue.shift();

    for (const dependent of dependentsByPackage.get(changedPackageName) ?? []) {
      const manifestChanged = alignInternalDependencySpecs(dependent, packagesByName);
      if (!manifestChanged) {
        continue;
      }

      if (packagesWithVersionChanges.has(dependent.name)) {
        continue;
      }

      const previousVersion = dependent.version;
      const nextVersion = bumpPatch(previousVersion);

      dependent.version = nextVersion;
      dependent.manifest.version = nextVersion;
      packagesWithVersionChanges.add(dependent.name);

      if (!queuedPackages.has(dependent.name)) {
        queue.push(dependent.name);
        queuedPackages.add(dependent.name);
      }

      propagatedChangelogUpdates.push({
        packageName: dependent.name,
        changelogPath: path.join(dependent.packageDir, 'CHANGELOG.md'),
        previousVersion,
        nextVersion,
      });
    }
  }

  const changedFiles = [];

  for (const pkg of packages) {
    const nextContent = formatJson(pkg.manifest);
    if (nextContent === originalManifestContents.get(pkg.name)) {
      continue;
    }

    await writeFile(pkg.manifestPath, nextContent, 'utf8');
    changedFiles.push(toPosixPath(path.relative(workspaceRoot, pkg.manifestPath)));
  }

  const releaseDate = new Date().toISOString().slice(0, 10);
  for (const changelogUpdate of propagatedChangelogUpdates) {
    const existingContent = await readFile(changelogUpdate.changelogPath, 'utf8');
    const versionHeading = `## [${changelogUpdate.nextVersion}](`;
    if (existingContent.includes(versionHeading)) {
      continue;
    }

    const entry = buildAlignmentChangelogEntry(
      changelogUpdate.packageName,
      changelogUpdate.previousVersion,
      changelogUpdate.nextVersion,
      releaseDate,
    );

    await writeFile(changelogUpdate.changelogPath, prependChangelogEntry(existingContent, entry), 'utf8');
    changedFiles.push(toPosixPath(path.relative(workspaceRoot, changelogUpdate.changelogPath)));
  }

  const releaseManifestPath = path.join(workspaceRoot, '.release-please-manifest.json');
  const releaseManifest = Object.fromEntries(
    packages
      .slice()
      .sort((left, right) => left.workspacePath.localeCompare(right.workspacePath))
      .map((pkg) => [pkg.workspacePath, pkg.version]),
  );
  const previousReleaseManifest = await readFile(releaseManifestPath, 'utf8');
  const nextReleaseManifest = formatJson(releaseManifest);

  if (previousReleaseManifest !== nextReleaseManifest) {
    await writeFile(releaseManifestPath, nextReleaseManifest, 'utf8');
    changedFiles.push('.release-please-manifest.json');
  }

  const dependencyCheck = await syncDependencyManifests({
    workspaceRoot,
    mode: 'check',
    silent: true,
  });

  if (dependencyCheck.changed) {
    throw new Error(
      `Propagation left stale internal dependency specs in: ${dependencyCheck.changedFiles.join(', ')}`,
    );
  }

  if (changedFiles.length === 0) {
    console.log('No internal dependency propagation changes were required.');
    return;
  }

  console.log('Updated release files:');
  for (const filePath of [...new Set(changedFiles)].sort()) {
    console.log(`- ${filePath}`);
  }
}

const isDirectInvocation = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectInvocation) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
