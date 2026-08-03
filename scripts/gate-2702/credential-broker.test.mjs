import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CURRENT_FAMILY_PRICING } from "../../src/lib/model-registry.ts";
import {
  GATE_2702_BROKER_PLACEHOLDER_TOKEN,
  GATE_2702_MODEL_DOMAIN,
  forwardGate2702UpstreamForTest,
  gate2702BrokerRequestPolicy,
  readGate2702RequestBodyForTest,
  startGate2702CredentialBroker,
  startGate2702CredentialBrokerForTest,
  waitForGate2702BrokerDrainForTest,
} from "./credential-broker.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRT_PACKAGE_ROOT = resolve(
  HERE,
  "..",
  "..",
  "node_modules",
  "@anthropic-ai",
  "sandbox-runtime",
);
const TEST_MODEL = "claude-haiku-4-5-20251001";
const TEST_REQUEST_POLICY = Object.freeze({
  allowedModels: [TEST_MODEL],
  wallTimeMs: 3_000_000,
  costCapUsd: 18,
});

test("broker reservations track canonical Haiku and Sonnet price maxima", () => {
  const policy = gate2702BrokerRequestPolicy(TEST_REQUEST_POLICY);
  assert.deepEqual(policy.familyRatesMicroUsd, {
    haiku: {
      input: CURRENT_FAMILY_PRICING.haiku.cacheWrite1h,
      output: CURRENT_FAMILY_PRICING.haiku.output,
    },
    sonnet: {
      input: CURRENT_FAMILY_PRICING.sonnet.cacheWrite1h,
      output: CURRENT_FAMILY_PRICING.sonnet.output,
    },
  });
  assert.equal(policy.maxConnections, 8);
  assert.equal(policy.maxActiveRequests, 4);
  assert.equal(policy.maxBufferedRequestBodyBytes, 8 * 1024 * 1024);
});

test("request bodies use one admitted buffer instead of a retained chunk corpus", async () => {
  const originalConcat = Buffer.concat;
  Buffer.concat = () => {
    throw new Error("request body must not use Buffer.concat");
  };
  try {
    const body = await readGate2702RequestBodyForTest(
      Readable.from([Buffer.from("bounded "), Buffer.from("body")]),
      12,
      new AbortController().signal,
    );
    assert.equal(body.length, 12);
    assert.equal(body.toString("utf8"), "bounded body");
  } finally {
    Buffer.concat = originalConcat;
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gate-2702-broker-"));
  const credentialPath = join(root, ".credentials.json");
  const socketPath = join(root, "broker.sock");
  const caCertPath = join(root, "broker-ca.crt");
  const credentialCanary = `credential-canary-${process.pid}-${Date.now()}`;
  writeFileSync(
    credentialPath,
    `${JSON.stringify({
      mcpOAuth: {
        hostile: {
          accessToken: "mcp-token-must-never-enter-the-broker",
          refreshToken: "mcp-refresh-must-never-enter-the-broker",
        },
      },
      claudeAiOauth: {
        accessToken: credentialCanary,
        refreshToken: "refresh-token-must-stay-on-host",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    })}\n`,
    { mode: 0o600 },
  );
  return {
    root,
    credentialPath,
    socketPath,
    caCertPath,
    credentialCanary,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function connectThroughBroker(socketPath, target = `${GATE_2702_MODEL_DOMAIN}:443`) {
  const socket = net.createConnection({ path: socketPath });
  await once(socket, "connect");
  socket.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nConnection: keep-alive\r\n\r\n`,
  );
  let response = Buffer.alloc(0);
  while (!response.includes("\r\n\r\n")) {
    const [chunk] = await once(socket, "data");
    response = Buffer.concat([response, chunk]);
    assert.ok(response.length <= 16 * 1024, "CONNECT response stayed bounded");
  }
  const boundary = response.indexOf("\r\n\r\n") + 4;
  const head = response.subarray(0, boundary).toString("latin1");
  const remainder = response.subarray(boundary);
  if (remainder.length) socket.unshift(remainder);
  return { socket, head };
}

function within(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not settle within ${milliseconds}ms`)),
      milliseconds,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function openPartialMessagesRequest(socketPath, contentLength) {
  const connected = await connectThroughBroker(socketPath);
  assert.match(connected.head, /^HTTP\/1\.1 200 /);
  const secure = tls.connect({
    socket: connected.socket,
    servername: GATE_2702_MODEL_DOMAIN,
    ca: readFileSync(join(dirname(socketPath), "broker-ca.crt")),
    ALPNProtocols: ["http/1.1"],
  });
  await once(secure, "secureConnect");
  secure.write(
    [
      "POST /v1/messages?beta=true HTTP/1.1",
      `Host: ${GATE_2702_MODEL_DOMAIN}`,
      `Authorization: Bearer ${GATE_2702_BROKER_PLACEHOLDER_TOKEN}`,
      "Content-Type: application/json",
      `Content-Length: ${contentLength}`,
      "Expect: 100-continue",
      "Connection: close",
      "",
      "",
    ].join("\r\n"),
  );
  let response = Buffer.alloc(0);
  while (!response.includes("\r\n\r\n")) {
    const [chunk] = await within(
      once(secure, "data"),
      1_000,
      "partial request acknowledgement",
    );
    response = Buffer.concat([response, chunk]);
    assert.ok(response.length <= 16 * 1024);
  }
  assert.match(response.toString("latin1"), /^HTTP\/1\.1 100 Continue/);
  secure.write("{");
  return secure;
}

async function messagesRequestEventually(socketPath, body, expectedStatusCode) {
  let lastResponse;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    lastResponse = await messagesRequest(socketPath, body);
    if (lastResponse.statusCode === expectedStatusCode) return lastResponse;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.equal(lastResponse?.statusCode, expectedStatusCode);
  return lastResponse;
}

async function rawTlsRequest(socketPath, rawRequest) {
  const connected = await connectThroughBroker(socketPath);
  assert.match(connected.head, /^HTTP\/1\.1 200 /);
  const secure = tls.connect({
    socket: connected.socket,
    servername: GATE_2702_MODEL_DOMAIN,
    ca: readFileSync(join(dirname(socketPath), "broker-ca.crt")),
    ALPNProtocols: ["http/1.1"],
  });
  await once(secure, "secureConnect");
  secure.end(rawRequest);
  const chunks = [];
  secure.on("data", (chunk) => chunks.push(chunk));
  await once(secure, "close");
  return Buffer.concat(chunks).toString("utf8");
}

async function messagesRequest(socketPath, body) {
  const raw = await rawTlsRequest(
    socketPath,
    [
      "POST /v1/messages?beta=true HTTP/1.1",
      `Host: ${GATE_2702_MODEL_DOMAIN}`,
      `Authorization: Bearer ${GATE_2702_BROKER_PLACEHOLDER_TOKEN}`,
      "X-Api-Key: worker-controlled-api-key",
      "Proxy-Authorization: Basic worker-controlled",
      "Anthropic-Version: 2023-06-01",
      "Anthropic-Beta: oauth-2025-04-20",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
  const boundary = raw.indexOf("\r\n\r\n");
  assert.notEqual(boundary, -1);
  const head = raw.slice(0, boundary).split("\r\n");
  const statusCode = Number(head[0].split(" ")[1]);
  const headers = Object.fromEntries(
    head.slice(1).map((line) => {
      const separator = line.indexOf(":");
      return [
        line.slice(0, separator).toLowerCase(),
        line.slice(separator + 1).trim(),
      ];
    }),
  );
  return { statusCode, headers, body: raw.slice(boundary + 4) };
}

async function messagesHeadersOnlyRequest(socketPath, contentLength) {
  const raw = await rawTlsRequest(
    socketPath,
    [
      "POST /v1/messages?beta=true HTTP/1.1",
      `Host: ${GATE_2702_MODEL_DOMAIN}`,
      `Authorization: Bearer ${GATE_2702_BROKER_PLACEHOLDER_TOKEN}`,
      "Content-Type: application/json",
      `Content-Length: ${contentLength}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n"),
  );
  return Number(raw.slice(0, raw.indexOf("\r\n")).split(" ")[1]);
}

test("the broker replaces worker auth and streams the real Messages SSE shape", async () => {
  const value = fixture();
  const upstream = [];
  let broker;
  try {
    broker = await startGate2702CredentialBrokerForTest({
      credentialPath: value.credentialPath,
      socketPath: value.socketPath,
      caCertPath: value.caCertPath,
      srtPackageRoot: SRT_PACKAGE_ROOT,
      requestPolicy: TEST_REQUEST_POLICY,
      async forwardUpstream(request) {
        upstream.push(request);
        if (request.path === "/api/hello") {
          return {
            statusCode: 200,
            headers: { "content-type": "application/json" },
            body: Readable.from(['{"message":"hello"}']),
          };
        }
        return {
          statusCode: 200,
          headers: { "content-type": "text/event-stream" },
          body: Readable.from([
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","content":[],"model":"claude-haiku-4-5-20251001","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ]),
        };
      },
    });

    const body = JSON.stringify({
      model: TEST_MODEL,
      max_tokens: 8,
      stream: true,
      service_tier: "auto",
      messages: [{ role: "user", content: "ordinary bounded task" }],
    });
    const response = await messagesRequest(value.socketPath, body);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["content-type"], "text/event-stream");
    assert.match(response.body, /event: message_start/);
    assert.match(response.body, /event: content_block_delta/);
    assert.match(response.body, /event: message_stop/);
    assert.equal(response.body.includes(value.credentialCanary), false);

    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].method, "POST");
    assert.equal(upstream[0].path, "/v1/messages?beta=true");
    assert.equal(upstream[0].hostname, GATE_2702_MODEL_DOMAIN);
    assert.equal(upstream[0].servername, GATE_2702_MODEL_DOMAIN);
    assert.equal(
      upstream[0].headers.authorization,
      `Bearer ${value.credentialCanary}`,
    );
    assert.equal(upstream[0].headers["x-api-key"], undefined);
    assert.equal(upstream[0].headers["proxy-authorization"], undefined);
    assert.deepEqual(JSON.parse(upstream[0].body.toString("utf8")), {
      ...JSON.parse(body),
      service_tier: "standard_only",
    });
    assert.equal(upstream[0].body.includes(value.credentialCanary), false);

    const hello = await rawTlsRequest(
      value.socketPath,
      `GET /api/hello HTTP/1.1\r\nHost: ${GATE_2702_MODEL_DOMAIN}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(hello, /^HTTP\/1\.1 200 /);
    assert.match(hello, /\r\n\r\n(?:[0-9a-f]+\r\n)?\{"message":"hello"\}/i);
    assert.equal(upstream.length, 2);
    assert.equal(upstream[1].method, "GET");
    assert.equal(upstream[1].path, "/api/hello");
    assert.equal(upstream[1].headers.authorization, undefined);
    assert.equal(statSync(value.socketPath).mode & 0o777, 0o600);
  } finally {
    await broker?.close();
    assert.equal(existsSync(value.socketPath), false);
    value.cleanup();
  }
});

test("the broker rejects wrong targets, paths, upgrades, and ambiguous headers", async () => {
  const value = fixture();
  const upstream = [];
  let broker;
  try {
    broker = await startGate2702CredentialBrokerForTest({
      credentialPath: value.credentialPath,
      socketPath: value.socketPath,
      caCertPath: value.caCertPath,
      srtPackageRoot: SRT_PACKAGE_ROOT,
      requestPolicy: TEST_REQUEST_POLICY,
      async forwardUpstream(request) {
        upstream.push(request);
        return {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: Readable.from(['{"ok":true}']),
        };
      },
    });

    const wrongTarget = await connectThroughBroker(
      value.socketPath,
      "attacker.invalid:443",
    );
    assert.match(wrongTarget.head, /^HTTP\/1\.1 403 /);
    wrongTarget.socket.destroy();

    const wrongModel = JSON.stringify({
      model: "claude-sonnet-5-20990101",
      max_tokens: 8,
      stream: true,
      messages: [],
    });
    const excessiveOutput = JSON.stringify({
      model: TEST_MODEL,
      max_tokens: 65_537,
      stream: true,
      messages: [],
    });
    const serverExpandedBodies = [
      {
        mcp_servers: [{ type: "url", url: "https://attacker.invalid/mcp" }],
      },
      { container: { id: "container_attacker" } },
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "url", url: "https://attacker.invalid/a.pdf" },
              },
            ],
          },
        ],
      },
      { tools: [{ type: "web_search_20250305", name: "web_search" }] },
    ].map((extra) =>
      JSON.stringify({
        model: TEST_MODEL,
        max_tokens: 8,
        stream: true,
        messages: [],
        ...extra,
      }),
    );

    for (const raw of [
      `POST /v1/admin HTTP/1.1\r\nHost: ${GATE_2702_MODEL_DOMAIN}\r\nContent-Length: 0\r\n\r\n`,
      `POST https://${GATE_2702_MODEL_DOMAIN}/v1/messages?beta=true HTTP/1.1\r\nHost: ${GATE_2702_MODEL_DOMAIN}\r\nContent-Length: 0\r\n\r\n`,
      `GET /v1/messages?beta=true HTTP/1.1\r\nHost: ${GATE_2702_MODEL_DOMAIN}\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\n`,
      `CONNECT ${GATE_2702_MODEL_DOMAIN}:443 HTTP/1.1\r\nHost: ${GATE_2702_MODEL_DOMAIN}\r\n\r\n`,
      `POST /v1/messages?beta=true HTTP/1.1\r\nHost: ${GATE_2702_MODEL_DOMAIN}\r\nAuthorization: Bearer one\r\nAuthorization: Bearer two\r\nContent-Length: 0\r\n\r\n`,
      `POST /v1/messages?beta=true HTTP/1.1\r\nHost: ${GATE_2702_MODEL_DOMAIN}\r\nAuthorization: Bearer ${GATE_2702_BROKER_PLACEHOLDER_TOKEN}\r\nX-Api-Key: one\r\nX-Api-Key: two\r\nContent-Length: 0\r\n\r\n`,
      `POST /v1/messages?beta=true HTTP/1.1\r\nHost: ${GATE_2702_MODEL_DOMAIN}\r\nAuthorization: Bearer ${GATE_2702_BROKER_PLACEHOLDER_TOKEN}\r\nContent-Length: 0\r\nContent-Length: 1\r\n\r\n`,
      `POST /v1/messages?beta=true HTTP/1.1\r\nHost: ${GATE_2702_MODEL_DOMAIN}\r\nAuthorization: Bearer ${GATE_2702_BROKER_PLACEHOLDER_TOKEN}\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n`,
      `POST /v1/messages?beta=true HTTP/1.1\r\nHost: ${GATE_2702_MODEL_DOMAIN}\r\nAuthorization: Bearer ${GATE_2702_BROKER_PLACEHOLDER_TOKEN}\r\nContent-Length: ${9 * 1024 * 1024}\r\n\r\n`,
      `POST /v1/messages?beta=true HTTP/1.1\r\nHost: ${GATE_2702_MODEL_DOMAIN}\r\nAuthorization: Bearer ${GATE_2702_BROKER_PLACEHOLDER_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(wrongModel)}\r\n\r\n${wrongModel}`,
      `POST /v1/messages?beta=true HTTP/1.1\r\nHost: ${GATE_2702_MODEL_DOMAIN}\r\nAuthorization: Bearer ${GATE_2702_BROKER_PLACEHOLDER_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(excessiveOutput)}\r\n\r\n${excessiveOutput}`,
      ...serverExpandedBodies.map(
        (expanded) =>
          `POST /v1/messages?beta=true HTTP/1.1\r\nHost: ${GATE_2702_MODEL_DOMAIN}\r\nAuthorization: Bearer ${GATE_2702_BROKER_PLACEHOLDER_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(expanded)}\r\n\r\n${expanded}`,
      ),
    ]) {
      const response = await rawTlsRequest(value.socketPath, raw);
      assert.match(response, /^HTTP\/1\.1 (400|403|413|426) /);
    }
    assert.equal(upstream.length, 0);
  } finally {
    await broker?.close();
    value.cleanup();
  }
});

test("the broker enforces its own per-arm request and output-token ceilings", async () => {
  const value = fixture();
  let broker;
  let upstreamCalls = 0;
  try {
    broker = await startGate2702CredentialBrokerForTest({
      credentialPath: value.credentialPath,
      socketPath: value.socketPath,
      caCertPath: value.caCertPath,
      srtPackageRoot: SRT_PACKAGE_ROOT,
      requestPolicy: {
        allowedModels: [TEST_MODEL],
        wallTimeMs: 1,
        costCapUsd: 1,
      },
      async forwardUpstream() {
        upstreamCalls += 1;
        return {
          statusCode: 200,
          headers: { "content-type": "text/event-stream" },
          body: Readable.from(["event: message_stop\ndata: {}\n\n"]),
        };
      },
    });
    const body = JSON.stringify({
      model: TEST_MODEL,
      max_tokens: 8,
      stream: true,
      messages: [],
    });
    assert.equal((await messagesRequest(value.socketPath, body)).statusCode, 200);
    assert.equal((await messagesRequest(value.socketPath, body)).statusCode, 429);
    assert.equal(upstreamCalls, 1);
  } finally {
    await broker?.close();
    value.cleanup();
  }
});

test("repeated large inputs exhaust the broker dollar reservation", async () => {
  const value = fixture();
  let broker;
  let upstreamCalls = 0;
  try {
    broker = await startGate2702CredentialBrokerForTest({
      credentialPath: value.credentialPath,
      socketPath: value.socketPath,
      caCertPath: value.caCertPath,
      srtPackageRoot: SRT_PACKAGE_ROOT,
      requestPolicy: {
        allowedModels: [TEST_MODEL],
        wallTimeMs: 100_000,
        costCapUsd: 0.005,
      },
      async forwardUpstream() {
        upstreamCalls += 1;
        return {
          statusCode: 200,
          headers: { "content-type": "text/event-stream" },
          body: Readable.from(["event: message_stop\ndata: {}\n\n"]),
        };
      },
    });
    const body = JSON.stringify({
      model: TEST_MODEL,
      max_tokens: 8,
      stream: true,
      messages: [{ role: "user", content: "x".repeat(1_000) }],
    });
    assert.equal((await messagesRequest(value.socketPath, body)).statusCode, 200);
    assert.equal((await messagesRequest(value.socketPath, body)).statusCode, 200);
    assert.equal((await messagesRequest(value.socketPath, body)).statusCode, 429);
    assert.equal(upstreamCalls, 2);
  } finally {
    await broker?.close();
    value.cleanup();
  }
});

test("Sonnet max-output reservations exhaust the registered dollar cap", async () => {
  const value = fixture();
  const sonnetModel = "claude-sonnet-5";
  let broker;
  let upstreamCalls = 0;
  try {
    broker = await startGate2702CredentialBrokerForTest({
      credentialPath: value.credentialPath,
      socketPath: value.socketPath,
      caCertPath: value.caCertPath,
      srtPackageRoot: SRT_PACKAGE_ROOT,
      requestPolicy: {
        allowedModels: [sonnetModel],
        wallTimeMs: 100_000,
        costCapUsd: 1,
      },
      async forwardUpstream() {
        upstreamCalls += 1;
        return {
          statusCode: 200,
          headers: { "content-type": "text/event-stream" },
          body: Readable.from(["event: message_stop\ndata: {}\n\n"]),
        };
      },
    });
    const body = JSON.stringify({
      model: sonnetModel,
      max_tokens: 65_536,
      stream: true,
      messages: [],
    });
    assert.equal((await messagesRequest(value.socketPath, body)).statusCode, 200);
    assert.equal((await messagesRequest(value.socketPath, body)).statusCode, 429);
    assert.equal(upstreamCalls, 1);
  } finally {
    await broker?.close();
    value.cleanup();
  }
});

test("the broker bounds physical connections and releases them for later work", async () => {
  const value = fixture();
  const held = [];
  let broker;
  let upstreamCalls = 0;
  try {
    broker = await startGate2702CredentialBrokerForTest({
      credentialPath: value.credentialPath,
      socketPath: value.socketPath,
      caCertPath: value.caCertPath,
      srtPackageRoot: SRT_PACKAGE_ROOT,
      requestPolicy: {
        allowedModels: [TEST_MODEL],
        wallTimeMs: 1,
        costCapUsd: 1,
      },
      async forwardUpstream() {
        upstreamCalls += 1;
        return {
          statusCode: 200,
          headers: { "content-type": "text/event-stream" },
          body: Readable.from(["event: message_stop\ndata: {}\n\n"]),
        };
      },
    });
    for (let index = 0; index < 8; index += 1) {
      const socket = net.createConnection({ path: value.socketPath });
      await once(socket, "connect");
      held.push(socket);
    }

    const excess = net.createConnection({ path: value.socketPath });
    excess.on("error", () => {});
    await within(once(excess, "close"), 1_000, "excess broker connection");
    assert.equal(upstreamCalls, 0);

    const released = held.pop();
    released.destroy();
    await once(released, "close");
    await new Promise((resolveWait) => setImmediate(resolveWait));

    const body = JSON.stringify({
      model: TEST_MODEL,
      max_tokens: 8,
      stream: true,
      messages: [],
    });
    assert.equal((await messagesRequest(value.socketPath, body)).statusCode, 200);
    assert.equal(upstreamCalls, 1);
  } finally {
    for (const socket of held) socket.destroy();
    await within(broker?.close(), 1_000, "connection-bound broker cleanup");
    value.cleanup();
  }
});

test("active partial requests are capped before reservation and release on abort and completion", async () => {
  const value = fixture();
  const held = [];
  let broker;
  let upstreamCalls = 0;
  const body = JSON.stringify({
    model: TEST_MODEL,
    max_tokens: 8,
    stream: true,
    messages: [],
  });
  try {
    broker = await startGate2702CredentialBrokerForTest({
      credentialPath: value.credentialPath,
      socketPath: value.socketPath,
      caCertPath: value.caCertPath,
      srtPackageRoot: SRT_PACKAGE_ROOT,
      requestPolicy: {
        allowedModels: [TEST_MODEL],
        wallTimeMs: 20_000,
        costCapUsd: 1,
      },
      async forwardUpstream() {
        upstreamCalls += 1;
        return {
          statusCode: 200,
          headers: { "content-type": "text/event-stream" },
          body: Readable.from(["event: message_stop\ndata: {}\n\n"]),
        };
      },
    });
    for (let index = 0; index < 4; index += 1) {
      held.push(await openPartialMessagesRequest(value.socketPath, 1024));
    }

    assert.equal((await messagesRequest(value.socketPath, body)).statusCode, 503);
    assert.equal(upstreamCalls, 0);

    const aborted = held.pop();
    aborted.destroy();
    await once(aborted, "close");
    assert.equal(
      (await messagesRequestEventually(value.socketPath, body, 200)).statusCode,
      200,
    );
    assert.equal((await messagesRequest(value.socketPath, body)).statusCode, 200);
    assert.equal((await messagesRequest(value.socketPath, body)).statusCode, 429);
    assert.equal(upstreamCalls, 2);

    await within(broker.close(), 1_000, "active-request broker cleanup");
    broker = null;
  } finally {
    for (const socket of held) socket.destroy();
    await broker?.close();
    value.cleanup();
  }
});

test("aggregate partial-body reservations are bounded and released", async () => {
  const value = fixture();
  let held;
  let broker;
  let upstreamCalls = 0;
  const largeBody = JSON.stringify({
    model: TEST_MODEL,
    max_tokens: 8,
    stream: true,
    messages: [{ role: "user", content: "x".repeat(4_100_000) }],
  });
  try {
    broker = await startGate2702CredentialBrokerForTest({
      credentialPath: value.credentialPath,
      socketPath: value.socketPath,
      caCertPath: value.caCertPath,
      srtPackageRoot: SRT_PACKAGE_ROOT,
      requestPolicy: {
        allowedModels: [TEST_MODEL],
        wallTimeMs: 20_000,
        costCapUsd: 18,
      },
      async forwardUpstream() {
        upstreamCalls += 1;
        return {
          statusCode: 200,
          headers: { "content-type": "text/event-stream" },
          body: Readable.from(["event: message_stop\ndata: {}\n\n"]),
        };
      },
    });
    held = await openPartialMessagesRequest(value.socketPath, 8 * 1024 * 1024);
    assert.equal(
      await messagesHeadersOnlyRequest(value.socketPath, Buffer.byteLength(largeBody)),
      503,
    );
    assert.equal(upstreamCalls, 0);

    held.destroy();
    await once(held, "close");
    held = null;
    assert.equal(
      (await messagesRequestEventually(value.socketPath, largeBody, 200)).statusCode,
      200,
    );
    assert.equal((await messagesRequest(value.socketPath, largeBody)).statusCode, 200);
    assert.equal(upstreamCalls, 2);
  } finally {
    held?.destroy();
    await broker?.close();
    value.cleanup();
  }
});

test("a pre-aborted upstream signal is destroyed after listener registration", async () => {
  const originalRequest = https.request;
  const fakeUpstream = new EventEmitter();
  let destroyError;
  fakeUpstream.setTimeout = () => fakeUpstream;
  fakeUpstream.end = () => {};
  fakeUpstream.destroy = (error) => {
    destroyError = error;
    queueMicrotask(() => fakeUpstream.emit("error", error));
  };
  https.request = () => fakeUpstream;
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      within(
        forwardGate2702UpstreamForTest({
          method: "POST",
          path: "/v1/messages?beta=true",
          headers: { "content-length": "0" },
          body: Buffer.alloc(0),
          signal: controller.signal,
        }),
        250,
        "pre-aborted upstream request",
      ),
      /broker request aborted/,
    );
    assert.match(destroyError?.message ?? "", /broker request aborted/);
  } finally {
    https.request = originalRequest;
  }
});

test("downstream close and abort release broker backpressure waits", async () => {
  for (const event of ["close", "abort"]) {
    const response = new EventEmitter();
    response.destroyed = false;
    const controller = new AbortController();
    const waiting = waitForGate2702BrokerDrainForTest(
      response,
      controller.signal,
    );
    if (event === "close") {
      response.destroyed = true;
      response.emit("close");
    } else {
      controller.abort();
    }
    assert.equal(await waiting, false);
    assert.equal(response.listenerCount("drain"), 0);
    assert.equal(response.listenerCount("close"), 0);
    assert.equal(response.listenerCount("error"), 0);
  }
});

test("the parent removes broker artifacts after an unexpected child exit", async () => {
  const value = fixture();
  let broker;
  try {
    broker = await startGate2702CredentialBroker({
      credentialPath: value.credentialPath,
      socketPath: value.socketPath,
      caCertPath: value.caCertPath,
      srtPackageRoot: SRT_PACKAGE_ROOT,
      requestPolicy: TEST_REQUEST_POLICY,
    });
    assert.equal(existsSync(value.socketPath), true);
    assert.equal(existsSync(value.caCertPath), true);
    const exited = once(broker.process, "exit");
    broker.process.kill("SIGKILL");
    await exited;
    await broker.close();
    assert.equal(existsSync(value.socketPath), false);
    assert.equal(existsSync(value.caCertPath), false);
  } finally {
    await broker?.close();
    value.cleanup();
  }
});

test("broker startup refuses symlinked and expired credentials without residue", async () => {
  const value = fixture();
  try {
    const symlink = join(value.root, "credential-link.json");
    symlinkSync(value.credentialPath, symlink);
    await assert.rejects(
      startGate2702CredentialBrokerForTest({
        credentialPath: symlink,
        socketPath: value.socketPath,
        caCertPath: value.caCertPath,
        srtPackageRoot: SRT_PACKAGE_ROOT,
        requestPolicy: TEST_REQUEST_POLICY,
        async forwardUpstream() {
          throw new Error("unreachable");
        },
      }),
      /bounded regular file/i,
    );
    assert.equal(existsSync(value.socketPath), false);

    writeFileSync(
      value.credentialPath,
      `${JSON.stringify({
        claudeAiOauth: {
          accessToken: value.credentialCanary,
          expiresAt: Date.now() - 1,
        },
      })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      startGate2702CredentialBrokerForTest({
        credentialPath: value.credentialPath,
        socketPath: value.socketPath,
        caCertPath: value.caCertPath,
        srtPackageRoot: SRT_PACKAGE_ROOT,
        requestPolicy: TEST_REQUEST_POLICY,
        async forwardUpstream() {
          throw new Error("unreachable");
        },
      }),
      /expired.*refresh.*outside the jail/i,
    );
    assert.equal(existsSync(value.socketPath), false);
    assert.equal(existsSync(value.caCertPath), false);
  } finally {
    value.cleanup();
  }
});
