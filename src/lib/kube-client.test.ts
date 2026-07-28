import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error The zero-dependency server runtime module intentionally ships without types.
import { call } from '../../scripts/lib/kube-client.mjs';

async function listenOnLoopback(
  onRequest: Parameters<typeof createServer>[0],
) {
  const server = createServer(onRequest);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
  };
}

async function closeServer(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('Kubernetes API endpoint validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('rejects plaintext HTTP before the bearer token reaches the listener', async () => {
    const receivedAuthorizationHeaders: string[] = [];
    const { server, port } = await listenOnLoopback((request, response) => {
      receivedAuthorizationHeaders.push(request.headers.authorization ?? '');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });

    vi.stubEnv('PROBAITIO_KUBE_API', `http://127.0.0.1:${port}`);
    vi.stubEnv('PROBAITIO_KUBE_TOKEN', 'kube-audit-sentinel-token');

    try {
      await expect(call('GET', '/version')).rejects.toThrow(
        'PROBAITIO_KUBE_API must use HTTPS',
      );
      expect(receivedAuthorizationHeaders).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it('accepts HTTPS and sends the request to its normalized origin', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubEnv(
      'PROBAITIO_KUBE_API',
      'https://EXAMPLE.test:443/ignored/path?query=yes#fragment',
    );
    vi.stubEnv('PROBAITIO_KUBE_TOKEN', 'kube-audit-sentinel-token');

    await call('GET', '/version');

    expect(requestedUrls).toEqual(['https://example.test/version']);
  });

  it('rejects credentials embedded in the API endpoint', async () => {
    vi.stubEnv(
      'PROBAITIO_KUBE_API',
      'https://cluster-user:cluster-password@127.0.0.1:1',
    );
    vi.stubEnv('PROBAITIO_KUBE_TOKEN', 'kube-audit-sentinel-token');

    await expect(call('GET', '/version')).rejects.toThrow(
      'PROBAITIO_KUBE_API must not include credentials',
    );
  });

  it('rejects a malformed API endpoint', async () => {
    vi.stubEnv('PROBAITIO_KUBE_API', 'https://[invalid-host');
    vi.stubEnv('PROBAITIO_KUBE_TOKEN', 'kube-audit-sentinel-token');

    await expect(call('GET', '/version')).rejects.toThrow(
      'PROBAITIO_KUBE_API must be a valid HTTPS URL',
    );
  });
});
