import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseCommitType, computeBump, applyBump, nextVersion } from '../scripts/next-version.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/next-version.mjs', import.meta.url));

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'nv-test-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  return dir;
}

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

describe('next-version integration (real git repo)', () => {
  let dir;
  before(() => {
    dir = makeRepo();
    writeFileSync(join(dir, 'README.md'), '');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'chore: init');
    git(dir, 'tag', 'v0.1.0');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('BREAKING CHANGE footer in body is detected by the CLI', () => {
    git(dir, 'commit', '--allow-empty', '-m', 'fix: something\n\nBREAKING CHANGE: removed flag');
    const r = spawnSync('node', [SCRIPT, '--current', 'v0.1.0', '--since', 'v0.1.0'], {
      cwd: dir, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '0.2.0');
  });

  it('since-tag range: only commits after the tag are considered', () => {
    git(dir, 'tag', 'v0.2.0');
    git(dir, 'commit', '--allow-empty', '-m', 'fix: small fix after tag');
    const r = spawnSync('node', [SCRIPT, '--current', 'v0.2.0', '--since', 'v0.2.0'], {
      cwd: dir, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '0.2.1');
  });

  it('no-tag fallback: script exits without error and prints 0.1.0 for feat commit', () => {
    const noTagDir = makeRepo();
    try {
      writeFileSync(join(noTagDir, 'README.md'), '');
      git(noTagDir, 'add', '.');
      git(noTagDir, 'commit', '-m', 'feat: initial');
      // Pass --current 0.0.0 so the result is deterministic regardless of project version.
      const r = spawnSync('node', [SCRIPT, '--current', '0.0.0'], { cwd: noTagDir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      // 0.0.0 base + feat: → minor bump → 0.1.0
      assert.equal(r.stdout.trim(), '0.1.0');
    } finally {
      rmSync(noTagDir, { recursive: true, force: true });
    }
  });

  it('v1 tag detection: BREAKING CHANGE in body triggers major bump', () => {
    const v1Dir = makeRepo();
    try {
      writeFileSync(join(v1Dir, 'README.md'), '');
      git(v1Dir, 'add', '.');
      git(v1Dir, 'commit', '-m', 'chore: init');
      git(v1Dir, 'tag', 'v1.0.0');
      git(v1Dir, 'commit', '--allow-empty', '-m', 'fix: stuff\n\nBREAKING CHANGE: dropped flag');
      const r = spawnSync('node', [SCRIPT, '--current', 'v1.0.0', '--since', 'v1.0.0'], {
        cwd: v1Dir, encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), '2.0.0');
    } finally {
      rmSync(v1Dir, { recursive: true, force: true });
    }
  });
});
