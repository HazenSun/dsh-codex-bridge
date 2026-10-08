import { describe, expect, it } from 'vitest';
import { previewDshModelSync } from './model-sync.js';

describe('DSH model settings sync', () => {
  it('imports only provider references and preserves other user overrides', () => {
    const preview = previewDshModelSync(
      '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      moonshotai-cn:\n        apiKeyEnv: MOONSHOTAI_CN_API_KEY\n- id: arbitrary\n  config: {}\n',
      '# Keep the operator note\n- id: hmr\n  disabled: true\n- id: sandbox-policy\n  config:\n    workspaceRoot: !!js process.cwd()\n',
    );
    expect(preview.provider_entries).toEqual(['llm-pi-ai']);
    expect(preview.serialized).toContain('MOONSHOTAI_CN_API_KEY');
    expect(preview.serialized).toContain('# Keep the operator note');
    expect(preview.serialized).toContain('id: hmr');
    expect(preview.serialized).toContain('process.cwd()');
    expect(preview.serialized).not.toContain('arbitrary');
  });

  it('rejects literal credentials before returning any provider contents', () => {
    expect(() =>
      previewDshModelSync(
        '- id: llm-pi-ai\n  config:\n    providers:\n      main:\n        apiKey: never-copy-this-value\n',
        '[]\n',
      ),
    ).toThrow(/Credential fields/);
    expect(() =>
      previewDshModelSync(
        '- id: llm-pi-ai\n  config:\n    apiKeyEnv: !!js process.env.KEY\n',
        '[]\n',
      ),
    ).toThrow(/environment reference/);
  });
});
