import type { ExecutionClass } from '../../src/kernel/run/execution-class.mjs';
import type { CapabilityContext } from '../../src/kernel/run/optional-capabilities.mjs';
import { executionClassForAction } from '../../src/kernel/run/execution-class.mjs';
import { resolveOptionalCapabilities } from '../../src/kernel/run/optional-capabilities.mjs';

const workload: ExecutionClass | null = executionClassForAction('implement', { complexity: 'complex' });
const context: CapabilityContext = { actionKind: 'implement', attempts: [{ status: 'failed' }], threshold: 3 };
resolveOptionalCapabilities(context);
void workload;
// @ts-expect-error A provider model name is not a Kernel execution class.
const invalidClass: ExecutionClass = 'provider-model';
// @ts-expect-error Attempts must be a list of attempt records.
const invalidContext: CapabilityContext = { attempts: 'failed' };
void invalidClass;
void invalidContext;
