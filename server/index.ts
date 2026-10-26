import { runApplicationEntry } from './session-entry.js';

// Start diagnostics before importing configuration and the application graph.
await runApplicationEntry('server', async () => {
  const { startServer } = await import('./runtime.js');
  await startServer();
});
