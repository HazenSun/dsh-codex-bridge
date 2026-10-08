import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', 'plugins', 'dsh-codex-bridge');
const manifest = JSON.parse(await readFile(resolve(root, '.codex-plugin', 'plugin.json'), 'utf8'));
const errors = [];

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') errors.push(`${label} must be non-empty`);
}

requireText(manifest.name, 'name');
requireText(manifest.version, 'version');
requireText(manifest.description, 'description');
requireText(manifest.author?.name, 'author.name');
requireText(manifest.interface?.displayName, 'interface.displayName');
requireText(manifest.interface?.shortDescription, 'interface.shortDescription');
requireText(manifest.interface?.longDescription, 'interface.longDescription');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '')) {
  errors.push('version must be strict semver');
}
if (manifest.name !== 'dsh-codex-bridge') errors.push('plugin directory and name must match');
if (!Array.isArray(manifest.interface?.capabilities)) {
  errors.push('interface.capabilities must be an array');
}

for (const path of [manifest.skills]) {
  if (typeof path !== 'string' || !path.startsWith('./')) {
    errors.push(`invalid plugin-relative path: ${String(path)}`);
    continue;
  }
  await access(resolve(root, path)).catch(() => errors.push(`missing plugin path: ${path}`));
}

if (manifest.mcpServers !== undefined)
  errors.push('Local MCP is registered by the installer, not through unexpanded plugin paths');
if (
  !Array.isArray(manifest.interface?.defaultPrompt) ||
  manifest.interface.defaultPrompt.length > 3
)
  errors.push('The plugin must provide at most three starter prompts');
await access(resolve(root, 'scripts/launch-dsh.mjs'));
const onboardingSkill = manifest.extensions?.['com.openai']?.onboardingSkill;
if (onboardingSkill !== './skills/setup-dsh-bridge/SKILL.md') {
  errors.push('Plugin setup must reference the packaged onboarding Skill');
}
const skill = await readFile(resolve(root, 'skills', 'delegate-to-dsh', 'SKILL.md'), 'utf8');
if (!skill.startsWith('---\n') || !skill.includes('\nname: delegate-to-dsh\n')) {
  errors.push('delegate-to-dsh skill frontmatter is invalid');
}
if (skill.includes('[TODO:')) errors.push('plugin contains a TODO placeholder');

if (errors.length > 0) throw new Error(`Codex plugin validation failed:\n${errors.join('\n')}`);
process.stdout.write(`Codex plugin validation passed: ${root}\n`);
