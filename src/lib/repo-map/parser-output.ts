import { types as nodeUtilTypes } from 'node:util';
import type { FileStructure, RepoSymbol, RepoSymbolKind } from './types';

// Capture the intrinsics used to inspect parser output. The boundary rejects
// proxies and accessors before executing their behavior; local references also
// prevent earlier global-method replacement from weakening that inspection.
// The parser implementation itself is trusted host code, not sandboxed code:
// this module constrains the value it returns, but cannot defend the whole
// process from a parser that directly mutates global prototypes. That requires
// worker/process isolation rather than return-value validation.
const arrayIsArray = Array.isArray;
const numberIsFinite = Number.isFinite;
const numberIsSafeInteger = Number.isSafeInteger;
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectIsExtensible = Object.isExtensible;
const objectDefineProperty = Object.defineProperty;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectKeys = Object.keys;
const nativePromiseConstructor = Promise;
const promiseThen = Promise.prototype.then;
const reflectApply = Reflect.apply;
const reflectDeleteProperty = Reflect.deleteProperty;
const reflectOwnKeys = Reflect.ownKeys;
const isProxy = nodeUtilTypes.isProxy;
const isPromise = nodeUtilTypes.isPromise;
const symbolSpecies = Symbol.species;
const nativePromiseSpeciesCarrier = objectCreate(null) as object;
objectDefineProperty(nativePromiseSpeciesCarrier, symbolSpecies, {
  value: nativePromiseConstructor,
});
objectFreeze(nativePromiseSpeciesCarrier);

type NormalizationResult<Value> =
  | { valid: true; value: Value }
  | { valid: false };

const INVALID_RESULT = { valid: false } as const;
const MAX_EXACT_ARRAY_ITEMS = 1_000_000;

function normalized<Value>(value: Value): NormalizationResult<Value> {
  return { valid: true, value };
}

function normalizeExactArray<Value>(
  value: unknown,
  normalizeItem: (item: unknown) => NormalizationResult<Value>
): NormalizationResult<Value[]> {
  if (!arrayIsArray(value) || isProxy(value)) return INVALID_RESULT;
  const lengthDescriptor = objectGetOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !objectHasOwn(lengthDescriptor, 'value')) {
    return INVALID_RESULT;
  }
  // Read the own data descriptor once. The ceiling is far above what can fit
  // in a bounded source file, but prevents an injected parser from turning
  // validation into an effectively unbounded sparse-array walk.
  const length = lengthDescriptor.value;
  if (
    !numberIsSafeInteger(length) ||
    length < 0 ||
    length > MAX_EXACT_ARRAY_ITEMS
  ) {
    return INVALID_RESULT;
  }
  const projected: Value[] = [];
  for (let index = 0; index < length; index += 1) {
    // Parser output is data, not executable behavior. Reject holes, inherited
    // indices, accessors, and proxies; read each own data descriptor once.
    const descriptor = objectGetOwnPropertyDescriptor(value, index);
    if (!descriptor || !objectHasOwn(descriptor, 'value')) return INVALID_RESULT;
    const result = normalizeItem(descriptor.value);
    if (!result.valid) return INVALID_RESULT;
    objectDefineProperty(projected, index, {
      configurable: true,
      enumerable: true,
      value: result.value,
      writable: true,
    });
  }
  return normalized(projected);
}

type ExactFieldRule<Shape extends object, Field extends keyof Shape> = {
  optional: Pick<Shape, Field> extends Required<Pick<Shape, Field>>
    ? false
    : true;
  normalize: (
    value: unknown
  ) => NormalizationResult<Exclude<Shape[Field], undefined>>;
};

type ExactFieldRules<Shape extends object> = {
  [Field in keyof Shape]-?: ExactFieldRule<Shape, Field>;
};

function normalizeExactObject<Shape extends object>(
  value: unknown,
  rules: ExactFieldRules<Shape>
): Shape | null {
  if (
    !value ||
    typeof value !== 'object' ||
    arrayIsArray(value) ||
    isProxy(value) ||
    isPromise(value)
  ) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};

  // Unknown data keys are projected away, but unknown accessors are executable
  // behavior (`then`, `toJSON`, and similar hooks). Reject them without reading
  // them so normalization itself and later serialization cannot trigger code.
  for (const key of reflectOwnKeys(candidate)) {
    const descriptor = objectGetOwnPropertyDescriptor(candidate, key);
    if (!descriptor || !objectHasOwn(descriptor, 'value')) return null;
  }

  const fields = objectKeys(rules) as Array<keyof Shape>;
  const fieldCount = fields.length;
  for (let index = 0; index < fieldCount; index += 1) {
    const field = fields[index];
    const rule = rules[field] as ExactFieldRule<Shape, keyof Shape>;
    const fieldName = field as string;
    const descriptor = objectGetOwnPropertyDescriptor(candidate, fieldName);
    if (!descriptor) {
      if (rule.optional) continue;
      return null;
    }
    // Never execute parser-supplied accessors. Besides being mode-dependent,
    // they could mutate shared intrinsics before downstream artifact handling.
    if (!objectHasOwn(descriptor, 'value')) return null;
    const fieldValue = descriptor.value;
    if (fieldValue === undefined && rule.optional) continue;
    const result = rule.normalize(fieldValue);
    if (!result.valid) return null;
    objectDefineProperty(projected, fieldName, {
      configurable: true,
      enumerable: true,
      value: result.value,
      writable: true,
    });
  }

  return projected as Shape;
}

export type ParserPromiseSettlement =
  | { fulfilled: true; value: unknown; then: undefined }
  | { fulfilled: false; cause: unknown; then: undefined };

export type ParserResultClassification =
  | { kind: 'value'; value: unknown }
  | { kind: 'promise'; promise: Promise<ParserPromiseSettlement> }
  | { kind: 'invalid-promise'; cause: unknown };

type PromisePropertyShadow = {
  target: object;
  key: PropertyKey;
  descriptor: PropertyDescriptor | undefined;
};

type PromiseBridgePlan =
  | { valid: true; shadow?: PromisePropertyShadow }
  | { valid: false; cause: TypeError };

const SAFE_PROMISE_BRIDGE = { valid: true } as const;

function fulfilledParserPromise(value: unknown): ParserPromiseSettlement {
  // The own inert `then` is load-bearing: Promise resolution probes a returned
  // object's `then`. Without this shield, a parser-supplied fulfilled value can
  // be assimilated a second time and execute an accessor before normalization.
  const settlement = objectCreate(null) as ParserPromiseSettlement;
  objectDefineProperty(settlement, 'fulfilled', { value: true });
  objectDefineProperty(settlement, 'value', { value });
  objectDefineProperty(settlement, 'then', { value: undefined });
  return settlement;
}

function rejectedParserPromise(cause: unknown): ParserPromiseSettlement {
  const settlement = objectCreate(null) as ParserPromiseSettlement;
  objectDefineProperty(settlement, 'fulfilled', { value: false });
  objectDefineProperty(settlement, 'cause', { value: cause });
  objectDefineProperty(settlement, 'then', { value: undefined });
  return settlement;
}

function unsafePromiseBridge(message: string): PromiseBridgePlan {
  return { valid: false, cause: new TypeError(message) };
}

function propertyShadow(
  target: object,
  key: PromisePropertyShadow['key'],
  descriptor: PropertyDescriptor | undefined
): PromiseBridgePlan {
  return { valid: true, shadow: { target, key, descriptor } };
}

/**
 * Plan a native `Symbol.species` result without invoking a parser-supplied
 * accessor or constructor. An extensible constructor can take an own shadow.
 * A fully frozen standard subclass instead inherits Promise's configurable
 * species accessor, so shadow that intrinsic synchronously for the bridge.
 */
function planNativePromiseSpecies(constructorValue: unknown): PromiseBridgePlan {
  if (
    (typeof constructorValue !== 'object' &&
      typeof constructorValue !== 'function') ||
    constructorValue === null ||
    isProxy(constructorValue)
  ) {
    return unsafePromiseBridge('parser Promise has an unsafe constructor value');
  }

  const constructor = constructorValue as object;
  const ownSpecies = objectGetOwnPropertyDescriptor(constructor, symbolSpecies);
  if (!ownSpecies && objectIsExtensible(constructor)) {
    return propertyShadow(constructor, symbolSpecies, undefined);
  }

  let holder: object | null = constructor;
  while (holder) {
    if (isProxy(holder)) {
      return unsafePromiseBridge('parser Promise has an unsafe species prototype');
    }
    const descriptor = objectGetOwnPropertyDescriptor(holder, symbolSpecies);
    if (descriptor) {
      if (
        objectHasOwn(descriptor, 'value') &&
        (descriptor.value == null ||
          descriptor.value === nativePromiseConstructor)
      ) {
        return SAFE_PROMISE_BRIDGE;
      }
      if (descriptor.configurable) {
        return propertyShadow(holder, symbolSpecies, descriptor);
      }
      return unsafePromiseBridge(
        'parser Promise cannot be bridged without executing a species hook'
      );
    }
    holder = objectGetPrototypeOf(holder) as object | null;
  }

  // An absent species resolves to the intrinsic default constructor.
  return SAFE_PROMISE_BRIDGE;
}

/** Resolve `promise.constructor` through descriptors only. */
function planNativePromiseConstructor(promise: Promise<unknown>): PromiseBridgePlan {
  const ownConstructor = objectGetOwnPropertyDescriptor(promise, 'constructor');
  if (!ownConstructor && objectIsExtensible(promise)) {
    return propertyShadow(promise, 'constructor', undefined);
  }

  let holder: object | null = promise;
  while (holder) {
    if (holder !== promise && isProxy(holder)) {
      return unsafePromiseBridge('parser Promise has an unsafe prototype');
    }
    const descriptor = objectGetOwnPropertyDescriptor(holder, 'constructor');
    if (descriptor) {
      if (descriptor.configurable) {
        return propertyShadow(holder, 'constructor', descriptor);
      }
      if (objectHasOwn(descriptor, 'value')) {
        if (descriptor.value === undefined) return SAFE_PROMISE_BRIDGE;
        return planNativePromiseSpecies(descriptor.value);
      }
      return unsafePromiseBridge('parser Promise has an unsafe constructor hook');
    }
    holder = objectGetPrototypeOf(holder) as object | null;
  }

  // An absent constructor also selects the intrinsic Promise constructor.
  return SAFE_PROMISE_BRIDGE;
}

/**
 * Classify parser results without reading an arbitrary `then` property.
 * Genuine Promise internal-slot values are bridged through the captured
 * intrinsic `Promise.prototype.then`. Temporarily shadowing `constructor` with
 * a frozen carrier whose species is the captured intrinsic Promise, or
 * shadowing `Symbol.species` itself, prevents subclass hooks from running and
 * makes the bridge a plain Promise that callers can safely await.
 * This also observes rejected decorated, non-extensible, and frozen standard
 * subclasses instead of leaving an unhandled rejection.
 *
 * Supported Promise values must expose an ordinary constructor/species chain
 * that can resolve to native Promise without executing a hook: a configurable
 * property, an extensible ordinary object, or the configurable native Promise
 * species accessor. A fully locked custom constructor/species hook is an
 * invalid async protocol; callers fail the producer before artifact creation.
 * If such an unsupported Promise is already rejected, pure JavaScript offers
 * no way to mark it handled without executing that locked hook; the host's
 * unhandled-rejection policy may therefore surface the original rejection too.
 * We deliberately prefer a fail-closed producer over executing output code.
 */
export function classifyParserResult(value: unknown): ParserResultClassification {
  if (
    typeof value !== 'object' ||
    value === null ||
    isProxy(value) ||
    !isPromise(value)
  ) {
    return { kind: 'value', value };
  }

  const promise = value as Promise<unknown>;
  let shadow: PromisePropertyShadow | undefined;
  try {
    const plan = planNativePromiseConstructor(promise);
    if (!plan.valid) {
      return { kind: 'invalid-promise', cause: plan.cause };
    }
    shadow = plan.shadow;

    if (shadow) {
      objectDefineProperty(shadow.target, shadow.key, {
        configurable: true,
        enumerable: false,
        value:
          shadow.key === 'constructor'
            ? nativePromiseSpeciesCarrier
            : nativePromiseConstructor,
        writable: true,
      });
    }

    const bridged = reflectApply(promiseThen, promise, [
      fulfilledParserPromise,
      rejectedParserPromise,
    ]) as Promise<ParserPromiseSettlement>;
    return { kind: 'promise', promise: bridged };
  } catch (cause) {
    return { kind: 'invalid-promise', cause };
  } finally {
    if (shadow) {
      if (shadow.descriptor) {
        objectDefineProperty(shadow.target, shadow.key, shadow.descriptor);
      } else {
        reflectDeleteProperty(shadow.target, shadow.key);
      }
    }
  }
}

const REPO_SYMBOL_FIELD_RULES: ExactFieldRules<RepoSymbol> = {
  name: {
    optional: false,
    normalize: (value) =>
      typeof value === 'string' ? normalized(value) : INVALID_RESULT,
  },
  kind: {
    optional: false,
    normalize: normalizeRepoSymbolKind,
  },
  exported: {
    optional: false,
    normalize: (value) =>
      typeof value === 'boolean' ? normalized(value) : INVALID_RESULT,
  },
  signature: {
    optional: false,
    normalize: (value) =>
      typeof value === 'string' ? normalized(value) : INVALID_RESULT,
  },
  line: {
    optional: false,
    normalize: (value) =>
      typeof value === 'number' && numberIsFinite(value)
        ? normalized(value)
        : INVALID_RESULT,
  },
};

function normalizeRepoSymbolKind(
  value: unknown
): NormalizationResult<RepoSymbolKind> {
  if (typeof value !== 'string') return INVALID_RESULT;
  switch (value) {
    case 'function':
      return normalized(value);
    case 'class':
      return normalized(value);
    case 'interface':
      return normalized(value);
    case 'type':
      return normalized(value);
    case 'enum':
      return normalized(value);
    case 'const':
      return normalized(value);
    case 'variable':
      return normalized(value);
    default:
      return INVALID_RESULT;
  }
}

function normalizeRepoSymbol(value: unknown): RepoSymbol | null {
  return normalizeExactObject(value, REPO_SYMBOL_FIELD_RULES);
}

const FILE_STRUCTURE_FIELD_RULES: ExactFieldRules<FileStructure> = {
  symbols: {
    optional: false,
    normalize: (value) =>
      normalizeExactArray(value, (candidate) => {
        const symbol = normalizeRepoSymbol(candidate);
        return symbol ? normalized(symbol) : INVALID_RESULT;
      }),
  },
  imports: {
    optional: false,
    normalize: (value) =>
      normalizeExactArray(value, (specifier) =>
        typeof specifier === 'string'
          ? normalized(specifier)
          : INVALID_RESULT
      ),
  },
};

/**
 * Validate an untrusted parser result and project it onto the exact
 * privacy-safe FileStructure shape. Unknown keys are discarded. A malformed
 * result returns null so generation can skip that file just as it skips a
 * parser throw. Only ordinary objects/arrays with own data properties are
 * accepted; accessors and proxies are malformed and never executed. One bad
 * file never weakens or sinks the rest of the Repo Map.
 */
export function normalizeFileStructure(value: unknown): FileStructure | null {
  try {
    return normalizeExactObject(value, FILE_STRUCTURE_FIELD_RULES);
  } catch {
    // Returned values are untrusted. A getter/proxy/iterator failure describes
    // malformed output, not parser construction, even if it throws the fatal
    // initialization error class. The generator therefore skips this file.
    return null;
  }
}
