import { useState } from "react";
import { createRoot } from "react-dom/client";

import type { Finding } from "../../../domain/finding";
import type { SourceUnit } from "../../../domain/source";
import type { ParsedSourceUnit } from "../../parsing/build-anchors";
import "../../../styles/tokens.css";
import "../../../styles/global.css";
import { EvidencePanel } from "../EvidencePanel";

const sources: SourceUnit[] = [
  {
    sourceId: "SYNTHETIC-REG",
    sourceType: "regulatory_text",
    title: "合成监管材料.pdf",
    content: "第七条 机构应当保留记录。",
  },
  {
    sourceId: "SYNTHETIC-OFFICIAL",
    sourceType: "official_interpretation",
    title: "合成官方解读.pdf",
    content: "第十八条 官方解读说明不得删除记录。",
  },
];

const parsedUnits: ParsedSourceUnit[] = [
  {
    sourceId: "SYNTHETIC-REG",
    sourceType: "regulatory_text",
    page: 7,
    article: "第七条",
    paragraphIndex: 0,
    text: "第七条 机构应当保留记录。",
    extractionMethod: "text_layer",
    confidence: 1,
  },
  {
    sourceId: "SYNTHETIC-OFFICIAL",
    sourceType: "official_interpretation",
    page: 18,
    article: "第十八条",
    paragraphIndex: 0,
    text: "第十八条 官方解读说明不得删除记录。",
    extractionMethod: "text_layer",
    confidence: 1,
  },
];

const findings: Finding[] = parsedUnits.map((unit, index) => ({
  findingId: `F${index + 1}`,
  category:
    index === 0 ? "atomic_requirement" : "official_context:policy_background",
  statement:
    index === 0
      ? "机构应当保留记录。"
      : "官方解读材料摘录（政策背景）：“官方解读说明不得删除记录。”。该摘录仅作为官方说明材料，不建立或覆盖监管文件效力、适用性或其他法律结论，须经人工合规复核。",
  claimType: index === 0 ? "regulatory_fact" : "official_explanation",
  sourceAnchors: [
    {
      sourceId: unit.sourceId,
      sourceType: unit.sourceType,
      page: unit.page,
      article: unit.article,
      paragraphIndex: unit.paragraphIndex,
      quote: index === 0 ? "机构应当保留记录。" : "官方解读说明不得删除记录。",
    },
  ],
  inferenceParents: index === 0 ? [] : ["F1"],
  reviewStatus: "unreviewed",
  requiredReview: true,
  revisionRecords: [],
}));

const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
const correctOfficialPairing = {
  "SYNTHETIC-OFFICIAL": ["SYNTHETIC-REG"],
} as const;
const harnessMappingsValid =
  parsedUnits.every(
    (unit) => sourceById.get(unit.sourceId)?.sourceType === unit.sourceType,
  ) &&
  findings.every((finding) =>
    finding.sourceAnchors.every(
      (anchor) =>
        sourceById.get(anchor.sourceId)?.sourceType === anchor.sourceType,
    ),
  ) &&
  correctOfficialPairing["SYNTHETIC-OFFICIAL"][0] === "SYNTHETIC-REG";
if (!harnessMappingsValid) {
  throw new Error(
    "EvidencePanel test harness source mappings are inconsistent",
  );
}
document.documentElement.dataset.harnessMappings = "valid";

function Harness() {
  const [selectedFindingId, setSelectedFindingId] = useState("F1");
  const [officialPrimarySourceIds, setOfficialPrimarySourceIds] = useState<
    typeof correctOfficialPairing | undefined
  >(correctOfficialPairing);
  return (
    <main
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 40%)",
        gap: "1rem",
        maxWidth: "100%",
        padding: "1rem",
      }}
    >
      <section style={{ minWidth: 0 }}>
        <h1>合成结论</h1>
        <button onClick={() => setSelectedFindingId("F1")} type="button">
          选择结论 F1
        </button>
        <button onClick={() => setSelectedFindingId("F2")} type="button">
          选择结论 F2
        </button>
        <button
          onClick={() => setOfficialPrimarySourceIds(undefined)}
          type="button"
        >
          移除官方配对
        </button>
        <button
          onClick={() => setOfficialPrimarySourceIds(correctOfficialPairing)}
          type="button"
        >
          恢复官方配对
        </button>
      </section>
      <EvidencePanel
        findings={findings}
        officialPrimarySourceIds={officialPrimarySourceIds}
        parsedUnits={parsedUnits}
        selectedFindingId={selectedFindingId}
        sources={sources}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
