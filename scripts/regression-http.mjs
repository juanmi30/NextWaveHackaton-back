export function createRegressionHttpClient(configuredUrl = process.env.API_URL) {
  const raw = (configuredUrl ?? 'http://127.0.0.1:3000/api').replace(/\/$/, '');
  const apiUrl = raw.endsWith('/api') ? raw : `${raw}/api`;
  const originUrl = apiUrl.slice(0, -4);

  async function request(path, options = {}) {
    const method = options.method ?? 'GET';
    const url = `${options.root ? originUrl : apiUrl}${path}`;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    try {
      const response = await nativeRequest(url, {
        method,
        timeoutMs,
        body,
        headers: { 'content-type': 'application/json', ...options.headers },
      });
      const text = response.text;
      let payload;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }
      if (response.status < 200 || response.status >= 300) {
        console.error(`[HTTP ${response.status}]\n${method} ${url}\n${summarizeBody(payload)}`);
        throw new Error(`${method} ${url} returned HTTP ${response.status}`);
      }
      return payload;
    } catch (error) {
      if (error instanceof Error && error.message.includes('returned HTTP')) throw error;
      const cause = error?.cause;
      console.error([
        '[HTTP TRANSPORT ERROR]',
        `${method} ${url}`,
        `name=${error?.name ?? 'UnknownError'}`,
        `message=${error?.message ?? String(error)}`,
        `cause.code=${cause?.code ?? ''}`,
        `cause.message=${cause?.message ?? ''}`,
        `cause.address=${cause?.address ?? ''}`,
        `cause.port=${cause?.port ?? ''}`,
        `cause.errno=${cause?.errno ?? ''}`,
        `cause.syscall=${cause?.syscall ?? ''}`,
      ].join('\n'));
      throw error;
    }
  }

  return {
    apiUrl,
    get: (path, options) => request(path, options),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    health: () => request('/health', { root: true }),
  };
}

function nativeRequest(url, { method, timeoutMs, body, headers }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = transport(parsed, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
      },
    }, (response) => {
      response.setEncoding('utf8');
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
    });
    request.setTimeout(timeoutMs, () => {
      const error = new Error(`Request timed out after ${timeoutMs}ms`);
      error.name = 'TimeoutError';
      request.destroy(error);
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function summarizeBody(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return text.length > 4_000 ? `${text.slice(0, 4_000)}\n...[truncated]` : text;
}
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
