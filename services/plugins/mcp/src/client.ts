// Thin HTTP client for the Inova-API-Plugin on the printer (default :5001).
// Every plugin response is wrapped in a Timed envelope:
//   { respondedAt: string, data: T }

export interface Timed<T> {
  respondedAt: string;
  data: T;
}

export class InovaApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    path: string,
  ) {
    super(`Inova API ${status} on ${path}: ${body}`);
  }
}

export class InovaClient {
  constructor(
    private readonly baseUrl: string = process.env.INOVA_API_BASE_URL ??
      "http://192.168.1.146:5001",
    private readonly timeoutMs = 10_000,
  ) {}

  // timeoutMs overrides the default for endpoints that block on physical
  // printer operations (powder-tuning surface/layer/print run for minutes).
  async get<T>(path: string, timeoutMs?: number): Promise<Timed<T>> {
    return this.request<Timed<T>>(path, { method: "GET" }, timeoutMs);
  }

  async post<T>(path: string, body: unknown, timeoutMs?: number): Promise<Timed<T>> {
    return this.request<Timed<T>>(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  }

  // The /jobs and /profiles routes return bare JSON — no Timed envelope.
  async getBare<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  async postBare<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async patchBare<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async putBare<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    timeoutMs?: number,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new InovaApiError(res.status, text, path);
    return JSON.parse(text) as T;
  }
}
