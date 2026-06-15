// Zero-dependency Kubernetes API client for the dashboard server's session-dispatch routes.
//
// Mirrors operator/reconciler/k8s.mjs (native fetch, no @kubernetes/client-node, no node_modules —
// the server boot graph must stay dependency-free, see MEMORY server-runtime-has-no-node-modules),
// but DUAL-MODE so the dashboard works whether it runs:
//   - IN-CLUSTER (the DashboardInstance pod): bearer token + namespace from the projected SA at
//     /var/run/secrets/kubernetes.io/serviceaccount; CA trusted via NODE_EXTRA_CA_CERTS at launch.
//   - OUT-OF-CLUSTER (local/dev): PROBAITIO_KUBE_API (https://host:port) + PROBAITIO_KUBE_TOKEN; the
//     API server CA must be trusted by pointing NODE_EXTRA_CA_CERTS at the cluster CA file at process
//     launch (native fetch takes no per-call CA/insecure flag without an npm dep — do NOT reach for
//     the process-global NODE_TLS_REJECT_UNAUTHORIZED=0, which would expose the SA token on every
//     fetch in the server to MITM; mount the CA instead).
//
// Throws { code: 'NO_KUBE' } when neither mode is configured, so handlers can answer
// { configured:false } instead of crashing.

import { readFileSync } from 'node:fs';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

function inClusterToken() {
  try {
    return readFileSync(`${SA}/token`, 'utf8').trim();
  } catch {
    return '';
  }
}

function inClusterHost() {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  if (!host) return '';
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT || '443';
  return `https://${host}:${port}`;
}

// Resolve { base, token } from whichever mode is configured, or throw NO_KUBE.
function resolve() {
  // Re-read each call so a rotated projected token (in-cluster) is picked up.
  const envApi = process.env.PROBAITIO_KUBE_API;
  const envTok = process.env.PROBAITIO_KUBE_TOKEN;
  if (envApi && envTok) {
    return { base: envApi.replace(/\/+$/, ''), token: envTok };
  }
  const base = inClusterHost();
  const token = inClusterToken();
  if (base && token) return { base, token };
  const err = new Error('no Kubernetes API configured (set PROBAITIO_KUBE_API + PROBAITIO_KUBE_TOKEN, or run in-cluster)');
  err.code = 'NO_KUBE';
  throw err;
}

export function isConfigured() {
  try {
    resolve();
    return true;
  } catch {
    return false;
  }
}

// The namespace RemoteSessions live in (where the operator reconciles). Env override wins; else the
// in-cluster SA namespace; else the conventional default.
export function dispatchNamespace() {
  if (process.env.PROBAITIO_OPERATOR_NS) return process.env.PROBAITIO_OPERATOR_NS;
  try {
    return readFileSync(`${SA}/namespace`, 'utf8').trim() || 'probaitio-operator-system';
  } catch {
    return 'probaitio-operator-system';
  }
}

async function call(method, path, { body, contentType } = {}) {
  const { base, token } = resolve();
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    headers['Content-Type'] = contentType || 'application/json';
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${json.message || text}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const RS_BASE = (ns) => `/apis/probaitio.com/v1alpha1/namespaces/${ns}/remotesessions`;

export const remoteSessions = {
  list: (ns) => call('GET', RS_BASE(ns)),
  get: (ns, name) => call('GET', `${RS_BASE(ns)}/${encodeURIComponent(name)}`),
  create: (ns, manifest) => call('POST', RS_BASE(ns), { body: manifest }),
  del: (ns, name) =>
    call('DELETE', `${RS_BASE(ns)}/${encodeURIComponent(name)}`, {
      body: { propagationPolicy: 'Background' },
    }),
};

export { call };
