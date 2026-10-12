// Generated build tool. Edit the corresponding .ts source.
import { checkSafeOutput } from './source-graph.mjs';
import { readFile, writeFile, mkdir, lstat, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { compile } from 'json-schema-to-typescript';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const object = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Contract registry must contain objects');
    return value;
};
const registryEntries = (value) => {
    const registry = object(value);
    if (registry.schemaVersion !== 1 || !Array.isArray(registry.contracts))
        throw new Error('Unsupported contract registry');
    const ids = new Set();
    return registry.contracts.map((value) => {
        const entry = object(value);
        const field = (key) => {
            const value = entry[key];
            if (typeof value !== 'string' || !value)
                throw new Error('Contract registry field missing: ' + key);
            return value;
        };
        if (typeof entry.version !== 'number' || !Number.isInteger(entry.version) || entry.version < 1)
            throw new Error('Unsupported contract version');
        const result = {
            id: field('id'), schema: field('schema'), version: entry.version, owner: field('owner'),
            typeName: field('typeName'), generatedType: field('generatedType'),
            producer: field('producer'), consumer: field('consumer'), validator: field('validator'),
        };
        if (ids.has(result.id))
            throw new Error('Duplicate contract id: ' + result.id);
        ids.add(result.id);
        if (!/^schemas\/kernel\.[a-z.-]+\.schema\.json$/.test(result.schema)
            || !/^src\/contracts\/generated\/kernel\.[a-z.-]+\.ts$/.test(result.generatedType)
            || !/^Kernel[A-Za-z0-9]+$/.test(result.typeName))
            throw new Error('Invalid contract registry path/name');
        return result;
    });
};
/** Schema and generator output must agree before the ordinary TS emit starts. */
export async function buildContractArtifacts({ root, check = false }) {
    const registryPath = path.join(root, 'catalog/kernel-contracts.json');
    if (!existsSync(registryPath)) {
        if (existsSync(path.join(root, 'src/contracts/schema-codec.ts')))
            throw new Error('Contract registry missing');
        return { contracts: 0, changed: 0 };
    }
    await checkSafeOutput(root, 'catalog/kernel-contracts.json');
    await checkSafeOutput(root, 'src/contracts/generated');
    const entries = registryEntries(JSON.parse(await readFile(registryPath, 'utf8')));
    const schemaFiles = (await readdir(path.join(root, 'schemas'))).filter(file => /^kernel\..*\.schema\.json$/.test(file)).map(file => 'schemas/' + file);
    const registeredSchemas = new Set(entries.map(entry => entry.schema));
    if (schemaFiles.some(file => !registeredSchemas.has(file)))
        throw new Error('Unregistered canonical Kernel schema');
    const drafts = {
        'http://json-schema.org/draft-07/schema#': new Ajv({ strict: false, allErrors: true }),
        'https://json-schema.org/draft/2020-12/schema': new Ajv2020({ strict: false, allErrors: true }),
    };
    // ajv-formats exposes a CommonJS callable; NodeNext declares a module namespace.
    const formatsPlugin = addFormats;
    if (typeof formatsPlugin !== 'function')
        throw new Error('JSON Schema formats SDK is not callable');
    Object.values(drafts).forEach(ajv => Reflect.apply(formatsPlugin, undefined, [ajv]));
    const outputs = [];
    const definitions = [];
    const enums = {};
    for (const entry of entries) {
        await checkSafeOutput(root, entry.schema);
        if ((await lstat(path.join(root, entry.schema))).isSymbolicLink())
            throw new Error('Contract schema symlink refused');
        const schema = object(JSON.parse(await readFile(path.join(root, entry.schema), 'utf8')));
        const versionField = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
            ? object(schema.properties).schemaVersion : undefined;
        if (versionField && typeof versionField === 'object' && !Array.isArray(versionField)) {
            const literal = object(versionField).const;
            if (typeof literal === 'number' && literal !== entry.version)
                throw new Error('Registry schema version mismatch: ' + entry.id);
        }
        const draft = schema.$schema;
        if (draft !== 'http://json-schema.org/draft-07/schema#' && draft !== 'https://json-schema.org/draft/2020-12/schema')
            throw new Error('Unsupported JSON Schema draft');
        const ajv = drafts[draft];
        if (!ajv.validateSchema(schema))
            throw new Error('Invalid contract schema: ' + entry.schema);
        ajv.compile(schema);
        // The external generator accepts a draft-04 structural SDK type. Ajv has
        // checked the actual draft first; no network refs are allowed here.
        const text = await compile({ ...schema, title: entry.typeName }, entry.typeName, {
            cwd: path.join(root, 'schemas'), unknownAny: true, strictIndexSignatures: true,
            $refOptions: { resolve: { http: false } },
            bannerComment: '// Generated from ' + entry.schema + '. Edit the schema and run build:contracts.',
            style: { singleQuote: true, tabWidth: 2 },
        });
        outputs.push({ file: entry.generatedType, text });
        definitions.push({ id: entry.id, draft, schemaJson: JSON.stringify(schema) });
        const fields = {};
        const collectEnums = (value, prefix = '') => {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                return;
            const node = object(value);
            if (Array.isArray(node.enum) && node.enum.every((item) => typeof item === 'string' || item === null))
                fields[prefix] = node.enum.filter((item) => typeof item === 'string');
            if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
                for (const [name, child] of Object.entries(object(node.properties)))
                    collectEnums(child, prefix ? prefix + '.' + name : name);
            }
            for (const composition of ['anyOf', 'oneOf', 'allOf']) {
                const branches = node[composition];
                if (Array.isArray(branches))
                    for (const branch of branches)
                        collectEnums(branch, prefix);
            }
        };
        collectEnums(schema);
        enums[entry.id] = fields;
    }
    const imports = entries.map(entry => `import type { ${entry.typeName} } from './generated/${path.basename(entry.generatedType, '.ts')}.js';`).join('\n');
    outputs.push({ file: 'src/contracts/schema-definitions.generated.ts', text: '// Generated from catalog/kernel-contracts.json and canonical schemas.\n' + imports
            + '\nexport interface KernelContractTypes {\n' + entries.map(entry => `  '${entry.id}': ${entry.typeName};`).join('\n')
            + '\n}\nexport const KERNEL_SCHEMA_DEFINITIONS: readonly { id: string; draft: string; schemaJson: string }[] = ' + JSON.stringify(definitions, null, 2) + ';\n'
            + 'export const KERNEL_CONTRACT_ENUMS = ' + JSON.stringify(enums, null, 2) + ' as const;\n' });
    for (const output of outputs)
        await checkSafeOutput(root, output.file);
    let changed = 0;
    const generatedDirectory = path.join(root, 'src/contracts/generated');
    if (existsSync(generatedDirectory)) {
        const expected = new Set(entries.map(entry => path.basename(entry.generatedType)));
        for (const file of await readdir(generatedDirectory)) {
            if (expected.has(file))
                continue;
            const absolute = path.join(generatedDirectory, file);
            if ((await lstat(absolute)).isSymbolicLink())
                throw new Error('Generated contract symlink refused');
            if (!file.endsWith('.ts') || !(await readFile(absolute, 'utf8')).startsWith('// Generated from schemas/'))
                throw new Error('Unmanaged file in generated contract directory');
            if (check)
                throw new Error('Orphaned generated contract: ' + file);
            await unlink(absolute);
            changed++;
        }
    }
    for (const output of outputs) {
        const destination = path.join(root, output.file);
        let existing = null;
        try {
            existing = await readFile(destination, 'utf8');
        }
        catch (error) {
            if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
                throw error;
        }
        if (existing === output.text)
            continue;
        changed++;
        if (check)
            throw new Error('Generated contract drift: ' + output.file);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, output.text);
    }
    return { contracts: entries.length, changed };
}
