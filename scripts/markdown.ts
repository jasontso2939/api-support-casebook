// A small Markdown renderer: enough for the ticket write-ups and the playbook.
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function inline(s: string): string {
  const codes: string[] = [];
  let out = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  out = esc(out)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

function codeBlock(lang: string, body: string): string {
  if (lang === 'diff') {
    const lines = body.split('\n').map(l => {
      const cls = l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
      return `<span class="${cls}">${esc(l) || ' '}</span>`;
    });
    return `<pre class="code diff">${lines.join('\n')}</pre>`;
  }
  if (lang === 'triage') {
    const lines = body.split('\n').map(l => {
      const cls = /^\s+\[high\]/.test(l) ? 'hi' : /^\s+\[medium\]|^\s+\[low\]/.test(l) ? 'med' : /^(ENDPOINT|ERRORS|FINDINGS)/.test(l) ? 'hd' : /^\s+next:/.test(l) ? 'nx' : /^\s+evidence:/.test(l) ? 'ev' : '';
      return `<span class="${cls}">${esc(l) || ' '}</span>`;
    });
    return `<div class="term"><div class="term-bar"><i></i><i></i><i></i><span>$ npm run triage</span></div><pre>${lines.join('\n')}</pre></div>`;
  }
  return `<pre class="code">${esc(body)}</pre>`;
}

function table(rows: string[]): string {
  const cells = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  return `<div class="tbl"><table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export function render(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const fence = l.match(/^```(\w*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      out.push(codeBlock(fence[1], body.join('\n')));
      continue;
    }
    const h = l.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const slug = h[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      out.push(`<h${h[1].length} id="${slug}">${inline(h[2])}</h${h[1].length}>`); i++; continue;
    }
    if (l.startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      out.push(table(rows)); continue;
    }
    if (l.startsWith('>')) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${render(q.join('\n'))}</blockquote>`); continue;
    }
    if (/^(- |\d+\. )/.test(l)) {
      const ordered = /^\d+\. /.test(l);
      const items: string[] = [];
      while (i < lines.length && /^(- |\d+\. )/.test(lines[i])) {
        let item = lines[i++].replace(/^(- |\d+\. )/, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`); continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#|\||>|- |\d+\. )/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

/** Line diff (LCS) as a unified-style hunk with full context. */
export function diff(a: string, b: string, labelA: string, labelB: string): string {
  const x = a.split('\n'), y = b.split('\n');
  const n = x.length, m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { out.push(' ' + x[i]); i++; j++; }
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { out.push('-' + x[i]); i++; }
    else { out.push('+' + y[j]); j++; }
  }
  return out.join('\n');
}
