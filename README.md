# KrONE

A daily game of rare questions, at **https://krone.freemanmiller.net**.

Krillion gives you a prompt and rewards the rarest correct answer. KrONE turns that around: every day you get **seven rare answers**, and for each one you have 60 seconds to write the **rarest question** that still has that answer.

- Each question scores 0, 10, 15, 30, 60, 85 or 100 points. Each point lifts your balloon 10 m, so a perfect day reaches 7,000 m.
- **One of ONE** (100) means the question was rated highly rare *and* nobody else asked anything close that day.
- A question scores 0 if it's wrong, too vague, contains the answer, or comes in after the timer.

## How a question is scored

1. **Rules check** (`givesAway` in `public/lib/game.mjs`): the question can't contain the answer.
2. **Judge** (Workers AI, `JUDGE_MODEL`): is the question true and does it lead to the answer? How unexpected is the angle (0–100)?
3. **Distance from the obvious**: each answer has three predictable questions in `src/puzzles.json`. The player's question is embedded (`EMBED_MODEL`) and compared with them.
4. **The crowd**: the share of other players today whose question for that answer is a near-duplicate (cosine ≥ 0.86).

These blend into a rarity from 0 to 1 (`rarity()` / `pointsFor()` in `public/lib/game.mjs`). The crowd counts for more as more people play.

## Layout

| Path | What |
| --- | --- |
| `public/` | The static site: `index.html`, `style.css`, `app.js`, and `lib/game.mjs` (shared with the Worker). |
| `worker/index.mjs` | The Worker: serves `public/` and `/api/today`, `/api/open`, `/api/ask`. One Durable Object (`Day`, SQLite) per puzzle day stores questions, embeddings and totals. |
| `src/puzzles.json` | The puzzle bank: 28 days × 7 answers. Day *n* uses entry `(n − 1) mod 28`, so it loops after four weeks. Add more days to the end. |
| `tests/` | `npm test` |

Players are anonymous (a `kr_id` cookie). The timer starts on the server when a card is first shown, so reloading doesn't reset it. A new puzzle starts at midnight Eastern. KrONE #1 was 2026-10-25.

## Deploy (Cloudflare)

```sh
npm install
npx wrangler login
npx wrangler deploy
```

That's all: Workers AI and the Durable Object need no keys or extra setup. The custom-domain route `krone.freemanmiller.net` is in `wrangler.jsonc`, the same way as the other freemanmiller.net games.

Local: `npx wrangler dev` (Workers AI runs remotely, so you need to be logged in; without it, the judge falls back to scoring on rarity alone). Set `DEV_DATE=2026-10-26` in `.dev.vars` to play another day.

### Costs

Each question makes one judge call and one embedding call (about 15 neurons in all). The Workers AI free allocation is 10,000 neurons a day (reset 00:00 UTC), and Cloudflare has no spending cap, so the Worker keeps its own count in the `Budget` Durable Object and stops calling AI at 9,000 neurons a day (about 600 questions). Past that, until the reset, the judge falls back gracefully: every question is treated as valid and scored on distance from the obvious questions and the crowd. `GET /api/budget` shows today's count. To lower the cap, set the `AI_DAILY_NEURONS` var; it can't be raised above 9,000 without editing `AI_DAILY_LIMIT` in `worker/index.mjs`.
