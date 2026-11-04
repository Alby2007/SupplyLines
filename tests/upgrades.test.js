// Offer-deal lifecycle: enumerate()/bcstep stash the materialised pair on
// state._offers; whoever applies it must consume the field or the SAME pair
// re-deals every upgradePending — stale feats, stale epOffers, and an
// ok()-bypassed apply (e.g. 'Add a train' .reduce on an empty line list).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/state.js';
import { pickUpgrade, srand } from '../autoplay.mjs';

test('pickUpgrade consumes state._offers when it applies', () => {
  const s = createState();
  const applied = [];
  s.upgradePending = true;
  s._offers = [
    { name: 'fake-a', ok: () => true, apply: () => applied.push('a') },
    { name: 'fake-b', ok: () => true, apply: () => applied.push('b') },
  ];
  pickUpgrade(s, () => {}, srand(1), s._offers);
  assert.equal(s.upgradePending, false);
  assert.equal(s._offers, null);
  assert.equal(applied.length, 1);
});

test('pickUpgrade clears _offers when nothing is applicable', () => {
  const s = createState();
  s.upgradePending = true;
  s._offers = [{ name: 'fake', ok: () => true, apply: () => {} }];
  pickUpgrade(s, () => {}, srand(1), []);
  assert.equal(s.upgradePending, false);
  assert.equal(s._offers, null);
});
