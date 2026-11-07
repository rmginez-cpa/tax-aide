import { Fragment, type ReactNode } from "react";
import { Link } from "wouter";

// A deliberately small Markdown renderer for assistant answers: paragraphs,
// headings, lists, pipe tables, **bold**, *italic*, `code` and links. It builds
// React elements (never innerHTML), so model output cannot inject markup.
// Internal links (/clients/12) navigate in-app; other links open in a new tab.

/**
 * An in-app path: "/" then a plain path character (never a second "/" or a backslash, which
 * browsers read as "//host", i.e. another site), and only URL-safe characters after it.
 */
const INTERNAL_HREF = /^\/(?![\/\\])[A-Za-z0-9\/_?=&.%#~+-]*$/;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={key} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const [, label, href] = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      if (INTERNAL_HREF.test(href)) {
        out.push(<Link key={key} href={href} className="text-primary underline underline-offset-2">{label}</Link>);
      } else if (/^https?:\/\//i.test(href)) {
        out.push(<a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">{label}</a>);
      } else {
        out.push(label);
      }
    } else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${k++}`;
    if (!line.trim()) { i++; continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push(<p key={key} className="font-semibold mt-1">{inline(h[2], key)}</p>);
      i++;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key} className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>{head.map((c, j) => <th key={j} className="border-b px-2 py-1 text-left font-semibold">{inline(c, `${key}h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, j) => <td key={j} className="border-b px-2 py-1 align-top">{inline(c, `${key}r${ri}c${j}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const listRe = /^\s*([-*]|\d+[.)])\s+(.*)$/;
    if (listRe.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && listRe.test(lines[i]) && /^\s*\d/.test(lines[i]) === ordered) items.push(lines[i++].match(listRe)![2]);
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={key} className={`${ordered ? "list-decimal" : "list-disc"} pl-5 space-y-0.5`}>
          {items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>)}
        </Tag>,
      );
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !listRe.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push(
      <p key={key}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, `${key}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="space-y-2 break-words">{blocks}</div>;
}
