import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => !['node_modules', 'dist', '.git'].includes(entry.name))
      .map(async (entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory()
          ? markdownFiles(path)
          : extname(entry.name) === '.md'
            ? [path]
            : [];
      }),
  );
  return nested.flat();
}

const failures = [];
const files = await markdownFiles(root);
for (const file of files) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const path = resolve(dirname(file), decodeURIComponent(target.split('#')[0]));
    await access(path).catch(() => failures.push(`${file.slice(root.length + 1)} -> ${target}`));
  }
}

if (failures.length > 0) {
  throw new Error(`Broken local documentation links:\n${failures.join('\n')}`);
}
process.stdout.write(`Checked ${files.length} Markdown files: local links are valid.\n`);
