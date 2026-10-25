// KrONE Worker: serves public/ and the /api/* routes.
// Each puzzle day is one Durable Object (SQLite) holding that day's questions, embeddings and scores.
// Everything a request needs is cached in memory after the object's first load, so normal requests read ~0 rows.

import { DurableObject } from 'cloudflare:workers';
import PUZZLES from '../src/puzzles.json';
import {
  ITEMS_PER_DAY, SECONDS, GRACE, SIMILAR, dateInTZ, dayNumber, dateForDay,
  rarity, pointsFor, givesAway, jaccard, cleanQuestion, parseVerdict,
} from '../public/lib/game.mjs';

const COOKIE = 'kr_id';

export function puzzleFor(n) {
  const len = PUZZLES.length;
  return PUZZLES[(((n - 1) % len) + len) % len];
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

    let pid = readCookie(req, COOKIE);
    const fresh = !pid || !/^[a-f0-9-]{36}$/.test(pid);
    if (fresh) pid = crypto.randomUUID();

    let res;
    try {
      res = await route(req, env, url, pid);
    } catch (e) {
      console.error(e);
      res = json({ error: 'Something went wrong. Try again.' }, 500);
    }
    if (fresh) res.headers.append('set-cookie', `${COOKIE}=${pid}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
    return res;
  },
};

async function route(req, env, url, pid) {
  const today = dayNumber(env.DEV_DATE || dateInTZ());
  const p = url.pathname;

  if (p === '/api/today' && req.method === 'GET') {
    const n = today;
    const items = puzzleFor(n).map(({ answer, category, blurb }) => ({ answer, category, blurb }));
    const state = await stub(env, n).state(pid, n);
    return json({ n, date: dateForDay(n), seconds: SECONDS, items, ...state, now: Date.now() });
  }

  if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
  const body = await req.json().catch(() => ({}));
  const n = Number(body.n), i = Number(body.i);
  if (n !== today) return json({ error: 'That puzzle has closed. Reload for today’s.', stale: true }, 409);
  if (!Number.isInteger(i) || i < 0 || i >= ITEMS_PER_DAY) return json({ error: 'Bad item' }, 400);

  if (p === '/api/open') return json(await stub(env, n).open(pid, i, n));
  if (p === '/api/ask') return json(await stub(env, n).ask(pid, i, cleanQuestion(body.q), n));
  return json({ error: 'Not found' }, 404);
}

function stub(env, n) {
  return env.DAY.get(env.DAY.idFromName('day-' + n));
}

// ---- the day ----------------------------------------------------------------

export class Day extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS opens (pid TEXT, item INT, ts INT, PRIMARY KEY (pid, item));
      CREATE TABLE IF NOT EXISTS asks (pid TEXT, item INT, q TEXT, emb TEXT, points INT, result TEXT, ts INT, PRIMARY KEY (pid, item));
    `);
    this.loaded = false;
    this.pending = new Set();
  }

  load() {
    if (this.loaded) return;
    this.n = Number(this.sql.exec(`SELECT v FROM meta WHERE k='n'`).toArray()[0]?.v || 0);
    this.opens = new Map();   // pid → [ts per item]
    this.asks = new Map();    // pid → [result per item]
    this.crowd = Array.from({ length: ITEMS_PER_DAY }, () => []); // item → [{pid, q, emb}]
    this.totals = new Map();  // pid → total points
    for (const r of this.sql.exec(`SELECT pid, item, ts FROM opens`)) row(this.opens, r.pid)[r.item] = r.ts;
    for (const r of this.sql.exec(`SELECT pid, item, q, emb, points, result FROM asks ORDER BY ts`)) {
      row(this.asks, r.pid)[r.item] = JSON.parse(r.result);
      if (r.q) this.crowd[r.item].push({ pid: r.pid, q: r.q, emb: r.emb ? JSON.parse(r.emb) : null });
      this.totals.set(r.pid, (this.totals.get(r.pid) || 0) + r.points);
    }
    const obv = this.sql.exec(`SELECT v FROM meta WHERE k='obvious'`).toArray()[0]?.v;
    this.obviousEmb = obv ? JSON.parse(obv) : null;
    this.loaded = true;
  }

  setDay(n) {
    if (this.n === n) return;
    this.n = n;
    this.sql.exec(`INSERT OR REPLACE INTO meta VALUES ('n', ?)`, String(n));
  }

  async state(pid, n) {
    this.load(); this.setDay(n);
    return { opened: this.opens.get(pid) || [], results: this.asks.get(pid) || [], stats: this.stats(pid) };
  }

  async open(pid, i, n) {
    this.load(); this.setDay(n);
    const o = row(this.opens, pid);
    if (o[i] == null) {
      o[i] = Date.now();
      this.sql.exec(`INSERT OR IGNORE INTO opens VALUES (?, ?, ?)`, pid, i, o[i]);
    }
    return { opened: o[i], now: Date.now() };
  }

  async ask(pid, i, q, n) {
    this.load(); this.setDay(n);
    const mine = row(this.asks, pid);
    if (mine[i]) return { result: mine[i], stats: this.stats(pid) };
    const key = pid + ':' + i;
    if (this.pending.has(key)) return { error: 'Already judging that one…' };
    this.pending.add(key);
    try {
      const item = puzzleFor(n)[i];
      const opened = row(this.opens, pid)[i] ?? Date.now();
      const late = Date.now() - opened > (SECONDS + GRACE) * 1000;
      const result = await this.judge(item, i, q, late, pid);

      mine[i] = result;
      this.totals.set(pid, (this.totals.get(pid) || 0) + result.points);
      if (result.valid) this.crowd[i].push({ pid, q, emb: result.emb });
      const emb = result.emb; delete result.emb;
      this.sql.exec(`INSERT OR REPLACE INTO asks VALUES (?, ?, ?, ?, ?, ?, ?)`,
        pid, i, result.valid ? q : '', emb ? JSON.stringify(emb) : null, result.points, JSON.stringify(result), Date.now());
      return { result, stats: this.stats(pid) };
    } finally {
      this.pending.delete(key);
    }
  }

  async judge(item, i, q, late, pid) {
    const base = { q, obvious: item.obvious[0] };
    if (late) return { ...base, q: '', points: 0, valid: false, reason: 'time', comment: 'The balloon didn’t wait.' };
    if (!q || q.replace(/[^a-z]/gi, '').length < 6) return { ...base, points: 0, valid: false, reason: 'empty', comment: 'No question, no lift.' };
    if (givesAway(q, item.answer)) return { ...base, points: 0, valid: false, reason: 'giveaway', comment: `Your question contains the answer. That's cheating, friend.` };

    const [verdict, emb] = await Promise.all([this.askJudge(item, q), this.embed(item, i, q)]);
    if (!verdict.valid) return { ...base, points: 0, valid: false, reason: verdict.reason || 'wrong', comment: verdict.comment || `That doesn't lead to ${item.answer}.` };

    // How close is it to the predictable questions, and to what everyone else asked today?
    let simObvious, sims;
    const others = this.crowd[i].filter(c => c.pid !== pid);
    if (emb && this.obviousEmb?.[i]) {
      simObvious = Math.max(...this.obviousEmb[i].map(o => dot(emb, o)));
      sims = others.map(c => c.emb ? dot(emb, c.emb) : jaccard(q, c.q) * 0.5 + 0.5);
    } else {
      simObvious = 0.68 + 0.3 * Math.max(...item.obvious.map(o => jaccard(q, o)));
      sims = others.map(c => 0.68 + 0.3 * jaccard(q, c.q));
    }
    const close = sims.filter(s => s >= SIMILAR).length;
    const crowdShare = others.length ? close / others.length : 0;
    const r = rarity({ obscurity: verdict.obscurity, simObvious, crowdShare, crowdN: others.length });
    const points = pointsFor(r, close === 0);

    return {
      ...base, valid: true, points, comment: verdict.comment,
      rarity: Math.round(r * 100), similar: close, askedBy: others.length,
      emb: emb || null,
    };
  }

  async askJudge(item, q) {
    const env = this.env;
    if (!env.AI) return { valid: true, obscurity: 35, comment: 'Judge offline: scored on rarity alone.' };
    const system = `You are the judge of KrONE, a game where the player is given a rare ANSWER and must write a QUESTION whose answer is it, and the more unusual the question, the better.
Decide:
- valid: true if someone who knows the facts would read QUESTION and arrive at ANSWER as a correct answer (other answers can also be possible, but ANSWER must clearly fit), the facts in QUESTION are accurate, and it is a sincere question. false if it is factually wrong, too vague to point at ANSWER (e.g. "What is a thing?"), unrelated, a joke that doesn't work, or offensive/hateful/sexual.
- obscurity: 0-100, how rare and unexpected the angle is. 0-15 = the textbook definition anyone would write. 30-50 = a fair but natural angle. 60-80 = a specific, surprising true detail. 85-100 = a brilliant, unexpected, specific connection almost nobody would think to ask. Vagueness does not count as obscurity.
- comment: one short, witty line (max 14 words) for the player about their question. If invalid, say briefly why.
Reply with JSON only: {"valid": boolean, "obscurity": number, "comment": string}`;
    const user = `ANSWER: ${item.answer}\nABOUT IT: ${item.blurb}\nQUESTION: ${q}`;
    try {
      const out = await env.AI.run(env.JUDGE_MODEL, {
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: 120, temperature: 0.2,
        response_format: { type: 'json_schema', json_schema: { type: 'object', properties: { valid: { type: 'boolean' }, obscurity: { type: 'number' }, comment: { type: 'string' } }, required: ['valid', 'obscurity', 'comment'] } },
      });
      const v = parseVerdict(out?.response);
      if (v) return v;
    } catch (e) {
      console.error('judge', e);
    }
    return { valid: true, obscurity: 35, comment: 'The judge blinked. Scored on rarity alone.' };
  }

  async embed(item, i, q) {
    const env = this.env;
    if (!env.AI) return null;
    try {
      if (!this.obviousEmb) {
        const all = puzzleFor(this.n).flatMap(it => it.obvious);
        const out = await env.AI.run(env.EMBED_MODEL, { text: all });
        const vecs = out.data.map(norm);
        this.obviousEmb = Array.from({ length: ITEMS_PER_DAY }, (_, k) => vecs.slice(k * 3, k * 3 + 3));
        this.sql.exec(`INSERT OR REPLACE INTO meta VALUES ('obvious', ?)`, JSON.stringify(this.obviousEmb));
      }
      const out = await env.AI.run(env.EMBED_MODEL, { text: [q] });
      return norm(out.data[0]);
    } catch (e) {
      console.error('embed', e);
      return null;
    }
  }

  stats(pid) {
    const totals = [...this.totals.values()];
    const mine = this.totals.get(pid) || 0;
    const players = totals.length;
    const below = totals.filter(t => t < mine).length;
    const avg = players ? Math.round(totals.reduce((a, b) => a + b, 0) / players) : 0;
    return { players, avg, beat: players > 1 ? Math.round(100 * below / (players - 1)) : null };
  }
}

// ---- helpers ----------------------------------------------------------------

function row(map, pid) {
  let r = map.get(pid);
  if (!r) map.set(pid, r = []);
  return r;
}

function norm(v) {
  const len = Math.hypot(...v) || 1;
  return v.map(x => Math.round(x / len * 1e4) / 1e4);
}

function dot(a, b) {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += a[k] * b[k];
  return s;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

function readCookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m && m[1];
}
