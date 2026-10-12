import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface CommandObservation {
  commandRef?: string;
}

export interface RepositoryTopologyObservation {
  entrypoints?: unknown[];
  manifests?: unknown[];
  buildCommands?: CommandObservation[];
  testCommands?: CommandObservation[];
}

export interface TopologyProjectionOptions {
  observation?: RepositoryTopologyObservation | null;
  generatedAt?: string;
}

const commandRefs = (commands: CommandObservation[] | undefined): Array<string | undefined> => (
  Array.isArray(commands) ? commands.map((command) => command?.commandRef) : []
);

// Read-only project topology projection (§21.1). Repository facts are observed
// by the Host and passed in here. The projection is explicitly NOT an
// authority: the SQLite knowledge store remains canonical.
export const buildTopologyProjection = ({
  observation = null,
  generatedAt = new Date().toISOString(),
}: TopologyProjectionOptions = {}) => ({
  schemaVersion: 1,
  authority: false,
  kind: 'projection',
  generatedAt,
  entrypoints: Array.isArray(observation?.entrypoints) ? observation.entrypoints : [],
  manifests: Array.isArray(observation?.manifests) ? observation.manifests : [],
  buildCommands: commandRefs(observation?.buildCommands),
  testCommands: commandRefs(observation?.testCommands),
});

export const writeTopologyProjection = ({
  observation = null,
  outputDir,
}: TopologyProjectionOptions & { outputDir?: string } = {}) => {
  const projection = buildTopologyProjection({ observation });
  if (outputDir) {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      path.join(outputDir, 'topology.json'),
      JSON.stringify(projection, null, 2),
    );
  }
  return projection;
};
