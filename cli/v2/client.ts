export interface CliClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class CliClient {
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(options: CliClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? `http://127.0.0.1:${process.env.PORT || '8787'}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async getHealth(): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/health`);
    if (!res.ok) throw new Error(`Health check failed with status ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  public async getState(): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/state`);
    if (!res.ok) throw new Error(`State fetch failed with status ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  public async tripKill(): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/ops/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ killed: true })
    });
    return res.json() as Promise<Record<string, unknown>>;
  }

  public async releaseKill(): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/unkill`, {
      method: 'POST'
    });
    return res.json() as Promise<Record<string, unknown>>;
  }
}
