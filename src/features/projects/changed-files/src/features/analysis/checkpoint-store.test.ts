import "fake-indexeddb/auto";

import { afterEach, expect, test } from "vitest";

import { projectDatabase } from "../projects/db";
import {
  deleteAnalysisCheckpoint,
  loadAnalysisCheckpoint,
  saveAnalysisCheckpoint,
} from "./checkpoint-store";
import type { AnalysisCheckpoint } from "./skill-orchestrator";

afterEach(async () => {
  await projectDatabase.analysisCheckpoints.clear();
});

const minimalCheckpoint = (
  overrides: {
    model?: string;
    withRun?: boolean;
  } = {},
): AnalysisCheckpoint => {
  const run = {
    nodeId: "node-1",
    stage: "document_identity" as const,
    chunkId: "C1",
    model: overrides.model ?? "test-model",
    promptVersion: "v1",
    inputSourceIds: ["SRC-A"],
    responseHash: "a".repeat(64),
    outputHash: "b".repeat(64),
    scopeHash: "c".repeat(64),
    findingIds: [],
    atomicRequirementIds: [],
    inferenceRelationshipIds: [],
    conflictIds: [],
  };
  return {
    checkpointVersion: 2,
    inputFingerprint: "d".repeat(64),
    model: overrides.model ?? "test-model",
    hasOfficialInterpretation: false,
    findings: [],
    atomicRequirements: [],
    inferenceRelationships: [],
    conflicts: [],
    runs: overrides.withRun === false ? [] : [run],
    limitations: [],
    lastSuccessfulNode: overrides.withRun === false ? null : "node-1",
  } as unknown as AnalysisCheckpoint;
};

test("round-trips a checkpoint keyed by project", async () => {
  await saveAnalysisCheckpoint("P1", minimalCheckpoint());

  const stored = await loadAnalysisCheckpoint("P1");
  expect(stored).not.toBeNull();
  expect(stored?.lastSuccessfulNode).toBe("node-1");
  expect(await loadAnalysisCheckpoint("P2")).toBeNull();
});

test("saving again replaces the previous resume point", async () => {
  await saveAnalysisCheckpoint("P1", minimalCheckpoint());
  await saveAnalysisCheckpoint(
    "P1",
    minimalCheckpoint({ model: "replacement-model", withRun: false }),
  );

  expect(await projectDatabase.analysisCheckpoints.count()).toBe(1);
  expect((await loadAnalysisCheckpoint("P1"))?.model).toBe(
    "replacement-model",
  );
});

test("a corrupted stored checkpoint is dropped instead of trusted", async () => {
  await saveAnalysisCheckpoint("P1", { garbage: true } as never);
  expect(await loadAnalysisCheckpoint("P1")).toBeNull();
  expect(await projectDatabase.analysisCheckpoints.count()).toBe(0);
});

test("deleting removes the resume point", async () => {
  await saveAnalysisCheckpoint("P1", minimalCheckpoint());
  await deleteAnalysisCheckpoint("P1");
  expect(await loadAnalysisCheckpoint("P1")).toBeNull();
});
