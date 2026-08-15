import { impactDimensionTitle, type ReportModel } from "./report-model";

export const ReportPreview = ({ report }: { report: ReportModel }) => (
  <article className="report-preview" aria-labelledby="report-preview-title">
    {report.watermark ? (
      <p className="report-watermark" aria-label="草稿水印">
        {report.watermark}
      </p>
    ) : null}
    <header className="report-preview-header">
      <p className="report-product-title">外规解读agent</p>
      <h2 id="report-preview-title">{report.title}</h2>
      <p>{report.projectName}</p>
      <dl className="report-metadata">
        <div>
          <dt>成果类型</dt>
          <dd>{report.title}</dd>
        </div>
        <div>
          <dt>项目版本</dt>
          <dd>{report.projectVersion}</dd>
        </div>
        <div>
          <dt>生成时间</dt>
          <dd>{report.generatedAt}</dd>
        </div>
        <div>
          <dt>复核状态</dt>
          <dd>{report.reviewStatusLabel}</dd>
        </div>
      </dl>
      <p>
        来源清单：
        {report.sources
          .map(({ sourceLabel, title }) => `${sourceLabel}：${title}`)
          .join("；")}
      </p>
    </header>
    {report.sections.map((section, index) => (
      <section key={section.key} className="report-section">
        <h3>
          {index + 1}. {section.title}
        </h3>
        {section.groups ? (
          <div className="report-dimension-groups">
            {section.groups.map((group) => (
              <section key={group.dimension} aria-label={`${group.title}维度`}>
                <h4>{group.title}</h4>
                {group.items.length ? (
                  <ul>
                    {group.items.map((item) => (
                      <li key={item.itemId}>
                        <p>
                          <span className="report-claim-label">
                            {item.claimLabel}
                          </span>
                          {item.text}
                        </p>
                        <details>
                          <summary>查看证据与修订留痕</summary>
                          {item.evidence.map((evidence, evidenceIndex) => (
                            <blockquote
                              key={`${item.itemId}:evidence:${evidenceIndex}`}
                            >
                              <strong>{evidence.sourceLabel}</strong>｜
                              {evidence.sourceTitle}｜
                              {evidence.page === null
                                ? "无页码"
                                : `第${evidence.page}页`}
                              ｜{evidence.article ?? "无条款"}｜第
                              {evidence.paragraphIndex + 1}段：
                              {evidence.quote}
                            </blockquote>
                          ))}
                        </details>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="report-empty">该维度无可纳入的已验证结论。</p>
                )}
              </section>
            ))}
          </div>
        ) : section.items.length ? (
          <ul>
            {section.items.map((item) => (
              <li key={item.itemId}>
                <p>
                  <span className="report-claim-label">{item.claimLabel}</span>
                  {item.dimension ? (
                    <span>【{impactDimensionTitle(item.dimension)}维度】</span>
                  ) : null}
                  {item.text}
                </p>
                <details>
                  <summary>查看证据与修订留痕</summary>
                  {item.evidence.map((evidence, evidenceIndex) => (
                    <blockquote
                      key={`${item.itemId}:evidence:${evidenceIndex}`}
                    >
                      <strong>{evidence.sourceLabel}</strong>｜
                      {evidence.sourceTitle}｜
                      {evidence.page === null
                        ? "无页码"
                        : `第${evidence.page}页`}
                      ｜{evidence.article ?? "无条款"}｜第
                      {evidence.paragraphIndex + 1}
                      段：{evidence.quote}
                    </blockquote>
                  ))}
                  {item.revisions.map((revision, revisionIndex) => (
                    <p key={`${item.itemId}:revision:${revisionIndex}`}>
                      修订：{revision.reviewer}｜{revision.reviewedAt}｜
                      {revision.reason}
                    </p>
                  ))}
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="report-empty">本节无可纳入的已验证结论。</p>
        )}
      </section>
    ))}
  </article>
);
