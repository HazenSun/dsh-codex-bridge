import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}

const rootPackage = await json('package.json');
const packageNames = await readdir(resolve(root, 'packages'));
const manifests = await Promise.all(
  packageNames.map(async (directory) => ({
    directory,
    manifest: await json(`packages/${directory}/package.json`),
  })),
);
const plugin = await json('plugins/dsh-codex-bridge/.codex-plugin/plugin.json');
const marketplace = await json('.agents/plugins/marketplace.json');
const errors = [];
const runtimePackage = await json('packages/dsh-plugin/package.json');
const supportedDsh = runtimePackage.peerDependencies['@deepseek-ai/dsh'];
for (const path of ['plugins/dsh-codex-bridge/scripts/launch-dsh.mjs', 'scripts/e2e-support.mjs']) {
  const text = await readFile(resolve(root, path), 'utf8');
  if (!text.includes(`'${supportedDsh}'`))
    errors.push(`${path}: supported DSH version is not synchronized`);
}
const constants = await readFile(resolve(root, 'packages/protocol/src/constants.ts'), 'utf8');
if (!constants.includes(`BRIDGE_VERSION = '${rootPackage.version}'`))
  errors.push('protocol release version differs from packages');
if (!constants.includes(`SUPPORTED_DSH_VERSION = '${supportedDsh}'`))
  errors.push('protocol DSH version differs from integration peer');

for (const { directory, manifest } of manifests) {
  if (manifest.version !== rootPackage.version) {
    errors.push(`${directory}: ${manifest.version} != ${rootPackage.version}`);
  }
  if (manifest.license !== 'Apache-2.0') errors.push(`${directory}: license is not Apache-2.0`);
}
if (plugin.version !== rootPackage.version) {
  errors.push(`Codex plugin: ${plugin.version} != ${rootPackage.version}`);
}
if (!marketplace.plugins.some((entry) => entry.name === plugin.name)) {
  errors.push(`Marketplace does not contain ${plugin.name}`);
}
if (errors.length > 0) {
  throw new Error(`Release consistency failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
}

process.stdout.write(
  `Release unit ${rootPackage.version}: ${manifests.length} packages + Codex plugin are synchronized.\n`,
);
