// Generated from src/contracts/schema-codec.ts. Edit the source and run npm run build.
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { KERNEL_SCHEMA_DEFINITIONS } from './schema-definitions.generated.js';
export class KernelContractSchemaError extends Error {
    contractId;
    code = 'kernel_contract_schema_invalid';
    constructor(contractId, detail) {
        super(`Invalid Kernel contract ${contractId}: ${detail}`);
        this.contractId = contractId;
        this.name = 'KernelContractSchemaError';
    }
}
const validators = new Map();
const drafts = {
    'http://json-schema.org/draft-07/schema#': new Ajv({ strict: false, allErrors: true }),
    'https://json-schema.org/draft/2020-12/schema': new Ajv2020({ strict: false, allErrors: true }),
};
// CommonJS SDK callable is checked here; it never becomes an internal port.
const formatsPlugin = addFormats;
if (typeof formatsPlugin !== 'function')
    throw new Error('JSON Schema formats SDK is not callable');
Object.values(drafts).forEach(ajv => Reflect.apply(formatsPlugin, undefined, [ajv]));
const validatorFor = (id) => {
    const cached = validators.get(id);
    if (cached)
        return cached;
    const definition = KERNEL_SCHEMA_DEFINITIONS.find(entry => entry.id === id);
    if (!definition)
        throw new KernelContractSchemaError(id, 'registry entry missing');
    if (definition.draft !== 'http://json-schema.org/draft-07/schema#'
        && definition.draft !== 'https://json-schema.org/draft/2020-12/schema')
        throw new KernelContractSchemaError(id, 'unsupported draft');
    const schema = JSON.parse(definition.schemaJson);
    if (!schema || typeof schema !== 'object' || Array.isArray(schema))
        throw new KernelContractSchemaError(id, 'schema is not an object');
    const validator = drafts[definition.draft].compile(schema);
    validators.set(id, validator);
    return validator;
};
/** Shape comes from the same schema as the generated DTO. Owners check meaning afterwards. */
export function parseKernelContract(id, input) {
    const validate = validatorFor(id);
    if (!validate(input)) {
        const errors = (validate.errors || []).map(error => `${error.instancePath || '/'} ${error.message || error.keyword}`);
        throw new KernelContractSchemaError(id, errors.slice(0, 8).join('; '));
    }
    // Ajv checked this exact registry schema. No raw payload is included in errors.
    return input;
}
