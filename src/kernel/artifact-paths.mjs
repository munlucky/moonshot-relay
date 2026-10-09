import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveKernelRuntimeHome } from './runtime-home.mjs';

const safeIdentity = (value, label) => {
  const identity = String(value || '');
  if (!identity) {
    throw new Error(`artifact_path_invalid:${label}`);
  }
  return identity;
};

const encodedSegment = (value, label) => {
  const identity = safeIdentity(value, label);
  return `${label}-${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
};

export const projectRunArtifactRoot = ({ runtimeHome = resolveKernelRuntimeHome(), projectId, runId } = {}) =>
  path.join(path.resolve(runtimeHome), 'state', 'projects', encodedSegment(projectId, 'project'), 'runs', encodedSegment(runId, 'run'));

export const resolveRunArtifactPaths = ({ runtimeHome, projectId, runId } = {}) => {
  const root = projectRunArtifactRoot({ runtimeHome, projectId, runId });
  return {
    root,
    identity: {
      projectId: safeIdentity(projectId, 'projectId'),
      runId: safeIdentity(runId, 'runId'),
      projectSegment: encodedSegment(projectId, 'project'),
      runSegment: encodedSegment(runId, 'run'),
    },
    contract: path.join(root, 'contract.json'),
    projections: path.join(root, 'projections'),
    evidence: path.join(root, 'evidence'),
    receipts: path.join(root, 'receipts'),
    finalization: path.join(root, 'finalization'),
    legacy: {
      projections: path.join(path.resolve(runtimeHome), 'projections', String(runId)),
      evidence: path.join(path.resolve(runtimeHome), 'evidence', String(runId)),
    },
  };
};
