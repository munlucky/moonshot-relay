import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { KERNEL_SCHEMA_DEFINITIONS, type KernelContractTypes } from './schema-definitions.generated.js';

export class KernelContractSchemaError extends Error {
  readonly code = 'kernel_contract_schema_invalid';
  constructor(readonly contractId: string, detail: string) {
    super(`Invalid Kernel contract ${contractId}: ${detail}`);
    this.name = 'KernelContractSchemaError';
  }
}

const validators = new Map<string, ValidateFunction<unknown>>();
const drafts = {
  'http://json-schema.org/draft-07/schema#': new Ajv({ strict: false, allErrors: true }),
  'https://json-schema.org/draft/2020-12/schema': new Ajv2020({ strict: false, allErrors: true }),
};
// CommonJS SDK callable is checked here; it never becomes an internal port.
const formatsPlugin: unknown = addFormats;
if (typeof formatsPlugin !== 'function') throw new Error('JSON Schema formats SDK is not callable');
Object.values(drafts).forEach(ajv => Reflect.apply(formatsPlugin, undefined, [ajv]));

const validatorFor = (id: string): ValidateFunction<unknown> => {
  const cached = validators.get(id);
  if (cached) return cached;
  const definition = KERNEL_SCHEMA_DEFINITIONS.find(entry => entry.id === id);
  if (!definition) throw new KernelContractSchemaError(id, 'registry entry missing');
  if (definition.draft !== 'http://json-schema.org/draft-07/schema#'
    && definition.draft !== 'https://json-schema.org/draft/2020-12/schema') throw new KernelContractSchemaError(id, 'unsupported draft');
  const schema: unknown = JSON.parse(definition.schemaJson);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new KernelContractSchemaError(id, 'schema is not an object');
  const validator = drafts[definition.draft].compile<unknown>(schema);
  validators.set(id, validator);
  return validator;
};

/** Shape comes from the same schema as the generated DTO. Owners check meaning afterwards. */
export function parseKernelContract<K extends keyof KernelContractTypes>(id: K, input: unknown): KernelContractTypes[K] {
  const validate = validatorFor(id);
  if (!validate(input)) {
    const errors = (validate.errors || []).map(error => `${error.instancePath || '/'} ${error.message || error.keyword}`);
    throw new KernelContractSchemaError(id, errors.slice(0, 8).join('; '));
  }
  // Ajv checked this exact registry schema. No raw payload is included in errors.
  return input as KernelContractTypes[K];
}
