import { parseDocument } from 'yaml';

const providerEntries = new Map([
  ['llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai'],
  ['llm-deepseek', '@deepseek-ai/dsh-llm-deepseek-api-key'],
  ['llm-deepseek-account', '@deepseek-ai/dsh-llm-deepseek-account'],
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertReferencesOnly(value: unknown, path = 'config'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertReferencesOnly(entry, `${path}[${index}]`));
    return;
  }
  if (
    typeof value === 'string' &&
    /\b(?:sk|gsk)-[A-Za-z0-9_-]{16,}|^Bearer\s|PRIVATE KEY/.test(value)
  ) {
    throw new Error(`Literal credentials cannot be synced: ${path}`);
  }
  if (!record(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'unsupported_js_expression')
      throw new Error(`Dynamic provider expressions cannot be synced: ${path}`);
    if (key === 'apiKeyEnv') {
      if (typeof child !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(child)) {
        throw new Error(`A credential environment reference is required: ${path}.${key}`);
      }
    } else if (
      /api.?key|password|secret|authorization|cookie|token/i.test(key) &&
      !/maxTokens|thinkingTokens|tokenLimit/i.test(key)
    ) {
      throw new Error(`Credential fields cannot be synced: ${path}.${key}`);
    } else {
      assertReferencesOnly(child, `${path}.${key}`);
    }
  }
}

function document(text: string) {
  const result = parseDocument(text, {
    customTags: [
      {
        tag: 'tag:yaml.org,2002:js',
        resolve: (value: unknown) => ({
          unsupported_js_expression: true,
          source: typeof value === 'string' ? value : '',
        }),
        stringify: (item) => {
          const value: unknown = item.value;
          if (!record(value) || typeof value['source'] !== 'string')
            throw new Error('Invalid DSH expression');
          return JSON.stringify(value['source']);
        },
      },
    ],
  });
  if (result.errors.length > 0)
    throw new Error('DSH profile YAML is invalid; repair it before syncing models.');
  return result;
}

/** Copy provider settings inside DSH; never copy credentials or arbitrary plugin rows. */
export function previewDshModelSync(sourceYaml: string, currentYaml: string) {
  const source = document(sourceYaml).toJS() as unknown;
  const targetDocument = document(currentYaml);
  const target = targetDocument.toJS() as unknown;
  if (!Array.isArray(source) || !Array.isArray(target))
    throw new Error('DSH profiles must be YAML entry lists.');
  const imported: string[] = [];
  for (const row of source as unknown[]) {
    if (!record(row) || typeof row['id'] !== 'string' || !providerEntries.has(row['id'])) continue;
    const id = row['id'];
    if (row['name'] !== undefined && row['name'] !== providerEntries.get(id)) {
      throw new Error(`Unexpected provider implementation for ${id}`);
    }
    if (row['disabled'] === true) continue;
    const config = row['config'] ?? {};
    assertReferencesOnly(config);
    const index = (target as unknown[]).findIndex((entry) => record(entry) && entry['id'] === id);
    if (index < 0) targetDocument.add(targetDocument.createNode({ id, config }));
    else targetDocument.setIn([index, 'config'], config);
    imported.push(id);
  }
  if (imported.length === 0)
    throw new Error('No supported Provider settings were found in the source DSH profile.');
  return { provider_entries: imported, serialized: targetDocument.toString() };
}
