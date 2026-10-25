import { TIERS, ITEMS_PER_DAY, SECONDS, METERS_PER_POINT, tierFor, shareText, givesAway } from './lib/game.mjs';
import { launch } from './launch.js';

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const MAX = ITEMS_PER_DAY * 100;

let day = null;          // { n, date, items, opened, results, stats }
let skew = 0;            // server clock − our clock
let timer = null;

// ---- boot -------------------------------------------------------------------

buildTierTable();
$('#helpBtn').addEventListener('click', () => $('#help').showModal());
load();

async function load() {
  try {
    const res = await fetch('/api/today', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    day = await res.json();
    skew = day.now - Date.now();
  } catch (e) {
    app.innerHTML = `<section class="screen card"><h2>The balloon won't inflate.</h2><p class="error">Couldn't reach the server (${esc(e.message)}).</p><button class="btn" onclick="location.reload()">Try again</button></section>`;
    return;
  }
  $('#dayTag').textContent = `#${day.n} · ${fmtDate(day.date)}`;
  setAltitude(total());
  const next = nextIndex();
  if (next === -1) return summary();
  if (next === 0 && day.opened[0] == null) return intro();
  play(next);
}

// ---- screens ----------------------------------------------------------------

function intro() {
  app.innerHTML = `
    <section class="screen card intro">
      <h1>Seven rare answers.<br>Ask the <span class="one">rarest</span> questions.</h1>
      <p class="lede">Krillion dives for rare answers. <b>KrONE climbs for rare questions.</b></p>
      <ul class="steps">
        <li><b class="n">7</b><span>Today you get seven rare answers.</span></li>
        <li><b class="n">?</b><span>For each one, write the <b>rarest question</b> you can think of that still has that answer.</span></li>
        <li><b class="n">60</b><span>You get 60 seconds each. The question must be true, and it can't contain the answer.</span></li>
        <li><b class="n">↑</b><span>Common questions barely lift off. One nobody else asked climbs 1,000 m.</span></li>
      </ul>
      <div class="row"><button class="btn" id="go">Start climbing</button><button class="btn ghost" id="how">Scoring</button></div>
    </section>`;
  $('#go').onclick = () => play(0);
  $('#how').onclick = () => $('#help').showModal();
  $('#go').focus();
}

async function play(i) {
  clearInterval(timer);
  const item = day.items[i];
  app.innerHTML = `
    <section class="screen card">
      ${progressBar(i)}
      <span class="chip">${esc(item.category)}</span>
      <div class="label">The answer is</div>
      <div class="answer">${esc(item.answer)}</div>
      <p class="blurb">${esc(item.blurb)}</p>
      <div class="timer" id="bar"><i></i></div>
      <form class="ask" id="form" autocomplete="off">
        <label class="label" for="q" style="display:block;margin-top:0">Your question</label>
        <div class="field">
          <textarea id="q" maxlength="200" rows="3" placeholder="Ask the rarest question that leads here…" enterkeyhint="send"></textarea>
          <span class="count" id="count">0/200</span>
        </div>
        <div class="play-foot">
          <span class="secs" id="secs">${SECONDS}</span>
          <span class="dim small" id="warn"></span>
          <button class="btn" id="send">Ask</button>
        </div>
      </form>
    </section>`;

  const q = $('#q'), form = $('#form'), warn = $('#warn');
  q.addEventListener('input', () => {
    $('#count').textContent = `${q.value.length}/200`;
    warn.textContent = q.value && givesAway(q.value, item.answer) ? 'Careful: that gives the answer away.' : '';
  });
  q.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  let sent = false;
  const send = () => { if (sent) return; sent = true; clearInterval(timer); submit(i, q.value); };
  form.addEventListener('submit', e => { e.preventDefault(); if (!q.value.trim()) { q.focus(); return; } send(); });
  q.focus();

  // The clock starts when the server first sees this card (so a reload doesn't reset it).
  let opened = day.opened[i];
  if (opened == null) {
    try {
      const r = await api('/api/open', { n: day.n, i });
      opened = day.opened[i] = r.opened;
    } catch { opened = Date.now() + skew; }
  }
  const end = opened + SECONDS * 1000;
  const bar = $('#bar'), secs = $('#secs');
  const tick = () => {
    const left = Math.max(0, end - (Date.now() + skew));
    const s = Math.ceil(left / 1000);
    bar.firstElementChild.style.transform = `scaleX(${left / (SECONDS * 1000)})`;
    secs.textContent = s;
    bar.classList.toggle('low', s <= 10); secs.classList.toggle('low', s <= 10);
    if (left <= 0) send();
  };
  tick();
  timer = setInterval(tick, 200);
}

async function submit(i, text) {
  app.innerHTML = '';
  const asked = api('/api/ask', { n: day.n, i, q: text });
  let r;
  try {
    r = await launch(asked, day.items[i].answer);
  } catch (e) {
    if (e.stale) return load();
    app.innerHTML = `<section class="screen card"><p class="error">${esc(e.message)}</p><button class="btn" id="retry">Try again</button></section>`;
    $('#retry').onclick = () => submit(i, text);
    return;
  }
  day.results[i] = r.result;
  day.stats = r.stats;
  if (r.reveal) day.reveal = r.reveal;
  setAltitude(total());
  verdict(i, r.result);
}

function verdict(i, res) {
  const t = tierFor(res.points);
  const item = day.items[i];
  const name = res.points ? t.name : ({ time: "Time's up", giveaway: 'Gave it away', empty: 'No question' }[res.reason] || "Doesn't fit");
  const crowd = !res.valid ? '' : res.askedBy === 0
    ? `You're the first to ask about <b>${esc(item.answer)}</b> today.`
    : res.similar === 0 ? `Nobody else's question today comes close (of <b>${res.askedBy}</b>).`
    : `<b>${res.similar}</b> of ${res.askedBy} other players asked something like it.`;
  const last = i === ITEMS_PER_DAY - 1;
  app.innerHTML = `
    <section class="screen card verdict" style="--c:${t.color}">
      ${progressBar(i + 1)}
      <div class="label" style="margin-top:4px">${esc(item.answer)}</div>
      <div class="badge pop"><span class="pts">+${res.points * METERS_PER_POINT} m</span><span class="tname">${t.emoji} ${esc(name)}</span></div>
      ${res.q ? `<p class="yourq">${esc(res.q)}</p>` : ''}
      ${res.comment ? `<p class="comment">${esc(res.comment)}</p>` : ''}
      <div class="facts">
        <div><span class="dim">What most people ask:</span> <b>${esc(res.obvious)}</b></div>
        ${crowd ? `<div class="dim">${crowd}</div>` : ''}
      </div>
      <button class="btn" id="next">${last ? 'See your altitude' : 'Next answer →'}</button>
    </section>`;
  $('#next').onclick = () => last ? summary() : play(i + 1);
  $('#next').focus();
}

function summary() {
  clearInterval(timer);
  const pts = total();
  const s = day.stats || {};
  const recap = day.items.map((it, i) => {
    const r = day.results[i] || { points: 0 };
    const t = tierFor(r.points);
    const rv = day.reveal?.[i];
    const ladder = rv ? TIERS.filter(x => x.points && rv.ladder[x.points]).map(x => `
        <li class="${x.points === r.points ? 'yours' : ''}" style="--c:${x.color}">
          <span class="tier">${x.emoji} ${x.points === 100 ? 'One of ONE' : esc(x.name)}${x.points === r.points ? ' <em>← you</em>' : ''}</span>
          <span class="ex">${esc(rv.ladder[x.points])}</span>
        </li>`).join('') : '';
    const top = rv?.top ? `<div class="top" style="--c:${tierFor(rv.top.points).color}"><span class="tier">👑 Today's rarest question from a player · ${tierFor(rv.top.points).emoji} +${rv.top.points * METERS_PER_POINT} m</span><span class="ex">${esc(rv.top.q)}</span></div>` : '';
    return `<li style="--c:${t.color}">
      <details${i === 0 ? ' open' : ''}>
        <summary><span class="p">${t.emoji}<br>${r.points}</span><span><span class="a">${esc(it.answer)}</span><br><span class="q">${r.q ? esc(r.q) : '<i>no question</i>'}</span></span></summary>
        ${rv ? `<div class="ladder"><div class="label">What each tier looked like</div><ol>${ladder}</ol>${top}</div>` : ''}
      </details>
    </li>`;
  }).join('');
  app.innerHTML = `
    <section class="screen card summary">
      <div class="label">KrONE #${day.n} · you climbed</div>
      <div class="meters">${(pts * METERS_PER_POINT).toLocaleString('en-US')} m</div>
      <div class="dim">${zone(pts)}</div>
      <div class="grid">${day.items.map((_, i) => tierFor(day.results[i]?.points || 0).emoji).join('')}</div>
      <div class="statline">
        <div><b>${pts}</b><span>of ${MAX} pts</span></div>
        ${s.players ? `<div><b>${s.players}</b><span>players today</span></div>` : ''}
        ${s.players ? `<div><b>${(s.avg * METERS_PER_POINT).toLocaleString('en-US')} m</b><span>average</span></div>` : ''}
        ${s.beat != null ? `<div><b>${s.beat}%</b><span>out-climbed</span></div>` : ''}
      </div>
      <div class="row" style="justify-content:center"><button class="btn" id="share">Share</button></div>
      <ul class="recap">${recap}</ul>
      <p class="next" id="next"></p>
    </section>
    <p class="foot">A <a href="https://freemanmiller.net">freemanmiller.net</a> game</p>`;
  $('#share').onclick = share;
  const nextEl = $('#next');
  const tickNext = () => {
    const ms = msToMidnightET();
    if (ms <= 0) { clearInterval(timer); return location.reload(); }
    const h = Math.floor(ms / 3.6e6), m = Math.floor(ms / 6e4) % 60, sec = Math.floor(ms / 1000) % 60;
    nextEl.textContent = `Seven new answers in ${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };
  tickNext();
  timer = setInterval(tickNext, 1000);
}

// ---- bits -------------------------------------------------------------------

function nextIndex() {
  for (let i = 0; i < ITEMS_PER_DAY; i++) if (!day.results[i]) return i;
  return -1;
}

function total() {
  return (day?.results || []).reduce((s, r) => s + (r?.points || 0), 0);
}

function setAltitude(points) {
  document.documentElement.style.setProperty('--alt', String(points / MAX));
  $('#altReadout').textContent = `${(points * METERS_PER_POINT).toLocaleString('en-US')} m`;
}

function zone(pts) {
  const m = pts * METERS_PER_POINT;
  if (m >= 6500) return 'The thin air where only the One lives.';
  if (m >= 5000) return 'Above the clouds and nearly alone.';
  if (m >= 3000) return 'Mountain air. Most people never get here.';
  if (m >= 1000) return 'Through the cloud deck.';
  if (m >= 300) return 'Over the rooftops.';
  return 'Still in the treetops.';
}

function progressBar(upTo) {
  return `<div class="progress">${day.items.map((_, k) => {
    const r = day.results[k];
    if (r) return `<span class="done" style="--c:${tierFor(r.points).color}"></span>`;
    return `<span class="${k === upTo ? 'now' : ''}"></span>`;
  }).join('')}</div>`;
}

async function share() {
  const text = shareText(day.n, day.results);
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) { await navigator.share({ text }); return; }
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch { /* cancelled */ }
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 1800);
}

async function api(path, body) {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = new Error(data.error || 'HTTP ' + res.status);
    e.stale = !!data.stale;
    throw e;
  }
  return data;
}

function buildTierTable() {
  $('#tierTable').innerHTML = TIERS.filter(t => t.points).map(t =>
    `<tr><td>${t.emoji}</td><td><b style="color:${t.color}">${t.name}</b></td><td>+${t.points * METERS_PER_POINT} m</td></tr>`).join('') +
    `<tr><td>⬛</td><td><b>Wrong, gave it away, or time's up</b></td><td>0 m</td></tr>`;
}

function msToMidnightET() {
  const now = new Date(Date.now() + skew);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(now).map(p => [p.type, Number(p.value)]));
  const elapsed = ((parts.hour % 24) * 3600 + parts.minute * 60 + parts.second) * 1000 + now.getMilliseconds();
  return 86400000 - elapsed;
}

function fmtDate(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
