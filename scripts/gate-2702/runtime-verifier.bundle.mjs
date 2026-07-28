import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
var __toCommonJS = (mod) => __hasOwnProp.call(mod, "module.exports") ? mod["module.exports"] : __copyProps(__defProp({}, "__esModule", { value: true }), mod);
//#endregion
//#region \0gate-2702-runtime-register-noop
var _gate_2702_runtime_register_noop_exports = /* @__PURE__ */ __exportAll({});
var init__gate_2702_runtime_register_noop = __esmMin((() => {}));
//#endregion
//#region src/lib/experiment-runtime/contracts/v1/canonical.ts
function hasLoneSurrogate(value) {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 55296 && code <= 56319) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 56320 && next <= 57343)) return true;
			index++;
		} else if (code >= 56320 && code <= 57343) return true;
	}
	return false;
}
function childPath(path, key) {
	if (typeof key === "number") return `${path}[${key}]`;
	return `${path}.${key}`;
}
function cloneJson(value, path, ancestors) {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (hasLoneSurrogate(value)) throw new CanonicalizationError("json.lone-surrogate", path, "strings must contain valid Unicode scalar sequences");
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new CanonicalizationError("json.non-finite-number", path, "numbers must be finite");
		if (Object.is(value, -0)) throw new CanonicalizationError("json.negative-zero", path, "negative zero is not a canonical JSON number");
		if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new CanonicalizationError("json.unsafe-integer", path, "integer values must be exactly representable");
		return value;
	}
	if (typeof value !== "object") throw new CanonicalizationError("json.unsupported-value", path, `unsupported JSON value: ${typeof value}`);
	if (ancestors.has(value)) throw new CanonicalizationError("json.cycle", path, "cyclic values are not JSON");
	ancestors.add(value);
	try {
		if (Object.getOwnPropertySymbols(value).length > 0) throw new CanonicalizationError("json.symbol-key", path, "symbol-keyed properties are not JSON");
		if (Array.isArray(value)) {
			const extraKey = Object.keys(value).find((key) => !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length);
			if (extraKey !== void 0) throw new CanonicalizationError("json.array-property", childPath(path, extraKey), "arrays cannot carry named JSON properties");
			const result = [];
			for (let index = 0; index < value.length; index++) {
				if (!(index in value)) throw new CanonicalizationError("json.sparse-array", childPath(path, index), "sparse arrays are not canonical JSON");
				result.push(cloneJson(value[index], childPath(path, index), ancestors));
			}
			return result;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new CanonicalizationError("json.non-plain-object", path, "only plain JSON objects are supported");
		const result = Object.create(null);
		for (const key of Object.keys(value)) {
			if (hasLoneSurrogate(key)) throw new CanonicalizationError("json.lone-surrogate", childPath(path, key), "object keys must contain valid Unicode scalar sequences");
			result[key] = cloneJson(value[key], childPath(path, key), ancestors);
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}
/** Validate and clone an input into the strict JSON domain used by the wire contract. */
function toJsonValue(value) {
	return cloneJson(value, "$", /* @__PURE__ */ new Set());
}
function compareUtf16(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}
function serializeCanonical(value) {
	if (value === null || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "string" || typeof value === "number") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(",")}]`;
	return `{${Object.keys(value).sort(compareUtf16).map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key])}`).join(",")}}`;
}
/** RFC 8785/JCS serialization for values that pass the contract JSON preflight. */
function canonicalJson$5(value) {
	return serializeCanonical(toJsonValue(value));
}
function asRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function sortArray(parent, key, identity) {
	const value = parent?.[key];
	if (!Array.isArray(value)) return;
	value.sort((left, right) => compareUtf16(identity(left), identity(right)));
}
function stringAt(value, key) {
	const record = asRecord(value);
	return typeof record?.[key] === "string" ? record[key] : canonicalJson$5(value);
}
function semanticsIdentity(value) {
	const semantics = asRecord(asRecord(value)?.semanticsRef ?? value);
	if (!semantics) return canonicalJson$5(value);
	return `${String(semantics.id)}\u0000${String(semantics.version)}\u0000${String(semantics.contentDigest)}`;
}
function evidenceIdentity(value) {
	const record = asRecord(value);
	if (!record) return canonicalJson$5(value);
	if (record.kind === "session") {
		const session = asRecord(record.sessionRef);
		return `session\u0000${String(session?.harness)}\u0000${String(session?.sourceId)}\u0000${String(session?.sessionId)}\u0000${String(record.contentDigest)}`;
	}
	const artifact = asRecord(record.artifactRef);
	return `artifact\u0000${String(artifact?.harness)}\u0000${String(artifact?.sourceId)}\u0000${String(artifact?.artifactId)}\u0000${String(artifact?.contentDigest)}\u0000${String(artifact?.mediaType ?? "")}`;
}
function normalizeEvidenceArrays(values) {
	if (!Array.isArray(values)) return;
	for (const value of values) sortArray(asRecord(value), "evidenceRefs", evidenceIdentity);
}
function normalizeDefinition(root) {
	sortArray(asRecord(root.portability), "allowedHarnesses", (value) => String(value));
	sortArray(root, "requiredCapabilities", semanticsIdentity);
	sortArray(root, "treatments", (value) => stringAt(value, "id"));
	if (Array.isArray(root.treatments)) for (const treatment of root.treatments) sortArray(asRecord(treatment), "interventions", (value) => {
		const record = asRecord(value);
		return `${semanticsIdentity(record?.capability ?? value)}\u0000${String(record?.operation)}\u0000${canonicalJson$5(record?.value)}`;
	});
	sortArray(root, "metrics", (value) => stringAt(value, "id"));
	sortArray(root, "checks", (value) => stringAt(value, "id"));
	sortArray(asRecord(root.safeguards), "relaxationRequests", (value) => stringAt(value, "requestId"));
}
function normalizeFingerprint(fingerprint) {
	sortArray(fingerprint, "factors", (value) => stringAt(value, "id"));
}
function normalizeRun(root) {
	normalizeFingerprint(asRecord(root.behaviorFingerprint));
	sortArray(root, "capabilitySnapshot", semanticsIdentity);
	sortArray(root, "safeguardAuthorizations", (value) => stringAt(value, "requestId"));
	sortArray(root, "observations", (value) => stringAt(value, "metricId"));
	normalizeEvidenceArrays(root.observations);
	sortArray(root, "checkResults", (value) => stringAt(value, "checkId"));
	normalizeEvidenceArrays(root.checkResults);
	sortArray(asRecord(root.error), "evidenceRefs", evidenceIdentity);
}
function normalizeVerdict(root) {
	const evidence = asRecord(root.evidence);
	sortArray(evidence, "includedRuns", (value) => stringAt(value, "runId"));
	sortArray(evidence, "excludedRuns", (value) => {
		const entry = asRecord(value);
		const run = entry ? asRecord(entry.run) : null;
		return `${String(run?.runId)}\u0000${String(entry?.reason)}`;
	});
	sortArray(asRecord(root.evidenceBasis), "satisfiedCapabilitySemantics", semanticsIdentity);
	sortArray(asRecord(root.primaryEffect), "sampleCounts", (value) => stringAt(value, "treatmentId"));
}
/**
* Normalize only arrays whose order has no contract meaning. Assignment- and
* extension-owned arrays remain untouched.
*/
function normalizeDocument(document) {
	const root = asRecord(toJsonValue(document));
	if (!root) throw new CanonicalizationError("document.not-object", "$", "an experiment document must be a JSON object");
	if (root.kind === "ExperimentDefinition") normalizeDefinition(root);
	else if (root.kind === "ExperimentRun") normalizeRun(root);
	else if (root.kind === "ExperimentVerdict") normalizeVerdict(root);
	return root;
}
function canonicalDocumentJson(document) {
	return serializeCanonical(normalizeDocument(document));
}
function sha256$1(value) {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
/** Digest a complete authoritative document after omitting its own digest. */
function computeDocumentDigest(document) {
	const normalized = normalizeDocument(document);
	delete normalized.contentDigest;
	return sha256$1(serializeCanonical(normalized));
}
/** Return a normalized immutable-document candidate with its digest populated. */
function withDocumentDigest(document) {
	const normalized = normalizeDocument(document);
	normalized.contentDigest = computeDocumentDigest(normalized);
	return normalized;
}
/** Hash the complete behavior manifest, omitting only its self digest (#2609). */
function computeBehaviorFingerprintDigest(fingerprint) {
	const cloned = toJsonValue(fingerprint);
	delete cloned.digest;
	normalizeFingerprint(cloned);
	return sha256$1(serializeCanonical(cloned));
}
function withBehaviorFingerprintDigest(fingerprint) {
	const cloned = toJsonValue(fingerprint);
	cloned.digest = computeBehaviorFingerprintDigest(cloned);
	return cloned;
}
var CanonicalizationError;
var init_canonical = __esmMin((() => {
	CanonicalizationError = class extends Error {
		code;
		path;
		constructor(code, path, message) {
			super(message);
			this.name = "CanonicalizationError";
			this.code = code;
			this.path = path;
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/compile/codegen/code.js
var require_code$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.regexpCode = exports.getEsmExportName = exports.getProperty = exports.safeStringify = exports.stringify = exports.strConcat = exports.addCodeArg = exports.str = exports._ = exports.nil = exports._Code = exports.Name = exports.IDENTIFIER = exports._CodeOrName = void 0;
	var _CodeOrName = class {};
	exports._CodeOrName = _CodeOrName;
	exports.IDENTIFIER = /^[a-z$_][a-z$_0-9]*$/i;
	var Name = class extends _CodeOrName {
		constructor(s) {
			super();
			if (!exports.IDENTIFIER.test(s)) throw new Error("CodeGen: name must be a valid identifier");
			this.str = s;
		}
		toString() {
			return this.str;
		}
		emptyStr() {
			return false;
		}
		get names() {
			return { [this.str]: 1 };
		}
	};
	exports.Name = Name;
	var _Code = class extends _CodeOrName {
		constructor(code) {
			super();
			this._items = typeof code === "string" ? [code] : code;
		}
		toString() {
			return this.str;
		}
		emptyStr() {
			if (this._items.length > 1) return false;
			const item = this._items[0];
			return item === "" || item === "\"\"";
		}
		get str() {
			var _a;
			return (_a = this._str) !== null && _a !== void 0 ? _a : this._str = this._items.reduce((s, c) => `${s}${c}`, "");
		}
		get names() {
			var _a;
			return (_a = this._names) !== null && _a !== void 0 ? _a : this._names = this._items.reduce((names, c) => {
				if (c instanceof Name) names[c.str] = (names[c.str] || 0) + 1;
				return names;
			}, {});
		}
	};
	exports._Code = _Code;
	exports.nil = new _Code("");
	function _(strs, ...args) {
		const code = [strs[0]];
		let i = 0;
		while (i < args.length) {
			addCodeArg(code, args[i]);
			code.push(strs[++i]);
		}
		return new _Code(code);
	}
	exports._ = _;
	var plus = new _Code("+");
	function str(strs, ...args) {
		const expr = [safeStringify(strs[0])];
		let i = 0;
		while (i < args.length) {
			expr.push(plus);
			addCodeArg(expr, args[i]);
			expr.push(plus, safeStringify(strs[++i]));
		}
		optimize(expr);
		return new _Code(expr);
	}
	exports.str = str;
	function addCodeArg(code, arg) {
		if (arg instanceof _Code) code.push(...arg._items);
		else if (arg instanceof Name) code.push(arg);
		else code.push(interpolate(arg));
	}
	exports.addCodeArg = addCodeArg;
	function optimize(expr) {
		let i = 1;
		while (i < expr.length - 1) {
			if (expr[i] === plus) {
				const res = mergeExprItems(expr[i - 1], expr[i + 1]);
				if (res !== void 0) {
					expr.splice(i - 1, 3, res);
					continue;
				}
				expr[i++] = "+";
			}
			i++;
		}
	}
	function mergeExprItems(a, b) {
		if (b === "\"\"") return a;
		if (a === "\"\"") return b;
		if (typeof a == "string") {
			if (b instanceof Name || a[a.length - 1] !== "\"") return;
			if (typeof b != "string") return `${a.slice(0, -1)}${b}"`;
			if (b[0] === "\"") return a.slice(0, -1) + b.slice(1);
			return;
		}
		if (typeof b == "string" && b[0] === "\"" && !(a instanceof Name)) return `"${a}${b.slice(1)}`;
	}
	function strConcat(c1, c2) {
		return c2.emptyStr() ? c1 : c1.emptyStr() ? c2 : str`${c1}${c2}`;
	}
	exports.strConcat = strConcat;
	function interpolate(x) {
		return typeof x == "number" || typeof x == "boolean" || x === null ? x : safeStringify(Array.isArray(x) ? x.join(",") : x);
	}
	function stringify(x) {
		return new _Code(safeStringify(x));
	}
	exports.stringify = stringify;
	function safeStringify(x) {
		return JSON.stringify(x).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
	}
	exports.safeStringify = safeStringify;
	function getProperty(key) {
		return typeof key == "string" && exports.IDENTIFIER.test(key) ? new _Code(`.${key}`) : _`[${key}]`;
	}
	exports.getProperty = getProperty;
	function getEsmExportName(key) {
		if (typeof key == "string" && exports.IDENTIFIER.test(key)) return new _Code(`${key}`);
		throw new Error(`CodeGen: invalid export name: ${key}, use explicit $id name mapping`);
	}
	exports.getEsmExportName = getEsmExportName;
	function regexpCode(rx) {
		return new _Code(rx.toString());
	}
	exports.regexpCode = regexpCode;
}));
//#endregion
//#region node_modules/ajv/dist/compile/codegen/scope.js
var require_scope = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ValueScope = exports.ValueScopeName = exports.Scope = exports.varKinds = exports.UsedValueState = void 0;
	var code_1 = require_code$1();
	var ValueError = class extends Error {
		constructor(name) {
			super(`CodeGen: "code" for ${name} not defined`);
			this.value = name.value;
		}
	};
	var UsedValueState;
	(function(UsedValueState) {
		UsedValueState[UsedValueState["Started"] = 0] = "Started";
		UsedValueState[UsedValueState["Completed"] = 1] = "Completed";
	})(UsedValueState || (exports.UsedValueState = UsedValueState = {}));
	exports.varKinds = {
		const: new code_1.Name("const"),
		let: new code_1.Name("let"),
		var: new code_1.Name("var")
	};
	var Scope = class {
		constructor({ prefixes, parent } = {}) {
			this._names = {};
			this._prefixes = prefixes;
			this._parent = parent;
		}
		toName(nameOrPrefix) {
			return nameOrPrefix instanceof code_1.Name ? nameOrPrefix : this.name(nameOrPrefix);
		}
		name(prefix) {
			return new code_1.Name(this._newName(prefix));
		}
		_newName(prefix) {
			const ng = this._names[prefix] || this._nameGroup(prefix);
			return `${prefix}${ng.index++}`;
		}
		_nameGroup(prefix) {
			var _a, _b;
			if (((_b = (_a = this._parent) === null || _a === void 0 ? void 0 : _a._prefixes) === null || _b === void 0 ? void 0 : _b.has(prefix)) || this._prefixes && !this._prefixes.has(prefix)) throw new Error(`CodeGen: prefix "${prefix}" is not allowed in this scope`);
			return this._names[prefix] = {
				prefix,
				index: 0
			};
		}
	};
	exports.Scope = Scope;
	var ValueScopeName = class extends code_1.Name {
		constructor(prefix, nameStr) {
			super(nameStr);
			this.prefix = prefix;
		}
		setValue(value, { property, itemIndex }) {
			this.value = value;
			this.scopePath = (0, code_1._)`.${new code_1.Name(property)}[${itemIndex}]`;
		}
	};
	exports.ValueScopeName = ValueScopeName;
	var line = (0, code_1._)`\n`;
	var ValueScope = class extends Scope {
		constructor(opts) {
			super(opts);
			this._values = {};
			this._scope = opts.scope;
			this.opts = {
				...opts,
				_n: opts.lines ? line : code_1.nil
			};
		}
		get() {
			return this._scope;
		}
		name(prefix) {
			return new ValueScopeName(prefix, this._newName(prefix));
		}
		value(nameOrPrefix, value) {
			var _a;
			if (value.ref === void 0) throw new Error("CodeGen: ref must be passed in value");
			const name = this.toName(nameOrPrefix);
			const { prefix } = name;
			const valueKey = (_a = value.key) !== null && _a !== void 0 ? _a : value.ref;
			let vs = this._values[prefix];
			if (vs) {
				const _name = vs.get(valueKey);
				if (_name) return _name;
			} else vs = this._values[prefix] = /* @__PURE__ */ new Map();
			vs.set(valueKey, name);
			const s = this._scope[prefix] || (this._scope[prefix] = []);
			const itemIndex = s.length;
			s[itemIndex] = value.ref;
			name.setValue(value, {
				property: prefix,
				itemIndex
			});
			return name;
		}
		getValue(prefix, keyOrRef) {
			const vs = this._values[prefix];
			if (!vs) return;
			return vs.get(keyOrRef);
		}
		scopeRefs(scopeName, values = this._values) {
			return this._reduceValues(values, (name) => {
				if (name.scopePath === void 0) throw new Error(`CodeGen: name "${name}" has no value`);
				return (0, code_1._)`${scopeName}${name.scopePath}`;
			});
		}
		scopeCode(values = this._values, usedValues, getCode) {
			return this._reduceValues(values, (name) => {
				if (name.value === void 0) throw new Error(`CodeGen: name "${name}" has no value`);
				return name.value.code;
			}, usedValues, getCode);
		}
		_reduceValues(values, valueCode, usedValues = {}, getCode) {
			let code = code_1.nil;
			for (const prefix in values) {
				const vs = values[prefix];
				if (!vs) continue;
				const nameSet = usedValues[prefix] = usedValues[prefix] || /* @__PURE__ */ new Map();
				vs.forEach((name) => {
					if (nameSet.has(name)) return;
					nameSet.set(name, UsedValueState.Started);
					let c = valueCode(name);
					if (c) {
						const def = this.opts.es5 ? exports.varKinds.var : exports.varKinds.const;
						code = (0, code_1._)`${code}${def} ${name} = ${c};${this.opts._n}`;
					} else if (c = getCode === null || getCode === void 0 ? void 0 : getCode(name)) code = (0, code_1._)`${code}${c}${this.opts._n}`;
					else throw new ValueError(name);
					nameSet.set(name, UsedValueState.Completed);
				});
			}
			return code;
		}
	};
	exports.ValueScope = ValueScope;
}));
//#endregion
//#region node_modules/ajv/dist/compile/codegen/index.js
var require_codegen = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.or = exports.and = exports.not = exports.CodeGen = exports.operators = exports.varKinds = exports.ValueScopeName = exports.ValueScope = exports.Scope = exports.Name = exports.regexpCode = exports.stringify = exports.getProperty = exports.nil = exports.strConcat = exports.str = exports._ = void 0;
	var code_1 = require_code$1();
	var scope_1 = require_scope();
	var code_2 = require_code$1();
	Object.defineProperty(exports, "_", {
		enumerable: true,
		get: function() {
			return code_2._;
		}
	});
	Object.defineProperty(exports, "str", {
		enumerable: true,
		get: function() {
			return code_2.str;
		}
	});
	Object.defineProperty(exports, "strConcat", {
		enumerable: true,
		get: function() {
			return code_2.strConcat;
		}
	});
	Object.defineProperty(exports, "nil", {
		enumerable: true,
		get: function() {
			return code_2.nil;
		}
	});
	Object.defineProperty(exports, "getProperty", {
		enumerable: true,
		get: function() {
			return code_2.getProperty;
		}
	});
	Object.defineProperty(exports, "stringify", {
		enumerable: true,
		get: function() {
			return code_2.stringify;
		}
	});
	Object.defineProperty(exports, "regexpCode", {
		enumerable: true,
		get: function() {
			return code_2.regexpCode;
		}
	});
	Object.defineProperty(exports, "Name", {
		enumerable: true,
		get: function() {
			return code_2.Name;
		}
	});
	var scope_2 = require_scope();
	Object.defineProperty(exports, "Scope", {
		enumerable: true,
		get: function() {
			return scope_2.Scope;
		}
	});
	Object.defineProperty(exports, "ValueScope", {
		enumerable: true,
		get: function() {
			return scope_2.ValueScope;
		}
	});
	Object.defineProperty(exports, "ValueScopeName", {
		enumerable: true,
		get: function() {
			return scope_2.ValueScopeName;
		}
	});
	Object.defineProperty(exports, "varKinds", {
		enumerable: true,
		get: function() {
			return scope_2.varKinds;
		}
	});
	exports.operators = {
		GT: new code_1._Code(">"),
		GTE: new code_1._Code(">="),
		LT: new code_1._Code("<"),
		LTE: new code_1._Code("<="),
		EQ: new code_1._Code("==="),
		NEQ: new code_1._Code("!=="),
		NOT: new code_1._Code("!"),
		OR: new code_1._Code("||"),
		AND: new code_1._Code("&&"),
		ADD: new code_1._Code("+")
	};
	var Node = class {
		optimizeNodes() {
			return this;
		}
		optimizeNames(_names, _constants) {
			return this;
		}
	};
	var Def = class extends Node {
		constructor(varKind, name, rhs) {
			super();
			this.varKind = varKind;
			this.name = name;
			this.rhs = rhs;
		}
		render({ es5, _n }) {
			const varKind = es5 ? scope_1.varKinds.var : this.varKind;
			const rhs = this.rhs === void 0 ? "" : ` = ${this.rhs}`;
			return `${varKind} ${this.name}${rhs};` + _n;
		}
		optimizeNames(names, constants) {
			if (!names[this.name.str]) return;
			if (this.rhs) this.rhs = optimizeExpr(this.rhs, names, constants);
			return this;
		}
		get names() {
			return this.rhs instanceof code_1._CodeOrName ? this.rhs.names : {};
		}
	};
	var Assign = class extends Node {
		constructor(lhs, rhs, sideEffects) {
			super();
			this.lhs = lhs;
			this.rhs = rhs;
			this.sideEffects = sideEffects;
		}
		render({ _n }) {
			return `${this.lhs} = ${this.rhs};` + _n;
		}
		optimizeNames(names, constants) {
			if (this.lhs instanceof code_1.Name && !names[this.lhs.str] && !this.sideEffects) return;
			this.rhs = optimizeExpr(this.rhs, names, constants);
			return this;
		}
		get names() {
			return addExprNames(this.lhs instanceof code_1.Name ? {} : { ...this.lhs.names }, this.rhs);
		}
	};
	var AssignOp = class extends Assign {
		constructor(lhs, op, rhs, sideEffects) {
			super(lhs, rhs, sideEffects);
			this.op = op;
		}
		render({ _n }) {
			return `${this.lhs} ${this.op}= ${this.rhs};` + _n;
		}
	};
	var Label = class extends Node {
		constructor(label) {
			super();
			this.label = label;
			this.names = {};
		}
		render({ _n }) {
			return `${this.label}:` + _n;
		}
	};
	var Break = class extends Node {
		constructor(label) {
			super();
			this.label = label;
			this.names = {};
		}
		render({ _n }) {
			return `break${this.label ? ` ${this.label}` : ""};` + _n;
		}
	};
	var Throw = class extends Node {
		constructor(error) {
			super();
			this.error = error;
		}
		render({ _n }) {
			return `throw ${this.error};` + _n;
		}
		get names() {
			return this.error.names;
		}
	};
	var AnyCode = class extends Node {
		constructor(code) {
			super();
			this.code = code;
		}
		render({ _n }) {
			return `${this.code};` + _n;
		}
		optimizeNodes() {
			return `${this.code}` ? this : void 0;
		}
		optimizeNames(names, constants) {
			this.code = optimizeExpr(this.code, names, constants);
			return this;
		}
		get names() {
			return this.code instanceof code_1._CodeOrName ? this.code.names : {};
		}
	};
	var ParentNode = class extends Node {
		constructor(nodes = []) {
			super();
			this.nodes = nodes;
		}
		render(opts) {
			return this.nodes.reduce((code, n) => code + n.render(opts), "");
		}
		optimizeNodes() {
			const { nodes } = this;
			let i = nodes.length;
			while (i--) {
				const n = nodes[i].optimizeNodes();
				if (Array.isArray(n)) nodes.splice(i, 1, ...n);
				else if (n) nodes[i] = n;
				else nodes.splice(i, 1);
			}
			return nodes.length > 0 ? this : void 0;
		}
		optimizeNames(names, constants) {
			const { nodes } = this;
			let i = nodes.length;
			while (i--) {
				const n = nodes[i];
				if (n.optimizeNames(names, constants)) continue;
				subtractNames(names, n.names);
				nodes.splice(i, 1);
			}
			return nodes.length > 0 ? this : void 0;
		}
		get names() {
			return this.nodes.reduce((names, n) => addNames(names, n.names), {});
		}
	};
	var BlockNode = class extends ParentNode {
		render(opts) {
			return "{" + opts._n + super.render(opts) + "}" + opts._n;
		}
	};
	var Root = class extends ParentNode {};
	var Else = class extends BlockNode {};
	Else.kind = "else";
	var If = class If extends BlockNode {
		constructor(condition, nodes) {
			super(nodes);
			this.condition = condition;
		}
		render(opts) {
			let code = `if(${this.condition})` + super.render(opts);
			if (this.else) code += "else " + this.else.render(opts);
			return code;
		}
		optimizeNodes() {
			super.optimizeNodes();
			const cond = this.condition;
			if (cond === true) return this.nodes;
			let e = this.else;
			if (e) {
				const ns = e.optimizeNodes();
				e = this.else = Array.isArray(ns) ? new Else(ns) : ns;
			}
			if (e) {
				if (cond === false) return e instanceof If ? e : e.nodes;
				if (this.nodes.length) return this;
				return new If(not(cond), e instanceof If ? [e] : e.nodes);
			}
			if (cond === false || !this.nodes.length) return void 0;
			return this;
		}
		optimizeNames(names, constants) {
			var _a;
			this.else = (_a = this.else) === null || _a === void 0 ? void 0 : _a.optimizeNames(names, constants);
			if (!(super.optimizeNames(names, constants) || this.else)) return;
			this.condition = optimizeExpr(this.condition, names, constants);
			return this;
		}
		get names() {
			const names = super.names;
			addExprNames(names, this.condition);
			if (this.else) addNames(names, this.else.names);
			return names;
		}
	};
	If.kind = "if";
	var For = class extends BlockNode {};
	For.kind = "for";
	var ForLoop = class extends For {
		constructor(iteration) {
			super();
			this.iteration = iteration;
		}
		render(opts) {
			return `for(${this.iteration})` + super.render(opts);
		}
		optimizeNames(names, constants) {
			if (!super.optimizeNames(names, constants)) return;
			this.iteration = optimizeExpr(this.iteration, names, constants);
			return this;
		}
		get names() {
			return addNames(super.names, this.iteration.names);
		}
	};
	var ForRange = class extends For {
		constructor(varKind, name, from, to) {
			super();
			this.varKind = varKind;
			this.name = name;
			this.from = from;
			this.to = to;
		}
		render(opts) {
			const varKind = opts.es5 ? scope_1.varKinds.var : this.varKind;
			const { name, from, to } = this;
			return `for(${varKind} ${name}=${from}; ${name}<${to}; ${name}++)` + super.render(opts);
		}
		get names() {
			return addExprNames(addExprNames(super.names, this.from), this.to);
		}
	};
	var ForIter = class extends For {
		constructor(loop, varKind, name, iterable) {
			super();
			this.loop = loop;
			this.varKind = varKind;
			this.name = name;
			this.iterable = iterable;
		}
		render(opts) {
			return `for(${this.varKind} ${this.name} ${this.loop} ${this.iterable})` + super.render(opts);
		}
		optimizeNames(names, constants) {
			if (!super.optimizeNames(names, constants)) return;
			this.iterable = optimizeExpr(this.iterable, names, constants);
			return this;
		}
		get names() {
			return addNames(super.names, this.iterable.names);
		}
	};
	var Func = class extends BlockNode {
		constructor(name, args, async) {
			super();
			this.name = name;
			this.args = args;
			this.async = async;
		}
		render(opts) {
			return `${this.async ? "async " : ""}function ${this.name}(${this.args})` + super.render(opts);
		}
	};
	Func.kind = "func";
	var Return = class extends ParentNode {
		render(opts) {
			return "return " + super.render(opts);
		}
	};
	Return.kind = "return";
	var Try = class extends BlockNode {
		render(opts) {
			let code = "try" + super.render(opts);
			if (this.catch) code += this.catch.render(opts);
			if (this.finally) code += this.finally.render(opts);
			return code;
		}
		optimizeNodes() {
			var _a, _b;
			super.optimizeNodes();
			(_a = this.catch) === null || _a === void 0 || _a.optimizeNodes();
			(_b = this.finally) === null || _b === void 0 || _b.optimizeNodes();
			return this;
		}
		optimizeNames(names, constants) {
			var _a, _b;
			super.optimizeNames(names, constants);
			(_a = this.catch) === null || _a === void 0 || _a.optimizeNames(names, constants);
			(_b = this.finally) === null || _b === void 0 || _b.optimizeNames(names, constants);
			return this;
		}
		get names() {
			const names = super.names;
			if (this.catch) addNames(names, this.catch.names);
			if (this.finally) addNames(names, this.finally.names);
			return names;
		}
	};
	var Catch = class extends BlockNode {
		constructor(error) {
			super();
			this.error = error;
		}
		render(opts) {
			return `catch(${this.error})` + super.render(opts);
		}
	};
	Catch.kind = "catch";
	var Finally = class extends BlockNode {
		render(opts) {
			return "finally" + super.render(opts);
		}
	};
	Finally.kind = "finally";
	var CodeGen = class {
		constructor(extScope, opts = {}) {
			this._values = {};
			this._blockStarts = [];
			this._constants = {};
			this.opts = {
				...opts,
				_n: opts.lines ? "\n" : ""
			};
			this._extScope = extScope;
			this._scope = new scope_1.Scope({ parent: extScope });
			this._nodes = [new Root()];
		}
		toString() {
			return this._root.render(this.opts);
		}
		name(prefix) {
			return this._scope.name(prefix);
		}
		scopeName(prefix) {
			return this._extScope.name(prefix);
		}
		scopeValue(prefixOrName, value) {
			const name = this._extScope.value(prefixOrName, value);
			(this._values[name.prefix] || (this._values[name.prefix] = /* @__PURE__ */ new Set())).add(name);
			return name;
		}
		getScopeValue(prefix, keyOrRef) {
			return this._extScope.getValue(prefix, keyOrRef);
		}
		scopeRefs(scopeName) {
			return this._extScope.scopeRefs(scopeName, this._values);
		}
		scopeCode() {
			return this._extScope.scopeCode(this._values);
		}
		_def(varKind, nameOrPrefix, rhs, constant) {
			const name = this._scope.toName(nameOrPrefix);
			if (rhs !== void 0 && constant) this._constants[name.str] = rhs;
			this._leafNode(new Def(varKind, name, rhs));
			return name;
		}
		const(nameOrPrefix, rhs, _constant) {
			return this._def(scope_1.varKinds.const, nameOrPrefix, rhs, _constant);
		}
		let(nameOrPrefix, rhs, _constant) {
			return this._def(scope_1.varKinds.let, nameOrPrefix, rhs, _constant);
		}
		var(nameOrPrefix, rhs, _constant) {
			return this._def(scope_1.varKinds.var, nameOrPrefix, rhs, _constant);
		}
		assign(lhs, rhs, sideEffects) {
			return this._leafNode(new Assign(lhs, rhs, sideEffects));
		}
		add(lhs, rhs) {
			return this._leafNode(new AssignOp(lhs, exports.operators.ADD, rhs));
		}
		code(c) {
			if (typeof c == "function") c();
			else if (c !== code_1.nil) this._leafNode(new AnyCode(c));
			return this;
		}
		object(...keyValues) {
			const code = ["{"];
			for (const [key, value] of keyValues) {
				if (code.length > 1) code.push(",");
				code.push(key);
				if (key !== value || this.opts.es5) {
					code.push(":");
					(0, code_1.addCodeArg)(code, value);
				}
			}
			code.push("}");
			return new code_1._Code(code);
		}
		if(condition, thenBody, elseBody) {
			this._blockNode(new If(condition));
			if (thenBody && elseBody) this.code(thenBody).else().code(elseBody).endIf();
			else if (thenBody) this.code(thenBody).endIf();
			else if (elseBody) throw new Error("CodeGen: \"else\" body without \"then\" body");
			return this;
		}
		elseIf(condition) {
			return this._elseNode(new If(condition));
		}
		else() {
			return this._elseNode(new Else());
		}
		endIf() {
			return this._endBlockNode(If, Else);
		}
		_for(node, forBody) {
			this._blockNode(node);
			if (forBody) this.code(forBody).endFor();
			return this;
		}
		for(iteration, forBody) {
			return this._for(new ForLoop(iteration), forBody);
		}
		forRange(nameOrPrefix, from, to, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.let) {
			const name = this._scope.toName(nameOrPrefix);
			return this._for(new ForRange(varKind, name, from, to), () => forBody(name));
		}
		forOf(nameOrPrefix, iterable, forBody, varKind = scope_1.varKinds.const) {
			const name = this._scope.toName(nameOrPrefix);
			if (this.opts.es5) {
				const arr = iterable instanceof code_1.Name ? iterable : this.var("_arr", iterable);
				return this.forRange("_i", 0, (0, code_1._)`${arr}.length`, (i) => {
					this.var(name, (0, code_1._)`${arr}[${i}]`);
					forBody(name);
				});
			}
			return this._for(new ForIter("of", varKind, name, iterable), () => forBody(name));
		}
		forIn(nameOrPrefix, obj, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.const) {
			if (this.opts.ownProperties) return this.forOf(nameOrPrefix, (0, code_1._)`Object.keys(${obj})`, forBody);
			const name = this._scope.toName(nameOrPrefix);
			return this._for(new ForIter("in", varKind, name, obj), () => forBody(name));
		}
		endFor() {
			return this._endBlockNode(For);
		}
		label(label) {
			return this._leafNode(new Label(label));
		}
		break(label) {
			return this._leafNode(new Break(label));
		}
		return(value) {
			const node = new Return();
			this._blockNode(node);
			this.code(value);
			if (node.nodes.length !== 1) throw new Error("CodeGen: \"return\" should have one node");
			return this._endBlockNode(Return);
		}
		try(tryBody, catchCode, finallyCode) {
			if (!catchCode && !finallyCode) throw new Error("CodeGen: \"try\" without \"catch\" and \"finally\"");
			const node = new Try();
			this._blockNode(node);
			this.code(tryBody);
			if (catchCode) {
				const error = this.name("e");
				this._currNode = node.catch = new Catch(error);
				catchCode(error);
			}
			if (finallyCode) {
				this._currNode = node.finally = new Finally();
				this.code(finallyCode);
			}
			return this._endBlockNode(Catch, Finally);
		}
		throw(error) {
			return this._leafNode(new Throw(error));
		}
		block(body, nodeCount) {
			this._blockStarts.push(this._nodes.length);
			if (body) this.code(body).endBlock(nodeCount);
			return this;
		}
		endBlock(nodeCount) {
			const len = this._blockStarts.pop();
			if (len === void 0) throw new Error("CodeGen: not in self-balancing block");
			const toClose = this._nodes.length - len;
			if (toClose < 0 || nodeCount !== void 0 && toClose !== nodeCount) throw new Error(`CodeGen: wrong number of nodes: ${toClose} vs ${nodeCount} expected`);
			this._nodes.length = len;
			return this;
		}
		func(name, args = code_1.nil, async, funcBody) {
			this._blockNode(new Func(name, args, async));
			if (funcBody) this.code(funcBody).endFunc();
			return this;
		}
		endFunc() {
			return this._endBlockNode(Func);
		}
		optimize(n = 1) {
			while (n-- > 0) {
				this._root.optimizeNodes();
				this._root.optimizeNames(this._root.names, this._constants);
			}
		}
		_leafNode(node) {
			this._currNode.nodes.push(node);
			return this;
		}
		_blockNode(node) {
			this._currNode.nodes.push(node);
			this._nodes.push(node);
		}
		_endBlockNode(N1, N2) {
			const n = this._currNode;
			if (n instanceof N1 || N2 && n instanceof N2) {
				this._nodes.pop();
				return this;
			}
			throw new Error(`CodeGen: not in block "${N2 ? `${N1.kind}/${N2.kind}` : N1.kind}"`);
		}
		_elseNode(node) {
			const n = this._currNode;
			if (!(n instanceof If)) throw new Error("CodeGen: \"else\" without \"if\"");
			this._currNode = n.else = node;
			return this;
		}
		get _root() {
			return this._nodes[0];
		}
		get _currNode() {
			const ns = this._nodes;
			return ns[ns.length - 1];
		}
		set _currNode(node) {
			const ns = this._nodes;
			ns[ns.length - 1] = node;
		}
	};
	exports.CodeGen = CodeGen;
	function addNames(names, from) {
		for (const n in from) names[n] = (names[n] || 0) + (from[n] || 0);
		return names;
	}
	function addExprNames(names, from) {
		return from instanceof code_1._CodeOrName ? addNames(names, from.names) : names;
	}
	function optimizeExpr(expr, names, constants) {
		if (expr instanceof code_1.Name) return replaceName(expr);
		if (!canOptimize(expr)) return expr;
		return new code_1._Code(expr._items.reduce((items, c) => {
			if (c instanceof code_1.Name) c = replaceName(c);
			if (c instanceof code_1._Code) items.push(...c._items);
			else items.push(c);
			return items;
		}, []));
		function replaceName(n) {
			const c = constants[n.str];
			if (c === void 0 || names[n.str] !== 1) return n;
			delete names[n.str];
			return c;
		}
		function canOptimize(e) {
			return e instanceof code_1._Code && e._items.some((c) => c instanceof code_1.Name && names[c.str] === 1 && constants[c.str] !== void 0);
		}
	}
	function subtractNames(names, from) {
		for (const n in from) names[n] = (names[n] || 0) - (from[n] || 0);
	}
	function not(x) {
		return typeof x == "boolean" || typeof x == "number" || x === null ? !x : (0, code_1._)`!${par(x)}`;
	}
	exports.not = not;
	var andCode = mappend(exports.operators.AND);
	function and(...args) {
		return args.reduce(andCode);
	}
	exports.and = and;
	var orCode = mappend(exports.operators.OR);
	function or(...args) {
		return args.reduce(orCode);
	}
	exports.or = or;
	function mappend(op) {
		return (x, y) => x === code_1.nil ? y : y === code_1.nil ? x : (0, code_1._)`${par(x)} ${op} ${par(y)}`;
	}
	function par(x) {
		return x instanceof code_1.Name ? x : (0, code_1._)`(${x})`;
	}
}));
//#endregion
//#region node_modules/ajv/dist/compile/util.js
var require_util = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.checkStrictMode = exports.getErrorPath = exports.Type = exports.useFunc = exports.setEvaluated = exports.evaluatedPropsToName = exports.mergeEvaluated = exports.eachItem = exports.unescapeJsonPointer = exports.escapeJsonPointer = exports.escapeFragment = exports.unescapeFragment = exports.schemaRefOrVal = exports.schemaHasRulesButRef = exports.schemaHasRules = exports.checkUnknownRules = exports.alwaysValidSchema = exports.toHash = void 0;
	var codegen_1 = require_codegen();
	var code_1 = require_code$1();
	function toHash(arr) {
		const hash = {};
		for (const item of arr) hash[item] = true;
		return hash;
	}
	exports.toHash = toHash;
	function alwaysValidSchema(it, schema) {
		if (typeof schema == "boolean") return schema;
		if (Object.keys(schema).length === 0) return true;
		checkUnknownRules(it, schema);
		return !schemaHasRules(schema, it.self.RULES.all);
	}
	exports.alwaysValidSchema = alwaysValidSchema;
	function checkUnknownRules(it, schema = it.schema) {
		const { opts, self } = it;
		if (!opts.strictSchema) return;
		if (typeof schema === "boolean") return;
		const rules = self.RULES.keywords;
		for (const key in schema) if (!rules[key]) checkStrictMode(it, `unknown keyword: "${key}"`);
	}
	exports.checkUnknownRules = checkUnknownRules;
	function schemaHasRules(schema, rules) {
		if (typeof schema == "boolean") return !schema;
		for (const key in schema) if (rules[key]) return true;
		return false;
	}
	exports.schemaHasRules = schemaHasRules;
	function schemaHasRulesButRef(schema, RULES) {
		if (typeof schema == "boolean") return !schema;
		for (const key in schema) if (key !== "$ref" && RULES.all[key]) return true;
		return false;
	}
	exports.schemaHasRulesButRef = schemaHasRulesButRef;
	function schemaRefOrVal({ topSchemaRef, schemaPath }, schema, keyword, $data) {
		if (!$data) {
			if (typeof schema == "number" || typeof schema == "boolean") return schema;
			if (typeof schema == "string") return (0, codegen_1._)`${schema}`;
		}
		return (0, codegen_1._)`${topSchemaRef}${schemaPath}${(0, codegen_1.getProperty)(keyword)}`;
	}
	exports.schemaRefOrVal = schemaRefOrVal;
	function unescapeFragment(str) {
		return unescapeJsonPointer(decodeURIComponent(str));
	}
	exports.unescapeFragment = unescapeFragment;
	function escapeFragment(str) {
		return encodeURIComponent(escapeJsonPointer(str));
	}
	exports.escapeFragment = escapeFragment;
	function escapeJsonPointer(str) {
		if (typeof str == "number") return `${str}`;
		return str.replace(/~/g, "~0").replace(/\//g, "~1");
	}
	exports.escapeJsonPointer = escapeJsonPointer;
	function unescapeJsonPointer(str) {
		return str.replace(/~1/g, "/").replace(/~0/g, "~");
	}
	exports.unescapeJsonPointer = unescapeJsonPointer;
	function eachItem(xs, f) {
		if (Array.isArray(xs)) for (const x of xs) f(x);
		else f(xs);
	}
	exports.eachItem = eachItem;
	function makeMergeEvaluated({ mergeNames, mergeToName, mergeValues, resultToName }) {
		return (gen, from, to, toName) => {
			const res = to === void 0 ? from : to instanceof codegen_1.Name ? (from instanceof codegen_1.Name ? mergeNames(gen, from, to) : mergeToName(gen, from, to), to) : from instanceof codegen_1.Name ? (mergeToName(gen, to, from), from) : mergeValues(from, to);
			return toName === codegen_1.Name && !(res instanceof codegen_1.Name) ? resultToName(gen, res) : res;
		};
	}
	exports.mergeEvaluated = {
		props: makeMergeEvaluated({
			mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => {
				gen.if((0, codegen_1._)`${from} === true`, () => gen.assign(to, true), () => gen.assign(to, (0, codegen_1._)`${to} || {}`).code((0, codegen_1._)`Object.assign(${to}, ${from})`));
			}),
			mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => {
				if (from === true) gen.assign(to, true);
				else {
					gen.assign(to, (0, codegen_1._)`${to} || {}`);
					setEvaluated(gen, to, from);
				}
			}),
			mergeValues: (from, to) => from === true ? true : {
				...from,
				...to
			},
			resultToName: evaluatedPropsToName
		}),
		items: makeMergeEvaluated({
			mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => gen.assign(to, (0, codegen_1._)`${from} === true ? true : ${to} > ${from} ? ${to} : ${from}`)),
			mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => gen.assign(to, from === true ? true : (0, codegen_1._)`${to} > ${from} ? ${to} : ${from}`)),
			mergeValues: (from, to) => from === true ? true : Math.max(from, to),
			resultToName: (gen, items) => gen.var("items", items)
		})
	};
	function evaluatedPropsToName(gen, ps) {
		if (ps === true) return gen.var("props", true);
		const props = gen.var("props", (0, codegen_1._)`{}`);
		if (ps !== void 0) setEvaluated(gen, props, ps);
		return props;
	}
	exports.evaluatedPropsToName = evaluatedPropsToName;
	function setEvaluated(gen, props, ps) {
		Object.keys(ps).forEach((p) => gen.assign((0, codegen_1._)`${props}${(0, codegen_1.getProperty)(p)}`, true));
	}
	exports.setEvaluated = setEvaluated;
	var snippets = {};
	function useFunc(gen, f) {
		return gen.scopeValue("func", {
			ref: f,
			code: snippets[f.code] || (snippets[f.code] = new code_1._Code(f.code))
		});
	}
	exports.useFunc = useFunc;
	var Type;
	(function(Type) {
		Type[Type["Num"] = 0] = "Num";
		Type[Type["Str"] = 1] = "Str";
	})(Type || (exports.Type = Type = {}));
	function getErrorPath(dataProp, dataPropType, jsPropertySyntax) {
		if (dataProp instanceof codegen_1.Name) {
			const isNumber = dataPropType === Type.Num;
			return jsPropertySyntax ? isNumber ? (0, codegen_1._)`"[" + ${dataProp} + "]"` : (0, codegen_1._)`"['" + ${dataProp} + "']"` : isNumber ? (0, codegen_1._)`"/" + ${dataProp}` : (0, codegen_1._)`"/" + ${dataProp}.replace(/~/g, "~0").replace(/\\//g, "~1")`;
		}
		return jsPropertySyntax ? (0, codegen_1.getProperty)(dataProp).toString() : "/" + escapeJsonPointer(dataProp);
	}
	exports.getErrorPath = getErrorPath;
	function checkStrictMode(it, msg, mode = it.opts.strictSchema) {
		if (!mode) return;
		msg = `strict mode: ${msg}`;
		if (mode === true) throw new Error(msg);
		it.self.logger.warn(msg);
	}
	exports.checkStrictMode = checkStrictMode;
}));
//#endregion
//#region node_modules/ajv/dist/compile/names.js
var require_names = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	exports.default = {
		data: new codegen_1.Name("data"),
		valCxt: new codegen_1.Name("valCxt"),
		instancePath: new codegen_1.Name("instancePath"),
		parentData: new codegen_1.Name("parentData"),
		parentDataProperty: new codegen_1.Name("parentDataProperty"),
		rootData: new codegen_1.Name("rootData"),
		dynamicAnchors: new codegen_1.Name("dynamicAnchors"),
		vErrors: new codegen_1.Name("vErrors"),
		errors: new codegen_1.Name("errors"),
		this: new codegen_1.Name("this"),
		self: new codegen_1.Name("self"),
		scope: new codegen_1.Name("scope"),
		json: new codegen_1.Name("json"),
		jsonPos: new codegen_1.Name("jsonPos"),
		jsonLen: new codegen_1.Name("jsonLen"),
		jsonPart: new codegen_1.Name("jsonPart")
	};
}));
//#endregion
//#region node_modules/ajv/dist/compile/errors.js
var require_errors = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.extendErrors = exports.resetErrorsCount = exports.reportExtraError = exports.reportError = exports.keyword$DataError = exports.keywordError = void 0;
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	var names_1 = require_names();
	exports.keywordError = { message: ({ keyword }) => (0, codegen_1.str)`must pass "${keyword}" keyword validation` };
	exports.keyword$DataError = { message: ({ keyword, schemaType }) => schemaType ? (0, codegen_1.str)`"${keyword}" keyword must be ${schemaType} ($data)` : (0, codegen_1.str)`"${keyword}" keyword is invalid ($data)` };
	function reportError(cxt, error = exports.keywordError, errorPaths, overrideAllErrors) {
		const { it } = cxt;
		const { gen, compositeRule, allErrors } = it;
		const errObj = errorObjectCode(cxt, error, errorPaths);
		if (overrideAllErrors !== null && overrideAllErrors !== void 0 ? overrideAllErrors : compositeRule || allErrors) addError(gen, errObj);
		else returnErrors(it, (0, codegen_1._)`[${errObj}]`);
	}
	exports.reportError = reportError;
	function reportExtraError(cxt, error = exports.keywordError, errorPaths) {
		const { it } = cxt;
		const { gen, compositeRule, allErrors } = it;
		addError(gen, errorObjectCode(cxt, error, errorPaths));
		if (!(compositeRule || allErrors)) returnErrors(it, names_1.default.vErrors);
	}
	exports.reportExtraError = reportExtraError;
	function resetErrorsCount(gen, errsCount) {
		gen.assign(names_1.default.errors, errsCount);
		gen.if((0, codegen_1._)`${names_1.default.vErrors} !== null`, () => gen.if(errsCount, () => gen.assign((0, codegen_1._)`${names_1.default.vErrors}.length`, errsCount), () => gen.assign(names_1.default.vErrors, null)));
	}
	exports.resetErrorsCount = resetErrorsCount;
	function extendErrors({ gen, keyword, schemaValue, data, errsCount, it }) {
		/* istanbul ignore if */
		if (errsCount === void 0) throw new Error("ajv implementation error");
		const err = gen.name("err");
		gen.forRange("i", errsCount, names_1.default.errors, (i) => {
			gen.const(err, (0, codegen_1._)`${names_1.default.vErrors}[${i}]`);
			gen.if((0, codegen_1._)`${err}.instancePath === undefined`, () => gen.assign((0, codegen_1._)`${err}.instancePath`, (0, codegen_1.strConcat)(names_1.default.instancePath, it.errorPath)));
			gen.assign((0, codegen_1._)`${err}.schemaPath`, (0, codegen_1.str)`${it.errSchemaPath}/${keyword}`);
			if (it.opts.verbose) {
				gen.assign((0, codegen_1._)`${err}.schema`, schemaValue);
				gen.assign((0, codegen_1._)`${err}.data`, data);
			}
		});
	}
	exports.extendErrors = extendErrors;
	function addError(gen, errObj) {
		const err = gen.const("err", errObj);
		gen.if((0, codegen_1._)`${names_1.default.vErrors} === null`, () => gen.assign(names_1.default.vErrors, (0, codegen_1._)`[${err}]`), (0, codegen_1._)`${names_1.default.vErrors}.push(${err})`);
		gen.code((0, codegen_1._)`${names_1.default.errors}++`);
	}
	function returnErrors(it, errs) {
		const { gen, validateName, schemaEnv } = it;
		if (schemaEnv.$async) gen.throw((0, codegen_1._)`new ${it.ValidationError}(${errs})`);
		else {
			gen.assign((0, codegen_1._)`${validateName}.errors`, errs);
			gen.return(false);
		}
	}
	var E = {
		keyword: new codegen_1.Name("keyword"),
		schemaPath: new codegen_1.Name("schemaPath"),
		params: new codegen_1.Name("params"),
		propertyName: new codegen_1.Name("propertyName"),
		message: new codegen_1.Name("message"),
		schema: new codegen_1.Name("schema"),
		parentSchema: new codegen_1.Name("parentSchema")
	};
	function errorObjectCode(cxt, error, errorPaths) {
		const { createErrors } = cxt.it;
		if (createErrors === false) return (0, codegen_1._)`{}`;
		return errorObject(cxt, error, errorPaths);
	}
	function errorObject(cxt, error, errorPaths = {}) {
		const { gen, it } = cxt;
		const keyValues = [errorInstancePath(it, errorPaths), errorSchemaPath(cxt, errorPaths)];
		extraErrorProps(cxt, error, keyValues);
		return gen.object(...keyValues);
	}
	function errorInstancePath({ errorPath }, { instancePath }) {
		const instPath = instancePath ? (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(instancePath, util_1.Type.Str)}` : errorPath;
		return [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, instPath)];
	}
	function errorSchemaPath({ keyword, it: { errSchemaPath } }, { schemaPath, parentSchema }) {
		let schPath = parentSchema ? errSchemaPath : (0, codegen_1.str)`${errSchemaPath}/${keyword}`;
		if (schemaPath) schPath = (0, codegen_1.str)`${schPath}${(0, util_1.getErrorPath)(schemaPath, util_1.Type.Str)}`;
		return [E.schemaPath, schPath];
	}
	function extraErrorProps(cxt, { params, message }, keyValues) {
		const { keyword, data, schemaValue, it } = cxt;
		const { opts, propertyName, topSchemaRef, schemaPath } = it;
		keyValues.push([E.keyword, keyword], [E.params, typeof params == "function" ? params(cxt) : params || (0, codegen_1._)`{}`]);
		if (opts.messages) keyValues.push([E.message, typeof message == "function" ? message(cxt) : message]);
		if (opts.verbose) keyValues.push([E.schema, schemaValue], [E.parentSchema, (0, codegen_1._)`${topSchemaRef}${schemaPath}`], [names_1.default.data, data]);
		if (propertyName) keyValues.push([E.propertyName, propertyName]);
	}
}));
//#endregion
//#region node_modules/ajv/dist/compile/validate/boolSchema.js
var require_boolSchema = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.boolOrEmptySchema = exports.topBoolOrEmptySchema = void 0;
	var errors_1 = require_errors();
	var codegen_1 = require_codegen();
	var names_1 = require_names();
	var boolError = { message: "boolean schema is false" };
	function topBoolOrEmptySchema(it) {
		const { gen, schema, validateName } = it;
		if (schema === false) falseSchemaError(it, false);
		else if (typeof schema == "object" && schema.$async === true) gen.return(names_1.default.data);
		else {
			gen.assign((0, codegen_1._)`${validateName}.errors`, null);
			gen.return(true);
		}
	}
	exports.topBoolOrEmptySchema = topBoolOrEmptySchema;
	function boolOrEmptySchema(it, valid) {
		const { gen, schema } = it;
		if (schema === false) {
			gen.var(valid, false);
			falseSchemaError(it);
		} else gen.var(valid, true);
	}
	exports.boolOrEmptySchema = boolOrEmptySchema;
	function falseSchemaError(it, overrideAllErrors) {
		const { gen, data } = it;
		const cxt = {
			gen,
			keyword: "false schema",
			data,
			schema: false,
			schemaCode: false,
			schemaValue: false,
			params: {},
			it
		};
		(0, errors_1.reportError)(cxt, boolError, void 0, overrideAllErrors);
	}
}));
//#endregion
//#region node_modules/ajv/dist/compile/rules.js
var require_rules = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getRules = exports.isJSONType = void 0;
	var jsonTypes = new Set([
		"string",
		"number",
		"integer",
		"boolean",
		"null",
		"object",
		"array"
	]);
	function isJSONType(x) {
		return typeof x == "string" && jsonTypes.has(x);
	}
	exports.isJSONType = isJSONType;
	function getRules() {
		const groups = {
			number: {
				type: "number",
				rules: []
			},
			string: {
				type: "string",
				rules: []
			},
			array: {
				type: "array",
				rules: []
			},
			object: {
				type: "object",
				rules: []
			}
		};
		return {
			types: {
				...groups,
				integer: true,
				boolean: true,
				null: true
			},
			rules: [
				{ rules: [] },
				groups.number,
				groups.string,
				groups.array,
				groups.object
			],
			post: { rules: [] },
			all: {},
			keywords: {}
		};
	}
	exports.getRules = getRules;
}));
//#endregion
//#region node_modules/ajv/dist/compile/validate/applicability.js
var require_applicability = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.shouldUseRule = exports.shouldUseGroup = exports.schemaHasRulesForType = void 0;
	function schemaHasRulesForType({ schema, self }, type) {
		const group = self.RULES.types[type];
		return group && group !== true && shouldUseGroup(schema, group);
	}
	exports.schemaHasRulesForType = schemaHasRulesForType;
	function shouldUseGroup(schema, group) {
		return group.rules.some((rule) => shouldUseRule(schema, rule));
	}
	exports.shouldUseGroup = shouldUseGroup;
	function shouldUseRule(schema, rule) {
		var _a;
		return schema[rule.keyword] !== void 0 || ((_a = rule.definition.implements) === null || _a === void 0 ? void 0 : _a.some((kwd) => schema[kwd] !== void 0));
	}
	exports.shouldUseRule = shouldUseRule;
}));
//#endregion
//#region node_modules/ajv/dist/compile/validate/dataType.js
var require_dataType = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.reportTypeError = exports.checkDataTypes = exports.checkDataType = exports.coerceAndCheckDataType = exports.getJSONTypes = exports.getSchemaTypes = exports.DataType = void 0;
	var rules_1 = require_rules();
	var applicability_1 = require_applicability();
	var errors_1 = require_errors();
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	var DataType;
	(function(DataType) {
		DataType[DataType["Correct"] = 0] = "Correct";
		DataType[DataType["Wrong"] = 1] = "Wrong";
	})(DataType || (exports.DataType = DataType = {}));
	function getSchemaTypes(schema) {
		const types = getJSONTypes(schema.type);
		if (types.includes("null")) {
			if (schema.nullable === false) throw new Error("type: null contradicts nullable: false");
		} else {
			if (!types.length && schema.nullable !== void 0) throw new Error("\"nullable\" cannot be used without \"type\"");
			if (schema.nullable === true) types.push("null");
		}
		return types;
	}
	exports.getSchemaTypes = getSchemaTypes;
	function getJSONTypes(ts) {
		const types = Array.isArray(ts) ? ts : ts ? [ts] : [];
		if (types.every(rules_1.isJSONType)) return types;
		throw new Error("type must be JSONType or JSONType[]: " + types.join(","));
	}
	exports.getJSONTypes = getJSONTypes;
	function coerceAndCheckDataType(it, types) {
		const { gen, data, opts } = it;
		const coerceTo = coerceToTypes(types, opts.coerceTypes);
		const checkTypes = types.length > 0 && !(coerceTo.length === 0 && types.length === 1 && (0, applicability_1.schemaHasRulesForType)(it, types[0]));
		if (checkTypes) {
			const wrongType = checkDataTypes(types, data, opts.strictNumbers, DataType.Wrong);
			gen.if(wrongType, () => {
				if (coerceTo.length) coerceData(it, types, coerceTo);
				else reportTypeError(it);
			});
		}
		return checkTypes;
	}
	exports.coerceAndCheckDataType = coerceAndCheckDataType;
	var COERCIBLE = new Set([
		"string",
		"number",
		"integer",
		"boolean",
		"null"
	]);
	function coerceToTypes(types, coerceTypes) {
		return coerceTypes ? types.filter((t) => COERCIBLE.has(t) || coerceTypes === "array" && t === "array") : [];
	}
	function coerceData(it, types, coerceTo) {
		const { gen, data, opts } = it;
		const dataType = gen.let("dataType", (0, codegen_1._)`typeof ${data}`);
		const coerced = gen.let("coerced", (0, codegen_1._)`undefined`);
		if (opts.coerceTypes === "array") gen.if((0, codegen_1._)`${dataType} == 'object' && Array.isArray(${data}) && ${data}.length == 1`, () => gen.assign(data, (0, codegen_1._)`${data}[0]`).assign(dataType, (0, codegen_1._)`typeof ${data}`).if(checkDataTypes(types, data, opts.strictNumbers), () => gen.assign(coerced, data)));
		gen.if((0, codegen_1._)`${coerced} !== undefined`);
		for (const t of coerceTo) if (COERCIBLE.has(t) || t === "array" && opts.coerceTypes === "array") coerceSpecificType(t);
		gen.else();
		reportTypeError(it);
		gen.endIf();
		gen.if((0, codegen_1._)`${coerced} !== undefined`, () => {
			gen.assign(data, coerced);
			assignParentData(it, coerced);
		});
		function coerceSpecificType(t) {
			switch (t) {
				case "string":
					gen.elseIf((0, codegen_1._)`${dataType} == "number" || ${dataType} == "boolean"`).assign(coerced, (0, codegen_1._)`"" + ${data}`).elseIf((0, codegen_1._)`${data} === null`).assign(coerced, (0, codegen_1._)`""`);
					return;
				case "number":
					gen.elseIf((0, codegen_1._)`${dataType} == "boolean" || ${data} === null
              || (${dataType} == "string" && ${data} && ${data} == +${data})`).assign(coerced, (0, codegen_1._)`+${data}`);
					return;
				case "integer":
					gen.elseIf((0, codegen_1._)`${dataType} === "boolean" || ${data} === null
              || (${dataType} === "string" && ${data} && ${data} == +${data} && !(${data} % 1))`).assign(coerced, (0, codegen_1._)`+${data}`);
					return;
				case "boolean":
					gen.elseIf((0, codegen_1._)`${data} === "false" || ${data} === 0 || ${data} === null`).assign(coerced, false).elseIf((0, codegen_1._)`${data} === "true" || ${data} === 1`).assign(coerced, true);
					return;
				case "null":
					gen.elseIf((0, codegen_1._)`${data} === "" || ${data} === 0 || ${data} === false`);
					gen.assign(coerced, null);
					return;
				case "array": gen.elseIf((0, codegen_1._)`${dataType} === "string" || ${dataType} === "number"
              || ${dataType} === "boolean" || ${data} === null`).assign(coerced, (0, codegen_1._)`[${data}]`);
			}
		}
	}
	function assignParentData({ gen, parentData, parentDataProperty }, expr) {
		gen.if((0, codegen_1._)`${parentData} !== undefined`, () => gen.assign((0, codegen_1._)`${parentData}[${parentDataProperty}]`, expr));
	}
	function checkDataType(dataType, data, strictNums, correct = DataType.Correct) {
		const EQ = correct === DataType.Correct ? codegen_1.operators.EQ : codegen_1.operators.NEQ;
		let cond;
		switch (dataType) {
			case "null": return (0, codegen_1._)`${data} ${EQ} null`;
			case "array":
				cond = (0, codegen_1._)`Array.isArray(${data})`;
				break;
			case "object":
				cond = (0, codegen_1._)`${data} && typeof ${data} == "object" && !Array.isArray(${data})`;
				break;
			case "integer":
				cond = numCond((0, codegen_1._)`!(${data} % 1) && !isNaN(${data})`);
				break;
			case "number":
				cond = numCond();
				break;
			default: return (0, codegen_1._)`typeof ${data} ${EQ} ${dataType}`;
		}
		return correct === DataType.Correct ? cond : (0, codegen_1.not)(cond);
		function numCond(_cond = codegen_1.nil) {
			return (0, codegen_1.and)((0, codegen_1._)`typeof ${data} == "number"`, _cond, strictNums ? (0, codegen_1._)`isFinite(${data})` : codegen_1.nil);
		}
	}
	exports.checkDataType = checkDataType;
	function checkDataTypes(dataTypes, data, strictNums, correct) {
		if (dataTypes.length === 1) return checkDataType(dataTypes[0], data, strictNums, correct);
		let cond;
		const types = (0, util_1.toHash)(dataTypes);
		if (types.array && types.object) {
			const notObj = (0, codegen_1._)`typeof ${data} != "object"`;
			cond = types.null ? notObj : (0, codegen_1._)`!${data} || ${notObj}`;
			delete types.null;
			delete types.array;
			delete types.object;
		} else cond = codegen_1.nil;
		if (types.number) delete types.integer;
		for (const t in types) cond = (0, codegen_1.and)(cond, checkDataType(t, data, strictNums, correct));
		return cond;
	}
	exports.checkDataTypes = checkDataTypes;
	var typeError = {
		message: ({ schema }) => `must be ${schema}`,
		params: ({ schema, schemaValue }) => typeof schema == "string" ? (0, codegen_1._)`{type: ${schema}}` : (0, codegen_1._)`{type: ${schemaValue}}`
	};
	function reportTypeError(it) {
		const cxt = getTypeErrorContext(it);
		(0, errors_1.reportError)(cxt, typeError);
	}
	exports.reportTypeError = reportTypeError;
	function getTypeErrorContext(it) {
		const { gen, data, schema } = it;
		const schemaCode = (0, util_1.schemaRefOrVal)(it, schema, "type");
		return {
			gen,
			keyword: "type",
			data,
			schema: schema.type,
			schemaCode,
			schemaValue: schemaCode,
			parentSchema: schema,
			params: {},
			it
		};
	}
}));
//#endregion
//#region node_modules/ajv/dist/compile/validate/defaults.js
var require_defaults = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.assignDefaults = void 0;
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	function assignDefaults(it, ty) {
		const { properties, items } = it.schema;
		if (ty === "object" && properties) for (const key in properties) assignDefault(it, key, properties[key].default);
		else if (ty === "array" && Array.isArray(items)) items.forEach((sch, i) => assignDefault(it, i, sch.default));
	}
	exports.assignDefaults = assignDefaults;
	function assignDefault(it, prop, defaultValue) {
		const { gen, compositeRule, data, opts } = it;
		if (defaultValue === void 0) return;
		const childData = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(prop)}`;
		if (compositeRule) {
			(0, util_1.checkStrictMode)(it, `default is ignored for: ${childData}`);
			return;
		}
		let condition = (0, codegen_1._)`${childData} === undefined`;
		if (opts.useDefaults === "empty") condition = (0, codegen_1._)`${condition} || ${childData} === null || ${childData} === ""`;
		gen.if(condition, (0, codegen_1._)`${childData} = ${(0, codegen_1.stringify)(defaultValue)}`);
	}
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/code.js
var require_code = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.validateUnion = exports.validateArray = exports.usePattern = exports.callValidateCode = exports.schemaProperties = exports.allSchemaProperties = exports.noPropertyInData = exports.propertyInData = exports.isOwnProperty = exports.hasPropFunc = exports.reportMissingProp = exports.checkMissingProp = exports.checkReportMissingProp = void 0;
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	var names_1 = require_names();
	var util_2 = require_util();
	function checkReportMissingProp(cxt, prop) {
		const { gen, data, it } = cxt;
		gen.if(noPropertyInData(gen, data, prop, it.opts.ownProperties), () => {
			cxt.setParams({ missingProperty: (0, codegen_1._)`${prop}` }, true);
			cxt.error();
		});
	}
	exports.checkReportMissingProp = checkReportMissingProp;
	function checkMissingProp({ gen, data, it: { opts } }, properties, missing) {
		return (0, codegen_1.or)(...properties.map((prop) => (0, codegen_1.and)(noPropertyInData(gen, data, prop, opts.ownProperties), (0, codegen_1._)`${missing} = ${prop}`)));
	}
	exports.checkMissingProp = checkMissingProp;
	function reportMissingProp(cxt, missing) {
		cxt.setParams({ missingProperty: missing }, true);
		cxt.error();
	}
	exports.reportMissingProp = reportMissingProp;
	function hasPropFunc(gen) {
		return gen.scopeValue("func", {
			ref: Object.prototype.hasOwnProperty,
			code: (0, codegen_1._)`Object.prototype.hasOwnProperty`
		});
	}
	exports.hasPropFunc = hasPropFunc;
	function isOwnProperty(gen, data, property) {
		return (0, codegen_1._)`${hasPropFunc(gen)}.call(${data}, ${property})`;
	}
	exports.isOwnProperty = isOwnProperty;
	function propertyInData(gen, data, property, ownProperties) {
		const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} !== undefined`;
		return ownProperties ? (0, codegen_1._)`${cond} && ${isOwnProperty(gen, data, property)}` : cond;
	}
	exports.propertyInData = propertyInData;
	function noPropertyInData(gen, data, property, ownProperties) {
		const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} === undefined`;
		return ownProperties ? (0, codegen_1.or)(cond, (0, codegen_1.not)(isOwnProperty(gen, data, property))) : cond;
	}
	exports.noPropertyInData = noPropertyInData;
	function allSchemaProperties(schemaMap) {
		return schemaMap ? Object.keys(schemaMap).filter((p) => p !== "__proto__") : [];
	}
	exports.allSchemaProperties = allSchemaProperties;
	function schemaProperties(it, schemaMap) {
		return allSchemaProperties(schemaMap).filter((p) => !(0, util_1.alwaysValidSchema)(it, schemaMap[p]));
	}
	exports.schemaProperties = schemaProperties;
	function callValidateCode({ schemaCode, data, it: { gen, topSchemaRef, schemaPath, errorPath }, it }, func, context, passSchema) {
		const dataAndSchema = passSchema ? (0, codegen_1._)`${schemaCode}, ${data}, ${topSchemaRef}${schemaPath}` : data;
		const valCxt = [
			[names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, errorPath)],
			[names_1.default.parentData, it.parentData],
			[names_1.default.parentDataProperty, it.parentDataProperty],
			[names_1.default.rootData, names_1.default.rootData]
		];
		if (it.opts.dynamicRef) valCxt.push([names_1.default.dynamicAnchors, names_1.default.dynamicAnchors]);
		const args = (0, codegen_1._)`${dataAndSchema}, ${gen.object(...valCxt)}`;
		return context !== codegen_1.nil ? (0, codegen_1._)`${func}.call(${context}, ${args})` : (0, codegen_1._)`${func}(${args})`;
	}
	exports.callValidateCode = callValidateCode;
	var newRegExp = (0, codegen_1._)`new RegExp`;
	function usePattern({ gen, it: { opts } }, pattern) {
		const u = opts.unicodeRegExp ? "u" : "";
		const { regExp } = opts.code;
		const rx = regExp(pattern, u);
		return gen.scopeValue("pattern", {
			key: rx.toString(),
			ref: rx,
			code: (0, codegen_1._)`${regExp.code === "new RegExp" ? newRegExp : (0, util_2.useFunc)(gen, regExp)}(${pattern}, ${u})`
		});
	}
	exports.usePattern = usePattern;
	function validateArray(cxt) {
		const { gen, data, keyword, it } = cxt;
		const valid = gen.name("valid");
		if (it.allErrors) {
			const validArr = gen.let("valid", true);
			validateItems(() => gen.assign(validArr, false));
			return validArr;
		}
		gen.var(valid, true);
		validateItems(() => gen.break());
		return valid;
		function validateItems(notValid) {
			const len = gen.const("len", (0, codegen_1._)`${data}.length`);
			gen.forRange("i", 0, len, (i) => {
				cxt.subschema({
					keyword,
					dataProp: i,
					dataPropType: util_1.Type.Num
				}, valid);
				gen.if((0, codegen_1.not)(valid), notValid);
			});
		}
	}
	exports.validateArray = validateArray;
	function validateUnion(cxt) {
		const { gen, schema, keyword, it } = cxt;
		/* istanbul ignore if */
		if (!Array.isArray(schema)) throw new Error("ajv implementation error");
		if (schema.some((sch) => (0, util_1.alwaysValidSchema)(it, sch)) && !it.opts.unevaluated) return;
		const valid = gen.let("valid", false);
		const schValid = gen.name("_valid");
		gen.block(() => schema.forEach((_sch, i) => {
			const schCxt = cxt.subschema({
				keyword,
				schemaProp: i,
				compositeRule: true
			}, schValid);
			gen.assign(valid, (0, codegen_1._)`${valid} || ${schValid}`);
			if (!cxt.mergeValidEvaluated(schCxt, schValid)) gen.if((0, codegen_1.not)(valid));
		}));
		cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
	}
	exports.validateUnion = validateUnion;
}));
//#endregion
//#region node_modules/ajv/dist/compile/validate/keyword.js
var require_keyword = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.validateKeywordUsage = exports.validSchemaType = exports.funcKeywordCode = exports.macroKeywordCode = void 0;
	var codegen_1 = require_codegen();
	var names_1 = require_names();
	var code_1 = require_code();
	var errors_1 = require_errors();
	function macroKeywordCode(cxt, def) {
		const { gen, keyword, schema, parentSchema, it } = cxt;
		const macroSchema = def.macro.call(it.self, schema, parentSchema, it);
		const schemaRef = useKeyword(gen, keyword, macroSchema);
		if (it.opts.validateSchema !== false) it.self.validateSchema(macroSchema, true);
		const valid = gen.name("valid");
		cxt.subschema({
			schema: macroSchema,
			schemaPath: codegen_1.nil,
			errSchemaPath: `${it.errSchemaPath}/${keyword}`,
			topSchemaRef: schemaRef,
			compositeRule: true
		}, valid);
		cxt.pass(valid, () => cxt.error(true));
	}
	exports.macroKeywordCode = macroKeywordCode;
	function funcKeywordCode(cxt, def) {
		var _a;
		const { gen, keyword, schema, parentSchema, $data, it } = cxt;
		checkAsyncKeyword(it, def);
		const validateRef = useKeyword(gen, keyword, !$data && def.compile ? def.compile.call(it.self, schema, parentSchema, it) : def.validate);
		const valid = gen.let("valid");
		cxt.block$data(valid, validateKeyword);
		cxt.ok((_a = def.valid) !== null && _a !== void 0 ? _a : valid);
		function validateKeyword() {
			if (def.errors === false) {
				assignValid();
				if (def.modifying) modifyData(cxt);
				reportErrs(() => cxt.error());
			} else {
				const ruleErrs = def.async ? validateAsync() : validateSync();
				if (def.modifying) modifyData(cxt);
				reportErrs(() => addErrs(cxt, ruleErrs));
			}
		}
		function validateAsync() {
			const ruleErrs = gen.let("ruleErrs", null);
			gen.try(() => assignValid((0, codegen_1._)`await `), (e) => gen.assign(valid, false).if((0, codegen_1._)`${e} instanceof ${it.ValidationError}`, () => gen.assign(ruleErrs, (0, codegen_1._)`${e}.errors`), () => gen.throw(e)));
			return ruleErrs;
		}
		function validateSync() {
			const validateErrs = (0, codegen_1._)`${validateRef}.errors`;
			gen.assign(validateErrs, null);
			assignValid(codegen_1.nil);
			return validateErrs;
		}
		function assignValid(_await = def.async ? (0, codegen_1._)`await ` : codegen_1.nil) {
			const passCxt = it.opts.passContext ? names_1.default.this : names_1.default.self;
			const passSchema = !("compile" in def && !$data || def.schema === false);
			gen.assign(valid, (0, codegen_1._)`${_await}${(0, code_1.callValidateCode)(cxt, validateRef, passCxt, passSchema)}`, def.modifying);
		}
		function reportErrs(errors) {
			var _a;
			gen.if((0, codegen_1.not)((_a = def.valid) !== null && _a !== void 0 ? _a : valid), errors);
		}
	}
	exports.funcKeywordCode = funcKeywordCode;
	function modifyData(cxt) {
		const { gen, data, it } = cxt;
		gen.if(it.parentData, () => gen.assign(data, (0, codegen_1._)`${it.parentData}[${it.parentDataProperty}]`));
	}
	function addErrs(cxt, errs) {
		const { gen } = cxt;
		gen.if((0, codegen_1._)`Array.isArray(${errs})`, () => {
			gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`).assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
			(0, errors_1.extendErrors)(cxt);
		}, () => cxt.error());
	}
	function checkAsyncKeyword({ schemaEnv }, def) {
		if (def.async && !schemaEnv.$async) throw new Error("async keyword in sync schema");
	}
	function useKeyword(gen, keyword, result) {
		if (result === void 0) throw new Error(`keyword "${keyword}" failed to compile`);
		return gen.scopeValue("keyword", typeof result == "function" ? { ref: result } : {
			ref: result,
			code: (0, codegen_1.stringify)(result)
		});
	}
	function validSchemaType(schema, schemaType, allowUndefined = false) {
		return !schemaType.length || schemaType.some((st) => st === "array" ? Array.isArray(schema) : st === "object" ? schema && typeof schema == "object" && !Array.isArray(schema) : typeof schema == st || allowUndefined && typeof schema == "undefined");
	}
	exports.validSchemaType = validSchemaType;
	function validateKeywordUsage({ schema, opts, self, errSchemaPath }, def, keyword) {
		/* istanbul ignore if */
		if (Array.isArray(def.keyword) ? !def.keyword.includes(keyword) : def.keyword !== keyword) throw new Error("ajv implementation error");
		const deps = def.dependencies;
		if (deps === null || deps === void 0 ? void 0 : deps.some((kwd) => !Object.prototype.hasOwnProperty.call(schema, kwd))) throw new Error(`parent schema must have dependencies of ${keyword}: ${deps.join(",")}`);
		if (def.validateSchema) {
			if (!def.validateSchema(schema[keyword])) {
				const msg = `keyword "${keyword}" value is invalid at path "${errSchemaPath}": ` + self.errorsText(def.validateSchema.errors);
				if (opts.validateSchema === "log") self.logger.error(msg);
				else throw new Error(msg);
			}
		}
	}
	exports.validateKeywordUsage = validateKeywordUsage;
}));
//#endregion
//#region node_modules/ajv/dist/compile/validate/subschema.js
var require_subschema = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.extendSubschemaMode = exports.extendSubschemaData = exports.getSubschema = void 0;
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	function getSubschema(it, { keyword, schemaProp, schema, schemaPath, errSchemaPath, topSchemaRef }) {
		if (keyword !== void 0 && schema !== void 0) throw new Error("both \"keyword\" and \"schema\" passed, only one allowed");
		if (keyword !== void 0) {
			const sch = it.schema[keyword];
			return schemaProp === void 0 ? {
				schema: sch,
				schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}`,
				errSchemaPath: `${it.errSchemaPath}/${keyword}`
			} : {
				schema: sch[schemaProp],
				schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}${(0, codegen_1.getProperty)(schemaProp)}`,
				errSchemaPath: `${it.errSchemaPath}/${keyword}/${(0, util_1.escapeFragment)(schemaProp)}`
			};
		}
		if (schema !== void 0) {
			if (schemaPath === void 0 || errSchemaPath === void 0 || topSchemaRef === void 0) throw new Error("\"schemaPath\", \"errSchemaPath\" and \"topSchemaRef\" are required with \"schema\"");
			return {
				schema,
				schemaPath,
				topSchemaRef,
				errSchemaPath
			};
		}
		throw new Error("either \"keyword\" or \"schema\" must be passed");
	}
	exports.getSubschema = getSubschema;
	function extendSubschemaData(subschema, it, { dataProp, dataPropType: dpType, data, dataTypes, propertyName }) {
		if (data !== void 0 && dataProp !== void 0) throw new Error("both \"data\" and \"dataProp\" passed, only one allowed");
		const { gen } = it;
		if (dataProp !== void 0) {
			const { errorPath, dataPathArr, opts } = it;
			dataContextProps(gen.let("data", (0, codegen_1._)`${it.data}${(0, codegen_1.getProperty)(dataProp)}`, true));
			subschema.errorPath = (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(dataProp, dpType, opts.jsPropertySyntax)}`;
			subschema.parentDataProperty = (0, codegen_1._)`${dataProp}`;
			subschema.dataPathArr = [...dataPathArr, subschema.parentDataProperty];
		}
		if (data !== void 0) {
			dataContextProps(data instanceof codegen_1.Name ? data : gen.let("data", data, true));
			if (propertyName !== void 0) subschema.propertyName = propertyName;
		}
		if (dataTypes) subschema.dataTypes = dataTypes;
		function dataContextProps(_nextData) {
			subschema.data = _nextData;
			subschema.dataLevel = it.dataLevel + 1;
			subschema.dataTypes = [];
			it.definedProperties = /* @__PURE__ */ new Set();
			subschema.parentData = it.data;
			subschema.dataNames = [...it.dataNames, _nextData];
		}
	}
	exports.extendSubschemaData = extendSubschemaData;
	function extendSubschemaMode(subschema, { jtdDiscriminator, jtdMetadata, compositeRule, createErrors, allErrors }) {
		if (compositeRule !== void 0) subschema.compositeRule = compositeRule;
		if (createErrors !== void 0) subschema.createErrors = createErrors;
		if (allErrors !== void 0) subschema.allErrors = allErrors;
		subschema.jtdDiscriminator = jtdDiscriminator;
		subschema.jtdMetadata = jtdMetadata;
	}
	exports.extendSubschemaMode = extendSubschemaMode;
}));
//#endregion
//#region node_modules/fast-deep-equal/index.js
var require_fast_deep_equal = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = function equal(a, b) {
		if (a === b) return true;
		if (a && b && typeof a == "object" && typeof b == "object") {
			if (a.constructor !== b.constructor) return false;
			var length, i, keys;
			if (Array.isArray(a)) {
				length = a.length;
				if (length != b.length) return false;
				for (i = length; i-- !== 0;) if (!equal(a[i], b[i])) return false;
				return true;
			}
			if (a.constructor === RegExp) return a.source === b.source && a.flags === b.flags;
			if (a.valueOf !== Object.prototype.valueOf) return a.valueOf() === b.valueOf();
			if (a.toString !== Object.prototype.toString) return a.toString() === b.toString();
			keys = Object.keys(a);
			length = keys.length;
			if (length !== Object.keys(b).length) return false;
			for (i = length; i-- !== 0;) if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
			for (i = length; i-- !== 0;) {
				var key = keys[i];
				if (!equal(a[key], b[key])) return false;
			}
			return true;
		}
		return a !== a && b !== b;
	};
}));
//#endregion
//#region node_modules/json-schema-traverse/index.js
var require_json_schema_traverse = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var traverse = module.exports = function(schema, opts, cb) {
		if (typeof opts == "function") {
			cb = opts;
			opts = {};
		}
		cb = opts.cb || cb;
		var pre = typeof cb == "function" ? cb : cb.pre || function() {};
		var post = cb.post || function() {};
		_traverse(opts, pre, post, schema, "", schema);
	};
	traverse.keywords = {
		additionalItems: true,
		items: true,
		contains: true,
		additionalProperties: true,
		propertyNames: true,
		not: true,
		if: true,
		then: true,
		else: true
	};
	traverse.arrayKeywords = {
		items: true,
		allOf: true,
		anyOf: true,
		oneOf: true
	};
	traverse.propsKeywords = {
		$defs: true,
		definitions: true,
		properties: true,
		patternProperties: true,
		dependencies: true
	};
	traverse.skipKeywords = {
		default: true,
		enum: true,
		const: true,
		required: true,
		maximum: true,
		minimum: true,
		exclusiveMaximum: true,
		exclusiveMinimum: true,
		multipleOf: true,
		maxLength: true,
		minLength: true,
		pattern: true,
		format: true,
		maxItems: true,
		minItems: true,
		uniqueItems: true,
		maxProperties: true,
		minProperties: true
	};
	function _traverse(opts, pre, post, schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex) {
		if (schema && typeof schema == "object" && !Array.isArray(schema)) {
			pre(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
			for (var key in schema) {
				var sch = schema[key];
				if (Array.isArray(sch)) {
					if (key in traverse.arrayKeywords) for (var i = 0; i < sch.length; i++) _traverse(opts, pre, post, sch[i], jsonPtr + "/" + key + "/" + i, rootSchema, jsonPtr, key, schema, i);
				} else if (key in traverse.propsKeywords) {
					if (sch && typeof sch == "object") for (var prop in sch) _traverse(opts, pre, post, sch[prop], jsonPtr + "/" + key + "/" + escapeJsonPtr(prop), rootSchema, jsonPtr, key, schema, prop);
				} else if (key in traverse.keywords || opts.allKeys && !(key in traverse.skipKeywords)) _traverse(opts, pre, post, sch, jsonPtr + "/" + key, rootSchema, jsonPtr, key, schema);
			}
			post(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
		}
	}
	function escapeJsonPtr(str) {
		return str.replace(/~/g, "~0").replace(/\//g, "~1");
	}
}));
//#endregion
//#region node_modules/ajv/dist/compile/resolve.js
var require_resolve = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getSchemaRefs = exports.resolveUrl = exports.normalizeId = exports._getFullPath = exports.getFullPath = exports.inlineRef = void 0;
	var util_1 = require_util();
	var equal = require_fast_deep_equal();
	var traverse = require_json_schema_traverse();
	var SIMPLE_INLINED = new Set([
		"type",
		"format",
		"pattern",
		"maxLength",
		"minLength",
		"maxProperties",
		"minProperties",
		"maxItems",
		"minItems",
		"maximum",
		"minimum",
		"uniqueItems",
		"multipleOf",
		"required",
		"enum",
		"const"
	]);
	function inlineRef(schema, limit = true) {
		if (typeof schema == "boolean") return true;
		if (limit === true) return !hasRef(schema);
		if (!limit) return false;
		return countKeys(schema) <= limit;
	}
	exports.inlineRef = inlineRef;
	var REF_KEYWORDS = new Set([
		"$ref",
		"$recursiveRef",
		"$recursiveAnchor",
		"$dynamicRef",
		"$dynamicAnchor"
	]);
	function hasRef(schema) {
		for (const key in schema) {
			if (REF_KEYWORDS.has(key)) return true;
			const sch = schema[key];
			if (Array.isArray(sch) && sch.some(hasRef)) return true;
			if (typeof sch == "object" && hasRef(sch)) return true;
		}
		return false;
	}
	function countKeys(schema) {
		let count = 0;
		for (const key in schema) {
			if (key === "$ref") return Infinity;
			count++;
			if (SIMPLE_INLINED.has(key)) continue;
			if (typeof schema[key] == "object") (0, util_1.eachItem)(schema[key], (sch) => count += countKeys(sch));
			if (count === Infinity) return Infinity;
		}
		return count;
	}
	function getFullPath(resolver, id = "", normalize) {
		if (normalize !== false) id = normalizeId(id);
		return _getFullPath(resolver, resolver.parse(id));
	}
	exports.getFullPath = getFullPath;
	function _getFullPath(resolver, p) {
		return resolver.serialize(p).split("#")[0] + "#";
	}
	exports._getFullPath = _getFullPath;
	var TRAILING_SLASH_HASH = /#\/?$/;
	function normalizeId(id) {
		return id ? id.replace(TRAILING_SLASH_HASH, "") : "";
	}
	exports.normalizeId = normalizeId;
	function resolveUrl(resolver, baseId, id) {
		id = normalizeId(id);
		return resolver.resolve(baseId, id);
	}
	exports.resolveUrl = resolveUrl;
	var ANCHOR = /^[a-z_][-a-z0-9._]*$/i;
	function getSchemaRefs(schema, baseId) {
		if (typeof schema == "boolean") return {};
		const { schemaId, uriResolver } = this.opts;
		const schId = normalizeId(schema[schemaId] || baseId);
		const baseIds = { "": schId };
		const pathPrefix = getFullPath(uriResolver, schId, false);
		const localRefs = {};
		const schemaRefs = /* @__PURE__ */ new Set();
		traverse(schema, { allKeys: true }, (sch, jsonPtr, _, parentJsonPtr) => {
			if (parentJsonPtr === void 0) return;
			const fullPath = pathPrefix + jsonPtr;
			let innerBaseId = baseIds[parentJsonPtr];
			if (typeof sch[schemaId] == "string") innerBaseId = addRef.call(this, sch[schemaId]);
			addAnchor.call(this, sch.$anchor);
			addAnchor.call(this, sch.$dynamicAnchor);
			baseIds[jsonPtr] = innerBaseId;
			function addRef(ref) {
				const _resolve = this.opts.uriResolver.resolve;
				ref = normalizeId(innerBaseId ? _resolve(innerBaseId, ref) : ref);
				if (schemaRefs.has(ref)) throw ambiguos(ref);
				schemaRefs.add(ref);
				let schOrRef = this.refs[ref];
				if (typeof schOrRef == "string") schOrRef = this.refs[schOrRef];
				if (typeof schOrRef == "object") checkAmbiguosRef(sch, schOrRef.schema, ref);
				else if (ref !== normalizeId(fullPath)) if (ref[0] === "#") {
					checkAmbiguosRef(sch, localRefs[ref], ref);
					localRefs[ref] = sch;
				} else this.refs[ref] = fullPath;
				return ref;
			}
			function addAnchor(anchor) {
				if (typeof anchor == "string") {
					if (!ANCHOR.test(anchor)) throw new Error(`invalid anchor "${anchor}"`);
					addRef.call(this, `#${anchor}`);
				}
			}
		});
		return localRefs;
		function checkAmbiguosRef(sch1, sch2, ref) {
			if (sch2 !== void 0 && !equal(sch1, sch2)) throw ambiguos(ref);
		}
		function ambiguos(ref) {
			return /* @__PURE__ */ new Error(`reference "${ref}" resolves to more than one schema`);
		}
	}
	exports.getSchemaRefs = getSchemaRefs;
}));
//#endregion
//#region node_modules/ajv/dist/compile/validate/index.js
var require_validate = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getData = exports.KeywordCxt = exports.validateFunctionCode = void 0;
	var boolSchema_1 = require_boolSchema();
	var dataType_1 = require_dataType();
	var applicability_1 = require_applicability();
	var dataType_2 = require_dataType();
	var defaults_1 = require_defaults();
	var keyword_1 = require_keyword();
	var subschema_1 = require_subschema();
	var codegen_1 = require_codegen();
	var names_1 = require_names();
	var resolve_1 = require_resolve();
	var util_1 = require_util();
	var errors_1 = require_errors();
	function validateFunctionCode(it) {
		if (isSchemaObj(it)) {
			checkKeywords(it);
			if (schemaCxtHasRules(it)) {
				topSchemaObjCode(it);
				return;
			}
		}
		validateFunction(it, () => (0, boolSchema_1.topBoolOrEmptySchema)(it));
	}
	exports.validateFunctionCode = validateFunctionCode;
	function validateFunction({ gen, validateName, schema, schemaEnv, opts }, body) {
		if (opts.code.es5) gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${names_1.default.valCxt}`, schemaEnv.$async, () => {
			gen.code((0, codegen_1._)`"use strict"; ${funcSourceUrl(schema, opts)}`);
			destructureValCxtES5(gen, opts);
			gen.code(body);
		});
		else gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${destructureValCxt(opts)}`, schemaEnv.$async, () => gen.code(funcSourceUrl(schema, opts)).code(body));
	}
	function destructureValCxt(opts) {
		return (0, codegen_1._)`{${names_1.default.instancePath}="", ${names_1.default.parentData}, ${names_1.default.parentDataProperty}, ${names_1.default.rootData}=${names_1.default.data}${opts.dynamicRef ? (0, codegen_1._)`, ${names_1.default.dynamicAnchors}={}` : codegen_1.nil}}={}`;
	}
	function destructureValCxtES5(gen, opts) {
		gen.if(names_1.default.valCxt, () => {
			gen.var(names_1.default.instancePath, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.instancePath}`);
			gen.var(names_1.default.parentData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentData}`);
			gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentDataProperty}`);
			gen.var(names_1.default.rootData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.rootData}`);
			if (opts.dynamicRef) gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.dynamicAnchors}`);
		}, () => {
			gen.var(names_1.default.instancePath, (0, codegen_1._)`""`);
			gen.var(names_1.default.parentData, (0, codegen_1._)`undefined`);
			gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`undefined`);
			gen.var(names_1.default.rootData, names_1.default.data);
			if (opts.dynamicRef) gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`{}`);
		});
	}
	function topSchemaObjCode(it) {
		const { schema, opts, gen } = it;
		validateFunction(it, () => {
			if (opts.$comment && schema.$comment) commentKeyword(it);
			checkNoDefault(it);
			gen.let(names_1.default.vErrors, null);
			gen.let(names_1.default.errors, 0);
			if (opts.unevaluated) resetEvaluated(it);
			typeAndKeywords(it);
			returnResults(it);
		});
	}
	function resetEvaluated(it) {
		const { gen, validateName } = it;
		it.evaluated = gen.const("evaluated", (0, codegen_1._)`${validateName}.evaluated`);
		gen.if((0, codegen_1._)`${it.evaluated}.dynamicProps`, () => gen.assign((0, codegen_1._)`${it.evaluated}.props`, (0, codegen_1._)`undefined`));
		gen.if((0, codegen_1._)`${it.evaluated}.dynamicItems`, () => gen.assign((0, codegen_1._)`${it.evaluated}.items`, (0, codegen_1._)`undefined`));
	}
	function funcSourceUrl(schema, opts) {
		const schId = typeof schema == "object" && schema[opts.schemaId];
		return schId && (opts.code.source || opts.code.process) ? (0, codegen_1._)`/*# sourceURL=${schId} */` : codegen_1.nil;
	}
	function subschemaCode(it, valid) {
		if (isSchemaObj(it)) {
			checkKeywords(it);
			if (schemaCxtHasRules(it)) {
				subSchemaObjCode(it, valid);
				return;
			}
		}
		(0, boolSchema_1.boolOrEmptySchema)(it, valid);
	}
	function schemaCxtHasRules({ schema, self }) {
		if (typeof schema == "boolean") return !schema;
		for (const key in schema) if (self.RULES.all[key]) return true;
		return false;
	}
	function isSchemaObj(it) {
		return typeof it.schema != "boolean";
	}
	function subSchemaObjCode(it, valid) {
		const { schema, gen, opts } = it;
		if (opts.$comment && schema.$comment) commentKeyword(it);
		updateContext(it);
		checkAsyncSchema(it);
		const errsCount = gen.const("_errs", names_1.default.errors);
		typeAndKeywords(it, errsCount);
		gen.var(valid, (0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
	}
	function checkKeywords(it) {
		(0, util_1.checkUnknownRules)(it);
		checkRefsAndKeywords(it);
	}
	function typeAndKeywords(it, errsCount) {
		if (it.opts.jtd) return schemaKeywords(it, [], false, errsCount);
		const types = (0, dataType_1.getSchemaTypes)(it.schema);
		schemaKeywords(it, types, !(0, dataType_1.coerceAndCheckDataType)(it, types), errsCount);
	}
	function checkRefsAndKeywords(it) {
		const { schema, errSchemaPath, opts, self } = it;
		if (schema.$ref && opts.ignoreKeywordsWithRef && (0, util_1.schemaHasRulesButRef)(schema, self.RULES)) self.logger.warn(`$ref: keywords ignored in schema at path "${errSchemaPath}"`);
	}
	function checkNoDefault(it) {
		const { schema, opts } = it;
		if (schema.default !== void 0 && opts.useDefaults && opts.strictSchema) (0, util_1.checkStrictMode)(it, "default is ignored in the schema root");
	}
	function updateContext(it) {
		const schId = it.schema[it.opts.schemaId];
		if (schId) it.baseId = (0, resolve_1.resolveUrl)(it.opts.uriResolver, it.baseId, schId);
	}
	function checkAsyncSchema(it) {
		if (it.schema.$async && !it.schemaEnv.$async) throw new Error("async schema in sync schema");
	}
	function commentKeyword({ gen, schemaEnv, schema, errSchemaPath, opts }) {
		const msg = schema.$comment;
		if (opts.$comment === true) gen.code((0, codegen_1._)`${names_1.default.self}.logger.log(${msg})`);
		else if (typeof opts.$comment == "function") {
			const schemaPath = (0, codegen_1.str)`${errSchemaPath}/$comment`;
			const rootName = gen.scopeValue("root", { ref: schemaEnv.root });
			gen.code((0, codegen_1._)`${names_1.default.self}.opts.$comment(${msg}, ${schemaPath}, ${rootName}.schema)`);
		}
	}
	function returnResults(it) {
		const { gen, schemaEnv, validateName, ValidationError, opts } = it;
		if (schemaEnv.$async) gen.if((0, codegen_1._)`${names_1.default.errors} === 0`, () => gen.return(names_1.default.data), () => gen.throw((0, codegen_1._)`new ${ValidationError}(${names_1.default.vErrors})`));
		else {
			gen.assign((0, codegen_1._)`${validateName}.errors`, names_1.default.vErrors);
			if (opts.unevaluated) assignEvaluated(it);
			gen.return((0, codegen_1._)`${names_1.default.errors} === 0`);
		}
	}
	function assignEvaluated({ gen, evaluated, props, items }) {
		if (props instanceof codegen_1.Name) gen.assign((0, codegen_1._)`${evaluated}.props`, props);
		if (items instanceof codegen_1.Name) gen.assign((0, codegen_1._)`${evaluated}.items`, items);
	}
	function schemaKeywords(it, types, typeErrors, errsCount) {
		const { gen, schema, data, allErrors, opts, self } = it;
		const { RULES } = self;
		if (schema.$ref && (opts.ignoreKeywordsWithRef || !(0, util_1.schemaHasRulesButRef)(schema, RULES))) {
			gen.block(() => keywordCode(it, "$ref", RULES.all.$ref.definition));
			return;
		}
		if (!opts.jtd) checkStrictTypes(it, types);
		gen.block(() => {
			for (const group of RULES.rules) groupKeywords(group);
			groupKeywords(RULES.post);
		});
		function groupKeywords(group) {
			if (!(0, applicability_1.shouldUseGroup)(schema, group)) return;
			if (group.type) {
				gen.if((0, dataType_2.checkDataType)(group.type, data, opts.strictNumbers));
				iterateKeywords(it, group);
				if (types.length === 1 && types[0] === group.type && typeErrors) {
					gen.else();
					(0, dataType_2.reportTypeError)(it);
				}
				gen.endIf();
			} else iterateKeywords(it, group);
			if (!allErrors) gen.if((0, codegen_1._)`${names_1.default.errors} === ${errsCount || 0}`);
		}
	}
	function iterateKeywords(it, group) {
		const { gen, schema, opts: { useDefaults } } = it;
		if (useDefaults) (0, defaults_1.assignDefaults)(it, group.type);
		gen.block(() => {
			for (const rule of group.rules) if ((0, applicability_1.shouldUseRule)(schema, rule)) keywordCode(it, rule.keyword, rule.definition, group.type);
		});
	}
	function checkStrictTypes(it, types) {
		if (it.schemaEnv.meta || !it.opts.strictTypes) return;
		checkContextTypes(it, types);
		if (!it.opts.allowUnionTypes) checkMultipleTypes(it, types);
		checkKeywordTypes(it, it.dataTypes);
	}
	function checkContextTypes(it, types) {
		if (!types.length) return;
		if (!it.dataTypes.length) {
			it.dataTypes = types;
			return;
		}
		types.forEach((t) => {
			if (!includesType(it.dataTypes, t)) strictTypesError(it, `type "${t}" not allowed by context "${it.dataTypes.join(",")}"`);
		});
		narrowSchemaTypes(it, types);
	}
	function checkMultipleTypes(it, ts) {
		if (ts.length > 1 && !(ts.length === 2 && ts.includes("null"))) strictTypesError(it, "use allowUnionTypes to allow union type keyword");
	}
	function checkKeywordTypes(it, ts) {
		const rules = it.self.RULES.all;
		for (const keyword in rules) {
			const rule = rules[keyword];
			if (typeof rule == "object" && (0, applicability_1.shouldUseRule)(it.schema, rule)) {
				const { type } = rule.definition;
				if (type.length && !type.some((t) => hasApplicableType(ts, t))) strictTypesError(it, `missing type "${type.join(",")}" for keyword "${keyword}"`);
			}
		}
	}
	function hasApplicableType(schTs, kwdT) {
		return schTs.includes(kwdT) || kwdT === "number" && schTs.includes("integer");
	}
	function includesType(ts, t) {
		return ts.includes(t) || t === "integer" && ts.includes("number");
	}
	function narrowSchemaTypes(it, withTypes) {
		const ts = [];
		for (const t of it.dataTypes) if (includesType(withTypes, t)) ts.push(t);
		else if (withTypes.includes("integer") && t === "number") ts.push("integer");
		it.dataTypes = ts;
	}
	function strictTypesError(it, msg) {
		const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
		msg += ` at "${schemaPath}" (strictTypes)`;
		(0, util_1.checkStrictMode)(it, msg, it.opts.strictTypes);
	}
	var KeywordCxt = class {
		constructor(it, def, keyword) {
			(0, keyword_1.validateKeywordUsage)(it, def, keyword);
			this.gen = it.gen;
			this.allErrors = it.allErrors;
			this.keyword = keyword;
			this.data = it.data;
			this.schema = it.schema[keyword];
			this.$data = def.$data && it.opts.$data && this.schema && this.schema.$data;
			this.schemaValue = (0, util_1.schemaRefOrVal)(it, this.schema, keyword, this.$data);
			this.schemaType = def.schemaType;
			this.parentSchema = it.schema;
			this.params = {};
			this.it = it;
			this.def = def;
			if (this.$data) this.schemaCode = it.gen.const("vSchema", getData(this.$data, it));
			else {
				this.schemaCode = this.schemaValue;
				if (!(0, keyword_1.validSchemaType)(this.schema, def.schemaType, def.allowUndefined)) throw new Error(`${keyword} value must be ${JSON.stringify(def.schemaType)}`);
			}
			if ("code" in def ? def.trackErrors : def.errors !== false) this.errsCount = it.gen.const("_errs", names_1.default.errors);
		}
		result(condition, successAction, failAction) {
			this.failResult((0, codegen_1.not)(condition), successAction, failAction);
		}
		failResult(condition, successAction, failAction) {
			this.gen.if(condition);
			if (failAction) failAction();
			else this.error();
			if (successAction) {
				this.gen.else();
				successAction();
				if (this.allErrors) this.gen.endIf();
			} else if (this.allErrors) this.gen.endIf();
			else this.gen.else();
		}
		pass(condition, failAction) {
			this.failResult((0, codegen_1.not)(condition), void 0, failAction);
		}
		fail(condition) {
			if (condition === void 0) {
				this.error();
				if (!this.allErrors) this.gen.if(false);
				return;
			}
			this.gen.if(condition);
			this.error();
			if (this.allErrors) this.gen.endIf();
			else this.gen.else();
		}
		fail$data(condition) {
			if (!this.$data) return this.fail(condition);
			const { schemaCode } = this;
			this.fail((0, codegen_1._)`${schemaCode} !== undefined && (${(0, codegen_1.or)(this.invalid$data(), condition)})`);
		}
		error(append, errorParams, errorPaths) {
			if (errorParams) {
				this.setParams(errorParams);
				this._error(append, errorPaths);
				this.setParams({});
				return;
			}
			this._error(append, errorPaths);
		}
		_error(append, errorPaths) {
			(append ? errors_1.reportExtraError : errors_1.reportError)(this, this.def.error, errorPaths);
		}
		$dataError() {
			(0, errors_1.reportError)(this, this.def.$dataError || errors_1.keyword$DataError);
		}
		reset() {
			if (this.errsCount === void 0) throw new Error("add \"trackErrors\" to keyword definition");
			(0, errors_1.resetErrorsCount)(this.gen, this.errsCount);
		}
		ok(cond) {
			if (!this.allErrors) this.gen.if(cond);
		}
		setParams(obj, assign) {
			if (assign) Object.assign(this.params, obj);
			else this.params = obj;
		}
		block$data(valid, codeBlock, $dataValid = codegen_1.nil) {
			this.gen.block(() => {
				this.check$data(valid, $dataValid);
				codeBlock();
			});
		}
		check$data(valid = codegen_1.nil, $dataValid = codegen_1.nil) {
			if (!this.$data) return;
			const { gen, schemaCode, schemaType, def } = this;
			gen.if((0, codegen_1.or)((0, codegen_1._)`${schemaCode} === undefined`, $dataValid));
			if (valid !== codegen_1.nil) gen.assign(valid, true);
			if (schemaType.length || def.validateSchema) {
				gen.elseIf(this.invalid$data());
				this.$dataError();
				if (valid !== codegen_1.nil) gen.assign(valid, false);
			}
			gen.else();
		}
		invalid$data() {
			const { gen, schemaCode, schemaType, def, it } = this;
			return (0, codegen_1.or)(wrong$DataType(), invalid$DataSchema());
			function wrong$DataType() {
				if (schemaType.length) {
					/* istanbul ignore if */
					if (!(schemaCode instanceof codegen_1.Name)) throw new Error("ajv implementation error");
					const st = Array.isArray(schemaType) ? schemaType : [schemaType];
					return (0, codegen_1._)`${(0, dataType_2.checkDataTypes)(st, schemaCode, it.opts.strictNumbers, dataType_2.DataType.Wrong)}`;
				}
				return codegen_1.nil;
			}
			function invalid$DataSchema() {
				if (def.validateSchema) {
					const validateSchemaRef = gen.scopeValue("validate$data", { ref: def.validateSchema });
					return (0, codegen_1._)`!${validateSchemaRef}(${schemaCode})`;
				}
				return codegen_1.nil;
			}
		}
		subschema(appl, valid) {
			const subschema = (0, subschema_1.getSubschema)(this.it, appl);
			(0, subschema_1.extendSubschemaData)(subschema, this.it, appl);
			(0, subschema_1.extendSubschemaMode)(subschema, appl);
			const nextContext = {
				...this.it,
				...subschema,
				items: void 0,
				props: void 0
			};
			subschemaCode(nextContext, valid);
			return nextContext;
		}
		mergeEvaluated(schemaCxt, toName) {
			const { it, gen } = this;
			if (!it.opts.unevaluated) return;
			if (it.props !== true && schemaCxt.props !== void 0) it.props = util_1.mergeEvaluated.props(gen, schemaCxt.props, it.props, toName);
			if (it.items !== true && schemaCxt.items !== void 0) it.items = util_1.mergeEvaluated.items(gen, schemaCxt.items, it.items, toName);
		}
		mergeValidEvaluated(schemaCxt, valid) {
			const { it, gen } = this;
			if (it.opts.unevaluated && (it.props !== true || it.items !== true)) {
				gen.if(valid, () => this.mergeEvaluated(schemaCxt, codegen_1.Name));
				return true;
			}
		}
	};
	exports.KeywordCxt = KeywordCxt;
	function keywordCode(it, keyword, def, ruleType) {
		const cxt = new KeywordCxt(it, def, keyword);
		if ("code" in def) def.code(cxt, ruleType);
		else if (cxt.$data && def.validate) (0, keyword_1.funcKeywordCode)(cxt, def);
		else if ("macro" in def) (0, keyword_1.macroKeywordCode)(cxt, def);
		else if (def.compile || def.validate) (0, keyword_1.funcKeywordCode)(cxt, def);
	}
	var JSON_POINTER = /^\/(?:[^~]|~0|~1)*$/;
	var RELATIVE_JSON_POINTER = /^([0-9]+)(#|\/(?:[^~]|~0|~1)*)?$/;
	function getData($data, { dataLevel, dataNames, dataPathArr }) {
		let jsonPointer;
		let data;
		if ($data === "") return names_1.default.rootData;
		if ($data[0] === "/") {
			if (!JSON_POINTER.test($data)) throw new Error(`Invalid JSON-pointer: ${$data}`);
			jsonPointer = $data;
			data = names_1.default.rootData;
		} else {
			const matches = RELATIVE_JSON_POINTER.exec($data);
			if (!matches) throw new Error(`Invalid JSON-pointer: ${$data}`);
			const up = +matches[1];
			jsonPointer = matches[2];
			if (jsonPointer === "#") {
				if (up >= dataLevel) throw new Error(errorMsg("property/index", up));
				return dataPathArr[dataLevel - up];
			}
			if (up > dataLevel) throw new Error(errorMsg("data", up));
			data = dataNames[dataLevel - up];
			if (!jsonPointer) return data;
		}
		let expr = data;
		const segments = jsonPointer.split("/");
		for (const segment of segments) if (segment) {
			data = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)((0, util_1.unescapeJsonPointer)(segment))}`;
			expr = (0, codegen_1._)`${expr} && ${data}`;
		}
		return expr;
		function errorMsg(pointerType, up) {
			return `Cannot access ${pointerType} ${up} levels up, current level is ${dataLevel}`;
		}
	}
	exports.getData = getData;
}));
//#endregion
//#region node_modules/ajv/dist/runtime/validation_error.js
var require_validation_error = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var ValidationError = class extends Error {
		constructor(errors) {
			super("validation failed");
			this.errors = errors;
			this.ajv = this.validation = true;
		}
	};
	exports.default = ValidationError;
}));
//#endregion
//#region node_modules/ajv/dist/compile/ref_error.js
var require_ref_error = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var resolve_1 = require_resolve();
	var MissingRefError = class extends Error {
		constructor(resolver, baseId, ref, msg) {
			super(msg || `can't resolve reference ${ref} from id ${baseId}`);
			this.missingRef = (0, resolve_1.resolveUrl)(resolver, baseId, ref);
			this.missingSchema = (0, resolve_1.normalizeId)((0, resolve_1.getFullPath)(resolver, this.missingRef));
		}
	};
	exports.default = MissingRefError;
}));
//#endregion
//#region node_modules/ajv/dist/compile/index.js
var require_compile = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.resolveSchema = exports.getCompilingSchema = exports.resolveRef = exports.compileSchema = exports.SchemaEnv = void 0;
	var codegen_1 = require_codegen();
	var validation_error_1 = require_validation_error();
	var names_1 = require_names();
	var resolve_1 = require_resolve();
	var util_1 = require_util();
	var validate_1 = require_validate();
	var SchemaEnv = class {
		constructor(env) {
			var _a;
			this.refs = {};
			this.dynamicAnchors = {};
			let schema;
			if (typeof env.schema == "object") schema = env.schema;
			this.schema = env.schema;
			this.schemaId = env.schemaId;
			this.root = env.root || this;
			this.baseId = (_a = env.baseId) !== null && _a !== void 0 ? _a : (0, resolve_1.normalizeId)(schema === null || schema === void 0 ? void 0 : schema[env.schemaId || "$id"]);
			this.schemaPath = env.schemaPath;
			this.localRefs = env.localRefs;
			this.meta = env.meta;
			this.$async = schema === null || schema === void 0 ? void 0 : schema.$async;
			this.refs = {};
		}
	};
	exports.SchemaEnv = SchemaEnv;
	function compileSchema(sch) {
		const _sch = getCompilingSchema.call(this, sch);
		if (_sch) return _sch;
		const rootId = (0, resolve_1.getFullPath)(this.opts.uriResolver, sch.root.baseId);
		const { es5, lines } = this.opts.code;
		const { ownProperties } = this.opts;
		const gen = new codegen_1.CodeGen(this.scope, {
			es5,
			lines,
			ownProperties
		});
		let _ValidationError;
		if (sch.$async) _ValidationError = gen.scopeValue("Error", {
			ref: validation_error_1.default,
			code: (0, codegen_1._)`require("ajv/dist/runtime/validation_error").default`
		});
		const validateName = gen.scopeName("validate");
		sch.validateName = validateName;
		const schemaCxt = {
			gen,
			allErrors: this.opts.allErrors,
			data: names_1.default.data,
			parentData: names_1.default.parentData,
			parentDataProperty: names_1.default.parentDataProperty,
			dataNames: [names_1.default.data],
			dataPathArr: [codegen_1.nil],
			dataLevel: 0,
			dataTypes: [],
			definedProperties: /* @__PURE__ */ new Set(),
			topSchemaRef: gen.scopeValue("schema", this.opts.code.source === true ? {
				ref: sch.schema,
				code: (0, codegen_1.stringify)(sch.schema)
			} : { ref: sch.schema }),
			validateName,
			ValidationError: _ValidationError,
			schema: sch.schema,
			schemaEnv: sch,
			rootId,
			baseId: sch.baseId || rootId,
			schemaPath: codegen_1.nil,
			errSchemaPath: sch.schemaPath || (this.opts.jtd ? "" : "#"),
			errorPath: (0, codegen_1._)`""`,
			opts: this.opts,
			self: this
		};
		let sourceCode;
		try {
			this._compilations.add(sch);
			(0, validate_1.validateFunctionCode)(schemaCxt);
			gen.optimize(this.opts.code.optimize);
			const validateCode = gen.toString();
			sourceCode = `${gen.scopeRefs(names_1.default.scope)}return ${validateCode}`;
			if (this.opts.code.process) sourceCode = this.opts.code.process(sourceCode, sch);
			const validate = new Function(`${names_1.default.self}`, `${names_1.default.scope}`, sourceCode)(this, this.scope.get());
			this.scope.value(validateName, { ref: validate });
			validate.errors = null;
			validate.schema = sch.schema;
			validate.schemaEnv = sch;
			if (sch.$async) validate.$async = true;
			if (this.opts.code.source === true) validate.source = {
				validateName,
				validateCode,
				scopeValues: gen._values
			};
			if (this.opts.unevaluated) {
				const { props, items } = schemaCxt;
				validate.evaluated = {
					props: props instanceof codegen_1.Name ? void 0 : props,
					items: items instanceof codegen_1.Name ? void 0 : items,
					dynamicProps: props instanceof codegen_1.Name,
					dynamicItems: items instanceof codegen_1.Name
				};
				if (validate.source) validate.source.evaluated = (0, codegen_1.stringify)(validate.evaluated);
			}
			sch.validate = validate;
			return sch;
		} catch (e) {
			delete sch.validate;
			delete sch.validateName;
			if (sourceCode) this.logger.error("Error compiling schema, function code:", sourceCode);
			throw e;
		} finally {
			this._compilations.delete(sch);
		}
	}
	exports.compileSchema = compileSchema;
	function resolveRef(root, baseId, ref) {
		var _a;
		ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, ref);
		const schOrFunc = root.refs[ref];
		if (schOrFunc) return schOrFunc;
		let _sch = resolve.call(this, root, ref);
		if (_sch === void 0) {
			const schema = (_a = root.localRefs) === null || _a === void 0 ? void 0 : _a[ref];
			const { schemaId } = this.opts;
			if (schema) _sch = new SchemaEnv({
				schema,
				schemaId,
				root,
				baseId
			});
		}
		if (_sch === void 0) return;
		return root.refs[ref] = inlineOrCompile.call(this, _sch);
	}
	exports.resolveRef = resolveRef;
	function inlineOrCompile(sch) {
		if ((0, resolve_1.inlineRef)(sch.schema, this.opts.inlineRefs)) return sch.schema;
		return sch.validate ? sch : compileSchema.call(this, sch);
	}
	function getCompilingSchema(schEnv) {
		for (const sch of this._compilations) if (sameSchemaEnv(sch, schEnv)) return sch;
	}
	exports.getCompilingSchema = getCompilingSchema;
	function sameSchemaEnv(s1, s2) {
		return s1.schema === s2.schema && s1.root === s2.root && s1.baseId === s2.baseId;
	}
	function resolve(root, ref) {
		let sch;
		while (typeof (sch = this.refs[ref]) == "string") ref = sch;
		return sch || this.schemas[ref] || resolveSchema.call(this, root, ref);
	}
	function resolveSchema(root, ref) {
		const p = this.opts.uriResolver.parse(ref);
		const refPath = (0, resolve_1._getFullPath)(this.opts.uriResolver, p);
		let baseId = (0, resolve_1.getFullPath)(this.opts.uriResolver, root.baseId, void 0);
		if (Object.keys(root.schema).length > 0 && refPath === baseId) return getJsonPointer.call(this, p, root);
		const id = (0, resolve_1.normalizeId)(refPath);
		const schOrRef = this.refs[id] || this.schemas[id];
		if (typeof schOrRef == "string") {
			const sch = resolveSchema.call(this, root, schOrRef);
			if (typeof (sch === null || sch === void 0 ? void 0 : sch.schema) !== "object") return;
			return getJsonPointer.call(this, p, sch);
		}
		if (typeof (schOrRef === null || schOrRef === void 0 ? void 0 : schOrRef.schema) !== "object") return;
		if (!schOrRef.validate) compileSchema.call(this, schOrRef);
		if (id === (0, resolve_1.normalizeId)(ref)) {
			const { schema } = schOrRef;
			const { schemaId } = this.opts;
			const schId = schema[schemaId];
			if (schId) baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
			return new SchemaEnv({
				schema,
				schemaId,
				root,
				baseId
			});
		}
		return getJsonPointer.call(this, p, schOrRef);
	}
	exports.resolveSchema = resolveSchema;
	var PREVENT_SCOPE_CHANGE = new Set([
		"properties",
		"patternProperties",
		"enum",
		"dependencies",
		"definitions"
	]);
	function getJsonPointer(parsedRef, { baseId, schema, root }) {
		var _a;
		if (((_a = parsedRef.fragment) === null || _a === void 0 ? void 0 : _a[0]) !== "/") return;
		for (const part of parsedRef.fragment.slice(1).split("/")) {
			if (typeof schema === "boolean") return;
			const partSchema = schema[(0, util_1.unescapeFragment)(part)];
			if (partSchema === void 0) return;
			schema = partSchema;
			const schId = typeof schema === "object" && schema[this.opts.schemaId];
			if (!PREVENT_SCOPE_CHANGE.has(part) && schId) baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
		}
		let env;
		if (typeof schema != "boolean" && schema.$ref && !(0, util_1.schemaHasRulesButRef)(schema, this.RULES)) {
			const $ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schema.$ref);
			env = resolveSchema.call(this, root, $ref);
		}
		const { schemaId } = this.opts;
		env = env || new SchemaEnv({
			schema,
			schemaId,
			root,
			baseId
		});
		if (env.schema !== env.root.schema) return env;
	}
}));
//#endregion
//#region node_modules/ajv/dist/refs/data.json
var data_exports = /* @__PURE__ */ __exportAll({
	$id: () => $id$11,
	additionalProperties: () => false,
	default: () => data_default,
	description: () => description,
	properties: () => properties$11,
	required: () => required$3,
	type: () => type$11
}), $id$11, description, type$11, required$3, properties$11, data_default;
var init_data = __esmMin((() => {
	$id$11 = "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#";
	description = "Meta-schema for $data reference (JSON AnySchema extension proposal)";
	type$11 = "object";
	required$3 = ["$data"];
	properties$11 = { "$data": {
		"type": "string",
		"anyOf": [{ "format": "relative-json-pointer" }, { "format": "json-pointer" }]
	} };
	data_default = {
		$id: $id$11,
		description,
		type: type$11,
		required: required$3,
		properties: properties$11,
		additionalProperties: false
	};
}));
//#endregion
//#region node_modules/fast-uri/lib/utils.js
var require_utils = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/** @type {(value: string) => boolean} */
	var isUUID = RegExp.prototype.test.bind(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu);
	/** @type {(value: string) => boolean} */
	var isIPv4 = RegExp.prototype.test.bind(/^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)$/u);
	/** @type {(value: string) => boolean} */
	var isHexPair = RegExp.prototype.test.bind(/^[\da-f]{2}$/iu);
	/** @type {(value: string) => boolean} */
	var isUnreserved = RegExp.prototype.test.bind(/^[\da-z\-._~]$/iu);
	/** @type {(value: string) => boolean} */
	var isPathCharacter = RegExp.prototype.test.bind(/^[\da-z\-._~!$&'()*+,;=:@/]$/iu);
	/**
	* @param {Array<string>} input
	* @returns {string}
	*/
	function stringArrayToHexStripped(input) {
		let acc = "";
		let code = 0;
		let i = 0;
		for (i = 0; i < input.length; i++) {
			code = input[i].charCodeAt(0);
			if (code === 48) continue;
			if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) return "";
			acc += input[i];
			break;
		}
		for (i += 1; i < input.length; i++) {
			code = input[i].charCodeAt(0);
			if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) return "";
			acc += input[i];
		}
		return acc;
	}
	/**
	* @typedef {Object} GetIPV6Result
	* @property {boolean} error - Indicates if there was an error parsing the IPv6 address.
	* @property {string} address - The parsed IPv6 address.
	* @property {string} [zone] - The zone identifier, if present.
	*/
	/**
	* @param {string} value
	* @returns {boolean}
	*/
	var nonSimpleDomain = RegExp.prototype.test.bind(/[^!"$&'()*+,\-.;=_`a-z{}~]/u);
	/**
	* @param {Array<string>} buffer
	* @returns {boolean}
	*/
	function consumeIsZone(buffer) {
		buffer.length = 0;
		return true;
	}
	/**
	* @param {Array<string>} buffer
	* @param {Array<string>} address
	* @param {GetIPV6Result} output
	* @returns {boolean}
	*/
	function consumeHextets(buffer, address, output) {
		if (buffer.length) {
			const hex = stringArrayToHexStripped(buffer);
			if (hex !== "") address.push(hex);
			else {
				output.error = true;
				return false;
			}
			buffer.length = 0;
		}
		return true;
	}
	/**
	* @param {string} input
	* @returns {GetIPV6Result}
	*/
	function getIPV6(input) {
		let tokenCount = 0;
		const output = {
			error: false,
			address: "",
			zone: ""
		};
		/** @type {Array<string>} */
		const address = [];
		/** @type {Array<string>} */
		const buffer = [];
		let endipv6Encountered = false;
		let endIpv6 = false;
		let consume = consumeHextets;
		for (let i = 0; i < input.length; i++) {
			const cursor = input[i];
			if (cursor === "[" || cursor === "]") continue;
			if (cursor === ":") {
				if (endipv6Encountered === true) endIpv6 = true;
				if (!consume(buffer, address, output)) break;
				if (++tokenCount > 7) {
					output.error = true;
					break;
				}
				if (i > 0 && input[i - 1] === ":") endipv6Encountered = true;
				address.push(":");
				continue;
			} else if (cursor === "%") {
				if (!consume(buffer, address, output)) break;
				consume = consumeIsZone;
			} else {
				buffer.push(cursor);
				continue;
			}
		}
		if (buffer.length) if (consume === consumeIsZone) output.zone = buffer.join("");
		else if (endIpv6) address.push(buffer.join(""));
		else address.push(stringArrayToHexStripped(buffer));
		output.address = address.join("");
		return output;
	}
	/**
	* @typedef {Object} NormalizeIPv6Result
	* @property {string} host - The normalized host.
	* @property {string} [escapedHost] - The escaped host.
	* @property {boolean} isIPV6 - Indicates if the host is an IPv6 address.
	*/
	/**
	* @param {string} host
	* @returns {NormalizeIPv6Result}
	*/
	function normalizeIPv6(host) {
		if (findToken(host, ":") < 2) return {
			host,
			isIPV6: false
		};
		const ipv6 = getIPV6(host);
		if (!ipv6.error) {
			let newHost = ipv6.address;
			let escapedHost = ipv6.address;
			if (ipv6.zone) {
				newHost += "%" + ipv6.zone;
				escapedHost += "%25" + ipv6.zone;
			}
			return {
				host: newHost,
				isIPV6: true,
				escapedHost
			};
		} else return {
			host,
			isIPV6: false
		};
	}
	/**
	* @param {string} str
	* @param {string} token
	* @returns {number}
	*/
	function findToken(str, token) {
		let ind = 0;
		for (let i = 0; i < str.length; i++) if (str[i] === token) ind++;
		return ind;
	}
	/**
	* @param {string} path
	* @returns {string}
	*
	* @see https://datatracker.ietf.org/doc/html/rfc3986#section-5.2.4
	*/
	function removeDotSegments(path) {
		let input = path;
		const output = [];
		let nextSlash = -1;
		let len = 0;
		while (len = input.length) {
			if (len === 1) if (input === ".") break;
			else if (input === "/") {
				output.push("/");
				break;
			} else {
				output.push(input);
				break;
			}
			else if (len === 2) {
				if (input[0] === ".") {
					if (input[1] === ".") break;
					else if (input[1] === "/") {
						input = input.slice(2);
						continue;
					}
				} else if (input[0] === "/") {
					if (input[1] === "." || input[1] === "/") {
						output.push("/");
						break;
					}
				}
			} else if (len === 3) {
				if (input === "/..") {
					if (output.length !== 0) output.pop();
					output.push("/");
					break;
				}
			}
			if (input[0] === ".") {
				if (input[1] === ".") {
					if (input[2] === "/") {
						input = input.slice(3);
						continue;
					}
				} else if (input[1] === "/") {
					input = input.slice(2);
					continue;
				}
			} else if (input[0] === "/") {
				if (input[1] === ".") {
					if (input[2] === "/") {
						input = input.slice(2);
						continue;
					} else if (input[2] === ".") {
						if (input[3] === "/") {
							input = input.slice(3);
							if (output.length !== 0) output.pop();
							continue;
						}
					}
				}
			}
			if ((nextSlash = input.indexOf("/", 1)) === -1) {
				output.push(input);
				break;
			} else {
				output.push(input.slice(0, nextSlash));
				input = input.slice(nextSlash);
			}
		}
		return output.join("");
	}
	/**
	* Re-escape RFC 3986 gen-delims that must not appear literally in the host.
	* After the URI regex parses, these characters cannot be literal in the host
	* field, so any that appear after decoding came from percent-encoding and
	* must be restored to prevent authority structure changes.
	*
	* @param {string} host
	* @param {boolean} isIP - true for IPv4/IPv6 hosts (skip colon re-escaping)
	* @returns {string}
	*/
	var HOST_DELIMS = {
		"@": "%40",
		"/": "%2F",
		"?": "%3F",
		"#": "%23",
		":": "%3A"
	};
	var HOST_DELIM_RE = /[@/?#:]/g;
	var HOST_DELIM_NO_COLON_RE = /[@/?#]/g;
	function reescapeHostDelimiters(host, isIP) {
		const re = isIP ? HOST_DELIM_NO_COLON_RE : HOST_DELIM_RE;
		re.lastIndex = 0;
		return host.replace(re, (ch) => HOST_DELIMS[ch]);
	}
	/**
	* Normalizes percent escapes and optionally decodes only unreserved ASCII bytes.
	* Reserved delimiters such as `%2F` and `%2E` stay escaped.
	*
	* @param {string} input
	* @param {boolean} [decodeUnreserved=false]
	* @returns {string}
	*/
	function normalizePercentEncoding(input, decodeUnreserved = false) {
		if (input.indexOf("%") === -1) return input;
		let output = "";
		for (let i = 0; i < input.length; i++) {
			if (input[i] === "%" && i + 2 < input.length) {
				const hex = input.slice(i + 1, i + 3);
				if (isHexPair(hex)) {
					const normalizedHex = hex.toUpperCase();
					const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
					if (decodeUnreserved && isUnreserved(decoded)) output += decoded;
					else output += "%" + normalizedHex;
					i += 2;
					continue;
				}
			}
			output += input[i];
		}
		return output;
	}
	/**
	* Normalizes path data without turning reserved escapes into live path syntax.
	* Valid escapes are uppercased, raw unsafe characters are escaped, and only
	* unreserved bytes that are not `.` are decoded.
	*
	* @param {string} input
	* @returns {string}
	*/
	function normalizePathEncoding(input) {
		let output = "";
		for (let i = 0; i < input.length; i++) {
			if (input[i] === "%" && i + 2 < input.length) {
				const hex = input.slice(i + 1, i + 3);
				if (isHexPair(hex)) {
					const normalizedHex = hex.toUpperCase();
					const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
					if (decoded !== "." && isUnreserved(decoded)) output += decoded;
					else output += "%" + normalizedHex;
					i += 2;
					continue;
				}
			}
			if (isPathCharacter(input[i])) output += input[i];
			else output += escape(input[i]);
		}
		return output;
	}
	/**
	* Escapes a component while preserving existing valid percent escapes.
	*
	* @param {string} input
	* @returns {string}
	*/
	function escapePreservingEscapes(input) {
		let output = "";
		for (let i = 0; i < input.length; i++) {
			if (input[i] === "%" && i + 2 < input.length) {
				const hex = input.slice(i + 1, i + 3);
				if (isHexPair(hex)) {
					output += "%" + hex.toUpperCase();
					i += 2;
					continue;
				}
			}
			output += escape(input[i]);
		}
		return output;
	}
	/**
	* @param {import('../types/index').URIComponent} component
	* @returns {string|undefined}
	*/
	function recomposeAuthority(component) {
		const uriTokens = [];
		if (component.userinfo !== void 0) {
			uriTokens.push(component.userinfo);
			uriTokens.push("@");
		}
		if (component.host !== void 0) {
			let host = unescape(component.host);
			if (!isIPv4(host)) {
				const ipV6res = normalizeIPv6(host);
				if (ipV6res.isIPV6 === true) host = `[${ipV6res.escapedHost}]`;
				else host = reescapeHostDelimiters(host, false);
			}
			uriTokens.push(host);
		}
		if (typeof component.port === "number" || typeof component.port === "string") {
			uriTokens.push(":");
			uriTokens.push(String(component.port));
		}
		return uriTokens.length ? uriTokens.join("") : void 0;
	}
	module.exports = {
		nonSimpleDomain,
		recomposeAuthority,
		reescapeHostDelimiters,
		normalizePercentEncoding,
		normalizePathEncoding,
		escapePreservingEscapes,
		removeDotSegments,
		isIPv4,
		isUUID,
		normalizeIPv6,
		stringArrayToHexStripped
	};
}));
//#endregion
//#region node_modules/fast-uri/lib/schemes.js
var require_schemes = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { isUUID } = require_utils();
	var URN_REG = /([\da-z][\d\-a-z]{0,31}):((?:[\w!$'()*+,\-.:;=@]|%[\da-f]{2})+)/iu;
	var supportedSchemeNames = [
		"http",
		"https",
		"ws",
		"wss",
		"urn",
		"urn:uuid"
	];
	/** @typedef {supportedSchemeNames[number]} SchemeName */
	/**
	* @param {string} name
	* @returns {name is SchemeName}
	*/
	function isValidSchemeName(name) {
		return supportedSchemeNames.indexOf(name) !== -1;
	}
	/**
	* @callback SchemeFn
	* @param {import('../types/index').URIComponent} component
	* @param {import('../types/index').Options} options
	* @returns {import('../types/index').URIComponent}
	*/
	/**
	* @typedef {Object} SchemeHandler
	* @property {SchemeName} scheme - The scheme name.
	* @property {boolean} [domainHost] - Indicates if the scheme supports domain hosts.
	* @property {SchemeFn} parse - Function to parse the URI component for this scheme.
	* @property {SchemeFn} serialize - Function to serialize the URI component for this scheme.
	* @property {boolean} [skipNormalize] - Indicates if normalization should be skipped for this scheme.
	* @property {boolean} [absolutePath] - Indicates if the scheme uses absolute paths.
	* @property {boolean} [unicodeSupport] - Indicates if the scheme supports Unicode.
	*/
	/**
	* @param {import('../types/index').URIComponent} wsComponent
	* @returns {boolean}
	*/
	function wsIsSecure(wsComponent) {
		if (wsComponent.secure === true) return true;
		else if (wsComponent.secure === false) return false;
		else if (wsComponent.scheme) return wsComponent.scheme.length === 3 && (wsComponent.scheme[0] === "w" || wsComponent.scheme[0] === "W") && (wsComponent.scheme[1] === "s" || wsComponent.scheme[1] === "S") && (wsComponent.scheme[2] === "s" || wsComponent.scheme[2] === "S");
		else return false;
	}
	/** @type {SchemeFn} */
	function httpParse(component) {
		if (!component.host) component.error = component.error || "HTTP URIs must have a host.";
		return component;
	}
	/** @type {SchemeFn} */
	function httpSerialize(component) {
		const secure = String(component.scheme).toLowerCase() === "https";
		if (component.port === (secure ? 443 : 80) || component.port === "") component.port = void 0;
		if (!component.path) component.path = "/";
		return component;
	}
	/** @type {SchemeFn} */
	function wsParse(wsComponent) {
		wsComponent.secure = wsIsSecure(wsComponent);
		wsComponent.resourceName = (wsComponent.path || "/") + (wsComponent.query ? "?" + wsComponent.query : "");
		wsComponent.path = void 0;
		wsComponent.query = void 0;
		return wsComponent;
	}
	/** @type {SchemeFn} */
	function wsSerialize(wsComponent) {
		if (wsComponent.port === (wsIsSecure(wsComponent) ? 443 : 80) || wsComponent.port === "") wsComponent.port = void 0;
		if (typeof wsComponent.secure === "boolean") {
			wsComponent.scheme = wsComponent.secure ? "wss" : "ws";
			wsComponent.secure = void 0;
		}
		if (wsComponent.resourceName) {
			const [path, query] = wsComponent.resourceName.split("?");
			wsComponent.path = path && path !== "/" ? path : void 0;
			wsComponent.query = query;
			wsComponent.resourceName = void 0;
		}
		wsComponent.fragment = void 0;
		return wsComponent;
	}
	/** @type {SchemeFn} */
	function urnParse(urnComponent, options) {
		if (!urnComponent.path) {
			urnComponent.error = "URN can not be parsed";
			return urnComponent;
		}
		const matches = urnComponent.path.match(URN_REG);
		if (matches) {
			const scheme = options.scheme || urnComponent.scheme || "urn";
			urnComponent.nid = matches[1].toLowerCase();
			urnComponent.nss = matches[2];
			const schemeHandler = getSchemeHandler(`${scheme}:${options.nid || urnComponent.nid}`);
			urnComponent.path = void 0;
			if (schemeHandler) urnComponent = schemeHandler.parse(urnComponent, options);
		} else urnComponent.error = urnComponent.error || "URN can not be parsed.";
		return urnComponent;
	}
	/** @type {SchemeFn} */
	function urnSerialize(urnComponent, options) {
		if (urnComponent.nid === void 0) throw new Error("URN without nid cannot be serialized");
		const scheme = options.scheme || urnComponent.scheme || "urn";
		const nid = urnComponent.nid.toLowerCase();
		const schemeHandler = getSchemeHandler(`${scheme}:${options.nid || nid}`);
		if (schemeHandler) urnComponent = schemeHandler.serialize(urnComponent, options);
		const uriComponent = urnComponent;
		const nss = urnComponent.nss;
		uriComponent.path = `${nid || options.nid}:${nss}`;
		options.skipEscape = true;
		return uriComponent;
	}
	/** @type {SchemeFn} */
	function urnuuidParse(urnComponent, options) {
		const uuidComponent = urnComponent;
		uuidComponent.uuid = uuidComponent.nss;
		uuidComponent.nss = void 0;
		if (!options.tolerant && (!uuidComponent.uuid || !isUUID(uuidComponent.uuid))) uuidComponent.error = uuidComponent.error || "UUID is not valid.";
		return uuidComponent;
	}
	/** @type {SchemeFn} */
	function urnuuidSerialize(uuidComponent) {
		const urnComponent = uuidComponent;
		urnComponent.nss = (uuidComponent.uuid || "").toLowerCase();
		return urnComponent;
	}
	var http = {
		scheme: "http",
		domainHost: true,
		parse: httpParse,
		serialize: httpSerialize
	};
	var https = {
		scheme: "https",
		domainHost: http.domainHost,
		parse: httpParse,
		serialize: httpSerialize
	};
	var ws = {
		scheme: "ws",
		domainHost: true,
		parse: wsParse,
		serialize: wsSerialize
	};
	var SCHEMES = {
		http,
		https,
		ws,
		wss: {
			scheme: "wss",
			domainHost: ws.domainHost,
			parse: ws.parse,
			serialize: ws.serialize
		},
		urn: {
			scheme: "urn",
			parse: urnParse,
			serialize: urnSerialize,
			skipNormalize: true
		},
		"urn:uuid": {
			scheme: "urn:uuid",
			parse: urnuuidParse,
			serialize: urnuuidSerialize,
			skipNormalize: true
		}
	};
	Object.setPrototypeOf(SCHEMES, null);
	/**
	* @param {string|undefined} scheme
	* @returns {SchemeHandler|undefined}
	*/
	function getSchemeHandler(scheme) {
		return scheme && (SCHEMES[scheme] || SCHEMES[scheme.toLowerCase()]) || void 0;
	}
	module.exports = {
		wsIsSecure,
		SCHEMES,
		isValidSchemeName,
		getSchemeHandler
	};
}));
//#endregion
//#region node_modules/fast-uri/index.js
var require_fast_uri = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var { normalizeIPv6, removeDotSegments, recomposeAuthority, normalizePercentEncoding, normalizePathEncoding, escapePreservingEscapes, reescapeHostDelimiters, isIPv4, nonSimpleDomain } = require_utils();
	var { SCHEMES, getSchemeHandler } = require_schemes();
	/**
	* @template {import('./types/index').URIComponent|string} T
	* @param {T} uri
	* @param {import('./types/index').Options} [options]
	* @returns {T}
	*/
	function normalize(uri, options) {
		if (typeof uri === "string") uri = normalizeString(uri, options);
		else if (typeof uri === "object") uri = parse(serialize(uri, options), options);
		return uri;
	}
	/**
	* @param {string} baseURI
	* @param {string} relativeURI
	* @param {import('./types/index').Options} [options]
	* @returns {string}
	*/
	function resolve(baseURI, relativeURI, options) {
		const schemelessOptions = options ? Object.assign({ scheme: "null" }, options) : { scheme: "null" };
		const resolved = resolveComponent(parse(baseURI, schemelessOptions), parse(relativeURI, schemelessOptions), schemelessOptions, true);
		schemelessOptions.skipEscape = true;
		return serialize(resolved, schemelessOptions);
	}
	/**
	* @param {import ('./types/index').URIComponent} base
	* @param {import ('./types/index').URIComponent} relative
	* @param {import('./types/index').Options} [options]
	* @param {boolean} [skipNormalization=false]
	* @returns {import ('./types/index').URIComponent}
	*/
	function resolveComponent(base, relative, options, skipNormalization) {
		/** @type {import('./types/index').URIComponent} */
		const target = {};
		if (!skipNormalization) {
			base = parse(serialize(base, options), options);
			relative = parse(serialize(relative, options), options);
		}
		options = options || {};
		if (!options.tolerant && relative.scheme) {
			target.scheme = relative.scheme;
			target.userinfo = relative.userinfo;
			target.host = relative.host;
			target.port = relative.port;
			target.path = removeDotSegments(relative.path || "");
			target.query = relative.query;
		} else {
			if (relative.userinfo !== void 0 || relative.host !== void 0 || relative.port !== void 0) {
				target.userinfo = relative.userinfo;
				target.host = relative.host;
				target.port = relative.port;
				target.path = removeDotSegments(relative.path || "");
				target.query = relative.query;
			} else {
				if (!relative.path) {
					target.path = base.path;
					if (relative.query !== void 0) target.query = relative.query;
					else target.query = base.query;
				} else {
					if (relative.path[0] === "/") target.path = removeDotSegments(relative.path);
					else {
						if ((base.userinfo !== void 0 || base.host !== void 0 || base.port !== void 0) && !base.path) target.path = "/" + relative.path;
						else if (!base.path) target.path = relative.path;
						else target.path = base.path.slice(0, base.path.lastIndexOf("/") + 1) + relative.path;
						target.path = removeDotSegments(target.path);
					}
					target.query = relative.query;
				}
				target.userinfo = base.userinfo;
				target.host = base.host;
				target.port = base.port;
			}
			target.scheme = base.scheme;
		}
		target.fragment = relative.fragment;
		return target;
	}
	/**
	* @param {import ('./types/index').URIComponent|string} uriA
	* @param {import ('./types/index').URIComponent|string} uriB
	* @param {import ('./types/index').Options} options
	* @returns {boolean}
	*/
	function equal(uriA, uriB, options) {
		const normalizedA = normalizeComparableURI(uriA, options);
		const normalizedB = normalizeComparableURI(uriB, options);
		return normalizedA !== void 0 && normalizedB !== void 0 && normalizedA.toLowerCase() === normalizedB.toLowerCase();
	}
	/**
	* @param {Readonly<import('./types/index').URIComponent>} cmpts
	* @param {import('./types/index').Options} [opts]
	* @returns {string}
	*/
	function serialize(cmpts, opts) {
		const component = {
			host: cmpts.host,
			scheme: cmpts.scheme,
			userinfo: cmpts.userinfo,
			port: cmpts.port,
			path: cmpts.path,
			query: cmpts.query,
			nid: cmpts.nid,
			nss: cmpts.nss,
			uuid: cmpts.uuid,
			fragment: cmpts.fragment,
			reference: cmpts.reference,
			resourceName: cmpts.resourceName,
			secure: cmpts.secure,
			error: ""
		};
		const options = Object.assign({}, opts);
		const uriTokens = [];
		const schemeHandler = getSchemeHandler(options.scheme || component.scheme);
		if (schemeHandler && schemeHandler.serialize) schemeHandler.serialize(component, options);
		if (component.path !== void 0) if (!options.skipEscape) {
			component.path = escapePreservingEscapes(component.path);
			if (component.scheme !== void 0) component.path = component.path.split("%3A").join(":");
		} else component.path = normalizePercentEncoding(component.path);
		if (options.reference !== "suffix" && component.scheme) uriTokens.push(component.scheme, ":");
		const authority = recomposeAuthority(component);
		if (authority !== void 0) {
			if (options.reference !== "suffix") uriTokens.push("//");
			uriTokens.push(authority);
			if (component.path && component.path[0] !== "/") uriTokens.push("/");
		}
		if (component.path !== void 0) {
			let s = component.path;
			if (!options.absolutePath && (!schemeHandler || !schemeHandler.absolutePath)) s = removeDotSegments(s);
			if (authority === void 0 && s[0] === "/" && s[1] === "/") s = "/%2F" + s.slice(2);
			uriTokens.push(s);
		}
		if (component.query !== void 0) uriTokens.push("?", component.query);
		if (component.fragment !== void 0) uriTokens.push("#", component.fragment);
		return uriTokens.join("");
	}
	var URI_PARSE = /^(?:([^#/:?]+):)?(?:\/\/((?:([^#/?@]*)@)?(\[[^#/?\]]+\]|[^#/:?]*)(?::(\d*))?))?([^#?]*)(?:\?([^#]*))?(?:#((?:.|[\n\r])*))?/u;
	var AUTHORITY_PREFIX = /^(?:[^#/:?]+:)?\/\/([^/?#]*)/;
	/**
	* @param {import('./types/index').URIComponent} parsed
	* @param {RegExpMatchArray} matches
	* @returns {string|undefined}
	*/
	function getParseError(parsed, matches) {
		if (matches[2] !== void 0 && parsed.path && parsed.path[0] !== "/") return "URI path must start with \"/\" when authority is present.";
		if (typeof parsed.port === "number" && (parsed.port < 0 || parsed.port > 65535)) return "URI port is malformed.";
	}
	/**
	* @param {string} uri
	* @param {import('./types/index').Options} [opts]
	* @returns {{ parsed: import('./types/index').URIComponent, malformedAuthorityOrPort: boolean }}
	*/
	function parseWithStatus(uri, opts) {
		const options = Object.assign({}, opts);
		/** @type {import('./types/index').URIComponent} */
		const parsed = {
			scheme: void 0,
			userinfo: void 0,
			host: "",
			port: void 0,
			path: "",
			query: void 0,
			fragment: void 0
		};
		let malformedAuthorityOrPort = false;
		let isIP = false;
		if (options.reference === "suffix") if (options.scheme) uri = options.scheme + ":" + uri;
		else uri = "//" + uri;
		const authorityMatch = uri.match(AUTHORITY_PREFIX);
		if (authorityMatch !== null && authorityMatch[1].indexOf("\\") !== -1) {
			parsed.error = "URI authority must not contain a literal backslash.";
			malformedAuthorityOrPort = true;
		}
		const matches = uri.match(URI_PARSE);
		if (matches) {
			parsed.scheme = matches[1];
			parsed.userinfo = matches[3];
			parsed.host = matches[4];
			parsed.port = parseInt(matches[5], 10);
			parsed.path = matches[6] || "";
			parsed.query = matches[7];
			parsed.fragment = matches[8];
			if (isNaN(parsed.port)) parsed.port = matches[5];
			const parseError = getParseError(parsed, matches);
			if (parseError !== void 0) {
				parsed.error = parsed.error || parseError;
				malformedAuthorityOrPort = true;
			}
			if (parsed.host) if (isIPv4(parsed.host) === false) {
				const ipv6result = normalizeIPv6(parsed.host);
				parsed.host = ipv6result.host.toLowerCase();
				isIP = ipv6result.isIPV6;
			} else isIP = true;
			if (parsed.scheme === void 0 && parsed.userinfo === void 0 && parsed.host === void 0 && parsed.port === void 0 && parsed.query === void 0 && !parsed.path) parsed.reference = "same-document";
			else if (parsed.scheme === void 0) parsed.reference = "relative";
			else if (parsed.fragment === void 0) parsed.reference = "absolute";
			else parsed.reference = "uri";
			if (options.reference && options.reference !== "suffix" && options.reference !== parsed.reference) parsed.error = parsed.error || "URI is not a " + options.reference + " reference.";
			const schemeHandler = getSchemeHandler(options.scheme || parsed.scheme);
			if (!options.unicodeSupport && (!schemeHandler || !schemeHandler.unicodeSupport)) {
				if (parsed.host && (options.domainHost || schemeHandler && schemeHandler.domainHost) && isIP === false && nonSimpleDomain(parsed.host)) try {
					parsed.host = new URL("http://" + parsed.host).hostname;
				} catch (e) {
					parsed.error = parsed.error || "Host's domain name can not be converted to ASCII: " + e;
				}
			}
			if (!schemeHandler || schemeHandler && !schemeHandler.skipNormalize) {
				if (uri.indexOf("%") !== -1) {
					if (parsed.scheme !== void 0) parsed.scheme = unescape(parsed.scheme);
					if (parsed.host !== void 0) parsed.host = reescapeHostDelimiters(unescape(parsed.host), isIP);
				}
				if (parsed.path) parsed.path = normalizePathEncoding(parsed.path);
				if (parsed.fragment) try {
					parsed.fragment = encodeURI(decodeURIComponent(parsed.fragment));
				} catch {
					parsed.error = parsed.error || "URI malformed";
				}
			}
			if (schemeHandler && schemeHandler.parse) schemeHandler.parse(parsed, options);
		} else parsed.error = parsed.error || "URI can not be parsed.";
		return {
			parsed,
			malformedAuthorityOrPort
		};
	}
	/**
	* @param {string} uri
	* @param {import('./types/index').Options} [opts]
	* @returns
	*/
	function parse(uri, opts) {
		return parseWithStatus(uri, opts).parsed;
	}
	/**
	* @param {string} uri
	* @param {import('./types/index').Options} [opts]
	* @returns {string}
	*/
	function normalizeString(uri, opts) {
		return normalizeStringWithStatus(uri, opts).normalized;
	}
	/**
	* @param {string} uri
	* @param {import('./types/index').Options} [opts]
	* @returns {{ normalized: string, malformedAuthorityOrPort: boolean }}
	*/
	function normalizeStringWithStatus(uri, opts) {
		const { parsed, malformedAuthorityOrPort } = parseWithStatus(uri, opts);
		return {
			normalized: malformedAuthorityOrPort ? uri : serialize(parsed, opts),
			malformedAuthorityOrPort
		};
	}
	/**
	* @param {import ('./types/index').URIComponent|string} uri
	* @param {import('./types/index').Options} [opts]
	* @returns {string|undefined}
	*/
	function normalizeComparableURI(uri, opts) {
		if (typeof uri === "string") {
			const { normalized, malformedAuthorityOrPort } = normalizeStringWithStatus(uri, opts);
			return malformedAuthorityOrPort ? void 0 : normalized;
		}
		if (typeof uri === "object") return serialize(uri, opts);
	}
	var fastUri = {
		SCHEMES,
		normalize,
		resolve,
		resolveComponent,
		equal,
		serialize,
		parse
	};
	module.exports = fastUri;
	module.exports.default = fastUri;
	module.exports.fastUri = fastUri;
}));
//#endregion
//#region node_modules/ajv/dist/runtime/uri.js
var require_uri = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var uri = require_fast_uri();
	uri.code = "require(\"ajv/dist/runtime/uri\").default";
	exports.default = uri;
}));
//#endregion
//#region node_modules/ajv/dist/core.js
var require_core$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = void 0;
	var validate_1 = require_validate();
	Object.defineProperty(exports, "KeywordCxt", {
		enumerable: true,
		get: function() {
			return validate_1.KeywordCxt;
		}
	});
	var codegen_1 = require_codegen();
	Object.defineProperty(exports, "_", {
		enumerable: true,
		get: function() {
			return codegen_1._;
		}
	});
	Object.defineProperty(exports, "str", {
		enumerable: true,
		get: function() {
			return codegen_1.str;
		}
	});
	Object.defineProperty(exports, "stringify", {
		enumerable: true,
		get: function() {
			return codegen_1.stringify;
		}
	});
	Object.defineProperty(exports, "nil", {
		enumerable: true,
		get: function() {
			return codegen_1.nil;
		}
	});
	Object.defineProperty(exports, "Name", {
		enumerable: true,
		get: function() {
			return codegen_1.Name;
		}
	});
	Object.defineProperty(exports, "CodeGen", {
		enumerable: true,
		get: function() {
			return codegen_1.CodeGen;
		}
	});
	var validation_error_1 = require_validation_error();
	var ref_error_1 = require_ref_error();
	var rules_1 = require_rules();
	var compile_1 = require_compile();
	var codegen_2 = require_codegen();
	var resolve_1 = require_resolve();
	var dataType_1 = require_dataType();
	var util_1 = require_util();
	var $dataRefSchema = (init_data(), __toCommonJS(data_exports).default);
	var uri_1 = require_uri();
	var defaultRegExp = (str, flags) => new RegExp(str, flags);
	defaultRegExp.code = "new RegExp";
	var META_IGNORE_OPTIONS = [
		"removeAdditional",
		"useDefaults",
		"coerceTypes"
	];
	var EXT_SCOPE_NAMES = new Set([
		"validate",
		"serialize",
		"parse",
		"wrapper",
		"root",
		"schema",
		"keyword",
		"pattern",
		"formats",
		"validate$data",
		"func",
		"obj",
		"Error"
	]);
	var removedOptions = {
		errorDataPath: "",
		format: "`validateFormats: false` can be used instead.",
		nullable: "\"nullable\" keyword is supported by default.",
		jsonPointers: "Deprecated jsPropertySyntax can be used instead.",
		extendRefs: "Deprecated ignoreKeywordsWithRef can be used instead.",
		missingRefs: "Pass empty schema with $id that should be ignored to ajv.addSchema.",
		processCode: "Use option `code: {process: (code, schemaEnv: object) => string}`",
		sourceCode: "Use option `code: {source: true}`",
		strictDefaults: "It is default now, see option `strict`.",
		strictKeywords: "It is default now, see option `strict`.",
		uniqueItems: "\"uniqueItems\" keyword is always validated.",
		unknownFormats: "Disable strict mode or pass `true` to `ajv.addFormat` (or `formats` option).",
		cache: "Map is used as cache, schema object as key.",
		serialize: "Map is used as cache, schema object as key.",
		ajvErrors: "It is default now."
	};
	var deprecatedOptions = {
		ignoreKeywordsWithRef: "",
		jsPropertySyntax: "",
		unicode: "\"minLength\"/\"maxLength\" account for unicode characters by default."
	};
	var MAX_EXPRESSION = 200;
	function requiredOptions(o) {
		var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0;
		const s = o.strict;
		const _optz = (_a = o.code) === null || _a === void 0 ? void 0 : _a.optimize;
		const optimize = _optz === true || _optz === void 0 ? 1 : _optz || 0;
		const regExp = (_c = (_b = o.code) === null || _b === void 0 ? void 0 : _b.regExp) !== null && _c !== void 0 ? _c : defaultRegExp;
		const uriResolver = (_d = o.uriResolver) !== null && _d !== void 0 ? _d : uri_1.default;
		return {
			strictSchema: (_f = (_e = o.strictSchema) !== null && _e !== void 0 ? _e : s) !== null && _f !== void 0 ? _f : true,
			strictNumbers: (_h = (_g = o.strictNumbers) !== null && _g !== void 0 ? _g : s) !== null && _h !== void 0 ? _h : true,
			strictTypes: (_k = (_j = o.strictTypes) !== null && _j !== void 0 ? _j : s) !== null && _k !== void 0 ? _k : "log",
			strictTuples: (_m = (_l = o.strictTuples) !== null && _l !== void 0 ? _l : s) !== null && _m !== void 0 ? _m : "log",
			strictRequired: (_p = (_o = o.strictRequired) !== null && _o !== void 0 ? _o : s) !== null && _p !== void 0 ? _p : false,
			code: o.code ? {
				...o.code,
				optimize,
				regExp
			} : {
				optimize,
				regExp
			},
			loopRequired: (_q = o.loopRequired) !== null && _q !== void 0 ? _q : MAX_EXPRESSION,
			loopEnum: (_r = o.loopEnum) !== null && _r !== void 0 ? _r : MAX_EXPRESSION,
			meta: (_s = o.meta) !== null && _s !== void 0 ? _s : true,
			messages: (_t = o.messages) !== null && _t !== void 0 ? _t : true,
			inlineRefs: (_u = o.inlineRefs) !== null && _u !== void 0 ? _u : true,
			schemaId: (_v = o.schemaId) !== null && _v !== void 0 ? _v : "$id",
			addUsedSchema: (_w = o.addUsedSchema) !== null && _w !== void 0 ? _w : true,
			validateSchema: (_x = o.validateSchema) !== null && _x !== void 0 ? _x : true,
			validateFormats: (_y = o.validateFormats) !== null && _y !== void 0 ? _y : true,
			unicodeRegExp: (_z = o.unicodeRegExp) !== null && _z !== void 0 ? _z : true,
			int32range: (_0 = o.int32range) !== null && _0 !== void 0 ? _0 : true,
			uriResolver
		};
	}
	var Ajv = class {
		constructor(opts = {}) {
			this.schemas = {};
			this.refs = {};
			this.formats = Object.create(null);
			this._compilations = /* @__PURE__ */ new Set();
			this._loading = {};
			this._cache = /* @__PURE__ */ new Map();
			opts = this.opts = {
				...opts,
				...requiredOptions(opts)
			};
			const { es5, lines } = this.opts.code;
			this.scope = new codegen_2.ValueScope({
				scope: {},
				prefixes: EXT_SCOPE_NAMES,
				es5,
				lines
			});
			this.logger = getLogger(opts.logger);
			const formatOpt = opts.validateFormats;
			opts.validateFormats = false;
			this.RULES = (0, rules_1.getRules)();
			checkOptions.call(this, removedOptions, opts, "NOT SUPPORTED");
			checkOptions.call(this, deprecatedOptions, opts, "DEPRECATED", "warn");
			this._metaOpts = getMetaSchemaOptions.call(this);
			if (opts.formats) addInitialFormats.call(this);
			this._addVocabularies();
			this._addDefaultMetaSchema();
			if (opts.keywords) addInitialKeywords.call(this, opts.keywords);
			if (typeof opts.meta == "object") this.addMetaSchema(opts.meta);
			addInitialSchemas.call(this);
			opts.validateFormats = formatOpt;
		}
		_addVocabularies() {
			this.addKeyword("$async");
		}
		_addDefaultMetaSchema() {
			const { $data, meta, schemaId } = this.opts;
			let _dataRefSchema = $dataRefSchema;
			if (schemaId === "id") {
				_dataRefSchema = { ...$dataRefSchema };
				_dataRefSchema.id = _dataRefSchema.$id;
				delete _dataRefSchema.$id;
			}
			if (meta && $data) this.addMetaSchema(_dataRefSchema, _dataRefSchema[schemaId], false);
		}
		defaultMeta() {
			const { meta, schemaId } = this.opts;
			return this.opts.defaultMeta = typeof meta == "object" ? meta[schemaId] || meta : void 0;
		}
		validate(schemaKeyRef, data) {
			let v;
			if (typeof schemaKeyRef == "string") {
				v = this.getSchema(schemaKeyRef);
				if (!v) throw new Error(`no schema with key or ref "${schemaKeyRef}"`);
			} else v = this.compile(schemaKeyRef);
			const valid = v(data);
			if (!("$async" in v)) this.errors = v.errors;
			return valid;
		}
		compile(schema, _meta) {
			const sch = this._addSchema(schema, _meta);
			return sch.validate || this._compileSchemaEnv(sch);
		}
		compileAsync(schema, meta) {
			if (typeof this.opts.loadSchema != "function") throw new Error("options.loadSchema should be a function");
			const { loadSchema } = this.opts;
			return runCompileAsync.call(this, schema, meta);
			async function runCompileAsync(_schema, _meta) {
				await loadMetaSchema.call(this, _schema.$schema);
				const sch = this._addSchema(_schema, _meta);
				return sch.validate || _compileAsync.call(this, sch);
			}
			async function loadMetaSchema($ref) {
				if ($ref && !this.getSchema($ref)) await runCompileAsync.call(this, { $ref }, true);
			}
			async function _compileAsync(sch) {
				try {
					return this._compileSchemaEnv(sch);
				} catch (e) {
					if (!(e instanceof ref_error_1.default)) throw e;
					checkLoaded.call(this, e);
					await loadMissingSchema.call(this, e.missingSchema);
					return _compileAsync.call(this, sch);
				}
			}
			function checkLoaded({ missingSchema: ref, missingRef }) {
				if (this.refs[ref]) throw new Error(`AnySchema ${ref} is loaded but ${missingRef} cannot be resolved`);
			}
			async function loadMissingSchema(ref) {
				const _schema = await _loadSchema.call(this, ref);
				if (!this.refs[ref]) await loadMetaSchema.call(this, _schema.$schema);
				if (!this.refs[ref]) this.addSchema(_schema, ref, meta);
			}
			async function _loadSchema(ref) {
				const p = this._loading[ref];
				if (p) return p;
				try {
					return await (this._loading[ref] = loadSchema(ref));
				} finally {
					delete this._loading[ref];
				}
			}
		}
		addSchema(schema, key, _meta, _validateSchema = this.opts.validateSchema) {
			if (Array.isArray(schema)) {
				for (const sch of schema) this.addSchema(sch, void 0, _meta, _validateSchema);
				return this;
			}
			let id;
			if (typeof schema === "object") {
				const { schemaId } = this.opts;
				id = schema[schemaId];
				if (id !== void 0 && typeof id != "string") throw new Error(`schema ${schemaId} must be string`);
			}
			key = (0, resolve_1.normalizeId)(key || id);
			this._checkUnique(key);
			this.schemas[key] = this._addSchema(schema, _meta, key, _validateSchema, true);
			return this;
		}
		addMetaSchema(schema, key, _validateSchema = this.opts.validateSchema) {
			this.addSchema(schema, key, true, _validateSchema);
			return this;
		}
		validateSchema(schema, throwOrLogError) {
			if (typeof schema == "boolean") return true;
			let $schema;
			$schema = schema.$schema;
			if ($schema !== void 0 && typeof $schema != "string") throw new Error("$schema must be a string");
			$schema = $schema || this.opts.defaultMeta || this.defaultMeta();
			if (!$schema) {
				this.logger.warn("meta-schema not available");
				this.errors = null;
				return true;
			}
			const valid = this.validate($schema, schema);
			if (!valid && throwOrLogError) {
				const message = "schema is invalid: " + this.errorsText();
				if (this.opts.validateSchema === "log") this.logger.error(message);
				else throw new Error(message);
			}
			return valid;
		}
		getSchema(keyRef) {
			let sch;
			while (typeof (sch = getSchEnv.call(this, keyRef)) == "string") keyRef = sch;
			if (sch === void 0) {
				const { schemaId } = this.opts;
				const root = new compile_1.SchemaEnv({
					schema: {},
					schemaId
				});
				sch = compile_1.resolveSchema.call(this, root, keyRef);
				if (!sch) return;
				this.refs[keyRef] = sch;
			}
			return sch.validate || this._compileSchemaEnv(sch);
		}
		removeSchema(schemaKeyRef) {
			if (schemaKeyRef instanceof RegExp) {
				this._removeAllSchemas(this.schemas, schemaKeyRef);
				this._removeAllSchemas(this.refs, schemaKeyRef);
				return this;
			}
			switch (typeof schemaKeyRef) {
				case "undefined":
					this._removeAllSchemas(this.schemas);
					this._removeAllSchemas(this.refs);
					this._cache.clear();
					return this;
				case "string": {
					const sch = getSchEnv.call(this, schemaKeyRef);
					if (typeof sch == "object") this._cache.delete(sch.schema);
					delete this.schemas[schemaKeyRef];
					delete this.refs[schemaKeyRef];
					return this;
				}
				case "object": {
					const cacheKey = schemaKeyRef;
					this._cache.delete(cacheKey);
					let id = schemaKeyRef[this.opts.schemaId];
					if (id) {
						id = (0, resolve_1.normalizeId)(id);
						delete this.schemas[id];
						delete this.refs[id];
					}
					return this;
				}
				default: throw new Error("ajv.removeSchema: invalid parameter");
			}
		}
		addVocabulary(definitions) {
			for (const def of definitions) this.addKeyword(def);
			return this;
		}
		addKeyword(kwdOrDef, def) {
			let keyword;
			if (typeof kwdOrDef == "string") {
				keyword = kwdOrDef;
				if (typeof def == "object") {
					this.logger.warn("these parameters are deprecated, see docs for addKeyword");
					def.keyword = keyword;
				}
			} else if (typeof kwdOrDef == "object" && def === void 0) {
				def = kwdOrDef;
				keyword = def.keyword;
				if (Array.isArray(keyword) && !keyword.length) throw new Error("addKeywords: keyword must be string or non-empty array");
			} else throw new Error("invalid addKeywords parameters");
			checkKeyword.call(this, keyword, def);
			if (!def) {
				(0, util_1.eachItem)(keyword, (kwd) => addRule.call(this, kwd));
				return this;
			}
			keywordMetaschema.call(this, def);
			const definition = {
				...def,
				type: (0, dataType_1.getJSONTypes)(def.type),
				schemaType: (0, dataType_1.getJSONTypes)(def.schemaType)
			};
			(0, util_1.eachItem)(keyword, definition.type.length === 0 ? (k) => addRule.call(this, k, definition) : (k) => definition.type.forEach((t) => addRule.call(this, k, definition, t)));
			return this;
		}
		getKeyword(keyword) {
			const rule = this.RULES.all[keyword];
			return typeof rule == "object" ? rule.definition : !!rule;
		}
		removeKeyword(keyword) {
			const { RULES } = this;
			delete RULES.keywords[keyword];
			delete RULES.all[keyword];
			for (const group of RULES.rules) {
				const i = group.rules.findIndex((rule) => rule.keyword === keyword);
				if (i >= 0) group.rules.splice(i, 1);
			}
			return this;
		}
		addFormat(name, format) {
			if (typeof format == "string") format = new RegExp(format);
			this.formats[name] = format;
			return this;
		}
		errorsText(errors = this.errors, { separator = ", ", dataVar = "data" } = {}) {
			if (!errors || errors.length === 0) return "No errors";
			return errors.map((e) => `${dataVar}${e.instancePath} ${e.message}`).reduce((text, msg) => text + separator + msg);
		}
		$dataMetaSchema(metaSchema, keywordsJsonPointers) {
			const rules = this.RULES.all;
			metaSchema = JSON.parse(JSON.stringify(metaSchema));
			for (const jsonPointer of keywordsJsonPointers) {
				const segments = jsonPointer.split("/").slice(1);
				let keywords = metaSchema;
				for (const seg of segments) keywords = keywords[seg];
				for (const key in rules) {
					const rule = rules[key];
					if (typeof rule != "object") continue;
					const { $data } = rule.definition;
					const schema = keywords[key];
					if ($data && schema) keywords[key] = schemaOrData(schema);
				}
			}
			return metaSchema;
		}
		_removeAllSchemas(schemas, regex) {
			for (const keyRef in schemas) {
				const sch = schemas[keyRef];
				if (!regex || regex.test(keyRef)) {
					if (typeof sch == "string") delete schemas[keyRef];
					else if (sch && !sch.meta) {
						this._cache.delete(sch.schema);
						delete schemas[keyRef];
					}
				}
			}
		}
		_addSchema(schema, meta, baseId, validateSchema = this.opts.validateSchema, addSchema = this.opts.addUsedSchema) {
			let id;
			const { schemaId } = this.opts;
			if (typeof schema == "object") id = schema[schemaId];
			else if (this.opts.jtd) throw new Error("schema must be object");
			else if (typeof schema != "boolean") throw new Error("schema must be object or boolean");
			let sch = this._cache.get(schema);
			if (sch !== void 0) return sch;
			baseId = (0, resolve_1.normalizeId)(id || baseId);
			const localRefs = resolve_1.getSchemaRefs.call(this, schema, baseId);
			sch = new compile_1.SchemaEnv({
				schema,
				schemaId,
				meta,
				baseId,
				localRefs
			});
			this._cache.set(sch.schema, sch);
			if (addSchema && !baseId.startsWith("#")) {
				if (baseId) this._checkUnique(baseId);
				this.refs[baseId] = sch;
			}
			if (validateSchema) this.validateSchema(schema, true);
			return sch;
		}
		_checkUnique(id) {
			if (this.schemas[id] || this.refs[id]) throw new Error(`schema with key or id "${id}" already exists`);
		}
		_compileSchemaEnv(sch) {
			if (sch.meta) this._compileMetaSchema(sch);
			else compile_1.compileSchema.call(this, sch);
			/* istanbul ignore if */
			if (!sch.validate) throw new Error("ajv implementation error");
			return sch.validate;
		}
		_compileMetaSchema(sch) {
			const currentOpts = this.opts;
			this.opts = this._metaOpts;
			try {
				compile_1.compileSchema.call(this, sch);
			} finally {
				this.opts = currentOpts;
			}
		}
	};
	Ajv.ValidationError = validation_error_1.default;
	Ajv.MissingRefError = ref_error_1.default;
	exports.default = Ajv;
	function checkOptions(checkOpts, options, msg, log = "error") {
		for (const key in checkOpts) {
			const opt = key;
			if (opt in options) this.logger[log](`${msg}: option ${key}. ${checkOpts[opt]}`);
		}
	}
	function getSchEnv(keyRef) {
		keyRef = (0, resolve_1.normalizeId)(keyRef);
		return this.schemas[keyRef] || this.refs[keyRef];
	}
	function addInitialSchemas() {
		const optsSchemas = this.opts.schemas;
		if (!optsSchemas) return;
		if (Array.isArray(optsSchemas)) this.addSchema(optsSchemas);
		else for (const key in optsSchemas) this.addSchema(optsSchemas[key], key);
	}
	function addInitialFormats() {
		for (const name in this.opts.formats) {
			const format = this.opts.formats[name];
			if (format) this.addFormat(name, format);
		}
	}
	function addInitialKeywords(defs) {
		if (Array.isArray(defs)) {
			this.addVocabulary(defs);
			return;
		}
		this.logger.warn("keywords option as map is deprecated, pass array");
		for (const keyword in defs) {
			const def = defs[keyword];
			if (!def.keyword) def.keyword = keyword;
			this.addKeyword(def);
		}
	}
	function getMetaSchemaOptions() {
		const metaOpts = { ...this.opts };
		for (const opt of META_IGNORE_OPTIONS) delete metaOpts[opt];
		return metaOpts;
	}
	var noLogs = {
		log() {},
		warn() {},
		error() {}
	};
	function getLogger(logger) {
		if (logger === false) return noLogs;
		if (logger === void 0) return console;
		if (logger.log && logger.warn && logger.error) return logger;
		throw new Error("logger must implement log, warn and error methods");
	}
	var KEYWORD_NAME = /^[a-z_$][a-z0-9_$:-]*$/i;
	function checkKeyword(keyword, def) {
		const { RULES } = this;
		(0, util_1.eachItem)(keyword, (kwd) => {
			if (RULES.keywords[kwd]) throw new Error(`Keyword ${kwd} is already defined`);
			if (!KEYWORD_NAME.test(kwd)) throw new Error(`Keyword ${kwd} has invalid name`);
		});
		if (!def) return;
		if (def.$data && !("code" in def || "validate" in def)) throw new Error("$data keyword must have \"code\" or \"validate\" function");
	}
	function addRule(keyword, definition, dataType) {
		var _a;
		const post = definition === null || definition === void 0 ? void 0 : definition.post;
		if (dataType && post) throw new Error("keyword with \"post\" flag cannot have \"type\"");
		const { RULES } = this;
		let ruleGroup = post ? RULES.post : RULES.rules.find(({ type: t }) => t === dataType);
		if (!ruleGroup) {
			ruleGroup = {
				type: dataType,
				rules: []
			};
			RULES.rules.push(ruleGroup);
		}
		RULES.keywords[keyword] = true;
		if (!definition) return;
		const rule = {
			keyword,
			definition: {
				...definition,
				type: (0, dataType_1.getJSONTypes)(definition.type),
				schemaType: (0, dataType_1.getJSONTypes)(definition.schemaType)
			}
		};
		if (definition.before) addBeforeRule.call(this, ruleGroup, rule, definition.before);
		else ruleGroup.rules.push(rule);
		RULES.all[keyword] = rule;
		(_a = definition.implements) === null || _a === void 0 || _a.forEach((kwd) => this.addKeyword(kwd));
	}
	function addBeforeRule(ruleGroup, rule, before) {
		const i = ruleGroup.rules.findIndex((_rule) => _rule.keyword === before);
		if (i >= 0) ruleGroup.rules.splice(i, 0, rule);
		else {
			ruleGroup.rules.push(rule);
			this.logger.warn(`rule ${before} is not defined`);
		}
	}
	function keywordMetaschema(def) {
		let { metaSchema } = def;
		if (metaSchema === void 0) return;
		if (def.$data && this.opts.$data) metaSchema = schemaOrData(metaSchema);
		def.validateSchema = this.compile(metaSchema, true);
	}
	var $dataRef = { $ref: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#" };
	function schemaOrData(schema) {
		return { anyOf: [schema, $dataRef] };
	}
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/core/id.js
var require_id = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = {
		keyword: "id",
		code() {
			throw new Error("NOT SUPPORTED: keyword \"id\", use \"$id\" for schema ID");
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/core/ref.js
var require_ref = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.callRef = exports.getValidate = void 0;
	var ref_error_1 = require_ref_error();
	var code_1 = require_code();
	var codegen_1 = require_codegen();
	var names_1 = require_names();
	var compile_1 = require_compile();
	var util_1 = require_util();
	var def = {
		keyword: "$ref",
		schemaType: "string",
		code(cxt) {
			const { gen, schema: $ref, it } = cxt;
			const { baseId, schemaEnv: env, validateName, opts, self } = it;
			const { root } = env;
			if (($ref === "#" || $ref === "#/") && baseId === root.baseId) return callRootRef();
			const schOrEnv = compile_1.resolveRef.call(self, root, baseId, $ref);
			if (schOrEnv === void 0) throw new ref_error_1.default(it.opts.uriResolver, baseId, $ref);
			if (schOrEnv instanceof compile_1.SchemaEnv) return callValidate(schOrEnv);
			return inlineRefSchema(schOrEnv);
			function callRootRef() {
				if (env === root) return callRef(cxt, validateName, env, env.$async);
				const rootName = gen.scopeValue("root", { ref: root });
				return callRef(cxt, (0, codegen_1._)`${rootName}.validate`, root, root.$async);
			}
			function callValidate(sch) {
				callRef(cxt, getValidate(cxt, sch), sch, sch.$async);
			}
			function inlineRefSchema(sch) {
				const schName = gen.scopeValue("schema", opts.code.source === true ? {
					ref: sch,
					code: (0, codegen_1.stringify)(sch)
				} : { ref: sch });
				const valid = gen.name("valid");
				const schCxt = cxt.subschema({
					schema: sch,
					dataTypes: [],
					schemaPath: codegen_1.nil,
					topSchemaRef: schName,
					errSchemaPath: $ref
				}, valid);
				cxt.mergeEvaluated(schCxt);
				cxt.ok(valid);
			}
		}
	};
	function getValidate(cxt, sch) {
		const { gen } = cxt;
		return sch.validate ? gen.scopeValue("validate", { ref: sch.validate }) : (0, codegen_1._)`${gen.scopeValue("wrapper", { ref: sch })}.validate`;
	}
	exports.getValidate = getValidate;
	function callRef(cxt, v, sch, $async) {
		const { gen, it } = cxt;
		const { allErrors, schemaEnv: env, opts } = it;
		const passCxt = opts.passContext ? names_1.default.this : codegen_1.nil;
		if ($async) callAsyncRef();
		else callSyncRef();
		function callAsyncRef() {
			if (!env.$async) throw new Error("async schema referenced by sync schema");
			const valid = gen.let("valid");
			gen.try(() => {
				gen.code((0, codegen_1._)`await ${(0, code_1.callValidateCode)(cxt, v, passCxt)}`);
				addEvaluatedFrom(v);
				if (!allErrors) gen.assign(valid, true);
			}, (e) => {
				gen.if((0, codegen_1._)`!(${e} instanceof ${it.ValidationError})`, () => gen.throw(e));
				addErrorsFrom(e);
				if (!allErrors) gen.assign(valid, false);
			});
			cxt.ok(valid);
		}
		function callSyncRef() {
			cxt.result((0, code_1.callValidateCode)(cxt, v, passCxt), () => addEvaluatedFrom(v), () => addErrorsFrom(v));
		}
		function addErrorsFrom(source) {
			const errs = (0, codegen_1._)`${source}.errors`;
			gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`);
			gen.assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
		}
		function addEvaluatedFrom(source) {
			var _a;
			if (!it.opts.unevaluated) return;
			const schEvaluated = (_a = sch === null || sch === void 0 ? void 0 : sch.validate) === null || _a === void 0 ? void 0 : _a.evaluated;
			if (it.props !== true) if (schEvaluated && !schEvaluated.dynamicProps) {
				if (schEvaluated.props !== void 0) it.props = util_1.mergeEvaluated.props(gen, schEvaluated.props, it.props);
			} else {
				const props = gen.var("props", (0, codegen_1._)`${source}.evaluated.props`);
				it.props = util_1.mergeEvaluated.props(gen, props, it.props, codegen_1.Name);
			}
			if (it.items !== true) if (schEvaluated && !schEvaluated.dynamicItems) {
				if (schEvaluated.items !== void 0) it.items = util_1.mergeEvaluated.items(gen, schEvaluated.items, it.items);
			} else {
				const items = gen.var("items", (0, codegen_1._)`${source}.evaluated.items`);
				it.items = util_1.mergeEvaluated.items(gen, items, it.items, codegen_1.Name);
			}
		}
	}
	exports.callRef = callRef;
	exports.default = def;
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/core/index.js
var require_core = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var id_1 = require_id();
	var ref_1 = require_ref();
	exports.default = [
		"$schema",
		"$id",
		"$defs",
		"$vocabulary",
		{ keyword: "$comment" },
		"definitions",
		id_1.default,
		ref_1.default
	];
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/validation/limitNumber.js
var require_limitNumber = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	var ops = codegen_1.operators;
	var KWDs = {
		maximum: {
			okStr: "<=",
			ok: ops.LTE,
			fail: ops.GT
		},
		minimum: {
			okStr: ">=",
			ok: ops.GTE,
			fail: ops.LT
		},
		exclusiveMaximum: {
			okStr: "<",
			ok: ops.LT,
			fail: ops.GTE
		},
		exclusiveMinimum: {
			okStr: ">",
			ok: ops.GT,
			fail: ops.LTE
		}
	};
	exports.default = {
		keyword: Object.keys(KWDs),
		type: "number",
		schemaType: "number",
		$data: true,
		error: {
			message: ({ keyword, schemaCode }) => (0, codegen_1.str)`must be ${KWDs[keyword].okStr} ${schemaCode}`,
			params: ({ keyword, schemaCode }) => (0, codegen_1._)`{comparison: ${KWDs[keyword].okStr}, limit: ${schemaCode}}`
		},
		code(cxt) {
			const { keyword, data, schemaCode } = cxt;
			cxt.fail$data((0, codegen_1._)`${data} ${KWDs[keyword].fail} ${schemaCode} || isNaN(${data})`);
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/validation/multipleOf.js
var require_multipleOf = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	exports.default = {
		keyword: "multipleOf",
		type: "number",
		schemaType: "number",
		$data: true,
		error: {
			message: ({ schemaCode }) => (0, codegen_1.str)`must be multiple of ${schemaCode}`,
			params: ({ schemaCode }) => (0, codegen_1._)`{multipleOf: ${schemaCode}}`
		},
		code(cxt) {
			const { gen, data, schemaCode, it } = cxt;
			const prec = it.opts.multipleOfPrecision;
			const res = gen.let("res");
			const invalid = prec ? (0, codegen_1._)`Math.abs(Math.round(${res}) - ${res}) > 1e-${prec}` : (0, codegen_1._)`${res} !== parseInt(${res})`;
			cxt.fail$data((0, codegen_1._)`(${schemaCode} === 0 || (${res} = ${data}/${schemaCode}, ${invalid}))`);
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/runtime/ucs2length.js
var require_ucs2length = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	function ucs2length(str) {
		const len = str.length;
		let length = 0;
		let pos = 0;
		let value;
		while (pos < len) {
			length++;
			value = str.charCodeAt(pos++);
			if (value >= 55296 && value <= 56319 && pos < len) {
				value = str.charCodeAt(pos);
				if ((value & 64512) === 56320) pos++;
			}
		}
		return length;
	}
	exports.default = ucs2length;
	ucs2length.code = "require(\"ajv/dist/runtime/ucs2length\").default";
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/validation/limitLength.js
var require_limitLength = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	var ucs2length_1 = require_ucs2length();
	exports.default = {
		keyword: ["maxLength", "minLength"],
		type: "string",
		schemaType: "number",
		$data: true,
		error: {
			message({ keyword, schemaCode }) {
				const comp = keyword === "maxLength" ? "more" : "fewer";
				return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} characters`;
			},
			params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
		},
		code(cxt) {
			const { keyword, data, schemaCode, it } = cxt;
			const op = keyword === "maxLength" ? codegen_1.operators.GT : codegen_1.operators.LT;
			const len = it.opts.unicode === false ? (0, codegen_1._)`${data}.length` : (0, codegen_1._)`${(0, util_1.useFunc)(cxt.gen, ucs2length_1.default)}(${data})`;
			cxt.fail$data((0, codegen_1._)`${len} ${op} ${schemaCode}`);
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/validation/pattern.js
var require_pattern = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var code_1 = require_code();
	var util_1 = require_util();
	var codegen_1 = require_codegen();
	exports.default = {
		keyword: "pattern",
		type: "string",
		schemaType: "string",
		$data: true,
		error: {
			message: ({ schemaCode }) => (0, codegen_1.str)`must match pattern "${schemaCode}"`,
			params: ({ schemaCode }) => (0, codegen_1._)`{pattern: ${schemaCode}}`
		},
		code(cxt) {
			const { gen, data, $data, schema, schemaCode, it } = cxt;
			const u = it.opts.unicodeRegExp ? "u" : "";
			if ($data) {
				const { regExp } = it.opts.code;
				const regExpCode = regExp.code === "new RegExp" ? (0, codegen_1._)`new RegExp` : (0, util_1.useFunc)(gen, regExp);
				const valid = gen.let("valid");
				gen.try(() => gen.assign(valid, (0, codegen_1._)`${regExpCode}(${schemaCode}, ${u}).test(${data})`), () => gen.assign(valid, false));
				cxt.fail$data((0, codegen_1._)`!${valid}`);
			} else {
				const regExp = (0, code_1.usePattern)(cxt, schema);
				cxt.fail$data((0, codegen_1._)`!${regExp}.test(${data})`);
			}
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/validation/limitProperties.js
var require_limitProperties = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	exports.default = {
		keyword: ["maxProperties", "minProperties"],
		type: "object",
		schemaType: "number",
		$data: true,
		error: {
			message({ keyword, schemaCode }) {
				const comp = keyword === "maxProperties" ? "more" : "fewer";
				return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} properties`;
			},
			params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
		},
		code(cxt) {
			const { keyword, data, schemaCode } = cxt;
			const op = keyword === "maxProperties" ? codegen_1.operators.GT : codegen_1.operators.LT;
			cxt.fail$data((0, codegen_1._)`Object.keys(${data}).length ${op} ${schemaCode}`);
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/validation/required.js
var require_required = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var code_1 = require_code();
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	exports.default = {
		keyword: "required",
		type: "object",
		schemaType: "array",
		$data: true,
		error: {
			message: ({ params: { missingProperty } }) => (0, codegen_1.str)`must have required property '${missingProperty}'`,
			params: ({ params: { missingProperty } }) => (0, codegen_1._)`{missingProperty: ${missingProperty}}`
		},
		code(cxt) {
			const { gen, schema, schemaCode, data, $data, it } = cxt;
			const { opts } = it;
			if (!$data && schema.length === 0) return;
			const useLoop = schema.length >= opts.loopRequired;
			if (it.allErrors) allErrorsMode();
			else exitOnErrorMode();
			if (opts.strictRequired) {
				const props = cxt.parentSchema.properties;
				const { definedProperties } = cxt.it;
				for (const requiredKey of schema) if ((props === null || props === void 0 ? void 0 : props[requiredKey]) === void 0 && !definedProperties.has(requiredKey)) {
					const msg = `required property "${requiredKey}" is not defined at "${it.schemaEnv.baseId + it.errSchemaPath}" (strictRequired)`;
					(0, util_1.checkStrictMode)(it, msg, it.opts.strictRequired);
				}
			}
			function allErrorsMode() {
				if (useLoop || $data) cxt.block$data(codegen_1.nil, loopAllRequired);
				else for (const prop of schema) (0, code_1.checkReportMissingProp)(cxt, prop);
			}
			function exitOnErrorMode() {
				const missing = gen.let("missing");
				if (useLoop || $data) {
					const valid = gen.let("valid", true);
					cxt.block$data(valid, () => loopUntilMissing(missing, valid));
					cxt.ok(valid);
				} else {
					gen.if((0, code_1.checkMissingProp)(cxt, schema, missing));
					(0, code_1.reportMissingProp)(cxt, missing);
					gen.else();
				}
			}
			function loopAllRequired() {
				gen.forOf("prop", schemaCode, (prop) => {
					cxt.setParams({ missingProperty: prop });
					gen.if((0, code_1.noPropertyInData)(gen, data, prop, opts.ownProperties), () => cxt.error());
				});
			}
			function loopUntilMissing(missing, valid) {
				cxt.setParams({ missingProperty: missing });
				gen.forOf(missing, schemaCode, () => {
					gen.assign(valid, (0, code_1.propertyInData)(gen, data, missing, opts.ownProperties));
					gen.if((0, codegen_1.not)(valid), () => {
						cxt.error();
						gen.break();
					});
				}, codegen_1.nil);
			}
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/validation/limitItems.js
var require_limitItems = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	exports.default = {
		keyword: ["maxItems", "minItems"],
		type: "array",
		schemaType: "number",
		$data: true,
		error: {
			message({ keyword, schemaCode }) {
				const comp = keyword === "maxItems" ? "more" : "fewer";
				return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} items`;
			},
			params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
		},
		code(cxt) {
			const { keyword, data, schemaCode } = cxt;
			const op = keyword === "maxItems" ? codegen_1.operators.GT : codegen_1.operators.LT;
			cxt.fail$data((0, codegen_1._)`${data}.length ${op} ${schemaCode}`);
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/runtime/equal.js
var require_equal = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var equal = require_fast_deep_equal();
	equal.code = "require(\"ajv/dist/runtime/equal\").default";
	exports.default = equal;
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/validation/uniqueItems.js
var require_uniqueItems = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var dataType_1 = require_dataType();
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	var equal_1 = require_equal();
	exports.default = {
		keyword: "uniqueItems",
		type: "array",
		schemaType: "boolean",
		$data: true,
		error: {
			message: ({ params: { i, j } }) => (0, codegen_1.str)`must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
			params: ({ params: { i, j } }) => (0, codegen_1._)`{i: ${i}, j: ${j}}`
		},
		code(cxt) {
			const { gen, data, $data, schema, parentSchema, schemaCode, it } = cxt;
			if (!$data && !schema) return;
			const valid = gen.let("valid");
			const itemTypes = parentSchema.items ? (0, dataType_1.getSchemaTypes)(parentSchema.items) : [];
			cxt.block$data(valid, validateUniqueItems, (0, codegen_1._)`${schemaCode} === false`);
			cxt.ok(valid);
			function validateUniqueItems() {
				const i = gen.let("i", (0, codegen_1._)`${data}.length`);
				const j = gen.let("j");
				cxt.setParams({
					i,
					j
				});
				gen.assign(valid, true);
				gen.if((0, codegen_1._)`${i} > 1`, () => (canOptimize() ? loopN : loopN2)(i, j));
			}
			function canOptimize() {
				return itemTypes.length > 0 && !itemTypes.some((t) => t === "object" || t === "array");
			}
			function loopN(i, j) {
				const item = gen.name("item");
				const wrongType = (0, dataType_1.checkDataTypes)(itemTypes, item, it.opts.strictNumbers, dataType_1.DataType.Wrong);
				const indices = gen.const("indices", (0, codegen_1._)`{}`);
				gen.for((0, codegen_1._)`;${i}--;`, () => {
					gen.let(item, (0, codegen_1._)`${data}[${i}]`);
					gen.if(wrongType, (0, codegen_1._)`continue`);
					if (itemTypes.length > 1) gen.if((0, codegen_1._)`typeof ${item} == "string"`, (0, codegen_1._)`${item} += "_"`);
					gen.if((0, codegen_1._)`typeof ${indices}[${item}] == "number"`, () => {
						gen.assign(j, (0, codegen_1._)`${indices}[${item}]`);
						cxt.error();
						gen.assign(valid, false).break();
					}).code((0, codegen_1._)`${indices}[${item}] = ${i}`);
				});
			}
			function loopN2(i, j) {
				const eql = (0, util_1.useFunc)(gen, equal_1.default);
				const outer = gen.name("outer");
				gen.label(outer).for((0, codegen_1._)`;${i}--;`, () => gen.for((0, codegen_1._)`${j} = ${i}; ${j}--;`, () => gen.if((0, codegen_1._)`${eql}(${data}[${i}], ${data}[${j}])`, () => {
					cxt.error();
					gen.assign(valid, false).break(outer);
				})));
			}
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/validation/const.js
var require_const = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	var equal_1 = require_equal();
	exports.default = {
		keyword: "const",
		$data: true,
		error: {
			message: "must be equal to constant",
			params: ({ schemaCode }) => (0, codegen_1._)`{allowedValue: ${schemaCode}}`
		},
		code(cxt) {
			const { gen, data, $data, schemaCode, schema } = cxt;
			if ($data || schema && typeof schema == "object") cxt.fail$data((0, codegen_1._)`!${(0, util_1.useFunc)(gen, equal_1.default)}(${data}, ${schemaCode})`);
			else cxt.fail((0, codegen_1._)`${schema} !== ${data}`);
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/validation/enum.js
var require_enum = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	var equal_1 = require_equal();
	exports.default = {
		keyword: "enum",
		schemaType: "array",
		$data: true,
		error: {
			message: "must be equal to one of the allowed values",
			params: ({ schemaCode }) => (0, codegen_1._)`{allowedValues: ${schemaCode}}`
		},
		code(cxt) {
			const { gen, data, $data, schema, schemaCode, it } = cxt;
			if (!$data && schema.length === 0) throw new Error("enum must have non-empty array");
			const useLoop = schema.length >= it.opts.loopEnum;
			let eql;
			const getEql = () => eql !== null && eql !== void 0 ? eql : eql = (0, util_1.useFunc)(gen, equal_1.default);
			let valid;
			if (useLoop || $data) {
				valid = gen.let("valid");
				cxt.block$data(valid, loopEnum);
			} else {
				/* istanbul ignore if */
				if (!Array.isArray(schema)) throw new Error("ajv implementation error");
				const vSchema = gen.const("vSchema", schemaCode);
				valid = (0, codegen_1.or)(...schema.map((_x, i) => equalCode(vSchema, i)));
			}
			cxt.pass(valid);
			function loopEnum() {
				gen.assign(valid, false);
				gen.forOf("v", schemaCode, (v) => gen.if((0, codegen_1._)`${getEql()}(${data}, ${v})`, () => gen.assign(valid, true).break()));
			}
			function equalCode(vSchema, i) {
				const sch = schema[i];
				return typeof sch === "object" && sch !== null ? (0, codegen_1._)`${getEql()}(${data}, ${vSchema}[${i}])` : (0, codegen_1._)`${data} === ${sch}`;
			}
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/validation/index.js
var require_validation = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var limitNumber_1 = require_limitNumber();
	var multipleOf_1 = require_multipleOf();
	var limitLength_1 = require_limitLength();
	var pattern_1 = require_pattern();
	var limitProperties_1 = require_limitProperties();
	var required_1 = require_required();
	var limitItems_1 = require_limitItems();
	var uniqueItems_1 = require_uniqueItems();
	var const_1 = require_const();
	var enum_1 = require_enum();
	exports.default = [
		limitNumber_1.default,
		multipleOf_1.default,
		limitLength_1.default,
		pattern_1.default,
		limitProperties_1.default,
		required_1.default,
		limitItems_1.default,
		uniqueItems_1.default,
		{
			keyword: "type",
			schemaType: ["string", "array"]
		},
		{
			keyword: "nullable",
			schemaType: "boolean"
		},
		const_1.default,
		enum_1.default
	];
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/additionalItems.js
var require_additionalItems = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.validateAdditionalItems = void 0;
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	var def = {
		keyword: "additionalItems",
		type: "array",
		schemaType: ["boolean", "object"],
		before: "uniqueItems",
		error: {
			message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
			params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
		},
		code(cxt) {
			const { parentSchema, it } = cxt;
			const { items } = parentSchema;
			if (!Array.isArray(items)) {
				(0, util_1.checkStrictMode)(it, "\"additionalItems\" is ignored when \"items\" is not an array of schemas");
				return;
			}
			validateAdditionalItems(cxt, items);
		}
	};
	function validateAdditionalItems(cxt, items) {
		const { gen, schema, data, keyword, it } = cxt;
		it.items = true;
		const len = gen.const("len", (0, codegen_1._)`${data}.length`);
		if (schema === false) {
			cxt.setParams({ len: items.length });
			cxt.pass((0, codegen_1._)`${len} <= ${items.length}`);
		} else if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
			const valid = gen.var("valid", (0, codegen_1._)`${len} <= ${items.length}`);
			gen.if((0, codegen_1.not)(valid), () => validateItems(valid));
			cxt.ok(valid);
		}
		function validateItems(valid) {
			gen.forRange("i", items.length, len, (i) => {
				cxt.subschema({
					keyword,
					dataProp: i,
					dataPropType: util_1.Type.Num
				}, valid);
				if (!it.allErrors) gen.if((0, codegen_1.not)(valid), () => gen.break());
			});
		}
	}
	exports.validateAdditionalItems = validateAdditionalItems;
	exports.default = def;
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/items.js
var require_items = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.validateTuple = void 0;
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	var code_1 = require_code();
	var def = {
		keyword: "items",
		type: "array",
		schemaType: [
			"object",
			"array",
			"boolean"
		],
		before: "uniqueItems",
		code(cxt) {
			const { schema, it } = cxt;
			if (Array.isArray(schema)) return validateTuple(cxt, "additionalItems", schema);
			it.items = true;
			if ((0, util_1.alwaysValidSchema)(it, schema)) return;
			cxt.ok((0, code_1.validateArray)(cxt));
		}
	};
	function validateTuple(cxt, extraItems, schArr = cxt.schema) {
		const { gen, parentSchema, data, keyword, it } = cxt;
		checkStrictTuple(parentSchema);
		if (it.opts.unevaluated && schArr.length && it.items !== true) it.items = util_1.mergeEvaluated.items(gen, schArr.length, it.items);
		const valid = gen.name("valid");
		const len = gen.const("len", (0, codegen_1._)`${data}.length`);
		schArr.forEach((sch, i) => {
			if ((0, util_1.alwaysValidSchema)(it, sch)) return;
			gen.if((0, codegen_1._)`${len} > ${i}`, () => cxt.subschema({
				keyword,
				schemaProp: i,
				dataProp: i
			}, valid));
			cxt.ok(valid);
		});
		function checkStrictTuple(sch) {
			const { opts, errSchemaPath } = it;
			const l = schArr.length;
			const fullTuple = l === sch.minItems && (l === sch.maxItems || sch[extraItems] === false);
			if (opts.strictTuples && !fullTuple) {
				const msg = `"${keyword}" is ${l}-tuple, but minItems or maxItems/${extraItems} are not specified or different at path "${errSchemaPath}"`;
				(0, util_1.checkStrictMode)(it, msg, opts.strictTuples);
			}
		}
	}
	exports.validateTuple = validateTuple;
	exports.default = def;
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/prefixItems.js
var require_prefixItems = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var items_1 = require_items();
	exports.default = {
		keyword: "prefixItems",
		type: "array",
		schemaType: ["array"],
		before: "uniqueItems",
		code: (cxt) => (0, items_1.validateTuple)(cxt, "items")
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/items2020.js
var require_items2020 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	var code_1 = require_code();
	var additionalItems_1 = require_additionalItems();
	exports.default = {
		keyword: "items",
		type: "array",
		schemaType: ["object", "boolean"],
		before: "uniqueItems",
		error: {
			message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
			params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
		},
		code(cxt) {
			const { schema, parentSchema, it } = cxt;
			const { prefixItems } = parentSchema;
			it.items = true;
			if ((0, util_1.alwaysValidSchema)(it, schema)) return;
			if (prefixItems) (0, additionalItems_1.validateAdditionalItems)(cxt, prefixItems);
			else cxt.ok((0, code_1.validateArray)(cxt));
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/contains.js
var require_contains = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	exports.default = {
		keyword: "contains",
		type: "array",
		schemaType: ["object", "boolean"],
		before: "uniqueItems",
		trackErrors: true,
		error: {
			message: ({ params: { min, max } }) => max === void 0 ? (0, codegen_1.str)`must contain at least ${min} valid item(s)` : (0, codegen_1.str)`must contain at least ${min} and no more than ${max} valid item(s)`,
			params: ({ params: { min, max } }) => max === void 0 ? (0, codegen_1._)`{minContains: ${min}}` : (0, codegen_1._)`{minContains: ${min}, maxContains: ${max}}`
		},
		code(cxt) {
			const { gen, schema, parentSchema, data, it } = cxt;
			let min;
			let max;
			const { minContains, maxContains } = parentSchema;
			if (it.opts.next) {
				min = minContains === void 0 ? 1 : minContains;
				max = maxContains;
			} else min = 1;
			const len = gen.const("len", (0, codegen_1._)`${data}.length`);
			cxt.setParams({
				min,
				max
			});
			if (max === void 0 && min === 0) {
				(0, util_1.checkStrictMode)(it, `"minContains" == 0 without "maxContains": "contains" keyword ignored`);
				return;
			}
			if (max !== void 0 && min > max) {
				(0, util_1.checkStrictMode)(it, `"minContains" > "maxContains" is always invalid`);
				cxt.fail();
				return;
			}
			if ((0, util_1.alwaysValidSchema)(it, schema)) {
				let cond = (0, codegen_1._)`${len} >= ${min}`;
				if (max !== void 0) cond = (0, codegen_1._)`${cond} && ${len} <= ${max}`;
				cxt.pass(cond);
				return;
			}
			it.items = true;
			const valid = gen.name("valid");
			if (max === void 0 && min === 1) validateItems(valid, () => gen.if(valid, () => gen.break()));
			else if (min === 0) {
				gen.let(valid, true);
				if (max !== void 0) gen.if((0, codegen_1._)`${data}.length > 0`, validateItemsWithCount);
			} else {
				gen.let(valid, false);
				validateItemsWithCount();
			}
			cxt.result(valid, () => cxt.reset());
			function validateItemsWithCount() {
				const schValid = gen.name("_valid");
				const count = gen.let("count", 0);
				validateItems(schValid, () => gen.if(schValid, () => checkLimits(count)));
			}
			function validateItems(_valid, block) {
				gen.forRange("i", 0, len, (i) => {
					cxt.subschema({
						keyword: "contains",
						dataProp: i,
						dataPropType: util_1.Type.Num,
						compositeRule: true
					}, _valid);
					block();
				});
			}
			function checkLimits(count) {
				gen.code((0, codegen_1._)`${count}++`);
				if (max === void 0) gen.if((0, codegen_1._)`${count} >= ${min}`, () => gen.assign(valid, true).break());
				else {
					gen.if((0, codegen_1._)`${count} > ${max}`, () => gen.assign(valid, false).break());
					if (min === 1) gen.assign(valid, true);
					else gen.if((0, codegen_1._)`${count} >= ${min}`, () => gen.assign(valid, true));
				}
			}
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/dependencies.js
var require_dependencies = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.validateSchemaDeps = exports.validatePropertyDeps = exports.error = void 0;
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	var code_1 = require_code();
	exports.error = {
		message: ({ params: { property, depsCount, deps } }) => {
			const property_ies = depsCount === 1 ? "property" : "properties";
			return (0, codegen_1.str)`must have ${property_ies} ${deps} when property ${property} is present`;
		},
		params: ({ params: { property, depsCount, deps, missingProperty } }) => (0, codegen_1._)`{property: ${property},
    missingProperty: ${missingProperty},
    depsCount: ${depsCount},
    deps: ${deps}}`
	};
	var def = {
		keyword: "dependencies",
		type: "object",
		schemaType: "object",
		error: exports.error,
		code(cxt) {
			const [propDeps, schDeps] = splitDependencies(cxt);
			validatePropertyDeps(cxt, propDeps);
			validateSchemaDeps(cxt, schDeps);
		}
	};
	function splitDependencies({ schema }) {
		const propertyDeps = {};
		const schemaDeps = {};
		for (const key in schema) {
			if (key === "__proto__") continue;
			const deps = Array.isArray(schema[key]) ? propertyDeps : schemaDeps;
			deps[key] = schema[key];
		}
		return [propertyDeps, schemaDeps];
	}
	function validatePropertyDeps(cxt, propertyDeps = cxt.schema) {
		const { gen, data, it } = cxt;
		if (Object.keys(propertyDeps).length === 0) return;
		const missing = gen.let("missing");
		for (const prop in propertyDeps) {
			const deps = propertyDeps[prop];
			if (deps.length === 0) continue;
			const hasProperty = (0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties);
			cxt.setParams({
				property: prop,
				depsCount: deps.length,
				deps: deps.join(", ")
			});
			if (it.allErrors) gen.if(hasProperty, () => {
				for (const depProp of deps) (0, code_1.checkReportMissingProp)(cxt, depProp);
			});
			else {
				gen.if((0, codegen_1._)`${hasProperty} && (${(0, code_1.checkMissingProp)(cxt, deps, missing)})`);
				(0, code_1.reportMissingProp)(cxt, missing);
				gen.else();
			}
		}
	}
	exports.validatePropertyDeps = validatePropertyDeps;
	function validateSchemaDeps(cxt, schemaDeps = cxt.schema) {
		const { gen, data, keyword, it } = cxt;
		const valid = gen.name("valid");
		for (const prop in schemaDeps) {
			if ((0, util_1.alwaysValidSchema)(it, schemaDeps[prop])) continue;
			gen.if((0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties), () => {
				const schCxt = cxt.subschema({
					keyword,
					schemaProp: prop
				}, valid);
				cxt.mergeValidEvaluated(schCxt, valid);
			}, () => gen.var(valid, true));
			cxt.ok(valid);
		}
	}
	exports.validateSchemaDeps = validateSchemaDeps;
	exports.default = def;
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/propertyNames.js
var require_propertyNames = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	exports.default = {
		keyword: "propertyNames",
		type: "object",
		schemaType: ["object", "boolean"],
		error: {
			message: "property name must be valid",
			params: ({ params }) => (0, codegen_1._)`{propertyName: ${params.propertyName}}`
		},
		code(cxt) {
			const { gen, schema, data, it } = cxt;
			if ((0, util_1.alwaysValidSchema)(it, schema)) return;
			const valid = gen.name("valid");
			gen.forIn("key", data, (key) => {
				cxt.setParams({ propertyName: key });
				cxt.subschema({
					keyword: "propertyNames",
					data: key,
					dataTypes: ["string"],
					propertyName: key,
					compositeRule: true
				}, valid);
				gen.if((0, codegen_1.not)(valid), () => {
					cxt.error(true);
					if (!it.allErrors) gen.break();
				});
			});
			cxt.ok(valid);
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/additionalProperties.js
var require_additionalProperties = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var code_1 = require_code();
	var codegen_1 = require_codegen();
	var names_1 = require_names();
	var util_1 = require_util();
	exports.default = {
		keyword: "additionalProperties",
		type: ["object"],
		schemaType: ["boolean", "object"],
		allowUndefined: true,
		trackErrors: true,
		error: {
			message: "must NOT have additional properties",
			params: ({ params }) => (0, codegen_1._)`{additionalProperty: ${params.additionalProperty}}`
		},
		code(cxt) {
			const { gen, schema, parentSchema, data, errsCount, it } = cxt;
			/* istanbul ignore if */
			if (!errsCount) throw new Error("ajv implementation error");
			const { allErrors, opts } = it;
			it.props = true;
			if (opts.removeAdditional !== "all" && (0, util_1.alwaysValidSchema)(it, schema)) return;
			const props = (0, code_1.allSchemaProperties)(parentSchema.properties);
			const patProps = (0, code_1.allSchemaProperties)(parentSchema.patternProperties);
			checkAdditionalProperties();
			cxt.ok((0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
			function checkAdditionalProperties() {
				gen.forIn("key", data, (key) => {
					if (!props.length && !patProps.length) additionalPropertyCode(key);
					else gen.if(isAdditional(key), () => additionalPropertyCode(key));
				});
			}
			function isAdditional(key) {
				let definedProp;
				if (props.length > 8) {
					const propsSchema = (0, util_1.schemaRefOrVal)(it, parentSchema.properties, "properties");
					definedProp = (0, code_1.isOwnProperty)(gen, propsSchema, key);
				} else if (props.length) definedProp = (0, codegen_1.or)(...props.map((p) => (0, codegen_1._)`${key} === ${p}`));
				else definedProp = codegen_1.nil;
				if (patProps.length) definedProp = (0, codegen_1.or)(definedProp, ...patProps.map((p) => (0, codegen_1._)`${(0, code_1.usePattern)(cxt, p)}.test(${key})`));
				return (0, codegen_1.not)(definedProp);
			}
			function deleteAdditional(key) {
				gen.code((0, codegen_1._)`delete ${data}[${key}]`);
			}
			function additionalPropertyCode(key) {
				if (opts.removeAdditional === "all" || opts.removeAdditional && schema === false) {
					deleteAdditional(key);
					return;
				}
				if (schema === false) {
					cxt.setParams({ additionalProperty: key });
					cxt.error();
					if (!allErrors) gen.break();
					return;
				}
				if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
					const valid = gen.name("valid");
					if (opts.removeAdditional === "failing") {
						applyAdditionalSchema(key, valid, false);
						gen.if((0, codegen_1.not)(valid), () => {
							cxt.reset();
							deleteAdditional(key);
						});
					} else {
						applyAdditionalSchema(key, valid);
						if (!allErrors) gen.if((0, codegen_1.not)(valid), () => gen.break());
					}
				}
			}
			function applyAdditionalSchema(key, valid, errors) {
				const subschema = {
					keyword: "additionalProperties",
					dataProp: key,
					dataPropType: util_1.Type.Str
				};
				if (errors === false) Object.assign(subschema, {
					compositeRule: true,
					createErrors: false,
					allErrors: false
				});
				cxt.subschema(subschema, valid);
			}
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/properties.js
var require_properties = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var validate_1 = require_validate();
	var code_1 = require_code();
	var util_1 = require_util();
	var additionalProperties_1 = require_additionalProperties();
	exports.default = {
		keyword: "properties",
		type: "object",
		schemaType: "object",
		code(cxt) {
			const { gen, schema, parentSchema, data, it } = cxt;
			if (it.opts.removeAdditional === "all" && parentSchema.additionalProperties === void 0) additionalProperties_1.default.code(new validate_1.KeywordCxt(it, additionalProperties_1.default, "additionalProperties"));
			const allProps = (0, code_1.allSchemaProperties)(schema);
			for (const prop of allProps) it.definedProperties.add(prop);
			if (it.opts.unevaluated && allProps.length && it.props !== true) it.props = util_1.mergeEvaluated.props(gen, (0, util_1.toHash)(allProps), it.props);
			const properties = allProps.filter((p) => !(0, util_1.alwaysValidSchema)(it, schema[p]));
			if (properties.length === 0) return;
			const valid = gen.name("valid");
			for (const prop of properties) {
				if (hasDefault(prop)) applyPropertySchema(prop);
				else {
					gen.if((0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties));
					applyPropertySchema(prop);
					if (!it.allErrors) gen.else().var(valid, true);
					gen.endIf();
				}
				cxt.it.definedProperties.add(prop);
				cxt.ok(valid);
			}
			function hasDefault(prop) {
				return it.opts.useDefaults && !it.compositeRule && schema[prop].default !== void 0;
			}
			function applyPropertySchema(prop) {
				cxt.subschema({
					keyword: "properties",
					schemaProp: prop,
					dataProp: prop
				}, valid);
			}
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/patternProperties.js
var require_patternProperties = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var code_1 = require_code();
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	var util_2 = require_util();
	exports.default = {
		keyword: "patternProperties",
		type: "object",
		schemaType: "object",
		code(cxt) {
			const { gen, schema, data, parentSchema, it } = cxt;
			const { opts } = it;
			const patterns = (0, code_1.allSchemaProperties)(schema);
			const alwaysValidPatterns = patterns.filter((p) => (0, util_1.alwaysValidSchema)(it, schema[p]));
			if (patterns.length === 0 || alwaysValidPatterns.length === patterns.length && (!it.opts.unevaluated || it.props === true)) return;
			const checkProperties = opts.strictSchema && !opts.allowMatchingProperties && parentSchema.properties;
			const valid = gen.name("valid");
			if (it.props !== true && !(it.props instanceof codegen_1.Name)) it.props = (0, util_2.evaluatedPropsToName)(gen, it.props);
			const { props } = it;
			validatePatternProperties();
			function validatePatternProperties() {
				for (const pat of patterns) {
					if (checkProperties) checkMatchingProperties(pat);
					if (it.allErrors) validateProperties(pat);
					else {
						gen.var(valid, true);
						validateProperties(pat);
						gen.if(valid);
					}
				}
			}
			function checkMatchingProperties(pat) {
				for (const prop in checkProperties) if (new RegExp(pat).test(prop)) (0, util_1.checkStrictMode)(it, `property ${prop} matches pattern ${pat} (use allowMatchingProperties)`);
			}
			function validateProperties(pat) {
				gen.forIn("key", data, (key) => {
					gen.if((0, codegen_1._)`${(0, code_1.usePattern)(cxt, pat)}.test(${key})`, () => {
						const alwaysValid = alwaysValidPatterns.includes(pat);
						if (!alwaysValid) cxt.subschema({
							keyword: "patternProperties",
							schemaProp: pat,
							dataProp: key,
							dataPropType: util_2.Type.Str
						}, valid);
						if (it.opts.unevaluated && props !== true) gen.assign((0, codegen_1._)`${props}[${key}]`, true);
						else if (!alwaysValid && !it.allErrors) gen.if((0, codegen_1.not)(valid), () => gen.break());
					});
				});
			}
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/not.js
var require_not = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var util_1 = require_util();
	exports.default = {
		keyword: "not",
		schemaType: ["object", "boolean"],
		trackErrors: true,
		code(cxt) {
			const { gen, schema, it } = cxt;
			if ((0, util_1.alwaysValidSchema)(it, schema)) {
				cxt.fail();
				return;
			}
			const valid = gen.name("valid");
			cxt.subschema({
				keyword: "not",
				compositeRule: true,
				createErrors: false,
				allErrors: false
			}, valid);
			cxt.failResult(valid, () => cxt.reset(), () => cxt.error());
		},
		error: { message: "must NOT be valid" }
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/anyOf.js
var require_anyOf = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = {
		keyword: "anyOf",
		schemaType: "array",
		trackErrors: true,
		code: require_code().validateUnion,
		error: { message: "must match a schema in anyOf" }
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/oneOf.js
var require_oneOf = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	exports.default = {
		keyword: "oneOf",
		schemaType: "array",
		trackErrors: true,
		error: {
			message: "must match exactly one schema in oneOf",
			params: ({ params }) => (0, codegen_1._)`{passingSchemas: ${params.passing}}`
		},
		code(cxt) {
			const { gen, schema, parentSchema, it } = cxt;
			/* istanbul ignore if */
			if (!Array.isArray(schema)) throw new Error("ajv implementation error");
			if (it.opts.discriminator && parentSchema.discriminator) return;
			const schArr = schema;
			const valid = gen.let("valid", false);
			const passing = gen.let("passing", null);
			const schValid = gen.name("_valid");
			cxt.setParams({ passing });
			gen.block(validateOneOf);
			cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
			function validateOneOf() {
				schArr.forEach((sch, i) => {
					let schCxt;
					if ((0, util_1.alwaysValidSchema)(it, sch)) gen.var(schValid, true);
					else schCxt = cxt.subschema({
						keyword: "oneOf",
						schemaProp: i,
						compositeRule: true
					}, schValid);
					if (i > 0) gen.if((0, codegen_1._)`${schValid} && ${valid}`).assign(valid, false).assign(passing, (0, codegen_1._)`[${passing}, ${i}]`).else();
					gen.if(schValid, () => {
						gen.assign(valid, true);
						gen.assign(passing, i);
						if (schCxt) cxt.mergeEvaluated(schCxt, codegen_1.Name);
					});
				});
			}
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/allOf.js
var require_allOf = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var util_1 = require_util();
	exports.default = {
		keyword: "allOf",
		schemaType: "array",
		code(cxt) {
			const { gen, schema, it } = cxt;
			/* istanbul ignore if */
			if (!Array.isArray(schema)) throw new Error("ajv implementation error");
			const valid = gen.name("valid");
			schema.forEach((sch, i) => {
				if ((0, util_1.alwaysValidSchema)(it, sch)) return;
				const schCxt = cxt.subschema({
					keyword: "allOf",
					schemaProp: i
				}, valid);
				cxt.ok(valid);
				cxt.mergeEvaluated(schCxt);
			});
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/if.js
var require_if = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	var def = {
		keyword: "if",
		schemaType: ["object", "boolean"],
		trackErrors: true,
		error: {
			message: ({ params }) => (0, codegen_1.str)`must match "${params.ifClause}" schema`,
			params: ({ params }) => (0, codegen_1._)`{failingKeyword: ${params.ifClause}}`
		},
		code(cxt) {
			const { gen, parentSchema, it } = cxt;
			if (parentSchema.then === void 0 && parentSchema.else === void 0) (0, util_1.checkStrictMode)(it, "\"if\" without \"then\" and \"else\" is ignored");
			const hasThen = hasSchema(it, "then");
			const hasElse = hasSchema(it, "else");
			if (!hasThen && !hasElse) return;
			const valid = gen.let("valid", true);
			const schValid = gen.name("_valid");
			validateIf();
			cxt.reset();
			if (hasThen && hasElse) {
				const ifClause = gen.let("ifClause");
				cxt.setParams({ ifClause });
				gen.if(schValid, validateClause("then", ifClause), validateClause("else", ifClause));
			} else if (hasThen) gen.if(schValid, validateClause("then"));
			else gen.if((0, codegen_1.not)(schValid), validateClause("else"));
			cxt.pass(valid, () => cxt.error(true));
			function validateIf() {
				const schCxt = cxt.subschema({
					keyword: "if",
					compositeRule: true,
					createErrors: false,
					allErrors: false
				}, schValid);
				cxt.mergeEvaluated(schCxt);
			}
			function validateClause(keyword, ifClause) {
				return () => {
					const schCxt = cxt.subschema({ keyword }, schValid);
					gen.assign(valid, schValid);
					cxt.mergeValidEvaluated(schCxt, valid);
					if (ifClause) gen.assign(ifClause, (0, codegen_1._)`${keyword}`);
					else cxt.setParams({ ifClause: keyword });
				};
			}
		}
	};
	function hasSchema(it, keyword) {
		const schema = it.schema[keyword];
		return schema !== void 0 && !(0, util_1.alwaysValidSchema)(it, schema);
	}
	exports.default = def;
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/thenElse.js
var require_thenElse = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var util_1 = require_util();
	exports.default = {
		keyword: ["then", "else"],
		schemaType: ["object", "boolean"],
		code({ keyword, parentSchema, it }) {
			if (parentSchema.if === void 0) (0, util_1.checkStrictMode)(it, `"${keyword}" without "if" is ignored`);
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/index.js
var require_applicator = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var additionalItems_1 = require_additionalItems();
	var prefixItems_1 = require_prefixItems();
	var items_1 = require_items();
	var items2020_1 = require_items2020();
	var contains_1 = require_contains();
	var dependencies_1 = require_dependencies();
	var propertyNames_1 = require_propertyNames();
	var additionalProperties_1 = require_additionalProperties();
	var properties_1 = require_properties();
	var patternProperties_1 = require_patternProperties();
	var not_1 = require_not();
	var anyOf_1 = require_anyOf();
	var oneOf_1 = require_oneOf();
	var allOf_1 = require_allOf();
	var if_1 = require_if();
	var thenElse_1 = require_thenElse();
	function getApplicator(draft2020 = false) {
		const applicator = [
			not_1.default,
			anyOf_1.default,
			oneOf_1.default,
			allOf_1.default,
			if_1.default,
			thenElse_1.default,
			propertyNames_1.default,
			additionalProperties_1.default,
			dependencies_1.default,
			properties_1.default,
			patternProperties_1.default
		];
		if (draft2020) applicator.push(prefixItems_1.default, items2020_1.default);
		else applicator.push(additionalItems_1.default, items_1.default);
		applicator.push(contains_1.default);
		return applicator;
	}
	exports.default = getApplicator;
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/dynamic/dynamicAnchor.js
var require_dynamicAnchor = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.dynamicAnchor = void 0;
	var codegen_1 = require_codegen();
	var names_1 = require_names();
	var compile_1 = require_compile();
	var ref_1 = require_ref();
	var def = {
		keyword: "$dynamicAnchor",
		schemaType: "string",
		code: (cxt) => dynamicAnchor(cxt, cxt.schema)
	};
	function dynamicAnchor(cxt, anchor) {
		const { gen, it } = cxt;
		it.schemaEnv.root.dynamicAnchors[anchor] = true;
		const v = (0, codegen_1._)`${names_1.default.dynamicAnchors}${(0, codegen_1.getProperty)(anchor)}`;
		const validate = it.errSchemaPath === "#" ? it.validateName : _getValidate(cxt);
		gen.if((0, codegen_1._)`!${v}`, () => gen.assign(v, validate));
	}
	exports.dynamicAnchor = dynamicAnchor;
	function _getValidate(cxt) {
		const { schemaEnv, schema, self } = cxt.it;
		const { root, baseId, localRefs, meta } = schemaEnv.root;
		const { schemaId } = self.opts;
		const sch = new compile_1.SchemaEnv({
			schema,
			schemaId,
			root,
			baseId,
			localRefs,
			meta
		});
		compile_1.compileSchema.call(self, sch);
		return (0, ref_1.getValidate)(cxt, sch);
	}
	exports.default = def;
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/dynamic/dynamicRef.js
var require_dynamicRef = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.dynamicRef = void 0;
	var codegen_1 = require_codegen();
	var names_1 = require_names();
	var ref_1 = require_ref();
	var def = {
		keyword: "$dynamicRef",
		schemaType: "string",
		code: (cxt) => dynamicRef(cxt, cxt.schema)
	};
	function dynamicRef(cxt, ref) {
		const { gen, keyword, it } = cxt;
		if (ref[0] !== "#") throw new Error(`"${keyword}" only supports hash fragment reference`);
		const anchor = ref.slice(1);
		if (it.allErrors) _dynamicRef();
		else {
			const valid = gen.let("valid", false);
			_dynamicRef(valid);
			cxt.ok(valid);
		}
		function _dynamicRef(valid) {
			if (it.schemaEnv.root.dynamicAnchors[anchor]) {
				const v = gen.let("_v", (0, codegen_1._)`${names_1.default.dynamicAnchors}${(0, codegen_1.getProperty)(anchor)}`);
				gen.if(v, _callRef(v, valid), _callRef(it.validateName, valid));
			} else _callRef(it.validateName, valid)();
		}
		function _callRef(validate, valid) {
			return valid ? () => gen.block(() => {
				(0, ref_1.callRef)(cxt, validate);
				gen.let(valid, true);
			}) : () => (0, ref_1.callRef)(cxt, validate);
		}
	}
	exports.dynamicRef = dynamicRef;
	exports.default = def;
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/dynamic/recursiveAnchor.js
var require_recursiveAnchor = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var dynamicAnchor_1 = require_dynamicAnchor();
	var util_1 = require_util();
	exports.default = {
		keyword: "$recursiveAnchor",
		schemaType: "boolean",
		code(cxt) {
			if (cxt.schema) (0, dynamicAnchor_1.dynamicAnchor)(cxt, "");
			else (0, util_1.checkStrictMode)(cxt.it, "$recursiveAnchor: false is ignored");
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/dynamic/recursiveRef.js
var require_recursiveRef = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var dynamicRef_1 = require_dynamicRef();
	exports.default = {
		keyword: "$recursiveRef",
		schemaType: "string",
		code: (cxt) => (0, dynamicRef_1.dynamicRef)(cxt, cxt.schema)
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/dynamic/index.js
var require_dynamic = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var dynamicAnchor_1 = require_dynamicAnchor();
	var dynamicRef_1 = require_dynamicRef();
	var recursiveAnchor_1 = require_recursiveAnchor();
	var recursiveRef_1 = require_recursiveRef();
	exports.default = [
		dynamicAnchor_1.default,
		dynamicRef_1.default,
		recursiveAnchor_1.default,
		recursiveRef_1.default
	];
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/validation/dependentRequired.js
var require_dependentRequired = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var dependencies_1 = require_dependencies();
	exports.default = {
		keyword: "dependentRequired",
		type: "object",
		schemaType: "object",
		error: dependencies_1.error,
		code: (cxt) => (0, dependencies_1.validatePropertyDeps)(cxt)
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/applicator/dependentSchemas.js
var require_dependentSchemas = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var dependencies_1 = require_dependencies();
	exports.default = {
		keyword: "dependentSchemas",
		type: "object",
		schemaType: "object",
		code: (cxt) => (0, dependencies_1.validateSchemaDeps)(cxt)
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/validation/limitContains.js
var require_limitContains = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var util_1 = require_util();
	exports.default = {
		keyword: ["maxContains", "minContains"],
		type: "array",
		schemaType: "number",
		code({ keyword, parentSchema, it }) {
			if (parentSchema.contains === void 0) (0, util_1.checkStrictMode)(it, `"${keyword}" without "contains" is ignored`);
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/next.js
var require_next = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var dependentRequired_1 = require_dependentRequired();
	var dependentSchemas_1 = require_dependentSchemas();
	var limitContains_1 = require_limitContains();
	exports.default = [
		dependentRequired_1.default,
		dependentSchemas_1.default,
		limitContains_1.default
	];
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/unevaluated/unevaluatedProperties.js
var require_unevaluatedProperties = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	var names_1 = require_names();
	exports.default = {
		keyword: "unevaluatedProperties",
		type: "object",
		schemaType: ["boolean", "object"],
		trackErrors: true,
		error: {
			message: "must NOT have unevaluated properties",
			params: ({ params }) => (0, codegen_1._)`{unevaluatedProperty: ${params.unevaluatedProperty}}`
		},
		code(cxt) {
			const { gen, schema, data, errsCount, it } = cxt;
			/* istanbul ignore if */
			if (!errsCount) throw new Error("ajv implementation error");
			const { allErrors, props } = it;
			if (props instanceof codegen_1.Name) gen.if((0, codegen_1._)`${props} !== true`, () => gen.forIn("key", data, (key) => gen.if(unevaluatedDynamic(props, key), () => unevaluatedPropCode(key))));
			else if (props !== true) gen.forIn("key", data, (key) => props === void 0 ? unevaluatedPropCode(key) : gen.if(unevaluatedStatic(props, key), () => unevaluatedPropCode(key)));
			it.props = true;
			cxt.ok((0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
			function unevaluatedPropCode(key) {
				if (schema === false) {
					cxt.setParams({ unevaluatedProperty: key });
					cxt.error();
					if (!allErrors) gen.break();
					return;
				}
				if (!(0, util_1.alwaysValidSchema)(it, schema)) {
					const valid = gen.name("valid");
					cxt.subschema({
						keyword: "unevaluatedProperties",
						dataProp: key,
						dataPropType: util_1.Type.Str
					}, valid);
					if (!allErrors) gen.if((0, codegen_1.not)(valid), () => gen.break());
				}
			}
			function unevaluatedDynamic(evaluatedProps, key) {
				return (0, codegen_1._)`!${evaluatedProps} || !${evaluatedProps}[${key}]`;
			}
			function unevaluatedStatic(evaluatedProps, key) {
				const ps = [];
				for (const p in evaluatedProps) if (evaluatedProps[p] === true) ps.push((0, codegen_1._)`${key} !== ${p}`);
				return (0, codegen_1.and)(...ps);
			}
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/unevaluated/unevaluatedItems.js
var require_unevaluatedItems = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	var util_1 = require_util();
	exports.default = {
		keyword: "unevaluatedItems",
		type: "array",
		schemaType: ["boolean", "object"],
		error: {
			message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
			params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
		},
		code(cxt) {
			const { gen, schema, data, it } = cxt;
			const items = it.items || 0;
			if (items === true) return;
			const len = gen.const("len", (0, codegen_1._)`${data}.length`);
			if (schema === false) {
				cxt.setParams({ len: items });
				cxt.fail((0, codegen_1._)`${len} > ${items}`);
			} else if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
				const valid = gen.var("valid", (0, codegen_1._)`${len} <= ${items}`);
				gen.if((0, codegen_1.not)(valid), () => validateItems(valid, items));
				cxt.ok(valid);
			}
			it.items = true;
			function validateItems(valid, from) {
				gen.forRange("i", from, len, (i) => {
					cxt.subschema({
						keyword: "unevaluatedItems",
						dataProp: i,
						dataPropType: util_1.Type.Num
					}, valid);
					if (!it.allErrors) gen.if((0, codegen_1.not)(valid), () => gen.break());
				});
			}
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/unevaluated/index.js
var require_unevaluated = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var unevaluatedProperties_1 = require_unevaluatedProperties();
	var unevaluatedItems_1 = require_unevaluatedItems();
	exports.default = [unevaluatedProperties_1.default, unevaluatedItems_1.default];
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/format/format.js
var require_format$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	exports.default = {
		keyword: "format",
		type: ["number", "string"],
		schemaType: "string",
		$data: true,
		error: {
			message: ({ schemaCode }) => (0, codegen_1.str)`must match format "${schemaCode}"`,
			params: ({ schemaCode }) => (0, codegen_1._)`{format: ${schemaCode}}`
		},
		code(cxt, ruleType) {
			const { gen, data, $data, schema, schemaCode, it } = cxt;
			const { opts, errSchemaPath, schemaEnv, self } = it;
			if (!opts.validateFormats) return;
			if ($data) validate$DataFormat();
			else validateFormat();
			function validate$DataFormat() {
				const fmts = gen.scopeValue("formats", {
					ref: self.formats,
					code: opts.code.formats
				});
				const fDef = gen.const("fDef", (0, codegen_1._)`${fmts}[${schemaCode}]`);
				const fType = gen.let("fType");
				const format = gen.let("format");
				gen.if((0, codegen_1._)`typeof ${fDef} == "object" && !(${fDef} instanceof RegExp)`, () => gen.assign(fType, (0, codegen_1._)`${fDef}.type || "string"`).assign(format, (0, codegen_1._)`${fDef}.validate`), () => gen.assign(fType, (0, codegen_1._)`"string"`).assign(format, fDef));
				cxt.fail$data((0, codegen_1.or)(unknownFmt(), invalidFmt()));
				function unknownFmt() {
					if (opts.strictSchema === false) return codegen_1.nil;
					return (0, codegen_1._)`${schemaCode} && !${format}`;
				}
				function invalidFmt() {
					const callFormat = schemaEnv.$async ? (0, codegen_1._)`(${fDef}.async ? await ${format}(${data}) : ${format}(${data}))` : (0, codegen_1._)`${format}(${data})`;
					const validData = (0, codegen_1._)`(typeof ${format} == "function" ? ${callFormat} : ${format}.test(${data}))`;
					return (0, codegen_1._)`${format} && ${format} !== true && ${fType} === ${ruleType} && !${validData}`;
				}
			}
			function validateFormat() {
				const formatDef = self.formats[schema];
				if (!formatDef) {
					unknownFormat();
					return;
				}
				if (formatDef === true) return;
				const [fmtType, format, fmtRef] = getFormat(formatDef);
				if (fmtType === ruleType) cxt.pass(validCondition());
				function unknownFormat() {
					if (opts.strictSchema === false) {
						self.logger.warn(unknownMsg());
						return;
					}
					throw new Error(unknownMsg());
					function unknownMsg() {
						return `unknown format "${schema}" ignored in schema at path "${errSchemaPath}"`;
					}
				}
				function getFormat(fmtDef) {
					const code = fmtDef instanceof RegExp ? (0, codegen_1.regexpCode)(fmtDef) : opts.code.formats ? (0, codegen_1._)`${opts.code.formats}${(0, codegen_1.getProperty)(schema)}` : void 0;
					const fmt = gen.scopeValue("formats", {
						key: schema,
						ref: fmtDef,
						code
					});
					if (typeof fmtDef == "object" && !(fmtDef instanceof RegExp)) return [
						fmtDef.type || "string",
						fmtDef.validate,
						(0, codegen_1._)`${fmt}.validate`
					];
					return [
						"string",
						fmtDef,
						fmt
					];
				}
				function validCondition() {
					if (typeof formatDef == "object" && !(formatDef instanceof RegExp) && formatDef.async) {
						if (!schemaEnv.$async) throw new Error("async format in sync schema");
						return (0, codegen_1._)`await ${fmtRef}(${data})`;
					}
					return typeof format == "function" ? (0, codegen_1._)`${fmtRef}(${data})` : (0, codegen_1._)`${fmtRef}.test(${data})`;
				}
			}
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/format/index.js
var require_format = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = [require_format$1().default];
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/metadata.js
var require_metadata = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.contentVocabulary = exports.metadataVocabulary = void 0;
	exports.metadataVocabulary = [
		"title",
		"description",
		"default",
		"deprecated",
		"readOnly",
		"writeOnly",
		"examples"
	];
	exports.contentVocabulary = [
		"contentMediaType",
		"contentEncoding",
		"contentSchema"
	];
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/draft2020.js
var require_draft2020 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var core_1 = require_core();
	var validation_1 = require_validation();
	var applicator_1 = require_applicator();
	var dynamic_1 = require_dynamic();
	var next_1 = require_next();
	var unevaluated_1 = require_unevaluated();
	var format_1 = require_format();
	var metadata_1 = require_metadata();
	exports.default = [
		dynamic_1.default,
		core_1.default,
		validation_1.default,
		(0, applicator_1.default)(true),
		format_1.default,
		metadata_1.metadataVocabulary,
		metadata_1.contentVocabulary,
		next_1.default,
		unevaluated_1.default
	];
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/discriminator/types.js
var require_types = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.DiscrError = void 0;
	var DiscrError;
	(function(DiscrError) {
		DiscrError["Tag"] = "tag";
		DiscrError["Mapping"] = "mapping";
	})(DiscrError || (exports.DiscrError = DiscrError = {}));
}));
//#endregion
//#region node_modules/ajv/dist/vocabularies/discriminator/index.js
var require_discriminator = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var codegen_1 = require_codegen();
	var types_1 = require_types();
	var compile_1 = require_compile();
	var ref_error_1 = require_ref_error();
	var util_1 = require_util();
	exports.default = {
		keyword: "discriminator",
		type: "object",
		schemaType: "object",
		error: {
			message: ({ params: { discrError, tagName } }) => discrError === types_1.DiscrError.Tag ? `tag "${tagName}" must be string` : `value of tag "${tagName}" must be in oneOf`,
			params: ({ params: { discrError, tag, tagName } }) => (0, codegen_1._)`{error: ${discrError}, tag: ${tagName}, tagValue: ${tag}}`
		},
		code(cxt) {
			const { gen, data, schema, parentSchema, it } = cxt;
			const { oneOf } = parentSchema;
			if (!it.opts.discriminator) throw new Error("discriminator: requires discriminator option");
			const tagName = schema.propertyName;
			if (typeof tagName != "string") throw new Error("discriminator: requires propertyName");
			if (schema.mapping) throw new Error("discriminator: mapping is not supported");
			if (!oneOf) throw new Error("discriminator: requires oneOf keyword");
			const valid = gen.let("valid", false);
			const tag = gen.const("tag", (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(tagName)}`);
			gen.if((0, codegen_1._)`typeof ${tag} == "string"`, () => validateMapping(), () => cxt.error(false, {
				discrError: types_1.DiscrError.Tag,
				tag,
				tagName
			}));
			cxt.ok(valid);
			function validateMapping() {
				const mapping = getMapping();
				gen.if(false);
				for (const tagValue in mapping) {
					gen.elseIf((0, codegen_1._)`${tag} === ${tagValue}`);
					gen.assign(valid, applyTagSchema(mapping[tagValue]));
				}
				gen.else();
				cxt.error(false, {
					discrError: types_1.DiscrError.Mapping,
					tag,
					tagName
				});
				gen.endIf();
			}
			function applyTagSchema(schemaProp) {
				const _valid = gen.name("valid");
				const schCxt = cxt.subschema({
					keyword: "oneOf",
					schemaProp
				}, _valid);
				cxt.mergeEvaluated(schCxt, codegen_1.Name);
				return _valid;
			}
			function getMapping() {
				var _a;
				const oneOfMapping = {};
				const topRequired = hasRequired(parentSchema);
				let tagRequired = true;
				for (let i = 0; i < oneOf.length; i++) {
					let sch = oneOf[i];
					if ((sch === null || sch === void 0 ? void 0 : sch.$ref) && !(0, util_1.schemaHasRulesButRef)(sch, it.self.RULES)) {
						const ref = sch.$ref;
						sch = compile_1.resolveRef.call(it.self, it.schemaEnv.root, it.baseId, ref);
						if (sch instanceof compile_1.SchemaEnv) sch = sch.schema;
						if (sch === void 0) throw new ref_error_1.default(it.opts.uriResolver, it.baseId, ref);
					}
					const propSch = (_a = sch === null || sch === void 0 ? void 0 : sch.properties) === null || _a === void 0 ? void 0 : _a[tagName];
					if (typeof propSch != "object") throw new Error(`discriminator: oneOf subschemas (or referenced schemas) must have "properties/${tagName}"`);
					tagRequired = tagRequired && (topRequired || hasRequired(sch));
					addMappings(propSch, i);
				}
				if (!tagRequired) throw new Error(`discriminator: "${tagName}" must be required`);
				return oneOfMapping;
				function hasRequired({ required }) {
					return Array.isArray(required) && required.includes(tagName);
				}
				function addMappings(sch, i) {
					if (sch.const) addMapping(sch.const, i);
					else if (sch.enum) for (const tagValue of sch.enum) addMapping(tagValue, i);
					else throw new Error(`discriminator: "properties/${tagName}" must have "const" or "enum"`);
				}
				function addMapping(tagValue, i) {
					if (typeof tagValue != "string" || tagValue in oneOfMapping) throw new Error(`discriminator: "${tagName}" values must be unique strings`);
					oneOfMapping[tagValue] = i;
				}
			}
		}
	};
}));
//#endregion
//#region node_modules/ajv/dist/refs/json-schema-2020-12/schema.json
var schema_exports = /* @__PURE__ */ __exportAll({
	$comment: () => $comment,
	$dynamicAnchor: () => $dynamicAnchor$7,
	$id: () => $id$10,
	$schema: () => $schema$10,
	$vocabulary: () => $vocabulary$7,
	allOf: () => allOf,
	default: () => schema_default,
	properties: () => properties$10,
	title: () => title$10,
	type: () => type$10
});
var $schema$10, $id$10, $vocabulary$7, $dynamicAnchor$7, title$10, allOf, type$10, $comment, properties$10, schema_default;
var init_schema$1 = __esmMin((() => {
	$schema$10 = "https://json-schema.org/draft/2020-12/schema";
	$id$10 = "https://json-schema.org/draft/2020-12/schema";
	$vocabulary$7 = {
		"https://json-schema.org/draft/2020-12/vocab/core": true,
		"https://json-schema.org/draft/2020-12/vocab/applicator": true,
		"https://json-schema.org/draft/2020-12/vocab/unevaluated": true,
		"https://json-schema.org/draft/2020-12/vocab/validation": true,
		"https://json-schema.org/draft/2020-12/vocab/meta-data": true,
		"https://json-schema.org/draft/2020-12/vocab/format-annotation": true,
		"https://json-schema.org/draft/2020-12/vocab/content": true
	};
	$dynamicAnchor$7 = "meta";
	title$10 = "Core and Validation specifications meta-schema";
	allOf = [
		{ "$ref": "meta/core" },
		{ "$ref": "meta/applicator" },
		{ "$ref": "meta/unevaluated" },
		{ "$ref": "meta/validation" },
		{ "$ref": "meta/meta-data" },
		{ "$ref": "meta/format-annotation" },
		{ "$ref": "meta/content" }
	];
	type$10 = ["object", "boolean"];
	$comment = "This meta-schema also defines keywords that have appeared in previous drafts in order to prevent incompatible extensions as they remain in common use.";
	properties$10 = {
		"definitions": {
			"$comment": "\"definitions\" has been replaced by \"$defs\".",
			"type": "object",
			"additionalProperties": { "$dynamicRef": "#meta" },
			"deprecated": true,
			"default": {}
		},
		"dependencies": {
			"$comment": "\"dependencies\" has been split and replaced by \"dependentSchemas\" and \"dependentRequired\" in order to serve their differing semantics.",
			"type": "object",
			"additionalProperties": { "anyOf": [{ "$dynamicRef": "#meta" }, { "$ref": "meta/validation#/$defs/stringArray" }] },
			"deprecated": true,
			"default": {}
		},
		"$recursiveAnchor": {
			"$comment": "\"$recursiveAnchor\" has been replaced by \"$dynamicAnchor\".",
			"$ref": "meta/core#/$defs/anchorString",
			"deprecated": true
		},
		"$recursiveRef": {
			"$comment": "\"$recursiveRef\" has been replaced by \"$dynamicRef\".",
			"$ref": "meta/core#/$defs/uriReferenceString",
			"deprecated": true
		}
	};
	schema_default = {
		$schema: $schema$10,
		$id: $id$10,
		$vocabulary: $vocabulary$7,
		$dynamicAnchor: $dynamicAnchor$7,
		title: title$10,
		allOf,
		type: type$10,
		$comment,
		properties: properties$10
	};
}));
//#endregion
//#region node_modules/ajv/dist/refs/json-schema-2020-12/meta/applicator.json
var applicator_exports = /* @__PURE__ */ __exportAll({
	$defs: () => $defs$5,
	$dynamicAnchor: () => $dynamicAnchor$6,
	$id: () => $id$9,
	$schema: () => $schema$9,
	$vocabulary: () => $vocabulary$6,
	default: () => applicator_default,
	properties: () => properties$9,
	title: () => title$9,
	type: () => type$9
});
var $schema$9, $id$9, $vocabulary$6, $dynamicAnchor$6, title$9, type$9, properties$9, $defs$5, applicator_default;
var init_applicator = __esmMin((() => {
	$schema$9 = "https://json-schema.org/draft/2020-12/schema";
	$id$9 = "https://json-schema.org/draft/2020-12/meta/applicator";
	$vocabulary$6 = { "https://json-schema.org/draft/2020-12/vocab/applicator": true };
	$dynamicAnchor$6 = "meta";
	title$9 = "Applicator vocabulary meta-schema";
	type$9 = ["object", "boolean"];
	properties$9 = {
		"prefixItems": { "$ref": "#/$defs/schemaArray" },
		"items": { "$dynamicRef": "#meta" },
		"contains": { "$dynamicRef": "#meta" },
		"additionalProperties": { "$dynamicRef": "#meta" },
		"properties": {
			"type": "object",
			"additionalProperties": { "$dynamicRef": "#meta" },
			"default": {}
		},
		"patternProperties": {
			"type": "object",
			"additionalProperties": { "$dynamicRef": "#meta" },
			"propertyNames": { "format": "regex" },
			"default": {}
		},
		"dependentSchemas": {
			"type": "object",
			"additionalProperties": { "$dynamicRef": "#meta" },
			"default": {}
		},
		"propertyNames": { "$dynamicRef": "#meta" },
		"if": { "$dynamicRef": "#meta" },
		"then": { "$dynamicRef": "#meta" },
		"else": { "$dynamicRef": "#meta" },
		"allOf": { "$ref": "#/$defs/schemaArray" },
		"anyOf": { "$ref": "#/$defs/schemaArray" },
		"oneOf": { "$ref": "#/$defs/schemaArray" },
		"not": { "$dynamicRef": "#meta" }
	};
	$defs$5 = { "schemaArray": {
		"type": "array",
		"minItems": 1,
		"items": { "$dynamicRef": "#meta" }
	} };
	applicator_default = {
		$schema: $schema$9,
		$id: $id$9,
		$vocabulary: $vocabulary$6,
		$dynamicAnchor: $dynamicAnchor$6,
		title: title$9,
		type: type$9,
		properties: properties$9,
		$defs: $defs$5
	};
}));
//#endregion
//#region node_modules/ajv/dist/refs/json-schema-2020-12/meta/unevaluated.json
var unevaluated_exports = /* @__PURE__ */ __exportAll({
	$dynamicAnchor: () => $dynamicAnchor$5,
	$id: () => $id$8,
	$schema: () => $schema$8,
	$vocabulary: () => $vocabulary$5,
	default: () => unevaluated_default,
	properties: () => properties$8,
	title: () => title$8,
	type: () => type$8
});
var $schema$8, $id$8, $vocabulary$5, $dynamicAnchor$5, title$8, type$8, properties$8, unevaluated_default;
var init_unevaluated = __esmMin((() => {
	$schema$8 = "https://json-schema.org/draft/2020-12/schema";
	$id$8 = "https://json-schema.org/draft/2020-12/meta/unevaluated";
	$vocabulary$5 = { "https://json-schema.org/draft/2020-12/vocab/unevaluated": true };
	$dynamicAnchor$5 = "meta";
	title$8 = "Unevaluated applicator vocabulary meta-schema";
	type$8 = ["object", "boolean"];
	properties$8 = {
		"unevaluatedItems": { "$dynamicRef": "#meta" },
		"unevaluatedProperties": { "$dynamicRef": "#meta" }
	};
	unevaluated_default = {
		$schema: $schema$8,
		$id: $id$8,
		$vocabulary: $vocabulary$5,
		$dynamicAnchor: $dynamicAnchor$5,
		title: title$8,
		type: type$8,
		properties: properties$8
	};
}));
//#endregion
//#region node_modules/ajv/dist/refs/json-schema-2020-12/meta/content.json
var content_exports = /* @__PURE__ */ __exportAll({
	$dynamicAnchor: () => $dynamicAnchor$4,
	$id: () => $id$7,
	$schema: () => $schema$7,
	$vocabulary: () => $vocabulary$4,
	default: () => content_default,
	properties: () => properties$7,
	title: () => title$7,
	type: () => type$7
});
var $schema$7, $id$7, $vocabulary$4, $dynamicAnchor$4, title$7, type$7, properties$7, content_default;
var init_content = __esmMin((() => {
	$schema$7 = "https://json-schema.org/draft/2020-12/schema";
	$id$7 = "https://json-schema.org/draft/2020-12/meta/content";
	$vocabulary$4 = { "https://json-schema.org/draft/2020-12/vocab/content": true };
	$dynamicAnchor$4 = "meta";
	title$7 = "Content vocabulary meta-schema";
	type$7 = ["object", "boolean"];
	properties$7 = {
		"contentEncoding": { "type": "string" },
		"contentMediaType": { "type": "string" },
		"contentSchema": { "$dynamicRef": "#meta" }
	};
	content_default = {
		$schema: $schema$7,
		$id: $id$7,
		$vocabulary: $vocabulary$4,
		$dynamicAnchor: $dynamicAnchor$4,
		title: title$7,
		type: type$7,
		properties: properties$7
	};
}));
//#endregion
//#region node_modules/ajv/dist/refs/json-schema-2020-12/meta/core.json
var core_exports = /* @__PURE__ */ __exportAll({
	$defs: () => $defs$4,
	$dynamicAnchor: () => $dynamicAnchor$3,
	$id: () => $id$6,
	$schema: () => $schema$6,
	$vocabulary: () => $vocabulary$3,
	default: () => core_default,
	properties: () => properties$6,
	title: () => title$6,
	type: () => type$6
});
var $schema$6, $id$6, $vocabulary$3, $dynamicAnchor$3, title$6, type$6, properties$6, $defs$4, core_default;
var init_core = __esmMin((() => {
	$schema$6 = "https://json-schema.org/draft/2020-12/schema";
	$id$6 = "https://json-schema.org/draft/2020-12/meta/core";
	$vocabulary$3 = { "https://json-schema.org/draft/2020-12/vocab/core": true };
	$dynamicAnchor$3 = "meta";
	title$6 = "Core vocabulary meta-schema";
	type$6 = ["object", "boolean"];
	properties$6 = {
		"$id": {
			"$ref": "#/$defs/uriReferenceString",
			"$comment": "Non-empty fragments not allowed.",
			"pattern": "^[^#]*#?$"
		},
		"$schema": { "$ref": "#/$defs/uriString" },
		"$ref": { "$ref": "#/$defs/uriReferenceString" },
		"$anchor": { "$ref": "#/$defs/anchorString" },
		"$dynamicRef": { "$ref": "#/$defs/uriReferenceString" },
		"$dynamicAnchor": { "$ref": "#/$defs/anchorString" },
		"$vocabulary": {
			"type": "object",
			"propertyNames": { "$ref": "#/$defs/uriString" },
			"additionalProperties": { "type": "boolean" }
		},
		"$comment": { "type": "string" },
		"$defs": {
			"type": "object",
			"additionalProperties": { "$dynamicRef": "#meta" }
		}
	};
	$defs$4 = {
		"anchorString": {
			"type": "string",
			"pattern": "^[A-Za-z_][-A-Za-z0-9._]*$"
		},
		"uriString": {
			"type": "string",
			"format": "uri"
		},
		"uriReferenceString": {
			"type": "string",
			"format": "uri-reference"
		}
	};
	core_default = {
		$schema: $schema$6,
		$id: $id$6,
		$vocabulary: $vocabulary$3,
		$dynamicAnchor: $dynamicAnchor$3,
		title: title$6,
		type: type$6,
		properties: properties$6,
		$defs: $defs$4
	};
}));
//#endregion
//#region node_modules/ajv/dist/refs/json-schema-2020-12/meta/format-annotation.json
var format_annotation_exports = /* @__PURE__ */ __exportAll({
	$dynamicAnchor: () => $dynamicAnchor$2,
	$id: () => $id$5,
	$schema: () => $schema$5,
	$vocabulary: () => $vocabulary$2,
	default: () => format_annotation_default,
	properties: () => properties$5,
	title: () => title$5,
	type: () => type$5
});
var $schema$5, $id$5, $vocabulary$2, $dynamicAnchor$2, title$5, type$5, properties$5, format_annotation_default;
var init_format_annotation = __esmMin((() => {
	$schema$5 = "https://json-schema.org/draft/2020-12/schema";
	$id$5 = "https://json-schema.org/draft/2020-12/meta/format-annotation";
	$vocabulary$2 = { "https://json-schema.org/draft/2020-12/vocab/format-annotation": true };
	$dynamicAnchor$2 = "meta";
	title$5 = "Format vocabulary meta-schema for annotation results";
	type$5 = ["object", "boolean"];
	properties$5 = { "format": { "type": "string" } };
	format_annotation_default = {
		$schema: $schema$5,
		$id: $id$5,
		$vocabulary: $vocabulary$2,
		$dynamicAnchor: $dynamicAnchor$2,
		title: title$5,
		type: type$5,
		properties: properties$5
	};
}));
//#endregion
//#region node_modules/ajv/dist/refs/json-schema-2020-12/meta/meta-data.json
var meta_data_exports = /* @__PURE__ */ __exportAll({
	$dynamicAnchor: () => $dynamicAnchor$1,
	$id: () => $id$4,
	$schema: () => $schema$4,
	$vocabulary: () => $vocabulary$1,
	default: () => meta_data_default,
	properties: () => properties$4,
	title: () => title$4,
	type: () => type$4
});
var $schema$4, $id$4, $vocabulary$1, $dynamicAnchor$1, title$4, type$4, properties$4, meta_data_default;
var init_meta_data = __esmMin((() => {
	$schema$4 = "https://json-schema.org/draft/2020-12/schema";
	$id$4 = "https://json-schema.org/draft/2020-12/meta/meta-data";
	$vocabulary$1 = { "https://json-schema.org/draft/2020-12/vocab/meta-data": true };
	$dynamicAnchor$1 = "meta";
	title$4 = "Meta-data vocabulary meta-schema";
	type$4 = ["object", "boolean"];
	properties$4 = {
		"title": { "type": "string" },
		"description": { "type": "string" },
		"default": true,
		"deprecated": {
			"type": "boolean",
			"default": false
		},
		"readOnly": {
			"type": "boolean",
			"default": false
		},
		"writeOnly": {
			"type": "boolean",
			"default": false
		},
		"examples": {
			"type": "array",
			"items": true
		}
	};
	meta_data_default = {
		$schema: $schema$4,
		$id: $id$4,
		$vocabulary: $vocabulary$1,
		$dynamicAnchor: $dynamicAnchor$1,
		title: title$4,
		type: type$4,
		properties: properties$4
	};
}));
//#endregion
//#region node_modules/ajv/dist/refs/json-schema-2020-12/meta/validation.json
var validation_exports = /* @__PURE__ */ __exportAll({
	$defs: () => $defs$3,
	$dynamicAnchor: () => $dynamicAnchor,
	$id: () => $id$3,
	$schema: () => $schema$3,
	$vocabulary: () => $vocabulary,
	default: () => validation_default,
	properties: () => properties$3,
	title: () => title$3,
	type: () => type$3
});
var $schema$3, $id$3, $vocabulary, $dynamicAnchor, title$3, type$3, properties$3, $defs$3, validation_default;
var init_validation = __esmMin((() => {
	$schema$3 = "https://json-schema.org/draft/2020-12/schema";
	$id$3 = "https://json-schema.org/draft/2020-12/meta/validation";
	$vocabulary = { "https://json-schema.org/draft/2020-12/vocab/validation": true };
	$dynamicAnchor = "meta";
	title$3 = "Validation vocabulary meta-schema";
	type$3 = ["object", "boolean"];
	properties$3 = {
		"type": { "anyOf": [{ "$ref": "#/$defs/simpleTypes" }, {
			"type": "array",
			"items": { "$ref": "#/$defs/simpleTypes" },
			"minItems": 1,
			"uniqueItems": true
		}] },
		"const": true,
		"enum": {
			"type": "array",
			"items": true
		},
		"multipleOf": {
			"type": "number",
			"exclusiveMinimum": 0
		},
		"maximum": { "type": "number" },
		"exclusiveMaximum": { "type": "number" },
		"minimum": { "type": "number" },
		"exclusiveMinimum": { "type": "number" },
		"maxLength": { "$ref": "#/$defs/nonNegativeInteger" },
		"minLength": { "$ref": "#/$defs/nonNegativeIntegerDefault0" },
		"pattern": {
			"type": "string",
			"format": "regex"
		},
		"maxItems": { "$ref": "#/$defs/nonNegativeInteger" },
		"minItems": { "$ref": "#/$defs/nonNegativeIntegerDefault0" },
		"uniqueItems": {
			"type": "boolean",
			"default": false
		},
		"maxContains": { "$ref": "#/$defs/nonNegativeInteger" },
		"minContains": {
			"$ref": "#/$defs/nonNegativeInteger",
			"default": 1
		},
		"maxProperties": { "$ref": "#/$defs/nonNegativeInteger" },
		"minProperties": { "$ref": "#/$defs/nonNegativeIntegerDefault0" },
		"required": { "$ref": "#/$defs/stringArray" },
		"dependentRequired": {
			"type": "object",
			"additionalProperties": { "$ref": "#/$defs/stringArray" }
		}
	};
	$defs$3 = {
		"nonNegativeInteger": {
			"type": "integer",
			"minimum": 0
		},
		"nonNegativeIntegerDefault0": {
			"$ref": "#/$defs/nonNegativeInteger",
			"default": 0
		},
		"simpleTypes": { "enum": [
			"array",
			"boolean",
			"integer",
			"null",
			"number",
			"object",
			"string"
		] },
		"stringArray": {
			"type": "array",
			"items": { "type": "string" },
			"uniqueItems": true,
			"default": []
		}
	};
	validation_default = {
		$schema: $schema$3,
		$id: $id$3,
		$vocabulary,
		$dynamicAnchor,
		title: title$3,
		type: type$3,
		properties: properties$3,
		$defs: $defs$3
	};
}));
//#endregion
//#region node_modules/ajv/dist/refs/json-schema-2020-12/index.js
var require_json_schema_2020_12 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	var metaSchema = (init_schema$1(), __toCommonJS(schema_exports).default);
	var applicator = (init_applicator(), __toCommonJS(applicator_exports).default);
	var unevaluated = (init_unevaluated(), __toCommonJS(unevaluated_exports).default);
	var content = (init_content(), __toCommonJS(content_exports).default);
	var core = (init_core(), __toCommonJS(core_exports).default);
	var format = (init_format_annotation(), __toCommonJS(format_annotation_exports).default);
	var metadata = (init_meta_data(), __toCommonJS(meta_data_exports).default);
	var validation = (init_validation(), __toCommonJS(validation_exports).default);
	var META_SUPPORT_DATA = ["/properties"];
	function addMetaSchema2020($data) {
		[
			metaSchema,
			applicator,
			unevaluated,
			content,
			core,
			with$data(this, format),
			metadata,
			with$data(this, validation)
		].forEach((sch) => this.addMetaSchema(sch, void 0, false));
		return this;
		function with$data(ajv, sch) {
			return $data ? ajv.$dataMetaSchema(sch, META_SUPPORT_DATA) : sch;
		}
	}
	exports.default = addMetaSchema2020;
}));
//#endregion
//#region node_modules/ajv/dist/2020.js
var require__2020 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.MissingRefError = exports.ValidationError = exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = exports.Ajv2020 = void 0;
	var core_1 = require_core$1();
	var draft2020_1 = require_draft2020();
	var discriminator_1 = require_discriminator();
	var json_schema_2020_12_1 = require_json_schema_2020_12();
	var META_SCHEMA_ID = "https://json-schema.org/draft/2020-12/schema";
	var Ajv2020 = class extends core_1.default {
		constructor(opts = {}) {
			super({
				...opts,
				dynamicRef: true,
				next: true,
				unevaluated: true
			});
		}
		_addVocabularies() {
			super._addVocabularies();
			draft2020_1.default.forEach((v) => this.addVocabulary(v));
			if (this.opts.discriminator) this.addKeyword(discriminator_1.default);
		}
		_addDefaultMetaSchema() {
			super._addDefaultMetaSchema();
			const { $data, meta } = this.opts;
			if (!meta) return;
			json_schema_2020_12_1.default.call(this, $data);
			this.refs["http://json-schema.org/schema"] = META_SCHEMA_ID;
		}
		defaultMeta() {
			return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(META_SCHEMA_ID) ? META_SCHEMA_ID : void 0);
		}
	};
	exports.Ajv2020 = Ajv2020;
	module.exports = exports = Ajv2020;
	module.exports.Ajv2020 = Ajv2020;
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = Ajv2020;
	var validate_1 = require_validate();
	Object.defineProperty(exports, "KeywordCxt", {
		enumerable: true,
		get: function() {
			return validate_1.KeywordCxt;
		}
	});
	var codegen_1 = require_codegen();
	Object.defineProperty(exports, "_", {
		enumerable: true,
		get: function() {
			return codegen_1._;
		}
	});
	Object.defineProperty(exports, "str", {
		enumerable: true,
		get: function() {
			return codegen_1.str;
		}
	});
	Object.defineProperty(exports, "stringify", {
		enumerable: true,
		get: function() {
			return codegen_1.stringify;
		}
	});
	Object.defineProperty(exports, "nil", {
		enumerable: true,
		get: function() {
			return codegen_1.nil;
		}
	});
	Object.defineProperty(exports, "Name", {
		enumerable: true,
		get: function() {
			return codegen_1.Name;
		}
	});
	Object.defineProperty(exports, "CodeGen", {
		enumerable: true,
		get: function() {
			return codegen_1.CodeGen;
		}
	});
	var validation_error_1 = require_validation_error();
	Object.defineProperty(exports, "ValidationError", {
		enumerable: true,
		get: function() {
			return validation_error_1.default;
		}
	});
	var ref_error_1 = require_ref_error();
	Object.defineProperty(exports, "MissingRefError", {
		enumerable: true,
		get: function() {
			return ref_error_1.default;
		}
	});
})), $schema$2, $id$2, title$2, type$2, required$2, properties$2, $defs$2, experiment_definition_schema_default;
var init_experiment_definition_schema = __esmMin((() => {
	$schema$2 = "https://json-schema.org/draft/2020-12/schema";
	$id$2 = "https://coding-agent-dashboard.dev/schemas/experiment-runtime/v1/experiment-definition.schema.json";
	title$2 = "ExperimentDefinition v1";
	type$2 = "object";
	required$2 = [
		"schemaVersion",
		"kind",
		"definitionId",
		"definitionVersion",
		"contentDigest",
		"title",
		"description",
		"createdAt",
		"createdBy",
		"portability",
		"studyDesign",
		"workload",
		"requiredCapabilities",
		"treatments",
		"metrics",
		"checks",
		"estimatedUsage",
		"limits",
		"safeguards",
		"verdictPolicy",
		"extensions"
	];
	properties$2 = {
		"schemaVersion": { "const": 1 },
		"kind": { "const": "ExperimentDefinition" },
		"definitionId": { "$ref": "#/$defs/namespacedId" },
		"definitionVersion": {
			"type": "integer",
			"minimum": 1
		},
		"contentDigest": { "$ref": "#/$defs/digest" },
		"title": {
			"type": "string",
			"minLength": 1,
			"maxLength": 256
		},
		"description": {
			"type": "string",
			"minLength": 1,
			"maxLength": 8192
		},
		"createdAt": { "$ref": "#/$defs/timestamp" },
		"createdBy": { "$ref": "#/$defs/opaqueId" },
		"portability": { "oneOf": [{
			"type": "object",
			"additionalProperties": false,
			"required": ["class"],
			"properties": { "class": { "const": "portable" } }
		}, {
			"type": "object",
			"additionalProperties": false,
			"required": ["class", "allowedHarnesses"],
			"properties": {
				"class": { "const": "harness-specific" },
				"allowedHarnesses": {
					"type": "array",
					"minItems": 1,
					"uniqueItems": true,
					"items": { "$ref": "#/$defs/harnessId" }
				}
			}
		}] },
		"studyDesign": { "oneOf": [{
			"type": "object",
			"additionalProperties": false,
			"required": ["kind"],
			"properties": { "kind": { "const": "paired" } }
		}, {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"kind",
				"assignment",
				"minimumRunsPerTreatment"
			],
			"properties": {
				"kind": { "const": "cohort" },
				"assignment": {
					"type": "object",
					"additionalProperties": false,
					"required": ["kind"],
					"properties": { "kind": { "enum": ["explicit", "randomized"] } }
				},
				"minimumRunsPerTreatment": {
					"type": "integer",
					"minimum": 1
				},
				"maximumRunsPerTreatment": {
					"type": "integer",
					"minimum": 1
				}
			}
		}] },
		"workload": {
			"type": "object",
			"additionalProperties": false,
			"required": ["selector"],
			"properties": { "selector": {
				"type": "object",
				"additionalProperties": false,
				"required": [
					"id",
					"version",
					"capability",
					"parameters"
				],
				"properties": {
					"id": { "$ref": "#/$defs/namespacedId" },
					"version": {
						"type": "integer",
						"minimum": 1
					},
					"capability": { "$ref": "#/$defs/capabilityRequirement" },
					"parameters": { "$ref": "#/$defs/jsonObject" }
				}
			} }
		},
		"requiredCapabilities": {
			"type": "array",
			"items": { "$ref": "#/$defs/capabilityRequirement" }
		},
		"treatments": {
			"type": "array",
			"minItems": 2,
			"items": {
				"type": "object",
				"additionalProperties": false,
				"required": [
					"id",
					"label",
					"control",
					"interventions"
				],
				"properties": {
					"id": { "$ref": "#/$defs/localId" },
					"label": {
						"type": "string",
						"minLength": 1,
						"maxLength": 256
					},
					"control": { "type": "boolean" },
					"interventions": {
						"type": "array",
						"items": {
							"type": "object",
							"additionalProperties": false,
							"required": [
								"capability",
								"operation",
								"value"
							],
							"properties": {
								"capability": { "$ref": "#/$defs/capabilityRequirement" },
								"operation": { "$ref": "#/$defs/localId" },
								"value": { "$ref": "#/$defs/jsonValue" }
							}
						}
					}
				}
			}
		},
		"metrics": {
			"type": "array",
			"minItems": 1,
			"items": {
				"type": "object",
				"additionalProperties": false,
				"required": [
					"id",
					"unit",
					"scope",
					"basis",
					"semanticsVersion",
					"collector"
				],
				"properties": {
					"id": { "$ref": "#/$defs/namespacedId" },
					"unit": { "$ref": "#/$defs/localId" },
					"scope": { "enum": ["run", "subject"] },
					"basis": { "$ref": "#/$defs/namespacedId" },
					"semanticsVersion": {
						"type": "integer",
						"minimum": 1
					},
					"collector": {
						"type": "object",
						"additionalProperties": false,
						"required": [
							"capability",
							"operation",
							"parameters"
						],
						"properties": {
							"capability": { "$ref": "#/$defs/capabilityRequirement" },
							"operation": { "$ref": "#/$defs/localId" },
							"parameters": { "$ref": "#/$defs/jsonObject" }
						}
					}
				}
			}
		},
		"checks": {
			"type": "array",
			"items": {
				"type": "object",
				"additionalProperties": false,
				"required": [
					"id",
					"capability",
					"operation",
					"parameters"
				],
				"properties": {
					"id": { "$ref": "#/$defs/namespacedId" },
					"capability": { "$ref": "#/$defs/capabilityRequirement" },
					"operation": { "$ref": "#/$defs/localId" },
					"parameters": { "$ref": "#/$defs/jsonObject" }
				}
			}
		},
		"estimatedUsage": { "$ref": "#/$defs/usageBounds" },
		"limits": { "$ref": "#/$defs/usageBounds" },
		"safeguards": {
			"type": "object",
			"additionalProperties": false,
			"required": ["policy", "relaxationRequests"],
			"properties": {
				"policy": { "$ref": "#/$defs/semanticsRef" },
				"relaxationRequests": {
					"type": "array",
					"items": {
						"type": "object",
						"additionalProperties": false,
						"required": [
							"requestId",
							"safeguard",
							"requestedValue",
							"reason"
						],
						"properties": {
							"requestId": { "$ref": "#/$defs/localId" },
							"safeguard": { "$ref": "#/$defs/namespacedId" },
							"requestedValue": { "$ref": "#/$defs/jsonValue" },
							"reason": {
								"type": "string",
								"minLength": 1,
								"maxLength": 2048
							}
						}
					}
				}
			}
		},
		"verdictPolicy": {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"id",
				"version",
				"contentDigest",
				"parameters"
			],
			"properties": {
				"id": { "$ref": "#/$defs/namespacedId" },
				"version": {
					"type": "integer",
					"minimum": 1
				},
				"contentDigest": { "$ref": "#/$defs/digest" },
				"parameters": { "$ref": "#/$defs/jsonObject" }
			}
		},
		"extensions": { "$ref": "#/$defs/extensions" }
	};
	$defs$2 = {
		"digest": {
			"type": "string",
			"pattern": "^sha256:[0-9a-f]{64}$"
		},
		"timestamp": {
			"type": "string",
			"pattern": "^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?Z$"
		},
		"localId": {
			"type": "string",
			"pattern": "^[a-z0-9][a-z0-9._-]{0,127}$"
		},
		"namespacedId": {
			"type": "string",
			"pattern": "^[a-z0-9][a-z0-9_-]*(?:[./][a-z0-9][a-z0-9._-]*)+$"
		},
		"opaqueId": {
			"type": "string",
			"minLength": 1,
			"maxLength": 256,
			"pattern": "^[A-Za-z0-9][A-Za-z0-9._:/@-]*$"
		},
		"harnessId": {
			"type": "string",
			"pattern": "^[a-z][a-z0-9-]{0,63}$"
		},
		"jsonValue": { "oneOf": [
			{ "type": "null" },
			{ "type": "boolean" },
			{ "type": "number" },
			{ "type": "string" },
			{
				"type": "array",
				"items": { "$ref": "#/$defs/jsonValue" }
			},
			{
				"type": "object",
				"additionalProperties": { "$ref": "#/$defs/jsonValue" }
			}
		] },
		"jsonObject": {
			"type": "object",
			"additionalProperties": { "$ref": "#/$defs/jsonValue" }
		},
		"extensions": {
			"type": "object",
			"propertyNames": { "pattern": "^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/[A-Za-z0-9][A-Za-z0-9._-]*$" },
			"additionalProperties": { "$ref": "#/$defs/jsonValue" }
		},
		"semanticsRef": {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"id",
				"version",
				"contentDigest"
			],
			"properties": {
				"id": { "$ref": "#/$defs/namespacedId" },
				"version": {
					"type": "integer",
					"minimum": 1
				},
				"contentDigest": { "$ref": "#/$defs/digest" }
			}
		},
		"capabilityRequirement": {
			"type": "object",
			"additionalProperties": false,
			"required": ["semanticsRef"],
			"properties": { "semanticsRef": { "$ref": "#/$defs/semanticsRef" } }
		},
		"usageBounds": {
			"type": "object",
			"additionalProperties": false,
			"properties": {
				"wallTimeMs": {
					"type": "integer",
					"minimum": 0
				},
				"totalTokens": {
					"type": "integer",
					"minimum": 0
				},
				"turns": {
					"type": "integer",
					"minimum": 0
				},
				"toolCalls": {
					"type": "integer",
					"minimum": 0
				},
				"costUsd": {
					"type": "number",
					"minimum": 0
				}
			}
		}
	};
	experiment_definition_schema_default = {
		$schema: $schema$2,
		$id: $id$2,
		title: title$2,
		type: type$2,
		additionalProperties: false,
		required: required$2,
		properties: properties$2,
		$defs: $defs$2
	};
})), $schema$1, $id$1, title$1, type$1, required$1, properties$1, $defs$1, experiment_run_schema_default;
var init_experiment_run_schema = __esmMin((() => {
	$schema$1 = "https://json-schema.org/draft/2020-12/schema";
	$id$1 = "https://coding-agent-dashboard.dev/schemas/experiment-runtime/v1/experiment-run.schema.json";
	title$1 = "ExperimentRun v1";
	type$1 = "object";
	required$1 = [
		"schemaVersion",
		"kind",
		"runId",
		"trialId",
		"contentDigest",
		"definitionRef",
		"treatmentId",
		"retryOf",
		"status",
		"createdAt",
		"startedAt",
		"finishedAt",
		"subjectRef",
		"assignment",
		"selectedHarness",
		"harnessProvenance",
		"selectionRef",
		"triggerRef",
		"behaviorFingerprint",
		"capabilitySnapshot",
		"effectiveLimits",
		"safeguardAuthorizations",
		"sessionRef",
		"observations",
		"checkResults",
		"usage",
		"error",
		"extensions"
	];
	properties$1 = {
		"schemaVersion": { "const": 1 },
		"kind": { "const": "ExperimentRun" },
		"runId": { "$ref": "#/$defs/uuid" },
		"trialId": { "$ref": "#/$defs/uuid" },
		"contentDigest": { "$ref": "#/$defs/digest" },
		"definitionRef": { "$ref": "#/$defs/definitionRef" },
		"treatmentId": { "$ref": "#/$defs/localId" },
		"retryOf": { "oneOf": [{ "type": "null" }, { "$ref": "#/$defs/runRef" }] },
		"status": { "enum": [
			"succeeded",
			"failed",
			"cancelled"
		] },
		"createdAt": { "$ref": "#/$defs/timestamp" },
		"startedAt": { "$ref": "#/$defs/timestamp" },
		"finishedAt": { "$ref": "#/$defs/timestamp" },
		"subjectRef": { "$ref": "#/$defs/artifactRef" },
		"assignment": { "oneOf": [
			{
				"type": "object",
				"additionalProperties": false,
				"required": ["kind"],
				"properties": { "kind": { "const": "paired" } }
			},
			{
				"type": "object",
				"additionalProperties": false,
				"required": ["kind"],
				"properties": { "kind": { "const": "explicit" } }
			},
			{
				"type": "object",
				"additionalProperties": false,
				"required": ["kind", "seed"],
				"properties": {
					"kind": { "const": "randomized" },
					"seed": {
						"type": "string",
						"minLength": 16,
						"maxLength": 256,
						"pattern": "^[A-Za-z0-9_-]+$"
					}
				}
			}
		] },
		"selectedHarness": { "$ref": "#/$defs/harnessId" },
		"harnessProvenance": {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"origin",
				"driver",
				"worker",
				"judge"
			],
			"properties": {
				"origin": { "$ref": "#/$defs/harnessId" },
				"driver": { "$ref": "#/$defs/harnessId" },
				"worker": { "$ref": "#/$defs/harnessId" },
				"judge": { "$ref": "#/$defs/harnessId" }
			}
		},
		"selectionRef": {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"receiptId",
				"receiptDigest",
				"planSlotId"
			],
			"properties": {
				"receiptId": { "$ref": "#/$defs/uuid" },
				"receiptDigest": { "$ref": "#/$defs/digest" },
				"planSlotId": { "$ref": "#/$defs/localId" }
			}
		},
		"triggerRef": { "oneOf": [{ "type": "null" }, {
			"type": "object",
			"additionalProperties": false,
			"required": ["receiptId", "receiptDigest"],
			"properties": {
				"receiptId": { "$ref": "#/$defs/uuid" },
				"receiptDigest": { "$ref": "#/$defs/digest" }
			}
		}] },
		"behaviorFingerprint": { "$ref": "#/$defs/behaviorFingerprint" },
		"capabilitySnapshot": {
			"type": "array",
			"minItems": 1,
			"items": { "$ref": "#/$defs/capabilityCertification" }
		},
		"effectiveLimits": { "$ref": "#/$defs/usageBounds" },
		"safeguardAuthorizations": {
			"type": "array",
			"items": {
				"type": "object",
				"additionalProperties": false,
				"required": [
					"requestId",
					"approvedBy",
					"approvedAt",
					"reason"
				],
				"properties": {
					"requestId": { "$ref": "#/$defs/localId" },
					"approvedBy": { "$ref": "#/$defs/opaqueId" },
					"approvedAt": { "$ref": "#/$defs/timestamp" },
					"reason": {
						"type": "string",
						"minLength": 1,
						"maxLength": 2048
					}
				}
			}
		},
		"sessionRef": { "$ref": "#/$defs/sessionRef" },
		"observations": {
			"type": "array",
			"items": {
				"type": "object",
				"additionalProperties": false,
				"required": [
					"metricId",
					"value",
					"unit",
					"scope",
					"basis",
					"semanticsVersion",
					"confidence",
					"observedAt",
					"evidenceRefs"
				],
				"properties": {
					"metricId": { "$ref": "#/$defs/namespacedId" },
					"value": { "type": "number" },
					"unit": { "$ref": "#/$defs/localId" },
					"scope": { "enum": ["run", "subject"] },
					"basis": { "$ref": "#/$defs/namespacedId" },
					"semanticsVersion": {
						"type": "integer",
						"minimum": 1
					},
					"confidence": { "enum": [
						"high",
						"medium",
						"low"
					] },
					"observedAt": { "$ref": "#/$defs/timestamp" },
					"evidenceRefs": {
						"type": "array",
						"minItems": 1,
						"items": { "$ref": "#/$defs/evidenceRef" }
					}
				}
			}
		},
		"checkResults": {
			"type": "array",
			"items": {
				"type": "object",
				"additionalProperties": false,
				"required": [
					"checkId",
					"outcome",
					"startedAt",
					"finishedAt",
					"evidenceRefs"
				],
				"properties": {
					"checkId": { "$ref": "#/$defs/namespacedId" },
					"outcome": { "enum": [
						"passed",
						"failed",
						"skipped"
					] },
					"startedAt": { "$ref": "#/$defs/timestamp" },
					"finishedAt": { "$ref": "#/$defs/timestamp" },
					"evidenceRefs": {
						"type": "array",
						"minItems": 1,
						"items": { "$ref": "#/$defs/evidenceRef" }
					}
				}
			}
		},
		"usage": { "$ref": "#/$defs/usageBounds" },
		"error": { "oneOf": [{ "type": "null" }, {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"code",
				"message",
				"evidenceRefs"
			],
			"properties": {
				"code": { "$ref": "#/$defs/namespacedId" },
				"message": {
					"type": "string",
					"minLength": 1,
					"maxLength": 4096
				},
				"evidenceRefs": {
					"type": "array",
					"minItems": 1,
					"items": { "$ref": "#/$defs/evidenceRef" }
				}
			}
		}] },
		"extensions": { "$ref": "#/$defs/extensions" }
	};
	$defs$1 = {
		"digest": {
			"type": "string",
			"pattern": "^sha256:[0-9a-f]{64}$"
		},
		"uuid": {
			"type": "string",
			"pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
		},
		"timestamp": {
			"type": "string",
			"pattern": "^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?Z$"
		},
		"localId": {
			"type": "string",
			"pattern": "^[a-z0-9][a-z0-9._-]{0,127}$"
		},
		"namespacedId": {
			"type": "string",
			"pattern": "^[a-z0-9][a-z0-9_-]*(?:[./][a-z0-9][a-z0-9._-]*)+$"
		},
		"opaqueId": {
			"type": "string",
			"minLength": 1,
			"maxLength": 256,
			"pattern": "^[A-Za-z0-9][A-Za-z0-9._:/@-]*$"
		},
		"harnessId": {
			"type": "string",
			"pattern": "^[a-z][a-z0-9-]{0,63}$"
		},
		"jsonValue": { "oneOf": [
			{ "type": "null" },
			{ "type": "boolean" },
			{ "type": "number" },
			{ "type": "string" },
			{
				"type": "array",
				"items": { "$ref": "#/$defs/jsonValue" }
			},
			{
				"type": "object",
				"additionalProperties": { "$ref": "#/$defs/jsonValue" }
			}
		] },
		"extensions": {
			"type": "object",
			"propertyNames": { "pattern": "^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/[A-Za-z0-9][A-Za-z0-9._-]*$" },
			"additionalProperties": { "$ref": "#/$defs/jsonValue" }
		},
		"semanticsRef": {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"id",
				"version",
				"contentDigest"
			],
			"properties": {
				"id": { "$ref": "#/$defs/namespacedId" },
				"version": {
					"type": "integer",
					"minimum": 1
				},
				"contentDigest": { "$ref": "#/$defs/digest" }
			}
		},
		"definitionRef": {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"definitionId",
				"definitionVersion",
				"contentDigest"
			],
			"properties": {
				"definitionId": { "$ref": "#/$defs/namespacedId" },
				"definitionVersion": {
					"type": "integer",
					"minimum": 1
				},
				"contentDigest": { "$ref": "#/$defs/digest" }
			}
		},
		"runRef": {
			"type": "object",
			"additionalProperties": false,
			"required": ["runId", "contentDigest"],
			"properties": {
				"runId": { "$ref": "#/$defs/uuid" },
				"contentDigest": { "$ref": "#/$defs/digest" }
			}
		},
		"sessionRef": {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"harness",
				"sourceId",
				"sessionId"
			],
			"properties": {
				"harness": { "$ref": "#/$defs/harnessId" },
				"sourceId": { "$ref": "#/$defs/opaqueId" },
				"sessionId": { "$ref": "#/$defs/opaqueId" }
			}
		},
		"artifactRef": {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"harness",
				"sourceId",
				"artifactId",
				"contentDigest"
			],
			"properties": {
				"harness": { "$ref": "#/$defs/harnessId" },
				"sourceId": { "$ref": "#/$defs/opaqueId" },
				"artifactId": { "$ref": "#/$defs/opaqueId" },
				"contentDigest": { "$ref": "#/$defs/digest" },
				"mediaType": {
					"type": "string",
					"minLength": 1,
					"maxLength": 256
				}
			}
		},
		"evidenceRef": { "oneOf": [{
			"type": "object",
			"additionalProperties": false,
			"required": [
				"kind",
				"contentDigest",
				"sessionRef"
			],
			"properties": {
				"kind": { "const": "session" },
				"contentDigest": { "$ref": "#/$defs/digest" },
				"sessionRef": { "$ref": "#/$defs/sessionRef" }
			}
		}, {
			"type": "object",
			"additionalProperties": false,
			"required": ["kind", "artifactRef"],
			"properties": {
				"kind": { "const": "artifact" },
				"artifactRef": { "$ref": "#/$defs/artifactRef" }
			}
		}] },
		"capabilityCertification": {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"semanticsRef",
				"state",
				"observedAt"
			],
			"properties": {
				"semanticsRef": { "$ref": "#/$defs/semanticsRef" },
				"state": { "enum": [
					"available",
					"unavailable",
					"disabled",
					"unsupported",
					"stale"
				] },
				"observedAt": { "$ref": "#/$defs/timestamp" },
				"validUntil": { "$ref": "#/$defs/timestamp" }
			}
		},
		"behaviorFingerprint": {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"schemaVersion",
				"policy",
				"digest",
				"observedAt",
				"completeness",
				"runtime",
				"adapter",
				"model",
				"factors"
			],
			"properties": {
				"schemaVersion": { "const": 1 },
				"policy": {
					"type": "object",
					"additionalProperties": false,
					"required": ["id", "version"],
					"properties": {
						"id": { "$ref": "#/$defs/namespacedId" },
						"version": {
							"type": "integer",
							"minimum": 1
						}
					}
				},
				"digest": { "$ref": "#/$defs/digest" },
				"observedAt": { "$ref": "#/$defs/timestamp" },
				"completeness": { "enum": ["complete", "incomplete"] },
				"runtime": {
					"type": "object",
					"additionalProperties": false,
					"required": ["id", "behaviorVersion"],
					"properties": {
						"id": { "$ref": "#/$defs/namespacedId" },
						"behaviorVersion": {
							"type": "string",
							"minLength": 1,
							"maxLength": 128
						}
					}
				},
				"adapter": {
					"type": "object",
					"additionalProperties": false,
					"required": [
						"id",
						"behaviorVersion",
						"fingerprintSchemaVersion"
					],
					"properties": {
						"id": { "$ref": "#/$defs/opaqueId" },
						"behaviorVersion": {
							"type": "string",
							"minLength": 1,
							"maxLength": 128
						},
						"fingerprintSchemaVersion": {
							"type": "integer",
							"minimum": 1
						}
					}
				},
				"model": {
					"type": "object",
					"additionalProperties": false,
					"required": ["qualifiedId"],
					"properties": {
						"qualifiedId": { "$ref": "#/$defs/namespacedId" },
						"revision": {
							"type": "string",
							"minLength": 1,
							"maxLength": 256
						}
					}
				},
				"factors": {
					"type": "array",
					"items": {
						"type": "object",
						"additionalProperties": false,
						"required": ["id", "valueDigest"],
						"properties": {
							"id": { "$ref": "#/$defs/namespacedId" },
							"valueDigest": { "$ref": "#/$defs/digest" },
							"displayValue": {
								"type": "string",
								"minLength": 1,
								"maxLength": 128
							}
						}
					}
				}
			}
		},
		"usageBounds": {
			"type": "object",
			"additionalProperties": false,
			"properties": {
				"wallTimeMs": {
					"type": "integer",
					"minimum": 0
				},
				"totalTokens": {
					"type": "integer",
					"minimum": 0
				},
				"turns": {
					"type": "integer",
					"minimum": 0
				},
				"toolCalls": {
					"type": "integer",
					"minimum": 0
				},
				"costUsd": {
					"type": "number",
					"minimum": 0
				}
			}
		}
	};
	experiment_run_schema_default = {
		$schema: $schema$1,
		$id: $id$1,
		title: title$1,
		type: type$1,
		additionalProperties: false,
		required: required$1,
		properties: properties$1,
		$defs: $defs$1
	};
})), $schema, $id, title, type, required, properties, $defs, experiment_verdict_schema_default;
var init_experiment_verdict_schema = __esmMin((() => {
	$schema = "https://json-schema.org/draft/2020-12/schema";
	$id = "https://coding-agent-dashboard.dev/schemas/experiment-runtime/v1/experiment-verdict.schema.json";
	title = "ExperimentVerdict v1";
	type = "object";
	required = [
		"schemaVersion",
		"kind",
		"verdictId",
		"trialId",
		"contentDigest",
		"definitionRef",
		"policy",
		"evidence",
		"outcome",
		"policyResult",
		"evidenceBasis",
		"primaryEffect",
		"judge",
		"createdAt",
		"updatedAt",
		"updateReason",
		"extensions"
	];
	properties = {
		"schemaVersion": { "const": 1 },
		"kind": { "const": "ExperimentVerdict" },
		"verdictId": { "$ref": "#/$defs/uuid" },
		"trialId": { "$ref": "#/$defs/uuid" },
		"contentDigest": { "$ref": "#/$defs/digest" },
		"definitionRef": { "$ref": "#/$defs/definitionRef" },
		"policy": { "$ref": "#/$defs/semanticsRef" },
		"evidence": {
			"type": "object",
			"additionalProperties": false,
			"required": ["includedRuns", "excludedRuns"],
			"properties": {
				"includedRuns": {
					"type": "array",
					"items": { "$ref": "#/$defs/runRef" }
				},
				"excludedRuns": {
					"type": "array",
					"items": {
						"type": "object",
						"additionalProperties": false,
						"required": ["run", "reason"],
						"properties": {
							"run": { "$ref": "#/$defs/runRef" },
							"reason": { "$ref": "#/$defs/namespacedId" }
						}
					}
				}
			}
		},
		"outcome": { "oneOf": [
			{
				"type": "object",
				"additionalProperties": false,
				"required": ["kind", "winningTreatmentId"],
				"properties": {
					"kind": { "const": "winner" },
					"winningTreatmentId": { "$ref": "#/$defs/localId" }
				}
			},
			{
				"type": "object",
				"additionalProperties": false,
				"required": ["kind"],
				"properties": { "kind": { "const": "tie" } }
			},
			{
				"type": "object",
				"additionalProperties": false,
				"required": ["kind", "reason"],
				"properties": {
					"kind": { "const": "inconclusive" },
					"reason": { "$ref": "#/$defs/namespacedId" }
				}
			},
			{
				"type": "object",
				"additionalProperties": false,
				"required": ["kind", "reason"],
				"properties": {
					"kind": { "const": "invalid" },
					"reason": { "$ref": "#/$defs/namespacedId" }
				}
			}
		] },
		"policyResult": {
			"type": "object",
			"additionalProperties": false,
			"required": ["basis", "parameters"],
			"properties": {
				"basis": { "$ref": "#/$defs/namespacedId" },
				"parameters": { "$ref": "#/$defs/jsonObject" }
			}
		},
		"evidenceBasis": {
			"type": "object",
			"additionalProperties": false,
			"required": ["evidenceHarness", "satisfiedCapabilitySemantics"],
			"properties": {
				"evidenceHarness": { "$ref": "#/$defs/harnessId" },
				"satisfiedCapabilitySemantics": {
					"type": "array",
					"items": { "$ref": "#/$defs/semanticsRef" }
				}
			}
		},
		"primaryEffect": { "oneOf": [{ "type": "null" }, { "$ref": "#/$defs/primaryEffect" }] },
		"judge": {
			"type": "object",
			"additionalProperties": false,
			"required": ["harness", "sessionRef"],
			"properties": {
				"harness": { "$ref": "#/$defs/harnessId" },
				"sessionRef": { "$ref": "#/$defs/sessionRef" }
			}
		},
		"createdAt": { "$ref": "#/$defs/timestamp" },
		"updatedAt": { "$ref": "#/$defs/timestamp" },
		"updateReason": {
			"type": "string",
			"minLength": 1,
			"maxLength": 2048
		},
		"extensions": { "$ref": "#/$defs/extensions" }
	};
	$defs = {
		"digest": {
			"type": "string",
			"pattern": "^sha256:[0-9a-f]{64}$"
		},
		"uuid": {
			"type": "string",
			"pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
		},
		"timestamp": {
			"type": "string",
			"pattern": "^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?Z$"
		},
		"localId": {
			"type": "string",
			"pattern": "^[a-z0-9][a-z0-9._-]{0,127}$"
		},
		"namespacedId": {
			"type": "string",
			"pattern": "^[a-z0-9][a-z0-9_-]*(?:[./][a-z0-9][a-z0-9._-]*)+$"
		},
		"opaqueId": {
			"type": "string",
			"minLength": 1,
			"maxLength": 256,
			"pattern": "^[A-Za-z0-9][A-Za-z0-9._:/@-]*$"
		},
		"harnessId": {
			"type": "string",
			"pattern": "^[a-z][a-z0-9-]{0,63}$"
		},
		"jsonValue": { "oneOf": [
			{ "type": "null" },
			{ "type": "boolean" },
			{ "type": "number" },
			{ "type": "string" },
			{
				"type": "array",
				"items": { "$ref": "#/$defs/jsonValue" }
			},
			{
				"type": "object",
				"additionalProperties": { "$ref": "#/$defs/jsonValue" }
			}
		] },
		"jsonObject": {
			"type": "object",
			"additionalProperties": { "$ref": "#/$defs/jsonValue" }
		},
		"extensions": {
			"type": "object",
			"propertyNames": { "pattern": "^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/[A-Za-z0-9][A-Za-z0-9._-]*$" },
			"additionalProperties": { "$ref": "#/$defs/jsonValue" }
		},
		"semanticsRef": {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"id",
				"version",
				"contentDigest"
			],
			"properties": {
				"id": { "$ref": "#/$defs/namespacedId" },
				"version": {
					"type": "integer",
					"minimum": 1
				},
				"contentDigest": { "$ref": "#/$defs/digest" }
			}
		},
		"definitionRef": {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"definitionId",
				"definitionVersion",
				"contentDigest"
			],
			"properties": {
				"definitionId": { "$ref": "#/$defs/namespacedId" },
				"definitionVersion": {
					"type": "integer",
					"minimum": 1
				},
				"contentDigest": { "$ref": "#/$defs/digest" }
			}
		},
		"runRef": {
			"type": "object",
			"additionalProperties": false,
			"required": ["runId", "contentDigest"],
			"properties": {
				"runId": { "$ref": "#/$defs/uuid" },
				"contentDigest": { "$ref": "#/$defs/digest" }
			}
		},
		"sessionRef": {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"harness",
				"sourceId",
				"sessionId"
			],
			"properties": {
				"harness": { "$ref": "#/$defs/harnessId" },
				"sourceId": { "$ref": "#/$defs/opaqueId" },
				"sessionId": { "$ref": "#/$defs/opaqueId" }
			}
		},
		"primaryEffect": {
			"type": "object",
			"additionalProperties": false,
			"required": [
				"contrast",
				"metricRef",
				"estimator",
				"scale",
				"unit",
				"estimate",
				"uncertainty",
				"sampleCounts"
			],
			"properties": {
				"contrast": {
					"type": "object",
					"additionalProperties": false,
					"required": ["controlTreatmentId", "treatmentId"],
					"properties": {
						"controlTreatmentId": { "$ref": "#/$defs/localId" },
						"treatmentId": { "$ref": "#/$defs/localId" }
					}
				},
				"metricRef": {
					"type": "object",
					"additionalProperties": false,
					"required": ["id", "semanticsVersion"],
					"properties": {
						"id": { "$ref": "#/$defs/namespacedId" },
						"semanticsVersion": {
							"type": "integer",
							"minimum": 1
						}
					}
				},
				"estimator": {
					"type": "object",
					"additionalProperties": false,
					"required": ["id", "version"],
					"properties": {
						"id": { "$ref": "#/$defs/namespacedId" },
						"version": {
							"type": "integer",
							"minimum": 1
						}
					}
				},
				"scale": { "enum": ["absolute", "relative"] },
				"unit": { "$ref": "#/$defs/localId" },
				"estimate": { "type": "number" },
				"uncertainty": { "oneOf": [{
					"type": "object",
					"additionalProperties": false,
					"required": [
						"kind",
						"level",
						"lower",
						"upper"
					],
					"properties": {
						"kind": { "const": "interval" },
						"level": {
							"type": "number",
							"exclusiveMinimum": 0,
							"exclusiveMaximum": 1
						},
						"lower": { "type": "number" },
						"upper": { "type": "number" }
					}
				}, {
					"type": "object",
					"additionalProperties": false,
					"required": ["kind", "reason"],
					"properties": {
						"kind": { "const": "not-estimated" },
						"reason": { "$ref": "#/$defs/namespacedId" }
					}
				}] },
				"sampleCounts": {
					"type": "array",
					"minItems": 2,
					"items": {
						"type": "object",
						"additionalProperties": false,
						"required": ["treatmentId", "n"],
						"properties": {
							"treatmentId": { "$ref": "#/$defs/localId" },
							"n": {
								"type": "integer",
								"minimum": 0
							}
						}
					}
				}
			}
		}
	};
	experiment_verdict_schema_default = {
		$schema,
		$id,
		title,
		type,
		additionalProperties: false,
		required,
		properties,
		$defs
	};
}));
//#endregion
//#region src/lib/experiment-runtime/contracts/v1/schema.ts
function freezeDeep$1(value, seen = /* @__PURE__ */ new WeakSet()) {
	if (value === null || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	for (const child of Object.values(value)) freezeDeep$1(child, seen);
	Object.freeze(value);
}
function kebabKeyword(keyword) {
	return keyword.replaceAll(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}
function issuePath(error) {
	const base = `$${error.instancePath}`;
	if (error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string") return `${base}/${error.params.additionalProperty}`;
	if (error.keyword === "required" && typeof error.params.missingProperty === "string") return `${base}/${error.params.missingProperty}`;
	return base;
}
function schemaIssues(errors) {
	return (errors ?? []).map((error) => ({
		code: `schema.${kebabKeyword(error.keyword)}`,
		path: issuePath(error),
		message: error.message ?? `failed ${error.keyword}`
	}));
}
function validateContractSchema(value, kind) {
	const validator = contractValidators[kind];
	return validator(value) ? [] : schemaIssues(validator.errors);
}
/** Validate a registry-owned value with full strict Draft 2020-12 semantics. */
function validateRegistrySchema(value, schema) {
	try {
		let validator = typeof schema === "boolean" ? registryBooleanValidators.get(schema) : registryValidators.get(schema);
		if (!validator) {
			validator = new import__2020.default({
				allErrors: true,
				strict: true
			}).compile(schema);
			if (typeof schema === "boolean") registryBooleanValidators.set(schema, validator);
			else registryValidators.set(schema, validator);
		}
		if (validator.$async === true) return {
			issues: [],
			schemaError: "async registry schemas are not supported"
		};
		return { issues: validator(value) ? [] : schemaIssues(validator.errors) };
	} catch (error) {
		return {
			issues: [],
			schemaError: error instanceof Error ? error.message : String(error)
		};
	}
}
var import__2020, EXPERIMENT_CONTRACT_SCHEMAS_V1, ajv, contractValidators, registryValidators, registryBooleanValidators;
var init_schema = __esmMin((() => {
	import__2020 = /* @__PURE__ */ __toESM(require__2020(), 1);
	init_experiment_definition_schema();
	init_experiment_run_schema();
	init_experiment_verdict_schema();
	EXPERIMENT_CONTRACT_SCHEMAS_V1 = {
		ExperimentDefinition: experiment_definition_schema_default,
		ExperimentRun: experiment_run_schema_default,
		ExperimentVerdict: experiment_verdict_schema_default
	};
	freezeDeep$1(EXPERIMENT_CONTRACT_SCHEMAS_V1);
	ajv = new import__2020.default({
		allErrors: true,
		strict: true
	});
	contractValidators = {
		ExperimentDefinition: ajv.compile(EXPERIMENT_CONTRACT_SCHEMAS_V1.ExperimentDefinition),
		ExperimentRun: ajv.compile(EXPERIMENT_CONTRACT_SCHEMAS_V1.ExperimentRun),
		ExperimentVerdict: ajv.compile(EXPERIMENT_CONTRACT_SCHEMAS_V1.ExperimentVerdict)
	};
	registryValidators = /* @__PURE__ */ new WeakMap();
	registryBooleanValidators = /* @__PURE__ */ new Map();
}));
//#endregion
//#region src/lib/experiment-runtime/contracts/v1/codec.ts
function add(issues, stage, code, path, message) {
	issues.push({
		stage,
		code,
		path,
		message
	});
}
function sameSemantics(left, right) {
	return left.id === right.id && left.version === right.version && left.contentDigest === right.contentDigest;
}
function semanticsKey(ref) {
	return `${ref.id}\u0000${ref.version}\u0000${ref.contentDigest}`;
}
function sameDefinitionRef(left, right) {
	return left.definitionId === right.definitionId && left.definitionVersion === right.definitionVersion && left.contentDigest === right.contentDigest;
}
function definitionRef$1(definition) {
	return {
		definitionId: definition.definitionId,
		definitionVersion: definition.definitionVersion,
		contentDigest: definition.contentDigest
	};
}
function timestamp(value, path, issues) {
	const parsed = Date.parse(value);
	const parts = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
	const year = Number(parts?.[1]);
	const month = Number(parts?.[2]);
	const day = Number(parts?.[3]);
	const monthLengths = [
		31,
		year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31
	];
	const daysInMonth = month >= 1 && month <= 12 ? monthLengths[month - 1] : 0;
	if (!Number.isFinite(parsed) || !parts || day < 1 || day > daysInMonth) add(issues, "intrinsic", "timestamp.invalid", path, "timestamp is not a real UTC instant");
	return parsed;
}
/** Compare structurally valid fixed-offset UTC timestamps without truncating fractions. */
function compareUtcTimestamps(left, right) {
	const leftSecond = left.slice(0, 19);
	const rightSecond = right.slice(0, 19);
	if (leftSecond !== rightSecond) return leftSecond < rightSecond ? -1 : 1;
	const leftFraction = /\.([0-9]+)Z$/.exec(left)?.[1] ?? "";
	const rightFraction = /\.([0-9]+)Z$/.exec(right)?.[1] ?? "";
	const width = Math.max(leftFraction.length, rightFraction.length);
	const normalizedLeft = leftFraction.padEnd(width, "0");
	const normalizedRight = rightFraction.padEnd(width, "0");
	return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1;
}
function requireOrder(values, issues) {
	let priorValue;
	let priorParsed = Number.NEGATIVE_INFINITY;
	for (const item of values) {
		const current = timestamp(item.value, item.path, issues);
		if (priorValue !== void 0 && Number.isFinite(current) && Number.isFinite(priorParsed) && compareUtcTimestamps(item.value, priorValue) < 0) add(issues, "intrinsic", "timestamp.out-of-order", item.path, "timestamp precedes the prior lifecycle timestamp");
		priorValue = item.value;
		priorParsed = current;
	}
}
function requireUnique(values, identity, path, code, issues) {
	const seen = /* @__PURE__ */ new Set();
	for (let index = 0; index < values.length; index++) {
		const key = identity(values[index]);
		if (seen.has(key)) add(issues, "intrinsic", code, `${path}/${index}`, `duplicate identity ${JSON.stringify(key)}`);
		seen.add(key);
	}
}
function checkDigest(document, issues, path = "$/contentDigest") {
	const expected = computeDocumentDigest(document);
	if (document.contentDigest !== expected) add(issues, "intrinsic", "document.digest-mismatch", path, `contentDigest does not match canonical document bytes (expected ${expected})`);
}
function registryEntry(registry, ref) {
	return registry.semantics.find((candidate) => sameSemantics(candidate, ref));
}
function validateRegistryRef(ref, path, registry, portable, issues) {
	const exact = registryEntry(registry, ref);
	if (!exact) {
		const sameIdentity = registry.semantics.find((candidate) => candidate.id === ref.id && candidate.version === ref.version);
		add(issues, "definition-registry", sameIdentity ? "semantics.digest-mismatch" : "semantics.unregistered", path, sameIdentity ? "the registered semantics digest does not match the exact reference" : "the exact semantics reference is not registered");
		return;
	}
	if (portable && exact.portability !== "portable") add(issues, "definition-registry", "semantics.not-portable", path, "portable Definitions may reference only portable semantics");
}
function validateRegisteredValue(value, schema, path, code, issues) {
	const validation = validateRegistrySchema(value, schema);
	if (validation.schemaError) {
		add(issues, "definition-registry", "registry.schema-invalid", path, validation.schemaError);
		return;
	}
	for (const schemaIssue of validation.issues) add(issues, "definition-registry", code, `${path}${schemaIssue.path === "$" ? "" : schemaIssue.path.slice(1)}`, schemaIssue.message);
}
function registeredOperation(registry, ref, role, operation) {
	const operations = registryEntry(registry, ref)?.[role];
	return operations && Object.hasOwn(operations, operation) ? operations[operation] : void 0;
}
function capabilityRefs(definition) {
	const refs = [];
	const push = (requirement) => refs.push(requirement.semanticsRef);
	definition.requiredCapabilities.forEach(push);
	push(definition.workload.selector.capability);
	for (const treatment of definition.treatments) treatment.interventions.forEach((intervention) => push(intervention.capability));
	definition.metrics.forEach((metric) => push(metric.collector.capability));
	definition.checks.forEach((check) => push(check.capability));
	return [...new Map(refs.map((ref) => [semanticsKey(ref), ref])).values()];
}
function allowsHarnessVariation(definition, registry) {
	if (registryEntry(registry, definition.verdictPolicy)?.allowsHarnessComparison !== true) return false;
	return definition.treatments.some((treatment) => treatment.interventions.some((intervention) => registryEntry(registry, intervention.capability.semanticsRef)?.selectedHarnessOperations?.includes(intervention.operation)));
}
function validateBounds(estimated, limits, issues) {
	for (const key of [
		"wallTimeMs",
		"totalTokens",
		"turns",
		"toolCalls",
		"costUsd"
	]) {
		const estimate = estimated[key];
		const limit = limits[key];
		if (estimate !== void 0 && limit !== void 0 && estimate > limit) add(issues, "intrinsic", "usage.estimate-exceeds-limit", `$/estimatedUsage/${key}`, "estimated usage cannot exceed the corresponding hard limit");
	}
}
function validateDefinitionSemantics(definition, context, issues) {
	checkDigest(definition, issues);
	timestamp(definition.createdAt, "$/createdAt", issues);
	requireUnique(context.registry.semantics, (entry) => `${entry.id}\u0000${entry.version}`, "$/registry/semantics", "semantics.identity-collision", issues);
	const semanticsIdentity = /* @__PURE__ */ new Map();
	context.registry.semantics.forEach((entry, index) => {
		const key = `${entry.id}\u0000${entry.version}`;
		const prior = semanticsIdentity.get(key);
		if (prior && prior !== entry.contentDigest) add(issues, "definition-registry", "semantics.identity-collision", `$/registry/semantics/${index}`, "one semantics ID and version cannot identify multiple digests");
		semanticsIdentity.set(key, entry.contentDigest);
	});
	requireUnique(context.registry.selectors, (entry) => `${entry.id}\u0000${entry.version}`, "$/registry/selectors", "selector.identity-collision", issues);
	requireUnique(context.registry.fingerprintPolicies, (entry) => `${entry.id}\u0000${entry.version}`, "$/registry/fingerprintPolicies", "fingerprint.policy-identity-collision", issues);
	requireUnique(definition.treatments, (value) => value.id, "$/treatments", "definition.duplicate-treatment", issues);
	requireUnique(definition.metrics, (value) => value.id, "$/metrics", "definition.duplicate-metric", issues);
	requireUnique(definition.checks, (value) => value.id, "$/checks", "definition.duplicate-check", issues);
	requireUnique(definition.requiredCapabilities, (value) => semanticsKey(value.semanticsRef), "$/requiredCapabilities", "definition.duplicate-capability", issues);
	requireUnique(definition.safeguards.relaxationRequests, (value) => value.requestId, "$/safeguards/relaxationRequests", "definition.duplicate-relaxation", issues);
	for (let index = 0; index < definition.treatments.length; index++) requireUnique(definition.treatments[index].interventions, (value) => `${semanticsKey(value.capability.semanticsRef)}\u0000${value.operation}`, `$/treatments/${index}/interventions`, "definition.duplicate-intervention", issues);
	const controlCount = definition.treatments.filter((value) => value.control).length;
	if (controlCount !== 1) add(issues, "intrinsic", "definition.control-count", "$/treatments", `exactly one Treatment must be control; found ${controlCount}`);
	if (definition.studyDesign.kind === "cohort" && definition.studyDesign.maximumRunsPerTreatment !== void 0 && definition.studyDesign.maximumRunsPerTreatment < definition.studyDesign.minimumRunsPerTreatment) add(issues, "intrinsic", "definition.cohort-bounds", "$/studyDesign/maximumRunsPerTreatment", "maximumRunsPerTreatment must be at least the minimum");
	validateBounds(definition.estimatedUsage, definition.limits, issues);
	const portable = definition.portability.class === "portable";
	[
		...capabilityRefs(definition),
		definition.safeguards.policy,
		definition.verdictPolicy
	].forEach((ref, index) => validateRegistryRef(ref, `$/registryRefs/${index}`, context.registry, portable, issues));
	const selector = context.registry.selectors.find((candidate) => candidate.id === definition.workload.selector.id && candidate.version === definition.workload.selector.version);
	if (!selector) add(issues, "definition-registry", "selector.unregistered", "$/workload/selector", "workload selector ID and version are not registered");
	else {
		if (portable && selector.portability !== "portable") add(issues, "definition-registry", "selector.not-portable", "$/workload/selector", "portable Definitions may use only portable selectors");
		validateRegisteredValue(definition.workload.selector.parameters, selector.parametersSchema, "$/workload/selector/parameters", "selector.parameters-invalid", issues);
	}
	definition.treatments.forEach((treatment, treatmentIndex) => {
		treatment.interventions.forEach((intervention, interventionIndex) => {
			const schema = registeredOperation(context.registry, intervention.capability.semanticsRef, "interventionOperations", intervention.operation);
			const path = `$/treatments/${treatmentIndex}/interventions/${interventionIndex}`;
			if (schema === void 0) add(issues, "definition-registry", "intervention.operation-unregistered", `${path}/operation`, "intervention operation is not registered for this capability semantics");
			else validateRegisteredValue(intervention.value, schema, `${path}/value`, "intervention.value-invalid", issues);
		});
	});
	definition.metrics.forEach((metric, metricIndex) => {
		const schema = registeredOperation(context.registry, metric.collector.capability.semanticsRef, "collectorOperations", metric.collector.operation);
		const path = `$/metrics/${metricIndex}/collector`;
		if (schema === void 0) add(issues, "definition-registry", "collector.operation-unregistered", `${path}/operation`, "collector operation is not registered for this capability semantics");
		else validateRegisteredValue(metric.collector.parameters, schema, `${path}/parameters`, "collector.parameters-invalid", issues);
	});
	definition.checks.forEach((check, checkIndex) => {
		const schema = registeredOperation(context.registry, check.capability.semanticsRef, "checkOperations", check.operation);
		const path = `$/checks/${checkIndex}`;
		if (schema === void 0) add(issues, "definition-registry", "check.operation-unregistered", `${path}/operation`, "check operation is not registered for this capability semantics");
		else validateRegisteredValue(check.parameters, schema, `${path}/parameters`, "check.parameters-invalid", issues);
	});
	const safeguardRequestSchema = registryEntry(context.registry, definition.safeguards.policy)?.safeguardRequestSchema;
	if (definition.safeguards.relaxationRequests.length > 0 && safeguardRequestSchema === void 0) add(issues, "definition-registry", "safeguard.policy-schema-missing", "$/safeguards/policy", "registered Safeguard Policy does not define a request schema");
	else if (safeguardRequestSchema !== void 0) definition.safeguards.relaxationRequests.forEach((request, index) => validateRegisteredValue(request, safeguardRequestSchema, `$/safeguards/relaxationRequests/${index}`, "safeguard.request-invalid", issues));
	const verdictPolicy = registryEntry(context.registry, definition.verdictPolicy);
	if (verdictPolicy?.verdictParametersSchema === void 0) add(issues, "definition-registry", "verdict-policy.schema-missing", "$/verdictPolicy", "registered Verdict Policy does not define a parameter schema");
	else validateRegisteredValue(definition.verdictPolicy.parameters, verdictPolicy.verdictParametersSchema, "$/verdictPolicy/parameters", "verdict-policy.parameters-invalid", issues);
	const requirements = capabilityRefs(definition).map((ref) => registryEntry(context.registry, ref)).filter((entry) => Boolean(entry));
	for (const dimension of ["totalTokens", "costUsd"]) {
		if (definition.limits[dimension] === void 0) continue;
		const measured = requirements.some((entry) => entry.usage?.measures.includes(dimension));
		const enforced = requirements.some((entry) => entry.usage?.enforces.includes(dimension));
		if (!measured || !enforced) add(issues, "definition-registry", "usage.enforcement-capability-missing", `$/limits/${dimension}`, `${dimension} limits require registered measurement and enforcement support`);
	}
}
function sameArtifact(left, right) {
	return left.harness === right.harness && left.sourceId === right.sourceId && left.artifactId === right.artifactId && left.contentDigest === right.contentDigest;
}
function evidenceKey(evidence) {
	if (evidence.kind === "session") return [
		evidence.kind,
		evidence.sessionRef.harness,
		evidence.sessionRef.sourceId,
		evidence.sessionRef.sessionId,
		evidence.contentDigest
	].join("\0");
	return [
		evidence.kind,
		evidence.artifactRef.harness,
		evidence.artifactRef.sourceId,
		evidence.artifactRef.artifactId,
		evidence.artifactRef.contentDigest,
		evidence.artifactRef.mediaType ?? ""
	].join("\0");
}
function validateEvidenceRefs(evidenceRefs, path, run, issues) {
	requireUnique(evidenceRefs, evidenceKey, path, "run.duplicate-evidence-ref", issues);
	evidenceRefs.forEach((evidence, index) => {
		if (evidence.kind === "session" && evidence.sessionRef.harness !== run.selectedHarness) add(issues, "run-reference", "run.evidence-harness-mismatch", `${path}/${index}/sessionRef/harness`, "runtime-authored session evidence must use selectedHarness");
	});
}
function validateFingerprint(run, registry, issues) {
	const fingerprint = run.behaviorFingerprint;
	const expected = computeBehaviorFingerprintDigest(fingerprint);
	if (fingerprint.digest !== expected) add(issues, "intrinsic", "fingerprint.digest-mismatch", "$/behaviorFingerprint/digest", `fingerprint digest does not match behavior manifest (expected ${expected})`);
	const observedAt = timestamp(fingerprint.observedAt, "$/behaviorFingerprint/observedAt", issues);
	if (Number.isFinite(observedAt) && Number.isFinite(Date.parse(run.startedAt)) && compareUtcTimestamps(fingerprint.observedAt, run.startedAt) > 0) add(issues, "run-reference", "fingerprint.observed-after-dispatch", "$/behaviorFingerprint/observedAt", "behavior context must be observed no later than Run dispatch");
	requireUnique(fingerprint.factors, (value) => value.id, "$/behaviorFingerprint/factors", "fingerprint.duplicate-factor", issues);
	const policies = registry.fingerprintPolicies.filter((candidate) => candidate.id === fingerprint.policy.id && candidate.version === fingerprint.policy.version);
	const policy = policies[0];
	if (policies.length > 1) add(issues, "run-reference", "fingerprint.policy-identity-collision", "$/behaviorFingerprint/policy", "fingerprint policy identity resolves to multiple registry entries");
	if (!policy) add(issues, "run-reference", "fingerprint.policy-unregistered", "$/behaviorFingerprint/policy", "Behavior Fingerprint policy ID and version are not registered");
	else {
		if ((Object.hasOwn(policy.harnessByAdapter, fingerprint.adapter.id) ? policy.harnessByAdapter[fingerprint.adapter.id] : void 0) !== run.selectedHarness) add(issues, "run-reference", "fingerprint.adapter-mismatch", "$/behaviorFingerprint/adapter/id", "registered certifying adapter must bind to selectedHarness");
		const declared = Object.hasOwn(policy.factorIdsByAdapter, fingerprint.adapter.id) ? policy.factorIdsByAdapter[fingerprint.adapter.id] : void 0;
		if (!declared) add(issues, "run-reference", "fingerprint.adapter-manifest-missing", "$/behaviorFingerprint/adapter/id", "fingerprint policy has no factor manifest for this adapter");
		else {
			const expectedSchemaVersion = Object.hasOwn(policy.fingerprintSchemaVersionByAdapter, fingerprint.adapter.id) ? policy.fingerprintSchemaVersionByAdapter[fingerprint.adapter.id] : void 0;
			if (expectedSchemaVersion === void 0 || expectedSchemaVersion !== fingerprint.adapter.fingerprintSchemaVersion) add(issues, "run-reference", "fingerprint.schema-version-mismatch", "$/behaviorFingerprint/adapter/fingerprintSchemaVersion", "adapter fingerprint schema version does not match the registered policy");
			const actual = new Set(fingerprint.factors.map((factor) => factor.id));
			for (const factor of fingerprint.factors) if (!declared.includes(factor.id)) add(issues, "run-reference", "fingerprint.factor-undeclared", "$/behaviorFingerprint/factors", `factor ${factor.id} is not declared by the adapter policy`);
			if (fingerprint.completeness === "complete") {
				for (const factorId of declared) if (!actual.has(factorId)) add(issues, "run-reference", "fingerprint.factor-missing", "$/behaviorFingerprint/factors", `complete fingerprint omits declared factor ${factorId}`);
			}
		}
	}
	fingerprint.factors.forEach((factor, index) => {
		if (factor.displayValue && (SECRET_LIKE.test(factor.displayValue) || OPAQUE_TOKEN_LIKE.test(factor.displayValue))) add(issues, "intrinsic", "fingerprint.secret-like-display", `$/behaviorFingerprint/factors/${index}/displayValue`, "displayValue appears to contain credential material");
	});
}
function validateRunAssignment(run, definition, issues) {
	if (definition.studyDesign.kind === "paired" && run.assignment.kind !== "paired") add(issues, "run-reference", "run.assignment-mismatch", "$/assignment", "paired Definitions require paired Run assignment");
	if (definition.studyDesign.kind === "cohort") {
		const expected = definition.studyDesign.assignment.kind;
		if (run.assignment.kind !== expected) add(issues, "run-reference", "run.assignment-mismatch", "$/assignment", `cohort Definition requires ${expected} assignment`);
	}
}
function validateCertifications(run, definition, registry, issues) {
	requireUnique(run.capabilitySnapshot, (value) => semanticsKey(value.semanticsRef), "$/capabilitySnapshot", "run.duplicate-certification", issues);
	const started = Date.parse(run.startedAt);
	run.capabilitySnapshot.forEach((certification, index) => {
		validateRegistryRef(certification.semanticsRef, `$/capabilitySnapshot/${index}/semanticsRef`, registry, false, issues);
		const observed = timestamp(certification.observedAt, `$/capabilitySnapshot/${index}/observedAt`, issues);
		if (Number.isFinite(observed) && Number.isFinite(started) && compareUtcTimestamps(certification.observedAt, run.startedAt) > 0) add(issues, "run-reference", "capability.observed-after-dispatch", `$/capabilitySnapshot/${index}/observedAt`, "dispatch certification must be observed no later than Run start");
		if (certification.validUntil) {
			const validUntil = timestamp(certification.validUntil, `$/capabilitySnapshot/${index}/validUntil`, issues);
			if (Number.isFinite(validUntil) && Number.isFinite(observed) && compareUtcTimestamps(certification.validUntil, certification.observedAt) < 0 || Number.isFinite(validUntil) && Number.isFinite(started) && compareUtcTimestamps(certification.validUntil, run.startedAt) < 0) add(issues, "run-reference", "capability.stale-at-dispatch", `$/capabilitySnapshot/${index}/validUntil`, "capability certification was not current at dispatch");
		}
	});
	for (const required of capabilityRefs(definition)) {
		const certification = run.capabilitySnapshot.find((candidate) => sameSemantics(candidate.semanticsRef, required));
		if (!certification) add(issues, "run-reference", run.capabilitySnapshot.find((candidate) => candidate.semanticsRef.id === required.id && candidate.semanticsRef.version === required.version) ? "capability.semantics-digest-mismatch" : "capability.certification-missing", "$/capabilitySnapshot", `missing exact certification for ${required.id}@${required.version}`);
		else if (certification.state !== "available") add(issues, "run-reference", "capability.not-available", "$/capabilitySnapshot", `${required.id}@${required.version} is ${certification.state}`);
	}
}
function validateRunEvidence(run, definition, issues) {
	requireUnique(run.observations, (value) => value.metricId, "$/observations", "run.duplicate-observation", issues);
	run.observations.forEach((observation, index) => {
		const declared = definition.metrics.find((metric) => metric.id === observation.metricId);
		if (!declared) {
			add(issues, "run-reference", "run.undeclared-metric", `$/observations/${index}/metricId`, "observation metric is not declared by the Definition");
			return;
		}
		if (declared.unit !== observation.unit || declared.scope !== observation.scope || declared.basis !== observation.basis || declared.semanticsVersion !== observation.semanticsVersion) add(issues, "run-reference", "run.metric-semantics-mismatch", `$/observations/${index}`, "observation semantics do not match the Definition metric");
		const observed = timestamp(observation.observedAt, `$/observations/${index}/observedAt`, issues);
		if (Number.isFinite(observed) && Number.isFinite(Date.parse(run.startedAt)) && compareUtcTimestamps(observation.observedAt, run.startedAt) < 0 || Number.isFinite(observed) && Number.isFinite(Date.parse(run.finishedAt)) && compareUtcTimestamps(observation.observedAt, run.finishedAt) > 0) add(issues, "run-reference", "run.observation-outside-run", `$/observations/${index}/observedAt`, "observation time must fall within the Run");
		validateEvidenceRefs(observation.evidenceRefs, `$/observations/${index}/evidenceRefs`, run, issues);
	});
	requireUnique(run.checkResults, (value) => value.checkId, "$/checkResults", "run.duplicate-check-result", issues);
	run.checkResults.forEach((result, index) => {
		if (!definition.checks.some((check) => check.id === result.checkId)) add(issues, "run-reference", "run.undeclared-check", `$/checkResults/${index}/checkId`, "check result is not declared by the Definition");
		requireOrder([
			{
				value: run.startedAt,
				path: "$/startedAt"
			},
			{
				value: result.startedAt,
				path: `$/checkResults/${index}/startedAt`
			},
			{
				value: result.finishedAt,
				path: `$/checkResults/${index}/finishedAt`
			},
			{
				value: run.finishedAt,
				path: "$/finishedAt"
			}
		], issues);
		validateEvidenceRefs(result.evidenceRefs, `$/checkResults/${index}/evidenceRefs`, run, issues);
	});
	if (run.status === "succeeded") {
		definition.metrics.forEach((metric) => {
			if (!run.observations.some((value) => value.metricId === metric.id)) add(issues, "run-reference", "run.observation-missing", "$/observations", `succeeded Run is missing declared metric ${metric.id}`);
		});
		definition.checks.forEach((check) => {
			if (!run.checkResults.some((value) => value.checkId === check.id)) add(issues, "run-reference", "run.check-result-missing", "$/checkResults", `succeeded Run is missing declared check ${check.id}`);
		});
	}
	if (run.error) validateEvidenceRefs(run.error.evidenceRefs, "$/error/evidenceRefs", run, issues);
}
function validateUsageAgainstLimits(usage, limits, issues) {
	for (const key of [
		"wallTimeMs",
		"totalTokens",
		"turns",
		"toolCalls",
		"costUsd"
	]) if (limits[key] !== void 0 && usage[key] === void 0) add(issues, "intrinsic", "run.usage-missing", `$/usage/${key}`, "terminal usage must report every effective hard-limit dimension");
	else if (usage[key] !== void 0 && limits[key] !== void 0 && usage[key] > limits[key]) add(issues, "intrinsic", "run.hard-limit-exceeded", `$/usage/${key}`, "terminal Run usage exceeds its effective hard limit");
}
function validateEffectiveLimits(run, definition, issues) {
	for (const key of [
		"wallTimeMs",
		"totalTokens",
		"turns",
		"toolCalls",
		"costUsd"
	]) {
		const declared = definition.limits[key];
		if (declared === void 0) continue;
		const effective = run.effectiveLimits[key];
		if (effective === void 0 || effective > declared) add(issues, "run-reference", "run.effective-limit-loosened", `$/effectiveLimits/${key}`, "effective Run limits must retain or narrow every Definition limit");
	}
}
function validateSelectionBinding(run, context, issues) {
	const receipts = context.selectionReceipts.filter((candidate) => candidate.receiptId === run.selectionRef.receiptId);
	const receipt = receipts[0];
	if (receipts.length > 1) add(issues, "run-reference", "selection.receipt-identity-collision", "$/selectionRef/receiptId", "Selection Receipt ID resolves to multiple bindings");
	if (!receipt) {
		add(issues, "run-reference", "selection.receipt-missing", "$/selectionRef", "the referenced Selection Receipt was not supplied");
		return;
	}
	if (receipt.receiptDigest !== run.selectionRef.receiptDigest) add(issues, "run-reference", "selection.receipt-digest-mismatch", "$/selectionRef/receiptDigest", "Selection Reference does not pin the resolved Receipt bytes");
	const slotIds = /* @__PURE__ */ new Set();
	for (const candidate of receipt.planSlots) {
		if (slotIds.has(candidate.planSlotId)) add(issues, "run-reference", "selection.plan-slot-identity-collision", "$/selectionRef/planSlotId", "Selection Receipt contains duplicate Plan Slot IDs");
		slotIds.add(candidate.planSlotId);
	}
	if (receipt.outcome !== "selected" || !sameDefinitionRef(receipt.definitionRef, run.definitionRef) || receipt.trialId !== run.trialId || receipt.selectedHarness !== run.selectedHarness) add(issues, "run-reference", "selection.binding-mismatch", "$/selectionRef", "Selection Receipt must bind the same Definition, trial, and harness");
	if (receipt.adapterBinding.adapterId !== run.behaviorFingerprint.adapter.id || receipt.adapterBinding.behaviorFingerprintDigest !== run.behaviorFingerprint.digest) add(issues, "run-reference", "selection.adapter-binding-mismatch", "$/behaviorFingerprint", "Run behavior context must match the adapter binding selected by the Receipt");
	const slot = receipt.planSlots.find((candidate) => candidate.planSlotId === run.selectionRef.planSlotId);
	if (!slot) add(issues, "run-reference", "selection.plan-slot-missing", "$/selectionRef/planSlotId", "Selection Receipt does not authorize this Plan Slot");
	else if (slot.kind !== "treatment-run" || slot.treatmentId !== run.treatmentId) add(issues, "run-reference", "selection.plan-slot-mismatch", "$/selectionRef/planSlotId", "Plan Slot must authorize this exact Treatment Run");
}
function validateTriggerBinding(run, context, issues) {
	if (!run.triggerRef) return;
	const receipts = context.triggerReceipts.filter((candidate) => candidate.receiptId === run.triggerRef?.receiptId);
	if (receipts.length !== 1) {
		add(issues, "run-reference", receipts.length === 0 ? "trigger.receipt-missing" : "trigger.receipt-identity-collision", "$/triggerRef", "Trigger Reference must resolve to exactly one admitted Receipt");
		return;
	}
	const receipt = receipts[0];
	if (receipt.receiptDigest !== run.triggerRef.receiptDigest) add(issues, "run-reference", "trigger.receipt-digest-mismatch", "$/triggerRef/receiptDigest", "Trigger Reference does not pin the resolved Receipt bytes");
	if (receipt.outcome !== "admitted" || !sameDefinitionRef(receipt.definitionRef, run.definitionRef) || receipt.trialId !== run.trialId || receipt.selectedHarness !== run.selectedHarness) add(issues, "run-reference", "trigger.binding-mismatch", "$/triggerRef", "Trigger Receipt must admit the same Definition, trial, and harness");
}
function validateRetryLineage(run, priorRuns, issues) {
	if (!run.retryOf) return;
	if (run.retryOf.runId === run.runId) {
		add(issues, "run-reference", "retry.self-cycle", "$/retryOf", "a Run cannot retry itself");
		return;
	}
	const parent = priorRuns.find((candidate) => candidate.runId === run.retryOf?.runId);
	if (!parent) {
		add(issues, "run-reference", "retry.parent-missing", "$/retryOf", "retry parent was not provided");
		return;
	}
	if (parent.contentDigest !== run.retryOf.contentDigest) add(issues, "run-reference", "retry.parent-digest-mismatch", "$/retryOf/contentDigest", "retry reference does not pin the parent Run bytes");
	if (parent.trialId !== run.trialId || !sameDefinitionRef(parent.definitionRef, run.definitionRef) || parent.treatmentId !== run.treatmentId || parent.selectedHarness !== run.selectedHarness || !sameArtifact(parent.subjectRef, run.subjectRef)) add(issues, "run-reference", "retry.boundary-mismatch", "$/retryOf", "retry parent must share trial, Definition, Treatment, subject, and harness");
	if (compareUtcTimestamps(run.createdAt, parent.finishedAt) <= 0) add(issues, "run-reference", "retry.precedes-parent", "$/createdAt", "a retry cannot be created before its terminal parent finishes");
	const byId = new Map(priorRuns.map((candidate) => [candidate.runId, candidate]));
	const seen = new Set([run.runId]);
	let cursor = parent;
	while (cursor) {
		if (seen.has(cursor.runId)) {
			add(issues, "run-reference", "retry.cycle", "$/retryOf", "retry lineage contains a cycle");
			break;
		}
		seen.add(cursor.runId);
		cursor = cursor.retryOf ? byId.get(cursor.retryOf.runId) : void 0;
	}
}
function validateRunSemantics(run, context, issues) {
	checkDigest(run, issues);
	requireOrder([
		{
			value: run.createdAt,
			path: "$/createdAt"
		},
		{
			value: run.startedAt,
			path: "$/startedAt"
		},
		{
			value: run.finishedAt,
			path: "$/finishedAt"
		}
	], issues);
	if (!sameDefinitionRef(run.definitionRef, definitionRef$1(context.definition))) add(issues, "run-reference", "run.definition-mismatch", "$/definitionRef", "Run does not reference the exact supplied immutable Definition");
	const collision = context.priorRuns.find((candidate) => candidate.runId === run.runId);
	if (collision && collision.contentDigest !== run.contentDigest) add(issues, "run-reference", "run.identity-collision", "$/runId", "immutable Run ID already identifies different canonical bytes");
	const siblings = context.priorRuns.filter((candidate) => candidate.runId !== run.runId && candidate.trialId === run.trialId && sameDefinitionRef(candidate.definitionRef, run.definitionRef));
	if (!allowsHarnessVariation(context.definition, context.registry) && siblings.some((candidate) => candidate.selectedHarness !== run.selectedHarness)) add(issues, "run-reference", "run.trial-harness-mismatch", "$/selectedHarness", "all Runs in one trial must retain the selected harness binding");
	if (context.definition.studyDesign.kind === "paired" && siblings.some((candidate) => !sameArtifact(candidate.subjectRef, run.subjectRef))) add(issues, "run-reference", "run.paired-subject-mismatch", "$/subjectRef", "all paired Run attempts must use the same content-pinned subject");
	if (context.definition.studyDesign.kind === "paired" && !allowsHarnessVariation(context.definition, context.registry) && siblings.some((candidate) => candidate.selectionRef.receiptId !== run.selectionRef.receiptId || candidate.selectionRef.receiptDigest !== run.selectionRef.receiptDigest)) add(issues, "run-reference", "selection.paired-trial-receipt-mismatch", "$/selectionRef", "all Runs in a paired trial must remain bound to one immutable Selection Receipt");
	if (siblings.some((candidate) => candidate.selectionRef.receiptId === run.selectionRef.receiptId && candidate.selectionRef.planSlotId === run.selectionRef.planSlotId)) add(issues, "run-reference", "selection.plan-slot-reused", "$/selectionRef", "a Selection Receipt Plan Slot can authorize only one Run");
	if (!context.definition.treatments.some((value) => value.id === run.treatmentId)) add(issues, "run-reference", "run.treatment-missing", "$/treatmentId", "Run Treatment is not declared by the Definition");
	if (context.definition.portability.class === "harness-specific" && !context.definition.portability.allowedHarnesses.includes(run.selectedHarness)) add(issues, "run-reference", "run.harness-not-allowed", "$/selectedHarness", "selectedHarness is not allowed by this harness-specific Definition");
	for (const [role, harness] of Object.entries(run.harnessProvenance)) if (role !== "origin" && harness !== run.selectedHarness) add(issues, "intrinsic", "run.provenance-mismatch", `$/harnessProvenance/${role}`, "driver, worker, and judge must equal selectedHarness");
	if (run.sessionRef.harness !== run.selectedHarness) add(issues, "intrinsic", "run.session-harness-mismatch", "$/sessionRef/harness", "primary session must be namespaced to selectedHarness");
	validateFingerprint(run, context.registry, issues);
	validateSelectionBinding(run, context, issues);
	validateTriggerBinding(run, context, issues);
	validateRunAssignment(run, context.definition, issues);
	validateCertifications(run, context.definition, context.registry, issues);
	validateRunEvidence(run, context.definition, issues);
	validateEffectiveLimits(run, context.definition, issues);
	validateUsageAgainstLimits(run.usage, run.effectiveLimits, issues);
	requireUnique(run.safeguardAuthorizations, (value) => value.requestId, "$/safeguardAuthorizations", "run.duplicate-safeguard-authorization", issues);
	run.safeguardAuthorizations.forEach((authorization, index) => {
		const request = context.definition.safeguards.relaxationRequests.find((candidate) => candidate.requestId === authorization.requestId);
		if (!request) add(issues, "run-reference", "run.unknown-safeguard-authorization", `$/safeguardAuthorizations/${index}/requestId`, "authorization does not match a Definition relaxation request");
		if (!(request !== void 0 && context.operatorSafeguardAuthorizations.some((candidate) => sameDefinitionRef(candidate.definitionRef, run.definitionRef) && candidate.trialId === run.trialId && candidate.runId === run.runId && canonicalJson$5(candidate.request) === canonicalJson$5(request) && candidate.approvedBy === authorization.approvedBy && candidate.approvedAt === authorization.approvedAt && candidate.reason === authorization.reason))) add(issues, "run-reference", "run.safeguard-authorization-unresolved", `$/safeguardAuthorizations/${index}`, "Run safeguard authorization is not backed by exact operator authority");
		const approvedAt = timestamp(authorization.approvedAt, `$/safeguardAuthorizations/${index}/approvedAt`, issues);
		if (Number.isFinite(approvedAt) && Number.isFinite(Date.parse(run.startedAt)) && compareUtcTimestamps(authorization.approvedAt, run.startedAt) > 0) add(issues, "run-reference", "run.safeguard-authorization-late", `$/safeguardAuthorizations/${index}/approvedAt`, "safeguard relaxation must be authorized before dispatch");
	});
	if (run.status === "succeeded" && run.error !== null) add(issues, "intrinsic", "run.error-on-success", "$/error", "a succeeded Run cannot carry an error");
	if (run.status !== "succeeded" && run.error === null) add(issues, "intrinsic", "run.missing-error", "$/error", "failed and cancelled Runs must carry a structured error");
	validateRetryLineage(run, context.priorRuns, issues);
}
function refKey(ref) {
	return `${ref.runId}\u0000${ref.contentDigest}`;
}
function validateVerdictEffect(verdict, definition, includedRuns, registry, issues) {
	const effect = verdict.primaryEffect;
	if ((verdict.outcome.kind === "winner" || verdict.outcome.kind === "tie") && !effect) {
		add(issues, "verdict-policy", "verdict.primary-effect-required", "$/primaryEffect", "winner and tie Verdicts require a typed primary effect");
		return;
	}
	if (verdict.outcome.kind === "invalid" && effect) add(issues, "verdict-policy", "verdict.invalid-cannot-have-effect", "$/primaryEffect", "invalid Verdicts cannot assert an effect");
	if (!effect) return;
	const control = definition.treatments.find((value) => value.control);
	const treatment = definition.treatments.find((value) => value.id === effect.contrast.treatmentId);
	if (!control || effect.contrast.controlTreatmentId !== control.id) add(issues, "verdict-policy", "effect.control-mismatch", "$/primaryEffect/contrast/controlTreatmentId", "effect contrast must reference the declared control Treatment");
	if (!treatment || treatment.control) add(issues, "verdict-policy", "effect.treatment-mismatch", "$/primaryEffect/contrast/treatmentId", "effect contrast must reference a non-control Treatment");
	const metric = definition.metrics.find((value) => value.id === effect.metricRef.id);
	if (!metric || metric.semanticsVersion !== effect.metricRef.semanticsVersion || metric.unit !== effect.unit) add(issues, "verdict-policy", "effect.metric-mismatch", "$/primaryEffect/metricRef", "effect metric semantics and unit must match the Definition");
	if (!registryEntry(registry, verdict.policy)?.estimators?.some((candidate) => candidate.id === effect.estimator.id && candidate.version === effect.estimator.version)) add(issues, "verdict-policy", "effect.estimator-unregistered", "$/primaryEffect/estimator", "effect estimator is not registered for the Verdict Policy");
	if (effect.uncertainty.kind === "interval" && effect.uncertainty.lower > effect.uncertainty.upper) add(issues, "verdict-policy", "effect.interval-order", "$/primaryEffect/uncertainty", "uncertainty lower bound cannot exceed upper bound");
	requireUnique(effect.sampleCounts, (value) => value.treatmentId, "$/primaryEffect/sampleCounts", "effect.duplicate-sample-count", issues);
	const effectRuns = includedRuns.filter((run) => run.status === "succeeded" && run.observations.some((observation) => observation.metricId === effect.metricRef.id && observation.semanticsVersion === effect.metricRef.semanticsVersion && observation.unit === effect.unit));
	const actualCounts = /* @__PURE__ */ new Map();
	effectRuns.forEach((run) => actualCounts.set(run.treatmentId, (actualCounts.get(run.treatmentId) ?? 0) + 1));
	for (const count of effect.sampleCounts) {
		if (!definition.treatments.some((value) => value.id === count.treatmentId)) add(issues, "verdict-policy", "effect.undeclared-sample-count", "$/primaryEffect/sampleCounts", `sampleCounts names undeclared Treatment ${count.treatmentId}`);
		if ((actualCounts.get(count.treatmentId) ?? 0) !== count.n) add(issues, "verdict-policy", "effect.sample-count-mismatch", "$/primaryEffect/sampleCounts", `sample count for ${count.treatmentId} does not match included Runs`);
	}
	for (const treatmentId of actualCounts.keys()) if (!effect.sampleCounts.some((value) => value.treatmentId === treatmentId)) add(issues, "verdict-policy", "effect.sample-count-missing", "$/primaryEffect/sampleCounts", `sampleCounts omits included Treatment ${treatmentId}`);
	if (verdict.outcome.kind === "winner") {
		const winner = verdict.outcome.winningTreatmentId;
		const { controlTreatmentId, treatmentId } = effect.contrast;
		if (!(winner === treatmentId && effect.estimate > 0 || winner === controlTreatmentId && effect.estimate < 0)) add(issues, "verdict-policy", "effect.winner-direction-mismatch", "$/primaryEffect/estimate", "normalized effect sign and contrast must agree with the winning Treatment");
	}
}
function validateVerdictReplacement(verdict, previous, issues) {
	if (!previous) return;
	if (verdict.verdictId !== previous.verdictId) add(issues, "verdict-policy", "verdict.replacement-id-mismatch", "$/verdictId", "a replacement Verdict must retain the current Verdict ID");
	if (verdict.trialId !== previous.trialId) add(issues, "verdict-policy", "verdict.replacement-trial-mismatch", "$/trialId", "a replacement Verdict cannot move to another trial");
	if (!sameDefinitionRef(verdict.definitionRef, previous.definitionRef)) add(issues, "verdict-policy", "verdict.replacement-definition-mismatch", "$/definitionRef", "a replacement Verdict must retain the exact Definition reference");
	if (verdict.createdAt !== previous.createdAt) add(issues, "verdict-policy", "verdict.replacement-created-at-mismatch", "$/createdAt", "a replacement Verdict must retain the original creation time");
	if (compareUtcTimestamps(verdict.updatedAt, previous.updatedAt) <= 0) add(issues, "verdict-policy", "verdict.replacement-not-newer", "$/updatedAt", "a replacement Verdict must advance updatedAt");
	if (verdict.contentDigest === previous.contentDigest) add(issues, "verdict-policy", "verdict.replacement-digest-unchanged", "$/contentDigest", "a correction must invalidate the prior Verdict digest");
}
function validateVerdictSemantics(verdict, context, issues) {
	checkDigest(verdict, issues);
	validateVerdictReplacement(verdict, context.previousVerdict, issues);
	requireOrder([{
		value: verdict.createdAt,
		path: "$/createdAt"
	}, {
		value: verdict.updatedAt,
		path: "$/updatedAt"
	}], issues);
	if (!sameDefinitionRef(verdict.definitionRef, definitionRef$1(context.definition))) add(issues, "verdict-policy", "verdict.definition-mismatch", "$/definitionRef", "Verdict does not reference the exact supplied Definition");
	if (!sameSemantics(verdict.policy, context.definition.verdictPolicy)) add(issues, "verdict-policy", "verdict.policy-mismatch", "$/policy", "Verdict policy must match the exact Definition policy reference");
	validateRegistryRef(verdict.policy, "$/policy", context.registry, false, issues);
	const registeredPolicy = registryEntry(context.registry, verdict.policy);
	if (registeredPolicy?.verdictResultSchema === void 0) add(issues, "verdict-policy", "verdict.policy-result-schema-missing", "$/policyResult", "registered Verdict Policy does not define a result schema");
	else validateRegisteredValue(verdict.policyResult, registeredPolicy.verdictResultSchema, "$/policyResult", "verdict.policy-result-invalid", issues);
	requireUnique(verdict.evidence.includedRuns, refKey, "$/evidence/includedRuns", "verdict.duplicate-included-run", issues);
	requireUnique(verdict.evidence.excludedRuns, (value) => refKey(value.run), "$/evidence/excludedRuns", "verdict.duplicate-excluded-run", issues);
	const includedIds = new Set(verdict.evidence.includedRuns.map((value) => value.runId));
	for (const excluded of verdict.evidence.excludedRuns) if (includedIds.has(excluded.run.runId)) add(issues, "verdict-policy", "verdict.evidence-overlap", "$/evidence", `Run ${excluded.run.runId} is both included and excluded`);
	const relevantRuns = context.trialRuns.filter((run) => run.trialId === verdict.trialId && sameDefinitionRef(run.definitionRef, verdict.definitionRef));
	if (context.definition.studyDesign.kind === "paired" && relevantRuns.length > 1) {
		const first = relevantRuns[0];
		if (relevantRuns.some((run) => !sameArtifact(run.subjectRef, first.subjectRef))) add(issues, "verdict-policy", "verdict.paired-subject-mismatch", "$/evidence", "all evidence Runs in a paired trial must use one content-pinned subject");
		if (!allowsHarnessVariation(context.definition, context.registry) && relevantRuns.some((run) => run.selectionRef.receiptId !== first.selectionRef.receiptId || run.selectionRef.receiptDigest !== first.selectionRef.receiptDigest)) add(issues, "verdict-policy", "selection.paired-trial-receipt-mismatch", "$/evidence", "all evidence Runs in a paired trial must share one immutable Selection Receipt");
	}
	const selectionReceiptDigests = /* @__PURE__ */ new Map();
	const selectionSlots = /* @__PURE__ */ new Set();
	for (const run of relevantRuns) {
		const existingDigest = selectionReceiptDigests.get(run.selectionRef.receiptId);
		if (existingDigest !== void 0 && existingDigest !== run.selectionRef.receiptDigest) add(issues, "verdict-policy", "selection.receipt-identity-collision", "$/evidence", "one Selection Receipt ID cannot identify different immutable receipt bytes");
		selectionReceiptDigests.set(run.selectionRef.receiptId, run.selectionRef.receiptDigest);
		const key = `${run.selectionRef.receiptId}\u0000${run.selectionRef.planSlotId}`;
		if (selectionSlots.has(key)) add(issues, "verdict-policy", "selection.plan-slot-reused", "$/evidence", "a Selection Receipt Plan Slot can authorize only one evidence Run");
		selectionSlots.add(key);
	}
	if (relevantRuns.length === 0) add(issues, "verdict-policy", "verdict.trial-empty", "$/trialId", "a Verdict requires at least one terminal Run in the referenced trial");
	if (relevantRuns.some((run) => compareUtcTimestamps(run.finishedAt, verdict.updatedAt) > 0)) add(issues, "verdict-policy", "verdict.precedes-evidence", "$/updatedAt", "current Verdict cannot predate terminal evidence it accounts for");
	const runById = new Map(relevantRuns.map((run) => [run.runId, run]));
	const resolve = (ref, path) => {
		const run = runById.get(ref.runId);
		if (!run) {
			add(issues, "verdict-policy", "verdict.run-missing", path, "evidence Run is absent from the supplied trial");
			return;
		}
		if (run.contentDigest !== ref.contentDigest) add(issues, "verdict-policy", "verdict.run-digest-mismatch", `${path}/contentDigest`, "evidence reference does not pin the exact Run bytes");
		return run;
	};
	const includedRuns = verdict.evidence.includedRuns.map((ref, index) => {
		const run = resolve(ref, `$/evidence/includedRuns/${index}`);
		if (run?.status !== void 0 && run.status !== "succeeded" && (verdict.outcome.kind === "winner" || verdict.outcome.kind === "tie")) add(issues, "verdict-policy", "verdict.included-run-not-succeeded", `$/evidence/includedRuns/${index}`, "conclusive Verdict evidence may include only succeeded Runs");
		return run;
	}).filter((run) => Boolean(run));
	verdict.evidence.excludedRuns.forEach((entry, index) => resolve(entry.run, `$/evidence/excludedRuns/${index}/run`));
	const accounted = new Set([...verdict.evidence.includedRuns.map((value) => value.runId), ...verdict.evidence.excludedRuns.map((value) => value.run.runId)]);
	for (const run of relevantRuns) if (!accounted.has(run.runId)) add(issues, "verdict-policy", "verdict.run-unaccounted", "$/evidence", `trial Run ${run.runId} is neither included nor excluded`);
	const harnesses = new Set(relevantRuns.map((run) => run.selectedHarness));
	const fingerprints = new Set(includedRuns.map((run) => run.behaviorFingerprint.digest));
	const harnessVariation = allowsHarnessVariation(context.definition, context.registry);
	if (harnesses.size > 1 && !harnessVariation) add(issues, "verdict-policy", "verdict.mixed-harnesses", "$/evidence/includedRuns", "ordinary per-harness Verdicts cannot pool harnesses");
	if (fingerprints.size > 1 && !harnessVariation) add(issues, "verdict-policy", "verdict.mixed-fingerprints", "$/evidence/includedRuns", "ordinary Verdicts cannot pool behavior contexts");
	if (context.definition.studyDesign.kind === "paired" && includedRuns.length > 0) {
		const subject = includedRuns[0].subjectRef;
		if (includedRuns.some((run) => !sameArtifact(run.subjectRef, subject))) add(issues, "verdict-policy", "verdict.paired-subject-mismatch", "$/evidence/includedRuns", "paired evidence must use the same content-pinned subject");
		if (verdict.outcome.kind === "winner" || verdict.outcome.kind === "tie") {
			for (const treatment of context.definition.treatments) if (includedRuns.filter((run) => run.treatmentId === treatment.id && run.status === "succeeded").length !== 1) add(issues, "verdict-policy", "verdict.paired-treatment-coverage", "$/evidence/includedRuns", `conclusive paired Verdict requires one succeeded Run for ${treatment.id}`);
		}
	}
	if (includedRuns.some((run) => run.behaviorFingerprint.completeness !== "complete") && verdict.outcome.kind !== "inconclusive" && verdict.outcome.kind !== "invalid") add(issues, "verdict-policy", "verdict.incomplete-fingerprint", "$/evidence/includedRuns", "incomplete fingerprints cannot support a conclusive Verdict");
	const evidenceHarness = harnessVariation ? verdict.judge.harness : includedRuns[0]?.selectedHarness ?? relevantRuns[0]?.selectedHarness;
	if (evidenceHarness && verdict.evidenceBasis.evidenceHarness !== evidenceHarness) add(issues, "verdict-policy", "verdict.evidence-harness-mismatch", "$/evidenceBasis/evidenceHarness", "evidenceBasis must name the harness that produced included Runs");
	if (verdict.judge.harness !== verdict.evidenceBasis.evidenceHarness || verdict.judge.sessionRef.harness !== verdict.judge.harness) add(issues, "verdict-policy", "verdict.judge-harness-mismatch", "$/judge", "judge provenance must remain bound to the evidence harness");
	requireUnique(verdict.evidenceBasis.satisfiedCapabilitySemantics, semanticsKey, "$/evidenceBasis/satisfiedCapabilitySemantics", "verdict.duplicate-capability-semantics", issues);
	const required = includedRuns.length === 0 ? [] : capabilityRefs(context.definition).filter((ref) => includedRuns.every((run) => run.capabilitySnapshot.some((certification) => certification.state === "available" && sameSemantics(certification.semanticsRef, ref))));
	const satisfied = verdict.evidenceBasis.satisfiedCapabilitySemantics;
	for (const ref of required) if (!satisfied.some((candidate) => sameSemantics(candidate, ref))) add(issues, "verdict-policy", "verdict.capability-basis-missing", "$/evidenceBasis/satisfiedCapabilitySemantics", `evidence basis omits ${ref.id}@${ref.version}`);
	for (const ref of satisfied) if (!required.some((candidate) => sameSemantics(candidate, ref))) add(issues, "verdict-policy", "verdict.capability-basis-extra", "$/evidenceBasis/satisfiedCapabilitySemantics", `evidence basis includes undeclared ${ref.id}@${ref.version}`);
	for (const run of includedRuns) {
		const seen = /* @__PURE__ */ new Set();
		let parent = run.retryOf ? runById.get(run.retryOf.runId) : void 0;
		while (parent && !seen.has(parent.runId)) {
			if (includedIds.has(parent.runId)) {
				add(issues, "verdict-policy", "verdict.retry-double-counted", "$/evidence/includedRuns", "a retry and any superseded ancestor cannot both be included");
				break;
			}
			seen.add(parent.runId);
			parent = parent.retryOf ? runById.get(parent.retryOf.runId) : void 0;
		}
	}
	if (verdict.outcome.kind === "winner") {
		const winningTreatmentId = verdict.outcome.winningTreatmentId;
		if (!context.definition.treatments.some((value) => value.id === winningTreatmentId) || !includedRuns.some((run) => run.treatmentId === winningTreatmentId)) add(issues, "verdict-policy", "verdict.winner-without-evidence", "$/outcome/winningTreatmentId", "winning Treatment must be declared and have included evidence");
	}
	if (context.definition.studyDesign.kind === "cohort" && verdict.outcome.kind !== "inconclusive") for (const treatment of context.definition.treatments) {
		const eligibleCount = includedRuns.filter((run) => run.treatmentId === treatment.id && run.status === "succeeded" && context.definition.metrics.every((metric) => run.observations.some((observation) => observation.metricId === metric.id))).length;
		if (eligibleCount < context.definition.studyDesign.minimumRunsPerTreatment) add(issues, "verdict-policy", "verdict.cohort-minimum-not-met", "$/evidence/includedRuns", `Treatment ${treatment.id} has ${eligibleCount} eligible included Runs`);
	}
	if (context.definition.studyDesign.kind === "cohort" && context.definition.studyDesign.maximumRunsPerTreatment !== void 0) for (const treatment of context.definition.treatments) {
		const count = includedRuns.filter((run) => run.treatmentId === treatment.id).length;
		if (count > context.definition.studyDesign.maximumRunsPerTreatment) add(issues, "verdict-policy", "verdict.cohort-maximum-exceeded", "$/evidence/includedRuns", `Treatment ${treatment.id} has ${count} included Runs`);
	}
	validateVerdictEffect(verdict, context.definition, includedRuns, context.registry, issues);
}
function preflight(input) {
	try {
		return {
			value: toJsonValue(input),
			issues: []
		};
	} catch (error) {
		if (error instanceof CanonicalizationError) return { issues: [{
			stage: "json",
			code: error.code,
			path: error.path,
			message: error.message
		}] };
		return { issues: [{
			stage: "json",
			code: "json.invalid",
			path: "$",
			message: error instanceof Error ? error.message : String(error)
		}] };
	}
}
function freezeDeep(value, seen = /* @__PURE__ */ new WeakSet()) {
	if (value === null || typeof value !== "object" || seen.has(value)) return value;
	seen.add(value);
	Object.freeze(value);
	for (const child of Object.values(value)) freezeDeep(child, seen);
	return value;
}
function structuralIssues(input, kind) {
	return validateContractSchema(input, kind).map((value) => ({
		stage: "schema",
		code: value.code,
		path: value.path,
		message: value.message
	}));
}
function rebaseContextIssues(source, basePath) {
	return source.map((issue) => ({
		...issue,
		path: issue.path === "$" ? basePath : `${basePath}${issue.path.slice(1)}`
	}));
}
function recordValue(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function contextField(input, field) {
	try {
		const context = recordValue(input);
		if (!context) return void 0;
		return context[field];
	} catch {
		return;
	}
}
function stringArray(value) {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function jsonSchemaShape(value) {
	return typeof value === "boolean" || recordValue(value) !== void 0;
}
function semanticsRegistryEntryShape(value) {
	const entry = recordValue(value);
	if (!entry || typeof entry.id !== "string" || typeof entry.version !== "number" || typeof entry.contentDigest !== "string" || entry.portability !== "portable" && entry.portability !== "harness-specific") return false;
	for (const field of [
		"interventionOperations",
		"collectorOperations",
		"checkOperations"
	]) {
		const operations = entry[field];
		const operationRecord = operations === void 0 ? void 0 : recordValue(operations);
		if (operations !== void 0 && (!operationRecord || !Object.values(operationRecord).every(jsonSchemaShape))) return false;
	}
	for (const field of [
		"safeguardRequestSchema",
		"verdictParametersSchema",
		"verdictResultSchema"
	]) if (entry[field] !== void 0 && !jsonSchemaShape(entry[field])) return false;
	if (entry.selectedHarnessOperations !== void 0 && !stringArray(entry.selectedHarnessOperations)) return false;
	if (entry.estimators !== void 0) {
		if (!Array.isArray(entry.estimators) || !entry.estimators.every((candidate) => {
			const estimator = recordValue(candidate);
			return estimator !== void 0 && typeof estimator.id === "string" && typeof estimator.version === "number";
		})) return false;
	}
	if (entry.usage !== void 0) {
		const usage = recordValue(entry.usage);
		if (!usage || !stringArray(usage.measures) || !stringArray(usage.enforces)) return false;
	}
	return entry.allowsHarnessComparison === void 0 || typeof entry.allowsHarnessComparison === "boolean";
}
function selectorRegistryEntryShape(value) {
	const entry = recordValue(value);
	return Boolean(entry && typeof entry.id === "string" && typeof entry.version === "number" && (entry.portability === "portable" || entry.portability === "harness-specific") && jsonSchemaShape(entry.parametersSchema));
}
function fingerprintRegistryEntryShape(value) {
	const entry = recordValue(value);
	const factorIds = recordValue(entry?.factorIdsByAdapter);
	const schemaVersions = recordValue(entry?.fingerprintSchemaVersionByAdapter);
	const harnesses = recordValue(entry?.harnessByAdapter);
	return Boolean(entry && typeof entry.id === "string" && typeof entry.version === "number" && factorIds && Object.values(factorIds).every(stringArray) && schemaVersions && Object.values(schemaVersions).every((candidate) => typeof candidate === "number") && harnesses && Object.values(harnesses).every((candidate) => typeof candidate === "string"));
}
function validatedContextRegistry(input, issues) {
	let raw;
	try {
		raw = recordValue(input);
	} catch {
		add(issues, "definition-registry", "context.registry-invalid", "$/context/registry", "contract registry bindings must have the complete immutable v1 shape");
		return;
	}
	if (raw && validatedRegistryValues.has(raw)) return raw;
	if (!raw) {
		add(issues, "definition-registry", "context.registry-required", "$/context/registry", "contract decoding requires a registry with semantics, selector, and fingerprint policy arrays");
		return;
	}
	const prepared = preflight(input);
	const registry = recordValue(prepared.value);
	if (prepared.issues.length === 0 && registry && (!Array.isArray(registry.semantics) || !Array.isArray(registry.selectors) || !Array.isArray(registry.fingerprintPolicies))) {
		add(issues, "definition-registry", "context.registry-required", "$/context/registry", "contract decoding requires a registry with semantics, selector, and fingerprint policy arrays");
		return;
	}
	try {
		if (prepared.issues.length > 0 || !registry || !Array.isArray(registry.semantics) || !registry.semantics.every(semanticsRegistryEntryShape) || !Array.isArray(registry.selectors) || !registry.selectors.every(selectorRegistryEntryShape) || !Array.isArray(registry.fingerprintPolicies) || !registry.fingerprintPolicies.every(fingerprintRegistryEntryShape)) throw new Error("invalid registry binding shape");
	} catch {
		add(issues, "definition-registry", "context.registry-invalid", "$/context/registry", "contract registry bindings must have the complete immutable v1 shape");
		return;
	}
	freezeDeep(registry);
	validatedRegistryValues.add(registry);
	return registry;
}
function definitionRefShape(value) {
	const ref = recordValue(value);
	return Boolean(ref && typeof ref.definitionId === "string" && typeof ref.definitionVersion === "number" && typeof ref.contentDigest === "string");
}
function selectionReceiptShape(value) {
	const receipt = recordValue(value);
	const adapter = recordValue(receipt?.adapterBinding);
	return Boolean(receipt && typeof receipt.receiptId === "string" && typeof receipt.receiptDigest === "string" && receipt.outcome === "selected" && definitionRefShape(receipt.definitionRef) && typeof receipt.trialId === "string" && typeof receipt.selectedHarness === "string" && adapter && typeof adapter.adapterId === "string" && typeof adapter.behaviorFingerprintDigest === "string" && Array.isArray(receipt.planSlots) && receipt.planSlots.every((value) => {
		const slot = recordValue(value);
		return Boolean(slot && typeof slot.planSlotId === "string" && slot.kind === "treatment-run" && typeof slot.treatmentId === "string");
	}));
}
function triggerReceiptShape(value) {
	const receipt = recordValue(value);
	return Boolean(receipt && typeof receipt.receiptId === "string" && typeof receipt.receiptDigest === "string" && receipt.outcome === "admitted" && definitionRefShape(receipt.definitionRef) && typeof receipt.trialId === "string" && typeof receipt.selectedHarness === "string");
}
function operatorAuthorizationShape(value) {
	const authorization = recordValue(value);
	const request = recordValue(authorization?.request);
	return Boolean(authorization && definitionRefShape(authorization.definitionRef) && typeof authorization.trialId === "string" && typeof authorization.runId === "string" && request && typeof request.requestId === "string" && typeof request.safeguard === "string" && Object.hasOwn(request, "requestedValue") && typeof request.reason === "string" && typeof authorization.approvedBy === "string" && typeof authorization.approvedAt === "string" && typeof authorization.reason === "string");
}
function validatedContextDefinition(input, registry, issues) {
	const result = decodeDefinitionV1(input, { registry });
	if (!result.ok) {
		issues.push(...rebaseContextIssues(result.issues, "$/context/definition"));
		return;
	}
	return result.value;
}
function requiredContextArray(input, issues, options) {
	if (Array.isArray(input)) return input;
	add(issues, "run-reference", options.code, options.path, options.message);
	return [];
}
function validatedContextBindings(input, issues, options) {
	const required = requiredContextArray(input, issues, {
		path: options.path,
		code: options.requiredCode,
		message: options.requiredMessage
	});
	if (!Array.isArray(input)) return [];
	const prepared = preflight(required);
	if (prepared.issues.length > 0 || !Array.isArray(prepared.value)) {
		add(issues, "run-reference", options.invalidCode, options.path, options.invalidMessage);
		return [];
	}
	const bindings = [];
	prepared.value.forEach((candidate, index) => {
		if (!options.shape(candidate)) {
			add(issues, "run-reference", options.invalidCode, `${options.path}/${index}`, options.invalidMessage);
			return;
		}
		bindings.push(candidate);
	});
	return bindings;
}
function validatedContextRuns(input, issues, options) {
	if (!Array.isArray(input)) {
		add(issues, options.missingStage, options.missingCode, options.basePath, options.missingMessage);
		return [];
	}
	const runs = [];
	for (let index = 0; index < input.length; index++) {
		const basePath = `${options.basePath}/${index}`;
		const candidate = input[index];
		if (candidate === null || typeof candidate !== "object" || !validatedRunValues.has(candidate)) {
			add(issues, options.missingStage, "context.run-not-decoded", basePath, "context Runs must be immutable values returned by decodeRunV1");
			continue;
		}
		const run = candidate;
		const existing = runs.find((candidate) => candidate.runId === run.runId);
		if (existing) {
			add(issues, "run-reference", existing.contentDigest === run.contentDigest ? "context.duplicate-run-id" : "run.identity-collision", `${basePath}/runId`, existing.contentDigest === run.contentDigest ? "the context supplies the same immutable Run more than once" : "immutable Run ID identifies different canonical bytes in the context");
			continue;
		}
		runs.push(run);
	}
	return runs;
}
function validatedContextVerdict(input, issues) {
	if (input === null) return null;
	if (input === void 0) {
		add(issues, "verdict-policy", "context.previous-verdict-required", "$/context/previousVerdict", "Verdict decoding requires null for an initial Verdict or the current Verdict for a replacement");
		return;
	}
	if (typeof input !== "object" || !validatedVerdictValues.has(input)) {
		add(issues, "verdict-policy", "context.verdict-not-decoded", "$/context/previousVerdict", "a prior current Verdict must be the immutable value returned by decodeVerdictV1");
		return;
	}
	return input;
}
function success(value) {
	const normalized = normalizeDocument(value);
	return {
		ok: true,
		value: freezeDeep(normalized),
		canonicalJson: canonicalDocumentJson(normalized)
	};
}
function runSuccess(value) {
	const result = success(value);
	if (result.ok) validatedRunValues.add(result.value);
	return result;
}
function verdictSuccess(value) {
	const result = success(value);
	if (result.ok) validatedVerdictValues.add(result.value);
	return result;
}
function decodeDefinitionV1(input, context) {
	const prepared = preflight(input);
	const issues = prepared.issues;
	if (issues.length > 0) return {
		ok: false,
		issues
	};
	const candidate = prepared.value;
	issues.push(...structuralIssues(candidate, "ExperimentDefinition"));
	if (issues.length > 0) return {
		ok: false,
		issues
	};
	const registry = validatedContextRegistry(contextField(context, "registry"), issues);
	if (!registry) return {
		ok: false,
		issues
	};
	const definition = candidate;
	validateDefinitionSemantics(definition, { registry }, issues);
	return issues.length > 0 ? {
		ok: false,
		issues
	} : success(definition);
}
function decodeRunV1(input, context) {
	const prepared = preflight(input);
	const issues = prepared.issues;
	if (issues.length > 0) return {
		ok: false,
		issues
	};
	const candidate = prepared.value;
	issues.push(...structuralIssues(candidate, "ExperimentRun"));
	if (issues.length > 0) return {
		ok: false,
		issues
	};
	const registry = validatedContextRegistry(contextField(context, "registry"), issues);
	const selectionReceipts = validatedContextBindings(contextField(context, "selectionReceipts"), issues, {
		path: "$/context/selectionReceipts",
		requiredCode: "context.selection-receipts-required",
		requiredMessage: "Run decoding requires Selection Receipt bindings (use [] when none exist)",
		invalidCode: "context.selection-receipt-invalid",
		invalidMessage: "Selection Receipt bindings must have the complete immutable selected-receipt shape",
		shape: selectionReceiptShape
	});
	const triggerReceipts = validatedContextBindings(contextField(context, "triggerReceipts"), issues, {
		path: "$/context/triggerReceipts",
		requiredCode: "context.trigger-receipts-required",
		requiredMessage: "Run decoding requires Trigger Receipt bindings (use [] when none exist)",
		invalidCode: "context.trigger-receipt-invalid",
		invalidMessage: "Trigger Receipt bindings must have the complete immutable admitted-receipt shape",
		shape: triggerReceiptShape
	});
	const operatorSafeguardAuthorizations = validatedContextBindings(contextField(context, "operatorSafeguardAuthorizations"), issues, {
		path: "$/context/operatorSafeguardAuthorizations",
		requiredCode: "context.operator-authorizations-required",
		requiredMessage: "Run decoding requires operator safeguard authorizations (use [] when none exist)",
		invalidCode: "context.operator-authorization-invalid",
		invalidMessage: "operator safeguard authorizations must have the complete immutable v1 shape",
		shape: operatorAuthorizationShape
	});
	const priorRuns = validatedContextRuns(contextField(context, "priorRuns"), issues, {
		basePath: "$/context/priorRuns",
		missingStage: "run-reference",
		missingCode: "context.prior-runs-required",
		missingMessage: "Run decoding requires the complete ordered set of prior Runs (use [] for the first Run)"
	});
	if (!registry || issues.length > 0) return {
		ok: false,
		issues
	};
	const definition = validatedContextDefinition(contextField(context, "definition"), registry, issues);
	if (!definition) return {
		ok: false,
		issues
	};
	const run = candidate;
	validateRunSemantics(run, {
		definition,
		registry,
		selectionReceipts,
		triggerReceipts,
		operatorSafeguardAuthorizations,
		priorRuns
	}, issues);
	return issues.length > 0 ? {
		ok: false,
		issues
	} : runSuccess(run);
}
function decodeVerdictV1(input, context) {
	const prepared = preflight(input);
	const issues = prepared.issues;
	if (issues.length > 0) return {
		ok: false,
		issues
	};
	const candidate = prepared.value;
	issues.push(...structuralIssues(candidate, "ExperimentVerdict"));
	if (issues.length > 0) return {
		ok: false,
		issues
	};
	const registry = validatedContextRegistry(contextField(context, "registry"), issues);
	if (!registry) return {
		ok: false,
		issues
	};
	const definition = validatedContextDefinition(contextField(context, "definition"), registry, issues);
	const trialRuns = validatedContextRuns(contextField(context, "trialRuns"), issues, {
		basePath: "$/context/trialRuns",
		missingStage: "verdict-policy",
		missingCode: "context.trial-runs-required",
		missingMessage: "Verdict decoding requires the complete set of trial Runs"
	});
	const previousVerdict = validatedContextVerdict(contextField(context, "previousVerdict"), issues);
	if (!definition || previousVerdict === void 0 || issues.length > 0) return {
		ok: false,
		issues
	};
	const verdict = candidate;
	validateVerdictSemantics(verdict, {
		definition,
		registry,
		trialRuns,
		previousVerdict
	}, issues);
	return issues.length > 0 ? {
		ok: false,
		issues
	} : verdictSuccess(verdict);
}
/** Build an exact Run reference after a Run has passed the codec. */
function runRef$1(run) {
	return {
		runId: run.runId,
		contentDigest: run.contentDigest
	};
}
/** Type-only guard used by fixture builders. */
function jsonValue(value) {
	return value;
}
var validatedRunValues, validatedVerdictValues, validatedRegistryValues, SECRET_LIKE, OPAQUE_TOKEN_LIKE, EMPTY_SHA256;
var init_codec = __esmMin((() => {
	init_canonical();
	init_schema();
	validatedRunValues = /* @__PURE__ */ new WeakSet();
	validatedVerdictValues = /* @__PURE__ */ new WeakSet();
	validatedRegistryValues = /* @__PURE__ */ new WeakSet();
	SECRET_LIKE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat|glpat)[-_][A-Za-z0-9_-]{12,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\bxox[baprs]-[A-Za-z0-9-]{12,}|\bBearer\s+[A-Za-z0-9._-]{12,}|api[_-]?key\s*[=:])/i;
	OPAQUE_TOKEN_LIKE = /^[A-Za-z0-9_./+=-]{32,}$/;
	EMPTY_SHA256 = `sha256:${"0".repeat(64)}`;
}));
//#endregion
//#region src/lib/experiment-runtime/contracts/v1/index.ts
var v1_exports = /* @__PURE__ */ __exportAll({
	CanonicalizationError: () => CanonicalizationError,
	EMPTY_SHA256: () => EMPTY_SHA256,
	EXPERIMENT_CONTRACT_SCHEMAS_V1: () => EXPERIMENT_CONTRACT_SCHEMAS_V1,
	canonicalDocumentJson: () => canonicalDocumentJson,
	canonicalJson: () => canonicalJson$5,
	computeBehaviorFingerprintDigest: () => computeBehaviorFingerprintDigest,
	computeDocumentDigest: () => computeDocumentDigest,
	decodeDefinitionV1: () => decodeDefinitionV1,
	decodeRunV1: () => decodeRunV1,
	decodeVerdictV1: () => decodeVerdictV1,
	jsonValue: () => jsonValue,
	normalizeDocument: () => normalizeDocument,
	runRef: () => runRef$1,
	toJsonValue: () => toJsonValue,
	withBehaviorFingerprintDigest: () => withBehaviorFingerprintDigest,
	withDocumentDigest: () => withDocumentDigest
});
var init_v1 = __esmMin((() => {
	init_canonical();
	init_codec();
	init_schema();
}));
//#endregion
//#region src/lib/experiment-runtime/bridges/gate-2702/definition.ts
var definition_exports = /* @__PURE__ */ __exportAll({
	GATE_2702_C5_CHECK_IDS: () => GATE_2702_C5_CHECK_IDS,
	GATE_2702_C5_CONTRACT_REGISTRY: () => GATE_2702_C5_CONTRACT_REGISTRY,
	GATE_2702_C5_COST_CAPS: () => GATE_2702_C5_COST_CAPS,
	GATE_2702_C5_DEFINITION: () => GATE_2702_C5_DEFINITION,
	GATE_2702_C5_DEFINITION_ID: () => GATE_2702_C5_DEFINITION_ID,
	GATE_2702_C5_DEFINITION_VERSION: () => 1,
	GATE_2702_C5_FINGERPRINT_POLICY: () => GATE_2702_C5_FINGERPRINT_POLICY,
	GATE_2702_C5_HARNESS: () => GATE_2702_C5_HARNESS,
	GATE_2702_C5_JUDGE_PROTOCOL: () => GATE_2702_C5_JUDGE_PROTOCOL,
	GATE_2702_C5_LIMITS: () => GATE_2702_C5_LIMITS,
	GATE_2702_C5_METRIC_IDS: () => GATE_2702_C5_METRIC_IDS,
	GATE_2702_C5_PAIRING_RULE: () => GATE_2702_C5_PAIRING_RULE,
	GATE_2702_C5_PLAN: () => GATE_2702_C5_PLAN,
	GATE_2702_C5_PRIMARY_EFFECT: () => GATE_2702_C5_PRIMARY_EFFECT,
	GATE_2702_C5_SUBJECTS: () => GATE_2702_C5_SUBJECTS,
	GATE_2702_C5_TREATMENTS: () => GATE_2702_C5_TREATMENTS,
	GATE_2702_C5_VERDICT_GATES: () => GATE_2702_C5_VERDICT_GATES,
	GATE_2702_C5_VERDICT_PARAMETERS: () => GATE_2702_C5_VERDICT_PARAMETERS,
	createGate2702C5SelectionBinding: () => createGate2702C5SelectionBinding,
	projectGate2702C5Definition: () => projectGate2702C5Definition
});
function deepFreeze(value, seen = /* @__PURE__ */ new WeakSet()) {
	if (value === null || typeof value !== "object" || seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value)) deepFreeze(child, seen);
	return Object.freeze(value);
}
function semanticsDigest(value) {
	return `sha256:${createHash("sha256").update(canonicalJson$5(value), "utf8").digest("hex")}`;
}
/** Build exact schemas without object-valued const/enum (#2838). */
function literalSchema(value) {
	if (value === null) return { type: "null" };
	if (Array.isArray(value)) return {
		type: "array",
		minItems: value.length,
		maxItems: value.length,
		prefixItems: value.map(literalSchema),
		items: false
	};
	if (typeof value === "object") return {
		type: "object",
		additionalProperties: false,
		required: Object.keys(value),
		properties: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, literalSchema(child)]))
	};
	return { const: value };
}
function registerSemantics(value, digestSource = value) {
	return deepFreeze({
		...value,
		contentDigest: semanticsDigest(digestSource)
	});
}
function capability(semantics) {
	return { semanticsRef: {
		id: semantics.id,
		version: semantics.version,
		contentDigest: semantics.contentDigest
	} };
}
function metric$1(id, unit, scope, basis) {
	return {
		id,
		unit,
		scope,
		basis,
		semanticsVersion: 1,
		collector: {
			capability: capability(METRIC_SEMANTICS),
			operation: "collect",
			parameters: {
				metric: id,
				source: "sealed-c5-run"
			}
		}
	};
}
function buildDefinition() {
	const decoded = decodeDefinitionV1(withDocumentDigest({
		schemaVersion: 1,
		kind: "ExperimentDefinition",
		definitionId: GATE_2702_C5_DEFINITION_ID,
		definitionVersion: 1,
		contentDigest: EMPTY_SHA256,
		title: "#2702 C5 Haiku Sidekick ablation",
		description: "A fixed heavy-task comparison of Haiku solo against Haiku with the Sonnet Sidekick at the checkpoint gate.",
		createdAt: "2026-07-20T15:00:00.000Z",
		createdBy: "github:shpwrck/claude-history-dashboard/issues/2818",
		portability: {
			class: "harness-specific",
			allowedHarnesses: [GATE_2702_C5_HARNESS]
		},
		studyDesign: {
			kind: "cohort",
			assignment: { kind: "explicit" },
			minimumRunsPerTreatment: 6,
			maximumRunsPerTreatment: 6
		},
		workload: { selector: {
			id: "selectors/gate-2702-c5-heavy-issues",
			version: 1,
			capability: capability(WORKLOAD_SEMANTICS),
			parameters: {
				...WORKLOAD_SELECTOR_PARAMETERS,
				issues: [...GATE_2702_C5_SUBJECTS]
			}
		} },
		requiredCapabilities: [
			capability(WORKLOAD_SEMANTICS),
			capability(FINGERPRINT_SEMANTICS),
			capability(TREATMENT_SEMANTICS),
			capability(METRIC_SEMANTICS),
			capability(CHECK_SEMANTICS)
		],
		treatments: [{
			...GATE_2702_C5_TREATMENTS[0],
			interventions: [{
				capability: capability(TREATMENT_SEMANTICS),
				operation: "configure",
				value: CONTROL_CONFIGURATION
			}]
		}, {
			...GATE_2702_C5_TREATMENTS[1],
			interventions: [{
				capability: capability(TREATMENT_SEMANTICS),
				operation: "configure",
				value: TREATMENT_CONFIGURATION
			}]
		}],
		metrics: [
			metric$1("metrics/gate-2702-all-in-cost", "usd", "run", "basis/gate-2702-all-in-cost"),
			metric$1("metrics/gate-2702-wall-time", "ms", "run", "basis/gate-2702-monotonic-wall-time"),
			metric$1("metrics/gate-2702-quality-loss", "count", "subject", "basis/gate-2702-objective-and-blind-quality-loss"),
			metric$1("metrics/gate-2702-sidekick-triggers", "count", "run", "basis/gate-2702-sidekick-triggers"),
			metric$1("metrics/gate-2702-sidekick-paid-calls", "count", "run", "basis/gate-2702-sidekick-paid-calls"),
			metric$1("metrics/gate-2702-sidekick-shipped-interventions", "count", "run", "basis/gate-2702-sidekick-shipped-interventions"),
			metric$1("metrics/gate-2702-attributable-ships", "count", "subject", "basis/gate-2702-attributable-ships")
		],
		checks: [{
			id: GATE_2702_C5_CHECK_IDS[0],
			capability: capability(CHECK_SEMANTICS),
			operation: "run",
			parameters: {
				argv: [...CHECK_PARAMETERS[0].argv],
				timeoutMs: CHECK_PARAMETERS[0].timeoutMs
			}
		}, {
			id: GATE_2702_C5_CHECK_IDS[1],
			capability: capability(CHECK_SEMANTICS),
			operation: "run",
			parameters: {
				argv: [...CHECK_PARAMETERS[1].argv],
				timeoutMs: CHECK_PARAMETERS[1].timeoutMs
			}
		}],
		estimatedUsage: {
			wallTimeMs: 18e5,
			costUsd: 8
		},
		limits: GATE_2702_C5_LIMITS,
		safeguards: {
			policy: {
				id: SAFEGUARD_POLICY.id,
				version: SAFEGUARD_POLICY.version,
				contentDigest: SAFEGUARD_POLICY.contentDigest
			},
			relaxationRequests: []
		},
		verdictPolicy: {
			id: VERDICT_POLICY.id,
			version: VERDICT_POLICY.version,
			contentDigest: VERDICT_POLICY.contentDigest,
			parameters: GATE_2702_C5_VERDICT_PARAMETERS
		},
		extensions: {}
	}), { registry: GATE_2702_C5_CONTRACT_REGISTRY });
	if (!decoded.ok) throw new Error(`invalid checked-in gate-2702 Definition: ${JSON.stringify(decoded.issues)}`);
	return decoded.value;
}
function identityIssue(code, path, message) {
	return {
		stage: "intrinsic",
		code: `gate-2702.${code}`,
		path,
		message
	};
}
/** Decode and accept only the one immutable C5 Definition before any runner side effect. */
function projectGate2702C5Definition(input) {
	const decoded = decodeDefinitionV1(input, { registry: GATE_2702_C5_CONTRACT_REGISTRY });
	if (!decoded.ok) return {
		ok: false,
		code: "definition-invalid",
		issues: decoded.issues
	};
	if (decoded.value.definitionId !== "experiments/gate-2702-c5") return {
		ok: false,
		code: "definition-id-mismatch",
		issues: [identityIssue("definition-id-mismatch", "$/definitionId", "the C5 bridge accepts only its checked-in Definition ID")]
	};
	if (decoded.value.definitionVersion !== 1) return {
		ok: false,
		code: "definition-version-mismatch",
		issues: [identityIssue("definition-version-mismatch", "$/definitionVersion", "the C5 bridge accepts only its checked-in Definition version")]
	};
	if (decoded.value.contentDigest !== GATE_2702_C5_DEFINITION.contentDigest) return {
		ok: false,
		code: "definition-digest-mismatch",
		issues: [identityIssue("definition-digest-mismatch", "$/contentDigest", "the C5 bridge accepts only the checked-in canonical Definition bytes")]
	};
	return {
		ok: true,
		definition: decoded.value,
		plan: GATE_2702_C5_PLAN
	};
}
/** Build the minimal immutable Selection Receipt binding later Runs must resolve. */
function createGate2702C5SelectionBinding(input) {
	if (!GATE_2702_C5_TREATMENTS.some((treatment) => treatment.id === input.treatmentId)) throw new TypeError(`unknown gate-2702 treatment: ${input.treatmentId}`);
	return deepFreeze({
		receiptId: input.receiptId,
		receiptDigest: input.receiptDigest,
		outcome: "selected",
		definitionRef: DEFINITION_REF$3,
		trialId: input.trialId,
		selectedHarness: GATE_2702_C5_HARNESS,
		adapterBinding: {
			adapterId: "gate-2702-claude-code-adapter",
			behaviorFingerprintDigest: input.behaviorFingerprintDigest
		},
		planSlots: PLAN_SLOTS.filter((slot) => slot.treatmentId === input.treatmentId).map((slot) => ({ ...slot }))
	});
}
var GATE_2702_C5_DEFINITION_ID, GATE_2702_C5_HARNESS, GATE_2702_C5_SUBJECTS, GATE_2702_C5_TREATMENTS, GATE_2702_C5_METRIC_IDS, GATE_2702_C5_CHECK_IDS, GATE_2702_C5_LIMITS, GATE_2702_C5_COST_CAPS, GATE_2702_C5_VERDICT_GATES, GATE_2702_C5_PAIRING_RULE, GATE_2702_C5_JUDGE_PROTOCOL, GATE_2702_C5_PRIMARY_EFFECT, GATE_2702_C5_VERDICT_PARAMETERS, CONTROL_CONFIGURATION, TREATMENT_CONFIGURATION, CHECK_PARAMETERS, WORKLOAD_SELECTOR_PARAMETERS, WORKLOAD_SEMANTICS_MANIFEST, WORKLOAD_SEMANTICS, GATE_2702_C5_FINGERPRINT_POLICY, FINGERPRINT_SEMANTICS_MANIFEST, FINGERPRINT_SEMANTICS, TREATMENT_SEMANTICS, METRIC_SEMANTICS, CHECK_SEMANTICS, SAFEGUARD_POLICY, VERDICT_POLICY, GATE_2702_C5_CONTRACT_REGISTRY, GATE_2702_C5_DEFINITION, DEFINITION_REF$3, PLAN_SLOTS, GATE_2702_C5_PLAN;
var init_definition = __esmMin((() => {
	init_v1();
	GATE_2702_C5_DEFINITION_ID = "experiments/gate-2702-c5";
	GATE_2702_C5_HARNESS = "claude-code";
	GATE_2702_C5_SUBJECTS = [
		2760,
		2719,
		2713,
		2706,
		2710,
		2670
	];
	GATE_2702_C5_TREATMENTS = [{
		id: "haiku-solo",
		label: "Haiku solo",
		control: true
	}, {
		id: "haiku-sonnet-sidekick",
		label: "Haiku plus Sonnet Sidekick",
		control: false
	}];
	GATE_2702_C5_METRIC_IDS = [
		"metrics/gate-2702-all-in-cost",
		"metrics/gate-2702-wall-time",
		"metrics/gate-2702-quality-loss",
		"metrics/gate-2702-sidekick-triggers",
		"metrics/gate-2702-sidekick-paid-calls",
		"metrics/gate-2702-sidekick-shipped-interventions",
		"metrics/gate-2702-attributable-ships"
	];
	GATE_2702_C5_CHECK_IDS = ["checks/gate-2702-vitest", "checks/gate-2702-typecheck"];
	GATE_2702_C5_LIMITS = {
		wallTimeMs: 3e6,
		costUsd: 18
	};
	GATE_2702_C5_COST_CAPS = {
		workerUsd: 15,
		sidekickSessionUsd: 2,
		sidekickPerCallUsd: 1,
		allInUsd: 18
	};
	GATE_2702_C5_VERDICT_GATES = {
		parityFloor: { maximumHeavyTaskLosses: 0 },
		netPositiveCost: { comparison: "treatment-all-in-cost-lt-control-all-in-cost" },
		attributableShips: {
			minimumAttributableTreatmentWins: 1,
			requireShippedInterventionForEveryTreatmentWin: true
		},
		minimumSample: { runsPerTreatment: 6 }
	};
	GATE_2702_C5_PAIRING_RULE = {
		key: "subjectRef",
		requireBothTreatments: true,
		excludeIncompletePairs: true
	};
	GATE_2702_C5_JUDGE_PROTOCOL = {
		mode: "blind-position-swapped",
		armOrders: ["forward", "swapped"],
		agreementRequired: true,
		objectiveChecksAuthoritative: true,
		retries: {
			retryableFailureClasses: [
				"timeout",
				"non-json",
				"schema-invalid"
			],
			maximumAdditionalAttempts: 2
		}
	};
	GATE_2702_C5_PRIMARY_EFFECT = {
		contrast: {
			controlTreatmentId: "haiku-solo",
			treatmentId: "haiku-sonnet-sidekick"
		},
		metricRef: {
			id: "metrics/gate-2702-all-in-cost",
			semanticsVersion: 1
		},
		estimator: {
			id: "estimators/gate-2702-c5-graduation",
			version: 1
		},
		scale: "relative",
		unit: "usd",
		direction: "lower-is-better"
	};
	GATE_2702_C5_VERDICT_PARAMETERS = {
		...GATE_2702_C5_VERDICT_GATES,
		pairing: GATE_2702_C5_PAIRING_RULE,
		judgeProtocol: GATE_2702_C5_JUDGE_PROTOCOL,
		primaryEffect: GATE_2702_C5_PRIMARY_EFFECT
	};
	CONTROL_CONFIGURATION = {
		workerTier: "haiku",
		workerBudgetUsd: GATE_2702_C5_COST_CAPS.workerUsd,
		sidekick: {
			enabled: false,
			sessionBudgetUsd: 0,
			perCallBudgetUsd: 0
		}
	};
	TREATMENT_CONFIGURATION = {
		workerTier: "haiku",
		workerBudgetUsd: GATE_2702_C5_COST_CAPS.workerUsd,
		sidekick: {
			enabled: true,
			reviewerTier: "sonnet",
			gate: "checkpoint",
			sessionBudgetUsd: GATE_2702_C5_COST_CAPS.sidekickSessionUsd,
			perCallBudgetUsd: GATE_2702_C5_COST_CAPS.sidekickPerCallUsd
		}
	};
	CHECK_PARAMETERS = [{
		argv: [
			"npx",
			"vitest",
			"run"
		],
		timeoutMs: 72e4
	}, {
		argv: [
			"npm",
			"run",
			"typecheck"
		],
		timeoutMs: 36e4
	}];
	WORKLOAD_SELECTOR_PARAMETERS = {
		repository: "shpwrck/claude-history-dashboard",
		weight: "heavy",
		issues: GATE_2702_C5_SUBJECTS
	};
	WORKLOAD_SEMANTICS_MANIFEST = {
		id: "capabilities/gate-2702-workload-selection",
		version: 1,
		portability: "harness-specific"
	};
	WORKLOAD_SEMANTICS = registerSemantics(WORKLOAD_SEMANTICS_MANIFEST, {
		semantics: WORKLOAD_SEMANTICS_MANIFEST,
		selector: {
			id: "selectors/gate-2702-c5-heavy-issues",
			version: 1,
			parameters: WORKLOAD_SELECTOR_PARAMETERS
		}
	});
	GATE_2702_C5_FINGERPRINT_POLICY = {
		id: "fingerprints/gate-2702-c5",
		version: 1,
		factorIdsByAdapter: { "gate-2702-claude-code-adapter": [
			"runtime/claude-cli-version",
			"model/worker-qualified-id",
			"runtime/worker-invocation-digest",
			"sidekick/enabled",
			"sidekick/model-qualified-id",
			"sidekick/gate",
			"sidekick/version",
			"sidekick/resolved-config-digest",
			"sidekick/instructions-digest",
			"budget/worker-usd",
			"budget/sidekick-session-usd",
			"budget/sidekick-per-call-usd",
			"checks/environment-digest",
			"repository/base-sha"
		] },
		fingerprintSchemaVersionByAdapter: { "gate-2702-claude-code-adapter": 1 },
		harnessByAdapter: { "gate-2702-claude-code-adapter": GATE_2702_C5_HARNESS }
	};
	FINGERPRINT_SEMANTICS_MANIFEST = {
		id: "capabilities/gate-2702-behavior-fingerprint",
		version: 1,
		portability: "harness-specific"
	};
	FINGERPRINT_SEMANTICS = registerSemantics(FINGERPRINT_SEMANTICS_MANIFEST, {
		semantics: FINGERPRINT_SEMANTICS_MANIFEST,
		fingerprintPolicy: GATE_2702_C5_FINGERPRINT_POLICY
	});
	TREATMENT_SEMANTICS = registerSemantics({
		id: "capabilities/gate-2702-treatment-application",
		version: 1,
		portability: "harness-specific",
		selectedHarnessOperations: ["configure"],
		interventionOperations: { configure: { oneOf: [literalSchema(CONTROL_CONFIGURATION), literalSchema(TREATMENT_CONFIGURATION)] } },
		usage: {
			measures: [],
			enforces: ["costUsd"]
		}
	});
	METRIC_SEMANTICS = registerSemantics({
		id: "capabilities/gate-2702-metric-collection",
		version: 1,
		portability: "harness-specific",
		collectorOperations: { collect: {
			type: "object",
			additionalProperties: false,
			required: ["metric", "source"],
			properties: {
				metric: { enum: GATE_2702_C5_METRIC_IDS },
				source: { const: "sealed-c5-run" }
			}
		} },
		usage: {
			measures: ["costUsd"],
			enforces: []
		}
	});
	CHECK_SEMANTICS = registerSemantics({
		id: "capabilities/gate-2702-objective-checks",
		version: 1,
		portability: "harness-specific",
		checkOperations: { run: { oneOf: CHECK_PARAMETERS.map(literalSchema) } }
	});
	SAFEGUARD_POLICY = registerSemantics({
		id: "policies/gate-2702-safeguard-ceiling",
		version: 1,
		portability: "harness-specific"
	});
	VERDICT_POLICY = registerSemantics({
		id: "policies/gate-2702-c5-graduation",
		version: 1,
		portability: "harness-specific",
		allowsHarnessComparison: true,
		verdictParametersSchema: literalSchema(GATE_2702_C5_VERDICT_PARAMETERS),
		verdictResultSchema: {
			type: "object",
			additionalProperties: false,
			required: ["basis", "parameters"],
			properties: {
				basis: { const: "policies/gate-2702-c5-graduation" },
				parameters: {
					type: "object",
					additionalProperties: false,
					required: ["decision", "gates"],
					properties: {
						decision: { enum: [
							"sidekick-clears",
							"sidekick-does-not-clear",
							"inconclusive",
							"invalid"
						] },
						gates: {
							type: "object",
							additionalProperties: false,
							required: [
								"parityFloor",
								"netPositiveCost",
								"attributableShips",
								"minimumSample"
							],
							properties: {
								parityFloor: { $ref: "#/$defs/gateResult" },
								netPositiveCost: { $ref: "#/$defs/gateResult" },
								attributableShips: { $ref: "#/$defs/gateResult" },
								minimumSample: { $ref: "#/$defs/gateResult" }
							}
						}
					}
				}
			},
			$defs: { gateResult: {
				type: "object",
				additionalProperties: false,
				required: [
					"state",
					"basis",
					"observed"
				],
				properties: {
					state: { enum: [
						"passed",
						"failed",
						"not-evaluable"
					] },
					basis: {
						type: "string",
						minLength: 1
					},
					observed: { type: "object" }
				}
			} }
		},
		estimators: [{
			id: "estimators/gate-2702-c5-graduation",
			version: 1
		}]
	});
	GATE_2702_C5_CONTRACT_REGISTRY = deepFreeze({
		semantics: [
			WORKLOAD_SEMANTICS,
			FINGERPRINT_SEMANTICS,
			TREATMENT_SEMANTICS,
			METRIC_SEMANTICS,
			CHECK_SEMANTICS,
			SAFEGUARD_POLICY,
			VERDICT_POLICY
		],
		selectors: [{
			id: "selectors/gate-2702-c5-heavy-issues",
			version: 1,
			portability: "harness-specific",
			parametersSchema: literalSchema(WORKLOAD_SELECTOR_PARAMETERS)
		}],
		fingerprintPolicies: [GATE_2702_C5_FINGERPRINT_POLICY]
	});
	GATE_2702_C5_DEFINITION = buildDefinition();
	DEFINITION_REF$3 = deepFreeze({
		definitionId: GATE_2702_C5_DEFINITION.definitionId,
		definitionVersion: GATE_2702_C5_DEFINITION.definitionVersion,
		contentDigest: GATE_2702_C5_DEFINITION.contentDigest
	});
	PLAN_SLOTS = GATE_2702_C5_SUBJECTS.flatMap((subject) => GATE_2702_C5_TREATMENTS.map((treatment) => ({
		planSlotId: `issue-${subject}.${treatment.id}`,
		kind: "treatment-run",
		treatmentId: treatment.id
	})));
	GATE_2702_C5_PLAN = deepFreeze({
		definitionRef: DEFINITION_REF$3,
		selectedHarness: GATE_2702_C5_HARNESS,
		subjects: [...GATE_2702_C5_SUBJECTS],
		treatments: [{
			...GATE_2702_C5_TREATMENTS[0],
			configuration: CONTROL_CONFIGURATION
		}, {
			...GATE_2702_C5_TREATMENTS[1],
			configuration: TREATMENT_CONFIGURATION
		}],
		limits: { ...GATE_2702_C5_LIMITS },
		costCaps: { ...GATE_2702_C5_COST_CAPS },
		checks: [{
			id: GATE_2702_C5_CHECK_IDS[0],
			...CHECK_PARAMETERS[0]
		}, {
			id: GATE_2702_C5_CHECK_IDS[1],
			...CHECK_PARAMETERS[1]
		}],
		metricIds: [...GATE_2702_C5_METRIC_IDS],
		verdictParameters: GATE_2702_C5_VERDICT_PARAMETERS,
		planSlots: PLAN_SLOTS
	});
}));
//#endregion
//#region scripts/gate-2702/seal-accounting.mjs
/**
* Pure accounting rederivation for the sealed #2702 C5 bridge.
*
* `deriveGate2702AccountingEvidence` accepts the exact retained worker stdout
* bytes, the exact retained Sidekick JSONL bytes when one exists, and immutable
* Definition inputs. It returns only the evidence-derived fields written by
* `accounting.mjs`; it performs no filesystem or process access.
*
* `validateGate2702AccountingEvidence` additionally accepts an already
* schema/digest-validated `Gate2702Accounting` receipt and rejects any mismatch
* in its session, numeric, count, usage, observation, or source-evidence fields.
* The caller remains responsible for validating receipt identity and lineage.
*/
function fail$4(message) {
	throw new Error(message);
}
function canonicalValue$4(value) {
	if (Array.isArray(value)) return value.map(canonicalValue$4);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue$4(value[key])]));
}
function canonicalJson$4(value) {
	return JSON.stringify(canonicalValue$4(value));
}
function sha256(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function retainedBytes$2(value, maximumBytes, label) {
	if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail$4(`${label} must be retained bytes`);
	const bytes = Buffer.from(value);
	if (bytes.length > maximumBytes) fail$4(`${label} exceeds its fixed size limit`);
	return bytes;
}
function workerEvidence(workerStdoutBytes) {
	const bytes = retainedBytes$2(workerStdoutBytes, MAX_WORKER_BYTES, "worker terminal JSON");
	let result = null;
	const unknownReasons = [];
	try {
		const parsed = JSON.parse(bytes.toString("utf8"));
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed;
	} catch {}
	if (result === null) unknownReasons.push("worker-result-malformed");
	const workerSessionId = UUID_PATTERN$4.test(result?.session_id ?? "") ? result.session_id.toLowerCase() : null;
	if (workerSessionId === null) unknownReasons.push("worker-session-id-unknown");
	const workerCostUsd = typeof result?.total_cost_usd === "number" && Number.isFinite(result.total_cost_usd) && result.total_cost_usd >= 0 && !Object.is(result.total_cost_usd, -0) ? result.total_cost_usd : null;
	if (workerCostUsd === null) unknownReasons.push("worker-cost-unknown");
	return {
		workerSessionId,
		workerCostUsd,
		unknownReasons,
		evidence: {
			source: "worker-terminal-json",
			byteLength: bytes.length,
			contentDigest: sha256(bytes)
		}
	};
}
function observation(value, evidenceDigests, unknownReasons = []) {
	return {
		value,
		evidenceDigests,
		unknownReasons
	};
}
function parseLedgerRows(sidekickLedgerBytes) {
	const bytes = retainedBytes$2(sidekickLedgerBytes, MAX_SIDEKICK_LEDGER_BYTES, "exact Sidekick ledger");
	const lines = bytes.toString("utf8").split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length > MAX_SIDEKICK_LEDGER_ROWS) fail$4("exact Sidekick ledger exceeds its fixed row limit");
	let malformed = false;
	return {
		bytes,
		entries: lines.map((line, index) => {
			let row;
			try {
				row = JSON.parse(line);
			} catch {
				malformed = true;
				row = null;
			}
			if (row === null || typeof row !== "object" || Array.isArray(row)) {
				malformed = true;
				row = null;
			}
			return {
				rowNumber: index + 1,
				row,
				contentDigest: sha256(line)
			};
		}),
		malformed
	};
}
function requiredString(value, label) {
	if (typeof value !== "string" || value.length === 0) fail$4(`${label} is missing`);
	return value;
}
function requiredTurn(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) fail$4(`${label} is invalid`);
	return value;
}
function requireZeroCost(row, label) {
	if (row.costUsd !== 0 || Object.is(row.costUsd, -0)) fail$4(`${label} must have known zero cost`);
}
function normalizeGate2702Cost(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || Object.is(value, -0)) return null;
	const normalized = Number(value.toFixed(12));
	return Number.isFinite(normalized) && !Object.is(normalized, -0) ? normalized : null;
}
function requireNoShippedField(row, label) {
	if (row.shipped !== void 0) fail$4(`${label} cannot declare a shipped intervention`);
}
function requireShippedBoolean(row, label, expected) {
	if (typeof row.shipped !== "boolean" || expected !== void 0 && row.shipped !== expected) fail$4(`${label} has an invalid shipped state`);
}
function unknownSidekickValues(reason, rowEvidence) {
	const reasons = [reason];
	return {
		sidekickCostUsd: null,
		sidekickTriggerCount: null,
		sidekickPaidCallCount: null,
		sidekickShippedInterventionCount: null,
		unknownReasons: reasons,
		fieldUnknownReasons: {
			sidekickCostUsd: reasons,
			sidekickTriggerCount: reasons,
			sidekickPaidCallCount: reasons,
			sidekickShippedInterventionCount: reasons
		},
		rowEvidence
	};
}
function untrustedSidekickValues(reason, entries) {
	return unknownSidekickValues(reason, entries.map(({ rowNumber, contentDigest, row }) => ({
		rowNumber,
		contentDigest,
		lifecycle: row === null ? "malformed" : "untrusted"
	})));
}
function collectSidekickRows(rows, workerSessionId, sidekickModel) {
	const asyncJobs = /* @__PURE__ */ new Map();
	const lifecycleRows = /* @__PURE__ */ new Map();
	const paidRows = [];
	const shippedRows = [];
	const rowEvidence = [];
	let lifecycleConflict = false;
	let lifecycleUnrecognized = false;
	let directTriggerCount = 0;
	const ignoredModels = new Set([
		"engage",
		"budget",
		"guard"
	]);
	const acceptLifecycle = (identity, row) => {
		const canonical = canonicalJson$4(row);
		const existing = lifecycleRows.get(identity);
		if (existing === void 0) {
			lifecycleRows.set(identity, canonical);
			return "unique";
		}
		if (existing !== canonical) {
			lifecycleConflict = true;
			return "conflict";
		}
		return "duplicate";
	};
	for (const evidence of rows) {
		const { row } = evidence;
		let lifecycle = "ignored";
		let identity = null;
		let duplicate = false;
		let conflict = false;
		if (row.model === "queued") {
			const jobId = requiredString(row.jobId, "queued Sidekick jobId");
			const trigger = requiredString(row.trigger, "queued Sidekick trigger");
			requireZeroCost(row, "queued Sidekick row");
			requireNoShippedField(row, "queued Sidekick row");
			lifecycle = "async-queued";
			identity = `async:${workerSessionId}:${jobId}:queued`;
			const disposition = acceptLifecycle(identity, row);
			if (disposition === "unique") {
				const job = asyncJobs.get(jobId) ?? {
					trigger,
					queued: false,
					completed: false
				};
				if (job.trigger !== trigger) {
					lifecycleConflict = true;
					conflict = true;
				} else {
					job.queued = true;
					asyncJobs.set(jobId, job);
				}
			} else if (disposition === "duplicate") duplicate = true;
			else conflict = true;
		} else if (row.model === "sync" || row.model === "stop-review") {
			const turn = requiredTurn(row.turn, `${row.model} Sidekick turn`);
			const trigger = requiredString(row.trigger, `${row.model} Sidekick trigger`);
			const skipped = row.model === "stop-review" && row.skipped === "empty-tail";
			if (row.skipped !== void 0 && !skipped) fail$4(`${row.model} Sidekick skipped state is unrecognized`);
			if (skipped) {
				requireZeroCost(row, "skipped stop-review Sidekick row");
				requireNoShippedField(row, "skipped stop-review Sidekick row");
			} else requireShippedBoolean(row, `${row.model} Sidekick row`);
			identity = `direct:${workerSessionId}:${row.model}:${turn}:${trigger}`;
			lifecycle = row.model;
			const disposition = acceptLifecycle(identity, row);
			if (disposition === "unique") {
				directTriggerCount += 1;
				if (!skipped) {
					paidRows.push(row);
					if (row.shipped === true) shippedRows.push(row);
				}
			} else if (disposition === "duplicate") duplicate = true;
			else conflict = true;
		} else if (row.model === "triage") {
			const turn = requiredTurn(row.turn, "triage Sidekick turn");
			if (typeof row.fired !== "boolean") fail$4("triage Sidekick fired result is invalid");
			requireNoShippedField(row, "triage Sidekick row");
			identity = `probe:${workerSessionId}:triage:${turn}`;
			lifecycle = "triage";
			const disposition = acceptLifecycle(identity, row);
			if (disposition === "unique") paidRows.push(row);
			else if (disposition === "duplicate") duplicate = true;
			else conflict = true;
		} else if (row.model === "delivery" || row.model === "pre-act" || row.model === "interrupt") {
			const reviewedTurn = requiredTurn(row.reviewedTurn, `${row.model} Sidekick reviewed turn`);
			requireZeroCost(row, `${row.model} Sidekick row`);
			requireShippedBoolean(row, `${row.model} Sidekick row`, true);
			identity = `delivery:${workerSessionId}:${row.model}:${reviewedTurn}`;
			lifecycle = "delivery";
			const disposition = acceptLifecycle(identity, row);
			if (disposition === "unique") {
				if (row.shipped === true) shippedRows.push(row);
			} else if (disposition === "duplicate") duplicate = true;
			else conflict = true;
		} else if (row.model === sidekickModel && typeof row.trigger === "string" && typeof row.error === "string" && row.error.length > 0 && row.jobId === void 0) {
			const turn = requiredTurn(row.turn, `${row.model} Sidekick turn`);
			const trigger = requiredString(row.trigger, `${row.model} Sidekick trigger`);
			requireShippedBoolean(row, `${row.model} Sidekick error row`, false);
			identity = `direct:${workerSessionId}:${row.model}:${turn}:${trigger}`;
			lifecycle = "sync-error";
			const disposition = acceptLifecycle(identity, row);
			if (disposition === "unique") {
				directTriggerCount += 1;
				paidRows.push(row);
				if (row.shipped === true) shippedRows.push(row);
			} else if (disposition === "duplicate") duplicate = true;
			else conflict = true;
		} else if (row.model === sidekickModel && typeof row.jobId === "string") {
			const jobId = requiredString(row.jobId, "completed Sidekick jobId");
			const trigger = requiredString(row.trigger, "completed Sidekick trigger");
			requireNoShippedField(row, "completed Sidekick row");
			lifecycle = "async-completed";
			identity = `async:${workerSessionId}:${jobId}:completed`;
			const disposition = acceptLifecycle(identity, row);
			if (disposition === "unique") {
				const job = asyncJobs.get(jobId) ?? {
					trigger,
					queued: false,
					completed: false
				};
				if (job.trigger !== trigger) {
					lifecycleConflict = true;
					conflict = true;
				} else {
					job.completed = true;
					asyncJobs.set(jobId, job);
					paidRows.push(row);
				}
			} else if (disposition === "duplicate") duplicate = true;
			else conflict = true;
		} else if (ignoredModels.has(row.model) && row.costUsd === 0) lifecycle = "administrative";
		else {
			lifecycle = "unrecognized";
			lifecycleUnrecognized = true;
		}
		rowEvidence.push({
			rowNumber: evidence.rowNumber,
			contentDigest: evidence.contentDigest,
			lifecycle,
			...identity ? { identityDigest: sha256(identity) } : {},
			...duplicate ? { duplicate: true } : {},
			...conflict ? { conflict: true } : {}
		});
	}
	if (lifecycleUnrecognized) return unknownSidekickValues("sidekick-lifecycle-unrecognized", rowEvidence);
	if (lifecycleConflict) return unknownSidekickValues("sidekick-lifecycle-conflict", rowEvidence);
	const sidekickTriggerCount = asyncJobs.size + directTriggerCount;
	if ([...asyncJobs.values()].some(({ queued, completed }) => queued && !completed)) {
		const reasons = ["sidekick-lifecycle-incomplete"];
		return {
			sidekickCostUsd: null,
			sidekickTriggerCount,
			sidekickPaidCallCount: null,
			sidekickShippedInterventionCount: null,
			unknownReasons: reasons,
			fieldUnknownReasons: {
				sidekickCostUsd: reasons,
				sidekickTriggerCount: [],
				sidekickPaidCallCount: reasons,
				sidekickShippedInterventionCount: reasons
			},
			rowEvidence
		};
	}
	const sidekickCostUsd = paidRows.every((row) => typeof row.costUsd === "number" && Number.isFinite(row.costUsd) && row.costUsd >= 0 && !Object.is(row.costUsd, -0)) ? normalizeGate2702Cost(paidRows.reduce((total, row) => total + row.costUsd, 0)) : null;
	const costUnknownReasons = sidekickCostUsd === null ? ["sidekick-cost-unknown"] : [];
	return {
		sidekickCostUsd,
		sidekickTriggerCount,
		sidekickPaidCallCount: paidRows.length,
		sidekickShippedInterventionCount: shippedRows.length,
		unknownReasons: costUnknownReasons,
		fieldUnknownReasons: {
			sidekickCostUsd: costUnknownReasons,
			sidekickTriggerCount: [],
			sidekickPaidCallCount: [],
			sidekickShippedInterventionCount: []
		},
		rowEvidence
	};
}
function unavailableSidekickValues(reason) {
	const reasons = [reason];
	return {
		sidekickCostUsd: null,
		sidekickTriggerCount: null,
		sidekickPaidCallCount: null,
		sidekickShippedInterventionCount: null,
		unknownReasons: reasons,
		fieldUnknownReasons: Object.fromEntries([
			"sidekickCostUsd",
			"sidekickTriggerCount",
			"sidekickPaidCallCount",
			"sidekickShippedInterventionCount"
		].map((field) => [field, reasons])),
		rowEvidence: []
	};
}
function deriveTreatment(worker, sidekickLedgerBytes, sidekickModel) {
	if (typeof sidekickModel !== "string" || sidekickModel.length === 0) fail$4("sidekickModel must identify the configured Sidekick model");
	if (worker.workerSessionId === null && sidekickLedgerBytes != null) fail$4("Sidekick ledger bytes cannot bind without a worker session id");
	const relativePath = worker.workerSessionId === null ? null : `${worker.workerSessionId}/__sidekick.jsonl`;
	const ledger = worker.workerSessionId === null ? {
		status: "unavailable",
		relativePath
	} : sidekickLedgerBytes == null ? {
		status: "missing",
		relativePath
	} : {
		status: "settled",
		relativePath,
		...parseLedgerRows(sidekickLedgerBytes)
	};
	const values = ledger.status !== "settled" ? unavailableSidekickValues(ledger.status === "missing" ? "sidekick-ledger-missing" : "worker-session-id-unknown") : (() => {
		if (!ledger.malformed) try {
			return collectSidekickRows(ledger.entries, worker.workerSessionId, sidekickModel);
		} catch {}
		return untrustedSidekickValues("sidekick-ledger-malformed", ledger.entries);
	})();
	const allInCostUsd = worker.workerCostUsd === null || values.sidekickCostUsd === null ? null : normalizeGate2702Cost(worker.workerCostUsd + values.sidekickCostUsd);
	const workerCostUnknownReasons = worker.workerCostUsd === null ? worker.unknownReasons.filter((reason) => reason !== "worker-session-id-unknown") : [];
	const invalidAllInCost = worker.workerCostUsd !== null && values.sidekickCostUsd !== null && allInCostUsd === null;
	const allInUnknownReasons = [...new Set([
		...workerCostUnknownReasons,
		...values.fieldUnknownReasons.sidekickCostUsd,
		...invalidAllInCost ? ["all-in-cost-invalid"] : []
	])];
	const unknownReasons = [...new Set([...allInUnknownReasons, ...values.unknownReasons])];
	const ledgerDigest = ledger.status === "settled" ? sha256(ledger.bytes) : null;
	const evidenceDigests = [worker.evidence.contentDigest, ...ledgerDigest === null ? [] : [ledgerDigest]];
	return {
		workerSessionId: worker.workerSessionId,
		workerCostUsd: worker.workerCostUsd,
		sidekickCostUsd: values.sidekickCostUsd,
		allInCostUsd,
		sidekickTriggerCount: values.sidekickTriggerCount,
		sidekickPaidCallCount: values.sidekickPaidCallCount,
		sidekickShippedInterventionCount: values.sidekickShippedInterventionCount,
		bridgeEvidenceStatus: allInCostUsd === null ? "excluded" : "eligible",
		exclusionReasons: unknownReasons,
		...allInCostUsd === null ? {} : { usage: { costUsd: allInCostUsd } },
		observations: {
			workerCostUsd: observation(worker.workerCostUsd, [worker.evidence.contentDigest], workerCostUnknownReasons),
			sidekickCostUsd: observation(values.sidekickCostUsd, evidenceDigests.slice(1), values.fieldUnknownReasons.sidekickCostUsd),
			allInCostUsd: observation(allInCostUsd, evidenceDigests, allInUnknownReasons),
			sidekickTriggerCount: observation(values.sidekickTriggerCount, evidenceDigests.slice(1), values.fieldUnknownReasons.sidekickTriggerCount),
			sidekickPaidCallCount: observation(values.sidekickPaidCallCount, evidenceDigests.slice(1), values.fieldUnknownReasons.sidekickPaidCallCount),
			sidekickShippedInterventionCount: observation(values.sidekickShippedInterventionCount, evidenceDigests.slice(1), values.fieldUnknownReasons.sidekickShippedInterventionCount)
		},
		sourceEvidence: {
			worker: worker.evidence,
			sidekick: {
				source: "sidekick-session-ledger",
				relativePath: ledger.relativePath,
				status: ledger.status,
				...ledger.status === "settled" ? {
					byteLength: ledger.bytes.length,
					contentDigest: ledgerDigest
				} : {},
				rowDigests: values.rowEvidence
			}
		}
	};
}
function deriveControl(worker, definitionDigest) {
	const costKnown = worker.workerCostUsd !== null;
	const unknownReasons = costKnown ? [] : worker.unknownReasons.filter((reason) => reason !== "worker-session-id-unknown");
	const allInCostUsd = costKnown ? worker.workerCostUsd : null;
	return {
		workerSessionId: worker.workerSessionId,
		workerCostUsd: worker.workerCostUsd,
		sidekickCostUsd: 0,
		allInCostUsd,
		sidekickTriggerCount: 0,
		sidekickPaidCallCount: 0,
		sidekickShippedInterventionCount: 0,
		bridgeEvidenceStatus: costKnown ? "eligible" : "excluded",
		exclusionReasons: unknownReasons,
		...costKnown ? { usage: { costUsd: allInCostUsd } } : {},
		observations: {
			workerCostUsd: observation(worker.workerCostUsd, [worker.evidence.contentDigest], unknownReasons),
			sidekickCostUsd: observation(0, [definitionDigest]),
			allInCostUsd: observation(allInCostUsd, [worker.evidence.contentDigest, definitionDigest], unknownReasons),
			sidekickTriggerCount: observation(0, [definitionDigest]),
			sidekickPaidCallCount: observation(0, [definitionDigest]),
			sidekickShippedInterventionCount: observation(0, [definitionDigest])
		},
		sourceEvidence: {
			worker: worker.evidence,
			sidekick: {
				source: "fixed-disabled-treatment",
				definitionDigest
			}
		}
	};
}
/**
* Re-derive the evidence-controlled portion of a Gate2702Accounting receipt.
*
* @param {object} input
* @param {Buffer|Uint8Array} input.workerStdoutBytes Exact retained stdout.
* @param {Buffer|Uint8Array|null} [input.sidekickLedgerBytes] Exact retained
*   `__sidekick.jsonl`, or null/undefined when no ledger existed.
* @param {boolean} input.sidekickEnabled Whether the Definition treatment
*   enables Sidekick.
* @param {string} input.definitionDigest Exact Definition content digest.
* @param {string} input.sidekickModel Pinned Sidekick advisor model id.
*/
function deriveGate2702AccountingEvidence({ workerStdoutBytes, sidekickLedgerBytes = null, sidekickEnabled, definitionDigest, sidekickModel }) {
	if (typeof sidekickEnabled !== "boolean") fail$4("sidekickEnabled must be a boolean Definition value");
	if (!SHA256_PATTERN$2.test(definitionDigest ?? "")) fail$4("definitionDigest must be a sha256 content digest");
	if (!sidekickEnabled && sidekickLedgerBytes != null) fail$4("a Sidekick-disabled treatment cannot bind Sidekick ledger bytes");
	const worker = workerEvidence(workerStdoutBytes);
	return sidekickEnabled ? deriveTreatment(worker, sidekickLedgerBytes, sidekickModel) : deriveControl(worker, definitionDigest);
}
/**
* Validate all evidence-derived accounting claims and return their rederived
* projection. The input receipt must already have passed schema, digest,
* identity, and lineage validation.
*
* @param {object} input Same inputs as `deriveGate2702AccountingEvidence`.
* @param {object} input.accounting Parsed Gate2702Accounting receipt.
*/
function validateGate2702AccountingEvidence({ accounting, ...inputs }) {
	if (accounting === null || typeof accounting !== "object" || Array.isArray(accounting)) fail$4("Gate2702Accounting receipt must be an object");
	const expected = deriveGate2702AccountingEvidence(inputs);
	for (const field of ACCOUNTING_EVIDENCE_FIELDS) {
		const expectedHasField = Object.hasOwn(expected, field);
		if (expectedHasField !== Object.hasOwn(accounting, field) || expectedHasField && !isDeepStrictEqual(accounting[field], expected[field])) fail$4(`Gate2702Accounting ${field} does not rederive from retained evidence`);
	}
	return expected;
}
var MAX_WORKER_BYTES, MAX_SIDEKICK_LEDGER_BYTES, MAX_SIDEKICK_LEDGER_ROWS, UUID_PATTERN$4, SHA256_PATTERN$2, ACCOUNTING_EVIDENCE_FIELDS;
var init_seal_accounting = __esmMin((() => {
	MAX_WORKER_BYTES = 2 * 1024 * 1024;
	MAX_SIDEKICK_LEDGER_BYTES = 4 * 1024 * 1024;
	MAX_SIDEKICK_LEDGER_ROWS = 4096;
	UUID_PATTERN$4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	SHA256_PATTERN$2 = /^sha256:[0-9a-f]{64}$/;
	ACCOUNTING_EVIDENCE_FIELDS = [
		"workerSessionId",
		"workerCostUsd",
		"sidekickCostUsd",
		"allInCostUsd",
		"sidekickTriggerCount",
		"sidekickPaidCallCount",
		"sidekickShippedInterventionCount",
		"bridgeEvidenceStatus",
		"exclusionReasons",
		"usage",
		"observations",
		"sourceEvidence"
	];
}));
//#endregion
//#region scripts/gate-2702/behavior-context.mjs
function configuredModel(env, name, fallback, tier) {
	const value = String(env[name] || fallback).trim();
	if (!new RegExp(`^claude-${tier}-[a-z0-9-]+$`).test(value)) throw new Error(`${name} must be a fully qualified Claude ${tier} model`);
	return value;
}
function gate2702ModelIds(env = process.env) {
	return {
		worker: configuredModel(env, "CHD_EXPERIMENT_2702_WORKER_MODEL_ID", GATE_2702_WORKER_MODEL_ID, "haiku"),
		sidekick: configuredModel(env, "CHD_EXPERIMENT_2702_SIDEKICK_MODEL_ID", GATE_2702_SIDEKICK_MODEL_ID, "sonnet")
	};
}
function gate2702ResolvedSidekickConfig(treatment, env = process.env) {
	const models = gate2702ModelIds(env);
	const enabled = treatment.configuration.sidekick.enabled;
	return {
		enabled,
		model: models.sidekick,
		gate: enabled ? treatment.configuration.sidekick.gate : "off",
		warmupTokens: 15e4,
		backoffAfter: 3,
		backoffMax: 8,
		sessionBudgetUsd: enabled ? treatment.configuration.sidekick.sessionBudgetUsd : 0,
		triggerReserveUsd: enabled ? 1 : 0,
		callBudgetUsd: enabled ? treatment.configuration.sidekick.perCallBudgetUsd : 0,
		sighted: true,
		verifyLens: true,
		sync: false,
		triggers: [
			"push-or-pr",
			"merge-conflict",
			"sensitive-file-edit",
			"destructive"
		],
		triageModel: "claude-haiku-4-5",
		audits: ["file"],
		shipCooldown: 2,
		nearDup: .5,
		nearDupMinShared: 4,
		concurrency: 1,
		minDelta: 120
	};
}
function gate2702SidekickEnvironment(treatment, env = process.env) {
	const config = gate2702ResolvedSidekickConfig(treatment, env);
	return {
		SIDEKICK_ENABLE: config.enabled ? "1" : "0",
		SIDEKICK_MODEL: config.model,
		SIDEKICK_GATE: config.gate,
		SIDEKICK_WARMUP_TOKENS: String(config.warmupTokens),
		SIDEKICK_BACKOFF_AFTER: String(config.backoffAfter),
		SIDEKICK_BACKOFF_MAX: String(config.backoffMax),
		SIDEKICK_SESSION_BUDGET_USD: String(config.sessionBudgetUsd),
		SIDEKICK_TRIGGER_RESERVE_USD: String(config.triggerReserveUsd),
		SIDEKICK_CALL_BUDGET_USD: String(config.callBudgetUsd),
		SIDEKICK_SIGHTED: config.sighted ? "1" : "0",
		SIDEKICK_VERIFY_LENS: config.verifyLens ? "1" : "0",
		SIDEKICK_SYNC: config.sync ? "1" : "0",
		SIDEKICK_TRIGGERS: config.triggers.join(","),
		SIDEKICK_TRIAGE_MODEL: config.triageModel,
		SIDEKICK_AUDITS: config.audits.join(","),
		SIDEKICK_SHIP_COOLDOWN: String(config.shipCooldown),
		SIDEKICK_NEARDUP: String(config.nearDup),
		SIDEKICK_NEARDUP_MIN_SHARED: String(config.nearDupMinShared),
		SIDEKICK_CONCURRENCY: String(config.concurrency),
		SIDEKICK_MIN_DELTA: String(config.minDelta),
		SIDEKICK_NESTED: "0"
	};
}
var GATE_2702_WORKER_MODEL_ID, GATE_2702_SIDEKICK_MODEL_ID;
var init_behavior_context = __esmMin((() => {
	GATE_2702_WORKER_MODEL_ID = "claude-haiku-4-5-20251001";
	GATE_2702_SIDEKICK_MODEL_ID = "claude-sonnet-5";
}));
//#endregion
//#region scripts/gate-2702/seal-classification.mjs
/**
* Pure classification-evidence verification for the sealed #2702 C5 bridge.
*
* The verifier reads exact bytes from a trial-relative artifact map. It never
* touches a live worktree or launches a process. Callers provide the trusted
* arm identity; all receipt identity, lifecycle, stream, check-result, and
* classification claims are rederived from the retained artifacts.
*/
function fail$3(message) {
	throw new Error(message);
}
function canonicalValue$3(value) {
	if (Array.isArray(value)) return value.map(canonicalValue$3);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue$3(value[key])]));
}
function canonicalJson$3(value) {
	return JSON.stringify(canonicalValue$3(value));
}
function sameValue$3(left, right) {
	return canonicalJson$3(left) === canonicalJson$3(right);
}
function sha256Bytes$2(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function valueDigest$3(value) {
	return sha256Bytes$2(Buffer.from(canonicalJson$3(value), "utf8"));
}
function receiptDigest$2(receipt) {
	const withoutDigest = { ...receipt };
	delete withoutDigest.contentDigest;
	return valueDigest$3(withoutDigest);
}
function requireArtifactMap$1(artifactBytesByPath) {
	if (artifactBytesByPath === null || typeof artifactBytesByPath !== "object" || typeof artifactBytesByPath.get !== "function" || typeof artifactBytesByPath.has !== "function" || typeof artifactBytesByPath.keys !== "function") fail$3("artifactBytesByPath must be a retained-artifact map");
	for (const path of artifactBytesByPath.keys()) if (typeof path !== "string" || !path) fail$3("retained classification artifact map contains an invalid path");
	return artifactBytesByPath;
}
function retainedBytes$1(artifacts, path, required = true) {
	if (!artifacts.has(path)) {
		if (!required) return null;
		fail$3(`missing retained classification artifact: ${path}`);
	}
	const value = artifacts.get(path);
	if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail$3(`retained classification artifact is not bytes: ${path}`);
	const bytes = Buffer.from(value);
	if (bytes.length > MAX_ARTIFACT_BYTES) fail$3(`retained classification artifact exceeds its bound: ${path}`);
	return bytes;
}
function readJson$1(artifacts, path, required = true) {
	const bytes = retainedBytes$1(artifacts, path, required);
	if (bytes === null) return null;
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		fail$3(`could not decode retained classification artifact ${path}: ${error.message}`);
	}
}
function readReceipt$2(artifacts, path, kind, required = true) {
	const receipt = readJson$1(artifacts, path, required);
	if (receipt === null) return null;
	if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt) || receipt.schemaVersion !== SCHEMA_VERSION$1 || receipt.kind !== kind || !SHA256_PATTERN$1.test(receipt.contentDigest ?? "") || receipt.contentDigest !== receiptDigest$2(receipt)) fail$3(`retained ${kind} receipt is invalid: ${path}`);
	return receipt;
}
function anchorFor({ trialId, baseSha, subject, treatmentId, attempt }) {
	return {
		trialId,
		baseSha,
		subject,
		treatmentId,
		attempt
	};
}
function assertDefinition(value, label) {
	if (!sameValue$3(value, DEFINITION_REF$2)) fail$3(`${label} does not use the fixed C5 Definition`);
}
function assertAnchor$1(receipt, anchor, label) {
	if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) fail$3(`${label} is not an object`);
	assertDefinition(receipt.definitionRef, label);
	if (receipt.trialId !== anchor.trialId || receipt.baseSha !== anchor.baseSha || receipt.subject !== anchor.subject || receipt.treatmentId !== anchor.treatmentId || receipt.attempt !== anchor.attempt) fail$3(`${label} does not match the trusted arm identity`);
	return receipt;
}
function validTimestamp(value) {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function expectedRunPrefix(anchor) {
	return `runs/issue-${anchor.subject}/${anchor.treatmentId}/attempt-${anchor.attempt}`;
}
function workerPrompt$1(snapshot, registration) {
	return [
		`You are executing the pre-registered #2702 C5 arm for issue #${snapshot.subject}.`,
		`Treatment: ${registration.treatmentId}. Attempt: ${registration.attempt}.`,
		`Work only in the provided disposable worktree at pinned commit ${registration.baseSha}.`,
		"Implement the bounded issue and verify the result locally.",
		"Do not push any branch or commit.",
		"Do not open, update, or merge a pull request.",
		"Do not edit the GitHub issue or make any other external durable write.",
		"Leave all result files in the disposable worktree; the bridge will preserve evidence.",
		"",
		`Issue title: ${snapshot.title}`,
		"Issue body:",
		snapshot.body,
		""
	].join("\n");
}
function artifactClaim(bytes, path) {
	return {
		path,
		byteLength: bytes.length,
		contentDigest: sha256Bytes$2(bytes),
		capturedBytes: Math.min(bytes.length, MAX_CAPTURE_BYTES),
		truncated: bytes.length > MAX_CAPTURE_BYTES
	};
}
function withoutDigest(receipt) {
	const value = { ...receipt };
	delete value.contentDigest;
	return value;
}
function validateSnapshot(artifacts, trial, anchor) {
	const snapshot = readReceipt$2(artifacts, `subjects/issue-${anchor.subject}.json`, "Gate2702SubjectSnapshot");
	assertDefinition(snapshot.definitionRef, "subject snapshot");
	const manifest = trial.subjectSnapshots?.find((entry) => entry?.subject === anchor.subject);
	if (snapshot.trialId !== anchor.trialId || snapshot.subject !== anchor.subject || snapshot.baseSha !== anchor.baseSha || snapshot.repository !== "shpwrck/claude-history-dashboard" || snapshot.executionMode !== "production" || typeof snapshot.title !== "string" || !snapshot.title || typeof snapshot.body !== "string" || !manifest || manifest.contentDigest !== snapshot.contentDigest) fail$3("subject snapshot is not bound to the production C5 trial");
	return snapshot;
}
function validateRegistration(artifacts, trial, anchor) {
	const prefix = expectedRunPrefix(anchor);
	const registration = assertAnchor$1(readReceipt$2(artifacts, `${prefix}/registration.json`, "Gate2702ArmRegistration"), anchor, "arm registration");
	if (registration.subjectRef !== `github:shpwrck/claude-history-dashboard#${anchor.subject}` || registration.executionMode !== "production" || typeof registration.runDir !== "string" || !isAbsolute(registration.runDir) || !registration.runDir.replaceAll("\\", "/").endsWith(`/${prefix}`) || typeof registration.worktreePath !== "string" || !isAbsolute(registration.worktreePath)) fail$3("arm registration is not the fixed production C5 arm");
	if (anchor.attempt === 1) {
		const embedded = trial.registrations?.find((candidate) => candidate?.subject === anchor.subject && candidate?.treatmentId === anchor.treatmentId && candidate?.attempt === 1);
		if (!embedded || !sameValue$3(embedded, registration)) fail$3("attempt-1 registration is not embedded in the trial receipt");
	} else {
		const parentAnchor = {
			...anchor,
			attempt: 1
		};
		const parentPrefix = expectedRunPrefix(parentAnchor);
		const parentRegistration = assertAnchor$1(readReceipt$2(artifacts, `${parentPrefix}/registration.json`, "Gate2702ArmRegistration"), parentAnchor, "attempt-1 registration");
		const parentClassification = assertAnchor$1(readReceipt$2(artifacts, `${parentPrefix}/classification.json`, "Gate2702ArmClassification"), parentAnchor, "attempt-1 classification");
		const retryOf = {
			attempt: 1,
			registrationDigest: parentRegistration.contentDigest,
			classificationDigest: parentClassification.contentDigest
		};
		if (parentClassification.registrationDigest !== parentRegistration.contentDigest || parentClassification.retry?.authorized !== true || !sameValue$3(registration.retryOf, retryOf)) fail$3("attempt-2 registration is not authorized by attempt 1");
	}
	return registration;
}
function validateBehaviorContext(context, treatmentId) {
	const treatment = TREATMENT_DEFINITIONS[treatmentId];
	const enabled = treatment.configuration.sidekick.enabled;
	const resolvedConfig = gate2702ResolvedSidekickConfig(treatment, {});
	if (context === null || typeof context !== "object" || Array.isArray(context) || context.schemaVersion !== SCHEMA_VERSION$1 || !validTimestamp(context.observedAt) || context.workerModelQualifiedId !== "claude-haiku-4-5-20251001" || context.sidekickModelQualifiedId !== (enabled ? "claude-sonnet-5" : null) || context.sidekickVersion !== (enabled ? "0.3.3" : null) || (enabled ? !SHA256_PATTERN$1.test(context.sidekickImplementationDigest ?? "") : context.sidekickImplementationDigest !== null) || !sameValue$3(context.sidekickActivation, enabled ? {
		pluginEnabled: true,
		globalPauseAbsent: true
	} : null) || !sameValue$3(context.resolvedSidekickConfig, resolvedConfig) || context.resolvedSidekickConfigDigest !== valueDigest$3(resolvedConfig) || !Array.isArray(context.instructionSources) || context.instructionsDigest !== valueDigest$3(context.instructionSources)) fail$3("preflight behavior context is not the fixed C5 treatment context");
	const order = ["user", "project"];
	let previous = -1;
	for (const source of context.instructionSources) {
		const index = order.indexOf(source?.scope);
		if (index <= previous || !SHA256_PATTERN$1.test(source?.contentDigest ?? "") || !Number.isSafeInteger(source?.characterLength) || source.characterLength <= 0 || source.characterLength > 6e3 || typeof source.truncated !== "boolean") fail$3("preflight instruction evidence is invalid");
		previous = index;
	}
	return context;
}
function validateInstallStream(artifacts, stream, relativePath, absolutePath, label) {
	const bytes = retainedBytes$1(artifacts, relativePath);
	const capturedDigest = sha256Bytes$2(bytes);
	if (stream === null || typeof stream !== "object" || Array.isArray(stream) || stream.path !== absolutePath || !Number.isSafeInteger(stream.byteLength) || stream.byteLength < 0 || !Number.isSafeInteger(stream.capturedBytes) || stream.capturedBytes !== Math.min(stream.byteLength, INSTALL_CAPTURE_BYTES) || stream.capturedBytes !== bytes.length || stream.truncated !== stream.byteLength > stream.capturedBytes || !SHA256_PATTERN$1.test(stream.contentDigest ?? "") || stream.capturedContentDigest !== capturedDigest || !stream.truncated && stream.contentDigest !== capturedDigest) fail$3(`${label} does not match its retained npm-ci stream bytes`);
	return bytes;
}
function validateInstallOutcome(artifacts, path, dispatchToken, stdoutBytes, stderrBytes, required) {
	const outcome = readJson$1(artifacts, path, required);
	if (outcome === null) return null;
	const validStream = (stream, bytes) => stream !== null && typeof stream === "object" && !Array.isArray(stream) && Number.isSafeInteger(stream.byteLength) && stream.byteLength >= 0 && Number.isSafeInteger(stream.capturedBytes) && stream.capturedBytes === Math.min(stream.byteLength, INSTALL_CAPTURE_BYTES) && stream.capturedBytes === bytes.length && stream.truncated === stream.byteLength > stream.capturedBytes && SHA256_PATTERN$1.test(stream.contentDigest ?? "") && stream.capturedContentDigest === sha256Bytes$2(bytes) && (stream.truncated || stream.contentDigest === sha256Bytes$2(bytes));
	const expectedKeys = [
		"durationMs",
		"exitCode",
		"signal",
		"stderr",
		"stdout",
		"timedOut",
		"token"
	];
	if (outcome.spawnError !== void 0) expectedKeys.push("spawnError");
	if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome) || outcome.token !== dispatchToken || !(outcome.exitCode === null || Number.isSafeInteger(outcome.exitCode) && outcome.exitCode >= 0) || !(outcome.signal === null || typeof outcome.signal === "string") || outcome.spawnError !== void 0 && (typeof outcome.spawnError !== "string" || !outcome.spawnError) || typeof outcome.durationMs !== "number" || !Number.isFinite(outcome.durationMs) || outcome.durationMs < 0 || typeof outcome.timedOut !== "boolean" || !validStream(outcome.stdout, stdoutBytes) || !validStream(outcome.stderr, stderrBytes) || !sameValue$3(Object.keys(outcome).sort(), expectedKeys.sort())) fail$3("retained npm-ci wrapper outcome is invalid");
	return outcome;
}
function validateInstallLifecycle(artifacts, registration, embedded, preflightStatus, anchor) {
	const root = `${expectedRunPrefix(anchor)}/preflight-install`;
	const preDispatch = assertAnchor$1(readReceipt$2(artifacts, `${root}/pre-dispatch.json`, "Gate2702InstallPreDispatch"), anchor, "npm-ci pre-dispatch");
	if (preDispatch.registrationDigest !== registration.contentDigest || preDispatch.program !== (preDispatch.executable ?? "npm") || !(preDispatch.executable === null || isAbsolute(preDispatch.executable)) || !sameValue$3(preDispatch.argv, ["npm", "ci"]) || preDispatch.timeoutMs !== INSTALL_TIMEOUT_MS || preDispatch.maxBufferBytes !== INSTALL_CAPTURE_BYTES || resolve(preDispatch.cwd ?? "") !== resolve(registration.worktreePath) || !UUID_PATTERN$3.test(preDispatch.dispatchToken ?? "") || !Number.isSafeInteger(preDispatch.ownerPid) || preDispatch.ownerPid <= 1 || !validTimestamp(preDispatch.startedAt)) fail$3("npm-ci pre-dispatch is not the fixed production invocation");
	const execution = assertAnchor$1(readReceipt$2(artifacts, `${root}/execution.json`, "Gate2702InstallExecution"), anchor, "npm-ci execution");
	if (execution.registrationDigest !== registration.contentDigest || execution.preDispatchDigest !== preDispatch.contentDigest || execution.program !== preDispatch.program || execution.executable !== preDispatch.executable || !sameValue$3(execution.argv, ["npm", "ci"]) || execution.timeoutMs !== INSTALL_TIMEOUT_MS || execution.maxBufferBytes !== INSTALL_CAPTURE_BYTES || execution.startedAt !== preDispatch.startedAt || !(execution.pid === null || Number.isSafeInteger(execution.pid) && execution.pid > 1) || !(execution.durationMs === null || typeof execution.durationMs === "number" && Number.isFinite(execution.durationMs) && execution.durationMs >= 0) || !(execution.exitCode === null || Number.isSafeInteger(execution.exitCode) && execution.exitCode >= 0) || !(execution.signal === null || typeof execution.signal === "string") || typeof execution.timedOut !== "boolean" || typeof execution.interrupted !== "boolean" || execution.interrupted !== (execution.durationMs === null) || typeof execution.processGroupQuiescent !== "boolean" || typeof execution.truncated !== "boolean" || typeof execution.stdout !== "string" || typeof execution.stderr !== "string" || execution.error !== void 0 && (typeof execution.error !== "string" || !execution.error)) fail$3("retained npm-ci execution receipt is invalid");
	let processReceipt = null;
	if (execution.processDigest !== void 0) {
		processReceipt = assertAnchor$1(readReceipt$2(artifacts, `${root}/process.json`, "Gate2702InstallProcess"), anchor, "npm-ci process");
		if (processReceipt.registrationDigest !== registration.contentDigest || processReceipt.preDispatchDigest !== preDispatch.contentDigest || processReceipt.dispatchToken !== preDispatch.dispatchToken || !Number.isSafeInteger(processReceipt.pid) || processReceipt.pid <= 1 || execution.processDigest !== processReceipt.contentDigest || execution.pid !== processReceipt.pid || !retainedBytes$1(artifacts, `${root}/dispatch-gate`).equals(Buffer.from(`${preDispatch.dispatchToken}\n`, "utf8"))) fail$3("npm-ci process/gate lineage is invalid");
	} else if (artifacts.has(`${root}/process.json`) || artifacts.has(`${root}/dispatch-gate`) || execution.pid !== null) fail$3("npm-ci execution omits retained process/gate evidence");
	const stdoutBytes = validateInstallStream(artifacts, execution.stdoutEvidence, `${root}/stdout.log`, `${registration.runDir}/preflight-install/stdout.log`, "npm-ci stdout");
	const stderrBytes = validateInstallStream(artifacts, execution.stderrEvidence, `${root}/stderr.log`, `${registration.runDir}/preflight-install/stderr.log`, "npm-ci stderr");
	if (execution.stdout !== stdoutBytes.toString("utf8").trim() || execution.stderr !== stderrBytes.toString("utf8").trim() || execution.truncated !== (execution.stdoutEvidence.truncated || execution.stderrEvidence.truncated)) fail$3("npm-ci captured output does not match its retained bytes");
	const outcome = validateInstallOutcome(artifacts, `${root}/outcome.json`, preDispatch.dispatchToken, stdoutBytes, stderrBytes, execution.error === void 0 && execution.interrupted === false);
	if (processReceipt === null && outcome !== null) fail$3("npm-ci outcome has no dispatched wrapper process");
	if (outcome !== null) {
		const outcomeStdout = {
			path: execution.stdoutEvidence.path,
			...outcome.stdout
		};
		const outcomeStderr = {
			path: execution.stderrEvidence.path,
			...outcome.stderr
		};
		const expectedError = outcome.spawnError ?? (outcome.timedOut ? "install-timeout" : void 0);
		if (execution.interrupted || execution.durationMs !== outcome.durationMs || execution.exitCode !== outcome.exitCode || execution.signal !== outcome.signal || execution.timedOut !== outcome.timedOut || execution.error !== expectedError || !sameValue$3(execution.stdoutEvidence, outcomeStdout) || !sameValue$3(execution.stderrEvidence, outcomeStderr) || outcome.spawnError !== void 0 && execution.error !== outcome.spawnError) fail$3("npm-ci execution does not rederive from its wrapper outcome");
	}
	if (!sameValue$3(embedded, execution)) fail$3("preflight embedded npm-ci execution differs from retained bytes");
	if (preflightStatus === "passed" && (execution.exitCode !== 0 || execution.signal !== null || execution.timedOut || execution.interrupted || execution.processGroupQuiescent !== true || execution.error !== void 0)) fail$3("passed preflight does not contain a successful npm-ci execution");
	return {
		preDispatch,
		process: processReceipt,
		outcome,
		execution,
		stdoutBytes,
		stderrBytes
	};
}
function validatePreflight(artifacts, registration, anchor) {
	const treatment = TREATMENT_DEFINITIONS[anchor.treatmentId];
	const receipt = readReceipt$2(artifacts, anchor.attempt === 1 ? `preflight/issue-${anchor.subject}.json` : `${expectedRunPrefix(anchor)}/preflight.json`, anchor.attempt === 1 ? "Gate2702PairPreflight" : "Gate2702RetryPreflight");
	assertDefinition(receipt.definitionRef, "arm preflight");
	const arm = anchor.attempt === 1 ? receipt.arms?.[anchor.treatmentId] : receipt;
	if (receipt.trialId !== anchor.trialId || receipt.subject !== anchor.subject || receipt.baseSha !== anchor.baseSha || !["passed", "failed"].includes(receipt.status) || anchor.attempt === 2 && (receipt.treatmentId !== anchor.treatmentId || receipt.attempt !== 2) || arm?.registrationDigest !== registration.contentDigest || arm.treatmentId !== void 0 && arm.treatmentId !== anchor.treatmentId || arm.attempt !== void 0 && arm.attempt !== anchor.attempt || arm.worktreePath !== void 0 && resolve(arm.worktreePath) !== resolve(registration.worktreePath) || receipt.status === "passed" && arm.environment === void 0 || (arm.environment !== void 0 || arm.environmentDigest !== void 0) && (arm.environment === void 0 || arm.environmentDigest !== valueDigest$3(arm.environment))) fail$3("arm preflight is not identity-bound to the registration");
	const expectedSidekick = treatment.configuration.sidekick;
	const enabled = expectedSidekick.enabled;
	const sidekickComplete = arm.sidekick?.version === "0.3.3" && SHA256_PATTERN$1.test(arm.sidekick?.implementationDigest ?? "") && sameValue$3(arm.sidekick?.activation, {
		pluginEnabled: true,
		globalPauseAbsent: true
	});
	const sidekickUnavailable = arm.sidekick?.version === null && arm.sidekick?.implementationDigest === null && arm.sidekick?.activation === null;
	const sidekickIncompatible = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(arm.sidekick?.version ?? "") && SHA256_PATTERN$1.test(arm.sidekick?.implementationDigest ?? "") && sameValue$3(arm.sidekick?.activation, {
		pluginEnabled: true,
		globalPauseAbsent: true
	});
	const sidekickProvided = arm.sidekick !== void 0;
	if ((receipt.status === "passed" || sidekickProvided) && (!sameValue$3(arm.sidekick?.configuration, expectedSidekick) || !enabled && !sidekickUnavailable || enabled && (receipt.status === "passed" ? !sidekickComplete : !sidekickComplete && !sidekickUnavailable && !sidekickIncompatible))) fail$3("arm preflight Sidekick evidence is not the fixed treatment");
	let behaviorContext = null;
	if (receipt.status === "passed") behaviorContext = validateBehaviorContext(arm.behaviorContext, anchor.treatmentId);
	else {
		if (!Array.isArray(receipt.errors) || receipt.errors.length === 0) fail$3("failed preflight has no structured error evidence");
		if (arm.behaviorContext !== null && arm.behaviorContext !== void 0) behaviorContext = validateBehaviorContext(arm.behaviorContext, anchor.treatmentId);
	}
	const install = validateInstallLifecycle(artifacts, registration, arm.install, receipt.status, anchor);
	return {
		receipt,
		arm,
		behaviorContext,
		install
	};
}
function validateWorktreeIdentity(artifacts, registration, anchor) {
	const receipt = assertAnchor$1(readReceipt$2(artifacts, `${expectedRunPrefix(anchor)}/worktree-identity.json`, "Gate2702WorktreeIdentity"), anchor, "worktree identity");
	if (receipt.registrationDigest !== registration.contentDigest || receipt.executionMode !== "production" || resolve(receipt.worktreePath ?? "") !== resolve(registration.worktreePath) || typeof receipt.gitDirectory !== "string" || !isAbsolute(receipt.gitDirectory) || !UUID_PATTERN$3.test(receipt.identityToken ?? "") || !validTimestamp(receipt.createdAt)) fail$3("worktree identity is not bound to its production registration");
	return receipt;
}
function validateWorkerLifecycle(artifacts, registration, snapshot, preflight, identity, anchor) {
	const prefix = expectedRunPrefix(anchor);
	const terminal = assertAnchor$1(readReceipt$2(artifacts, `${prefix}/terminal.json`, "Gate2702Terminal"), anchor, "worker terminal");
	const stdoutBytes = retainedBytes$1(artifacts, `${prefix}/stdout.log`);
	const stderrBytes = retainedBytes$1(artifacts, `${prefix}/stderr.log`);
	if (preflight.receipt.status === "failed") {
		if (artifacts.has(`${prefix}/pre-dispatch.json`) || artifacts.has(`${prefix}/process.json`) || terminal.preflightDigest !== preflight.receipt.contentDigest || terminal.outcome !== "preflight-failed" || terminal.exitCode !== null || terminal.signal !== null || terminal.timedOut !== false || terminal.processGroupQuiescent !== true || !validTimestamp(terminal.endedAt) || stdoutBytes.length !== 0 || stderrBytes.length !== 0) fail$3("preflight-failed arm contains a worker dispatch");
		return {
			terminal,
			preDispatch: null,
			process: null,
			stdoutBytes,
			stderrBytes
		};
	}
	const preDispatch = assertAnchor$1(readReceipt$2(artifacts, `${prefix}/pre-dispatch.json`, "Gate2702PreDispatch"), anchor, "worker pre-dispatch");
	const expectedEnvironment = gate2702SidekickEnvironment(TREATMENT_DEFINITIONS[anchor.treatmentId], {});
	if (preDispatch.registrationDigest !== registration.contentDigest || preDispatch.worktreeIdentityDigest !== identity.contentDigest || preDispatch.executionMode !== "production" || !sameValue$3(preDispatch.argv, WORKER_ARGV) || !sameValue$3(preDispatch.sidekickEnvironment, expectedEnvironment) || preDispatch.sidekickEnvironmentDigest !== valueDigest$3(expectedEnvironment) || resolve(preDispatch.cwd ?? "") !== resolve(registration.worktreePath) || preDispatch.promptDigest !== sha256Bytes$2(Buffer.from(workerPrompt$1(snapshot, registration), "utf8")) || !validTimestamp(preDispatch.startedAt) || terminal.preDispatchDigest !== preDispatch.contentDigest || typeof terminal.durationMs !== "number" || !Number.isFinite(terminal.durationMs) || terminal.durationMs < 0 || !validTimestamp(terminal.endedAt)) fail$3("worker dispatch does not rederive from its production inputs");
	let processReceipt = null;
	if (terminal.outcome === "spawn-error") {
		if (artifacts.has(`${prefix}/process.json`) || terminal.processDigest !== void 0 || typeof terminal.error !== "string" || !terminal.error) fail$3("spawn-error worker has contradictory process evidence");
	} else {
		processReceipt = assertAnchor$1(readReceipt$2(artifacts, `${prefix}/process.json`, "Gate2702Process"), anchor, "worker process");
		if (processReceipt.registrationDigest !== registration.contentDigest || processReceipt.preDispatchDigest !== preDispatch.contentDigest || !Number.isSafeInteger(processReceipt.pid) || processReceipt.pid <= 1 || typeof processReceipt.detachedProcessGroup !== "boolean" || !validTimestamp(processReceipt.startedAt) || processReceipt.startedAt !== preDispatch.startedAt || terminal.processDigest !== processReceipt.contentDigest || !["exited", "timed-out"].includes(terminal.outcome) || !(terminal.exitCode === null || Number.isSafeInteger(terminal.exitCode) && terminal.exitCode >= 0) || !(terminal.signal === null || typeof terminal.signal === "string") || typeof terminal.timedOut !== "boolean" || terminal.timedOut !== (terminal.outcome === "timed-out") || typeof terminal.processGroupQuiescent !== "boolean" || terminal.error !== void 0 && (typeof terminal.error !== "string" || !terminal.error)) fail$3("worker terminal does not bind its exact process lifecycle");
	}
	return {
		terminal,
		preDispatch,
		process: processReceipt,
		stdoutBytes,
		stderrBytes
	};
}
function validateProbe(probe, program, args, environmentEntry, label) {
	if (probe === null || typeof probe !== "object" || Array.isArray(probe) || !sameValue$3(probe.argv, [program, ...args]) || probe.timeoutMs !== 6e4 || probe.maxBufferBytes !== 256 * 1024 || probe.processGroupQuiescent !== true || typeof probe.program !== "string" || !probe.program || environmentEntry?.executable !== probe.program || environmentEntry?.version !== probe.stdout) fail$3(`${label} does not retain its exact environment probe`);
}
function validateCheckEnvironment(probes, environment, label) {
	for (const [name, [program, args]] of Object.entries({
		npm: ["npm", ["--version"]],
		claude: ["claude", ["--version"]],
		vitest: ["npx", [
			"--no-install",
			"vitest",
			"--version"
		]],
		typescript: ["npx", [
			"--no-install",
			"tsc",
			"--version"
		]]
	})) validateProbe(probes?.[name], program, args, environment?.[name], `${label} ${name}`);
	if (typeof environment?.node?.executable !== "string" || !environment.node.executable || typeof environment.node.version !== "string" || !environment.node.version) fail$3(`${label} node environment is invalid`);
}
function validateCapturedStream(artifacts, stream, relativePath, absolutePath, label) {
	const bytes = retainedBytes$1(artifacts, relativePath);
	const capturedDigest = sha256Bytes$2(bytes);
	if (stream === null || typeof stream !== "object" || Array.isArray(stream) || stream.path !== absolutePath || !Number.isSafeInteger(stream.byteLength) || stream.byteLength < 0 || !Number.isSafeInteger(stream.capturedBytes) || stream.capturedBytes !== Math.min(stream.byteLength, MAX_CAPTURE_BYTES) || stream.capturedBytes !== bytes.length || stream.truncated !== stream.byteLength > stream.capturedBytes || !SHA256_PATTERN$1.test(stream.contentDigest ?? "") || stream.capturedContentDigest !== capturedDigest || !stream.truncated && stream.contentDigest !== capturedDigest) fail$3(`${label} does not match its retained stream bytes`);
	return bytes;
}
function checkSummary(execution) {
	return {
		checkId: execution.checkId,
		status: execution.exitCode === 0 && execution.signal === null && execution.spawnError === void 0 && execution.timedOut === false && execution.interrupted === false && execution.processGroupQuiescent === true ? "passed" : "failed",
		evidenceDigest: execution.contentDigest,
		exitCode: execution.exitCode,
		signal: execution.signal,
		timedOut: execution.timedOut,
		interrupted: execution.interrupted,
		environmentDigest: execution.environmentDigest,
		...execution.environmentErrors ? { environmentErrors: execution.environmentErrors } : {},
		processGroupQuiescent: execution.processGroupQuiescent,
		truncated: execution.truncated,
		...execution.spawnError ? { spawnError: execution.spawnError } : {}
	};
}
function validatePlainOutcome(artifacts, path, dispatchToken, required) {
	const outcome = readJson$1(artifacts, path, required);
	if (outcome === null) return null;
	const expectedKeys = [
		"exitCode",
		"signal",
		"token"
	];
	if (outcome.spawnError !== void 0) expectedKeys.push("spawnError");
	if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome) || outcome.token !== dispatchToken || !(outcome.exitCode === null || Number.isSafeInteger(outcome.exitCode) && outcome.exitCode >= 0) || !(outcome.signal === null || typeof outcome.signal === "string") || outcome.spawnError !== void 0 && (typeof outcome.spawnError !== "string" || !outcome.spawnError) || !sameValue$3(Object.keys(outcome).sort(), expectedKeys.sort())) fail$3("declared check wrapper outcome is invalid");
	return outcome;
}
function validateOneCheck(artifacts, registration, anchor, check) {
	const prefix = expectedRunPrefix(anchor);
	const slug = check.id.replaceAll("/", "_");
	const root = `${prefix}/checks/${slug}`;
	const preDispatch = assertAnchor$1(readReceipt$2(artifacts, `${root}.pre-dispatch.json`, "Gate2702CheckPreDispatch"), anchor, `${check.id} pre-dispatch`);
	if (preDispatch.registrationDigest !== registration.contentDigest || preDispatch.checkId !== check.id || !sameValue$3(preDispatch.argv, check.argv) || preDispatch.timeoutMs !== check.timeoutMs || preDispatch.testEffectiveTimeoutMs !== void 0 || resolve(preDispatch.cwd ?? "") !== resolve(registration.worktreePath) || preDispatch.environmentDigest !== valueDigest$3(preDispatch.environment) || preDispatch.environmentErrors !== void 0 && !Array.isArray(preDispatch.environmentErrors) || !UUID_PATTERN$3.test(preDispatch.dispatchToken ?? "") || !Number.isSafeInteger(preDispatch.ownerPid) || preDispatch.ownerPid <= 1 || !validTimestamp(preDispatch.startedAt)) fail$3(`${check.id} pre-dispatch is not the fixed production check`);
	validateCheckEnvironment(preDispatch.environmentProbes, preDispatch.environment, `${check.id} pre-dispatch`);
	const execution = assertAnchor$1(readReceipt$2(artifacts, `${root}.json`, "Gate2702CheckExecution"), anchor, `${check.id} execution`);
	if (execution.registrationDigest !== registration.contentDigest || execution.preDispatchDigest !== preDispatch.contentDigest || execution.checkId !== check.id || !sameValue$3(execution.argv, check.argv) || execution.timeoutMs !== check.timeoutMs || execution.testEffectiveTimeoutMs !== void 0 || execution.environmentDigest !== preDispatch.environmentDigest || !sameValue$3(execution.environment, preDispatch.environment) || !sameValue$3(execution.environmentProbes, preDispatch.environmentProbes) || !sameValue$3(execution.environmentErrors, preDispatch.environmentErrors) || execution.startedAt !== preDispatch.startedAt || !(execution.durationMs === null || typeof execution.durationMs === "number" && Number.isFinite(execution.durationMs) && execution.durationMs >= 0) || !(execution.exitCode === null || Number.isSafeInteger(execution.exitCode) && execution.exitCode >= 0) || !(execution.signal === null || typeof execution.signal === "string") || typeof execution.timedOut !== "boolean" || typeof execution.interrupted !== "boolean" || execution.interrupted !== (execution.durationMs === null) || typeof execution.processGroupQuiescent !== "boolean" || typeof execution.truncated !== "boolean" || execution.spawnError !== void 0 && (typeof execution.spawnError !== "string" || !execution.spawnError)) fail$3(`${check.id} execution receipt is invalid`);
	let processReceipt = null;
	if (execution.processDigest !== void 0) {
		processReceipt = assertAnchor$1(readReceipt$2(artifacts, `${root}.process.json`, "Gate2702CheckProcess"), anchor, `${check.id} process`);
		if (processReceipt.registrationDigest !== registration.contentDigest || processReceipt.preDispatchDigest !== preDispatch.contentDigest || processReceipt.checkId !== check.id || processReceipt.dispatchToken !== preDispatch.dispatchToken || !Number.isSafeInteger(processReceipt.pid) || processReceipt.pid <= 1 || execution.processDigest !== processReceipt.contentDigest || !retainedBytes$1(artifacts, `${root}.dispatch-gate`).equals(Buffer.from(`${preDispatch.dispatchToken}\n`, "utf8"))) fail$3(`${check.id} process/gate lineage is invalid`);
	} else if (artifacts.has(`${root}.process.json`) || artifacts.has(`${root}.dispatch-gate`)) fail$3(`${check.id} execution omits retained process/gate evidence`);
	const successfulWrapper = execution.timedOut === false && execution.interrupted === false && execution.spawnError === void 0;
	const outcome = validatePlainOutcome(artifacts, `${root}.outcome.json`, preDispatch.dispatchToken, successfulWrapper);
	if (successfulWrapper && processReceipt === null || processReceipt === null && outcome !== null || execution.interrupted && outcome !== null) fail$3(`${check.id} outcome has no valid dispatched wrapper lineage`);
	if (outcome && execution.timedOut === false && (execution.exitCode !== outcome.exitCode || execution.signal !== outcome.signal || execution.spawnError !== outcome.spawnError)) fail$3(`${check.id} execution does not rederive from its wrapper outcome`);
	const stdoutBytes = validateCapturedStream(artifacts, execution.stdout, `${root}.stdout.log`, `${registration.runDir}/checks/${slug}.stdout.log`, `${check.id} stdout`);
	const stderrBytes = validateCapturedStream(artifacts, execution.stderr, `${root}.stderr.log`, `${registration.runDir}/checks/${slug}.stderr.log`, `${check.id} stderr`);
	if (execution.truncated !== (execution.stdout.truncated || execution.stderr.truncated)) fail$3(`${check.id} truncation summary does not rederive`);
	return {
		preDispatch,
		process: processReceipt,
		outcome,
		execution,
		stdoutBytes,
		stderrBytes,
		summary: checkSummary(execution)
	};
}
function validateChecks(artifacts, registration, anchor) {
	return CHECKS.map((check) => validateOneCheck(artifacts, registration, anchor, check));
}
function decodeCanonicalBase64(value, label) {
	if (typeof value !== "string") fail$3(`${label} has no base64 bytes`);
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value) fail$3(`${label} has malformed base64 bytes`);
	return bytes;
}
function validateWorktreeEvidence(artifacts, registration, anchor) {
	const diff = readJson$1(artifacts, `generated/diffs/issue-${anchor.subject}.${anchor.treatmentId}.attempt-${anchor.attempt}.json`);
	assertAnchor$1(diff, anchor, "sealed worktree diff");
	if (diff.schemaVersion !== SCHEMA_VERSION$1 || diff.kind !== "Gate2702SealedWorktreeDiff" || diff.registrationDigest !== registration.contentDigest || !/^[0-9a-f]{40}$/.test(diff.head ?? "") || !Array.isArray(diff.untracked)) fail$3("sealed worktree diff has invalid arm lineage");
	const patchBytes = decodeCanonicalBase64(diff.trackedPatch?.bytes, "tracked worktree patch");
	if (diff.trackedPatch.encoding !== "base64" || diff.trackedPatch.sizeBytes !== patchBytes.length || diff.trackedPatch.contentDigest !== sha256Bytes$2(patchBytes)) fail$3("tracked worktree patch does not match its retained bytes");
	if (diff.untracked.length > MAX_UNTRACKED_FILES$1) fail$3("sealed worktree diff exceeds its file-count bound");
	const paths = diff.untracked.map((entry) => entry?.path);
	if (!sameValue$3(paths, [...paths].sort()) || new Set(paths).size !== paths.length) fail$3("sealed untracked paths are not uniquely sorted");
	let aggregateBytes = patchBytes.length;
	const untracked = diff.untracked.map((entry) => {
		const normalizedPath = typeof entry?.path === "string" ? normalize(entry.path) : null;
		if (typeof entry.path !== "string" || !entry.path || isAbsolute(entry.path) || normalizedPath === ".." || normalizedPath.startsWith(`..${sep}`) || entry.path.includes("\0") || !["file", "symlink"].includes(entry.kind) || !Number.isSafeInteger(entry.mode) || entry.mode < 0) fail$3("sealed untracked worktree entry is invalid");
		const bytes = entry.encoding === "base64" ? decodeCanonicalBase64(entry.bytes, `untracked ${entry.path}`) : entry.encoding === "utf8" && typeof entry.bytes === "string" ? Buffer.from(entry.bytes, "utf8") : null;
		if (bytes === null || entry.kind === "file" && entry.encoding !== "base64" || entry.kind === "symlink" && entry.encoding !== "utf8" || entry.sizeBytes !== bytes.length || entry.contentDigest !== sha256Bytes$2(bytes)) fail$3(`sealed untracked ${entry.path} does not match its bytes`);
		aggregateBytes += bytes.length;
		if (aggregateBytes > MAX_ARTIFACT_BYTES) fail$3("sealed worktree source exceeds its aggregate byte bound");
		return {
			path: entry.path,
			kind: entry.kind,
			mode: entry.mode,
			sizeBytes: entry.sizeBytes,
			contentDigest: entry.contentDigest,
			encoding: entry.encoding
		};
	});
	const body = {
		baseSha: anchor.baseSha,
		trackedPatch: {
			sizeBytes: patchBytes.length,
			contentDigest: sha256Bytes$2(patchBytes)
		},
		untracked,
		aggregateBytes
	};
	return {
		diff,
		evidence: {
			...body,
			contentDigest: valueDigest$3(body)
		}
	};
}
function assertNoCheckArtifacts(artifacts, anchor) {
	const prefix = `${expectedRunPrefix(anchor)}/checks/`;
	for (const path of artifacts.keys()) if (path.startsWith(prefix)) fail$3("classification contains check evidence for an undispatched check");
}
function classificationBase(registration, preflight, terminal) {
	return {
		schemaVersion: SCHEMA_VERSION$1,
		kind: "Gate2702ArmClassification",
		definitionRef: registration.definitionRef,
		registrationDigest: registration.contentDigest,
		preflightDigest: preflight.contentDigest,
		terminalDigest: terminal.contentDigest,
		trialId: registration.trialId,
		subject: registration.subject,
		treatmentId: registration.treatmentId,
		attempt: registration.attempt,
		baseSha: registration.baseSha
	};
}
function retryDisposition(attempt, reason, authorized = attempt === 1) {
	return {
		authorized,
		reason,
		maximumAttempt: 2
	};
}
function assertBehaviorVerification(classification, behaviorContext) {
	const verification = classification.behaviorVerification;
	if (verification === null || typeof verification !== "object" || Array.isArray(verification) || verification.behaviorContextDigest !== valueDigest$3(behaviorContext) || !validTimestamp(verification.verifiedAt)) fail$3("classification behavior verification does not bind its preflight context");
	return verification;
}
function parseWorkerResult(bytes) {
	try {
		const value = JSON.parse(bytes.toString("utf8"));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}
function validateClassification(artifacts, registration, preflight, lifecycle, anchor) {
	const classification = assertAnchor$1(readReceipt$2(artifacts, `${expectedRunPrefix(anchor)}/classification.json`, "Gate2702ArmClassification"), anchor, "arm classification");
	const base = classificationBase(registration, preflight.receipt, lifecycle.terminal);
	const workerArtifacts = {
		stdout: artifactClaim(lifecycle.stdoutBytes, `${registration.runDir}/stdout.log`),
		stderr: artifactClaim(lifecycle.stderrBytes, `${registration.runDir}/stderr.log`)
	};
	if (!sameValue$3(classification.workerArtifacts, workerArtifacts)) fail$3("classification worker artifacts do not match retained bytes");
	let expected;
	let checks = [];
	let worktree = null;
	if (preflight.receipt.status === "failed") {
		assertNoCheckArtifacts(artifacts, anchor);
		expected = {
			...base,
			status: "failed",
			eligible: false,
			workerArtifacts,
			checkResults: [],
			error: {
				code: "tooling-artifact",
				message: "paired C5 environment preflight failed before model dispatch",
				preflightErrors: preflight.receipt.errors ?? []
			},
			retry: retryDisposition(anchor.attempt, "tooling-artifact")
		};
	} else if (classification.error?.code === "behavior-context-drift") {
		assertNoCheckArtifacts(artifacts, anchor);
		const behaviorVerification = assertBehaviorVerification(classification, preflight.behaviorContext);
		if (typeof classification.error.detail !== "string" || !classification.error.detail) fail$3("behavior-context drift has no retained failure detail");
		expected = {
			...base,
			status: "failed",
			eligible: false,
			workerArtifacts,
			checkResults: [],
			behaviorVerification,
			error: {
				code: "behavior-context-drift",
				message: "the C5 behavior context changed after preflight and is excluded",
				detail: classification.error.detail
			},
			retry: retryDisposition(anchor.attempt, "tooling-artifact")
		};
	} else {
		const stdout = workerArtifacts.stdout;
		const stderr = workerArtifacts.stderr;
		const workerResult = stdout.truncated ? null : parseWorkerResult(lifecycle.stdoutBytes);
		if (lifecycle.terminal.outcome === "timed-out" || lifecycle.terminal.timedOut === true) {
			assertNoCheckArtifacts(artifacts, anchor);
			expected = {
				...base,
				status: "cancelled",
				eligible: false,
				workerArtifacts,
				checkResults: [],
				error: {
					code: "timeout",
					message: "the C5 worker exceeded its fixed wall-time limit"
				},
				retry: retryDisposition(anchor.attempt, "timeout")
			};
		} else if (workerResult?.subtype === "error_max_budget_usd") {
			assertNoCheckArtifacts(artifacts, anchor);
			expected = {
				...base,
				status: "cancelled",
				eligible: false,
				workerArtifacts,
				checkResults: [],
				error: {
					code: "budget-exhausted",
					message: "Claude reported the pre-registered worker budget ceiling"
				},
				retry: retryDisposition(anchor.attempt, "budget-exhausted", false)
			};
		} else if (stdout.truncated || stderr.truncated) {
			assertNoCheckArtifacts(artifacts, anchor);
			expected = {
				...base,
				status: "cancelled",
				eligible: false,
				workerArtifacts,
				checkResults: [],
				error: {
					code: "truncated-evidence",
					message: "worker stdout or stderr exceeded the fixed 2 MiB evidence bound"
				},
				retry: retryDisposition(anchor.attempt, "truncated-evidence")
			};
		} else if (lifecycle.terminal.outcome === "spawn-error" || lifecycle.terminal.exitCode !== 0 || lifecycle.terminal.processGroupQuiescent !== true) {
			assertNoCheckArtifacts(artifacts, anchor);
			expected = {
				...base,
				status: "failed",
				eligible: false,
				workerArtifacts,
				checkResults: [],
				error: {
					code: "worker-process-failure",
					message: "the preflighted worker process did not complete successfully",
					outcome: lifecycle.terminal.outcome,
					exitCode: lifecycle.terminal.exitCode,
					signal: lifecycle.terminal.signal
				},
				retry: retryDisposition(anchor.attempt, "tooling-artifact")
			};
		} else if (lifecycle.terminal.outcome !== "exited" || lifecycle.terminal.exitCode !== 0 || lifecycle.terminal.timedOut === true || lifecycle.terminal.processGroupQuiescent !== true) fail$3("worker terminal is not a completed C5 arm");
		else if (workerResult?.type !== "result" || workerResult?.subtype !== "success" || typeof workerResult?.result !== "string") {
			assertNoCheckArtifacts(artifacts, anchor);
			expected = {
				...base,
				status: "failed",
				eligible: false,
				workerArtifacts,
				checkResults: [],
				error: {
					code: "worker-output-invalid",
					message: "Claude did not emit one structured successful result"
				},
				retry: retryDisposition(anchor.attempt, "tooling-artifact")
			};
		} else {
			const behaviorVerification = assertBehaviorVerification(classification, preflight.behaviorContext);
			checks = validateChecks(artifacts, registration, anchor);
			const summaries = checks.map((check) => check.summary);
			const timedOutCheck = summaries.find((result) => result.timedOut);
			const truncatedCheck = summaries.find((result) => result.truncated);
			const toolingFailure = summaries.find((result) => result.spawnError !== void 0 || (result.environmentErrors?.length ?? 0) > 0 || result.exitCode === null || result.exitCode === 127 || result.signal !== null || result.processGroupQuiescent !== true);
			const genuineCheckFailure = summaries.find((result) => result.status === "failed" || result.exitCode !== 0);
			let disposition;
			if (timedOutCheck) disposition = {
				status: "cancelled",
				eligible: false,
				error: {
					code: "timeout",
					checkId: timedOutCheck.checkId,
					message: "a declared check exceeded its pre-registered timeout"
				},
				retry: retryDisposition(anchor.attempt, "timeout")
			};
			else if (truncatedCheck) disposition = {
				status: "cancelled",
				eligible: false,
				error: {
					code: "truncated-evidence",
					checkId: truncatedCheck.checkId,
					message: "a declared check exceeded its fixed 2 MiB output bound"
				},
				retry: retryDisposition(anchor.attempt, "truncated-evidence")
			};
			else if (toolingFailure) disposition = {
				status: "failed",
				eligible: false,
				error: {
					code: "tooling-artifact",
					checkId: toolingFailure.checkId,
					message: "a declared check could not execute with the preflighted toolchain"
				},
				retry: retryDisposition(anchor.attempt, "tooling-artifact")
			};
			else if (genuineCheckFailure) disposition = {
				status: "failed",
				eligible: false,
				error: {
					code: "genuine-check-failure",
					checkId: genuineCheckFailure.checkId,
					message: "a declared check completed with a failing result"
				},
				retry: retryDisposition(anchor.attempt, "genuine-result", false)
			};
			else {
				disposition = {
					status: "succeeded",
					eligible: true,
					retry: retryDisposition(anchor.attempt, "genuine-result", false)
				};
				worktree = validateWorktreeEvidence(artifacts, registration, anchor);
			}
			expected = {
				...base,
				...disposition,
				behaviorVerification,
				workerArtifacts,
				...worktree ? { worktreeEvidence: worktree.evidence } : {},
				checkResults: summaries
			};
		}
	}
	if (!sameValue$3(withoutDigest(classification), expected)) fail$3("classification does not rederive from retained worker/check evidence");
	return {
		classification,
		checks,
		worktree
	};
}
/**
* Validate and rederive one retained C5 arm classification.
*
* @param {object} input
* @param {Map<string, Buffer|Uint8Array>} input.artifactBytesByPath exact
*   retained bytes keyed by trial-relative path
* @param {string} input.trialId trusted trial UUID
* @param {string} input.baseSha trusted pinned Git commit
* @param {number} input.subject trusted C5 issue number
* @param {"haiku-solo"|"haiku-sonnet-sidekick"} input.treatmentId trusted
*   treatment identity
* @param {1|2} input.attempt trusted arm attempt
*/
function validateGate2702ClassificationEvidence({ artifactBytesByPath, trialId, baseSha, subject, treatmentId, attempt }) {
	const artifacts = requireArtifactMap$1(artifactBytesByPath);
	if (!UUID_PATTERN$3.test(trialId ?? "")) fail$3("trialId is not an RFC 4122 UUID");
	if (!/^[0-9a-f]{40}$/.test(baseSha ?? "")) fail$3("baseSha is not a pinned Git SHA");
	if (!SUBJECTS$1.has(subject)) fail$3("subject is not part of the fixed C5 workload");
	if (!TREATMENTS$2.has(treatmentId)) fail$3("treatmentId is not part of C5");
	if (attempt !== 1 && attempt !== 2) fail$3("attempt must be 1 or 2");
	const trial = readReceipt$2(artifacts, "trial.json", "Gate2702Trial");
	if (trial.trialId !== trialId || trial.baseSha !== baseSha || trial.repository !== "shpwrck/claude-history-dashboard" || trial.executionMode !== "production" || !sameValue$3(trial.definitionRef, DEFINITION_REF$2)) fail$3("retained trial does not match the trusted production C5 identity");
	const anchor = anchorFor({
		trialId,
		baseSha,
		subject,
		treatmentId,
		attempt
	});
	const snapshot = validateSnapshot(artifacts, trial, anchor);
	const registration = validateRegistration(artifacts, trial, anchor);
	const preflight = validatePreflight(artifacts, registration, anchor);
	const identity = validateWorktreeIdentity(artifacts, registration, anchor);
	const lifecycle = validateWorkerLifecycle(artifacts, registration, snapshot, preflight, identity, anchor);
	const verified = validateClassification(artifacts, registration, preflight, lifecycle, anchor);
	return {
		trial,
		snapshot,
		registration,
		preflight: preflight.receipt,
		install: preflight.install,
		identity,
		preDispatch: lifecycle.preDispatch,
		process: lifecycle.process,
		terminal: lifecycle.terminal,
		classification: verified.classification,
		checks: verified.checks,
		worktree: verified.worktree
	};
}
var SCHEMA_VERSION$1, MAX_ARTIFACT_BYTES, SHA256_PATTERN$1, UUID_PATTERN$3, DEFINITION_REF$2, TREATMENTS$2, SUBJECTS$1, MAX_CAPTURE_BYTES, MAX_UNTRACKED_FILES$1, INSTALL_TIMEOUT_MS, INSTALL_CAPTURE_BYTES, CHECKS, WORKER_ARGV, TREATMENT_DEFINITIONS;
var init_seal_classification = __esmMin((() => {
	init_behavior_context();
	SCHEMA_VERSION$1 = 1;
	MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
	SHA256_PATTERN$1 = /^sha256:[0-9a-f]{64}$/;
	UUID_PATTERN$3 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	DEFINITION_REF$2 = Object.freeze({
		definitionId: "experiments/gate-2702-c5",
		definitionVersion: 1,
		contentDigest: "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba"
	});
	TREATMENTS$2 = new Set(["haiku-solo", "haiku-sonnet-sidekick"]);
	SUBJECTS$1 = new Set([
		2760,
		2719,
		2713,
		2706,
		2710,
		2670
	]);
	MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
	MAX_UNTRACKED_FILES$1 = 4096;
	INSTALL_TIMEOUT_MS = 12e5;
	INSTALL_CAPTURE_BYTES = 256 * 1024;
	CHECKS = Object.freeze([Object.freeze({
		id: "checks/gate-2702-vitest",
		argv: Object.freeze([
			"npx",
			"vitest",
			"run"
		]),
		timeoutMs: 72e4
	}), Object.freeze({
		id: "checks/gate-2702-typecheck",
		argv: Object.freeze([
			"npm",
			"run",
			"typecheck"
		]),
		timeoutMs: 36e4
	})]);
	WORKER_ARGV = Object.freeze([
		"claude",
		"-p",
		"--model",
		GATE_2702_WORKER_MODEL_ID,
		"--output-format",
		"json",
		"--dangerously-skip-permissions",
		"--strict-mcp-config",
		"--max-budget-usd",
		"15"
	]);
	TREATMENT_DEFINITIONS = Object.freeze({
		"haiku-solo": Object.freeze({
			id: "haiku-solo",
			configuration: Object.freeze({ sidekick: Object.freeze({
				enabled: false,
				sessionBudgetUsd: 0,
				perCallBudgetUsd: 0
			}) })
		}),
		"haiku-sonnet-sidekick": Object.freeze({
			id: "haiku-sonnet-sidekick",
			configuration: Object.freeze({ sidekick: Object.freeze({
				enabled: true,
				reviewerTier: "sonnet",
				gate: "checkpoint",
				sessionBudgetUsd: 2,
				perCallBudgetUsd: 1
			}) })
		})
	});
}));
//#endregion
//#region scripts/gate-2702/seal-judge.mjs
/**
* Pure judge-evidence verification for the sealed #2702 C5 bridge.
*
* `validateGate2702JudgeEvidence` accepts a map from trial-relative artifact
* paths to their exact retained bytes. It performs no filesystem, process, or
* environment access. The caller supplies the independently trusted trial
* identity; this module verifies receipt digests and rederives the frozen
* input, both blind requests, every referenced durable attempt lifecycle, and
* the final `Gate2702JudgeResult` body.
*/
function fail$2(message) {
	throw new Error(message);
}
function canonicalValue$2(value) {
	if (Array.isArray(value)) return value.map(canonicalValue$2);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue$2(value[key])]));
}
function canonicalJson$2(value) {
	return JSON.stringify(canonicalValue$2(value));
}
function sameValue$2(left, right) {
	return canonicalJson$2(left) === canonicalJson$2(right);
}
function sha256Bytes$1(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function valueDigest$2(value) {
	return sha256Bytes$1(Buffer.from(canonicalJson$2(value), "utf8"));
}
function receiptDigest$1(receipt) {
	const withoutDigest = { ...receipt };
	delete withoutDigest.contentDigest;
	return valueDigest$2(withoutDigest);
}
function requireArtifactMap(artifactBytesByPath) {
	if (artifactBytesByPath === null || typeof artifactBytesByPath !== "object" || typeof artifactBytesByPath.get !== "function" || typeof artifactBytesByPath.has !== "function" || typeof artifactBytesByPath.keys !== "function") fail$2("artifactBytesByPath must be a retained-artifact map");
	for (const path of artifactBytesByPath.keys()) if (typeof path !== "string" || path.length === 0) fail$2("retained artifact map contains an invalid path");
	return artifactBytesByPath;
}
function retainedBytes(artifacts, path, required = true) {
	if (!artifacts.has(path)) {
		if (!required) return null;
		fail$2(`missing retained judge artifact: ${path}`);
	}
	const value = artifacts.get(path);
	if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail$2(`retained judge artifact is not bytes: ${path}`);
	const bytes = Buffer.from(value);
	if (bytes.length > MAX_SOURCE_BYTES) fail$2(`retained judge artifact exceeds its fixed size limit: ${path}`);
	return bytes;
}
function readReceipt$1(artifacts, path, kind, required = true) {
	const bytes = retainedBytes(artifacts, path, required);
	if (bytes === null) return null;
	let receipt;
	try {
		receipt = JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		fail$2(`could not decode retained ${kind} at ${path}: ${error.message}`);
	}
	if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt) || receipt.schemaVersion !== SCHEMA_VERSION || receipt.kind !== kind) fail$2(`expected retained ${kind} schema version ${SCHEMA_VERSION}: ${path}`);
	if (!SHA256_PATTERN.test(receipt.contentDigest ?? "") || receipt.contentDigest !== receiptDigest$1(receipt)) fail$2(`retained ${kind} content digest does not match: ${path}`);
	return receipt;
}
function assertAnchor(receipt, anchor, label, includeSubject = true) {
	if (!sameValue$2(receipt.definitionRef, DEFINITION_REF$1) || receipt.trialId !== anchor.trialId || receipt.baseSha !== anchor.baseSha || includeSubject && receipt.subject !== anchor.subject) fail$2(`${label} identity does not match the retained C5 trial`);
	return receipt;
}
function assertProduction(receipt, label) {
	if (receipt.executionMode !== "production") fail$2(`${label} does not bind production execution mode`);
}
function decodeBase64$1(value, label) {
	if (typeof value !== "string") fail$2(`${label} has no retained bytes`);
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value) fail$2(`${label} has invalid base64`);
	return bytes;
}
function decodeFrozenEntry(entry, label) {
	if (entry?.encoding === "base64") return decodeBase64$1(entry.bytes, label);
	if (entry?.encoding === "utf8" && typeof entry.bytes === "string") return Buffer.from(entry.bytes, "utf8");
	fail$2(`${label} has an unsupported encoding`);
}
function validateFrozenDiff$1(diff, treatmentId) {
	const patch = diff?.trackedPatch;
	if (patch?.encoding !== "base64") fail$2(`${treatmentId} tracked patch encoding is invalid`);
	const patchBytes = decodeFrozenEntry(patch, `${treatmentId} tracked patch`);
	if (patch.sizeBytes !== patchBytes.length || patch.contentDigest !== sha256Bytes$1(patchBytes)) fail$2(`${treatmentId} tracked patch digest is invalid`);
	if (!Array.isArray(diff?.untracked)) fail$2(`${treatmentId} untracked evidence is invalid`);
	if (diff.untracked.length > MAX_UNTRACKED_FILES) fail$2(`${treatmentId} untracked evidence exceeds its fixed file limit`);
	const paths = diff.untracked.map((entry) => entry?.path);
	if (paths.some((path) => typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.split("/").includes("..")) || new Set(paths).size !== paths.length || !sameValue$2(paths, [...paths].sort())) fail$2(`${treatmentId} untracked evidence paths are invalid`);
	let aggregateBytes = patchBytes.length;
	const untrackedEvidence = [];
	for (const entry of diff.untracked) {
		if (!["file", "symlink"].includes(entry?.kind) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.kind === "file" && entry.encoding !== "base64" || entry.kind === "symlink" && entry.encoding !== "utf8") fail$2(`${treatmentId} untracked ${entry?.path} identity is invalid`);
		const bytes = decodeFrozenEntry(entry, `${treatmentId} untracked ${entry.path}`);
		if (entry.sizeBytes !== bytes.length || entry.contentDigest !== sha256Bytes$1(bytes)) fail$2(`${treatmentId} untracked ${entry.path} digest is invalid`);
		aggregateBytes += bytes.length;
		if (aggregateBytes > MAX_SOURCE_BYTES) fail$2(`${treatmentId} aggregate source exceeds its evidence cap`);
		const { bytes: _bytes, ...metadata } = entry;
		untrackedEvidence.push(metadata);
	}
	return {
		diff,
		body: {
			baseSha: null,
			trackedPatch: {
				sizeBytes: patchBytes.length,
				contentDigest: sha256Bytes$1(patchBytes)
			},
			untracked: untrackedEvidence,
			aggregateBytes
		}
	};
}
function worktreeEvidenceFromDiff(diffValidation, baseSha) {
	const body = {
		...diffValidation.body,
		baseSha
	};
	return {
		...body,
		contentDigest: valueDigest$2(body)
	};
}
function artifactText(workerResult, diff, registration) {
	return [
		workerResult,
		"[FINAL TRACKED DIFF]",
		Buffer.from(diff.trackedPatch.bytes, "base64").toString("utf8"),
		diff.untracked.map((entry) => `[UNTRACKED ${entry.kind} ${entry.path}; ${entry.encoding}]\n${entry.bytes}`).join("\n\n")
	].filter(Boolean).join("\n\n").replaceAll(registration.worktreePath, "<worktree>").replaceAll(registration.runDir, "<run>").replaceAll(registration.treatmentId, "<arm>").replace(/claude-(?:haiku|sonnet|opus)-[a-z0-9-]+/gi, "<model>");
}
function workerPrompt(snapshot, registration) {
	return [
		`You are executing the pre-registered #2702 C5 arm for issue #${snapshot.subject}.`,
		`Treatment: ${registration.treatmentId}. Attempt: ${registration.attempt}.`,
		`Work only in the provided disposable worktree at pinned commit ${registration.baseSha}.`,
		"Implement the bounded issue and verify the result locally.",
		"Do not push any branch or commit.",
		"Do not open, update, or merge a pull request.",
		"Do not edit the GitHub issue or make any other external durable write.",
		"Leave all result files in the disposable worktree; the bridge will preserve evidence.",
		"",
		`Issue title: ${snapshot.title}`,
		"Issue body:",
		snapshot.body,
		""
	].join("\n");
}
function expectedWorkerArgv() {
	return [
		"claude",
		"-p",
		"--model",
		"claude-haiku-4-5-20251001",
		"--output-format",
		"json",
		"--dangerously-skip-permissions",
		"--strict-mcp-config",
		"--max-budget-usd",
		"15"
	];
}
function exactTreatmentKeys(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) && sameValue$2(Object.keys(value).sort(), [...TREATMENTS$1].sort());
}
function validateFrozenSource(artifacts, anchor) {
	const trial = assertAnchor(readReceipt$1(artifacts, "trial.json", "Gate2702Trial"), anchor, "trial", false);
	assertProduction(trial, "trial");
	if (typeof trial.worktreeRoot !== "string" || !isAbsolute(trial.worktreeRoot)) fail$2("trial does not retain its production worktree root");
	const snapshot = assertAnchor(readReceipt$1(artifacts, `subjects/issue-${anchor.subject}.json`, "Gate2702SubjectSnapshot"), anchor, "subject snapshot");
	assertProduction(snapshot, "subject snapshot");
	if (typeof snapshot.title !== "string" || typeof snapshot.body !== "string") fail$2("subject snapshot lacks frozen task text");
	const snapshotManifest = Array.isArray(trial.subjectSnapshots) ? trial.subjectSnapshots.filter((entry) => entry?.subject === anchor.subject) : [];
	if (snapshotManifest.length !== 1 || !sameValue$2(snapshotManifest[0], {
		subject: anchor.subject,
		contentDigest: snapshot.contentDigest
	})) fail$2("subject snapshot is not bound by the trial manifest");
	const selection = assertAnchor(readReceipt$1(artifacts, `pair-selection/issue-${anchor.subject}.json`, "Gate2702PairSelection"), anchor, "pair selection");
	if (!exactTreatmentKeys(selection.arms)) fail$2("pair selection does not contain the exact C5 treatments");
	const arms = {};
	for (const treatmentId of TREATMENTS$1) {
		const selected = selection.arms[treatmentId];
		if (selected?.treatmentId !== treatmentId || ![1, 2].includes(selected.attempt) || !SHA256_PATTERN.test(selected.registrationDigest ?? "") || !SHA256_PATTERN.test(selected.classificationDigest ?? "")) fail$2(`pair selection has no exact ${treatmentId} arm`);
		const prefix = `runs/issue-${anchor.subject}/${treatmentId}/attempt-${selected.attempt}`;
		const registration = assertAnchor(readReceipt$1(artifacts, `${prefix}/registration.json`, "Gate2702ArmRegistration"), anchor, `${treatmentId} registration`);
		assertProduction(registration, `${treatmentId} registration`);
		const worktreeSuffix = `worktrees/issue-${anchor.subject}.${treatmentId}.attempt-${selected.attempt}`;
		if (registration.treatmentId !== treatmentId || registration.attempt !== selected.attempt || registration.contentDigest !== selected.registrationDigest || typeof registration.runDir !== "string" || !absolutePathEndsWith(registration.runDir, prefix) || typeof registration.worktreePath !== "string" || !absolutePathEndsWith(registration.worktreePath, worktreeSuffix) || normalizedPath(registration.worktreePath) !== `${normalizedPath(trial.worktreeRoot).replace(/\/$/, "")}/${worktreeSuffix.slice(10)}`) fail$2(`${treatmentId} registration does not match pair selection`);
		if (selected.attempt === 1) {
			const embedded = Array.isArray(trial.registrations) ? trial.registrations.filter((candidate) => candidate?.subject === anchor.subject && candidate?.treatmentId === treatmentId && candidate?.attempt === 1) : [];
			if (embedded.length !== 1 || !sameValue$2(embedded[0], registration)) fail$2(`${treatmentId} registration is not bound into the trial`);
		} else {
			const firstPrefix = `runs/issue-${anchor.subject}/${treatmentId}/attempt-1`;
			const firstRegistration = assertAnchor(readReceipt$1(artifacts, `${firstPrefix}/registration.json`, "Gate2702ArmRegistration"), anchor, `${treatmentId} first registration`);
			const firstClassification = assertAnchor(readReceipt$1(artifacts, `${firstPrefix}/classification.json`, "Gate2702ArmClassification"), anchor, `${treatmentId} first classification`);
			assertProduction(firstRegistration, `${treatmentId} first registration`);
			if (firstClassification.registrationDigest !== firstRegistration.contentDigest || firstClassification.retry?.authorized !== true || !sameValue$2(registration.retryOf, {
				attempt: 1,
				registrationDigest: firstRegistration.contentDigest,
				classificationDigest: firstClassification.contentDigest
			})) fail$2(`${treatmentId} retry registration has no authorized lineage`);
		}
		const preflight = assertAnchor(readReceipt$1(artifacts, selected.attempt === 1 ? `preflight/issue-${anchor.subject}.json` : `${prefix}/preflight.json`, selected.attempt === 1 ? "Gate2702PairPreflight" : "Gate2702RetryPreflight"), anchor, `${treatmentId} preflight`);
		const preflightArm = selected.attempt === 1 ? preflight.arms?.[treatmentId] : preflight;
		if (preflight.status !== "passed" || preflightArm?.registrationDigest !== registration.contentDigest || preflightArm?.behaviorContext === null || typeof preflightArm?.behaviorContext !== "object") fail$2(`${treatmentId} preflight is not bound to behavior evidence`);
		const preDispatch = assertAnchor(readReceipt$1(artifacts, `${prefix}/pre-dispatch.json`, "Gate2702PreDispatch"), anchor, `${treatmentId} worker pre-dispatch`);
		assertProduction(preDispatch, `${treatmentId} worker pre-dispatch`);
		if (preDispatch.treatmentId !== treatmentId || preDispatch.attempt !== selected.attempt || preDispatch.registrationDigest !== registration.contentDigest || normalizedPath(preDispatch.cwd) !== normalizedPath(registration.worktreePath) || preDispatch.promptDigest !== sha256Bytes$1(Buffer.from(workerPrompt(snapshot, registration), "utf8")) || !sameValue$2(preDispatch.argv, expectedWorkerArgv())) fail$2(`${treatmentId} worker dispatch prompt or invocation is invalid`);
		const identity = assertAnchor(readReceipt$1(artifacts, `${prefix}/worktree-identity.json`, "Gate2702WorktreeIdentity"), anchor, `${treatmentId} worktree identity`);
		assertProduction(identity, `${treatmentId} worktree identity`);
		if (identity.treatmentId !== treatmentId || identity.attempt !== selected.attempt || identity.registrationDigest !== registration.contentDigest || normalizedPath(identity.worktreePath) !== normalizedPath(registration.worktreePath) || typeof identity.gitDirectory !== "string" || !isAbsolute(identity.gitDirectory) || !UUID_PATTERN$2.test(identity.identityToken ?? "") || !Number.isFinite(Date.parse(identity.createdAt ?? "")) || preDispatch.worktreeIdentityDigest !== identity.contentDigest) fail$2(`${treatmentId} worktree identity is not bound to its dispatch`);
		const processReceipt = assertAnchor(readReceipt$1(artifacts, `${prefix}/process.json`, "Gate2702Process"), anchor, `${treatmentId} worker process`);
		if (processReceipt.treatmentId !== treatmentId || processReceipt.attempt !== selected.attempt || processReceipt.registrationDigest !== registration.contentDigest || processReceipt.preDispatchDigest !== preDispatch.contentDigest || !Number.isSafeInteger(processReceipt.pid) || processReceipt.pid <= 1) fail$2(`${treatmentId} worker process is not bound to its dispatch`);
		const terminal = assertAnchor(readReceipt$1(artifacts, `${prefix}/terminal.json`, "Gate2702Terminal"), anchor, `${treatmentId} worker terminal`);
		if (terminal.treatmentId !== treatmentId || terminal.attempt !== selected.attempt || terminal.preDispatchDigest !== preDispatch.contentDigest || terminal.processDigest !== processReceipt.contentDigest || terminal.outcome !== "exited" || terminal.exitCode !== 0 || terminal.timedOut !== false || terminal.processGroupQuiescent !== true) fail$2(`${treatmentId} worker terminal is not a completed C5 arm`);
		const classification = assertAnchor(readReceipt$1(artifacts, `${prefix}/classification.json`, "Gate2702ArmClassification"), anchor, `${treatmentId} classification`);
		const statuses = Array.isArray(classification.checkResults) ? classification.checkResults.map((check) => check?.status) : [];
		const checkIds = Array.isArray(classification.checkResults) ? classification.checkResults.map((check) => check?.checkId) : [];
		if (classification.treatmentId !== treatmentId || classification.attempt !== selected.attempt || classification.registrationDigest !== registration.contentDigest || classification.preflightDigest !== preflight.contentDigest || classification.terminalDigest !== terminal.contentDigest || classification.contentDigest !== selected.classificationDigest || classification.status !== "succeeded" || classification.eligible !== true || classification.behaviorVerification?.behaviorContextDigest !== valueDigest$2(preflightArm.behaviorContext) || !Number.isFinite(Date.parse(classification.behaviorVerification?.verifiedAt ?? "")) || statuses.length !== CHECK_IDS$1.length || !sameValue$2([...checkIds].sort(), [...CHECK_IDS$1].sort()) || !statuses.every((status) => ["passed", "failed"].includes(status))) fail$2(`${treatmentId} classification is absent, ineligible, or tampered`);
		const stdoutPath = `${prefix}/stdout.log`;
		const stdoutBytes = retainedBytes(artifacts, stdoutPath);
		const recordedStdout = classification.workerArtifacts?.stdout;
		if (!absolutePathEndsWith(recordedStdout?.path, stdoutPath) || recordedStdout.byteLength !== stdoutBytes.length || recordedStdout.capturedBytes !== stdoutBytes.length || recordedStdout.truncated !== false || recordedStdout.contentDigest !== sha256Bytes$1(stdoutBytes)) fail$2(`${treatmentId} worker stdout is not bound to its classification`);
		let workerWrapper;
		try {
			workerWrapper = JSON.parse(stdoutBytes.toString("utf8"));
		} catch {
			fail$2(`${treatmentId} worker stdout is not valid Claude JSON`);
		}
		if (typeof workerWrapper?.result !== "string" || !workerWrapper.result.trim()) fail$2(`${treatmentId} worker stdout has no final result`);
		arms[treatmentId] = {
			selected,
			registration,
			classification,
			workerResult: workerWrapper.result
		};
	}
	return {
		trial,
		snapshot,
		selection,
		arms
	};
}
function validateFrozenInput(artifacts, anchor) {
	const source = validateFrozenSource(artifacts, anchor);
	const prefix = `judging/issue-${anchor.subject}`;
	const input = assertAnchor(readReceipt$1(artifacts, `${prefix}/input.json`, "Gate2702JudgeInput"), anchor, "frozen judge input");
	assertProduction(input, "frozen judge input");
	if (input.pairSelectionDigest !== source.selection.contentDigest || input.subjectSnapshotDigest !== source.snapshot.contentDigest || input.task !== `${source.snapshot.title}\n\n${source.snapshot.body}` || !exactTreatmentKeys(input.armEvidence) || !exactTreatmentKeys(input.objectiveChecks) || !exactTreatmentKeys(input.artifacts)) fail$2("frozen judge input does not rederive from the selected C5 pair");
	const frozenArms = {};
	for (const treatmentId of TREATMENTS$1) {
		const evidence = assertAnchor(readReceipt$1(artifacts, `${prefix}/evidence/${treatmentId}.json`, "Gate2702JudgeArmEvidence"), anchor, `${treatmentId} frozen judge evidence`);
		assertProduction(evidence, `${treatmentId} frozen judge evidence`);
		const arm = source.arms[treatmentId];
		const expectedWorktreeEvidence = worktreeEvidenceFromDiff(validateFrozenDiff$1(evidence.diff, treatmentId), anchor.baseSha);
		const workerBytes = Buffer.from(evidence.workerResult ?? "", "utf8");
		const objectiveState = arm.classification.checkResults.every((check) => check.status === "passed") ? "passed" : "failed";
		const objective = input.objectiveChecks[treatmentId];
		if (evidence.treatmentId !== treatmentId || evidence.attempt !== arm.registration.attempt || evidence.pairSelectionDigest !== source.selection.contentDigest || evidence.registrationDigest !== arm.registration.contentDigest || evidence.classificationDigest !== arm.classification.contentDigest || typeof evidence.workerResult !== "string" || !evidence.workerResult.trim() || evidence.workerResult !== arm.workerResult || evidence.workerResultDigest !== sha256Bytes$1(workerBytes) || !sameValue$2(evidence.worktreeEvidence, expectedWorktreeEvidence) || !sameValue$2(arm.classification.worktreeEvidence, expectedWorktreeEvidence) || evidence.artifact !== artifactText(evidence.workerResult, evidence.diff, arm.registration)) {
			if (typeof evidence.artifact === "string" && evidence.artifact !== artifactText(evidence.workerResult ?? "", evidence.diff, arm.registration)) fail$2(`${treatmentId} frozen artifact does not rederive`);
			fail$2(`${treatmentId} frozen judge evidence is invalid`);
		}
		if (input.armEvidence[treatmentId] !== evidence.contentDigest || input.artifacts[treatmentId] !== evidence.artifact || objective?.classificationDigest !== arm.classification.contentDigest || !sameValue$2(objective?.results, arm.classification.checkResults) || objective?.state !== objectiveState) fail$2(`${treatmentId} frozen judge evidence does not match its input`);
		frozenArms[treatmentId] = evidence;
	}
	return {
		source,
		input,
		frozenArms
	};
}
function expectedPayloads(input) {
	const forward = {
		task: input.task,
		rubric: RUBRIC,
		artifacts: {
			A: input.artifacts[TREATMENTS$1[0]],
			B: input.artifacts[TREATMENTS$1[1]]
		}
	};
	return {
		forward,
		swapped: {
			task: input.task,
			rubric: RUBRIC,
			artifacts: {
				A: forward.artifacts.B,
				B: forward.artifacts.A
			}
		}
	};
}
function validateRequests(artifacts, anchor, input) {
	const requests = assertAnchor(readReceipt$1(artifacts, `judging/issue-${anchor.subject}/requests.json`, "Gate2702JudgeRequests"), anchor, "frozen judge requests");
	assertProduction(requests, "frozen judge requests");
	const payloads = expectedPayloads(input);
	if (requests.judgeInputDigest !== input.contentDigest || requests.judgeModel !== JUDGE_MODEL$1 || requests.timeoutMs !== JUDGE_TIMEOUT_MS$1 || requests.maxBudgetUsd !== Number(JUDGE_BUDGET_USD$1) || requests.maxAttemptsPerOrder !== MAX_ATTEMPTS || requests.maxPayloadBytes !== MAX_PROMPT_BYTES || requests.maxStdoutBytes !== MAX_STREAM_BYTES || requests.maxStderrBytes !== MAX_STREAM_BYTES || requests.rubric !== RUBRIC || !sameValue$2(requests.schema, JUDGE_SCHEMA$1) || !sameValue$2(requests.requests?.forward?.payload, payloads.forward) || !sameValue$2(requests.requests?.swapped?.payload, payloads.swapped) || requests.requests?.forward?.payloadDigest !== valueDigest$2(payloads.forward) || requests.requests?.swapped?.payloadDigest !== valueDigest$2(payloads.swapped) || !sameValue$2(requests.requests?.forward?.order, {
		A: TREATMENTS$1[0],
		B: TREATMENTS$1[1]
	}) || !sameValue$2(requests.requests?.swapped?.order, {
		A: TREATMENTS$1[1],
		B: TREATMENTS$1[0]
	})) fail$2("frozen judge request or arm order differs from the C5 contract");
	for (const payload of Object.values(payloads)) if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PROMPT_BYTES) fail$2("frozen judge request exceeds the C5 payload bound");
	return requests;
}
function judgeArgv() {
	return [
		"-p",
		"--model",
		JUDGE_MODEL$1,
		"--json-schema",
		JSON.stringify(JUDGE_SCHEMA$1),
		"--output-format",
		"json",
		"--strict-mcp-config",
		"--tools",
		"",
		"--max-budget-usd",
		JUDGE_BUDGET_USD$1
	];
}
function validScores(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) && sameValue$2(Object.keys(value).sort(), DIMENSIONS.map(([key]) => key).sort()) && Object.values(value).every((score) => Number.isInteger(score) && score >= 1 && score <= 10);
}
function validResponse(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) && sameValue$2(Object.keys(value).sort(), [
		"rationale",
		"scores",
		"winner"
	]) && [
		"A",
		"B",
		"tie"
	].includes(value.winner) && typeof value.rationale === "string" && Boolean(value.rationale.trim()) && value.rationale.length <= 4096 && value.scores !== null && typeof value.scores === "object" && !Array.isArray(value.scores) && sameValue$2(Object.keys(value.scores).sort(), ["A", "B"]) && validScores(value.scores.A) && validScores(value.scores.B);
}
function normalizedPath(value) {
	return typeof value === "string" ? value.replaceAll("\\", "/") : "";
}
function absolutePathEndsWith(value, suffix) {
	const normalized = normalizedPath(value);
	return isAbsolute(value ?? "") && normalized.endsWith(`/${suffix}`);
}
function rootBeforeSuffix(value, suffix) {
	if (!absolutePathEndsWith(value, suffix)) return null;
	return normalizedPath(value).slice(0, -1 * `/${suffix}`.length);
}
function validatePreDispatch(preDispatch, anchor, requests, request, order, n) {
	if (!sameValue$2(preDispatch.definitionRef, DEFINITION_REF$1) || preDispatch.trialId !== anchor.trialId || preDispatch.subject !== anchor.subject || preDispatch.baseSha !== anchor.baseSha || preDispatch.executionMode !== "production" || preDispatch.requestSetDigest !== requests.contentDigest || preDispatch.payloadDigest !== request.payloadDigest || !sameValue$2(preDispatch.payload, request.payload) || preDispatch.order !== order || preDispatch.attempt !== n || preDispatch.executable !== "claude" || !sameValue$2(preDispatch.argv, judgeArgv()) || preDispatch.judgeModel !== JUDGE_MODEL$1 || preDispatch.sidekickEnabled !== false || preDispatch.toolAccess !== false || preDispatch.permissionBypass !== false || preDispatch.maxBudgetUsd !== Number(JUDGE_BUDGET_USD$1) || preDispatch.timeoutMs !== JUDGE_TIMEOUT_MS$1 || preDispatch.maxStdoutBytes !== MAX_STREAM_BYTES || preDispatch.maxStderrBytes !== MAX_STREAM_BYTES || !UUID_PATTERN$2.test(preDispatch.dispatchToken ?? "") || !Number.isFinite(Date.parse(preDispatch.createdAt ?? ""))) fail$2(`${order} pre-dispatch receipt is not the frozen production call`);
	return preDispatch;
}
function validateProcessReceipt(processReceipt, preDispatch, anchor, order, n) {
	const relativePrefix = `judging/issue-${anchor.subject}/${order}/attempt-${n}`;
	const expectedSuffixes = [
		`${relativePrefix}.pre-dispatch.json`,
		`${relativePrefix}.process.json`,
		`${relativePrefix}.gate.json`,
		`${relativePrefix}.outcome.json`
	];
	const argv = processReceipt.argv;
	const wrapperPathsValid = Array.isArray(argv) && argv.length === 6 && absolutePathEndsWith(argv[0], "scripts/gate-2702/judge.mjs") && argv[1] === "__dispatch" && expectedSuffixes.every((suffix, index) => absolutePathEndsWith(argv[index + 2], suffix)) && new Set(expectedSuffixes.map((suffix, index) => rootBeforeSuffix(argv[index + 2], suffix))).size === 1;
	if (!sameValue$2(processReceipt.definitionRef, DEFINITION_REF$1) || processReceipt.trialId !== preDispatch.trialId || processReceipt.subject !== preDispatch.subject || processReceipt.baseSha !== preDispatch.baseSha || processReceipt.executionMode !== "production" || processReceipt.requestSetDigest !== preDispatch.requestSetDigest || processReceipt.payloadDigest !== preDispatch.payloadDigest || processReceipt.order !== order || processReceipt.attempt !== n || processReceipt.dispatchToken !== preDispatch.dispatchToken || processReceipt.preDispatchDigest !== preDispatch.contentDigest || typeof processReceipt.executable !== "string" || !isAbsolute(processReceipt.executable) || !wrapperPathsValid || !Number.isSafeInteger(processReceipt.pid) || processReceipt.pid <= 0 || !(processReceipt.processStartTimeTicks === null || /^\d+$/.test(processReceipt.processStartTimeTicks ?? "")) || !Number.isFinite(Date.parse(processReceipt.launchedAt ?? ""))) fail$2(`${order} judge process receipt is invalid`);
	return processReceipt;
}
function validateGate(gate, preDispatch, processReceipt, order, n) {
	if (!sameValue$2(gate.definitionRef, DEFINITION_REF$1) || gate.trialId !== preDispatch.trialId || gate.subject !== preDispatch.subject || gate.baseSha !== preDispatch.baseSha || gate.executionMode !== "production" || gate.requestSetDigest !== preDispatch.requestSetDigest || gate.payloadDigest !== preDispatch.payloadDigest || gate.order !== order || gate.attempt !== n || gate.dispatchToken !== preDispatch.dispatchToken || gate.preDispatchDigest !== preDispatch.contentDigest || gate.processDigest !== processReceipt.contentDigest || !Number.isFinite(Date.parse(gate.authorizedAt ?? ""))) fail$2(`${order} judge gate is invalid`);
	return gate;
}
function capturedStreamBytes(stream, label) {
	if (stream === null) return null;
	if (stream?.encoding !== "base64" || !Number.isSafeInteger(stream.capturedBytes) || !Number.isSafeInteger(stream.totalBytes) || stream.capturedBytes < 0 || stream.totalBytes < stream.capturedBytes || stream.capturedBytes > MAX_STREAM_BYTES || !SHA256_PATTERN.test(stream.contentDigest ?? "") || typeof stream.truncated !== "boolean") fail$2(`${label} capture metadata is invalid`);
	const bytes = decodeBase64$1(stream.bytes, label);
	if (bytes.length !== stream.capturedBytes || stream.truncated !== stream.totalBytes > stream.capturedBytes || !stream.truncated && stream.contentDigest !== sha256Bytes$1(bytes)) fail$2(`${label} capture digest or bounds are invalid`);
	return bytes;
}
function validateOutcome(outcome, preDispatch, processReceipt, gate, order, n) {
	if (!sameValue$2(outcome.definitionRef, DEFINITION_REF$1) || outcome.trialId !== preDispatch.trialId || outcome.subject !== preDispatch.subject || outcome.baseSha !== preDispatch.baseSha || outcome.executionMode !== "production" || outcome.requestSetDigest !== preDispatch.requestSetDigest || outcome.payloadDigest !== preDispatch.payloadDigest || outcome.order !== order || outcome.attempt !== n || outcome.dispatchToken !== preDispatch.dispatchToken || outcome.preDispatchDigest !== preDispatch.contentDigest || outcome.processDigest !== (processReceipt?.contentDigest ?? null) || outcome.gateDigest !== (gate?.contentDigest ?? null) || !Number.isFinite(Date.parse(outcome.startedAt ?? "")) || !Number.isFinite(Date.parse(outcome.endedAt ?? "")) || !(outcome.startedMonotonicNs === null || /^\d+$/.test(outcome.startedMonotonicNs ?? "")) || !(outcome.endedMonotonicNs === null || /^\d+$/.test(outcome.endedMonotonicNs ?? "")) || !(outcome.durationMs === null || typeof outcome.durationMs === "number" && Number.isFinite(outcome.durationMs) && outcome.durationMs >= 0) || !(outcome.exitCode === null || Number.isSafeInteger(outcome.exitCode) && outcome.exitCode >= 0) || !(outcome.signal === null || typeof outcome.signal === "string" && outcome.signal.length > 0) || typeof outcome.timedOut !== "boolean" || !(outcome.spawnError === null || typeof outcome.spawnError === "string" && outcome.spawnError.length > 0)) fail$2(`${order} judge outcome is invalid`);
	const stdoutBytes = capturedStreamBytes(outcome.stdout, `${order} outcome stdout`);
	const stderrBytes = capturedStreamBytes(outcome.stderr, `${order} outcome stderr`);
	if (outcome.spawnError === null && stdoutBytes === null) fail$2(`${order} judge outcome has no stdout capture`);
	const wallDuration = Date.parse(outcome.endedAt) - Date.parse(outcome.startedAt);
	const monotonicPair = outcome.startedMonotonicNs !== null && outcome.endedMonotonicNs !== null;
	if (wallDuration < 0 || monotonicPair && BigInt(outcome.endedMonotonicNs) < BigInt(outcome.startedMonotonicNs) || monotonicPair && outcome.durationMs === null || !monotonicPair && (outcome.startedMonotonicNs !== null || outcome.endedMonotonicNs !== null || outcome.durationMs !== null)) fail$2(`${order} judge outcome timing is invalid`);
	return {
		outcome,
		stdoutBytes,
		stderrBytes
	};
}
function reportedCost(stdoutBytes) {
	try {
		const wrapper = JSON.parse(stdoutBytes.toString("utf8"));
		return typeof wrapper?.total_cost_usd === "number" ? wrapper.total_cost_usd : null;
	} catch {
		return null;
	}
}
function deriveAttempt(outcomeData) {
	const { outcome } = outcomeData;
	const stdout = outcomeData.stdoutBytes ?? Buffer.alloc(0);
	const stderr = outcomeData.stderrBytes ?? Buffer.alloc(0);
	if (outcome.spawnError) return {
		outcome: "failed",
		retryable: false,
		failureClass: "spawn-error",
		response: null,
		costUsd: null
	};
	if (outcome.stdout?.truncated || outcome.stderr?.truncated) return {
		outcome: "failed",
		retryable: false,
		failureClass: "output-truncated",
		response: null,
		costUsd: null
	};
	if (outcome.timedOut) return {
		outcome: "failed",
		retryable: true,
		failureClass: "timeout",
		response: null,
		costUsd: null
	};
	if (outcome.exitCode !== 0 || outcome.signal) {
		const combined = `${stdout.toString("utf8")}\n${stderr.toString("utf8")}`;
		return {
			outcome: "failed",
			retryable: false,
			failureClass: /budget|max[_ -]?budget/i.test(combined) ? "budget-exhausted" : "process-exit",
			response: null,
			costUsd: reportedCost(stdout)
		};
	}
	let wrapper;
	try {
		wrapper = JSON.parse(stdout.toString("utf8"));
	} catch {
		return {
			outcome: "failed",
			retryable: true,
			failureClass: "non-json",
			response: null,
			costUsd: null
		};
	}
	const costUsd = typeof wrapper?.total_cost_usd === "number" ? wrapper.total_cost_usd : null;
	if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0 || costUsd > Number(JUDGE_BUDGET_USD$1))) return {
		outcome: "failed",
		retryable: false,
		failureClass: costUsd > Number(JUDGE_BUDGET_USD$1) ? "budget-exhausted" : "schema-invalid",
		response: null,
		costUsd: Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null
	};
	let response = wrapper?.structured_output ?? wrapper?.structuredOutput;
	if (response === void 0 && typeof wrapper?.result === "string") try {
		response = JSON.parse(wrapper.result);
	} catch {
		return {
			outcome: "failed",
			retryable: true,
			failureClass: "non-json",
			response: null,
			costUsd
		};
	}
	return validResponse(response) ? {
		outcome: "valid",
		retryable: false,
		failureClass: null,
		response,
		costUsd
	} : {
		outcome: "failed",
		retryable: true,
		failureClass: "schema-invalid",
		response: null,
		costUsd
	};
}
function lifecyclePath(subject, order, attempt, suffix) {
	const prefix = `judging/issue-${subject}/${order}/attempt-${attempt}`;
	return suffix === "attempt" ? `${prefix}.json` : `${prefix}.${suffix}.json`;
}
function validateAttempt(artifacts, anchor, requests, order, attemptNumber) {
	const request = requests.requests[order];
	const preDispatch = validatePreDispatch(readReceipt$1(artifacts, lifecyclePath(anchor.subject, order, attemptNumber, "pre-dispatch"), "Gate2702JudgePreDispatch"), anchor, requests, request, order, attemptNumber);
	const processReceipt = readReceipt$1(artifacts, lifecyclePath(anchor.subject, order, attemptNumber, "process"), "Gate2702JudgeProcess", false);
	if (processReceipt) validateProcessReceipt(processReceipt, preDispatch, anchor, order, attemptNumber);
	const gate = readReceipt$1(artifacts, lifecyclePath(anchor.subject, order, attemptNumber, "gate"), "Gate2702JudgeGate", false);
	if (gate && !processReceipt) fail$2(`${order} judge gate has no process receipt`);
	if (gate) validateGate(gate, preDispatch, processReceipt, order, attemptNumber);
	const outcomeData = validateOutcome(readReceipt$1(artifacts, lifecyclePath(anchor.subject, order, attemptNumber, "outcome"), "Gate2702JudgeOutcome"), preDispatch, processReceipt, gate, order, attemptNumber);
	const derived = deriveAttempt(outcomeData);
	const attempt = readReceipt$1(artifacts, lifecyclePath(anchor.subject, order, attemptNumber, "attempt"), "Gate2702JudgeAttempt");
	const expectedArgv = [preDispatch.executable, ...preDispatch.argv];
	if (!sameValue$2(attempt.definitionRef, DEFINITION_REF$1) || attempt.trialId !== anchor.trialId || attempt.subject !== anchor.subject || attempt.baseSha !== anchor.baseSha || attempt.executionMode !== "production" || attempt.requestSetDigest !== requests.contentDigest || attempt.payloadDigest !== request.payloadDigest || attempt.order !== order || attempt.attempt !== attemptNumber || attempt.preDispatchDigest !== preDispatch.contentDigest || attempt.processDigest !== (processReceipt?.contentDigest ?? null) || attempt.outcomeDigest !== outcomeData.outcome.contentDigest || !sameValue$2(attempt.argv, expectedArgv) || attempt.judgeModel !== JUDGE_MODEL$1 || attempt.sidekickEnabled !== false || attempt.startedAt !== outcomeData.outcome.startedAt || attempt.endedAt !== outcomeData.outcome.endedAt || attempt.startedMonotonicNs !== outcomeData.outcome.startedMonotonicNs || attempt.endedMonotonicNs !== outcomeData.outcome.endedMonotonicNs || attempt.durationMs !== outcomeData.outcome.durationMs || attempt.exitCode !== outcomeData.outcome.exitCode || attempt.signal !== outcomeData.outcome.signal || attempt.timedOut !== outcomeData.outcome.timedOut || !sameValue$2(attempt.stdout, outcomeData.outcome.stdout) || !sameValue$2(attempt.stderr, outcomeData.outcome.stderr) || attempt.outcome !== derived.outcome || attempt.retryable !== derived.retryable || attempt.failureClass !== derived.failureClass || !sameValue$2(attempt.response, derived.response) || attempt.costUsd !== derived.costUsd || !(attempt.costUsd === null || typeof attempt.costUsd === "number" && Number.isFinite(attempt.costUsd) && attempt.costUsd >= 0)) fail$2(`${order} attempt ${attemptNumber} does not rederive`);
	return attempt;
}
function lifecycleExists(artifacts, subject, order, attempt) {
	return [
		"pre-dispatch",
		"process",
		"gate",
		"outcome",
		"attempt"
	].some((suffix) => artifacts.has(lifecyclePath(subject, order, attempt, suffix)));
}
function assertNoOverCapArtifacts(artifacts, subject, order) {
	const pattern = new RegExp(`^judging/issue-${subject}/${order}/attempt-(\\d+)(?:\\.(?:pre-dispatch|process|gate|outcome))?\\.json$`);
	for (const path of artifacts.keys()) {
		const match = pattern.exec(path);
		if (match && Number(match[1]) > MAX_ATTEMPTS) fail$2(`${order} judge call cap was exceeded by ${path}`);
	}
}
function validateAttemptSequence(artifacts, anchor, requests, result, order) {
	const manifest = result.attempts?.[order];
	if (!Array.isArray(manifest) || manifest.length < 1 || manifest.length > MAX_ATTEMPTS || manifest.some((entry, index) => !sameValue$2(Object.keys(entry ?? {}).sort(), ["attempt", "contentDigest"]) || entry.attempt !== index + 1 || !SHA256_PATTERN.test(entry.contentDigest ?? ""))) fail$2(`${order} judge result has an invalid attempt manifest`);
	assertNoOverCapArtifacts(artifacts, anchor.subject, order);
	const attempts = manifest.map((reference, index) => {
		const attempt = validateAttempt(artifacts, anchor, requests, order, index + 1);
		if (attempt.contentDigest !== reference.contentDigest) fail$2(`${order} judge result references a different attempt`);
		return attempt;
	});
	for (const attempt of attempts.slice(0, -1)) if (attempt.outcome !== "failed" || attempt.retryable !== true) fail$2(`${order} judge continued after a terminal attempt`);
	const terminal = attempts.at(-1);
	if (terminal.outcome !== "valid" && terminal.retryable === true && terminal.attempt < MAX_ATTEMPTS) fail$2(`${order} judge stopped before its fixed retry cap`);
	for (let future = attempts.length + 1; future <= MAX_ATTEMPTS; future += 1) if (lifecycleExists(artifacts, anchor.subject, order, future)) fail$2(`${order} judge result omits a later attempt`);
	return attempts;
}
function canonicalWinner(attempt, request) {
	if (attempt.outcome !== "valid") return null;
	if (attempt.response.winner === "tie") return "tie";
	return request.order[attempt.response.winner];
}
function resultBody(input, requests, attempts) {
	const forward = attempts.forward.at(-1);
	const swapped = attempts.swapped.at(-1);
	const bothValid = forward.outcome === "valid" && swapped.outcome === "valid";
	const forwardWinner = canonicalWinner(forward, requests.requests.forward);
	const swappedWinner = canonicalWinner(swapped, requests.requests.swapped);
	let state = "failed";
	let subjectiveWinner = null;
	if (bothValid && forwardWinner === swappedWinner) {
		state = forwardWinner === "tie" ? "tie" : "agreed";
		subjectiveWinner = forwardWinner;
	} else if (bothValid) state = "disagreement";
	const subjectiveState = state;
	const objective = Object.fromEntries(TREATMENTS$1.map((treatmentId) => [treatmentId, input.objectiveChecks[treatmentId].state]));
	const passed = TREATMENTS$1.filter((treatmentId) => objective[treatmentId] === "passed");
	let effectiveWinner = subjectiveWinner;
	let effectiveBasis = "blind-judge";
	if (passed.length === 1) {
		effectiveWinner = passed[0];
		effectiveBasis = "objective-checks";
	} else if (passed.length === 0) {
		state = "failed";
		effectiveWinner = null;
		effectiveBasis = "objective-both-failed";
	} else if (state === "failed" || state === "disagreement") {
		effectiveWinner = null;
		effectiveBasis = state === "failed" ? "judge-failed" : "judge-disagreement";
	}
	return {
		schemaVersion: SCHEMA_VERSION,
		kind: "Gate2702JudgeResult",
		definitionRef: DEFINITION_REF$1,
		trialId: input.trialId,
		subject: input.subject,
		baseSha: input.baseSha,
		executionMode: "production",
		judgeInputDigest: input.contentDigest,
		requestSetDigest: requests.contentDigest,
		attempts: {
			forward: attempts.forward.map((attempt) => ({
				attempt: attempt.attempt,
				contentDigest: attempt.contentDigest
			})),
			swapped: attempts.swapped.map((attempt) => ({
				attempt: attempt.attempt,
				contentDigest: attempt.contentDigest
			}))
		},
		state,
		subjectiveState,
		forwardWinner,
		swappedWinner,
		subjectiveWinner,
		objectiveChecks: input.objectiveChecks,
		effectiveWinner,
		effectiveBasis
	};
}
/**
* Validate and rederive all retained C5 judge evidence for one selected pair.
*
* @param {object} input
* @param {Map<string, Buffer|Uint8Array>} input.artifactBytesByPath exact bytes,
*   keyed by path relative to the trial root
* @param {string} input.trialId independently trusted trial UUID
* @param {number} input.subject independently trusted C5 subject issue number
* @param {string} input.baseSha independently trusted pinned Git SHA
* @returns {{input: object, requests: object, result: object,
*   attempts: {forward: object[], swapped: object[]}}}
*/
function validateGate2702JudgeEvidence({ artifactBytesByPath, trialId, subject, baseSha }) {
	const artifacts = requireArtifactMap(artifactBytesByPath);
	if (!UUID_PATTERN$2.test(trialId ?? "")) fail$2("trialId is not an RFC 4122 UUID");
	if (!Number.isSafeInteger(subject) || subject <= 0) fail$2("subject is not a valid issue number");
	if (!/^[0-9a-f]{40}$/.test(baseSha ?? "")) fail$2("baseSha is not a pinned Git SHA");
	const anchor = {
		trialId,
		subject,
		baseSha
	};
	const { input } = validateFrozenInput(artifacts, anchor);
	const requests = validateRequests(artifacts, anchor, input);
	const result = assertAnchor(readReceipt$1(artifacts, `judging/issue-${subject}/result.json`, "Gate2702JudgeResult"), anchor, "judge result");
	assertProduction(result, "judge result");
	const attempts = {
		forward: validateAttemptSequence(artifacts, anchor, requests, result, "forward"),
		swapped: validateAttemptSequence(artifacts, anchor, requests, result, "swapped")
	};
	const expected = resultBody(input, requests, attempts);
	const actual = { ...result };
	delete actual.contentDigest;
	if (!sameValue$2(actual, expected)) fail$2("judge result does not match its frozen evidence");
	return {
		input,
		requests,
		result,
		attempts
	};
}
var SCHEMA_VERSION, DEFINITION_REF$1, TREATMENTS$1, CHECK_IDS$1, JUDGE_MODEL$1, JUDGE_TIMEOUT_MS$1, JUDGE_BUDGET_USD$1, MAX_ATTEMPTS, MAX_PROMPT_BYTES, MAX_STREAM_BYTES, MAX_SOURCE_BYTES, MAX_UNTRACKED_FILES, SHA256_PATTERN, UUID_PATTERN$2, DIMENSIONS, JUDGE_SCHEMA$1, RUBRIC;
var init_seal_judge = __esmMin((() => {
	SCHEMA_VERSION = 1;
	DEFINITION_REF$1 = Object.freeze({
		definitionId: "experiments/gate-2702-c5",
		definitionVersion: 1,
		contentDigest: "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba"
	});
	TREATMENTS$1 = ["haiku-solo", "haiku-sonnet-sidekick"];
	CHECK_IDS$1 = ["checks/gate-2702-vitest", "checks/gate-2702-typecheck"];
	JUDGE_MODEL$1 = "claude-haiku-4-5-20251001";
	JUDGE_TIMEOUT_MS$1 = 6e5;
	JUDGE_BUDGET_USD$1 = "0.25";
	MAX_ATTEMPTS = 3;
	MAX_PROMPT_BYTES = 128 * 1024;
	MAX_STREAM_BYTES = 2 * 1024 * 1024;
	MAX_SOURCE_BYTES = 32 * 1024 * 1024;
	MAX_UNTRACKED_FILES = 4096;
	SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
	UUID_PATTERN$2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	DIMENSIONS = [
		["correctness", "Does it achieve the outcome the user would accept as the solution, rather than mere plausibility?"],
		["design", "Is it well architected under CUPID, KISS, DRY, and GRASP? Score neutral 5 for non-code tasks."],
		["completeness", "Does it cover the whole task, including edge cases the task implies?"],
		["clarity", "Is the result clear, well structured, and easy to act on?"],
		["scopeFit", "Does it stay in scope, without over-building or unrequested changes?"],
		["autonomy", "How few user prompts or interventions would it take to reach the result?"]
	];
	JUDGE_SCHEMA$1 = {
		type: "object",
		additionalProperties: false,
		required: [
			"winner",
			"scores",
			"rationale"
		],
		properties: {
			winner: {
				type: "string",
				enum: [
					"A",
					"B",
					"tie"
				]
			},
			scores: {
				type: "object",
				additionalProperties: false,
				required: ["A", "B"],
				properties: {
					A: { $ref: "#/$defs/dimensionScores" },
					B: { $ref: "#/$defs/dimensionScores" }
				}
			},
			rationale: {
				type: "string",
				minLength: 1,
				maxLength: 4096
			}
		},
		$defs: { dimensionScores: {
			type: "object",
			additionalProperties: false,
			required: DIMENSIONS.map(([key]) => key),
			properties: Object.fromEntries(DIMENSIONS.map(([key]) => [key, {
				type: "integer",
				minimum: 1,
				maximum: 10
			}]))
		} }
	};
	RUBRIC = [
		"You are an impartial judge comparing two attempts (A and B) at the same task.",
		"Skeptic first: for each attempt, identify what is missing or wrong before giving credit.",
		"Judge output quality, not length, apparent effort, model, or cost. Return tie only when equivalent.",
		`Score 1-10 on: ${DIMENSIONS.map(([key, description]) => `${key} (${description})`).join("; ")}`
	].join("\n");
}));
//#endregion
//#region scripts/gate-2702/seal.mjs
/**
* C5-only durable evidence sealer for #2702.
*
* `seal` validates live producer evidence, captures every retained byte plus a
* complete Git diff for every registered attempt, and publishes one atomic
* content-addressed bundle. `verify` reads only the published bundle, so it
* remains useful after the disposable worktrees have been removed.
*/
var seal_exports = /* @__PURE__ */ __exportAll({
	loadVerifiedTrial: () => loadVerifiedTrial,
	sealTrial: () => sealTrial,
	verifyTrial: () => verifyTrial
});
function fail$1(message) {
	throw new Error(message);
}
function canonicalValue$1(value) {
	if (Array.isArray(value)) return value.map(canonicalValue$1);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue$1(value[key])]));
}
function canonicalJson$1(value) {
	return JSON.stringify(canonicalValue$1(value));
}
function sameValue$1(left, right) {
	return canonicalJson$1(left) === canonicalJson$1(right);
}
function sha256Bytes(bytes) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function valueDigest$1(value) {
	return sha256Bytes(Buffer.from(canonicalJson$1(value), "utf8"));
}
function receiptDigest(receipt) {
	const undigested = { ...receipt };
	delete undigested.contentDigest;
	return valueDigest$1(undigested);
}
function withDigest(receipt) {
	const undigested = { ...receipt };
	delete undigested.contentDigest;
	return {
		...undigested,
		contentDigest: valueDigest$1(undigested)
	};
}
function assertPlainObject(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail$1(`${label} is not an object`);
	return value;
}
function verifyReceipt(receipt, expectedKind, label = expectedKind) {
	assertPlainObject(receipt, label);
	if (receipt.schemaVersion !== 1 || receipt.kind !== expectedKind) fail$1(`${label} has the wrong kind or schema version`);
	if (!DIGEST_PATTERN.test(receipt.contentDigest ?? "")) fail$1(`${label} has no valid content digest`);
	if (receipt.contentDigest !== receiptDigest(receipt)) fail$1(`${label} content digest does not match its fields`);
	return receipt;
}
function readRegularBytes(path, maximumBytes = MAX_RECEIPT_BYTES, label = path) {
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) fail$1(`${label} is not a regular file`);
	if (metadata.size > maximumBytes) fail$1(`${label} exceeds its fixed size limit`);
	const bytes = readFileSync(path);
	if (bytes.length !== metadata.size) fail$1(`${label} changed while it was read`);
	return bytes;
}
function readJson(path, maximumBytes = MAX_RECEIPT_BYTES, label = path) {
	try {
		return JSON.parse(readRegularBytes(path, maximumBytes, label).toString("utf8"));
	} catch (error) {
		fail$1(`${label} is not valid JSON: ${error.message}`);
	}
}
function readReceipt(path, kind, label = kind) {
	return verifyReceipt(readJson(path, MAX_RECEIPT_BYTES, label), kind, label);
}
function writeDurableFile(path, bytes, mode = 384) {
	mkdirSync(dirname(path), { recursive: true });
	const descriptor = openSync(path, "wx", mode);
	try {
		writeFileSync(descriptor, bytes);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
function fsyncDirectory$1(path) {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
function atomicWriteJson(path, value) {
	const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
	mkdirSync(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	writeDurableFile(temporary, bytes);
	try {
		linkSync(temporary, path);
		fsyncDirectory$1(dirname(path));
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		if (!readRegularBytes(path, MAX_RECEIPT_BYTES, path).equals(bytes)) fail$1("immutable verified seal marker already exists with different bytes");
	} finally {
		unlinkSync(temporary);
	}
}
function deterministicUuid$1(input) {
	const bytes = createHash("sha256").update(input).digest().subarray(0, 16);
	bytes[6] = bytes[6] & 15 | 80;
	bytes[8] = bytes[8] & 63 | 128;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function defaultStateRoot$1() {
	return resolve(process.env.CHD_EXPERIMENT_2702_STATE_ROOT || join(homedir(), ".claude", "shadow-calls", "gate-2702"));
}
function parseArgs$1(argv) {
	const [command, ...rest] = argv;
	if (!new Set(["seal", "verify"]).has(command)) fail$1("usage: seal.mjs <seal|verify> --trial <uuid> [--state-root <path>]");
	const options = { command };
	for (let index = 0; index < rest.length; index += 2) {
		const key = rest[index];
		const value = rest[index + 1];
		if (!key?.startsWith("--") || value === void 0) fail$1(`invalid argument near ${String(key)}`);
		const name = key.slice(2);
		if (!new Set(["trial", "state-root"]).has(name)) fail$1(`unknown option ${key}`);
		if (options[name] !== void 0) fail$1(`duplicate option ${key}`);
		options[name] = value;
	}
	if (!UUID_PATTERN$1.test(options.trial ?? "")) fail$1("--trial must be an RFC 4122 UUID");
	options.stateRoot = resolve(options["state-root"] || defaultStateRoot$1());
	return options;
}
function trialPaths(options) {
	const trialRoot = join(options.stateRoot, DEFINITION_DIGEST.replace(":", "-"), options.trial);
	const sealRoot = join(trialRoot, "seal");
	return {
		trialRoot,
		trial: join(trialRoot, "trial.json"),
		sealRoot,
		bundles: join(sealRoot, "bundles"),
		marker: join(sealRoot, "verified.json")
	};
}
function isWithin(root, candidate) {
	const rel = relative(resolve(root), resolve(candidate));
	return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}
function runDirectory(paths, subject, treatmentId, attempt) {
	return join(paths.trialRoot, "runs", `issue-${subject}`, treatmentId, `attempt-${attempt}`);
}
function registrationPath(paths, subject, treatmentId, attempt) {
	return join(runDirectory(paths, subject, treatmentId, attempt), "registration.json");
}
function retryRegistrationManifest(registrations) {
	return [...registrations].sort((left, right) => left.subject - right.subject || left.treatmentId.localeCompare(right.treatmentId)).map((registration) => ({
		subject: registration.subject,
		treatmentId: registration.treatmentId,
		attempt: registration.attempt,
		registrationDigest: registration.contentDigest,
		retryOf: registration.retryOf,
		worktreePath: registration.worktreePath
	}));
}
function assertArmIdentity(receipt, registration, label) {
	if (!sameValue$1(receipt.definitionRef, registration.definitionRef) || receipt.trialId !== registration.trialId || receipt.subject !== registration.subject || receipt.treatmentId !== registration.treatmentId || receipt.attempt !== registration.attempt || receipt.baseSha !== registration.baseSha) fail$1(`${label} identity does not match its registration`);
	return receipt;
}
function currentRetryState(paths, runtime, trial) {
	const registrations = [];
	for (const subject of runtime.plan.subjects) for (const treatment of runtime.plan.treatments) {
		const path = registrationPath(paths, subject, treatment.id, 2);
		if (!existsSync(path)) continue;
		const registration = readReceipt(path, "Gate2702ArmRegistration", "retry registration");
		const parent = trial.registrations.find((entry) => entry.subject === subject && entry.treatmentId === treatment.id);
		if (!parent) fail$1("retry registration has no attempt-1 parent");
		const parentClassification = readReceipt(join(parent.runDir, "classification.json"), "Gate2702ArmClassification", "retry-authorizing classification");
		const expectedRetryOf = {
			attempt: 1,
			registrationDigest: parent.contentDigest,
			classificationDigest: parentClassification.contentDigest
		};
		if (registration.executionMode !== "production" || registration.subject !== subject || registration.treatmentId !== treatment.id || registration.attempt !== 2 || registration.baseSha !== trial.baseSha || !sameValue$1(registration.definitionRef, DEFINITION_REF) || !sameValue$1(registration.retryOf, expectedRetryOf) || parentClassification.registrationDigest !== parent.contentDigest || parentClassification.retry?.authorized !== true) fail$1(`retry registration is not authorized for #${subject}/${treatment.id}`);
		registrations.push(registration);
	}
	const manifest = retryRegistrationManifest(registrations);
	const registrationSetDigest = valueDigest$1(manifest);
	let currentReceipt = null;
	const setRoot = join(paths.trialRoot, "retries", "sets");
	if (registrations.length > 0) {
		currentReceipt = readReceipt(join(setRoot, `${registrationSetDigest.replace(":", "-")}.json`), "Gate2702RetryRegistrationSet", "current retry registration set");
		if (!sameValue$1(currentReceipt.definitionRef, DEFINITION_REF) || currentReceipt.trialId !== trial.trialId || currentReceipt.baseSha !== trial.baseSha || currentReceipt.registrationSetDigest !== registrationSetDigest || !sameValue$1(currentReceipt.registrations, manifest)) fail$1("current retry registration set does not match the exact retry set");
	}
	if (existsSync(setRoot)) for (const name of readdirSync(setRoot)) {
		if (!/^sha256-[0-9a-f]{64}\.json$/.test(name)) fail$1(`unknown retry-set evidence: ${name}`);
		const receipt = readReceipt(join(setRoot, name), "Gate2702RetryRegistrationSet", `retry-set ${name}`);
		if (!sameValue$1(receipt.definitionRef, DEFINITION_REF) || receipt.trialId !== trial.trialId || receipt.baseSha !== trial.baseSha || name !== `${receipt.registrationSetDigest.replace(":", "-")}.json`) fail$1(`retry-set ${name} is not bound to this trial`);
	}
	return {
		registrations,
		manifest,
		registrationSetDigest,
		currentReceipt
	};
}
function assertExactRunDirectories(paths) {
	const runsRoot = join(paths.trialRoot, "runs");
	if (!sameValue$1(readdirSync(runsRoot).sort(), SUBJECTS.map((subject) => `issue-${subject}`).sort())) fail$1("run evidence contains an unknown or missing C5 subject directory");
	for (const subject of SUBJECTS) {
		const subjectRoot = join(runsRoot, `issue-${subject}`);
		if (!sameValue$1(readdirSync(subjectRoot).sort(), [...TREATMENTS].sort())) fail$1(`run evidence contains an unknown treatment for #${subject}`);
		for (const treatmentId of TREATMENTS) {
			const attempts = readdirSync(join(subjectRoot, treatmentId)).sort();
			if (!sameValue$1(attempts, ["attempt-1"]) && !sameValue$1(attempts, ["attempt-1", "attempt-2"])) fail$1(`run evidence contains an unknown attempt for #${subject}/${treatmentId}`);
		}
	}
}
function validateTrial(runtime, options, paths) {
	if (existsSync(join(paths.trialRoot, "lock"))) fail$1("trial lock still exists; sealing requires a quiescent terminal trial");
	const trial = readReceipt(paths.trial, "Gate2702Trial", "trial receipt");
	if (trial.trialId !== options.trial || !sameValue$1(trial.definitionRef, runtime.plan.definitionRef) || !sameValue$1(trial.definitionRef, DEFINITION_REF) || trial.repository !== REPOSITORY || trial.executionMode !== "production" || !/^[0-9a-f]{40}$/.test(trial.baseSha ?? "") || resolve(trial.stateRoot) !== resolve(options.stateRoot) || resolve(trial.worktreeRoot) !== resolve(join(paths.trialRoot, "worktrees")) || !Array.isArray(trial.registrations) || trial.registrations.length !== 12) fail$1("trial is not the exact production C5 launcher manifest");
	assertExactRunDirectories(paths);
	const registrations = [];
	for (const subject of runtime.plan.subjects) {
		for (const treatment of runtime.plan.treatments) {
			const embedded = trial.registrations.find((entry) => entry.subject === subject && entry.treatmentId === treatment.id);
			if (!embedded) fail$1(`trial omits #${subject}/${treatment.id}`);
			verifyReceipt(embedded, "Gate2702ArmRegistration", "embedded registration");
			const registration = readReceipt(registrationPath(paths, subject, treatment.id, 1), "Gate2702ArmRegistration", "attempt-1 registration");
			if (!sameValue$1(registration, embedded) || registration.attempt !== 1 || registration.executionMode !== "production" || registration.baseSha !== trial.baseSha || resolve(registration.runDir) !== resolve(runDirectory(paths, subject, treatment.id, 1)) || !isWithin(trial.worktreeRoot, registration.worktreePath)) fail$1(`attempt-1 registration drifted for #${subject}/${treatment.id}`);
			registrations.push(registration);
		}
		const snapshot = readReceipt(join(paths.trialRoot, "subjects", `issue-${subject}.json`), "Gate2702SubjectSnapshot", `subject snapshot #${subject}`);
		const manifest = trial.subjectSnapshots?.filter((entry) => entry.subject === subject) ?? [];
		if (manifest.length !== 1 || manifest[0].contentDigest !== snapshot.contentDigest || snapshot.executionMode !== "production" || snapshot.trialId !== trial.trialId || snapshot.subject !== subject || snapshot.baseSha !== trial.baseSha || !sameValue$1(snapshot.definitionRef, DEFINITION_REF)) fail$1(`subject snapshot #${subject} is not launcher-bound`);
	}
	const worktreeManifest = registrations.map((registration) => ({
		subject: registration.subject,
		treatmentId: registration.treatmentId,
		attempt: registration.attempt,
		worktreePath: registration.worktreePath,
		registrationDigest: registration.contentDigest
	}));
	if (trial.worktreeManifestDigest !== valueDigest$1(worktreeManifest)) fail$1("launcher worktree manifest digest does not match its 12 registrations");
	const retryState = currentRetryState(paths, runtime, trial);
	return {
		trial,
		registrations: [...registrations, ...retryState.registrations],
		retryState
	};
}
function producerArgs(script, command, options, registration) {
	const args = [
		script,
		command,
		"--trial",
		options.trial,
		"--subject",
		String(registration.subject),
		"--state-root",
		options.stateRoot
	];
	if (script !== JUDGE_PATH) args.push("--treatment", registration.treatmentId, "--attempt", String(registration.attempt));
	return args;
}
function runProducer(args, acceptedStatuses = new Set([0])) {
	const env = {
		...process.env,
		CHD_EXPERIMENT_2702: "1"
	};
	delete env.CHD_EXPERIMENT_2702_TEST_MODE;
	delete env.CHD_EXPERIMENT_2702_TEST_ARM_COMMAND_JSON;
	delete env.CHD_EXPERIMENT_2702_CLAUDE_BIN;
	const result = spawnSync(process.execPath, args, {
		cwd: PROJECT_ROOT,
		env,
		encoding: "utf8",
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		timeout: 6e4,
		maxBuffer: 16 * 1024 * 1024
	});
	if (result.error || !acceptedStatuses.has(result.status)) fail$1(`producer validation failed (${args.slice(0, 2).join(" ")}): ${result.error?.message || result.stderr || result.stdout}`);
	try {
		return JSON.parse(result.stdout);
	} catch {
		fail$1(`producer validation returned malformed JSON: ${args.slice(0, 2).join(" ")}`);
	}
}
function expectedJudgeArgv() {
	return [
		"-p",
		"--model",
		JUDGE_MODEL,
		"--json-schema",
		JSON.stringify(JUDGE_SCHEMA),
		"--output-format",
		"json",
		"--strict-mcp-config",
		"--tools",
		"",
		"--max-budget-usd",
		JUDGE_BUDGET_USD
	];
}
function assertFixedJudgePreDispatch(preDispatch, requests, request, order, attempt) {
	if (!sameValue$1(preDispatch.definitionRef, DEFINITION_REF) || preDispatch.trialId !== requests.trialId || preDispatch.subject !== requests.subject || preDispatch.baseSha !== requests.baseSha || preDispatch.requestSetDigest !== requests.contentDigest || preDispatch.payloadDigest !== request.payloadDigest || !sameValue$1(preDispatch.payload, request.payload) || preDispatch.order !== order || preDispatch.attempt !== attempt || preDispatch.executable !== "claude" || !sameValue$1(preDispatch.argv, expectedJudgeArgv()) || preDispatch.judgeModel !== JUDGE_MODEL || preDispatch.sidekickEnabled !== false || preDispatch.toolAccess !== false || preDispatch.permissionBypass !== false || preDispatch.maxBudgetUsd !== Number(JUDGE_BUDGET_USD) || preDispatch.timeoutMs !== JUDGE_TIMEOUT_MS || preDispatch.maxStdoutBytes !== JUDGE_MAX_STREAM_BYTES || preDispatch.maxStderrBytes !== JUDGE_MAX_STREAM_BYTES || !UUID_PATTERN$1.test(preDispatch.dispatchToken ?? "") || !Number.isFinite(Date.parse(preDispatch.createdAt ?? ""))) fail$1(`judge pre-dispatch #${requests.subject}/${order}/${attempt} is not the fixed production command`);
}
function validateJudgeDispatches(paths, subject, result) {
	const subjectRoot = join(paths.trialRoot, "judging", `issue-${subject}`);
	const requests = readReceipt(join(subjectRoot, "requests.json"), "Gate2702JudgeRequests", `judge requests #${subject}`);
	for (const order of ["forward", "swapped"]) {
		const attempts = result.attempts?.[order];
		if (!Array.isArray(attempts) || attempts.length < 1 || attempts.length > 3) fail$1(`judge result #${subject}/${order} has an invalid attempt set`);
		for (const [index, reference] of attempts.entries()) {
			const attempt = index + 1;
			const preDispatch = readReceipt(join(subjectRoot, order, `attempt-${attempt}.pre-dispatch.json`), "Gate2702JudgePreDispatch", `judge pre-dispatch #${subject}/${order}/${attempt}`);
			if (reference.attempt !== attempt) fail$1("judge attempts contain a gap");
			assertFixedJudgePreDispatch(preDispatch, requests, requests.requests?.[order], order, attempt);
		}
	}
}
function validateTerminalArm(runtime, paths, registration, validators, options) {
	const runDir = registration.runDir;
	const terminal = assertArmIdentity(readReceipt(join(runDir, "terminal.json"), "Gate2702Terminal", "terminal receipt"), registration, "terminal receipt");
	const classification = assertArmIdentity(readReceipt(join(runDir, "classification.json"), "Gate2702ArmClassification", "classification receipt"), registration, "classification receipt");
	if (classification.registrationDigest !== registration.contentDigest || classification.terminalDigest !== terminal.contentDigest || ![
		"succeeded",
		"failed",
		"cancelled"
	].includes(classification.status) || typeof classification.eligible !== "boolean") fail$1("classification is not bound to a terminal registered arm");
	const preDispatchPath = join(runDir, "pre-dispatch.json");
	let preDispatch = null;
	if (existsSync(preDispatchPath)) {
		preDispatch = assertArmIdentity(readReceipt(preDispatchPath, "Gate2702PreDispatch", "worker pre-dispatch"), registration, "worker pre-dispatch");
		const expectedArgv = [
			"claude",
			"-p",
			"--model",
			"claude-haiku-4-5-20251001",
			"--output-format",
			"json",
			"--dangerously-skip-permissions",
			"--strict-mcp-config",
			"--max-budget-usd",
			String(runtime.plan.costCaps.workerUsd)
		];
		if (preDispatch.executionMode !== "production" || registration.executionMode !== "production" || !sameValue$1(preDispatch.argv, expectedArgv) || preDispatch.registrationDigest !== registration.contentDigest) fail$1("sealing refuses test-mode or non-registered worker argv");
	} else if (terminal.outcome !== "preflight-failed") fail$1("terminal worker arm has no production pre-dispatch receipt");
	if (!sameValue$1(validators.classification(options, registration), classification)) fail$1("classification did not rederive from its terminal/check evidence");
	const accounting = assertArmIdentity(readReceipt(join(runDir, "accounting.json"), "Gate2702Accounting", "accounting receipt"), registration, "accounting receipt");
	if (accounting.registrationDigest !== registration.contentDigest || accounting.terminalDigest !== terminal.contentDigest || accounting.classificationDigest !== classification.contentDigest) fail$1("accounting is not bound to the exact terminal classification");
	if (!sameValue$1(validators.accounting(options, registration), accounting)) fail$1("accounting did not rederive from worker/Sidekick evidence");
	return {
		registration,
		terminal,
		classification,
		accounting,
		preDispatch
	};
}
function selectedAttempts(paths, trial, armEvidence) {
	const bySubject = /* @__PURE__ */ new Map();
	for (const subject of SUBJECTS) {
		const selectionPath = join(paths.trialRoot, "pair-selection", `issue-${subject}.json`);
		const arms = armEvidence.filter((entry) => entry.registration.subject === subject);
		const finalByTreatment = Object.fromEntries(TREATMENTS.map((treatmentId) => [treatmentId, arms.filter((entry) => entry.registration.treatmentId === treatmentId).sort((left, right) => right.registration.attempt - left.registration.attempt)[0]]));
		const selectable = TREATMENTS.every((treatmentId) => finalByTreatment[treatmentId]?.classification.status === "succeeded" && finalByTreatment[treatmentId]?.classification.eligible === true);
		if (!existsSync(selectionPath)) {
			if (selectable) fail$1(`eligible #${subject} pair has no deterministic selection receipt`);
			continue;
		}
		const selection = readReceipt(selectionPath, "Gate2702PairSelection", `pair selection #${subject}`);
		if (selection.trialId !== trial.trialId || selection.subject !== subject || selection.baseSha !== trial.baseSha || !sameValue$1(selection.definitionRef, DEFINITION_REF)) fail$1(`pair selection #${subject} has the wrong trial identity`);
		const selected = {};
		for (const treatmentId of TREATMENTS) {
			const pointer = selection.arms?.[treatmentId];
			const evidence = arms.find((entry) => entry.registration.treatmentId === treatmentId && entry.registration.attempt === pointer?.attempt);
			if (!evidence || pointer.treatmentId !== treatmentId || pointer.registrationDigest !== evidence.registration.contentDigest || pointer.classificationDigest !== evidence.classification.contentDigest || evidence.classification.status !== "succeeded" || evidence.classification.eligible !== true) fail$1(`pair selection #${subject} does not name an exact eligible ${treatmentId} arm`);
			selected[treatmentId] = evidence;
		}
		bySubject.set(subject, {
			selection,
			selected
		});
	}
	return bySubject;
}
function validateJudging(paths, options, selected, validators) {
	const judgeBySubject = /* @__PURE__ */ new Map();
	const judgingRoot = join(paths.trialRoot, "judging");
	for (const subject of SUBJECTS) {
		const pair = selected.get(subject);
		const subjectRoot = join(judgingRoot, `issue-${subject}`);
		if (!pair) {
			if (existsSync(subjectRoot)) fail$1(`unselected #${subject} has unknown judge evidence`);
			continue;
		}
		const resultPath = join(subjectRoot, "result.json");
		if (!existsSync(resultPath)) fail$1(`selected #${subject} pair has no terminal judge result`);
		const result = readReceipt(resultPath, "Gate2702JudgeResult", `judge result #${subject}`);
		validateJudgeDispatches(paths, subject, result);
		if (!sameValue$1(validators.judge(options, subject), result)) fail$1(`judge result #${subject} did not rederive from its frozen attempts`);
		judgeBySubject.set(subject, result);
	}
	return judgeBySubject;
}
function expectedEvidencePaths(paths, armEvidence, selected) {
	const expected = new Set(["trial.json"]);
	for (const subject of SUBJECTS) {
		expected.add(`subjects/issue-${subject}.json`);
		expected.add(`preflight/issue-${subject}.json`);
		if (selected.get(subject)) expected.add(`pair-selection/issue-${subject}.json`);
	}
	for (const evidence of armEvidence) {
		const { registration } = evidence;
		const prefix = relative(paths.trialRoot, registration.runDir);
		for (const name of [
			"registration.json",
			"worktree-identity.json",
			"preflight.json",
			"pre-dispatch.json",
			"process.json",
			"stdout.log",
			"stderr.log",
			"terminal.json",
			"classification.json",
			"accounting.json"
		]) if (existsSync(join(registration.runDir, name))) expected.add(join(prefix, name));
		for (const name of [
			"pre-dispatch.json",
			"process.json",
			"dispatch-gate",
			"outcome.json",
			"stdout.log",
			"stderr.log",
			"execution.json"
		]) if (existsSync(join(registration.runDir, "preflight-install", name))) expected.add(join(prefix, "preflight-install", name));
		for (const checkId of CHECK_IDS) {
			const slug = checkId.replaceAll("/", "_");
			for (const suffix of [
				".json",
				".pre-dispatch.json",
				".process.json",
				".dispatch-gate",
				".outcome.json",
				".stdout.log",
				".stderr.log"
			]) {
				const name = `${slug}${suffix}`;
				if (existsSync(join(registration.runDir, "checks", name))) expected.add(join(prefix, "checks", name));
			}
		}
	}
	const setRoot = join(paths.trialRoot, "retries", "sets");
	if (existsSync(setRoot)) for (const name of readdirSync(setRoot)) expected.add(join("retries", "sets", name));
	if (existsSync(join(paths.trialRoot, "judging"))) for (const subject of SUBJECTS) {
		if (!selected.has(subject)) continue;
		const prefix = join("judging", `issue-${subject}`);
		for (const name of [
			"input.json",
			"requests.json",
			"result.json",
			"evidence/haiku-solo.json",
			"evidence/haiku-sonnet-sidekick.json"
		]) if (existsSync(join(paths.trialRoot, prefix, name))) expected.add(join(prefix, name));
		for (const order of ["forward", "swapped"]) for (let attempt = 1; attempt <= 3; attempt += 1) for (const suffix of [
			".json",
			".pre-dispatch.json",
			".process.json",
			".gate.json",
			".outcome.json"
		]) {
			const name = `${order}/attempt-${attempt}${suffix}`;
			if (existsSync(join(paths.trialRoot, prefix, name))) expected.add(join(prefix, name));
		}
	}
	if (existsSync(join(paths.trialRoot, "supervisor.log"))) expected.add("supervisor.log");
	return expected;
}
function walkEvidenceFiles(root, current = root, result = []) {
	for (const name of readdirSync(current).sort()) {
		const path = join(current, name);
		const rel = relative(root, path);
		if (rel === "seal" || rel.startsWith(`seal${process.platform === "win32" ? "\\" : "/"}`)) continue;
		if (rel === "worktrees" || rel.startsWith(`worktrees${process.platform === "win32" ? "\\" : "/"}`)) continue;
		const metadata = lstatSync(path);
		if (metadata.isSymbolicLink()) fail$1(`trial evidence contains a symlink: ${rel}`);
		if (metadata.isDirectory()) walkEvidenceFiles(root, path, result);
		else if (metadata.isFile()) result.push(rel);
		else fail$1(`trial evidence contains a special file: ${rel}`);
	}
	return result;
}
function assertNoUnknownEvidence(paths, expected) {
	if (existsSync(join(paths.trialRoot, "cleanup.json"))) fail$1("a cleaned trial cannot be newly sealed from live workspaces");
	const actual = walkEvidenceFiles(paths.trialRoot);
	for (const path of actual) if (!expected.has(path)) fail$1(`unknown C5 evidence path: ${path}`);
	for (const path of expected) if (!actual.includes(path)) fail$1(`required C5 evidence path is missing: ${path}`);
	return actual.sort();
}
function runGit(worktree, args, encoding = null, maxBuffer = MAX_GIT_BYTES) {
	const result = spawnSync("git", [
		"-C",
		worktree,
		...args
	], {
		encoding,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		maxBuffer,
		timeout: 12e4
	});
	if (result.error || result.status !== 0) fail$1(`git ${args.join(" ")} failed while sealing ${worktree}`);
	return result.stdout;
}
function captureWorktreeDiff(registration, trialBounds) {
	const worktree = resolve(registration.worktreePath);
	const metadata = lstatSync(worktree);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail$1(`registered worktree is unavailable: ${worktree}`);
	const head = runGit(worktree, ["rev-parse", "HEAD"], "utf8").trim().toLowerCase();
	if (head !== registration.baseSha) {
		if (spawnSync("git", [
			"-C",
			worktree,
			"merge-base",
			"--is-ancestor",
			registration.baseSha,
			"HEAD"
		], {
			stdio: "ignore",
			timeout: 6e4
		}).status !== 0) fail$1("registered worktree no longer descends from its pinned base");
	}
	const patch = runGit(worktree, [
		"diff",
		"--binary",
		"--no-color",
		"--no-ext-diff",
		"--no-renames",
		registration.baseSha,
		"--"
	], null, MAX_WORKTREE_DIFF_RAW_BYTES);
	const untrackedNames = runGit(worktree, [
		"ls-files",
		"-z",
		"--others",
		"--exclude-standard"
	]).toString("utf8").split("\0").filter(Boolean).sort();
	if (untrackedNames.length + 1 > MAX_WORKTREE_DIFF_ARTIFACTS) fail$1("worktree diff exceeds the fixed artifact-count bound");
	const inventory = untrackedNames.map((path) => {
		const absolute = join(worktree, path);
		const entry = lstatSync(absolute);
		if (entry.isSymbolicLink()) return {
			path,
			absolute,
			entry,
			bytes: Buffer.from(readlinkSync(absolute), "utf8")
		};
		if (!entry.isFile()) fail$1(`unsupported untracked worktree entry: ${path}`);
		if (entry.size > MAX_OBJECT_BYTES) fail$1(`untracked evidence is too large: ${path}`);
		return {
			path,
			absolute,
			entry,
			bytes: null
		};
	});
	const rawBytes = patch.length + inventory.reduce((total, item) => total + (item.bytes?.length ?? item.entry.size), 0);
	const artifactCount = inventory.length + 1;
	if (rawBytes > MAX_WORKTREE_DIFF_RAW_BYTES) fail$1("worktree diff exceeds the fixed aggregate byte bound");
	if (trialBounds.rawBytes + rawBytes > MAX_TRIAL_DIFF_RAW_BYTES || trialBounds.artifactCount + artifactCount > MAX_TRIAL_DIFF_ARTIFACTS) fail$1("trial diffs exceed their fixed aggregate byte/count bounds");
	trialBounds.rawBytes += rawBytes;
	trialBounds.artifactCount += artifactCount;
	const untracked = inventory.map(({ path, absolute, entry, bytes }) => {
		if (entry.isSymbolicLink()) return {
			path,
			kind: "symlink",
			mode: entry.mode,
			sizeBytes: bytes.length,
			contentDigest: sha256Bytes(bytes),
			encoding: "utf8",
			bytes: bytes.toString("utf8")
		};
		const fileBytes = readFileSync(absolute);
		if (fileBytes.length !== entry.size) fail$1(`untracked evidence changed while sealing: ${path}`);
		return {
			path,
			kind: "file",
			mode: entry.mode,
			sizeBytes: fileBytes.length,
			contentDigest: sha256Bytes(fileBytes),
			encoding: "base64",
			bytes: fileBytes.toString("base64")
		};
	});
	return {
		schemaVersion: 1,
		kind: "Gate2702SealedWorktreeDiff",
		definitionRef: registration.definitionRef,
		trialId: registration.trialId,
		subject: registration.subject,
		treatmentId: registration.treatmentId,
		attempt: registration.attempt,
		baseSha: registration.baseSha,
		registrationDigest: registration.contentDigest,
		head,
		trackedPatch: {
			encoding: "base64",
			sizeBytes: patch.length,
			contentDigest: sha256Bytes(patch),
			bytes: patch.toString("base64")
		},
		untracked
	};
}
function artifactId(path) {
	return path.replace(/[^A-Za-z0-9._:/@-]/g, "-");
}
function objectEvidenceRef(entry, trialId) {
	return {
		kind: "artifact",
		artifactRef: {
			harness: "claude-code",
			sourceId: `gate-2702:${trialId}`,
			artifactId: artifactId(entry.sourcePath),
			contentDigest: entry.contentDigest,
			mediaType: entry.mediaType
		}
	};
}
function decodeBase64(value, label) {
	if (typeof value !== "string") fail$1(`${label} has no bytes`);
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value) fail$1(`${label} has malformed base64`);
	return bytes;
}
function validateFrozenDiff(diff, label) {
	const patch = decodeBase64(diff?.trackedPatch?.bytes, `${label} tracked patch`);
	if (diff.trackedPatch.encoding !== "base64" || diff.trackedPatch.sizeBytes !== patch.length || diff.trackedPatch.contentDigest !== sha256Bytes(patch) || !Array.isArray(diff.untracked)) fail$1(`${label} has invalid tracked diff evidence`);
	const paths = diff.untracked.map((entry) => entry.path);
	if (!sameValue$1(paths, [...paths].sort()) || new Set(paths).size !== paths.length) fail$1(`${label} untracked evidence is not uniquely sorted`);
	for (const entry of diff.untracked) {
		const bytes = entry.encoding === "base64" ? decodeBase64(entry.bytes, `${label} ${entry.path}`) : Buffer.from(entry.bytes ?? "", "utf8");
		if (!["file", "symlink"].includes(entry.kind) || entry.sizeBytes !== bytes.length || entry.contentDigest !== sha256Bytes(bytes)) fail$1(`${label} has invalid untracked evidence for ${entry.path}`);
	}
}
function judgeArtifactText(workerResultText, diff, registration) {
	return [
		workerResultText,
		"[FINAL TRACKED DIFF]",
		decodeBase64(diff.trackedPatch.bytes, "frozen judge tracked patch").toString("utf8"),
		diff.untracked.map((entry) => `[UNTRACKED ${entry.kind} ${entry.path}; ${entry.encoding}]\n${entry.bytes}`).join("\n\n")
	].filter(Boolean).join("\n\n").replaceAll(registration.worktreePath, "<worktree>").replaceAll(registration.runDir, "<run>").replaceAll(registration.treatmentId, "<arm>").replace(/claude-(?:haiku|sonnet|opus)-[a-z0-9-]+/gi, "<model>");
}
function validateFrozenJudgeArm(frozen, registration, classification, selectionDigest) {
	validateFrozenDiff(frozen.diff, "frozen judge worktree diff");
	if (!sameValue$1(frozen.definitionRef, DEFINITION_REF) || frozen.trialId !== registration.trialId || frozen.subject !== registration.subject || frozen.treatmentId !== registration.treatmentId || frozen.attempt !== registration.attempt || frozen.baseSha !== registration.baseSha || frozen.registrationDigest !== registration.contentDigest || frozen.classificationDigest !== classification.contentDigest || selectionDigest !== void 0 && frozen.pairSelectionDigest !== selectionDigest || typeof frozen.workerResult !== "string" || !frozen.workerResult.trim() || frozen.workerResultDigest !== sha256Bytes(Buffer.from(frozen.workerResult, "utf8")) || frozen.artifact !== judgeArtifactText(frozen.workerResult, frozen.diff, registration)) fail$1("frozen judge arm evidence does not rederive from retained sources");
	return frozen;
}
function timestampPlus(startedAt, durationMs) {
	const start = Date.parse(startedAt);
	if (!Number.isFinite(start)) fail$1("receipt contains an invalid timestamp");
	return new Date(start + Math.ceil(typeof durationMs === "number" && Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0)).toISOString();
}
function latestTimestamp(values) {
	const times = values.filter(Boolean).map((value) => Date.parse(value));
	if (times.some((value) => !Number.isFinite(value))) fail$1("evidence contains an invalid timestamp");
	return new Date(Math.max(...times)).toISOString();
}
function preflightFor(paths, registration) {
	if (registration.attempt === 1) {
		const receipt = readReceipt(join(paths.trialRoot, "preflight", `issue-${registration.subject}.json`), "Gate2702PairPreflight", "pair preflight");
		return {
			receipt,
			arm: receipt.arms?.[registration.treatmentId],
			behaviorContext: receipt.arms?.[registration.treatmentId]?.behaviorContext ?? null,
			environmentDigest: receipt.arms?.[registration.treatmentId]?.environmentDigest,
			environment: receipt.arms?.[registration.treatmentId]?.environment
		};
	}
	const receipt = readReceipt(join(registration.runDir, "preflight.json"), "Gate2702RetryPreflight", "retry preflight");
	return {
		receipt,
		arm: receipt,
		behaviorContext: receipt.behaviorContext ?? null,
		environmentDigest: receipt.environmentDigest,
		environment: receipt.environment
	};
}
function factor(id, value, displayValue) {
	return {
		id,
		valueDigest: DIGEST_PATTERN.test(value) ? value : valueDigest$1(value),
		...displayValue ? { displayValue } : {}
	};
}
function buildFingerprint(runtime, paths, evidence, startedAt, retainedPreflight = null) {
	const { registration, preDispatch } = evidence;
	const treatment = runtime.plan.treatments.find((entry) => entry.id === registration.treatmentId);
	const preflight = retainedPreflight ?? preflightFor(paths, registration);
	const context = preflight.behaviorContext;
	const enabled = treatment.configuration.sidekick.enabled;
	const workerModel = context?.workerModelQualifiedId ?? "claude-haiku-4-5-20251001";
	const sidekickModel = context?.sidekickModelQualifiedId ?? null;
	const runtimeVersion = preflight.environment?.claude?.version ?? "unavailable";
	const fingerprint = {
		schemaVersion: 1,
		policy: {
			id: "fingerprints/gate-2702-c5",
			version: 1
		},
		digest: `sha256:${"0".repeat(64)}`,
		observedAt: context?.observedAt ?? startedAt,
		completeness: context ? "complete" : "incomplete",
		runtime: {
			id: "experiment-runtime/gate-2702-c5",
			behaviorVersion: "1"
		},
		adapter: {
			id: "gate-2702-claude-code-adapter",
			behaviorVersion: "1",
			fingerprintSchemaVersion: 1
		},
		model: { qualifiedId: `anthropic/${workerModel}` },
		factors: [
			factor("runtime/claude-cli-version", runtimeVersion, String(runtimeVersion).slice(0, 128)),
			factor("model/worker-qualified-id", workerModel, workerModel),
			factor("runtime/worker-invocation-digest", preDispatch ? valueDigest$1({ argv: preDispatch.argv }) : valueDigest$1("not-dispatched")),
			factor("sidekick/enabled", {
				enabled,
				activation: context?.sidekickActivation ?? null
			}, enabled ? "enabled" : "disabled"),
			factor("sidekick/model-qualified-id", sidekickModel, sidekickModel ?? "disabled"),
			factor("sidekick/gate", treatment.configuration.sidekick.gate ?? "off", treatment.configuration.sidekick.gate ?? "off"),
			factor("sidekick/version", {
				version: context?.sidekickVersion ?? null,
				implementationDigest: context?.sidekickImplementationDigest ?? null
			}, context?.sidekickVersion ?? "disabled"),
			factor("sidekick/resolved-config-digest", context?.resolvedSidekickConfigDigest ?? valueDigest$1(treatment.configuration.sidekick)),
			factor("sidekick/instructions-digest", context?.instructionsDigest ?? valueDigest$1([])),
			factor("budget/worker-usd", runtime.plan.costCaps.workerUsd, String(runtime.plan.costCaps.workerUsd)),
			factor("budget/sidekick-session-usd", treatment.configuration.sidekick.sessionBudgetUsd, String(treatment.configuration.sidekick.sessionBudgetUsd)),
			factor("budget/sidekick-per-call-usd", treatment.configuration.sidekick.perCallBudgetUsd, String(treatment.configuration.sidekick.perCallBudgetUsd)),
			factor("checks/environment-digest", preflight.environmentDigest ?? valueDigest$1("unavailable")),
			factor("repository/base-sha", registration.baseSha, registration.baseSha.slice(0, 12))
		]
	};
	return runtime.contracts.withBehaviorFingerprintDigest(fingerprint);
}
function selectionBindingFor({ runtime, trialId, treatmentId, fingerprint, planSlots, receiptKind }) {
	const receiptId = deterministicUuid$1(`gate-2702-selection\0${trialId}\0${treatmentId}\0${receiptKind}`);
	const receiptDigest = valueDigest$1({
		definitionRef: runtime.plan.definitionRef,
		trialId,
		treatmentId,
		receiptKind,
		planSlots,
		behaviorFingerprintDigest: fingerprint.digest
	});
	if (receiptKind === "base") return runtime.definitionModule.createGate2702C5SelectionBinding({
		receiptId,
		receiptDigest,
		trialId,
		behaviorFingerprintDigest: fingerprint.digest,
		treatmentId
	});
	return Object.freeze({
		receiptId,
		receiptDigest,
		outcome: "selected",
		definitionRef: runtime.plan.definitionRef,
		trialId,
		selectedHarness: "claude-code",
		adapterBinding: {
			adapterId: "gate-2702-claude-code-adapter",
			behaviorFingerprintDigest: fingerprint.digest
		},
		planSlots
	});
}
function fingerprintWithoutObservation(fingerprint) {
	const comparable = { ...fingerprint };
	delete comparable.digest;
	delete comparable.observedAt;
	return comparable;
}
function buildSelectionGroups(runtime, paths, armEvidence) {
	const byRegistration = /* @__PURE__ */ new Map();
	const bindings = [];
	for (const treatmentId of TREATMENTS) for (const attempt of [1, 2]) {
		const members = armEvidence.filter((entry) => entry.registration.treatmentId === treatmentId && entry.registration.attempt === attempt);
		if (members.length === 0) continue;
		const complete = [];
		for (const evidence of members) {
			const fingerprint = buildFingerprint(runtime, paths, evidence, evidence.preDispatch?.startedAt ?? evidence.terminal.endedAt);
			if (fingerprint.completeness !== "complete") continue;
			complete.push({
				evidence,
				fingerprint
			});
		}
		if (complete.length === 0) continue;
		const first = complete[0].fingerprint;
		if (complete.some(({ fingerprint }) => !sameValue$1(fingerprintWithoutObservation(fingerprint), fingerprintWithoutObservation(first)))) fail$1(`C5 ${treatmentId} attempt-${attempt} behavior factors drifted across registered subjects`);
		const observedAt = complete.map(({ fingerprint }) => fingerprint.observedAt).sort()[0];
		const fingerprint = runtime.contracts.withBehaviorFingerprintDigest({
			...first,
			observedAt
		});
		const planSlots = attempt === 1 ? SUBJECTS.map((subject) => ({
			planSlotId: `issue-${subject}.${treatmentId}`,
			kind: "treatment-run",
			treatmentId
		})) : complete.map(({ evidence }) => ({
			planSlotId: `issue-${evidence.registration.subject}.${treatmentId}.retry-2`,
			kind: "treatment-run",
			treatmentId
		}));
		const binding = selectionBindingFor({
			runtime,
			trialId: complete[0].evidence.registration.trialId,
			treatmentId,
			fingerprint,
			planSlots,
			receiptKind: attempt === 1 ? "base" : "retry-2"
		});
		bindings.push(binding);
		for (const { evidence } of complete) byRegistration.set(evidence.registration.contentDigest, {
			fingerprint,
			binding,
			planSlotId: attempt === 1 ? `issue-${evidence.registration.subject}.${treatmentId}` : `issue-${evidence.registration.subject}.${treatmentId}.retry-2`
		});
	}
	return {
		byRegistration,
		bindings
	};
}
function workerResult(accounting, runDir) {
	try {
		return JSON.parse(readRegularBytes(join(runDir, "stdout.log"), MAX_OBJECT_BYTES).toString("utf8"));
	} catch {
		return null;
	}
}
function objectForPath(artifactByPath, path) {
	const entry = artifactByPath.get(path);
	if (!entry) fail$1(`sealed artifact was not indexed: ${path}`);
	return entry;
}
function evidenceForPath(artifactByPath, path, trialId) {
	return [objectEvidenceRef(objectForPath(artifactByPath, path), trialId)];
}
function buildCheckResults(paths, evidence, artifactByPath, startedAt) {
	const results = [];
	for (const summary of evidence.classification.checkResults ?? []) {
		const slug = summary.checkId.replaceAll("/", "_");
		const rel = join(relative(paths.trialRoot, evidence.registration.runDir), "checks", `${slug}.json`);
		const execution = readReceipt(join(paths.trialRoot, rel), "Gate2702CheckExecution", `check execution ${summary.checkId}`);
		const finishedAt = timestampPlus(execution.startedAt, execution.durationMs);
		if (Date.parse(execution.startedAt) < Date.parse(startedAt)) fail$1("declared check predates worker dispatch");
		results.push({
			checkId: summary.checkId,
			outcome: summary.status === "passed" ? "passed" : "failed",
			startedAt: execution.startedAt,
			finishedAt,
			evidenceRefs: evidenceForPath(artifactByPath, rel, evidence.registration.trialId)
		});
	}
	return results;
}
function metricObservation(definition, metricId, value, observedAt, evidenceRefs) {
	const metric = definition.metrics.find((entry) => entry.id === metricId);
	if (!metric) fail$1(`Definition omits ${metricId}`);
	return {
		metricId,
		value,
		unit: metric.unit,
		scope: metric.scope,
		basis: metric.basis,
		semanticsVersion: metric.semanticsVersion,
		confidence: "high",
		observedAt,
		evidenceRefs
	};
}
function candidateExclusion(evidence, judge, selectionInfo) {
	const { accounting, classification, terminal } = evidence;
	if (!selectionInfo) return "complete-behavior-fingerprint-unavailable";
	if (classification.error?.code === "behavior-context-drift") return "behavior-context-drift";
	const result = workerResult(accounting, evidence.registration.runDir);
	if (!UUID_PATTERN$1.test(result?.session_id ?? "")) return "worker-session-id-unknown";
	if (accounting.bridgeEvidenceStatus !== "eligible" || typeof accounting.allInCostUsd !== "number" || !Number.isFinite(accounting.allInCostUsd) || accounting.allInCostUsd < 0) return `unknown-all-in-cost:${(accounting.exclusionReasons ?? []).join(",") || "unspecified"}`;
	if (accounting.allInCostUsd > 18) return "all-in-cost-exceeds-definition-limit";
	if (classification.status === "succeeded") {
		if (!judge) return "selected-pair-judge-unavailable";
		if (judge.effectiveWinner === null && TREATMENTS.every((treatmentId) => judge.objectiveChecks?.[treatmentId]?.state === "passed")) return "judge-quality-not-evaluable";
		if (typeof terminal.durationMs !== "number" || !Number.isFinite(terminal.durationMs) || terminal.durationMs < 0) return "worker-wall-time-unknown";
		for (const field of [
			"sidekickTriggerCount",
			"sidekickPaidCallCount",
			"sidekickShippedInterventionCount"
		]) if (!Number.isSafeInteger(accounting[field]) || accounting[field] < 0) return `accounting-${field}-unknown`;
	}
	return null;
}
function buildRunCandidate(runtime, paths, evidence, judge, artifactByPath, priorByRegistration, selectionInfo) {
	const { registration, terminal, classification, accounting, preDispatch } = evidence;
	const identityRel = join(relative(paths.trialRoot, registration.runDir), "worktree-identity.json");
	const identity = readReceipt(join(paths.trialRoot, identityRel), "Gate2702WorktreeIdentity", "worktree identity");
	const startedAt = preDispatch?.startedAt ?? terminal.endedAt;
	let createdAt = preflightFor(paths, registration).behaviorContext?.observedAt ?? identity.createdAt ?? startedAt;
	const checkResults = buildCheckResults(paths, evidence, artifactByPath, startedAt);
	const finishedAt = latestTimestamp([
		terminal.endedAt,
		startedAt,
		...checkResults.map((entry) => entry.finishedAt)
	]);
	const parent = registration.attempt === 2 ? priorByRegistration.get(registration.retryOf?.registrationDigest) : null;
	if (registration.attempt === 2 && !parent) return { exclusion: "retry-parent-not-canonical" };
	if (parent && Date.parse(createdAt) <= Date.parse(parent.finishedAt)) {
		const adjusted = new Date(Date.parse(parent.finishedAt) + 1).toISOString();
		if (Date.parse(adjusted) > Date.parse(startedAt)) return { exclusion: "retry-timing-does-not-follow-parent" };
		createdAt = adjusted;
	}
	const exclusion = candidateExclusion(evidence, judge, selectionInfo);
	if (exclusion) return { exclusion };
	const runId = deterministicUuid$1(`gate-2702-run\0${registration.trialId}\0${registration.contentDigest}`);
	const { fingerprint, binding: selectionBinding, planSlotId } = selectionInfo;
	const snapshotEntry = objectForPath(artifactByPath, join("subjects", `issue-${registration.subject}.json`));
	const terminalRel = relative(paths.trialRoot, join(registration.runDir, "terminal.json"));
	const classificationRel = relative(paths.trialRoot, join(registration.runDir, "classification.json"));
	const accountingRel = relative(paths.trialRoot, join(registration.runDir, "accounting.json"));
	const terminalEvidence = evidenceForPath(artifactByPath, terminalRel, registration.trialId);
	const classificationEvidence = evidenceForPath(artifactByPath, classificationRel, registration.trialId);
	const accountingEvidence = evidenceForPath(artifactByPath, accountingRel, registration.trialId);
	const judgeRel = judge ? join("judging", `issue-${registration.subject}`, "result.json") : null;
	const judgeEvidence = judgeRel ? evidenceForPath(artifactByPath, judgeRel, registration.trialId) : [];
	const wallTimeMs = Math.min(runtime.plan.limits.wallTimeMs, Math.max(0, Math.ceil(terminal.durationMs ?? 0)));
	const observations = [];
	if (classification.status === "succeeded") {
		const qualityLoss = TREATMENTS.every((treatmentId) => judge.objectiveChecks?.[treatmentId]?.state === "failed") ? 1 : TREATMENTS.includes(judge.effectiveWinner) && judge.effectiveWinner !== registration.treatmentId ? 1 : 0;
		const attributableShips = registration.treatmentId === "haiku-sonnet-sidekick" && judge.effectiveWinner === "haiku-sonnet-sidekick" && accounting.sidekickShippedInterventionCount > 0 ? 1 : 0;
		observations.push(metricObservation(runtime.definition, "metrics/gate-2702-all-in-cost", accounting.allInCostUsd, finishedAt, accountingEvidence), metricObservation(runtime.definition, "metrics/gate-2702-wall-time", wallTimeMs, finishedAt, terminalEvidence), metricObservation(runtime.definition, "metrics/gate-2702-quality-loss", qualityLoss, finishedAt, judgeEvidence), metricObservation(runtime.definition, "metrics/gate-2702-sidekick-triggers", accounting.sidekickTriggerCount, finishedAt, accountingEvidence), metricObservation(runtime.definition, "metrics/gate-2702-sidekick-paid-calls", accounting.sidekickPaidCallCount, finishedAt, accountingEvidence), metricObservation(runtime.definition, "metrics/gate-2702-sidekick-shipped-interventions", accounting.sidekickShippedInterventionCount, finishedAt, accountingEvidence), metricObservation(runtime.definition, "metrics/gate-2702-attributable-ships", attributableShips, finishedAt, [...judgeEvidence, ...accountingEvidence]));
	}
	const sessionId = workerResult(accounting, registration.runDir).session_id;
	const run = {
		schemaVersion: 1,
		kind: "ExperimentRun",
		runId,
		trialId: registration.trialId,
		contentDigest: `sha256:${"0".repeat(64)}`,
		definitionRef: registration.definitionRef,
		treatmentId: registration.treatmentId,
		retryOf: parent ? {
			runId: parent.runId,
			contentDigest: parent.contentDigest
		} : null,
		status: classification.status,
		createdAt,
		startedAt,
		finishedAt,
		subjectRef: {
			harness: "claude-code",
			sourceId: `github:${REPOSITORY}`,
			artifactId: `github:${REPOSITORY}/issues/${registration.subject}`,
			contentDigest: snapshotEntry.contentDigest,
			mediaType: "application/json"
		},
		assignment: { kind: "explicit" },
		selectedHarness: "claude-code",
		harnessProvenance: {
			origin: "claude-code",
			driver: "claude-code",
			worker: "claude-code",
			judge: "claude-code"
		},
		selectionRef: {
			receiptId: selectionBinding.receiptId,
			receiptDigest: selectionBinding.receiptDigest,
			planSlotId
		},
		triggerRef: null,
		behaviorFingerprint: fingerprint,
		capabilitySnapshot: runtime.definition.requiredCapabilities.map((entry) => ({
			semanticsRef: entry.semanticsRef,
			state: "available",
			observedAt: fingerprint.observedAt
		})),
		effectiveLimits: { ...runtime.definition.limits },
		safeguardAuthorizations: [],
		sessionRef: {
			harness: "claude-code",
			sourceId: "local-gate-2702",
			sessionId
		},
		observations,
		checkResults,
		usage: {
			wallTimeMs,
			costUsd: accounting.allInCostUsd
		},
		error: classification.status === "succeeded" ? null : {
			code: `gate-2702/${String(classification.error?.code ?? classification.status).replace(/[^a-z0-9._-]/g, "-")}`,
			message: String(classification.error?.message ?? `C5 ${classification.status}`).slice(0, 4096),
			evidenceRefs: classificationEvidence
		},
		extensions: {
			"gate-2702/registrationDigest": registration.contentDigest,
			"gate-2702/classificationDigest": classification.contentDigest,
			"gate-2702/accountingDigest": accounting.contentDigest,
			"gate-2702/judgeResultDigest": judge?.contentDigest ?? null,
			"gate-2702/actualWallTimeMs": terminal.durationMs ?? null
		}
	};
	const digested = runtime.contracts.withDocumentDigest(run);
	const decoded = runtime.contracts.decodeRunV1(digested, {
		definition: runtime.definition,
		registry: runtime.registry,
		selectionReceipts: [selectionBinding],
		triggerReceipts: [],
		operatorSafeguardAuthorizations: [],
		priorRuns: [...priorByRegistration.values()]
	});
	if (!decoded.ok) fail$1(`canonical Run ${runId} failed strict v1 decoding: ${JSON.stringify(decoded.issues)}`);
	return {
		run: decoded.value,
		selectionBinding
	};
}
function addObject(objectMap, sourcePath, bytes, mediaType = "application/octet-stream") {
	const contentDigest = sha256Bytes(bytes);
	const existing = objectMap.objects.get(contentDigest);
	if (existing && !existing.equals(bytes)) fail$1(`SHA-256 collision while storing ${sourcePath}`);
	objectMap.objects.set(contentDigest, bytes);
	const entry = {
		sourcePath,
		contentDigest,
		sizeBytes: bytes.length,
		mediaType,
		objectName: contentDigest.replace(":", "-")
	};
	objectMap.artifacts.push(entry);
	objectMap.byPath.set(sourcePath, entry);
	return entry;
}
function collectExternalAccountingObjects(objectMap, armEvidence) {
	for (const evidence of armEvidence) {
		const source = evidence.accounting.sourceEvidence?.sidekick;
		if (source?.source !== "sidekick-session-ledger" || source.status !== "settled") continue;
		const sessionId = evidence.accounting.workerSessionId;
		if (!UUID_PATTERN$1.test(sessionId ?? "") || typeof source.relativePath !== "string") fail$1("settled Sidekick accounting lacks an exact session path");
		const root = resolve(process.env.HOME || homedir(), ".sidekick");
		const path = resolve(root, source.relativePath);
		if (!isWithin(root, path)) fail$1("Sidekick ledger path escapes its fixed root");
		const bytes = readRegularBytes(path, 4 * 1024 * 1024, "Sidekick ledger");
		if (bytes.length !== source.byteLength || sha256Bytes(bytes) !== source.contentDigest) fail$1("Sidekick ledger bytes no longer match accounting evidence");
		addObject(objectMap, `external/sidekick/${sessionId}/__sidekick.jsonl`, bytes, "application/x-ndjson");
	}
}
function maybeCrash(stage) {
	if (process.env.NODE_ENV === "test" && process.env.CHD_EXPERIMENT_2702_SEAL_TEST_CRASH_STAGE === stage) process.exit(86);
}
function sortedRunEvidence(armEvidence) {
	return [...armEvidence].sort((left, right) => left.registration.attempt - right.registration.attempt || left.registration.subject - right.registration.subject || left.registration.treatmentId.localeCompare(right.registration.treatmentId));
}
function parseArtifactJson(objectBytes, entry, expectedKind) {
	if (!entry) fail$1("sealed JSON artifact is missing");
	let value;
	try {
		value = JSON.parse(objectBytes.get(entry.contentDigest).toString("utf8"));
	} catch {
		fail$1(`sealed JSON artifact is malformed: ${entry.sourcePath}`);
	}
	return expectedKind ? verifyReceipt(value, expectedKind, entry.sourcePath) : value;
}
function verifySealedTrialSet(runtime, marker, manifest, objectBytes, byPath) {
	const trial = parseArtifactJson(objectBytes, byPath.get("trial.json"), "Gate2702Trial");
	const recordedPaths = typeof trial.stateRoot === "string" && isAbsolute(trial.stateRoot) ? trialPaths({
		stateRoot: trial.stateRoot,
		trial: trial.trialId
	}) : null;
	if (trial.contentDigest !== marker.trialDigest || trial.contentDigest !== manifest.trialDigest || trial.trialId !== marker.trialId || trial.baseSha !== marker.baseSha || !sameValue$1(trial.definitionRef, runtime.plan.definitionRef) || !sameValue$1(trial.definitionRef, DEFINITION_REF) || trial.repository !== REPOSITORY || trial.executionMode !== "production" || recordedPaths === null || typeof trial.worktreeRoot !== "string" || !isAbsolute(trial.worktreeRoot) || resolve(trial.worktreeRoot) !== resolve(join(recordedPaths.trialRoot, "worktrees")) || !Array.isArray(trial.registrations) || trial.registrations.length !== SUBJECTS.length * TREATMENTS.length || !Array.isArray(trial.subjectSnapshots) || trial.subjectSnapshots.length !== SUBJECTS.length) fail$1("sealed trial is not the exact production C5 launcher manifest");
	const baseRegistrations = [];
	for (const subject of SUBJECTS) {
		const snapshots = trial.subjectSnapshots.filter((entry) => entry.subject === subject);
		const snapshot = parseArtifactJson(objectBytes, byPath.get(`subjects/issue-${subject}.json`), "Gate2702SubjectSnapshot");
		if (snapshots.length !== 1 || snapshots[0].contentDigest !== snapshot.contentDigest || snapshot.executionMode !== "production" || snapshot.trialId !== trial.trialId || snapshot.subject !== subject || snapshot.baseSha !== trial.baseSha || !sameValue$1(snapshot.definitionRef, DEFINITION_REF)) fail$1(`sealed subject snapshot #${subject} is not launcher-bound`);
		const pairPreflight = parseArtifactJson(objectBytes, byPath.get(`preflight/issue-${subject}.json`), "Gate2702PairPreflight");
		if (pairPreflight.trialId !== trial.trialId || pairPreflight.subject !== subject || pairPreflight.baseSha !== trial.baseSha || !sameValue$1(pairPreflight.definitionRef, DEFINITION_REF)) fail$1(`sealed pair preflight #${subject} has the wrong trial identity`);
		for (const treatmentId of TREATMENTS) {
			const embedded = trial.registrations.filter((entry) => entry.subject === subject && entry.treatmentId === treatmentId);
			const prefix = `runs/issue-${subject}/${treatmentId}/attempt-1`;
			const registration = parseArtifactJson(objectBytes, byPath.get(`${prefix}/registration.json`), "Gate2702ArmRegistration");
			if (embedded.length !== 1 || !sameValue$1(registration, embedded[0]) || registration.attempt !== 1 || registration.executionMode !== "production" || registration.trialId !== trial.trialId || registration.baseSha !== trial.baseSha || typeof registration.runDir !== "string" || !isAbsolute(registration.runDir) || resolve(registration.runDir) !== resolve(runDirectory(recordedPaths, subject, treatmentId, 1)) || !isWithin(trial.worktreeRoot, registration.worktreePath)) fail$1(`sealed attempt-1 registration drifted for #${subject}/${treatmentId}`);
			const preflightArm = pairPreflight.arms?.[treatmentId];
			if (preflightArm?.treatmentId !== treatmentId || preflightArm?.attempt !== 1 || preflightArm?.registrationDigest !== registration.contentDigest || resolve(preflightArm?.worktreePath ?? "") !== resolve(registration.worktreePath)) fail$1(`sealed pair preflight is not bound to #${subject}/${treatmentId}`);
			baseRegistrations.push(registration);
		}
	}
	if (valueDigest$1(baseRegistrations.map((registration) => ({
		subject: registration.subject,
		treatmentId: registration.treatmentId,
		attempt: registration.attempt,
		worktreePath: registration.worktreePath,
		registrationDigest: registration.contentDigest
	}))) !== trial.worktreeManifestDigest || trial.worktreeManifestDigest !== marker.worktreeManifestDigest || trial.worktreeManifestDigest !== manifest.worktreeManifestDigest) fail$1("sealed worktree manifest does not rederive from its registrations");
	const retryRegistrations = manifest.runCandidates.filter((candidate) => candidate.attempt === 2).map((candidate) => {
		const registration = parseArtifactJson(objectBytes, byPath.get(`runs/issue-${candidate.subject}/${candidate.treatmentId}/attempt-2/registration.json`), "Gate2702ArmRegistration");
		if (typeof registration.runDir !== "string" || !isAbsolute(registration.runDir) || resolve(registration.runDir) !== resolve(runDirectory(recordedPaths, candidate.subject, candidate.treatmentId, 2)) || !isWithin(trial.worktreeRoot, registration.worktreePath)) fail$1(`sealed retry registration drifted for #${candidate.subject}/${candidate.treatmentId}`);
		return registration;
	});
	const retryPaths = [...byPath.keys()].filter((path) => path.startsWith("retries/sets/"));
	if (marker.retryRegistrationSetDigest === void 0) {
		if (manifest.retryRegistrationSetDigest !== null || retryRegistrations.length !== 0 || retryPaths.length !== 0) fail$1("sealed trial has an unbound retry registration set");
	} else {
		const retryManifest = retryRegistrationManifest(retryRegistrations);
		const registrationSetDigest = valueDigest$1(retryManifest);
		const expectedPath = `retries/sets/${registrationSetDigest.replace(":", "-")}.json`;
		const retrySet = parseArtifactJson(objectBytes, byPath.get(expectedPath), "Gate2702RetryRegistrationSet");
		if (retryPaths.length !== 1 || retryPaths[0] !== expectedPath || registrationSetDigest !== marker.retryRegistrationSetDigest || registrationSetDigest !== manifest.retryRegistrationSetDigest || retrySet.registrationSetDigest !== registrationSetDigest || retrySet.trialId !== trial.trialId || retrySet.baseSha !== trial.baseSha || !sameValue$1(retrySet.definitionRef, DEFINITION_REF) || !sameValue$1(retrySet.registrations, retryManifest)) fail$1("sealed retry registration set does not rederive exactly");
	}
	const expectedCandidates = [...baseRegistrations, ...retryRegistrations].map((registration) => ({
		subject: registration.subject,
		treatmentId: registration.treatmentId,
		attempt: registration.attempt,
		registrationDigest: registration.contentDigest
	})).sort((left, right) => left.attempt - right.attempt || left.subject - right.subject || left.treatmentId.localeCompare(right.treatmentId));
	if (!sameValue$1(manifest.runCandidates.map((candidate) => ({
		subject: candidate.subject,
		treatmentId: candidate.treatmentId,
		attempt: candidate.attempt,
		registrationDigest: candidate.registrationDigest
	})).sort((left, right) => left.attempt - right.attempt || left.subject - right.subject || left.treatmentId.localeCompare(right.treatmentId)), expectedCandidates)) fail$1("seal manifest does not cover the exact base and retry arm set");
	return trial;
}
function verifyArtifactCoverage(manifest, objectBytes, byPath) {
	const required = new Set([
		"trial.json",
		"generated/definition.json",
		"generated/registry.json"
	]);
	for (const subject of SUBJECTS) {
		required.add(`subjects/issue-${subject}.json`);
		required.add(`preflight/issue-${subject}.json`);
	}
	for (const candidate of manifest.runCandidates) {
		const prefix = `runs/issue-${candidate.subject}/${candidate.treatmentId}/attempt-${candidate.attempt}`;
		const installPrefix = `${prefix}/preflight-install`;
		for (const name of [
			"pre-dispatch.json",
			"stdout.log",
			"stderr.log",
			"execution.json"
		]) required.add(`${installPrefix}/${name}`);
		const installExecution = parseArtifactJson(objectBytes, byPath.get(`${installPrefix}/execution.json`), "Gate2702InstallExecution");
		if (installExecution.processDigest !== void 0) {
			required.add(`${installPrefix}/process.json`);
			required.add(`${installPrefix}/dispatch-gate`);
		}
		if (installExecution.interrupted === false && installExecution.error === void 0) required.add(`${installPrefix}/outcome.json`);
		for (const name of [
			"registration.json",
			"worktree-identity.json",
			"stdout.log",
			"stderr.log",
			"terminal.json",
			"classification.json",
			"accounting.json"
		]) required.add(`${prefix}/${name}`);
		required.add(`generated/diffs/issue-${candidate.subject}.${candidate.treatmentId}.attempt-${candidate.attempt}.json`);
		const terminal = parseArtifactJson(objectBytes, byPath.get(`${prefix}/terminal.json`), "Gate2702Terminal");
		if (terminal.outcome !== "preflight-failed") required.add(`${prefix}/pre-dispatch.json`);
		if (candidate.attempt === 2) required.add(`${prefix}/preflight.json`);
		if (["exited", "timed-out"].includes(terminal.outcome)) required.add(`${prefix}/process.json`);
		const classification = parseArtifactJson(objectBytes, byPath.get(`${prefix}/classification.json`), "Gate2702ArmClassification");
		for (const check of classification.checkResults ?? []) {
			const checkPrefix = `${prefix}/checks/${check.checkId.replaceAll("/", "_")}`;
			for (const suffix of [
				".json",
				".pre-dispatch.json",
				".stdout.log",
				".stderr.log"
			]) required.add(`${checkPrefix}${suffix}`);
			const execution = parseArtifactJson(objectBytes, byPath.get(`${checkPrefix}.json`), "Gate2702CheckExecution");
			if (execution.processDigest !== void 0) {
				required.add(`${checkPrefix}.process.json`);
				required.add(`${checkPrefix}.dispatch-gate`);
			}
			if (execution.timedOut === false && execution.spawnError === void 0 && execution.exitCode !== null) required.add(`${checkPrefix}.outcome.json`);
		}
		const accounting = parseArtifactJson(objectBytes, byPath.get(`${prefix}/accounting.json`), "Gate2702Accounting");
		if (accounting.sourceEvidence?.sidekick?.status === "settled") required.add(`external/sidekick/${accounting.workerSessionId}/__sidekick.jsonl`);
	}
	for (const run of manifest.canonicalRuns) required.add(run.sourcePath);
	for (const judge of manifest.judgeResults) {
		const prefix = `judging/issue-${judge.subject}`;
		required.add(`pair-selection/issue-${judge.subject}.json`);
		for (const name of [
			"input.json",
			"requests.json",
			"result.json",
			"evidence/haiku-solo.json",
			"evidence/haiku-sonnet-sidekick.json"
		]) required.add(`${prefix}/${name}`);
		const result = parseArtifactJson(objectBytes, byPath.get(`${prefix}/result.json`), "Gate2702JudgeResult");
		for (const order of ["forward", "swapped"]) for (const reference of result.attempts?.[order] ?? []) {
			const attemptPrefix = `${prefix}/${order}/attempt-${reference.attempt}`;
			required.add(`${attemptPrefix}.json`);
			required.add(`${attemptPrefix}.pre-dispatch.json`);
			required.add(`${attemptPrefix}.outcome.json`);
			for (const optional of [".process.json", ".gate.json"]) if (byPath.has(`${attemptPrefix}${optional}`)) required.add(`${attemptPrefix}${optional}`);
		}
	}
	for (const path of byPath.keys()) {
		const knownOperationalPath = path === "supervisor.log" || /^retries\/sets\/sha256-[0-9a-f]{64}\.json$/.test(path) || /^runs\/issue-[0-9]+\/(?:haiku-solo|haiku-sonnet-sidekick)\/attempt-[12]\/(?:preflight\.json|preflight-install\/(?:pre-dispatch\.json|process\.json|dispatch-gate|outcome\.json|stdout\.log|stderr\.log|execution\.json)|checks\/checks_gate-2702-(?:vitest|typecheck)(?:\.pre-dispatch\.json|\.process\.json|\.dispatch-gate|\.outcome\.json|\.stdout\.log|\.stderr\.log))$/.test(path);
		if (!required.has(path) && !knownOperationalPath) fail$1(`seal bundle contains unknown artifact path: ${path}`);
	}
	for (const path of required) if (!byPath.has(path)) fail$1(`seal bundle omits required artifact path: ${path}`);
}
function sealedPreflightFor(objectBytes, byPath, registration) {
	if (registration.attempt === 1) {
		const receipt = parseArtifactJson(objectBytes, byPath.get(`preflight/issue-${registration.subject}.json`), "Gate2702PairPreflight");
		return {
			receipt,
			arm: receipt.arms?.[registration.treatmentId],
			behaviorContext: receipt.arms?.[registration.treatmentId]?.behaviorContext ?? null,
			environmentDigest: receipt.arms?.[registration.treatmentId]?.environmentDigest,
			environment: receipt.arms?.[registration.treatmentId]?.environment
		};
	}
	const prefix = `runs/issue-${registration.subject}/${registration.treatmentId}/attempt-2`;
	const receipt = parseArtifactJson(objectBytes, byPath.get(`${prefix}/preflight.json`), "Gate2702RetryPreflight");
	return {
		receipt,
		arm: receipt,
		behaviorContext: receipt.behaviorContext ?? null,
		environmentDigest: receipt.environmentDigest,
		environment: receipt.environment
	};
}
function buildSealedSelectionGroups(runtime, manifest, objectBytes, byPath) {
	const evidence = manifest.runCandidates.map((candidate) => {
		const prefix = `runs/issue-${candidate.subject}/${candidate.treatmentId}/attempt-${candidate.attempt}`;
		return {
			registration: parseArtifactJson(objectBytes, byPath.get(`${prefix}/registration.json`), "Gate2702ArmRegistration"),
			terminal: parseArtifactJson(objectBytes, byPath.get(`${prefix}/terminal.json`), "Gate2702Terminal"),
			classification: parseArtifactJson(objectBytes, byPath.get(`${prefix}/classification.json`), "Gate2702ArmClassification"),
			accounting: parseArtifactJson(objectBytes, byPath.get(`${prefix}/accounting.json`), "Gate2702Accounting"),
			preDispatch: byPath.has(`${prefix}/pre-dispatch.json`) ? parseArtifactJson(objectBytes, byPath.get(`${prefix}/pre-dispatch.json`), "Gate2702PreDispatch") : null
		};
	});
	const byRegistration = /* @__PURE__ */ new Map();
	const bindings = [];
	for (const treatmentId of TREATMENTS) for (const attempt of [1, 2]) {
		const members = evidence.filter((entry) => entry.registration.treatmentId === treatmentId && entry.registration.attempt === attempt);
		if (members.length === 0) continue;
		const complete = [];
		for (const entry of members) {
			const fingerprint = buildFingerprint(runtime, null, entry, entry.preDispatch?.startedAt ?? entry.terminal.endedAt, sealedPreflightFor(objectBytes, byPath, entry.registration));
			if (fingerprint.completeness === "complete") complete.push({
				evidence: entry,
				fingerprint
			});
		}
		if (complete.length === 0) continue;
		const first = complete[0].fingerprint;
		if (complete.some(({ fingerprint }) => !sameValue$1(fingerprintWithoutObservation(fingerprint), fingerprintWithoutObservation(first)))) fail$1("sealed C5 behavior factors drift across registered subjects");
		const observedAt = complete.map(({ fingerprint }) => fingerprint.observedAt).sort()[0];
		const fingerprint = runtime.contracts.withBehaviorFingerprintDigest({
			...first,
			observedAt
		});
		const planSlots = attempt === 1 ? SUBJECTS.map((subject) => ({
			planSlotId: `issue-${subject}.${treatmentId}`,
			kind: "treatment-run",
			treatmentId
		})) : complete.map(({ evidence: entry }) => ({
			planSlotId: `issue-${entry.registration.subject}.${treatmentId}.retry-2`,
			kind: "treatment-run",
			treatmentId
		}));
		const binding = selectionBindingFor({
			runtime,
			trialId: complete[0].evidence.registration.trialId,
			treatmentId,
			fingerprint,
			planSlots,
			receiptKind: attempt === 1 ? "base" : "retry-2"
		});
		bindings.push(binding);
		for (const { evidence: entry } of complete) byRegistration.set(entry.registration.contentDigest, {
			fingerprint,
			binding,
			planSlotId: attempt === 1 ? `issue-${entry.registration.subject}.${treatmentId}` : `issue-${entry.registration.subject}.${treatmentId}.retry-2`
		});
	}
	if (!sameValue$1(manifest.selectionBindings, bindings)) fail$1("sealed selection bindings do not rederive from behavior evidence");
	return {
		byRegistration,
		evidence
	};
}
function sealedCandidateExclusion(evidence, judge, selectionInfo, workerBytes) {
	const { accounting, classification, terminal } = evidence;
	if (!selectionInfo) return "complete-behavior-fingerprint-unavailable";
	if (classification.error?.code === "behavior-context-drift") return "behavior-context-drift";
	let result = null;
	try {
		result = JSON.parse(workerBytes.toString("utf8"));
	} catch {}
	if (!UUID_PATTERN$1.test(result?.session_id ?? "")) return "worker-session-id-unknown";
	if (accounting.bridgeEvidenceStatus !== "eligible" || typeof accounting.allInCostUsd !== "number" || !Number.isFinite(accounting.allInCostUsd) || accounting.allInCostUsd < 0) return `unknown-all-in-cost:${(accounting.exclusionReasons ?? []).join(",") || "unspecified"}`;
	if (accounting.allInCostUsd > 18) return "all-in-cost-exceeds-definition-limit";
	if (classification.status === "succeeded") {
		if (!judge) return "selected-pair-judge-unavailable";
		if (judge.effectiveWinner === null && TREATMENTS.every((treatmentId) => judge.objectiveChecks?.[treatmentId]?.state === "passed")) return "judge-quality-not-evaluable";
		if (typeof terminal.durationMs !== "number" || !Number.isFinite(terminal.durationMs) || terminal.durationMs < 0) return "worker-wall-time-unknown";
		for (const field of [
			"sidekickTriggerCount",
			"sidekickPaidCallCount",
			"sidekickShippedInterventionCount"
		]) if (!Number.isSafeInteger(accounting[field]) || accounting[field] < 0) return `accounting-${field}-unknown`;
	}
	return null;
}
function verifySealedArmsAndLiveDiffs(runtime, manifest, objectBytes, byPath) {
	if (!Number.isSafeInteger(manifest.registrationCount) || manifest.registrationCount < 12 || !Array.isArray(manifest.runCandidates) || manifest.runCandidates.length !== manifest.registrationCount) fail$1("seal manifest does not cover its exact registration count");
	const identities = manifest.runCandidates.map((candidate) => `${candidate.subject}/${candidate.treatmentId}/${candidate.attempt}`);
	if (new Set(identities).size !== identities.length) fail$1("seal manifest repeats an arm registration");
	const selectionGroups = buildSealedSelectionGroups(runtime, manifest, objectBytes, byPath);
	const trialBounds = {
		rawBytes: 0,
		artifactCount: 0
	};
	const expectedCanonicalRegistrations = /* @__PURE__ */ new Set();
	for (const candidate of manifest.runCandidates) {
		const identity = `${candidate.subject}/${candidate.treatmentId}/${candidate.attempt}`;
		if (!SUBJECTS.includes(candidate.subject) || !TREATMENTS.includes(candidate.treatmentId) || ![1, 2].includes(candidate.attempt)) fail$1("seal manifest contains an unknown C5 arm");
		const prefix = `runs/issue-${candidate.subject}/${candidate.treatmentId}/attempt-${candidate.attempt}`;
		const registration = parseArtifactJson(objectBytes, byPath.get(`${prefix}/registration.json`), "Gate2702ArmRegistration");
		const terminal = parseArtifactJson(objectBytes, byPath.get(`${prefix}/terminal.json`), "Gate2702Terminal");
		const classification = parseArtifactJson(objectBytes, byPath.get(`${prefix}/classification.json`), "Gate2702ArmClassification");
		const accounting = parseArtifactJson(objectBytes, byPath.get(`${prefix}/accounting.json`), "Gate2702Accounting");
		assertArmIdentity(terminal, registration, "sealed terminal");
		assertArmIdentity(classification, registration, "sealed classification");
		assertArmIdentity(accounting, registration, "sealed accounting");
		if (registration.subject !== candidate.subject || registration.treatmentId !== candidate.treatmentId || registration.attempt !== candidate.attempt || registration.contentDigest !== candidate.registrationDigest || classification.registrationDigest !== registration.contentDigest || classification.terminalDigest !== terminal.contentDigest || classification.status !== candidate.status || classification.contentDigest !== candidate.classificationDigest || accounting.registrationDigest !== registration.contentDigest || accounting.terminalDigest !== terminal.contentDigest || accounting.classificationDigest !== classification.contentDigest || accounting.contentDigest !== candidate.accountingDigest) fail$1("sealed arm receipts do not retain their exact lineage");
		const identityReceipt = parseArtifactJson(objectBytes, byPath.get(`${prefix}/worktree-identity.json`), "Gate2702WorktreeIdentity");
		assertArmIdentity(identityReceipt, registration, "sealed worktree identity");
		if (identityReceipt.executionMode !== "production" || resolve(identityReceipt.worktreePath) !== resolve(registration.worktreePath)) fail$1("sealed worktree identity is not production registration-bound");
		if (terminal.outcome === "preflight-failed") {
			if (byPath.has(`${prefix}/pre-dispatch.json`) || byPath.has(`${prefix}/process.json`) || terminal.preDispatchDigest !== void 0 || terminal.processDigest !== void 0) fail$1("sealed preflight failure unexpectedly has worker dispatch evidence");
		} else {
			const preDispatch = parseArtifactJson(objectBytes, byPath.get(`${prefix}/pre-dispatch.json`), "Gate2702PreDispatch");
			assertArmIdentity(preDispatch, registration, "sealed worker pre-dispatch");
			if (preDispatch.executionMode !== "production" || preDispatch.registrationDigest !== registration.contentDigest || preDispatch.worktreeIdentityDigest !== identityReceipt.contentDigest || resolve(preDispatch.cwd) !== resolve(registration.worktreePath) || !sameValue$1(preDispatch.argv, [
				"claude",
				"-p",
				"--model",
				"claude-haiku-4-5-20251001",
				"--output-format",
				"json",
				"--dangerously-skip-permissions",
				"--strict-mcp-config",
				"--max-budget-usd",
				"15"
			]) || terminal.preDispatchDigest !== preDispatch.contentDigest) fail$1("sealed worker dispatch is not the fixed production invocation");
			if (["exited", "timed-out"].includes(terminal.outcome)) {
				const processReceipt = parseArtifactJson(objectBytes, byPath.get(`${prefix}/process.json`), "Gate2702Process");
				assertArmIdentity(processReceipt, registration, "sealed worker process");
				if (processReceipt.registrationDigest !== registration.contentDigest || processReceipt.preDispatchDigest !== preDispatch.contentDigest || !Number.isSafeInteger(processReceipt.pid) || processReceipt.pid <= 1 || terminal.processDigest !== processReceipt.contentDigest) fail$1("sealed terminal does not bind its exact worker process");
			} else if (terminal.outcome !== "spawn-error" || byPath.has(`${prefix}/process.json`) || terminal.processDigest !== void 0) fail$1("sealed worker terminal has an invalid process lineage");
		}
		if (candidate.attempt === 2) {
			const retrySet = parseArtifactJson(objectBytes, byPath.get(`retries/sets/${manifest.retryRegistrationSetDigest.replace(":", "-")}.json`), "Gate2702RetryRegistrationSet");
			const parent = manifest.runCandidates.find((entry) => entry.subject === candidate.subject && entry.treatmentId === candidate.treatmentId && entry.attempt === 1);
			if (!parent || registration.retryOf?.attempt !== 1 || registration.retryOf?.registrationDigest !== parent.registrationDigest || registration.retryOf?.classificationDigest !== parent.classificationDigest || !sameValue$1(accounting.retryOf, registration.retryOf) || accounting.retryRegistrationSetDigest !== manifest.retryRegistrationSetDigest || accounting.retryRegistrationSetReceiptDigest !== retrySet.contentDigest) fail$1("sealed retry arm does not retain its exact attempt-1 lineage");
		}
		for (const streamName of ["stdout", "stderr"]) {
			const streamEntry = byPath.get(`${prefix}/${streamName}.log`);
			const declared = classification.workerArtifacts?.[streamName];
			if (!streamEntry || declared?.contentDigest !== streamEntry.contentDigest || declared?.byteLength !== streamEntry.sizeBytes || declared?.capturedBytes !== Math.min(streamEntry.sizeBytes, 2 * 1024 * 1024) || declared?.truncated !== streamEntry.sizeBytes > 2 * 1024 * 1024) fail$1("sealed classification is not bound to its retained worker output");
		}
		const workerSource = accounting.sourceEvidence?.worker;
		const stdoutEntry = byPath.get(`${prefix}/stdout.log`);
		if (!stdoutEntry || workerSource?.contentDigest !== stdoutEntry.contentDigest || workerSource?.byteLength !== stdoutEntry.sizeBytes) fail$1("sealed accounting is not bound to its retained worker output");
		const numericCost = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && !Object.is(value, -0);
		if (accounting.allInCostUsd !== null) {
			if (!numericCost(accounting.workerCostUsd) || !numericCost(accounting.sidekickCostUsd) || !numericCost(accounting.allInCostUsd)) fail$1("sealed accounting all-in cost does not rederive");
			const expectedAllInCostUsd = candidate.treatmentId === "haiku-solo" ? accounting.workerCostUsd : normalizeGate2702Cost(accounting.workerCostUsd + accounting.sidekickCostUsd);
			if (accounting.allInCostUsd !== expectedAllInCostUsd) fail$1("sealed accounting all-in cost does not rederive");
		}
		if (accounting.bridgeEvidenceStatus === "eligible" && !numericCost(accounting.allInCostUsd)) fail$1("eligible sealed accounting has no finite all-in cost");
		const sidekickSource = accounting.sourceEvidence?.sidekick;
		let ledgerEntry = null;
		if (sidekickSource?.source === "sidekick-session-ledger") {
			if (sidekickSource.status === "settled") {
				ledgerEntry = byPath.get(`external/sidekick/${accounting.workerSessionId}/__sidekick.jsonl`);
				if (!ledgerEntry || ledgerEntry.contentDigest !== sidekickSource.contentDigest || ledgerEntry.sizeBytes !== sidekickSource.byteLength) fail$1("sealed accounting is not bound to its retained Sidekick ledger");
			}
		} else if (sidekickSource?.source !== "fixed-disabled-treatment" || sidekickSource.definitionDigest !== DEFINITION_DIGEST || accounting.sidekickCostUsd !== 0 || accounting.sidekickTriggerCount !== 0 || accounting.sidekickPaidCallCount !== 0 || accounting.sidekickShippedInterventionCount !== 0) fail$1("sealed control accounting does not rederive from the Definition");
		validateGate2702AccountingEvidence({
			accounting,
			workerStdoutBytes: objectBytes.get(stdoutEntry.contentDigest),
			sidekickLedgerBytes: ledgerEntry ? objectBytes.get(ledgerEntry.contentDigest) : null,
			sidekickEnabled: registration.treatmentId === "haiku-sonnet-sidekick",
			definitionDigest: DEFINITION_DIGEST,
			sidekickModel: SIDEKICK_MODEL
		});
		const judge = manifest.judgeResults.find((entry) => entry.subject === registration.subject) ? parseArtifactJson(objectBytes, byPath.get(`judging/issue-${registration.subject}/result.json`), "Gate2702JudgeResult") : null;
		const expectedExclusion = registration.attempt === 2 && !expectedCanonicalRegistrations.has(registration.retryOf?.registrationDigest) ? "retry-parent-not-canonical" : sealedCandidateExclusion({
			registration,
			terminal,
			classification,
			accounting
		}, judge, selectionGroups.byRegistration.get(registration.contentDigest), objectBytes.get(stdoutEntry.contentDigest));
		if ((candidate.exclusion ?? null) !== expectedExclusion) fail$1(`sealed run candidate disposition does not rederive from evidence: ${identity} expected ${String(expectedExclusion)} but found ${String(candidate.exclusion ?? null)}`);
		if (expectedExclusion === null) expectedCanonicalRegistrations.add(registration.contentDigest);
		const diffPath = `generated/diffs/issue-${candidate.subject}.${candidate.treatmentId}.attempt-${candidate.attempt}.json`;
		const diffEntry = byPath.get(diffPath);
		if (!diffEntry || diffEntry.contentDigest !== candidate.diffObjectDigest) fail$1("sealed arm points at the wrong worktree diff");
		const frozen = parseArtifactJson(objectBytes, diffEntry);
		validateFrozenDiff(frozen, `sealed diff ${identity}`);
		if (frozen.registrationDigest !== registration.contentDigest || frozen.trialId !== registration.trialId || frozen.subject !== registration.subject || frozen.treatmentId !== registration.treatmentId || frozen.attempt !== registration.attempt || frozen.baseSha !== registration.baseSha) fail$1("sealed worktree diff has the wrong arm identity");
		const worktreeEvidenceBody = {
			baseSha: registration.baseSha,
			trackedPatch: {
				sizeBytes: frozen.trackedPatch.sizeBytes,
				contentDigest: frozen.trackedPatch.contentDigest
			},
			untracked: frozen.untracked.map((entry) => ({
				path: entry.path,
				kind: entry.kind,
				mode: entry.mode,
				sizeBytes: entry.sizeBytes,
				contentDigest: entry.contentDigest,
				encoding: entry.encoding
			})),
			aggregateBytes: frozen.trackedPatch.sizeBytes + frozen.untracked.reduce((total, entry) => total + entry.sizeBytes, 0)
		};
		const expectedWorktreeEvidence = {
			...worktreeEvidenceBody,
			contentDigest: valueDigest$1(worktreeEvidenceBody)
		};
		if (classification.eligible === true && classification.worktreeEvidence === void 0 || classification.worktreeEvidence !== void 0 && !sameValue$1(classification.worktreeEvidence, expectedWorktreeEvidence)) fail$1("sealed classification worktree evidence does not rederive");
		if (existsSync(registration.worktreePath)) {
			if (!sameValue$1(captureWorktreeDiff(registration, trialBounds), frozen)) fail$1("registered worktree changed after evidence sealing");
		}
	}
	return selectionGroups;
}
function judgeStreamBytes(stream, label, required) {
	if (stream === null || stream === void 0) {
		if (required) fail$1(`${label} is missing`);
		return Buffer.alloc(0);
	}
	const bytes = decodeBase64(stream.bytes, label);
	if (stream.encoding !== "base64" || !Number.isSafeInteger(stream.capturedBytes) || !Number.isSafeInteger(stream.totalBytes) || stream.capturedBytes < 0 || stream.totalBytes < stream.capturedBytes || stream.capturedBytes !== bytes.length || stream.capturedBytes > JUDGE_MAX_STREAM_BYTES || stream.truncated !== stream.totalBytes > stream.capturedBytes || !DIGEST_PATTERN.test(stream.contentDigest ?? "") || !stream.truncated && stream.contentDigest !== sha256Bytes(bytes)) fail$1(`${label} has invalid retained bytes or bounds`);
	return bytes;
}
function deriveJudgeAttempt(outcome) {
	if (outcome.spawnError) return {
		outcome: "failed",
		retryable: false,
		failureClass: "spawn-error",
		response: null,
		costUsd: null
	};
	const stdout = judgeStreamBytes(outcome.stdout, "judge stdout", true);
	const stderr = judgeStreamBytes(outcome.stderr, "judge stderr", false);
	if (outcome.stdout?.truncated || outcome.stderr?.truncated) return {
		outcome: "failed",
		retryable: false,
		failureClass: "output-truncated",
		response: null,
		costUsd: null
	};
	if (outcome.timedOut) return {
		outcome: "failed",
		retryable: true,
		failureClass: "timeout",
		response: null,
		costUsd: null
	};
	if (outcome.exitCode !== 0 || outcome.signal) {
		const stdoutText = stdout.toString("utf8");
		const combined = `${stdoutText}\n${stderr.toString("utf8")}`;
		let costUsd = null;
		try {
			const wrapper = JSON.parse(stdoutText);
			costUsd = typeof wrapper.total_cost_usd === "number" ? wrapper.total_cost_usd : null;
		} catch {}
		return {
			outcome: "failed",
			retryable: false,
			failureClass: /budget|max[_ -]?budget/i.test(combined) ? "budget-exhausted" : "process-exit",
			response: null,
			costUsd
		};
	}
	let wrapper;
	try {
		wrapper = JSON.parse(stdout.toString("utf8"));
	} catch {
		return {
			outcome: "failed",
			retryable: true,
			failureClass: "non-json",
			response: null,
			costUsd: null
		};
	}
	const costUsd = typeof wrapper.total_cost_usd === "number" ? wrapper.total_cost_usd : null;
	if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0 || costUsd > Number(JUDGE_BUDGET_USD))) return {
		outcome: "failed",
		retryable: false,
		failureClass: costUsd > Number(JUDGE_BUDGET_USD) ? "budget-exhausted" : "schema-invalid",
		response: null,
		costUsd: Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null
	};
	let response = wrapper.structured_output ?? wrapper.structuredOutput;
	if (response === void 0 && typeof wrapper.result === "string") try {
		response = JSON.parse(wrapper.result);
	} catch {
		return {
			outcome: "failed",
			retryable: true,
			failureClass: "non-json",
			response: null,
			costUsd
		};
	}
	const dimensions = [
		"correctness",
		"design",
		"completeness",
		"clarity",
		"scopeFit",
		"autonomy"
	];
	const validScores = (scores) => scores && sameValue$1(Object.keys(scores).sort(), [...dimensions].sort()) && Object.values(scores).every((score) => Number.isInteger(score) && score >= 1 && score <= 10);
	return response && sameValue$1(Object.keys(response).sort(), [
		"rationale",
		"scores",
		"winner"
	]) && [
		"A",
		"B",
		"tie"
	].includes(response.winner) && typeof response.rationale === "string" && response.rationale.trim() && response.rationale.length <= 4096 && response.scores && sameValue$1(Object.keys(response.scores).sort(), ["A", "B"]) && validScores(response.scores.A) && validScores(response.scores.B) ? {
		outcome: "valid",
		retryable: false,
		failureClass: null,
		response,
		costUsd
	} : {
		outcome: "failed",
		retryable: true,
		failureClass: "schema-invalid",
		response: null,
		costUsd
	};
}
function rederiveSealedJudge(manifest, objectBytes, subject) {
	const byPath = new Map(manifest.artifacts.map((entry) => [entry.sourcePath, entry]));
	const prefix = `judging/issue-${subject}`;
	const input = parseArtifactJson(objectBytes, byPath.get(`${prefix}/input.json`), "Gate2702JudgeInput");
	const requests = parseArtifactJson(objectBytes, byPath.get(`${prefix}/requests.json`), "Gate2702JudgeRequests");
	const result = parseArtifactJson(objectBytes, byPath.get(`${prefix}/result.json`), "Gate2702JudgeResult");
	for (const treatmentId of TREATMENTS) {
		const frozen = parseArtifactJson(objectBytes, byPath.get(`${prefix}/evidence/${treatmentId}.json`), "Gate2702JudgeArmEvidence");
		const armPrefix = `runs/issue-${subject}/${treatmentId}/attempt-${frozen.attempt}`;
		const registration = parseArtifactJson(objectBytes, byPath.get(`${armPrefix}/registration.json`), "Gate2702ArmRegistration");
		const classification = parseArtifactJson(objectBytes, byPath.get(`${armPrefix}/classification.json`), "Gate2702ArmClassification");
		validateFrozenJudgeArm(frozen, registration, classification, input.pairSelectionDigest);
		const objective = input.objectiveChecks?.[treatmentId];
		const objectiveState = classification.checkResults?.every((check) => check.status === "passed") ? "passed" : "failed";
		if (input.armEvidence?.[treatmentId] !== frozen.contentDigest || input.artifacts?.[treatmentId] !== frozen.artifact || objective?.classificationDigest !== classification.contentDigest || !sameValue$1(objective?.results, classification.checkResults) || objective?.state !== objectiveState) fail$1("sealed judge input does not rederive from frozen arm evidence");
	}
	const terminalByOrder = {};
	for (const order of ["forward", "swapped"]) {
		const attemptRefs = result.attempts?.[order];
		if (!Array.isArray(attemptRefs) || attemptRefs.length < 1 || attemptRefs.length > 3) fail$1(`sealed judge ${subject}/${order} has an invalid attempt set`);
		terminalByOrder[order] = attemptRefs.map((reference, index) => {
			if (reference.attempt !== index + 1) fail$1("sealed judge attempts contain a gap");
			const attempt = parseArtifactJson(objectBytes, byPath.get(`${prefix}/${order}/attempt-${index + 1}.json`), "Gate2702JudgeAttempt");
			const outcome = parseArtifactJson(objectBytes, byPath.get(`${prefix}/${order}/attempt-${index + 1}.outcome.json`), "Gate2702JudgeOutcome");
			assertFixedJudgePreDispatch(parseArtifactJson(objectBytes, byPath.get(`${prefix}/${order}/attempt-${index + 1}.pre-dispatch.json`), "Gate2702JudgePreDispatch"), requests, requests.requests?.[order], order, index + 1);
			const derived = deriveJudgeAttempt(outcome);
			if (attempt.contentDigest !== reference.contentDigest || attempt.outcomeDigest !== outcome.contentDigest || attempt.outcome !== derived.outcome || attempt.retryable !== derived.retryable || attempt.failureClass !== derived.failureClass || !sameValue$1(attempt.response, derived.response) || attempt.costUsd !== derived.costUsd) fail$1(`sealed judge ${subject}/${order} attempt ${index + 1} does not rederive`);
			if (index < attemptRefs.length - 1 && !(attempt.outcome === "failed" && attempt.retryable)) fail$1("sealed judge continued after a terminal attempt");
			return attempt;
		}).at(-1);
	}
	const winner = (order) => {
		const attempt = terminalByOrder[order];
		if (attempt.outcome !== "valid") return null;
		if (attempt.response.winner === "tie") return "tie";
		return requests.requests[order].order[attempt.response.winner];
	};
	const forwardWinner = winner("forward");
	const swappedWinner = winner("swapped");
	let state = "failed";
	let subjectiveWinner = null;
	if (terminalByOrder.forward.outcome === "valid" && terminalByOrder.swapped.outcome === "valid" && forwardWinner === swappedWinner) {
		state = forwardWinner === "tie" ? "tie" : "agreed";
		subjectiveWinner = forwardWinner;
	} else if (terminalByOrder.forward.outcome === "valid" && terminalByOrder.swapped.outcome === "valid") state = "disagreement";
	const subjectiveState = state;
	const passed = TREATMENTS.filter((treatmentId) => input.objectiveChecks?.[treatmentId]?.state === "passed");
	let effectiveWinner = subjectiveWinner;
	let effectiveBasis = "blind-judge";
	if (passed.length === 1) {
		effectiveWinner = passed[0];
		effectiveBasis = "objective-checks";
	} else if (passed.length === 0) {
		state = "failed";
		effectiveWinner = null;
		effectiveBasis = "objective-both-failed";
	} else if (state === "failed" || state === "disagreement") {
		effectiveWinner = null;
		effectiveBasis = state === "failed" ? "judge-failed" : "judge-disagreement";
	}
	if (result.state !== state || result.subjectiveState !== subjectiveState || result.forwardWinner !== forwardWinner || result.swappedWinner !== swappedWinner || result.subjectiveWinner !== subjectiveWinner || result.effectiveWinner !== effectiveWinner || result.effectiveBasis !== effectiveBasis || result.judgeInputDigest !== input.contentDigest || result.requestSetDigest !== requests.contentDigest) fail$1(`sealed judge result #${subject} does not rederive from retained attempts`);
	return result;
}
function rebuildSealedCheckResults(objectBytes, byPath, registration, classification, startedAt) {
	const prefix = `runs/issue-${registration.subject}/${registration.treatmentId}/attempt-${registration.attempt}`;
	return (classification.checkResults ?? []).map((summary) => {
		const path = `${prefix}/checks/${summary.checkId.replaceAll("/", "_")}.json`;
		const execution = parseArtifactJson(objectBytes, byPath.get(path), "Gate2702CheckExecution");
		if (Date.parse(execution.startedAt) < Date.parse(startedAt)) fail$1("sealed check predates worker dispatch");
		return {
			checkId: summary.checkId,
			outcome: summary.status === "passed" ? "passed" : "failed",
			startedAt: execution.startedAt,
			finishedAt: timestampPlus(execution.startedAt, execution.durationMs),
			evidenceRefs: evidenceForPath(byPath, path, registration.trialId)
		};
	});
}
function rebuildSealedCanonicalRun({ runtime, objectBytes, byPath, registration, terminal, classification, accounting, judge, selectionInfo, parent, priorRuns }) {
	const prefix = `runs/issue-${registration.subject}/${registration.treatmentId}/attempt-${registration.attempt}`;
	const preDispatch = byPath.has(`${prefix}/pre-dispatch.json`) ? parseArtifactJson(objectBytes, byPath.get(`${prefix}/pre-dispatch.json`), "Gate2702PreDispatch") : null;
	const identity = parseArtifactJson(objectBytes, byPath.get(`${prefix}/worktree-identity.json`), "Gate2702WorktreeIdentity");
	const preflight = sealedPreflightFor(objectBytes, byPath, registration);
	const startedAt = preDispatch?.startedAt ?? terminal.endedAt;
	let createdAt = preflight.behaviorContext?.observedAt ?? identity.createdAt ?? startedAt;
	const checkResults = rebuildSealedCheckResults(objectBytes, byPath, registration, classification, startedAt);
	const finishedAt = latestTimestamp([
		terminal.endedAt,
		startedAt,
		...checkResults.map((entry) => entry.finishedAt)
	]);
	if (parent && Date.parse(createdAt) <= Date.parse(parent.finishedAt)) {
		const adjusted = new Date(Date.parse(parent.finishedAt) + 1).toISOString();
		if (Date.parse(adjusted) > Date.parse(startedAt)) fail$1("canonical retry Run timing does not follow its parent");
		createdAt = adjusted;
	}
	const runId = deterministicUuid$1(`gate-2702-run\0${registration.trialId}\0${registration.contentDigest}`);
	const { fingerprint, binding: selectionBinding, planSlotId } = selectionInfo;
	const snapshotPath = `subjects/issue-${registration.subject}.json`;
	const terminalPath = `${prefix}/terminal.json`;
	const classificationPath = `${prefix}/classification.json`;
	const accountingPath = `${prefix}/accounting.json`;
	const terminalEvidence = evidenceForPath(byPath, terminalPath, registration.trialId);
	const classificationEvidence = evidenceForPath(byPath, classificationPath, registration.trialId);
	const accountingEvidence = evidenceForPath(byPath, accountingPath, registration.trialId);
	const judgePath = judge ? `judging/issue-${registration.subject}/result.json` : null;
	const judgeEvidence = judgePath ? evidenceForPath(byPath, judgePath, registration.trialId) : [];
	const wallTimeMs = Math.min(runtime.plan.limits.wallTimeMs, Math.max(0, Math.ceil(terminal.durationMs ?? 0)));
	const observations = [];
	if (classification.status === "succeeded") {
		const qualityLoss = TREATMENTS.every((treatmentId) => judge.objectiveChecks?.[treatmentId]?.state === "failed") ? 1 : TREATMENTS.includes(judge.effectiveWinner) && judge.effectiveWinner !== registration.treatmentId ? 1 : 0;
		const attributableShips = registration.treatmentId === "haiku-sonnet-sidekick" && judge.effectiveWinner === "haiku-sonnet-sidekick" && accounting.sidekickShippedInterventionCount > 0 ? 1 : 0;
		observations.push(metricObservation(runtime.definition, "metrics/gate-2702-all-in-cost", accounting.allInCostUsd, finishedAt, accountingEvidence), metricObservation(runtime.definition, "metrics/gate-2702-wall-time", wallTimeMs, finishedAt, terminalEvidence), metricObservation(runtime.definition, "metrics/gate-2702-quality-loss", qualityLoss, finishedAt, judgeEvidence), metricObservation(runtime.definition, "metrics/gate-2702-sidekick-triggers", accounting.sidekickTriggerCount, finishedAt, accountingEvidence), metricObservation(runtime.definition, "metrics/gate-2702-sidekick-paid-calls", accounting.sidekickPaidCallCount, finishedAt, accountingEvidence), metricObservation(runtime.definition, "metrics/gate-2702-sidekick-shipped-interventions", accounting.sidekickShippedInterventionCount, finishedAt, accountingEvidence), metricObservation(runtime.definition, "metrics/gate-2702-attributable-ships", attributableShips, finishedAt, [...judgeEvidence, ...accountingEvidence]));
	}
	let worker;
	try {
		worker = JSON.parse(objectBytes.get(byPath.get(`${prefix}/stdout.log`).contentDigest));
	} catch {
		fail$1("canonical Run worker result is not retained JSON");
	}
	const run = runtime.contracts.withDocumentDigest({
		schemaVersion: 1,
		kind: "ExperimentRun",
		runId,
		trialId: registration.trialId,
		contentDigest: `sha256:${"0".repeat(64)}`,
		definitionRef: registration.definitionRef,
		treatmentId: registration.treatmentId,
		retryOf: parent ? {
			runId: parent.runId,
			contentDigest: parent.contentDigest
		} : null,
		status: classification.status,
		createdAt,
		startedAt,
		finishedAt,
		subjectRef: {
			harness: "claude-code",
			sourceId: `github:${REPOSITORY}`,
			artifactId: `github:${REPOSITORY}/issues/${registration.subject}`,
			contentDigest: objectForPath(byPath, snapshotPath).contentDigest,
			mediaType: "application/json"
		},
		assignment: { kind: "explicit" },
		selectedHarness: "claude-code",
		harnessProvenance: {
			origin: "claude-code",
			driver: "claude-code",
			worker: "claude-code",
			judge: "claude-code"
		},
		selectionRef: {
			receiptId: selectionBinding.receiptId,
			receiptDigest: selectionBinding.receiptDigest,
			planSlotId
		},
		triggerRef: null,
		behaviorFingerprint: fingerprint,
		capabilitySnapshot: runtime.definition.requiredCapabilities.map((entry) => ({
			semanticsRef: entry.semanticsRef,
			state: "available",
			observedAt: fingerprint.observedAt
		})),
		effectiveLimits: { ...runtime.definition.limits },
		safeguardAuthorizations: [],
		sessionRef: {
			harness: "claude-code",
			sourceId: "local-gate-2702",
			sessionId: worker.session_id
		},
		observations,
		checkResults,
		usage: {
			wallTimeMs,
			costUsd: accounting.allInCostUsd
		},
		error: classification.status === "succeeded" ? null : {
			code: `gate-2702/${String(classification.error?.code ?? classification.status).replace(/[^a-z0-9._-]/g, "-")}`,
			message: String(classification.error?.message ?? `C5 ${classification.status}`).slice(0, 4096),
			evidenceRefs: classificationEvidence
		},
		extensions: {
			"gate-2702/registrationDigest": registration.contentDigest,
			"gate-2702/classificationDigest": classification.contentDigest,
			"gate-2702/accountingDigest": accounting.contentDigest,
			"gate-2702/judgeResultDigest": judge?.contentDigest ?? null,
			"gate-2702/actualWallTimeMs": terminal.durationMs ?? null
		}
	});
	const decoded = runtime.contracts.decodeRunV1(run, {
		definition: runtime.definition,
		registry: runtime.registry,
		selectionReceipts: [selectionBinding],
		triggerReceipts: [],
		operatorSafeguardAuthorizations: [],
		priorRuns
	});
	if (!decoded.ok) fail$1(`rederived canonical Run ${runId} failed strict v1 decoding: ${JSON.stringify(decoded.issues)}`);
	return decoded.value;
}
async function loadRuntime$1() {
	await Promise.resolve().then(() => (init__gate_2702_runtime_register_noop(), _gate_2702_runtime_register_noop_exports));
	const definitionModule = await Promise.resolve().then(() => (init_definition(), definition_exports));
	const contracts = await Promise.resolve().then(() => (init_v1(), v1_exports));
	const projected = definitionModule.projectGate2702C5Definition(definitionModule.GATE_2702_C5_DEFINITION);
	if (!projected.ok) fail$1("checked-in C5 Definition did not project");
	return {
		plan: projected.plan,
		definition: definitionModule.GATE_2702_C5_DEFINITION,
		registry: definitionModule.GATE_2702_C5_CONTRACT_REGISTRY,
		definitionModule,
		contracts
	};
}
function verifyBundleDirectory(runtime, paths, marker, bundleDirectory) {
	if (!isWithin(paths.bundles, bundleDirectory)) fail$1("seal marker bundle path escapes the trial");
	const metadata = lstatSync(bundleDirectory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail$1("seal bundle is not a real directory");
	if (!sameValue$1(readdirSync(bundleDirectory).sort(), ["manifest.json", "objects"])) fail$1("seal bundle contains unknown top-level evidence");
	const manifest = readReceipt(join(bundleDirectory, "manifest.json"), "Gate2702SealBundle", "seal bundle manifest");
	if (manifest.contentDigest !== marker.bundleDigest || marker.bundleManifestDigest !== manifest.contentDigest || manifest.trialId !== marker.trialId || manifest.trialDigest !== marker.trialDigest || manifest.baseSha !== marker.baseSha || manifest.worktreeManifestDigest !== marker.worktreeManifestDigest || !sameValue$1(manifest.definitionRef, marker.definitionRef) || manifest.retryRegistrationSetDigest !== (marker.retryRegistrationSetDigest ?? null)) fail$1("verified marker does not bind the exact seal bundle");
	const objectsRoot = join(bundleDirectory, "objects");
	const objectsMetadata = lstatSync(objectsRoot);
	if (!objectsMetadata.isDirectory() || objectsMetadata.isSymbolicLink()) fail$1("seal objects root is not a self-contained directory");
	if (!sameValue$1(readdirSync(objectsRoot).sort(), [...new Set(manifest.artifacts.map((entry) => entry.objectName))].sort())) fail$1("seal object directory is not exact");
	const objectBytes = /* @__PURE__ */ new Map();
	for (const entry of manifest.artifacts) {
		if (!DIGEST_PATTERN.test(entry.contentDigest ?? "") || entry.objectName !== entry.contentDigest.replace(":", "-") || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || typeof entry.sourcePath !== "string" || !entry.sourcePath) fail$1("seal manifest contains an invalid artifact entry");
		const bytes = readRegularBytes(join(objectsRoot, entry.objectName), MAX_OBJECT_BYTES, `sealed object ${entry.objectName}`);
		if (bytes.length !== entry.sizeBytes || sha256Bytes(bytes) !== entry.contentDigest) fail$1(`sealed object ${entry.sourcePath} failed content verification`);
		objectBytes.set(entry.contentDigest, bytes);
	}
	const sourcePaths = manifest.artifacts.map((entry) => entry.sourcePath);
	if (new Set(sourcePaths).size !== sourcePaths.length || !sameValue$1(sourcePaths, [...sourcePaths].sort())) fail$1("seal artifact paths are not uniquely sorted");
	const byPath = new Map(manifest.artifacts.map((entry) => [entry.sourcePath, entry]));
	if (!byPath.get("trial.json")) fail$1("verified marker does not bind the exact trial receipt");
	verifySealedTrialSet(runtime, marker, manifest, objectBytes, byPath);
	verifyArtifactCoverage(manifest, objectBytes, byPath);
	const judgeSubjects = manifest.judgeResults.map((entry) => entry.subject);
	if (new Set(judgeSubjects).size !== judgeSubjects.length) fail$1("seal manifest repeats a judge result");
	const artifactBytesByPath = new Map(manifest.artifacts.map((entry) => [entry.sourcePath, objectBytes.get(entry.contentDigest)]));
	for (const candidate of manifest.runCandidates) {
		const verifiedClassification = validateGate2702ClassificationEvidence({
			artifactBytesByPath,
			trialId: marker.trialId,
			baseSha: marker.baseSha,
			subject: candidate.subject,
			treatmentId: candidate.treatmentId,
			attempt: candidate.attempt
		});
		if (verifiedClassification.registration.contentDigest !== candidate.registrationDigest || verifiedClassification.classification.contentDigest !== candidate.classificationDigest || verifiedClassification.classification.status !== candidate.status) fail$1("seal Run candidate does not bind its rederived classification");
	}
	for (const entry of manifest.judgeResults) {
		if (validateGate2702JudgeEvidence({
			artifactBytesByPath,
			trialId: marker.trialId,
			subject: entry.subject,
			baseSha: marker.baseSha
		}).result.contentDigest !== entry.contentDigest) fail$1("seal judge-result manifest digest does not match retained result");
		rederiveSealedJudge(manifest, objectBytes, entry.subject);
	}
	const sealedSelectionGroups = verifySealedArmsAndLiveDiffs(runtime, manifest, objectBytes, byPath);
	const definitionEntry = byPath.get("generated/definition.json");
	if (!definitionEntry) fail$1("seal bundle omits its exact Definition");
	const definitionBytes = objectBytes.get(definitionEntry.contentDigest);
	const definitionInput = JSON.parse(definitionBytes.toString("utf8"));
	const decodedDefinition = runtime.contracts.decodeDefinitionV1(definitionInput, { registry: runtime.registry });
	if (!decodedDefinition.ok || !sameValue$1(decodedDefinition.value, runtime.definition) || !definitionBytes.equals(Buffer.from(`${runtime.contracts.canonicalDocumentJson(runtime.definition)}\n`, "utf8"))) fail$1("sealed Definition is not the checked-in C5 Definition");
	const registryEntry = byPath.get("generated/registry.json");
	if (!registryEntry) fail$1("seal bundle omits its exact contract registry");
	const sealedRegistry = JSON.parse(objectBytes.get(registryEntry.contentDigest).toString("utf8"));
	if (!sameValue$1(sealedRegistry, runtime.registry) || !objectBytes.get(registryEntry.contentDigest).equals(Buffer.from(`${canonicalJson$1(runtime.registry)}\n`, "utf8"))) fail$1("sealed contract registry differs from the checked-in C5 registry");
	const decodedRuns = [];
	const bindings = manifest.selectionBindings;
	for (const runEntry of manifest.canonicalRuns) {
		const artifact = byPath.get(runEntry.sourcePath);
		if (!artifact || artifact.contentDigest !== runEntry.objectDigest) fail$1("canonical Run manifest points at the wrong object");
		const bytes = objectBytes.get(artifact.contentDigest);
		const input = JSON.parse(bytes.toString("utf8"));
		const binding = bindings.find((entry) => entry.receiptId === input.selectionRef?.receiptId);
		const decoded = runtime.contracts.decodeRunV1(input, {
			definition: decodedDefinition.value,
			registry: runtime.registry,
			selectionReceipts: binding ? [binding] : [],
			triggerReceipts: [],
			operatorSafeguardAuthorizations: [],
			priorRuns: decodedRuns
		});
		if (!decoded.ok) fail$1(`sealed canonical Run failed v1 decoding: ${JSON.stringify(decoded.issues)}`);
		const expectedBytes = Buffer.from(`${runtime.contracts.canonicalDocumentJson(decoded.value)}\n`, "utf8");
		if (!bytes.equals(expectedBytes)) fail$1("sealed Run bytes are not canonical v1 JSON");
		if (decoded.value.runId !== runEntry.runId || decoded.value.contentDigest !== runEntry.contentDigest) fail$1("canonical Run manifest identity is wrong");
		decodedRuns.push(decoded.value);
	}
	const canonicalRunIds = manifest.canonicalRuns.map((entry) => entry.runId);
	if (new Set(canonicalRunIds).size !== canonicalRunIds.length) fail$1("seal manifest repeats a canonical Run");
	const includedCandidates = manifest.runCandidates.filter((candidate) => candidate.exclusion === void 0);
	if (includedCandidates.length !== decodedRuns.length || manifest.runCandidates.some((candidate) => candidate.exclusion === void 0 !== (typeof candidate.runId === "string" && DIGEST_PATTERN.test(candidate.runDigest ?? "")))) fail$1("canonical Runs are not a bijection with included run candidates");
	const runById = new Map(decodedRuns.map((run) => [run.runId, run]));
	const expectedPriorByRegistration = /* @__PURE__ */ new Map();
	for (const candidate of includedCandidates) {
		const run = runById.get(candidate.runId);
		const prefix = `runs/issue-${candidate.subject}/${candidate.treatmentId}/attempt-${candidate.attempt}`;
		const registration = parseArtifactJson(objectBytes, byPath.get(`${prefix}/registration.json`), "Gate2702ArmRegistration");
		const terminal = parseArtifactJson(objectBytes, byPath.get(`${prefix}/terminal.json`), "Gate2702Terminal");
		const classification = parseArtifactJson(objectBytes, byPath.get(`${prefix}/classification.json`), "Gate2702ArmClassification");
		const accounting = parseArtifactJson(objectBytes, byPath.get(`${prefix}/accounting.json`), "Gate2702Accounting");
		const expectedWallTime = Math.min(runtime.plan.limits.wallTimeMs, Math.max(0, Math.ceil(terminal.durationMs ?? 0)));
		if (!run || run.contentDigest !== candidate.runDigest || run.trialId !== registration.trialId || run.treatmentId !== registration.treatmentId || run.status !== classification.status || run.subjectRef?.artifactId !== `github:${REPOSITORY}/issues/${registration.subject}` || run.sessionRef?.sessionId !== accounting.workerSessionId || run.usage?.costUsd !== accounting.allInCostUsd || run.usage?.wallTimeMs !== expectedWallTime || run.extensions?.["gate-2702/registrationDigest"] !== registration.contentDigest || run.extensions?.["gate-2702/classificationDigest"] !== classification.contentDigest || run.extensions?.["gate-2702/accountingDigest"] !== accounting.contentDigest) fail$1("canonical Run does not rederive from its sealed arm receipts");
		const selectionInfo = sealedSelectionGroups.byRegistration.get(registration.contentDigest);
		if (!selectionInfo) fail$1("canonical Run has no complete retained behavior evidence");
		const judge = manifest.judgeResults.find((entry) => entry.subject === registration.subject) ? parseArtifactJson(objectBytes, byPath.get(`judging/issue-${registration.subject}/result.json`), "Gate2702JudgeResult") : null;
		const parent = registration.attempt === 2 ? expectedPriorByRegistration.get(registration.retryOf?.registrationDigest) : null;
		if (registration.attempt === 2 && !parent) fail$1("canonical retry Run has no rederived prior Run");
		const expectedRun = rebuildSealedCanonicalRun({
			runtime,
			objectBytes,
			byPath,
			registration,
			terminal,
			classification,
			accounting,
			judge,
			selectionInfo,
			parent,
			priorRuns: [...expectedPriorByRegistration.values()]
		});
		if (!sameValue$1(run, expectedRun) || candidate.runId !== expectedRun.runId || candidate.runDigest !== expectedRun.contentDigest) fail$1("canonical Run does not exactly rederive from sealed evidence");
		expectedPriorByRegistration.set(registration.contentDigest, expectedRun);
		const normalizedExpectedFingerprint = {
			...selectionInfo.fingerprint,
			factors: [...selectionInfo.fingerprint.factors].sort((left, right) => left.id.localeCompare(right.id))
		};
		if (!sameValue$1(run.behaviorFingerprint, normalizedExpectedFingerprint)) fail$1("canonical Run behavior fingerprint does not rederive");
		if (run.selectionRef?.receiptId !== selectionInfo.binding.receiptId || run.selectionRef?.receiptDigest !== selectionInfo.binding.receiptDigest || run.selectionRef?.planSlotId !== selectionInfo.planSlotId) fail$1("canonical Run selection receipt does not rederive");
		if (classification.status === "succeeded") {
			const qualityLoss = TREATMENTS.every((treatmentId) => judge.objectiveChecks?.[treatmentId]?.state === "failed") ? 1 : TREATMENTS.includes(judge.effectiveWinner) && judge.effectiveWinner !== registration.treatmentId ? 1 : 0;
			const expectedMetrics = new Map([
				["metrics/gate-2702-all-in-cost", accounting.allInCostUsd],
				["metrics/gate-2702-wall-time", expectedWallTime],
				["metrics/gate-2702-quality-loss", qualityLoss],
				["metrics/gate-2702-sidekick-triggers", accounting.sidekickTriggerCount],
				["metrics/gate-2702-sidekick-paid-calls", accounting.sidekickPaidCallCount],
				["metrics/gate-2702-sidekick-shipped-interventions", accounting.sidekickShippedInterventionCount],
				["metrics/gate-2702-attributable-ships", registration.treatmentId === "haiku-sonnet-sidekick" && judge.effectiveWinner === "haiku-sonnet-sidekick" && accounting.sidekickShippedInterventionCount > 0 ? 1 : 0]
			]);
			if (run.observations.length !== expectedMetrics.size || run.observations.some((observation) => !expectedMetrics.has(observation.metricId) || expectedMetrics.get(observation.metricId) !== observation.value)) fail$1("canonical Run observations do not rederive from sealed evidence");
		} else if (run.observations.length !== 0 || run.error === null || !run.error.code.startsWith("gate-2702/")) fail$1("non-successful canonical Run has invalid outcome evidence");
		if (candidate.attempt === 2) {
			const parentCandidate = manifest.runCandidates.find((entry) => entry.registrationDigest === registration.retryOf?.registrationDigest);
			if (!parentCandidate?.runId || run.retryOf?.runId !== parentCandidate.runId || run.retryOf?.contentDigest !== parentCandidate.runDigest) fail$1("canonical retry Run does not bind its prior Run");
		} else if (run.retryOf !== null) fail$1("attempt-1 canonical Run unexpectedly declares a retry parent");
	}
	return {
		definition: decodedDefinition.value,
		registry: sealedRegistry,
		runs: decodedRuns,
		manifest,
		objectBytes
	};
}
/**
* Load decoded C5 data only after the immutable marker and every retained
* bundle artifact have passed the full post-cleanup verification path.
*/
async function loadVerifiedTrial(optionsInput) {
	const options = {
		...optionsInput,
		stateRoot: resolve(optionsInput.stateRoot || defaultStateRoot$1())
	};
	const runtime = await loadRuntime$1();
	const paths = trialPaths(options);
	const marker = readReceipt(paths.marker, "Gate2702VerifiedSeal", "verified seal marker");
	if (marker.verified !== true || marker.trialId !== options.trial || !sameValue$1(marker.definitionRef, runtime.plan.definitionRef) || !DIGEST_PATTERN.test(marker.trialDigest ?? "") || !/^[0-9a-f]{40}$/.test(marker.baseSha ?? "") || !DIGEST_PATTERN.test(marker.worktreeManifestDigest ?? "") || !DIGEST_PATTERN.test(marker.bundleDigest ?? "") || marker.bundleDirectory !== join("bundles", marker.bundleDigest.replace(":", "-")) || !Number.isFinite(Date.parse(marker.sealedAt ?? ""))) fail$1("verified seal marker is not the exact C5 cleanup authority");
	const verified = verifyBundleDirectory(runtime, paths, marker, join(paths.sealRoot, marker.bundleDirectory));
	return {
		definition: verified.definition,
		registry: verified.registry,
		runs: verified.runs,
		manifest: verified.manifest,
		marker
	};
}
async function verifyTrial(optionsInput) {
	const verified = await loadVerifiedTrial(optionsInput);
	return {
		trialId: verified.marker.trialId,
		state: "verified",
		bundleDigest: verified.manifest.contentDigest,
		runCount: verified.runs.length,
		excludedRunCount: verified.manifest.runCandidates.filter((entry) => entry.exclusion).length
	};
}
async function sealTrial(optionsInput, dependencies = productionValidators) {
	const options = {
		...optionsInput,
		stateRoot: resolve(optionsInput.stateRoot || defaultStateRoot$1())
	};
	const runtime = await loadRuntime$1();
	const paths = trialPaths(options);
	if (existsSync(paths.marker)) return verifyTrial(options);
	const state = validateTrial(runtime, options, paths);
	const armEvidence = state.registrations.map((registration) => validateTerminalArm(runtime, paths, registration, dependencies, options));
	const selected = selectedAttempts(paths, state.trial, armEvidence);
	const judgeBySubject = validateJudging(paths, options, selected, dependencies);
	const evidencePaths = assertNoUnknownEvidence(paths, expectedEvidencePaths(paths, armEvidence, selected));
	const objectMap = {
		objects: /* @__PURE__ */ new Map(),
		artifacts: [],
		byPath: /* @__PURE__ */ new Map()
	};
	for (const path of evidencePaths) addObject(objectMap, path, readRegularBytes(join(paths.trialRoot, path), MAX_OBJECT_BYTES, path), path.endsWith(".json") ? "application/json" : path.endsWith(".jsonl") ? "application/x-ndjson" : "application/octet-stream");
	collectExternalAccountingObjects(objectMap, armEvidence);
	addObject(objectMap, "generated/definition.json", Buffer.from(`${runtime.contracts.canonicalDocumentJson(runtime.definition)}\n`, "utf8"), "application/json");
	addObject(objectMap, "generated/registry.json", Buffer.from(`${canonicalJson$1(runtime.registry)}\n`, "utf8"), "application/json");
	const diffEntries = /* @__PURE__ */ new Map();
	const trialDiffBounds = {
		rawBytes: 0,
		artifactCount: 0
	};
	for (const evidence of armEvidence) {
		const diff = captureWorktreeDiff(evidence.registration, trialDiffBounds);
		validateFrozenDiff(diff, "captured worktree diff");
		const selectedPair = selected.get(evidence.registration.subject);
		if (selectedPair?.selected[evidence.registration.treatmentId]?.registration.contentDigest === evidence.registration.contentDigest) {
			const frozen = readReceipt(join(paths.trialRoot, "judging", `issue-${evidence.registration.subject}`, "evidence", `${evidence.registration.treatmentId}.json`), "Gate2702JudgeArmEvidence", "frozen judge arm evidence");
			const liveWorker = workerResult(evidence.accounting, evidence.registration.runDir);
			validateFrozenJudgeArm(frozen, evidence.registration, evidence.classification, selectedPair.selection.contentDigest);
			if (frozen.workerResult !== liveWorker?.result || !sameValue$1(frozen.diff, {
				trackedPatch: diff.trackedPatch,
				untracked: diff.untracked
			})) fail$1("live final worktree differs from its frozen judge diff");
		}
		const sourcePath = `generated/diffs/issue-${evidence.registration.subject}.${evidence.registration.treatmentId}.attempt-${evidence.registration.attempt}.json`;
		const diffBytes = Buffer.from(`${canonicalJson$1(diff)}\n`, "utf8");
		if (diffBytes.length > MAX_OBJECT_BYTES) fail$1("encoded worktree diff exceeds the fixed object bound");
		diffEntries.set(evidence.registration.contentDigest, addObject(objectMap, sourcePath, diffBytes, "application/json"));
	}
	objectMap.artifacts.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
	objectMap.byPath = new Map(objectMap.artifacts.map((entry) => [entry.sourcePath, entry]));
	const priorByRegistration = /* @__PURE__ */ new Map();
	const runCandidates = [];
	const canonicalRuns = [];
	const selectionGroups = buildSelectionGroups(runtime, paths, armEvidence);
	const selectionBindings = selectionGroups.bindings;
	for (const evidence of sortedRunEvidence(armEvidence)) {
		const built = buildRunCandidate(runtime, paths, evidence, judgeBySubject.get(evidence.registration.subject) ?? null, objectMap.byPath, priorByRegistration, selectionGroups.byRegistration.get(evidence.registration.contentDigest));
		const candidate = {
			subject: evidence.registration.subject,
			treatmentId: evidence.registration.treatmentId,
			attempt: evidence.registration.attempt,
			status: evidence.classification.status,
			registrationDigest: evidence.registration.contentDigest,
			classificationDigest: evidence.classification.contentDigest,
			accountingDigest: evidence.accounting.contentDigest,
			diffObjectDigest: diffEntries.get(evidence.registration.contentDigest).contentDigest
		};
		if (built.exclusion) {
			runCandidates.push({
				...candidate,
				exclusion: built.exclusion
			});
			continue;
		}
		const runBytes = Buffer.from(`${runtime.contracts.canonicalDocumentJson(built.run)}\n`, "utf8");
		const sourcePath = `generated/runs/${built.run.runId}.json`;
		const entry = addObject(objectMap, sourcePath, runBytes, "application/json");
		canonicalRuns.push({
			sourcePath,
			objectDigest: entry.contentDigest,
			runId: built.run.runId,
			contentDigest: built.run.contentDigest
		});
		priorByRegistration.set(evidence.registration.contentDigest, built.run);
		runCandidates.push({
			...candidate,
			runId: built.run.runId,
			runDigest: built.run.contentDigest
		});
	}
	objectMap.artifacts.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
	const manifest = withDigest({
		schemaVersion: 1,
		kind: "Gate2702SealBundle",
		definitionRef: state.trial.definitionRef,
		trialId: state.trial.trialId,
		trialDigest: state.trial.contentDigest,
		baseSha: state.trial.baseSha,
		worktreeManifestDigest: state.trial.worktreeManifestDigest,
		retryRegistrationSetDigest: state.retryState.registrations.length > 0 ? state.retryState.registrationSetDigest : null,
		registrationCount: state.registrations.length,
		artifacts: objectMap.artifacts,
		runCandidates,
		canonicalRuns,
		selectionBindings,
		judgeResults: [...judgeBySubject.entries()].map(([subject, result]) => ({
			subject,
			contentDigest: result.contentDigest
		}))
	});
	const staging = join(paths.sealRoot, `.staging-${process.pid}-${randomUUID()}`);
	const objectsRoot = join(staging, "objects");
	mkdirSync(objectsRoot, { recursive: true });
	for (const [digest, bytes] of objectMap.objects) writeDurableFile(join(objectsRoot, digest.replace(":", "-")), bytes);
	fsyncDirectory$1(objectsRoot);
	writeDurableFile(join(staging, "manifest.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
	fsyncDirectory$1(staging);
	maybeCrash("after-staging");
	mkdirSync(paths.bundles, { recursive: true });
	const bundleDirectory = join(paths.bundles, manifest.contentDigest.replace(":", "-"));
	if (existsSync(bundleDirectory)) rmSync(staging, {
		recursive: true,
		force: true
	});
	else {
		renameSync(staging, bundleDirectory);
		fsyncDirectory$1(paths.bundles);
	}
	maybeCrash("after-bundle");
	const marker = withDigest({
		schemaVersion: 1,
		kind: "Gate2702VerifiedSeal",
		verified: true,
		definitionRef: state.trial.definitionRef,
		trialId: state.trial.trialId,
		trialDigest: state.trial.contentDigest,
		baseSha: state.trial.baseSha,
		worktreeManifestDigest: state.trial.worktreeManifestDigest,
		...state.retryState.registrations.length > 0 ? { retryRegistrationSetDigest: state.retryState.registrationSetDigest } : {},
		bundleDigest: manifest.contentDigest,
		bundleManifestDigest: manifest.contentDigest,
		bundleDirectory: join("bundles", manifest.contentDigest.replace(":", "-")),
		sealedAt: (/* @__PURE__ */ new Date()).toISOString()
	});
	verifyBundleDirectory(runtime, paths, marker, bundleDirectory);
	maybeCrash("before-marker");
	atomicWriteJson(paths.marker, marker);
	return verifyTrial(options);
}
async function main$1() {
	if (process.env.CHD_EXPERIMENT_2702 !== "1") fail$1("gate-2702 sealing is opt-in; set CHD_EXPERIMENT_2702=1 to enable it");
	const options = parseArgs$1(process.argv.slice(2));
	const result = options.command === "seal" ? await sealTrial(options) : await verifyTrial(options);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}
var PROJECT_ROOT, CLASSIFIER_PATH, ACCOUNTING_PATH, JUDGE_PATH, DEFINITION_DIGEST, DEFINITION_ID, DEFINITION_VERSION, REPOSITORY, SUBJECTS, TREATMENTS, CHECK_IDS, MAX_RECEIPT_BYTES, MAX_OBJECT_BYTES, MAX_GIT_BYTES, MAX_WORKTREE_DIFF_ARTIFACTS, MAX_WORKTREE_DIFF_RAW_BYTES, MAX_TRIAL_DIFF_ARTIFACTS, MAX_TRIAL_DIFF_RAW_BYTES, JUDGE_MODEL, SIDEKICK_MODEL, JUDGE_TIMEOUT_MS, JUDGE_BUDGET_USD, JUDGE_MAX_STREAM_BYTES, JUDGE_DIMENSIONS, JUDGE_SCHEMA, UUID_PATTERN$1, DIGEST_PATTERN, DEFINITION_REF, productionValidators;
var init_seal = __esmMin((() => {
	init_seal_accounting();
	init_seal_classification();
	init_seal_judge();
	PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	CLASSIFIER_PATH = join(PROJECT_ROOT, "scripts/gate-2702/classify.mjs");
	ACCOUNTING_PATH = join(PROJECT_ROOT, "scripts/gate-2702/accounting.mjs");
	JUDGE_PATH = join(PROJECT_ROOT, "scripts/gate-2702/judge.mjs");
	DEFINITION_DIGEST = "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba";
	DEFINITION_ID = "experiments/gate-2702-c5";
	DEFINITION_VERSION = 1;
	REPOSITORY = "shpwrck/claude-history-dashboard";
	SUBJECTS = [
		2760,
		2719,
		2713,
		2706,
		2710,
		2670
	];
	TREATMENTS = ["haiku-solo", "haiku-sonnet-sidekick"];
	CHECK_IDS = ["checks/gate-2702-vitest", "checks/gate-2702-typecheck"];
	MAX_RECEIPT_BYTES = 32 * 1024 * 1024;
	MAX_OBJECT_BYTES = 256 * 1024 * 1024;
	MAX_GIT_BYTES = 256 * 1024 * 1024;
	MAX_WORKTREE_DIFF_ARTIFACTS = 1024;
	MAX_WORKTREE_DIFF_RAW_BYTES = 64 * 1024 * 1024;
	MAX_TRIAL_DIFF_ARTIFACTS = 4096;
	MAX_TRIAL_DIFF_RAW_BYTES = 256 * 1024 * 1024;
	JUDGE_MODEL = "claude-haiku-4-5-20251001";
	SIDEKICK_MODEL = "claude-sonnet-5";
	JUDGE_TIMEOUT_MS = 6e5;
	JUDGE_BUDGET_USD = "0.25";
	JUDGE_MAX_STREAM_BYTES = 2 * 1024 * 1024;
	JUDGE_DIMENSIONS = [
		"correctness",
		"design",
		"completeness",
		"clarity",
		"scopeFit",
		"autonomy"
	];
	JUDGE_SCHEMA = {
		type: "object",
		additionalProperties: false,
		required: [
			"winner",
			"scores",
			"rationale"
		],
		properties: {
			winner: {
				type: "string",
				enum: [
					"A",
					"B",
					"tie"
				]
			},
			scores: {
				type: "object",
				additionalProperties: false,
				required: ["A", "B"],
				properties: {
					A: { $ref: "#/$defs/dimensionScores" },
					B: { $ref: "#/$defs/dimensionScores" }
				}
			},
			rationale: {
				type: "string",
				minLength: 1,
				maxLength: 4096
			}
		},
		$defs: { dimensionScores: {
			type: "object",
			additionalProperties: false,
			required: JUDGE_DIMENSIONS,
			properties: Object.fromEntries(JUDGE_DIMENSIONS.map((key) => [key, {
				type: "integer",
				minimum: 1,
				maximum: 10
			}]))
		} }
	};
	UUID_PATTERN$1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
	DEFINITION_REF = Object.freeze({
		definitionId: DEFINITION_ID,
		definitionVersion: DEFINITION_VERSION,
		contentDigest: DEFINITION_DIGEST
	});
	productionValidators = {
		classification(options, registration) {
			return runProducer(producerArgs(CLASSIFIER_PATH, "classify", options, registration));
		},
		accounting(options, registration) {
			return runProducer(producerArgs(ACCOUNTING_PATH, "collect", options, registration));
		},
		judge(options, subject) {
			return runProducer([
				JUDGE_PATH,
				"run",
				"--trial",
				options.trial,
				"--subject",
				String(subject),
				"--state-root",
				options.stateRoot
			], new Set([0, 2]));
		}
	};
	if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main$1().catch((error) => {
		process.stderr.write(`gate-2702 seal: ${error?.stack || error}\n`);
		process.exitCode = 1;
	});
}));
//#endregion
//#region scripts/gate-2702/evaluate.mjs
/**
* Deterministic policy evaluator for the one pre-registered #2702 C5 trial.
*
* This remains intentionally narrower than a generic experiment evaluator. Its
* input is the verified #2822 seal, and its output is the exact C5 v1 Verdict.
*/
var CONTROL = "haiku-solo";
var TREATMENT = "haiku-sonnet-sidekick";
var COST_METRIC = "metrics/gate-2702-all-in-cost";
var QUALITY_METRIC = "metrics/gate-2702-quality-loss";
var ATTRIBUTABLE_METRIC = "metrics/gate-2702-attributable-ships";
var SHIPPED_METRIC = "metrics/gate-2702-sidekick-shipped-interventions";
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var MAX_EVALUATION_BYTES = 4 * 1024 * 1024;
function fail(message) {
	throw new Error(message);
}
function canonicalValue(value) {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}
function sameValue(left, right) {
	return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}
function canonicalJson(value) {
	return JSON.stringify(canonicalValue(value));
}
function valueDigest(value) {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
function withReceiptDigest(candidate) {
	const body = { ...candidate };
	delete body.contentDigest;
	return {
		...candidate,
		contentDigest: valueDigest(body)
	};
}
function deterministicUuid(value) {
	const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
	bytes[6] = bytes[6] & 15 | 80;
	bytes[8] = bytes[8] & 63 | 128;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function definitionRef(definition) {
	return {
		definitionId: definition.definitionId,
		definitionVersion: definition.definitionVersion,
		contentDigest: definition.contentDigest
	};
}
function runRef(run) {
	return {
		runId: run.runId,
		contentDigest: run.contentDigest
	};
}
function metric(run, metricId) {
	const observation = run.observations.find((candidate) => candidate.metricId === metricId);
	if (!observation) fail(`Run ${run.runId} omits ${metricId}`);
	return observation.value;
}
function subjectKey(run) {
	return [
		run.subjectRef.harness,
		run.subjectRef.sourceId,
		run.subjectRef.artifactId,
		run.subjectRef.contentDigest
	].join("\0");
}
async function loadRuntime() {
	await Promise.resolve().then(() => (init__gate_2702_runtime_register_noop(), _gate_2702_runtime_register_noop_exports));
	return {
		definitionModule: await Promise.resolve().then(() => (init_definition(), definition_exports)),
		contracts: await Promise.resolve().then(() => (init_v1(), v1_exports))
	};
}
function strictRuns(input, runtime) {
	const { contracts } = runtime;
	const selectionReceipts = input.manifest.selectionBindings;
	if (!Array.isArray(selectionReceipts)) fail("verified C5 manifest omits selection bindings");
	if (!Array.isArray(input.runs)) fail("verified C5 bundle omits canonical Runs");
	const pending = /* @__PURE__ */ new Map();
	for (const run of input.runs) {
		if (pending.has(run?.runId)) fail(`C5 bundle repeats Run ${String(run?.runId)}`);
		pending.set(run?.runId, run);
	}
	const decoded = [];
	const decodedIds = /* @__PURE__ */ new Set();
	while (pending.size > 0) {
		const ready = [...pending.values()].filter((run) => !run.retryOf || decodedIds.has(run.retryOf.runId)).sort((left, right) => left.runId.localeCompare(right.runId));
		if (ready.length === 0) fail("C5 retry lineage has a missing parent or cycle");
		const run = ready[0];
		const result = contracts.decodeRunV1(run, {
			definition: input.definition,
			registry: input.registry,
			selectionReceipts,
			triggerReceipts: [],
			operatorSafeguardAuthorizations: [],
			priorRuns: decoded
		});
		if (!result.ok) fail(`Run ${String(run?.runId)} is not strict C5 v1 evidence: ${JSON.stringify(result.issues)}`);
		decoded.push(result.value);
		decodedIds.add(result.value.runId);
		pending.delete(run.runId);
	}
	return decoded.sort((left, right) => left.runId.localeCompare(right.runId));
}
function gate(state, basis, observed) {
	return {
		state,
		basis,
		observed
	};
}
function defaultStateRoot() {
	return resolve(process.env.CHD_EXPERIMENT_2702_STATE_ROOT || join(homedir(), ".claude", "shadow-calls", "gate-2702"));
}
function normalizeOptions(optionsInput) {
	if (!UUID_PATTERN.test(optionsInput?.trial ?? "")) fail("--trial must be an RFC 4122 UUID");
	return {
		trial: optionsInput.trial,
		stateRoot: resolve(optionsInput.stateRoot || defaultStateRoot())
	};
}
function evaluationPaths(options, definition) {
	const root = join(join(options.stateRoot, definition.contentDigest.replace(":", "-"), options.trial), "evaluation");
	return {
		root,
		results: join(root, "results"),
		current: join(root, "current.json")
	};
}
function readRegularText(path, label) {
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} is not a regular file`);
	if (metadata.size > MAX_EVALUATION_BYTES) fail(`${label} exceeds the evaluation size bound`);
	return readFileSync(path, "utf8");
}
function readRegularJson(path, label) {
	const bytes = readRegularText(path, label);
	try {
		return {
			value: JSON.parse(bytes),
			bytes
		};
	} catch (error) {
		fail(`${label} is not valid JSON: ${error.message}`);
	}
}
function fsyncDirectory(path) {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
function writeImmutable(path, bytes) {
	const temporary = join(dirname(path), `.result.${process.pid}.${randomUUID()}.tmp`);
	let descriptor = openSync(temporary, "wx", 384);
	try {
		writeFileSync(descriptor, bytes, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = void 0;
		try {
			linkSync(temporary, path);
			fsyncDirectory(dirname(path));
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			if (readRegularText(path, "immutable C5 evaluation object") !== bytes) fail(`immutable evaluation already exists with different bytes: ${path}`);
		}
	} finally {
		if (descriptor !== void 0) closeSync(descriptor);
		if (existsSync(temporary)) {
			unlinkSync(temporary);
			fsyncDirectory(dirname(path));
		}
	}
}
function atomicWrite(path, bytes) {
	const temporary = join(dirname(path), `.current.${process.pid}.${randomUUID()}.tmp`);
	const descriptor = openSync(temporary, "wx", 384);
	try {
		writeFileSync(descriptor, bytes, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		renameSync(temporary, path);
		fsyncDirectory(dirname(path));
	} finally {
		try {
			closeSync(descriptor);
		} catch {}
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}
async function verifiedTrial(options, dependencies) {
	const loadVerifiedTrial = dependencies?.loadVerifiedTrial ?? (await Promise.resolve().then(() => (init_seal(), seal_exports))).loadVerifiedTrial;
	if (typeof loadVerifiedTrial !== "function") fail("#2822 does not expose loadVerifiedTrial(options)");
	return loadVerifiedTrial(options);
}
function terminalExclusionReason(run) {
	return run.status === "failed" ? "run/status-failed" : "run/status-cancelled";
}
/** Evaluate only fully verified, decoded evidence returned by #2822. */
async function evaluateTrialEvidence(input) {
	const runtime = await loadRuntime();
	const { definitionModule, contracts } = runtime;
	if (!definitionModule.projectGate2702C5Definition(input.definition).ok) fail("evaluator accepts only the exact checked-in C5 Definition");
	if (contracts.canonicalJson(input.registry) !== contracts.canonicalJson(definitionModule.GATE_2702_C5_CONTRACT_REGISTRY)) fail("evaluator accepts only the exact checked-in C5 contract registry");
	if (input.marker?.trialId !== input.manifest?.trialId || input.marker?.bundleDigest !== input.manifest?.contentDigest || !sameValue(input.marker?.definitionRef, definitionRef(input.definition)) || !sameValue(input.manifest?.definitionRef, definitionRef(input.definition))) fail("verified seal marker and bundle do not bind the C5 Definition");
	if (!Number.isFinite(Date.parse(input.marker.sealedAt ?? ""))) fail("verified seal marker has no valid retained seal timestamp");
	const runs = strictRuns(input, runtime);
	if (runs.some((run) => run.trialId !== input.marker.trialId)) fail("C5 bundle mixes trials");
	if (!Array.isArray(input.manifest.canonicalRuns)) fail("C5 manifest omits its canonical Run bindings");
	const manifestRefs = new Map(input.manifest.canonicalRuns.map((entry) => [entry.runId, entry.contentDigest]));
	if (input.manifest.canonicalRuns.length !== runs.length || manifestRefs.size !== runs.length || runs.some((run) => manifestRefs.get(run.runId) !== run.contentDigest)) fail("C5 manifest does not bind every terminal Run exactly once");
	if (!Array.isArray(input.manifest.runCandidates)) fail("C5 manifest omits its exact run candidate dispositions");
	const sealedCandidateExclusions = input.manifest.runCandidates.filter((candidate) => typeof candidate.exclusion === "string").map((candidate) => ({
		subject: candidate.subject,
		treatmentId: candidate.treatmentId,
		attempt: candidate.attempt,
		reason: candidate.exclusion
	})).sort((left, right) => left.subject - right.subject || left.treatmentId.localeCompare(right.treatmentId) || left.attempt - right.attempt || left.reason.localeCompare(right.reason));
	if (runs.length === 0) {
		if (input.manifest.runCandidates.length === 0 || sealedCandidateExclusions.length !== input.manifest.runCandidates.length) fail("zero-Run C5 evidence must explain every sealed candidate exclusion");
		return withReceiptDigest({
			schemaVersion: 1,
			kind: "Gate2702InsufficientEvidence",
			contentDigest: `sha256:${"0".repeat(64)}`,
			trialId: input.marker.trialId,
			definitionRef: definitionRef(input.definition),
			bundleDigest: input.manifest.contentDigest,
			state: "insufficient-evidence",
			reason: "evidence/no-canonical-runs",
			sampleCounts: [{
				treatmentId: CONTROL,
				n: 0
			}, {
				treatmentId: TREATMENT,
				n: 0
			}],
			candidateExclusions: sealedCandidateExclusions,
			evaluatedAt: input.marker.sealedAt
		});
	}
	const supersededRunIds = new Set(runs.flatMap((run) => run.retryOf ? [run.retryOf.runId] : []));
	const activeRuns = runs.filter((run) => !supersededRunIds.has(run.runId));
	const disposition = new Map(runs.map((run) => [run.runId, supersededRunIds.has(run.runId) ? "run/retry-superseded" : run.status === "succeeded" ? null : terminalExclusionReason(run)]));
	const pairs = /* @__PURE__ */ new Map();
	for (const run of activeRuns) {
		const key = subjectKey(run);
		const pair = pairs.get(key) ?? /* @__PURE__ */ new Map();
		const arms = pair.get(run.treatmentId) ?? [];
		arms.push(run);
		pair.set(run.treatmentId, arms);
		pairs.set(key, pair);
	}
	let invalidEvidence = false;
	for (const pair of pairs.values()) {
		for (const treatmentId of [CONTROL, TREATMENT]) {
			const arms = pair.get(treatmentId) ?? [];
			if (arms.length <= 1) continue;
			invalidEvidence = true;
			const expected = arms.filter((run) => {
				const subject = run.subjectRef.artifactId.split("/").at(-1);
				return run.selectionRef.planSlotId === `issue-${subject}.${treatmentId}` || run.selectionRef.planSlotId === `issue-${subject}.${treatmentId}.retry-2`;
			});
			if (expected.length !== 1) fail(`C5 evidence has no unique pre-registered ${treatmentId} Run`);
			for (const run of arms) if (run.runId !== expected[0].runId) disposition.set(run.runId, "run/duplicate-slot");
		}
		const eligibleControl = (pair.get(CONTROL) ?? []).filter((run) => disposition.get(run.runId) === null);
		const eligibleTreatment = (pair.get(TREATMENT) ?? []).filter((run) => disposition.get(run.runId) === null);
		const hasControl = eligibleControl.length === 1;
		const hasTreatment = eligibleTreatment.length === 1;
		if (hasControl && hasTreatment) continue;
		for (const arms of pair.values()) for (const run of arms) if (disposition.get(run.runId) === null) disposition.set(run.runId, "run/pair-incomplete");
	}
	const includedRuns = runs.filter((run) => disposition.get(run.runId) === null);
	const includedIds = new Set(includedRuns.map((run) => run.runId));
	const excludedRuns = runs.filter((run) => disposition.get(run.runId) !== null).map((run) => ({
		run: runRef(run),
		reason: disposition.get(run.runId)
	}));
	const byTreatment = Object.fromEntries([CONTROL, TREATMENT].map((treatmentId) => [treatmentId, includedRuns.filter((run) => run.treatmentId === treatmentId)]));
	const sampleCounts = [CONTROL, TREATMENT].map((treatmentId) => ({
		treatmentId,
		n: byTreatment[treatmentId].length
	}));
	const controlCost = byTreatment[CONTROL].reduce((total, run) => total + metric(run, COST_METRIC), 0);
	const treatmentCost = byTreatment[TREATMENT].reduce((total, run) => total + metric(run, COST_METRIC), 0);
	const treatmentLosses = byTreatment[TREATMENT].reduce((total, run) => total + metric(run, QUALITY_METRIC), 0);
	let treatmentWins = 0;
	let attributableWins = 0;
	let treatmentWinsWithShippedIntervention = 0;
	for (const pair of pairs.values()) {
		const control = (pair.get(CONTROL) ?? []).find((run) => includedIds.has(run.runId));
		const treatment = (pair.get(TREATMENT) ?? []).find((run) => includedIds.has(run.runId));
		if (!control || !treatment || !includedIds.has(control.runId) || !includedIds.has(treatment.runId)) continue;
		if (metric(treatment, QUALITY_METRIC) < metric(control, QUALITY_METRIC)) {
			treatmentWins += 1;
			if (metric(treatment, ATTRIBUTABLE_METRIC) > 0) attributableWins += 1;
			if (metric(treatment, SHIPPED_METRIC) > 0) treatmentWinsWithShippedIntervention += 1;
		}
	}
	const minimumSamplePassed = sampleCounts.every(({ n }) => n >= 6);
	const parityPassed = treatmentLosses <= 0;
	const costPassed = treatmentCost < controlCost;
	const attributablePassed = attributableWins >= 1 && treatmentWinsWithShippedIntervention === treatmentWins;
	const gateState = (passed) => invalidEvidence ? "not-evaluable" : passed ? "passed" : "failed";
	const gates = {
		parityFloor: gate(gateState(parityPassed), "maximum zero heavy-task losses for the Sidekick treatment", {
			maximumHeavyTaskLosses: 0,
			treatmentHeavyTaskLosses: treatmentLosses
		}),
		netPositiveCost: gate(gateState(costPassed), "Sidekick treatment all-in cost must be less than control all-in cost", {
			controlAllInCostUsd: controlCost,
			treatmentAllInCostUsd: treatmentCost,
			savingsUsd: controlCost - treatmentCost
		}),
		attributableShips: gate(gateState(attributablePassed), "at least one Sidekick win must be attributable and every win must ship an intervention", {
			treatmentWins,
			attributableTreatmentWins: attributableWins,
			treatmentWinsWithShippedIntervention
		}),
		minimumSample: gate(gateState(minimumSamplePassed), "each treatment must contribute six eligible terminal Runs", {
			requiredRunsPerTreatment: 6,
			controlRuns: byTreatment[CONTROL].length,
			treatmentRuns: byTreatment[TREATMENT].length,
			sealedCandidateExclusionCount: sealedCandidateExclusions.length
		})
	};
	const allGatesPassed = Object.values(gates).every((result) => result.state === "passed");
	const decision = invalidEvidence ? "invalid" : minimumSamplePassed ? allGatesPassed ? "sidekick-clears" : "sidekick-does-not-clear" : "inconclusive";
	const relativeBaselineZero = minimumSamplePassed && !invalidEvidence && controlCost === 0;
	const estimate = controlCost === 0 ? null : (controlCost - treatmentCost) / controlCost;
	const outcome = invalidEvidence ? {
		kind: "invalid",
		reason: "evidence/ambiguous-run-slot"
	} : !minimumSamplePassed ? {
		kind: "inconclusive",
		reason: "sample/minimum-not-met"
	} : relativeBaselineZero ? {
		kind: "invalid",
		reason: "effect/relative-baseline-zero"
	} : estimate > 0 ? {
		kind: "winner",
		winningTreatmentId: TREATMENT
	} : estimate < 0 ? {
		kind: "winner",
		winningTreatmentId: CONTROL
	} : { kind: "tie" };
	const { parameters: _parameters, ...policy } = input.definition.verdictPolicy;
	const { direction: _direction, ...primaryEffectDefinition } = input.definition.verdictPolicy.parameters.primaryEffect;
	const evidenceTimestamp = runs.map((run) => run.finishedAt).sort().at(-1);
	if (!evidenceTimestamp) fail("C5 Verdict requires terminal Run evidence");
	const previousVerdict = input.previousVerdict ?? null;
	if (previousVerdict && (previousVerdict.contentDigest !== contracts.computeDocumentDigest(previousVerdict) || previousVerdict.trialId !== input.marker.trialId || !sameValue(previousVerdict.definitionRef, definitionRef(input.definition)))) fail("previous C5 Verdict has invalid identity or canonical digest");
	if (previousVerdict && Date.parse(evidenceTimestamp) <= Date.parse(previousVerdict.updatedAt)) fail("corrected C5 evidence must finish after the previous Verdict");
	const createdAt = previousVerdict?.createdAt ?? evidenceTimestamp;
	const updateReason = previousVerdict ? "Corrected deterministic #2702 C5 policy evaluation after the sealed Run set changed." : "Initial deterministic #2702 C5 policy evaluation.";
	const candidate = contracts.withDocumentDigest({
		schemaVersion: 1,
		kind: "ExperimentVerdict",
		verdictId: deterministicUuid(`gate-2702-verdict\0${input.marker.trialId}\0${input.definition.contentDigest}`),
		trialId: input.marker.trialId,
		contentDigest: `sha256:${"0".repeat(64)}`,
		definitionRef: definitionRef(input.definition),
		policy,
		evidence: {
			includedRuns: includedRuns.map(runRef),
			excludedRuns
		},
		outcome,
		policyResult: {
			basis: "policies/gate-2702-c5-graduation",
			parameters: {
				decision,
				gates
			}
		},
		evidenceBasis: {
			evidenceHarness: "claude-code",
			satisfiedCapabilitySemantics: includedRuns.length === 0 ? [] : input.definition.requiredCapabilities.map(({ semanticsRef }) => semanticsRef)
		},
		primaryEffect: minimumSamplePassed && !invalidEvidence && estimate !== null ? {
			...primaryEffectDefinition,
			estimate,
			uncertainty: {
				kind: "not-estimated",
				reason: "statistics/fixed-cohort-no-interval"
			},
			sampleCounts
		} : null,
		judge: {
			harness: "claude-code",
			sessionRef: {
				harness: "claude-code",
				sourceId: "local-gate-2702",
				sessionId: `verdict-${input.marker.trialId}`
			}
		},
		createdAt,
		updatedAt: evidenceTimestamp,
		updateReason,
		extensions: {
			"gate-2702/bundleDigest": input.manifest.contentDigest,
			"gate-2702/evaluatorVersion": 1,
			"gate-2702/sealedCandidateExclusions": sealedCandidateExclusions,
			...previousVerdict ? { "gate-2702/previousVerdictDigest": previousVerdict.contentDigest } : {}
		}
	});
	const decoded = contracts.decodeVerdictV1(candidate, {
		definition: input.definition,
		registry: input.registry,
		trialRuns: runs,
		previousVerdict
	});
	if (!decoded.ok) fail(`computed C5 Verdict is invalid: ${JSON.stringify(decoded.issues)}`);
	return decoded.value;
}
function evaluationObjectPath(paths, contentDigest) {
	if (!/^sha256:[0-9a-f]{64}$/.test(contentDigest ?? "")) fail("persisted C5 evaluation has no valid content digest");
	return join(paths.results, `${contentDigest.replace(":", "-")}.json`);
}
function evaluationBundleDigest(evaluation) {
	if (evaluation?.kind === "ExperimentVerdict") return evaluation.extensions?.["gate-2702/bundleDigest"];
	if (evaluation?.kind === "Gate2702InsufficientEvidence") return evaluation.bundleDigest;
	fail("C5 evaluation has an unsupported result kind");
}
function canonicalEvaluationJson(evaluation, contracts) {
	if (evaluation?.kind === "ExperimentVerdict") return contracts.canonicalDocumentJson(evaluation);
	if (evaluation?.kind === "Gate2702InsufficientEvidence") return canonicalJson(evaluation);
	fail("C5 evaluation has an unsupported result kind");
}
function computeEvaluationDigest(evaluation, contracts) {
	if (evaluation?.kind === "ExperimentVerdict") return contracts.computeDocumentDigest(evaluation);
	if (evaluation?.kind === "Gate2702InsufficientEvidence") {
		const body = { ...evaluation };
		delete body.contentDigest;
		return valueDigest(body);
	}
	fail("C5 evaluation has an unsupported result kind");
}
function canonicalEvaluationBytes(evaluation, contracts) {
	return `${canonicalEvaluationJson(evaluation, contracts)}\n`;
}
function readEvaluationObject(paths, contentDigest, contracts, label) {
	const path = evaluationObjectPath(paths, contentDigest);
	if (!existsSync(path)) fail("immutable C5 evaluation object is missing");
	const record = readRegularJson(path, label);
	if (record.value.contentDigest !== contentDigest || computeEvaluationDigest(record.value, contracts) !== contentDigest) fail(`${label} has an invalid canonical digest`);
	const canonicalBytes = canonicalEvaluationBytes(record.value, contracts);
	if (record.bytes !== canonicalBytes) fail(`${label} bytes are not canonical JSON`);
	return record;
}
function readPublishedCurrent(paths, contracts) {
	const current = readRegularJson(paths.current, "current C5 evaluation");
	if (current.value.contentDigest !== computeEvaluationDigest(current.value, contracts)) fail("current C5 evaluation has an invalid canonical digest");
	const canonicalBytes = canonicalEvaluationBytes(current.value, contracts);
	if (current.bytes !== canonicalBytes) fail("current C5 evaluation bytes are not canonical JSON");
	if (readEvaluationObject(paths, current.value.contentDigest, contracts, "immutable C5 evaluation object").bytes !== current.bytes) fail("current C5 evaluation differs from its immutable object");
	return current;
}
async function rederivePublishedCurrent(verified, paths, contracts, current) {
	if (evaluationBundleDigest(current.value) !== verified.manifest.contentDigest) fail("verified C5 seal bundle changed after evaluation; durable corrections are unsupported; start a new trial");
	if (current.value.kind === "ExperimentVerdict" && Object.prototype.hasOwnProperty.call(current.value.extensions ?? {}, "gate-2702/previousVerdictDigest")) fail("persisted Verdict correction lineage is unsupported; start a new trial");
	const expected = await evaluateTrialEvidence({
		...verified,
		previousVerdict: null
	});
	if (canonicalEvaluationBytes(expected, contracts) !== current.bytes) fail("current C5 evaluation does not rederive from the verified seal");
	return expected;
}
/** Verify the immutable seal, evaluate it, and atomically publish its result. */
async function evaluateTrial(optionsInput, dependencies) {
	const options = normalizeOptions(optionsInput);
	const verified = await verifiedTrial(options, dependencies);
	const paths = evaluationPaths(options, verified.definition);
	mkdirSync(paths.results, {
		recursive: true,
		mode: 448
	});
	const { contracts } = await loadRuntime();
	const current = existsSync(paths.current) ? readPublishedCurrent(paths, contracts) : null;
	if (current) return rederivePublishedCurrent(verified, paths, contracts, current);
	const evaluation = await evaluateTrialEvidence({
		...verified,
		previousVerdict: null
	});
	const bytes = canonicalEvaluationBytes(evaluation, contracts);
	writeImmutable(evaluationObjectPath(paths, evaluation.contentDigest), bytes);
	atomicWrite(paths.current, bytes);
	return evaluation;
}
/** One verified read for #2834: evaluation result plus its exact sealed evidence. */
async function loadCurrentEvaluation(optionsInput, dependencies) {
	const options = normalizeOptions(optionsInput);
	const verified = await verifiedTrial(options, dependencies);
	const paths = evaluationPaths(options, verified.definition);
	if (!existsSync(paths.current)) fail("current C5 evaluation does not exist");
	const { contracts } = await loadRuntime();
	return {
		evaluation: await rederivePublishedCurrent(verified, paths, contracts, readPublishedCurrent(paths, contracts)),
		...verified
	};
}
function parseArgs(argv) {
	const [command, ...rest] = argv;
	if (command !== "evaluate") fail("usage: evaluate.mjs evaluate --trial <uuid> [--state-root <path>]");
	const options = {};
	for (let index = 0; index < rest.length; index += 2) {
		const key = rest[index];
		const value = rest[index + 1];
		if (!key?.startsWith("--") || value === void 0) fail(`invalid argument near ${String(key)}`);
		const name = key.slice(2);
		if (!["trial", "state-root"].includes(name)) fail(`unknown option ${key}`);
		if (options[name] !== void 0) fail(`duplicate option ${key}`);
		options[name] = value;
	}
	return normalizeOptions({
		trial: options.trial,
		stateRoot: options["state-root"]
	});
}
async function main() {
	if (process.env.CHD_EXPERIMENT_2702 !== "1") fail("gate-2702 evaluation is opt-in; set CHD_EXPERIMENT_2702=1 to enable it");
	const evaluation = await evaluateTrial(parseArgs(process.argv.slice(2)));
	const { contracts } = await loadRuntime();
	process.stdout.write(canonicalEvaluationBytes(evaluation, contracts));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => {
	process.stderr.write(`gate-2702 evaluate: ${error?.stack || error}\n`);
	process.exitCode = 1;
});
//#endregion
export { loadCurrentEvaluation };
