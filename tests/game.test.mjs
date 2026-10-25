import test from 'node:test';
import assert from 'node:assert/strict';
import { dayNumber, dateForDay, givesAway, rarity, pointsFor, shareText, parseVerdict } from '../public/lib/game.mjs';


test('day numbers', () => {
  assert.equal(dayNumber('2026-10-25'), 1);
  assert.equal(dayNumber('2026-11-03'), 10);
  assert.equal(dateForDay(10), '2026-11-03');
  assert.equal(dayNumber('2027-03-14'), dayNumber('2027-03-13') + 1); // DST
});

test('giveaways', () => {
  assert.ok(givesAway('What is pykrete made of?', 'Pykrete'));
  assert.ok(givesAway('Which gas burst from Lake Nyos in 1986?', 'Lake Nyos'));
  assert.ok(givesAway('Why do olms live so long?', 'Olm'));
  assert.ok(!givesAway('Which Cameroonian lake suffocated a valley in 1986?', 'Lake Nyos'));
  assert.ok(!givesAway('What did Habakkuk want to float?', 'Pykrete'));
});

test('rarity and tiers', () => {
  const obvious = rarity({ obscurity: 5, simObvious: 0.95, crowdShare: 0.6, crowdN: 30 });
  const brilliant = rarity({ obscurity: 95, simObvious: 0.55, crowdShare: 0, crowdN: 30 });
  assert.equal(pointsFor(obvious, false), 10);
  assert.equal(pointsFor(brilliant, true), 100);
  assert.equal(pointsFor(brilliant, false), 85);
  assert.ok(rarity({ obscurity: 50, simObvious: 0.75, crowdShare: 0, crowdN: 0 }) > 0.3);
});

test('share text', () => {
  const t = shareText(3, [{ points: 100 }, { points: 10 }, { points: 0 }]);
  assert.match(t, /^KrONE #3 🎈 1,100 m\n🌟⬜⬛⬛⬛⬛⬛\n/);
});

test('verdict parsing', () => {
  assert.deepEqual(parseVerdict('Sure! {"valid": true, "obscurity": 140, "comment": "Nice"}'), { valid: true, obscurity: 100, comment: 'Nice' });
  assert.equal(parseVerdict('nope'), null);
  assert.equal(parseVerdict({ valid: false, obscurity: 3, comment: 'x' }).valid, false);
});
