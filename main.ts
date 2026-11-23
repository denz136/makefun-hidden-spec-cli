// mend — one command-line tool that applies the edits AI models write, in four formats, to a
// tree of text files. Node 22, the standard library alone: node main.ts [options] [PATCH].
//
// The four formats, and where SPEC.md describes each:
//   unified diff        section 6   read by parseUnified
//   SEARCH/REPLACE      section 7   read by parseSearchReplace
//   V4A patch           section 8   read by parseV4A
//   JSON edits          section 9   read by jsonEdits
//
// The shared machinery, all of it plain functions over lines:
//   patchLines  — a patch's lines: split at \n, one trailing \r gone, no empty piece
//                 after a final \n. Patch line numbers count these from 1.
//   parseDoc    — a tree file read into { lines, eol, final }: its break is CRLF when its
//                 first line feed follows a carriage return, else LF; final says whether
//                 the text ends with that break. emit writes a Doc back exactly so.
//   Tree        — the tree as the edits leave it. `now` maps changed paths to their new
//                 text, null for deleted; anything else is read from disk once and kept.
//                 Every edit sees the tree as the edits before it left it.
//   occurrences — every position where the old lines O match the file's lines at one
//                 tier, occurrences overlapping allowed.
//   firstTier   — the first tier (0: every line equal; 1: trailing spaces and tabs gone;
//                 2: leading and trailing gone) at which O occurs, with all positions.
//   reindent    — at tier 2, a replacement line that starts with the patch's first-line
//                 indent P is re-indented to the file's first matched line's indent F.
//   Fail        — an edit-level failure: no-match, ambiguous, missing, exists, unsafe.
//                 Reported one line per failed edit, then `failed: k of n edits`, exit 1,
//                 and nothing at all is written.
//   Exit2       — a whole-patch fault: usage, no-patch, format, or parse <N>. One line,
//                 exit 2, nothing written.
//
// Every check runs the CLI once in a fresh directory and compares the exit code, all of
// stdout, and every file afterwards with what SPEC.md says. stderr is never compared.
// The implementation below is therefore the specification, sentence by sentence.

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
const stripEnd = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const normLine = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? stripEnd(s) : stripBoth(s));
const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) as RegExpExecArray)[0];

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface Doc {
  lines: string[];
  eol: string;
  final: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], eol: '\n', final: false };
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(eol);
  const body = final ? text.slice(0, -eol.length) : text;
  return { lines: body.split(eol), eol, final };
}

function emit(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.eol) + (doc.final ? doc.eol : '');
}

interface Move {
  old: string;
  path: string;
}

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Move[] = [];
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
    return this.orig.get(p) as string | null;
  }
  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function occurrences(F: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  const o = O.map((s) => normLine(s, tier));
  for (let i = Math.max(0, from); i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(F[i + j] as string, tier) !== o[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function firstTier(F: string[], O: string[], maxTier: number, from = 0, eofOnly = false): { tier: number; idx: number[] } | null {
  for (let t = 0; t <= maxTier; t++) {
    let occ = occurrences(F, O, t, from);
    if (eofOnly) occ = occ.filter((i) => i + O.length === F.length);
    if (occ.length > 0) return { tier: t, idx: occ };
  }
  return null;
}

function reindent(line: string, P: string, F: string): string {
  if (line.trim() === '') return line;
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}

let STRICT = false;
const maxTierFor = (): number => (STRICT ? 0 : 2);

type BodyLine = { t: 'ctx' | 'old' | 'new' | 'bs'; s: string; blank?: boolean };
interface Hunk {
  A: number;
  body: BodyLine[];
}

interface Seg {
  pairOld?: string | null;
  pairNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  gitOld?: string;
  gitNew?: string;
  created: boolean;
  deleted: boolean;
  hunks: Hunk[];
  line: number;
}

function cleanPairPath(raw: string): string | null {
  let p = raw.split('\t')[0] as string;
  p = p.replace(/^ +/, '').replace(/ +$/, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function splitON(body: BodyLine[]): { O: string[]; N: { ctx: boolean; s: string; idx: number }[] } {
  const O: string[] = [];
  const N: { ctx: boolean; s: string; idx: number }[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.t === 'ctx') {
      O.push(b.s);
      N.push({ ctx: true, s: b.s, idx: oi });
      oi += 1;
    } else if (b.t === 'old') {
      O.push(b.s);
      oi += 1;
    } else if (b.t === 'new') {
      N.push({ ctx: false, s: b.s, idx: -1 });
    }
  }
  return { O, N };
}

function bsAfterLastNew(body: BodyLine[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    const b = body[j] as BodyLine;
    if (b.t === 'ctx' || b.t === 'new') last = j;
  }
  if (last < 0) return false;
  return (body[last + 1] as BodyLine | undefined)?.t === 'bs';
}

function applyHunks(doc: Doc, hunks: Hunk[], maxTier: number, path: string): Doc {
  const out: Doc = { lines: doc.lines.slice(), eol: doc.eol, final: doc.final };
  let d = 0;
  for (const h of hunks) {
    const { O, N } = splitON(h.body);
    if (O.length > 0) {
      const res = firstTier(out.lines, O, maxTier);
      if (res === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = res.idx[0] as number;
      for (const i of res.idx) if (Math.abs(i - target) < Math.abs(best - target)) best = i;
      const F = leadingWs(out.lines[best] as string);
      const P = leadingWs(O[0] as string);
      const repl = N.map((e) => (e.ctx ? (out.lines[best + e.idx] as string) : res.tier === 2 ? reindent(e.s, P, F) : e.s));
      const endAtEof = best + O.length === out.lines.length;
      out.lines.splice(best, O.length, ...repl);
      if (endAtEof) out.final = !bsAfterLastNew(h.body);
      d += N.length - O.length;
    } else {
      const at = Math.min(Math.max(0, h.A + d), out.lines.length);
      const repl = N.map((e) => e.s);
      out.lines.splice(at, 0, ...repl);
      if (at === out.lines.length - repl.length) out.final = !bsAfterLastNew(h.body);
      d += N.length;
    }
  }
  return out;
}

function parseUnified(lines: string[]): Edit[] {
  const segs: Seg[] = [];
  let cur: Seg | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const at = (k: number): string => (k < n ? (lines[k] as string) : '');

  const startSeg = (): Seg => {
    const s: Seg = { created: false, deleted: false, hunks: [], line: i + 1 };
    segs.push(s);
    cur = s;
    inHeader = true;
    return s;
  };

  while (i < n) {
    const l = lines[i] as string;
    if (inHeader && cur !== null) {
      if (l.startsWith('diff --git ')) {
        const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        const s = startSeg();
        s.gitOld = m[1] as string;
        s.gitNew = m[2] as string;
        i += 1;
        continue;
      }
      if (l.startsWith('--- ')) {
        if (!at(i + 1).startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.pairOld = cleanPairPath(l.slice(4));
        cur.pairNew = cleanPairPath(at(i + 1).slice(4));
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).replace(/^ +/, '').replace(/ +$/, '');
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).replace(/^ +/, '').replace(/ +$/, '');
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.created = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.deleted = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        inHeader = false;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSeg();
      s.gitOld = m[1] as string;
      s.gitNew = m[2] as string;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && at(i + 1).startsWith('+++ ')) {
      startSeg();
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const h: Hunk = { A: Number(m[1]), body: [] };
      i += 1;
      while (i < n) {
        const b = lines[i] as string;
        if (b === '') {
          h.body.push({ t: 'ctx', s: '', blank: true });
          i += 1;
          continue;
        }
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && at(i + 1).startsWith('+++ ')) break;
        const c = b[0] as string;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          h.body.push({ t: c === ' ' ? 'ctx' : c === '-' ? 'old' : c === '+' ? 'new' : 'bs', s: b.slice(1), blank: b.trim() === '' });
          i += 1;
          continue;
        }
        break;
      }
      while (h.body.length > 0 && (h.body[h.body.length - 1] as BodyLine).blank === true) h.body.pop();
      (cur as Seg).hunks.push(h);
      continue;
    }
    i += 1;
  }

  if (segs.length === 0) throw new Exit2('error: parse 1');
  return segs.map((s) => buildUnifiedEdit(s));
}

function buildUnifiedEdit(seg: Seg): Edit {
  const oldT = seg.pairOld !== undefined ? seg.pairOld : seg.renameFrom !== undefined ? seg.renameFrom : seg.gitOld !== undefined ? seg.gitOld : null;
  const newT = seg.pairNew !== undefined ? seg.pairNew : seg.renameTo !== undefined ? seg.renameTo : seg.gitNew !== undefined ? seg.gitNew : null;
  const isCreate = seg.created || oldT === null;
  const isDelete = !isCreate && (seg.deleted || newT === null);
  const createPath = (newT ?? seg.gitNew ?? '') as string;
  const oldPath = (oldT ?? seg.gitOld ?? '') as string;
  const newPath = (newT ?? seg.gitNew ?? '') as string;

  if (isCreate) {
    const plus: string[] = [];
    let endsBs = false;
    for (const h of seg.hunks) {
      for (let j = 0; j < h.body.length; j++) {
        const b = h.body[j] as BodyLine;
        if (b.t === 'new') {
          plus.push(b.s);
          endsBs = (h.body[j + 1] as BodyLine | undefined)?.t === 'bs';
        }
      }
    }
    return (tree) => {
      if (!safe(createPath)) throw new Fail('unsafe', createPath);
      if (tree.get(createPath) !== null) throw new Fail('exists', createPath);
      tree.now.set(createPath, emit({ lines: plus, eol: '\n', final: !endsBs }));
    };
  }
  if (isDelete) {
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  const isMove = oldPath !== newPath;
  return (tree) => {
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const doc = parseDoc(before);
    const out = applyHunks(doc, seg.hunks, maxTierFor(), oldPath);
    const text = emit(out);
    if (isMove) {
      tree.moves.push({ old: oldPath, path: newPath });
      tree.now.set(newPath, text);
      tree.now.set(oldPath, null);
    } else {
      tree.now.set(oldPath, text);
    }
  };
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if ((lines[i] as string).trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const t = lines[j] as string;
      if (blank(t)) continue;
      const tt = t.trim();
      if (tt.startsWith('```')) continue;
      path = tt;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < n; j++) {
      const t = (lines[j] as string).trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if ((lines[j] as string).trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, emit({ lines: newLines.slice(), eol: '\n', final: newLines.length > 0 }));
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = parseDoc(before);
      const res = firstTier(doc.lines, oldLines, maxTierFor());
      if (res === null) throw new Fail('no-match', p);
      if (res.idx.length > 1) throw new Fail('ambiguous', p);
      const pos = res.idx[0] as number;
      const F = leadingWs(doc.lines[pos] as string);
      const P = leadingWs(oldLines[0] as string);
      const repl = newLines.map((s) => (res.tier === 2 ? reindent(s, P, F) : s));
      doc.lines.splice(pos, oldLines.length, ...repl);
      tree.now.set(p, emit(doc));
    });
    prevEnd = rep;
    prevPath = p;
    i = rep + 1;
  }
  return edits;
}

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function parseV4A(lines: string[]): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let j = 0; j < n; j++) if (!blank(lines[j] as string)) { first = j; break; }
  if (first < 0) throw new Exit2('error: parse 1');
  if ((lines[first] as string).trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = n - 1; j >= 0; j--) if (!blank(lines[j] as string)) { last = j; break; }
  if (last < 0 || (lines[last] as string).trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  const isSection = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const l = lines[i] as string;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      i += 1;
      const body: { s: string; blank: boolean }[] = [];
      while (i < last) {
        const b = lines[i] as string;
        if (b.startsWith('+')) {
          body.push({ s: b.slice(1), blank: false });
          i += 1;
          continue;
        }
        if (b === '') {
          body.push({ s: '', blank: true });
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && (body[body.length - 1] as { blank: boolean }).blank) body.pop();
      const content = body.map((e) => e.s);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, emit({ lines: content.slice(), eol: '\n', final: true }));
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i += 1;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const upLine = i + 1;
      const p = l.slice('*** Update File: '.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < last && (lines[i] as string).startsWith('*** Move to: ')) {
        moveTo = (lines[i] as string).slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      while (i < last) {
        const b = lines[i] as string;
        if (isSection(b)) break;
        if (b.startsWith('@@')) {
          const a = b.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, body: [] };
          chunks.push(cur);
          i += 1;
          continue;
        }
        if (b.startsWith('*** End of File')) {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.eof = true;
          i += 1;
          continue;
        }
        if (b === '') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({ t: 'ctx', s: '', blank: true });
          i += 1;
          continue;
        }
        const c = b[0] as string;
        if (c === ' ' || c === '-' || c === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({ t: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', s: b.slice(1), blank: b.trim() === '' });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      for (const ch of chunks) {
        while (ch.body.length > 0 && (ch.body[ch.body.length - 1] as BodyLine).blank === true) ch.body.pop();
      }
      const keep = chunks.filter((ch) => ch.body.length > 0 || ch.anchor !== null || ch.eof);
      if (keep.length === 0 && moveTo === null) throw new Exit2(`error: parse ${upLine}`);
      const mv = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const doc = parseDoc(before);
        let cursor = 0;
        for (const ch of keep) {
          if (ch.anchor !== null) {
            let found = -1;
            for (let t = 0; t <= maxTierFor() && found < 0; t++) {
              for (let j = cursor; j < doc.lines.length; j++) {
                if (normLine(doc.lines[j] as string, t) === normLine(ch.anchor, t)) {
                  found = j;
                  break;
                }
              }
            }
            if (found < 0) throw new Fail('no-match', p);
            cursor = found;
          }
          const { O, N } = splitON(ch.body);
          if (O.length === 0) {
            const at = ch.eof ? doc.lines.length : Math.min(cursor, doc.lines.length);
            const repl = N.map((e) => e.s);
            doc.lines.splice(at, 0, ...repl);
            cursor = at + repl.length;
            continue;
          }
          const res = firstTier(doc.lines, O, maxTierFor(), cursor, ch.eof);
          if (res === null) throw new Fail('no-match', p);
          const at = res.idx[0] as number;
          const F = leadingWs(doc.lines[at] as string);
          const P = leadingWs(O[0] as string);
          const repl = N.map((e) => (e.ctx ? (doc.lines[at + e.idx] as string) : res.tier === 2 ? reindent(e.s, P, F) : e.s));
          doc.lines.splice(at, O.length, ...repl);
          cursor = at + repl.length;
        }
        const text = emit(doc);
        if (mv !== null) {
          tree.moves.push({ old: p, path: mv });
          tree.now.set(mv, text);
          tree.now.set(p, null);
        } else {
          tree.now.set(p, text);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

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
      const pos = t.indexOf(old);
      const out = t.slice(0, pos) + lf(newStr) + t.slice(pos + old.length);
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
      tree.now.set(p, emit({ lines, eol: br, final }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
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

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const c = (lines[first] as string).trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
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
  STRICT = strict;
  const file = pos.length === 0 || pos[0] === '-' ? null : (pos[0] as string);
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines) : kind === 'search-replace' ? parseSearchReplace(lines) : parseV4A(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { k: string; s: string }[] = [];
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const m of tree.moves) {
    const oldWas = tree.original(m.old);
    const newWas = tree.original(m.path);
    const nowOld = tree.get(m.old);
    const nowNew = tree.get(m.path);
    if (oldWas !== null && nowOld === null && newWas === null && nowNew !== null) {
      movedFrom.add(m.old);
      movedTo.add(m.path);
      rows.push({ k: m.path, s: `R ${m.old} -> ${m.path}` });
    }
  }
  for (const p of tree.now.keys()) {
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was === now) continue;
    rows.push({ k: p, s: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.k), Buffer.from(b.k)));
  const out = rows.map((r) => r.s);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p) as string | null;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
