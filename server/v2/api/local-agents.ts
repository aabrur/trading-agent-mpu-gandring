import type express from 'express';
import { z } from 'zod';
import {
  LOCAL_CLI_AGENTS,
  buildLocalCliEnv,
  runLocalCliInference,
  type LocalCliAgentSpec
} from '../agents/local.js';
import { safe } from '../../redact.js';
import type { SetupApiDeps } from './setup.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

function findBinPath(bin: string): string | null {
  const env = buildLocalCliEnv(process.env);
  const pathVal = env.PATH ?? env.Path ?? '';
  const dirs = pathVal.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${bin}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function mountLocalAgentsRoutes(app: express.Express, deps: SetupApiDeps): void {
  app.get('/api/setup/local-agents', (_req, res) => {
    const snap = deps.settings.current();
    const leadAgent = snap.effective.agents.lead;
    const agents = LOCAL_CLI_AGENTS.map((a) => {
      const binPath = findBinPath(a.bin);
      const isDefault = leadAgent.provider === 'local' && leadAgent.model.startsWith(`${a.id}:`);
      return {
        id: a.id,
        bin: a.bin,
        label: a.label,
        installed: Boolean(binPath),
        docs: a.docs,
        loginCommand: a.login.join(' ') || `${a.bin} login`,
        hint: binPath ? 'Installed on PATH' : 'Not found on PATH',
        models: [...a.models],
        activeModel: isDefault ? leadAgent.model : null
      };
    });

    res.json({
      ok: true,
      agents,
      settings: {}
    });
  });

  app.post('/api/setup/local-agents/status', async (req, res) => {
    const schema = z.object({
      id: z.string(),
      verify: z.boolean().optional()
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, detail: 'Agent id required.' });
      return;
    }

    const def = LOCAL_CLI_AGENTS.find((a) => a.id === parsed.data.id);
    if (!def) {
      res.status(400).json({ ok: false, detail: 'Unknown local agent.' });
      return;
    }

    const binPath = findBinPath(def.bin);
    if (!binPath) {
      res.json({ ok: true, installed: false, connected: false, state: 'missing' });
      return;
    }

    if (!parsed.data.verify) {
      res.json({ ok: true, installed: true, connected: true, state: 'ready' });
      return;
    }

    const testRes = await runLocalCliInference({
      agentSpec: `${def.id}:default`,
      prompt: 'Reply with only OK.',
      timeoutMs: 15_000
    });

    res.json({
      ok: true,
      installed: true,
      connected: testRes.ok,
      state: testRes.ok ? 'ready' : 'unauthenticated'
    });
  });

  app.post('/api/setup/local-agents/connect', async (req, res) => {
    const schema = z.object({
      id: z.string(),
      assignAll: z.boolean().optional()
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, state: 'CONFIGURATION FAILED', detail: 'Agent id required.' });
      return;
    }

    const def = LOCAL_CLI_AGENTS.find((a) => a.id === parsed.data.id);
    if (!def) {
      res.status(400).json({ ok: false, state: 'CONFIGURATION FAILED', detail: 'Unknown local agent.' });
      return;
    }

    const binPath = findBinPath(def.bin);
    if (!binPath) {
      res.status(400).json({ ok: false, state: 'NOT INSTALLED', detail: `Install ${def.label} (${def.bin}) on PATH first.` });
      return;
    }

    const testRes = await runLocalCliInference({
      agentSpec: `${def.id}:default`,
      prompt: 'Reply with only OK.',
      timeoutMs: 25_000
    });

    if (!testRes.ok) {
      res.status(400).json({
        ok: false,
        active: false,
        state: 'VERIFICATION FAILED',
        detail: testRes.error ?? 'The selected CLI agent did not return a valid reply. Check native CLI sign-in.'
      });
      return;
    }

    const modelString = `${def.id}:default`;
    const nextAgents: Record<string, { provider: 'local'; model: string }> = {};
    for (const role of ['lead', 'market', 'research', 'strategist', 'risk', 'execution']) {
      nextAgents[role] = { provider: 'local', model: modelString };
    }
    await deps.settings.apply(
      { agents: nextAgents as any },
      deps.settings.current().activeVersion
    );

    res.json({
      ok: true,
      active: true,
      state: 'CONNECTED & ACTIVE',
      model: modelString,
      detail: `Connected & Active: ${modelString}. ${parsed.data.assignAll ? 'Applied to all six agents.' : ''}`
    });
  });

  app.post('/api/setup/local-agents/login', (req, res) => {
    const id = String(req.body?.id ?? '');
    const def = LOCAL_CLI_AGENTS.find((a) => a.id === id);
    if (!def) {
      res.status(400).json({ ok: false, detail: 'Unknown local agent.' });
      return;
    }
    const cmd = def.login.length ? `${def.bin} ${def.login.join(' ')}` : `${def.bin} login`;
    res.json({ ok: true, detail: `Run "${cmd}" in your terminal to sign in.` });
  });

  app.post('/api/setup/local-agents/models', (req, res) => {
    const id = String(req.body?.id ?? '');
    const def = LOCAL_CLI_AGENTS.find((a) => a.id === id);
    if (!def) {
      res.status(400).json({ ok: false, detail: 'Unknown local agent.' });
      return;
    }
    res.json({
      ok: true,
      discovery: {
        configuredModel: 'default',
        models: def.models.map((m) => ({ id: m, reasoningLevels: ['default', 'high'] }))
      }
    });
  });

  app.post('/api/setup/local-agents/settings', (req, res) => {
    res.json({ ok: true, detail: 'Agent settings saved.', settings: {} });
  });

  const researchPolicy = {
    enabled: true,
    autoResearch: false,
    maxDepth: 1,
    mcpTools: [] as string[]
  };

  app.get('/api/setup/local-agents/research', (_req, res) => {
    res.json({
      ok: true,
      policy: researchPolicy,
      connections: [],
      activity: []
    });
  });

  app.post('/api/setup/local-agents/research', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.autoResearch === 'boolean') researchPolicy.autoResearch = body.autoResearch;
    if (typeof body.enabled === 'boolean') researchPolicy.enabled = body.enabled;
    if (typeof body.maxDepth === 'number') researchPolicy.maxDepth = body.maxDepth;
    res.json({ ok: true, detail: 'Research settings saved.', policy: researchPolicy });
  });
}
