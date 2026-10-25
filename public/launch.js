// The launch: after each question a huge hot-air balloon lifts off behind everything. It hovers while the judge
// reads, then climbs at a speed set by the score, and the tier is revealed with a flourish. Click or press a key to skip.
import { tierFor, METERS_PER_POINT } from './lib/game.mjs';

// how long the climb takes for each score (ms); 0 never really leaves the ground
const CLIMB = { 0: 0, 10: 4600, 15: 3800, 30: 2900, 60: 2100, 85: 1500, 100: 1000 };
const HOLD = { 0: 1500, 10: 1300, 15: 1300, 30: 1500, 60: 1700, 85: 2000, 100: 2800 };
const ZERO = { time: "Time's up", giveaway: 'Gave it away', empty: 'No question', wrong: "Doesn't fit" };

const BALLOON = `
<svg viewBox="0 0 200 290" aria-hidden="true">
  <defs>
    <clipPath id="env"><path d="M100 4C46 4 8 44 8 98c0 52 40 90 62 128h60c22-38 62-76 62-128C192 44 154 4 100 4z"/></clipPath>
    <radialGradient id="shine" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs>
  <g clip-path="url(#env)">
    <rect x="0" y="0" width="200" height="230" fill="#ff6b5b"/>
    <path d="M100 0C80 0 66 60 66 110s14 90 20 120h28c6-30 20-70 20-120S120 0 100 0z" fill="#ffd84d"/>
    <path d="M100 0C93 0 88 60 88 110s4 90 6 120h12c2-30 6-70 6-120S107 0 100 0z" fill="#ff6b5b"/>
    <path d="M30 0C14 40 14 160 52 230h14C40 170 34 60 52 0z" fill="#5fb4ff"/>
    <path d="M170 0c16 40 16 160-22 230h-14c26-60 32-170 14-230z" fill="#5fb4ff"/>
    <rect x="0" y="0" width="200" height="230" fill="url(#shine)"/>
    <path d="M0 150h200v8H0z" fill="#1b2a4a" opacity=".18"/>
  </g>
  <path d="M70 226h60l-8 12H78z" fill="#a0703c"/>
  <path d="M74 238l8 26M126 238l-8 26M92 238l2 26M108 238l-2 26" stroke="#5a4030" stroke-width="1.6"/>
  <g class="flame"><path d="M100 236c-7 8-9 15-4 22 1-6 4-8 4-8s3 2 4 8c5-7 3-14-4-22z" fill="#ffb02e"/><path d="M100 244c-3 4-3 8 0 11 3-3 3-7 0-11z" fill="#fff3b0"/></g>
  <rect x="80" y="262" width="40" height="24" rx="4" fill="#a0703c"/>
  <path d="M80 270h40M80 278h40" stroke="#7a5228" stroke-width="2"/>
</svg>`;

export async function launch(asked, answer) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.className = 'launch';
  el.innerHTML = `
    <div class="l-sky"></div>
    <div class="l-streaks"></div>
    <div class="l-ground"></div>
    <div class="l-balloon">${BALLOON}</div>
    <div class="l-caption"><span class="l-answer">${escapeHtml(answer)}</span><span class="l-status">The judge is reading your question…</span></div>
    <div class="l-meter" hidden>+0 m</div>
    <div class="l-reveal" hidden></div>
    <div class="l-skip">tap to skip</div>`;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('on'));

  let skip;
  const skipped = new Promise(res => { skip = res; });
  const onSkip = e => { if (e.type === 'keydown' && e.key === 'Tab') return; skip(); };
  const wait = ms => Promise.race([new Promise(res => setTimeout(res, ms)), skipped]);

  let r;
  try {
    [r] = await Promise.all([asked, new Promise(res => setTimeout(res, reduce ? 0 : 1100))]);
  } catch (e) {
    el.remove();
    throw e;
  }
  el.addEventListener('pointerdown', onSkip);
  addEventListener('keydown', onSkip);

  const res = r.result;
  const pts = res.points;
  const t = tierFor(pts);
  el.style.setProperty('--c', t.color);
  el.dataset.tier = pts;
  el.querySelector('.l-status').textContent = pts ? 'Lift-off!' : 'Hmm…';

  const balloon = el.querySelector('.l-balloon');
  const meter = el.querySelector('.l-meter');
  const climb = reduce ? 0 : CLIMB[pts] ?? 2000;

  if (!reduce) {
    if (pts === 0) {
      // a hop, a sputter, and back down
      el.classList.add('sputter');
      await animate(balloon, [{ transform: 'translateY(0)' }, { transform: 'translateY(-9vh)', offset: .45 }, { transform: 'translateY(-6vh)', offset: .6 }, { transform: 'translateY(0)' }],
        { duration: 1500, easing: 'ease-in-out' }, skipped);
    } else {
      el.classList.add('climbing');
      el.style.setProperty('--streak', `${Math.max(260, 1400 - pts * 11)}ms`);
      meter.hidden = false;
      countUp(meter, pts * METERS_PER_POINT, climb * .8);
      const rise = animate(balloon, [{ transform: 'translateY(0) scale(1)' }, { transform: 'translateY(-135vh) scale(.82)' }],
        { duration: climb, easing: 'cubic-bezier(.55,0,.7,.4)', fill: 'forwards' }, skipped);
      el.querySelector('.l-sky').animate([{ opacity: 0 }, { opacity: Math.min(1, .15 + pts / 110) }], { duration: climb, fill: 'forwards' });
      el.querySelector('.l-ground').animate([{ transform: 'translateY(0)' }, { transform: 'translateY(60vh)' }], { duration: climb * .7, easing: 'ease-in', fill: 'forwards' });
      await Promise.race([rise, wait(climb * .78)]);
    }
  }

  // the reveal
  const reveal = el.querySelector('.l-reveal');
  const name = pts === 100 ? 'ONE OF ONE' : pts ? t.name : (ZERO[res.reason] || "Doesn't fit");
  const sub = pts === 100 ? 'Nobody else asked anything like it.'
    : pts >= 85 ? 'Almost nobody goes there.'
    : pts >= 60 ? 'A genuinely rare angle.'
    : pts >= 30 ? 'Off the beaten path.'
    : pts ? 'Everybody asks that one.'
    : (res.comment || 'No lift this time.');
  reveal.innerHTML = `<span class="l-emoji">${t.emoji}</span><span class="l-name">${escapeHtml(name)}</span><span class="l-pts">+${(pts * METERS_PER_POINT).toLocaleString('en-US')} m</span><span class="l-sub">${escapeHtml(sub)}</span>`;
  reveal.hidden = false;
  meter.hidden = true;
  el.classList.add('revealed');
  if (pts >= 85 && !reduce) flash(el);
  if (pts === 100 && !reduce) confetti(el);

  await wait(reduce ? 900 : HOLD[pts] ?? 1500);
  removeEventListener('keydown', onSkip);
  el.classList.remove('on');
  setTimeout(() => el.remove(), 380);
  return r;
}

function animate(node, frames, opts, skipped) {
  const a = node.animate(frames, opts);
  skipped.then(() => { try { a.finish(); } catch { /* infinite or gone */ } });
  return a.finished.catch(() => {});
}

function countUp(node, to, ms) {
  const start = performance.now();
  const step = now => {
    const k = Math.min(1, (now - start) / ms);
    node.textContent = `+${Math.round(to * k * k).toLocaleString('en-US')} m`;
    if (k < 1 && node.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function flash(el) {
  const f = document.createElement('div');
  f.className = 'l-flash';
  el.append(f);
  setTimeout(() => f.remove(), 900);
}

function confetti(el) {
  const colors = ['#ffd84d', '#ff6b5b', '#5fb4ff', '#b48cff', '#5fdc8c', '#fff'];
  for (let k = 0; k < 70; k++) {
    const p = document.createElement('i');
    p.className = 'l-bit';
    const a = Math.random() * Math.PI * 2, d = 25 + Math.random() * 45;
    p.style.cssText = `--x:${Math.cos(a) * d}vw;--y:${Math.sin(a) * d - 10}vh;--r:${Math.random() * 720 - 360}deg;background:${colors[k % colors.length]};animation-delay:${Math.random() * 120}ms`;
    el.append(p);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
