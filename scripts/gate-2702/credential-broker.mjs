import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GATE_2702_MODEL_DOMAIN = "api.anthropic.com";
export const GATE_2702_BROKER_PLACEHOLDER_TOKEN =
  "gate-2702-host-broker-placeholder-not-a-credential";

const BROKER_SCRIPT = fileURLToPath(import.meta.url);
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const MAX_ACCESS_TOKEN_BYTES = 16 * 1024;
const MAX_HEADER_BYTES = 32 * 1024;
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BROKER_CONNECTIONS = 8;
const MAX_ACTIVE_PROXY_REQUESTS = 4;
const MAX_BUFFERED_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_HEADERS = 128;
const MAX_RESPONSE_HEADER_VALUE_BYTES = 16 * 1024;
const STARTUP_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_POLICY_WALL_TIME_MS = 3_000_000;
const MAX_POLICY_COST_USD = 18;
const MIN_REQUEST_INTERVAL_MS = 10_000;
const MAX_MESSAGES_REQUESTS = 256;
const MAX_OUTPUT_TOKENS_PER_REQUEST = 64 * 1024;
const MAX_TOTAL_OUTPUT_TOKENS = 1_800_000;
// USD per MTok, expressed as micro-USD per token. Input uses the maximum
// 1-hour cache-write rate; output uses the family output rate. These are the
// current Haiku/Sonnet maxima from the canonical pricing table, verified
// 2026-06-12. Body bytes conservatively upper-bound tokenizer input tokens.
const MODEL_FAMILY_RATES_MICRO_USD = Object.freeze({
  haiku: Object.freeze({ input: 2, output: 5 }),
  sonnet: Object.freeze({ input: 6, output: 15 }),
});
// The fixed #2702 Definition allows one arm to run for 3,000,000 ms. Refuse a
// token that could expire inside that window; one extra minute covers launch
// and teardown without pretending this broker implements OAuth refresh.
const MIN_TOKEN_LIFETIME_MS = 3_060_000;

const ALLOWED_REQUESTS = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/hello", authenticate: false }),
  Object.freeze({
    method: "POST",
    path: "/v1/messages?beta=true",
    authenticate: true,
  }),
]);

// perf-index-contract: broker-forwarded-header-membership always-consumed: every admitted upstream request filters each worker header through this fixed membership
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "anthropic-version",
  "content-type",
  "user-agent",
  "x-app",
  "x-claude-code-session-id",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
]);

// perf-index-contract: broker-response-header-membership always-consumed: every accepted upstream response filters each returned header through this fixed membership
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function unlinkIfPresent(path) {
  if (typeof path !== "string" || !path) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function readBoundedRegularFile(path, label) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(path, flags);
  } catch (error) {
    fail(`${label} is not a bounded regular file (${error?.code ?? "open"})`);
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > MAX_CREDENTIAL_BYTES) {
      fail(`${label} is not a bounded regular file`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail(`${label} changed while read`);
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      bytes.fill(0);
      fail(`${label} changed while read`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function readAccessToken(credentialPath, now = Date.now()) {
  const bytes = readBoundedRegularFile(
    credentialPath,
    "subscription credential",
  );
  try {
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("subscription credential is not valid JSON");
    }
    const oauth = parsed?.claudeAiOauth;
    const token = oauth?.accessToken;
    const expiresAt = oauth?.expiresAt;
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      Buffer.byteLength(token) > MAX_ACCESS_TOKEN_BYTES
    ) {
      fail("subscription credential has no bounded Claude OAuth access token");
    }
    if (!Number.isSafeInteger(expiresAt)) {
      fail("subscription credential has no bounded Claude OAuth expiry");
    }
    if (expiresAt <= now + MIN_TOKEN_LIFETIME_MS) {
      fail(
        "subscription OAuth access token is expired or too near expiry; refresh it outside the jail before dispatch",
      );
    }
    return token;
  } finally {
    bytes.fill(0);
  }
}

function headerValues(request, name) {
  if (request.headersDistinct && Array.isArray(request.headersDistinct[name])) {
    return request.headersDistinct[name];
  }
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1]);
    }
  }
  return values;
}

function hasAmbiguousHeaders(request) {
  for (const name of [
    "authorization",
    "x-api-key",
    "host",
    "content-length",
    "content-type",
    "proxy-authorization",
    "transfer-encoding",
  ]) {
    if (headerValues(request, name).length > 1) return true;
  }
  return false;
}

function writeError(response, statusCode, message) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(message),
    connection: "close",
  });
  response.end(message);
}

function writeSocketError(socket, statusCode, message) {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function allowedRequest(method, path) {
  return ALLOWED_REQUESTS.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
}

function boundedRequestPolicy(value) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    !Array.isArray(value.allowedModels) ||
    value.allowedModels.length === 0 ||
    value.allowedModels.length > 3 ||
    value.allowedModels.some(
      (model) =>
        typeof model !== "string" ||
        !/^claude-(?:haiku|sonnet)-[a-z0-9-]+$/.test(model),
    ) ||
    // perf-index-contract: broker-allowed-model-uniqueness always-consumed: every accepted broker policy checks its complete model list for duplicate identities
    new Set(value.allowedModels).size !== value.allowedModels.length ||
    !Number.isSafeInteger(value.wallTimeMs) ||
    value.wallTimeMs <= 0 ||
    value.wallTimeMs > MAX_POLICY_WALL_TIME_MS ||
    !Number.isFinite(value.costCapUsd) ||
    value.costCapUsd <= 0 ||
    value.costCapUsd > MAX_POLICY_COST_USD
  ) {
    fail("credential broker request policy is outside the registered C5 bounds");
  }
  const maxRequests = Math.min(
    MAX_MESSAGES_REQUESTS,
    Math.ceil(value.wallTimeMs / MIN_REQUEST_INTERVAL_MS),
  );
  const maxCostMicroUsd = Math.floor(value.costCapUsd * 1_000_000);
  return {
    allowedModels: [...value.allowedModels],
    wallTimeMs: value.wallTimeMs,
    costCapUsd: value.costCapUsd,
    maxRequests,
    maxTokensPerRequest: MAX_OUTPUT_TOKENS_PER_REQUEST,
    maxTotalOutputTokens: MAX_TOTAL_OUTPUT_TOKENS,
    maxCostMicroUsd,
    maxConnections: MAX_BROKER_CONNECTIONS,
    maxActiveRequests: MAX_ACTIVE_PROXY_REQUESTS,
    maxBufferedRequestBodyBytes: MAX_BUFFERED_REQUEST_BODY_BYTES,
    familyRatesMicroUsd: MODEL_FAMILY_RATES_MICRO_USD,
  };
}

export function gate2702BrokerRequestPolicy(value) {
  return boundedRequestPolicy(value);
}

function reserveBrokerRequest(policy, route, body) {
  if (policy.remainingRequests <= 0) {
    fail("broker request ceiling exhausted");
  }
  let requestedOutputTokens = 0;
  let upstreamBody = body;
  if (route.authenticate) {
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      fail("broker Messages body is not valid JSON");
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      fail("broker Messages body is not an object");
    }
    const values = [parsed];
    let visitedValues = 0;
    let hasExternalSource = false;
    while (values.length > 0) {
      const value = values.pop();
      visitedValues += 1;
      if (visitedValues > 100_000) {
        fail("broker Messages body structure exceeds its bound");
      }
      if (!value || Array.isArray(value) || typeof value !== "object") continue;
      if (
        "file_id" in value ||
        (value.source &&
          !Array.isArray(value.source) &&
          typeof value.source === "object" &&
          ["url", "file"].includes(value.source.type))
      ) {
        hasExternalSource = true;
        break;
      }
      for (const nested of Object.values(value)) {
        if (nested && typeof nested === "object") {
          if (Array.isArray(nested)) {
            for (const item of nested) values.push(item);
          } else values.push(nested);
        }
      }
    }
    requestedOutputTokens = parsed.max_tokens;
    if (
      !policy.metadata.allowedModels.includes(parsed.model) ||
      parsed.stream !== true ||
      "mcp_servers" in parsed ||
      "container" in parsed ||
      hasExternalSource ||
      !Number.isSafeInteger(requestedOutputTokens) ||
      requestedOutputTokens <= 0 ||
      requestedOutputTokens > policy.metadata.maxTokensPerRequest ||
      (parsed.tools !== undefined &&
        (!Array.isArray(parsed.tools) ||
          parsed.tools.some(
            (tool) =>
              !tool ||
              Array.isArray(tool) ||
              typeof tool !== "object" ||
              "type" in tool,
          )))
    ) {
      fail("broker Messages body exceeds its model, tool, or token policy");
    }
    try {
      upstreamBody = Buffer.from(
        JSON.stringify({ ...parsed, service_tier: "standard_only" }),
      );
    } catch {
      fail("broker Messages body cannot be normalized");
    }
    if (requestedOutputTokens > policy.remainingOutputTokens) {
      fail("broker output-token ceiling exhausted");
    }
    const rates = MODEL_FAMILY_RATES_MICRO_USD[
      parsed.model.includes("-sonnet-") ? "sonnet" : "haiku"
    ];
    const requestedCostMicroUsd =
      Math.max(body.length, upstreamBody.length) * rates.input +
      requestedOutputTokens * rates.output;
    if (requestedCostMicroUsd > policy.remainingCostMicroUsd) {
      fail("broker dollar ceiling exhausted");
    }
    policy.remainingCostMicroUsd -= requestedCostMicroUsd;
  }
  policy.remainingRequests -= 1;
  policy.remainingOutputTokens -= requestedOutputTokens;
  return upstreamBody;
}

function waitForDrainOrAbort(response, signal) {
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (drained) => {
      if (settled) return;
      settled = true;
      response.removeListener("drain", onDrain);
      response.removeListener("close", onClose);
      response.removeListener("error", onClose);
      signal.removeEventListener("abort", onClose);
      resolveWait(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onClose);
    signal.addEventListener("abort", onClose, { once: true });
    if (signal.aborted || response.destroyed) onClose();
  });
}

export function waitForGate2702BrokerDrainForTest(response, signal) {
  return waitForDrainOrAbort(response, signal);
}

function forwardHeaders(request, accessToken, authenticate, bodyLength) {
  const headers = {
    host: GATE_2702_MODEL_DOMAIN,
    "content-length": String(bodyLength),
  };
  for (const [name, value] of Object.entries(request.headers)) {
    if (!FORWARDED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    if (Array.isArray(value)) fail(`ambiguous ${name} request header`);
    headers[name] = value;
  }
  if (authenticate) headers.authorization = `Bearer ${accessToken}`;
  return headers;
}

async function readRequestBody(request, expectedBytes, signal) {
  if (expectedBytes > MAX_REQUEST_BODY_BYTES) {
    fail("request body exceeds broker bound");
  }
  const body = Buffer.alloc(expectedBytes);
  let bytes = 0;
  try {
    for await (const chunk of request) {
      if (signal.aborted) fail("request aborted");
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (
        value.length > expectedBytes - bytes ||
        value.length > MAX_REQUEST_BODY_BYTES - bytes
      ) {
        fail("request body exceeds broker bound");
      }
      value.copy(body, bytes);
      bytes += value.length;
    }
    if (bytes !== expectedBytes) fail("request body length is inconsistent");
    return body;
  } catch (error) {
    body.fill(0);
    throw error;
  }
}

export function readGate2702RequestBodyForTest(request, expectedBytes, signal) {
  return readRequestBody(request, expectedBytes, signal);
}

function responseHeaders(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    fail("upstream response headers are invalid");
  }
  const output = {};
  let count = 0;
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(name) ||
      name === "set-cookie" ||
      rawValue === undefined
    ) {
      continue;
    }
    count += 1;
    if (count > MAX_RESPONSE_HEADERS) fail("upstream sent too many headers");
    const joined = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
    if (Buffer.byteLength(joined) > MAX_RESPONSE_HEADER_VALUE_BYTES) {
      fail("upstream response header exceeds broker bound");
    }
    output[name] = joined;
  }
  return output;
}

async function proxyRequest({
  request,
  response,
  accessToken,
  requestPolicy,
  forwardUpstream,
  reserveBufferedRequestBody,
  releaseBufferedRequestBody,
}) {
  const controller = new AbortController();
  let reservedRequestBodyBytes = 0;
  const abort = () => controller.abort();
  request.once("aborted", abort);
  response.once("close", abort);
  request.setTimeout(IDLE_TIMEOUT_MS, () => {
    controller.abort();
    request.destroy();
  });
  try {
    if (
      typeof request.url !== "string" ||
      !request.url.startsWith("/") ||
      request.url.startsWith("//") ||
      request.url.includes("#") ||
      hasAmbiguousHeaders(request)
    ) {
      writeError(response, 400, "malformed broker request");
      return;
    }
    const hostValues = headerValues(request, "host");
    if (
      hostValues.length !== 1 ||
      ![
        GATE_2702_MODEL_DOMAIN,
        `${GATE_2702_MODEL_DOMAIN}:443`,
      ].includes(hostValues[0].toLowerCase())
    ) {
      writeError(response, 403, "broker host denied");
      return;
    }
    if (
      request.headers.upgrade !== undefined ||
      String(request.headers.connection ?? "")
        .toLowerCase()
        .split(",")
        .map((value) => value.trim())
        .includes("upgrade")
    ) {
      writeError(response, 426, "broker upgrades denied");
      return;
    }
    const policy = allowedRequest(request.method, request.url);
    if (!policy) {
      writeError(response, 403, "broker route denied");
      return;
    }
    if (request.headers["transfer-encoding"] !== undefined) {
      writeError(response, 400, "chunked broker requests denied");
      return;
    }
    const contentLengthValues = headerValues(request, "content-length");
    const contentLength =
      contentLengthValues.length === 0 ? 0 : Number(contentLengthValues[0]);
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > MAX_REQUEST_BODY_BYTES
    ) {
      writeError(response, 413, "broker request body denied");
      return;
    }
    if (
      policy.authenticate &&
      request.headers.authorization !==
        `Bearer ${GATE_2702_BROKER_PLACEHOLDER_TOKEN}`
    ) {
      writeError(response, 403, "broker placeholder auth required");
      return;
    }
    if (
      policy.authenticate &&
      (contentLengthValues.length !== 1 ||
        contentLength === 0 ||
        request.headers["content-type"] !== "application/json")
    ) {
      writeError(response, 400, "broker Messages framing denied");
      return;
    }
    if (
      !policy.authenticate &&
      (request.headers.authorization !== undefined ||
        request.headers["x-api-key"] !== undefined ||
        contentLength !== 0)
    ) {
      writeError(response, 403, "broker unauthenticated route denied");
      return;
    }
    if (!reserveBufferedRequestBody(contentLength)) {
      writeError(response, 503, "broker request capacity exhausted");
      return;
    }
    reservedRequestBodyBytes = contentLength;
    const body = await readRequestBody(
      request,
      contentLength,
      controller.signal,
    );
    if (controller.signal.aborted) return;
    let upstreamBody;
    try {
      upstreamBody = reserveBrokerRequest(requestPolicy, policy, body);
    } catch (error) {
      const exhausted = /ceiling exhausted/.test(error?.message ?? "");
      writeError(response, exhausted ? 429 : 403, "broker arm policy denied");
      return;
    }
    let upstream;
    try {
      upstream = await forwardUpstream({
        hostname: GATE_2702_MODEL_DOMAIN,
        servername: GATE_2702_MODEL_DOMAIN,
        method: policy.method,
        path: policy.path,
        headers: forwardHeaders(
          request,
          accessToken,
          policy.authenticate,
          upstreamBody.length,
        ),
        body: upstreamBody,
        signal: controller.signal,
      });
    } catch {
      if (!controller.signal.aborted) {
        writeError(response, 502, "broker upstream unavailable");
      }
      return;
    }
    if (
      !Number.isInteger(upstream?.statusCode) ||
      upstream.statusCode < 100 ||
      upstream.statusCode > 599 ||
      !upstream.body ||
      typeof upstream.body[Symbol.asyncIterator] !== "function"
    ) {
      writeError(response, 502, "broker upstream response invalid");
      return;
    }
    response.writeHead(
      upstream.statusCode,
      responseHeaders(upstream.headers ?? {}),
    );
    let responseBytes = 0;
    for await (const chunk of upstream.body) {
      if (controller.signal.aborted) break;
      responseBytes += Buffer.byteLength(chunk);
      if (responseBytes > MAX_RESPONSE_BODY_BYTES) {
        upstream.body.destroy?.();
        response.destroy();
        break;
      }
      if (
        !response.write(chunk) &&
        !(await waitForDrainOrAbort(response, controller.signal))
      ) {
        upstream.body.destroy?.();
        break;
      }
    }
    if (!controller.signal.aborted) response.end();
  } catch (error) {
    if (!controller.signal.aborted) {
      const status = /exceeds broker bound/.test(error?.message ?? "") ? 413 : 400;
      writeError(response, status, "broker request denied");
    }
  } finally {
    releaseBufferedRequestBody(reservedRequestBodyBytes);
    request.removeListener("aborted", abort);
    response.removeListener("close", abort);
  }
}

function forwardGate2702Upstream(request) {
  return new Promise((resolveRequest, rejectRequest) => {
    const upstream = https.request(
      {
        hostname: GATE_2702_MODEL_DOMAIN,
        servername: GATE_2702_MODEL_DOMAIN,
        port: 443,
        method: request.method,
        path: request.path,
        headers: request.headers,
        agent: false,
        maxHeaderSize: MAX_HEADER_BYTES,
      },
      (response) =>
        resolveRequest({
          statusCode: response.statusCode,
          headers: response.headers,
          body: response,
        }),
    );
    const abort = () => upstream.destroy(new Error("broker request aborted"));
    upstream.once("close", () =>
      request.signal.removeEventListener("abort", abort),
    );
    upstream.once("error", rejectRequest);
    upstream.once("upgrade", (_response, socket) => {
      socket.destroy();
      rejectRequest(new Error("broker upstream upgrade denied"));
    });
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) {
      abort();
      return;
    }
    upstream.setTimeout(IDLE_TIMEOUT_MS, () =>
      upstream.destroy(new Error("broker upstream idle timeout")),
    );
    upstream.end(request.body);
  });
}

export function forwardGate2702UpstreamForTest(request) {
  return forwardGate2702Upstream(request);
}

async function createBroker({
  credentialPath,
  socketPath,
  caCertPath,
  srtPackageRoot,
  requestPolicy,
  forwardUpstream,
}) {
  if (
    typeof credentialPath !== "string" ||
    typeof socketPath !== "string" ||
    typeof caCertPath !== "string" ||
    typeof srtPackageRoot !== "string" ||
    typeof forwardUpstream !== "function"
  ) {
    fail("credential broker configuration is incomplete");
  }
  const policyMetadata = boundedRequestPolicy(requestPolicy);
  const policyState = {
    metadata: policyMetadata,
    remainingRequests: policyMetadata.maxRequests,
    remainingOutputTokens: policyMetadata.maxTotalOutputTokens,
    remainingCostMicroUsd: policyMetadata.maxCostMicroUsd,
  };
  let accessToken = readAccessToken(credentialPath);
  let ca = null;
  let outer = null;
  let closed = false;
  let activeProxyRequests = 0;
  let bufferedRequestBodyBytes = 0;
  // perf-index-contract: broker-socket-membership always-consumed: every successful broker enforces admission and tears down both tracked socket memberships
  const sockets = new Set();
  const innerSockets = new Set();
  try {
    const caModule = await import(
      pathToFileURL(
        join(resolve(srtPackageRoot), "dist", "sandbox", "mitm-ca.js"),
      ).href
    );
    const leafModule = await import(
      pathToFileURL(
        join(resolve(srtPackageRoot), "dist", "sandbox", "mitm-leaf.js"),
      ).href
    );
    ca = caModule.createMitmCA({});
    const leaf = leafModule.mintLeafCert(ca, GATE_2702_MODEL_DOMAIN);
    mkdirSync(dirname(caCertPath), { recursive: true, mode: 0o700 });
    writeFileSync(caCertPath, ca.certPem, { flag: "wx", mode: 0o644 });

    const inner = https.createServer(
      {
        ALPNProtocols: ["http/1.1"],
        cert: leaf.certPem,
        key: leaf.keyPem,
        maxHeaderSize: MAX_HEADER_BYTES,
        requestTimeout: IDLE_TIMEOUT_MS,
        headersTimeout: CONNECT_TIMEOUT_MS,
        keepAliveTimeout: IDLE_TIMEOUT_MS,
      },
      (request, response) => {
        if (activeProxyRequests >= MAX_ACTIVE_PROXY_REQUESTS) {
          writeError(response, 503, "broker request capacity exhausted");
          return;
        }
        activeProxyRequests += 1;
        void proxyRequest({
          request,
          response,
          accessToken,
          requestPolicy: policyState,
          forwardUpstream,
          reserveBufferedRequestBody(bytes) {
            if (
              bytes >
              MAX_BUFFERED_REQUEST_BODY_BYTES - bufferedRequestBodyBytes
            ) {
              return false;
            }
            bufferedRequestBodyBytes += bytes;
            return true;
          },
          releaseBufferedRequestBody(bytes) {
            bufferedRequestBodyBytes -= bytes;
          },
        }).finally(() => {
          activeProxyRequests -= 1;
        });
      },
    );
    inner.on("connection", (socket) => {
      if (
        !sockets.has(socket) ||
        innerSockets.size >= MAX_BROKER_CONNECTIONS
      ) {
        socket.destroy();
        return;
      }
      innerSockets.add(socket);
      socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
      socket.once("close", () => innerSockets.delete(socket));
    });
    inner.on("connect", (_request, socket) =>
      writeSocketError(socket, 403, "Forbidden"),
    );
    inner.on("upgrade", (_request, socket) =>
      writeSocketError(socket, 426, "Upgrade Required"),
    );
    inner.on("clientError", (_error, socket) =>
      writeSocketError(socket, 400, "Bad Request"),
    );

    outer = http.createServer({
      maxHeaderSize: MAX_HEADER_BYTES,
      requestTimeout: CONNECT_TIMEOUT_MS,
      headersTimeout: CONNECT_TIMEOUT_MS,
      keepAliveTimeout: CONNECT_TIMEOUT_MS,
    });
    outer.on("connection", (socket) => {
      if (sockets.size >= MAX_BROKER_CONNECTIONS) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());
      socket.once("close", () => sockets.delete(socket));
    });
    outer.on("request", (_request, response) =>
      writeError(response, 403, "broker CONNECT required"),
    );
    outer.on("upgrade", (_request, socket) =>
      writeSocketError(socket, 426, "Upgrade Required"),
    );
    outer.on("clientError", (_error, socket) =>
      writeSocketError(socket, 400, "Bad Request"),
    );
    outer.on("connect", (request, socket, head) => {
      const target = `${GATE_2702_MODEL_DOMAIN}:443`;
      const hosts = headerValues(request, "host");
      if (
        request.url !== target ||
        hosts.length !== 1 ||
        hosts[0].toLowerCase() !== target ||
        hasAmbiguousHeaders(request)
      ) {
        writeSocketError(socket, 403, "Forbidden");
        return;
      }
      socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.unshift(head);
      inner.emit("connection", socket);
    });

    unlinkIfPresent(socketPath);
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => rejectListen(error);
      outer.once("error", onError);
      outer.listen(socketPath, () => {
        outer.removeListener("error", onError);
        resolveListen();
      });
    });
    chmodSync(socketPath, 0o600);
    await caModule.disposeMitmCA(ca);
    ca = null;

    const close = async () => {
      if (closed) return;
      closed = true;
      for (const socket of [...innerSockets, ...sockets]) socket.destroy();
      if (outer?.listening) {
        await new Promise((resolveClose) => outer.close(() => resolveClose()));
      }
      unlinkIfPresent(socketPath);
      unlinkIfPresent(caCertPath);
      accessToken = null;
    };
    return {
      socketPath,
      caCertPath,
      caCertDigest: sha256(readBoundedRegularFile(caCertPath, "broker CA")),
      credentialMode: "host-proxy-bearer-injection",
      modelDomain: GATE_2702_MODEL_DOMAIN,
      allowedRequests: ALLOWED_REQUESTS.map(({ method, path }) => ({ method, path })),
      requestPolicy: policyMetadata,
      close,
    };
  } catch (error) {
    for (const socket of [...innerSockets, ...sockets]) socket.destroy();
    if (outer?.listening) {
      await new Promise((resolveClose) => outer.close(() => resolveClose()));
    }
    unlinkIfPresent(socketPath);
    unlinkIfPresent(caCertPath);
    if (ca) {
      try {
        const caModule = await import(
          pathToFileURL(
            join(resolve(srtPackageRoot), "dist", "sandbox", "mitm-ca.js"),
          ).href
        );
        await caModule.disposeMitmCA(ca);
      } catch {
        // The broker is already failing closed. Its short-lived child process
        // exits immediately, reclaiming any in-memory CA/token state.
      }
    }
    accessToken = null;
    throw error;
  }
}

export async function startGate2702CredentialBrokerForTest(options) {
  return createBroker(options);
}

export function startGate2702CredentialBroker({
  credentialPath,
  socketPath,
  caCertPath,
  srtPackageRoot,
  requestPolicy,
}) {
  return new Promise((resolveStart, rejectStart) => {
    const child = spawn(
      process.execPath,
      [
        BROKER_SCRIPT,
        "__serve",
        JSON.stringify({
          credentialPath,
          socketPath,
          caCertPath,
          srtPackageRoot,
          requestPolicy,
        }),
      ],
      {
        env: {
          PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          NO_COLOR: "1",
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      },
    );
    const cleanupArtifacts = () => {
      unlinkIfPresent(socketPath);
      unlinkIfPresent(caCertPath);
    };
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("exit", onStartupExit);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => {
        cleanupArtifacts();
        rejectStart(new Error("credential broker startup timed out"));
      });
    }, STARTUP_TIMEOUT_MS);
    const onError = (error) =>
      finish(() => {
        cleanupArtifacts();
        rejectStart(error);
      });
    const onStartupExit = (code, signal) =>
      finish(() => {
        cleanupArtifacts();
        rejectStart(
          new Error(
            `credential broker exited before readiness (${code ?? signal ?? "unknown"})`,
          ),
        );
      });
    const onMessage = (message) => {
      if (message?.type === "error") {
        finish(() => {
          cleanupArtifacts();
          rejectStart(new Error(message.message || "credential broker failed"));
        });
        return;
      }
      if (message?.type !== "ready") return;
      finish(() => {
        const close = () =>
          new Promise((resolveClose, rejectClose) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              cleanupArtifacts();
              resolveClose();
              return;
            }
            let done = false;
            let killTimer;
            const finishClose = () => {
              if (done) return;
              done = true;
              clearTimeout(killTimer);
              try {
                cleanupArtifacts();
                resolveClose();
              } catch (error) {
                rejectClose(error);
              }
            };
            child.once("exit", finishClose);
            child.send({ type: "close" }, (error) => {
              if (error) child.kill("SIGTERM");
            });
            killTimer = setTimeout(() => {
              child.kill("SIGKILL");
              finishClose();
            }, SHUTDOWN_TIMEOUT_MS);
          });
        resolveStart({ ...message.metadata, process: child, close });
      });
    };
    // This listener intentionally survives readiness. A SIGKILL or crash cannot
    // run the child's close handler, so the parent owns deterministic residue
    // cleanup as well.
    child.on("exit", () => {
      try {
        cleanupArtifacts();
      } catch {
        // close() repeats cleanup and surfaces a deterministic failure to the
        // caller; never crash the supervising process from an event handler.
      }
    });
    child.once("error", onError);
    child.once("exit", onStartupExit);
    child.on("message", onMessage);
  });
}

async function serveBroker(config) {
  let broker;
  let closing = false;
  const close = async (exitCode = 0) => {
    if (closing) return;
    closing = true;
    try {
      await broker?.close();
    } finally {
      process.disconnect?.();
      process.exit(exitCode);
    }
  };
  try {
    broker = await createBroker({
      ...config,
      forwardUpstream: forwardGate2702Upstream,
    });
    process.on("message", (message) => {
      if (message?.type === "close") void close(0);
    });
    process.once("disconnect", () => void close(0));
    process.once("SIGTERM", () => void close(0));
    process.once("SIGINT", () => void close(0));
    process.send?.({
      type: "ready",
      metadata: {
        socketPath: broker.socketPath,
        caCertPath: broker.caCertPath,
        caCertDigest: broker.caCertDigest,
        credentialMode: broker.credentialMode,
        modelDomain: broker.modelDomain,
        allowedRequests: broker.allowedRequests,
        requestPolicy: broker.requestPolicy,
      },
    });
  } catch (error) {
    process.send?.({
      type: "error",
      message: error?.message || "credential broker failed closed",
    });
    await close(1);
  }
}

if (process.argv[2] === "__serve") {
  let config;
  try {
    config = JSON.parse(process.argv[3]);
  } catch {
    process.send?.({ type: "error", message: "credential broker config invalid" });
    process.exit(1);
  }
  void serveBroker(config);
}
