import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(root, 'docs', 'generated');
const licenseName = /^(licen[sc]e|copying|notice)([-_.].*)?$/i;
const maxLicenseBytes = 2 * 1024 * 1024;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function licenseFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && licenseName.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .filter((path) => statSync(path).size <= maxLicenseBytes)
    .sort((a, b) => a.localeCompare(b));
}

function repositoryValue(repository) {
  if (typeof repository === 'string') return repository;
  return repository?.url || null;
}

const cargoMetadata = JSON.parse(execFileSync('cargo', [
  'metadata', '--manifest-path', join(root, 'src-tauri', 'Cargo.toml'),
  '--locked', '--offline', '--format-version', '1',
], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

const rustPackages = cargoMetadata.packages
  .filter((pkg) => pkg.name !== 'clipcargo')
  .map((pkg) => ({
    ecosystem: 'cargo',
    name: pkg.name,
    version: pkg.version,
    license: pkg.license || null,
    source: pkg.source || null,
    repository: pkg.repository || null,
    manifestPath: pkg.manifest_path,
    files: licenseFiles(dirname(pkg.manifest_path)),
  }));

const packageLock = readJson(join(root, 'package-lock.json'));
const npmPackages = Object.entries(packageLock.packages || {})
  .filter(([packagePath]) => packagePath && packagePath.includes('node_modules/'))
  .map(([packagePath, locked]) => {
    const packageDirectory = join(root, packagePath);
    const packageJsonPath = join(packageDirectory, 'package.json');
    const manifest = existsSync(packageJsonPath) ? readJson(packageJsonPath) : {};
    return {
      ecosystem: 'npm',
      name: manifest.name || packagePath.split('node_modules/').at(-1),
      version: manifest.version || locked.version || 'unknown',
      license: manifest.license || locked.license || null,
      source: locked.resolved || null,
      repository: repositoryValue(manifest.repository),
      manifestPath: packageJsonPath,
      files: licenseFiles(packageDirectory),
    };
  });

const packages = [...rustPackages, ...npmPackages]
  .sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const licenseTexts = new Map();

for (const pkg of packages) {
  pkg.licenseFiles = pkg.files.map((path) => {
    const bytes = readFileSync(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const item = licenseTexts.get(sha256) || { sha256, text: bytes.toString('utf8').replace(/^\uFEFF/, '').trim(), packages: [], files: [] };
    item.packages.push(`${pkg.ecosystem}:${pkg.name}@${pkg.version}`);
    item.files.push(relative(root, path).replaceAll('\\', '/'));
    licenseTexts.set(sha256, item);
    return { path: relative(root, path).replaceAll('\\', '/'), sha256 };
  });
  delete pkg.files;
  pkg.manifestPath = relative(root, pkg.manifestPath).replaceAll('\\', '/');
}

const missingMetadata = packages.filter((pkg) => !pkg.license);
const missingText = packages.filter((pkg) => pkg.licenseFiles.length === 0);
const inventory = {
  generatedAt: new Date().toISOString(),
  cargoLock: 'src-tauri/Cargo.lock',
  npmLock: 'package-lock.json',
  summary: {
    packages: packages.length,
    cargoPackages: rustPackages.length,
    npmPackages: npmPackages.length,
    uniqueLicenseTexts: licenseTexts.size,
    missingLicenseMetadata: missingMetadata.length,
    packagesWithoutLocalLicenseText: missingText.length,
  },
  missingLicenseMetadata: missingMetadata.map(({ ecosystem, name, version }) => ({ ecosystem, name, version })),
  packagesWithoutLocalLicenseText: missingText.map(({ ecosystem, name, version, license }) => ({ ecosystem, name, version, license })),
  packages,
};

const lines = [
  'ClipCargo dependency license bundle',
  `Generated: ${inventory.generatedAt}`,
  'Inputs: src-tauri/Cargo.lock, package-lock.json and installed locked package directories',
  '',
  `Packages: ${packages.length} (${rustPackages.length} Cargo, ${npmPackages.length} npm)`,
  `Unique license texts: ${licenseTexts.size}`,
  `Missing license metadata: ${missingMetadata.length}`,
  `Packages without a local license text file: ${missingText.length}`,
  '',
  'PACKAGE INVENTORY',
  '=================',
  ...packages.map((pkg) => `${pkg.ecosystem}\t${pkg.name}\t${pkg.version}\t${pkg.license || 'MISSING'}\t${pkg.repository || pkg.source || ''}`),
  '',
  'UNIQUE LICENSE TEXTS',
  '====================',
];

for (const item of [...licenseTexts.values()].sort((a, b) => a.sha256.localeCompare(b.sha256))) {
  lines.push('', '-'.repeat(80), `SHA-256: ${item.sha256}`, `Packages: ${[...new Set(item.packages)].join(', ')}`, `Files: ${[...new Set(item.files)].join(', ')}`, '-'.repeat(80), item.text, '');
}

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, 'dependency-license-inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
writeFileSync(join(outputDirectory, 'DEPENDENCY-LICENSES.txt'), `${lines.join('\n')}\n`, 'utf8');

console.log(JSON.stringify(inventory.summary));
if (missingMetadata.length) process.exitCode = 2;
