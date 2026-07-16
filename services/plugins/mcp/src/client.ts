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

  async get<T>(path: string): Promise<Timed<T>> {
    return this.request<T>(path, { method: "GET" });
  }

  async post<T>(path: string, body: unknown): Promise<Timed<T>> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<Timed<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new InovaApiError(res.status, text, path);
    return JSON.parse(text) as Timed<T>;
  }
}
