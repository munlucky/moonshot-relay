import { loadAllProjectRecords } from './store.mjs';

export async function resolveTacitPractices({ projectId, env = process.env } = {}) {
  const records = await loadAllProjectRecords(projectId, { env });
  const observations = records.observations || [];

  // Group by statement fingerprint
  const groups = new Map();
  for (const obs of observations) {
    const key = obs.statement.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(obs);
  }

  const tacitPractices = [];
  for (const [key, obsList] of groups.entries()) {
    const distinctRuns = new Set(obsList.map((o) => o.runId).filter(Boolean));
    const hasVerification = obsList.some((o) => o.status === 'verified' || o.evidence);

    // Reusable tacit practice requires >= 2 distinct runs and at least 1 verification
    if (distinctRuns.size >= 2 && hasVerification) {
      tacitPractices.push({
        id: `tacit-${tacitPractices.length + 1}`,
        statement: obsList[0].statement,
        confidence: Math.min(1.0, 0.5 + distinctRuns.size * 0.2),
        observedRuns: Array.from(distinctRuns),
      });
    }
  }

  return tacitPractices;
}
