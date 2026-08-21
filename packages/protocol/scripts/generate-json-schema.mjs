import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { PROTOCOL_SCHEMA_REGISTRY } from '../dist/schema-registry.js';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaRoot = join(packageRoot, 'schemas', 'v1alpha1');

await rm(schemaRoot, { recursive: true, force: true });
await mkdir(join(schemaRoot, 'mcp'), { recursive: true });

async function writeSchema(relativePath, schema, name) {
  const output = zodToJsonSchema(schema, {
    name,
    // Preserve the recursive JSON metadata contract instead of degrading it
    // to `any` when a schema contains nested metadata or error details.
    $refStrategy: 'root',
    target: 'jsonSchema7',
  });
  const target = join(schemaRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

for (const [name, schema] of Object.entries(PROTOCOL_SCHEMA_REGISTRY)) {
  if (name !== 'mcp') {
    await writeSchema(`${name}.json`, schema, name);
  }
}

for (const [toolName, toolSchemas] of Object.entries(PROTOCOL_SCHEMA_REGISTRY.mcp)) {
  await writeSchema(`mcp/${toolName}-input.json`, toolSchemas.input, `${toolName}Input`);
  await writeSchema(`mcp/${toolName}-output.json`, toolSchemas.output, `${toolName}Output`);
}
