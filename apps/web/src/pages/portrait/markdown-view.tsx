import { InlineText } from "../../components/ui.js";
import { Icon } from "../../components/icons.js";
import { parsePortraitMarkdown, type MarkdownBlock } from "../../lib/markdown.js";

function alignOf(align: ReadonlyArray<"left" | "center" | "right">, index: number): "left" | "center" | "right" {
  return align[index] ?? "left";
}

function BlockView({ block }: { block: MarkdownBlock }) {
  if (block.kind === "heading") {
    const Tag = block.level === 1 ? "h1" : block.level === 2 ? "h2" : "h3";
    return (
      <Tag id={block.id}>
        <InlineText text={block.text} />
      </Tag>
    );
  }
  if (block.kind === "list" && block.checks && block.checks.length === block.items.length) {
    const checks = block.checks;
    return (
      <ul className="portrait-tasks">
        {block.items.map((item, index) => (
          <li key={index} className="portrait-task">
            <span className="portrait-check" data-checked={checks[index] ? "true" : "false"} aria-hidden="true">
              {checks[index] ? <Icon name="check" size={12} /> : null}
            </span>
            <span>
              <InlineText text={item} />
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (block.kind === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return (
      <Tag>
        {block.items.map((item, index) => (
          <li key={index}>
            <InlineText text={item} />
          </li>
        ))}
      </Tag>
    );
  }
  if (block.kind === "quote") {
    const lines = block.text.split("\n");
    return (
      <blockquote>
        {lines.map((line, index) => (
          <p key={index}>
            <InlineText text={line} />
          </p>
        ))}
      </blockquote>
    );
  }
  if (block.kind === "code") {
    return (
      <pre>
        <code {...(block.lang ? { "data-lang": block.lang } : {})}>{block.text}</code>
      </pre>
    );
  }
  if (block.kind === "table") {
    return (
      <div className="portrait-table-wrap">
        <table>
          <thead>
            <tr>
              {block.header.map((cell, index) => (
                <th key={index} data-align={alignOf(block.align, index)}>
                  <InlineText text={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, index) => (
                  <td key={index} data-align={alignOf(block.align, index)}>
                    <InlineText text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.kind === "rule") return <hr />;
  return (
    <p className={block.meta ? "portrait-meta" : undefined}>
      <InlineText text={block.text} />
    </p>
  );
}

export function PortraitMarkdown({ source }: { source: string }) {
  const blocks = parsePortraitMarkdown(source);
  if (blocks.length === 0) return null;
  return (
    <div className="portrait-prose">
      {blocks.map((block, index) => (
        <BlockView key={`${block.kind}-${index}`} block={block} />
      ))}
    </div>
  );
}
