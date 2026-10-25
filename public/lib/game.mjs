// Shared by the browser (public/app.js) and the Worker (worker/index.mjs).

export const LAUNCH = '2026-10-25';      // KrONE #1
export const ITEMS_PER_DAY = 7;
export const SECONDS = 60;                // time to write each question
export const GRACE = 8;                   // network slack the server allows
export const METERS_PER_POINT = 10;       // 7 × 100 points = 7,000 m
export const TZ = 'America/New_York';     // a new puzzle at midnight ET

// ---- days -------------------------------------------------------------------

export function dateInTZ(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return p; // YYYY-MM-DD
}

export function dayNumber(date) {
  const ms = Date.parse(date + 'T00:00:00Z') - Date.parse(LAUNCH + 'T00:00:00Z');
  return Math.round(ms / 86400000) + 1;
}

export function dateForDay(n) {
  return new Date(Date.parse(LAUNCH + 'T00:00:00Z') + (n - 1) * 86400000).toISOString().slice(0, 10);
}

// ---- tiers ------------------------------------------------------------------

export const TIERS = [
  { points: 100, key: 'one',      name: 'One of ONE',             emoji: '🌟', color: '#ffd84d' },
  { points: 85,  key: 'ultra',    name: 'Ultra rare',             emoji: '🟪', color: '#b48cff' },
  { points: 60,  key: 'rare',     name: 'Rare',                   emoji: '🟦', color: '#5fb4ff' },
  { points: 30,  key: 'uncommon', name: 'Uncommon',               emoji: '🟩', color: '#5fdc8c' },
  { points: 15,  key: 'familiar', name: 'Asked a thousand times', emoji: '🟨', color: '#f2c94c' },
  { points: 10,  key: 'common',   name: 'Asked a million times',  emoji: '⬜', color: '#d9dde6' },
  { points: 0,   key: 'zero',     name: 'No climb',               emoji: '⬛', color: '#6b7080' },
];

export function tierFor(points) {
  return TIERS.find(t => t.points === points) || TIERS[TIERS.length - 1];
}

// rarity r in [0, 1] → points. 100 also needs nobody else today to have asked anything close.
export function pointsFor(r, unique) {
  if (r >= 0.88) return unique ? 100 : 85;
  if (r >= 0.74) return 85;
  if (r >= 0.58) return 60;
  if (r >= 0.40) return 30;
  if (r >= 0.22) return 15;
  return 10;
}

// Blend the three signals.
//   obscurity: judge's 0–100 rating of how unexpected the angle is
//   simObvious: closest cosine similarity to the item's predictable questions
//   crowdShare: fraction of today's other players who asked something close
//   crowdN: how many other players there are (the crowd only counts once there are a few)
export function rarity({ obscurity, simObvious, crowdShare, crowdN }) {
  const rJudge = clamp(obscurity / 100);
  const rObvious = clamp((0.93 - simObvious) / 0.33);
  const rCrowd = 1 - clamp(crowdShare);
  const wc = 0.3 * Math.min(crowdN, 20) / 20;
  const rest = 1 - wc;
  return clamp(rest * (0.55 * rJudge + 0.45 * rObvious) + wc * rCrowd);
}

export const SIMILAR = 0.86; // cosine at which two questions count as "the same question"

// ---- text -------------------------------------------------------------------

const STOP = new Set(('a an and are as at be by for from has have in is it its of on or that the this to was were what which who whom whose why with ' +
  'lake river island islands mount mountain city town the of de la le el bay sea cape ' +
  // generic words inside answers ("Leaning Tower of Pisa", "Great Wall of China", "Big Ben") that a fair question may use
  'tower wall great bridge falls canal station space international house day days time big hot old new black hole light lights ' +
  'comet cube note code oven games canyon').split(' '));

export function tokens(s) {
  return (s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || []);
}

// Does the question contain the answer itself (or a distinctive word of it)?
export function givesAway(question, answer) {
  const q = new Set(tokens(question).flatMap(t => [t, t.replace(/(es|s)$/, '')]));
  const words = tokens(answer).filter(w => !STOP.has(w) && w.length >= 3);
  const full = tokens(answer).join(' ');
  if (full && tokens(question).join(' ').includes(full)) return true;
  return words.some(w => q.has(w) || q.has(w.replace(/(es|s)$/, '')));
}

// Fallback similarity when embeddings are unavailable (local dev without AI).
export function jaccard(a, b) {
  const A = new Set(tokens(a).filter(t => !STOP.has(t))), B = new Set(tokens(b).filter(t => !STOP.has(t)));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const t of A) if (B.has(t)) n++;
  return n / (A.size + B.size - n);
}

export function cleanQuestion(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 220);
}

// The judge's reply → { valid, obscurity, comment }, or null if it's unusable.
export function parseVerdict(text) {
  if (text && typeof text === 'object') return shape(text);
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return shape(JSON.parse(m[0])); } catch { return null; }
}

function shape(o) {
  if (typeof o.valid !== 'boolean') return null;
  return { valid: o.valid, obscurity: clamp(Number(o.obscurity), 0, 100), comment: String(o.comment || '').slice(0, 140) };
}

export function clamp(x, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : 0)); }

export function shareText(n, results) {
  const total = results.reduce((s, r) => s + (r?.points || 0), 0);
  const grid = Array.from({ length: ITEMS_PER_DAY }, (_, i) => results[i] ? tierFor(results[i].points).emoji : '⬛').join('');
  return `KrONE #${n} 🎈 ${(total * METERS_PER_POINT).toLocaleString('en-US')} m\n${grid}\nkrone.freemanmiller.net`;
}
