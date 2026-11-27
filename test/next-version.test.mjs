import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommitType, computeBump, applyBump, nextVersion } from '../scripts/next-version.mjs';

describe('parseCommitType', () => {
  it('feat: -> minor', () => assert.equal(parseCommitType('feat: add thing'), 'minor'));
  it('feat(scope): -> minor', () => assert.equal(parseCommitType('feat(cli): add thing'), 'minor'));
  it('fix: -> patch', () => assert.equal(parseCommitType('fix: broken thing'), 'patch'));
  it('chore: -> patch', () => assert.equal(parseCommitType('chore: cleanup'), 'patch'));
  it('docs: -> patch', () => assert.equal(parseCommitType('docs: update readme'), 'patch'));
  it('bang suffix -> breaking', () => assert.equal(parseCommitType('feat!: drop node 16'), 'breaking'));
  it('scoped bang -> breaking', () => assert.equal(parseCommitType('feat(cli)!: change api'), 'breaking'));
  it('BREAKING CHANGE footer -> breaking', () => assert.equal(parseCommitType('fix: stuff\n\nBREAKING CHANGE: removed flag'), 'breaking'));
  it('unknown type -> other', () => assert.equal(parseCommitType('wip: stuff'), 'other'));
  it('no prefix -> other', () => assert.equal(parseCommitType('update something'), 'other'));
});

describe('computeBump', () => {
  it('empty list -> patch', () => assert.equal(computeBump([]), 'patch'));
  it('only patch commits -> patch', () => assert.equal(computeBump(['fix: a', 'chore: b']), 'patch'));
  it('feat present -> minor', () => assert.equal(computeBump(['fix: a', 'feat: b']), 'minor'));
  it('breaking present -> breaking regardless of order', () => {
    assert.equal(computeBump(['feat: a', 'feat!: drop flag', 'fix: b']), 'breaking');
  });
  it('breaking beats minor', () => assert.equal(computeBump(['feat: a', 'feat!: b']), 'breaking'));
});

describe('applyBump', () => {
  it('patch bump', () => assert.equal(applyBump('0.3.0', 'patch', false), '0.3.1'));
  it('minor bump', () => assert.equal(applyBump('0.3.0', 'minor', false), '0.4.0'));
  it('breaking stays 0.x when no v1', () => assert.equal(applyBump('0.3.0', 'breaking', false), '0.4.0'));
  it('breaking bumps major when v1 exists', () => assert.equal(applyBump('1.2.3', 'breaking', true), '2.0.0'));
  it('strips leading v', () => assert.equal(applyBump('v0.3.0', 'patch', false), '0.3.1'));
  it('minor resets patch', () => assert.equal(applyBump('0.3.5', 'minor', false), '0.4.0'));
  it('breaking with v1 resets minor and patch', () => assert.equal(applyBump('1.5.3', 'breaking', true), '2.0.0'));
});

describe('nextVersion', () => {
  it('feat commits produce minor bump on 0.x', () => {
    assert.equal(nextVersion('0.3.0', ['feat: add thing', 'fix: bug'], false), '0.4.0');
  });
  it('fix-only commits produce patch bump', () => {
    assert.equal(nextVersion('0.3.0', ['fix: a', 'fix: b'], false), '0.3.1');
  });
  it('breaking change stays 0.x (no v1)', () => {
    assert.equal(nextVersion('0.3.0', ['feat!: break api'], false), '0.4.0');
  });
  it('breaking change bumps major when v1 tag exists', () => {
    assert.equal(nextVersion('1.0.0', ['feat!: break api'], true), '2.0.0');
  });
  it('no commits -> patch', () => {
    assert.equal(nextVersion('0.3.0', [], false), '0.3.1');
  });
});
