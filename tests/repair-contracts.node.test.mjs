import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const source = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('new conversation POST exposes conversationId expected by useDesk', () => {
  const api = source('server/v2/api/chat.ts');
  assert.match(api, /conversationId:\s*conv\.id/);
});
test('conversation lifecycle syncs runtime state, including deletion', () => {
  const api = source('server/v2/api/chat.ts');
  assert.match(api, /app\.delete\('\/api\/conversations\/:id'/);
  assert.match(api, /draft\.conversations\s*=\s*service\.listConversations\(\)/);
});
test('commands preserve conversationId to role runner and rooms', () => {
  const ops = source('server/v2/api/operations.ts');
  const run = source('server/v2/runtime.ts');
  assert.match(ops, /conversationId:\s*parsed\.data\.conversationId/);
  assert.match(run, /const conversationId = input\.conversationId \|\| 'office'/);
});
test('refresh models updates one CLI without replacing the entire roster', () => {
  const ui = source('web/src/components/LocalAgentsSetup.tsx');
  assert.doesNotMatch(ui, /setAgents\(result\.agents\)/);
  assert.match(ui, /setAgents\(current\s*=>/);
});
test('CLI installed-only is never misreported as authenticated', () => {
  const api = source('server/v2/api/local-agents.ts');
  assert.doesNotMatch(api, /installed:\s*true,\s*connected:\s*true,\s*state:\s*'ready'/);
});
test('CLI settings endpoint does not acknowledge empty persistence', () => {
  const api = source('server/v2/api/local-agents.ts');
  assert.doesNotMatch(api, /res\.json\(\{ ok: true, detail: 'Agent settings saved\.', settings: \{\} \}\)/);
});

test('V2 model picker populates all API providers and local CLIs from catalogue', () => {
  const api = source('server/v2/api/setup.ts');
  assert.match(api, /MODEL_CHOICES/);
  assert.match(api, /MODEL_PROVIDERS\.filter/);
  assert.match(api, /LOCAL_CLI_AGENTS\.flatMap/);
  assert.match(api, /checkedOn: MODEL_CATALOG_DATE/);
});

test('Connect CLI tests selected model and polling does real verification', () => {
  const api = source('server/v2/api/local-agents.ts');
  const ui = source('web/src/components/LocalAgentsSetup.tsx');
  assert.match(api, /agentSpec: `\$\{def\.id\}:\$\{selectedModel\}`/);
  assert.match(ui, /const result = await status\(id, true\)/);
});

test('owner chat uses a typed RoleRunner method instead of accessing private fields', () => {
  const runner = source('server/v2/agents/runner.ts');
  const runtime = source('server/v2/runtime.ts');
  assert.match(runner, /async chat\(input:/);
  assert.match(runtime, /roleRunner\.chat\(\{/);
  assert.doesNotMatch(runtime, /\(roleRunner as any\)\.providerCaller/);
});
