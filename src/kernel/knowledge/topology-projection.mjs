import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scanRepositoryEvidence } from '../task/evidence-scan.mjs';

// Read-only project topology projection (§21.1). It is derived from the
// repository scan and is explicitly NOT an authority: the SQLite knowledge
// store remains canonical. This exists only as a convenient read surface.
export const buildTopologyProjection = ({ projectRoot = process.cwd() } = {}) => {
  const scan = scanRepositoryEvidence({ projectRoot });
  return {
    schemaVersion: 1,
    authority: false,
    kind: 'projection',
    generatedAt: new Date().toISOString(),
    entrypoints: scan.entrypoints,
    manifests: scan.manifests,
    buildCommands: scan.buildCommands.map((c) => c.commandRef),
    testCommands: scan.testCommands.map((c) => c.commandRef),
  };
};

export const writeTopologyProjection = ({ projectRoot = process.cwd(), outputDir } = {}) => {
  const projection = buildTopologyProjection({ projectRoot });
  if (outputDir) {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(path.join(outputDir, 'topology.json'), JSON.stringify(projection, null, 2));
  }
  return projection;
};
