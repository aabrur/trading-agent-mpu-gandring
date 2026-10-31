import { runApplicationEntry } from './session-entry.js';

// Start diagnostics before importing configuration and the application graph.
await runApplicationEntry('server', async () => {
  const { startReplacementServer } = await import('./v2/runtime.js');
  await startReplacementServer();
});
