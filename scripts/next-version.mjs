#!/usr/bin/env node
/**
 * Compute the next semver from conventional commit messages since the last tag.
 * Rules: BREAKING CHANGE or "!" footer -> major (capped at 0.x until v1.0 tag exists)
 *        feat: -> minor, fix:/refactor:/perf:/etc -> patch
 *        No qualifying commits -> patch bump as a floor.
 * Usage: node scripts/next-version.mjs [--since <tag>] [--current <ver>]
 *        Reads git log on its own when run as a script; exports pure functions for tests.
 */
import { execSync } from 'node:child_process';

export function parseCommitType(subject) {
  const breaking = /^[a-z]+(\([^)]+\))?!:/.test(subject)
    || /BREAKING[ -]CHANGE/.test(subject);
  if (breaking) return 'breaking';
  const m = subject.match(/^([a-z]+)(\([^)]+\))?:/);
  if (!m) return 'other';
  const type = m[1];
  if (type === 'feat') return 'minor';
  if (['fix', 'perf', 'refactor', 'revert', 'docs', 'style', 'test', 'chore', 'build', 'ci'].includes(type)) return 'patch';
  return 'other';
}

export function computeBump(subjects) {
  let bump = 'patch';
  for (const s of subjects) {
    const t = parseCommitType(s);
    if (t === 'breaking') return 'breaking';
    if (t === 'minor') bump = 'minor';
  }
  return bump;
}

export function applyBump(current, bump, hasV1) {
  const clean = current.replace(/^v/, '');
  const [maj, min, pat] = clean.split('.').map(Number);
  if (bump === 'breaking') {
    if (!hasV1) {
      // Stay 0.x — treat breaking as minor bump
      return `${maj}.${min + 1}.0`;
    }
    return `${maj + 1}.0.0`;
  }
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

export function nextVersion(current, subjects, hasV1 = false) {
  const bump = computeBump(subjects);
  return applyBump(current, bump, hasV1);
}

if (process.argv[1] && process.argv[1].endsWith('next-version.mjs')) {
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf('--since');
  const currentIdx = args.indexOf('--current');

  let since;
  let current;

  if (sinceIdx !== -1) since = args[sinceIdx + 1];
  if (currentIdx !== -1) current = args[currentIdx + 1];

  if (!since) {
    try {
      since = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
    } catch {
      since = null;
    }
  }
  if (!current) {
    if (since) {
      current = since;
    } else {
      try {
        const pkg = JSON.parse(
          (await import('node:fs')).readFileSync(
            new URL('../package.json', import.meta.url), 'utf8'
          )
        );
        current = pkg.version;
      } catch {
        current = '0.0.0';
      }
    }
  }

  const range = since ? `${since}..HEAD` : 'HEAD';
  let subjects = [];
  try {
    const log = execSync(`git log --format=%s ${range}`, { encoding: 'utf8' });
    subjects = log.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    subjects = [];
  }

  let hasV1 = false;
  try {
    const tags = execSync('git tag --list', { encoding: 'utf8' });
    hasV1 = tags.split('\n').some(t => /^v?[1-9]/.test(t.trim()));
  } catch {
    hasV1 = false;
  }

  const ver = nextVersion(current, subjects, hasV1);
  process.stdout.write(ver + '\n');
}
