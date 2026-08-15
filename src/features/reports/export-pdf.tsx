import {
  Document as PdfDocument,
  Font,
  Page,
  StyleSheet,
  Text,
  View,
  pdf,
} from "@react-pdf/renderer";

import sourceHanSansUrl from "../../assets/SourceHanSans-Normal.otf?url";
import type { ReportEvidence, ReportModel } from "./report-model";

const FONT_FAMILY = "SourceHanSansLocal";
const testWorkingDirectory = (
  globalThis as typeof globalThis & {
    process?: { cwd: () => string };
  }
).process?.cwd();
const fontSource =
  import.meta.env?.MODE === "test" && testWorkingDirectory
    ? `${testWorkingDirectory}/src/assets/SourceHanSans-Normal.otf`
    : sourceHanSansUrl;
let registered = false;

const registerFont = (): void => {
  if (registered) return;
  Font.register({ family: FONT_FAMILY, src: fontSource });
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
};

const assertExportable = (report: ReportModel): void => {
  if (!report.authoritativeParsing)
    throw new Error("权威解析未通过，不能导出报告");
  const serialized = JSON.stringify(report);
  if (
    /"(?:apiKey|authorization|endpoint|credential|sessionSecret)"\s*:/iu.test(
      serialized,
    ) ||
    /(?:\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b|Bearer\s+\S+|session[-_ ]?secret)/iu.test(
      serialized,
    )
  )
    throw new Error("报告模型包含不允许导出的凭据字段");
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 58,
    paddingRight: 58,
    paddingBottom: 54,
    paddingLeft: 58,
    color: "#111111",
    fontFamily: FONT_FAMILY,
    fontSize: 10.5,
    lineHeight: 1.45,
  },
  runningHeader: {
    position: "absolute",
    top: 22,
    left: 58,
    right: 58,
    paddingBottom: 5,
    borderBottomWidth: 1,
    borderBottomColor: "#86BC25",
    fontSize: 8.5,
    color: "#555555",
  },
  watermark: {
    position: "absolute",
    top: 36,
    left: 58,
    right: 58,
    textAlign: "center",
    color: "#5F861B",
    fontSize: 13,
  },
  title: { marginTop: 18, marginBottom: 5, fontSize: 23, color: "#111111" },
  subtitle: { marginBottom: 14, fontSize: 13, color: "#555555" },
  metadata: {
    marginBottom: 14,
    paddingTop: 8,
    paddingRight: 10,
    paddingBottom: 8,
    paddingLeft: 10,
    borderLeftWidth: 4,
    borderLeftColor: "#86BC25",
    backgroundColor: "#F2F4F1",
    fontSize: 9,
  },
  metadataLine: { marginBottom: 2 },
  section: { marginTop: 12 },
  sectionTitle: { marginBottom: 6, fontSize: 15, color: "#111111" },
  empty: { color: "#666666" },
  item: {
    marginBottom: 7,
    paddingLeft: 9,
    borderLeftWidth: 2,
    borderLeftColor: "#86BC25",
  },
  itemLabel: { marginBottom: 2, color: "#4E7116", fontSize: 8.5 },
  evidence: { marginTop: 2, color: "#555555", fontSize: 8 },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 58,
    right: 58,
    textAlign: "right",
    color: "#777777",
    fontSize: 8,
  },
});

const evidenceText = (evidence: ReportEvidence): string => {
  const locator = [
    evidence.page === null ? null : `第${evidence.page}页`,
    evidence.article,
    `第${evidence.paragraphIndex + 1}段`,
  ]
    .filter(Boolean)
    .join(" / ");
  return `${evidence.sourceLabel}｜${evidence.sourceTitle}｜${evidence.sourceId}｜${locator}｜${evidence.quote}`;
};

export const ReportPdfDocument = ({ report }: { report: ReportModel }) => (
  <PdfDocument
    title={report.title}
    author="外规解读agent"
    subject={`${report.projectName} ${report.reviewStatusLabel}`}
    keywords="外规解读,证据索引,人工复核"
  >
    <Page size="LETTER" style={styles.page}>
      <Text fixed style={styles.runningHeader}>
        外规解读agent ｜ {report.title} ｜ {report.projectVersion}
      </Text>
      {report.watermark ? (
        <Text fixed style={styles.watermark}>
          {report.watermark}
        </Text>
      ) : null}
      <Text style={styles.title}>{report.title}</Text>
      <Text style={styles.subtitle}>{report.projectName}</Text>
      <View style={styles.metadata}>
        <Text style={styles.metadataLine}>成果类型：{report.title}</Text>
        <Text style={styles.metadataLine}>
          项目版本：{report.projectVersion}
        </Text>
        <Text style={styles.metadataLine}>生成时间：{report.generatedAt}</Text>
        <Text style={styles.metadataLine}>
          复核状态：{report.reviewStatusLabel}
        </Text>
        <Text>
          来源清单：
          {report.sources
            .map(({ sourceLabel, title }) => `${sourceLabel}：${title}`)
            .join("；")}
        </Text>
      </View>
      {report.sections.map((section) => (
        <View key={section.key} style={styles.section}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          {section.items.length ? (
            section.items.map((item) => (
              <View key={item.itemId} style={styles.item}>
                <Text style={styles.itemLabel}>
                  {item.claimLabel} ｜ {item.findingId}
                </Text>
                <Text>{item.text}</Text>
                {item.evidence.map((evidence, index) => (
                  <Text
                    key={`${item.itemId}:evidence:${index}`}
                    style={styles.evidence}
                  >
                    依据：{evidenceText(evidence)}
                  </Text>
                ))}
                {item.revisions.map((revision, index) => (
                  <Text
                    key={`${item.itemId}:revision:${index}`}
                    style={styles.evidence}
                  >
                    修订：{revision.reviewer}｜{revision.reviewedAt}｜
                    {revision.reason}
                  </Text>
                ))}
              </View>
            ))
          ) : (
            <Text style={styles.empty}>本节无可纳入的已验证结论。</Text>
          )}
        </View>
      ))}
      <Text
        fixed
        style={styles.footer}
        render={({ pageNumber, totalPages }) =>
          `${report.projectName} ｜ 第 ${pageNumber} / ${totalPages} 页`
        }
      />
    </Page>
  </PdfDocument>
);

export const exportPdf = async (report: ReportModel): Promise<Blob> => {
  assertExportable(report);
  registerFont();
  return pdf(<ReportPdfDocument report={report} />).toBlob();
};
