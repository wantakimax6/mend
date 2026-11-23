// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, and whether it ends with a break. */
interface Doc {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.finalBr ? d.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** One line compared at a tier: 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(lines: string[], old: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

interface Found {
  tier: number;
  positions: number[];
}

/** The first tier at which `old` occurs in `lines` (at or after `from`), or null. */
function findTier(lines: string[], old: string[], strict: boolean, from = 0): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrencesAt(lines, old, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** A new line at tier 2, re-indented from O's first line to the file's first matched line. */
function reindent(line: string, tier: number, p: string, f: string): string {
  if (tier !== 2) return line;
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** One body line of a unified hunk or a V4A chunk: context, old or new. */
type BodyKind = 'ctx' | 'old' | 'new';
interface BodyEntry {
  kind: BodyKind;
  text: string;
  /** A `\` line followed this entry (no line break after it). */
  noNL: boolean;
}

/** A hunk or chunk: its body entries (`a` is a unified hunk's old start line). */
interface Hunk {
  a: number;
  entries: BodyEntry[];
}

/** The old lines O of a hunk: its context and `-` lines, in body order. */
function hunkOld(h: Hunk): string[] {
  return h.entries.filter((e) => e.kind !== 'new').map((e) => e.text);
}

/** A piece of the new lines N: a context line (taken from the file) or a `+` line. */
interface NPart {
  ctx: boolean;
  text: string;
  /** Where this context line sits inside O. */
  oIndex: number;
}

function hunkNew(h: Hunk): NPart[] {
  const parts: NPart[] = [];
  let oIndex = 0;
  for (const e of h.entries) {
    if (e.kind === 'ctx') {
      parts.push({ ctx: true, text: e.text, oIndex });
      oIndex += 1;
    } else if (e.kind === 'new') {
      parts.push({ ctx: false, text: e.text, oIndex: -1 });
    } else {
      oIndex += 1;
    }
  }
  return parts;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkLastNoNL(h: Hunk): boolean {
  for (let i = h.entries.length - 1; i >= 0; i--) {
    const e = h.entries[i]!;
    if (e.kind === 'ctx' || e.kind === 'new') return e.noNL;
  }
  return false;
}

/** The replacement lines for a hunk matched at `pos` at `tier`. */
function hunkReplacement(fileLines: string[], pos: number, tier: number, h: Hunk): string[] {
  const o = hunkOld(h);
  const p = leadingWs(o[0]!);
  const f = leadingWs(fileLines[pos]!);
  return hunkNew(h).map((part) => (part.ctx ? fileLines[pos + part.oIndex]! : reindent(part.text, tier, p, f)));
}

/** Apply one unified hunk to a file; `d` is the length drift of earlier hunks. */
function applyHunk(doc: Doc, h: Hunk, d: number, strict: boolean, path: string): void {
  const o = hunkOld(h);
  if (o.length > 0) {
    const found = findTier(doc.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.positions[0]!;
    for (const q of found.positions) {
      if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
    }
    const atEnd = pos + o.length === doc.lines.length;
    const repl = hunkReplacement(doc.lines, pos, found.tier, h);
    doc.lines.splice(pos, o.length, ...repl);
    if (atEnd) doc.finalBr = !hunkLastNoNL(h);
  } else {
    const ins = Math.max(0, Math.min(h.a + d, doc.lines.length));
    const atEnd = ins === doc.lines.length;
    const repl = hunkNew(h).map((part) => part.text);
    doc.lines.splice(ins, 0, ...repl);
    if (atEnd) doc.finalBr = !hunkLastNoNL(h);
  }
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A move an edit made, so the output can print an `R` line for it. */
interface Move {
  from: string;
  to: string;
}

type Edit = (tree: Tree) => Move | undefined;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A `diff --git` line (exactly that, or followed by a space). */
function isGitLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

/** Parse a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function gitPaths(line: string): [string, string] | null {
  const parts = line.slice('diff --git '.length).split(' ');
  if (parts.length !== 2) return null;
  if (!parts[0]!.startsWith('a/') || !parts[1]!.startsWith('b/')) return null;
  return [parts[0]!.slice(2), parts[1]!.slice(2)];
}

/** Parse a `--- ` / `+++ ` path: after the four characters, up to the first tab, trimmed, `a/`/`b/` off; `/dev/null` is null. */
function diffPath(line: string): string | null {
  const p = line.slice(4).split('\t')[0]!.trim();
  const q = p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
  return q === '/dev/null' ? null : q;
}

/** A unified section: its paths (undefined: not named that way) and its hunks. */
interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The old start line A of a `@@ -A[,B] +C[,D] @@` header, or null when malformed. */
function hunkStart(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m === null ? null : Number(m[1]);
}

/** The `+` lines of every hunk of a section, in order. */
function plusLines(hunks: Hunk[]): BodyEntry[] {
  const out: BodyEntry[] = [];
  for (const h of hunks) {
    for (const e of h.entries) if (e.kind === 'new') out.push(e);
  }
  return out;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const startSection = (gitOld: string | null, gitNew: string | null): void => {
    cur = { gitOld, gitNew, pairOld: undefined, pairNew: undefined, renameFrom: undefined, renameTo: undefined, isCreate: false, isDelete: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (isGitLine(line)) {
      const paths = gitPaths(line);
      if (paths === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(paths[0], paths[1]);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.pairOld = diffPath(line);
        cur.pairNew = diffPath(lines[i + 1]!);
      } else {
        startSection(null, null);
        cur!.pairOld = diffPath(line);
        cur!.pairNew = diffPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && inHeader) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = hunkStart(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      i += 1;
      const entries: BodyEntry[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (isGitLine(b)) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          entries.push({
            kind: b === '' || b.startsWith(' ') ? 'ctx' : b.startsWith('-') ? 'old' : 'new',
            text: b === '' ? '' : b.slice(1),
            noNL: false,
          });
          i += 1;
          continue;
        }
        if (b.startsWith('\\')) {
          if (entries.length > 0) entries[entries.length - 1]!.noNL = true;
          i += 1;
          continue;
        }
        break;
      }
      while (entries.length > 0) {
        const last = entries[entries.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') entries.pop();
        else break;
      }
      cur.hunks.push({ a, entries });
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldPath = s.pairOld !== undefined ? s.pairOld : s.renameFrom !== undefined ? s.renameFrom : s.gitOld;
    const newPath = s.pairNew !== undefined ? s.pairNew : s.renameTo !== undefined ? s.renameTo : s.gitNew;
    const isCreate = oldPath === null || s.isCreate;
    const isDelete = !isCreate && (newPath === null || s.isDelete);
    edits.push((tree) => {
      if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (isCreate) {
        if (newPath === null) return undefined;
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const plus = plusLines(s.hunks);
        const text = plus.length === 0 ? '' : plus.map((e) => e.text).join('\n') + (plus[plus.length - 1]!.noNL ? '' : '\n');
        tree.now.set(newPath, text);
        return undefined;
      }
      if (isDelete) {
        const target = oldPath!;
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
        return undefined;
      }
      const from = oldPath!;
      const to = newPath!;
      const curText = tree.get(from);
      if (curText === null) throw new Fail('missing', from);
      if (from !== to && tree.get(to) !== null) throw new Fail('exists', to);
      const doc = parseDoc(curText);
      let d = 0;
      for (const h of s.hunks) {
        applyHunk(doc, h, d, strict, from);
        d += hunkNew(h).length - hunkOld(h).length;
      }
      const text = writeDoc(doc);
      if (from !== to) {
        tree.now.set(to, text);
        tree.now.set(from, null);
        return { from, to };
      }
      tree.now.set(from, text);
      return undefined;
    });
  }
  return edits;
}

/** One SEARCH/REPLACE block. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return undefined;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = parseDoc(cur);
    const found = findTier(doc.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const repl = newLines.map((l) => reindent(l, found.tier, leadingWs(oldLines[0]!), leadingWs(doc.lines[pos]!)));
    doc.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, writeDoc(doc));
    return undefined;
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let end = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (eq < 0 || end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/** One V4A chunk: an optional anchor, body entries, and whether it ends the file. */
interface VChunk extends Hunk {
  anchor: string | null;
  endOfFile: boolean;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseDoc(cur);
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        for (const t of tiers) {
          for (let k = cursor; k < doc.lines.length; k++) {
            if (normLine(doc.lines[k]!, t) === normLine(ch.anchor, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const o = hunkOld(ch);
      if (o.length === 0) {
        const ins = ch.endOfFile ? doc.lines.length : cursor;
        const repl = hunkNew(ch).map((part) => part.text);
        doc.lines.splice(ins, 0, ...repl);
        cursor = ins + repl.length;
        continue;
      }
      const found = findTier(doc.lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let pos = found.positions[0]!;
      if (ch.endOfFile) {
        const ok = found.positions.filter((q) => q + o.length === doc.lines.length);
        if (ok.length === 0) throw new Fail('no-match', path);
        pos = ok[0]!;
      }
      const repl = hunkReplacement(doc.lines, pos, found.tier, ch);
      doc.lines.splice(pos, o.length, ...repl);
      cursor = pos + repl.length;
    }
    const text = writeDoc(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      return { from: path, to: moveTo };
    }
    tree.now.set(path, text);
    return undefined;
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i += 1;
      const content: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          content.push(l.slice(1));
          i += 1;
          continue;
        }
        if (l === '') {
          content.push('');
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
        return undefined;
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
        return undefined;
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const updateLine = i;
      const path = line.slice('*** Update File: '.length).trim();
      i += 1;
      let moveTo: string | null = null;
      let j = i;
      while (j < last && blank(lines[j]!)) j += 1;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        i = j + 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const flush = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('@@')) {
          flush();
          const anchor = l.slice(2).trim();
          cur = { a: 0, anchor: anchor === '' ? null : anchor, entries: [], endOfFile: false };
          i += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) cur = { a: 0, anchor: null, entries: [], endOfFile: true };
          else cur.endOfFile = true;
          flush();
          i += 1;
          continue;
        }
        if (l.startsWith('***')) throw new Exit2(`error: parse ${i + 1}`);
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) cur = { a: 0, anchor: null, entries: [], endOfFile: false };
          cur.entries.push({
            kind: l === '' || l.startsWith(' ') ? 'ctx' : l.startsWith('-') ? 'old' : 'new',
            text: l === '' ? '' : l.slice(1),
            noNL: false,
          });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flush();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.entries.length > 0) {
          const e = lastChunk.entries[lastChunk.entries.length - 1]!;
          if (e.kind === 'ctx' && e.text === '') lastChunk.entries.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const m = edit(tree);
      if (m !== undefined) moves.push(m);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const paths = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const consumed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const m of moves) {
    const wasFrom = tree.original(m.from);
    const wasTo = tree.original(m.to);
    const nowFrom = tree.now.has(m.from) ? tree.now.get(m.from)! : tree.original(m.from);
    const nowTo = tree.now.has(m.to) ? tree.now.get(m.to)! : tree.original(m.to);
    if (wasFrom !== null && wasTo === null && nowFrom === null && nowTo !== null) {
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      consumed.add(m.from);
      consumed.add(m.to);
    }
  }
  for (const p of paths) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of paths) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of paths) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      try {
        if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
      } catch {
        // Nothing sits where the file goes.
      }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
