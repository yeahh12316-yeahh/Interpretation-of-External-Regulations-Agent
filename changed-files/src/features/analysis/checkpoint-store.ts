import { AnalysisCheckpointSchema, type AnalysisCheckpoint } from "./skill-orchestrator";
import { projectDatabase } from "../projects/db";

/**
 * Persistence for analysis resume points. `runAnalysis` already validates a
 * resumed checkpoint against the execution-plan fingerprint and node list,
 * so this store only has to persist opaque checkpoints and drop anything
 * that no longer parses — a tampered or stale record must never surface.
 */

export const saveAnalysisCheckpoint = (
  projectId: string,
  checkpoint: AnalysisCheckpoint,
) =>
  projectDatabase.analysisCheckpoints.put({
    projectId,
    checkpoint,
    updatedAt: new Date().toISOString(),
  });

export const loadAnalysisCheckpoint = async (
  projectId: string,
): Promise<AnalysisCheckpoint | null> => {
  const record = await projectDatabase.analysisCheckpoints.get(projectId);
  if (!record) return null;
  const parsed = AnalysisCheckpointSchema.safeParse(record.checkpoint);
  if (!parsed.success) {
    // Fail closed: an unreadable resume point is discarded, not resumed.
    await projectDatabase.analysisCheckpoints.delete(projectId);
    return null;
  }
  return parsed.data;
};

export const deleteAnalysisCheckpoint = (projectId: string) =>
  projectDatabase.analysisCheckpoints.delete(projectId);
