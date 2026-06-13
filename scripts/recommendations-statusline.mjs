#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'http://127.0.0.1:5173';
const DEFAULT_MAX_CHARS = 220;
const DEFAULT_TIMEOUT_MS = 15000;

export function helpText(command = 'node scripts/recommendations-statusline.mjs') {
  return `Recommendations statusline

Usage:
  ${command} [--url http://127.0.0.1:5173] [--max-chars 220] [--timeout-ms 15000]
  ${command} --input recommendations.json [--json]
  ${command} --help

Options:
  --url         Local dashboard base URL or /api/recommendations.json URL.
                Defaults to CODING_AGENT_DASHBOARD_URL or ${DEFAULT_BASE_URL}.
  --input       Read recommendations from a JSON file instead of HTTP.
  --json        Emit a structured JSON summary instead of one statusline.
  --max-chars   Maximum statusline length. Defaults to ${DEFAULT_MAX_CHARS}.
  --timeout-ms  HTTP timeout for local dashboard reads. Defaults to ${DEFAULT_TIMEOUT_MS}.
  -h, --help    Show this help.
`;
}

function parseValue(args, index, flag) {
  const arg = args[index];
  const prefix = `${flag}=`;
  if (arg.startsWith(prefix)) {
    return { value: arg.slice(prefix.length), nextIndex: index + 1 };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return { value, nextIndex: index + 2 };
}

export function parseArgs(args, env = process.env) {
  const options = {
    url: env.CODING_AGENT_DASHBOARD_URL || DEFAULT_BASE_URL,
    input: null,
    json: false,
    maxChars: DEFAULT_MAX_CHARS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };

  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      index += 1;
      continue;
    }
    if (arg === '--url' || arg.startsWith('--url=')) {
      const parsed = parseValue(args, index, '--url');
      options.url = parsed.value.trim();
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--input' || arg.startsWith('--input=')) {
      const parsed = parseValue(args, index, '--input');
      options.input = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (arg === '--max-chars' || arg.startsWith('--max-chars=')) {
      const parsed = parseValue(args, index, '--max-chars');
      const maxChars = Number(parsed.value);
      if (!Number.isInteger(maxChars) || maxChars < 40 || maxChars > 1000) {
        throw new Error(`Invalid --max-chars value: ${parsed.value}`);
      }
      options.maxChars = maxChars;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--timeout-ms' || arg.startsWith('--timeout-ms=')) {
      const parsed = parseValue(args, index, '--timeout-ms');
      const timeoutMs = Number(parsed.value);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
        throw new Error(`Invalid --timeout-ms value: ${parsed.value}`);
      }
      options.timeoutMs = timeoutMs;
      index = parsed.nextIndex;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function localHostname(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

export function recommendationApiUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Recommendation statusline URL must be http or https.');
  }
  if (!localHostname(url.hostname)) {
    throw new Error('Recommendation statusline only reads a local dashboard URL.');
  }

  if (url.pathname === '/' || url.pathname === '') {
    url.pathname = '/api/recommendations.json';
  } else if (!url.pathname.endsWith('/api/recommendations.json')) {
    throw new Error('URL must be a dashboard base URL or /api/recommendations.json.');
  }
  url.hash = '';
  return url;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function buildStatusline(recommendations, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (!Array.isArray(recommendations)) {
    throw new Error('Recommendations payload must be an array.');
  }
  if (recommendations.length === 0) {
    const text = 'recs: no active recommendations';
    return {
      status: 'empty',
      count: 0,
      text,
    };
  }

  const top = recommendations[0] || {};
  const severity = normalizeText(top.severity || 'info');
  const category = normalizeText(top.category || 'general');
  const title = normalizeText(top.title || top.id || 'Untitled recommendation');
  const action = normalizeText(top.action);
  const view = normalizeText(top.view);
  const viewText = view ? ` (${view})` : '';
  const actionText = action ? ` -> ${action}` : '';
  const text = truncate(
    `recs ${severity} ${category}: ${title}${viewText}${actionText}`,
    maxChars
  );

  return {
    status: 'ok',
    count: recommendations.length,
    id: typeof top.id === 'string' ? top.id : null,
    severity,
    category,
    title,
    action: action || null,
    view: view || null,
    text,
  };
}

async function readRecommendations(options) {
  if (options.input) {
    const raw = await readFile(options.input, 'utf8');
    return JSON.parse(raw);
  }

  const url = recommendationApiUrl(options.url);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Local dashboard returned HTTP ${response.status}.`);
  }
  return response.json();
}

export async function main(args = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(args);
  if (options.help) {
    stdout.write(helpText(io.command).trimEnd() + '\n');
    return;
  }

  const recommendations = await readRecommendations(options);
  const summary = buildStatusline(recommendations, {
    maxChars: options.maxChars,
  });

  if (options.json) {
    stdout.write(JSON.stringify(summary) + '\n');
  } else {
    stdout.write(summary.text + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
