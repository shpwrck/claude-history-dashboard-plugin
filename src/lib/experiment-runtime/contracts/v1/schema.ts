import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';

import definitionSchema from '../../schemas/v1/experiment-definition.schema.json' with { type: 'json' };
import runSchema from '../../schemas/v1/experiment-run.schema.json' with { type: 'json' };
import verdictSchema from '../../schemas/v1/experiment-verdict.schema.json' with { type: 'json' };

export type JsonSchema = boolean | Readonly<Record<string, unknown>>;

export interface SchemaIssue {
  code: string;
  path: string;
  message: string;
}

function freezeDeep(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  Object.freeze(value);
}

/** Checked-in, self-contained Draft 2020-12 wire schemas. */
export const EXPERIMENT_CONTRACT_SCHEMAS_V1 = {
  ExperimentDefinition: definitionSchema as JsonSchema,
  ExperimentRun: runSchema as JsonSchema,
  ExperimentVerdict: verdictSchema as JsonSchema,
} as const;

freezeDeep(EXPERIMENT_CONTRACT_SCHEMAS_V1);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const contractValidators = {
  ExperimentDefinition: ajv.compile(
    EXPERIMENT_CONTRACT_SCHEMAS_V1.ExperimentDefinition
  ),
  ExperimentRun: ajv.compile(EXPERIMENT_CONTRACT_SCHEMAS_V1.ExperimentRun),
  ExperimentVerdict: ajv.compile(
    EXPERIMENT_CONTRACT_SCHEMAS_V1.ExperimentVerdict
  ),
} as const;

function kebabKeyword(keyword: string): string {
  return keyword.replaceAll(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function issuePath(error: ErrorObject): string {
  const base = `$${error.instancePath}`;
  if (
    error.keyword === 'additionalProperties' &&
    typeof error.params.additionalProperty === 'string'
  ) {
    return `${base}/${error.params.additionalProperty}`;
  }
  if (
    error.keyword === 'required' &&
    typeof error.params.missingProperty === 'string'
  ) {
    return `${base}/${error.params.missingProperty}`;
  }
  return base;
}

function schemaIssues(errors: ErrorObject[] | null | undefined): SchemaIssue[] {
  return (errors ?? []).map((error) => ({
    code: `schema.${kebabKeyword(error.keyword)}`,
    path: issuePath(error),
    message: error.message ?? `failed ${error.keyword}`,
  }));
}

export function validateContractSchema(
  value: unknown,
  kind: keyof typeof contractValidators
): SchemaIssue[] {
  const validator = contractValidators[kind];
  return validator(value) ? [] : schemaIssues(validator.errors);
}

const registryValidators = new WeakMap<object, ValidateFunction>();
const registryBooleanValidators = new Map<boolean, ValidateFunction>();

/** Validate a registry-owned value with full strict Draft 2020-12 semantics. */
export function validateRegistrySchema(
  value: unknown,
  schema: JsonSchema
): { issues: SchemaIssue[]; schemaError?: string } {
  try {
    let validator =
      typeof schema === 'boolean'
        ? registryBooleanValidators.get(schema)
        : registryValidators.get(schema);
    if (!validator) {
      const registryAjv = new Ajv2020({ allErrors: true, strict: true });
      validator = registryAjv.compile(schema);
      if (typeof schema === 'boolean') {
        registryBooleanValidators.set(schema, validator);
      } else {
        registryValidators.set(schema, validator);
      }
    }
    if ((validator as ValidateFunction & { $async?: boolean }).$async === true) {
      return {
        issues: [],
        schemaError: 'async registry schemas are not supported',
      };
    }
    return {
      issues: validator(value) ? [] : schemaIssues(validator.errors),
    };
  } catch (error) {
    return {
      issues: [],
      schemaError: error instanceof Error ? error.message : String(error),
    };
  }
}
