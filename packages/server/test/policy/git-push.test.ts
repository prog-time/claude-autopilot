import { describe, expect, it } from 'vitest';
import {
  evaluateBashGitPush,
  evaluateGitPushPart,
  isSafeGitPush,
  parseGitPush,
} from '../../src/policy/index.js';

describe('parseGitPush', () => {
  it.each([
    [[], { remote: null, refspecs: [], flags: [] }],
    [['origin'], { remote: 'origin', refspecs: [], flags: [] }],
    [['-u', 'origin', 'issues-1'], { remote: 'origin', refspecs: ['issues-1'], flags: ['-u'] }],
    [
      ['origin', 'a', 'b', '--force'],
      { remote: 'origin', refspecs: ['a', 'b'], flags: ['--force'] },
    ],
    [['origin', '--', '-x'], { remote: 'origin', refspecs: ['-x'], flags: ['--'] }],
  ])('%j', (args, expected) => {
    expect(parseGitPush(args)).toEqual(expected);
  });
});

const allowed = [
  'git push -u origin issues-12',
  'git push --set-upstream origin issues-12',
  'git push origin issues-12',
  'git push origin issues-12:issues-12',
  'git push origin -u issues-12',
  'git push "origin" \'issues-12\'',
  'git push origin issues-0',
  'FOO=bar git push origin issues-12',
  'git status && git push origin issues-12',
];

const asked = [
  // refspec to protected branches
  'git push origin :main',
  'git push origin :develop',
  'git push origin issues-12:main',
  'git push origin issues-12:develop',
  'git push origin refs/heads/main',
  'git push origin issues-12:refs/heads/develop',
  'git push origin HEAD:issues-12',
  'git push origin HEAD:main',
  'git push origin HEAD',
  'git push origin issues-1 :develop',
  'git push origin issues-12:issues-13',
  'git push origin refs/heads/issues-12',
  'git push origin issues-12:refs/heads/issues-12',
  'git push origin issues-12:',
  'git push origin issues-',
  'git push origin issues-12x',
  'git push origin Issues-12',
  // force refspec
  'git push origin +issues-12',
  'git push origin +issues-12:issues-12',
  'git push origin +issues-3',
  // several refspecs
  'git push origin issues-12 issues-13',
  'git push origin issues-12 main',
  // flags
  'git push --mirror origin issues-12',
  'git push --all origin',
  'git push --delete origin issues-12',
  'git push -d origin issues-12',
  'git push --tags origin issues-12',
  'git push --force origin issues-12',
  'git push -f origin issues-12',
  'git push --force-with-lease origin issues-12',
  'git push --force-with-lease=issues-12 origin issues-12',
  'git push -uf origin issues-12',
  'git push --dry-run origin issues-12',
  'git push -- origin issues-12',
  // remote
  'git push upstream issues-12',
  'git push https://github.com/x/y issues-12',
  'git push origin2 issues-12',
  'git push issues-12',
  // no refspec
  'git push',
  'git push origin',
  'git push -u origin',
  // chains and env
  'git status && git push origin issues-12:main',
  'git status; git push origin issues-12:main',
  'git status | git push origin issues-12:main',
  'git status || git push origin issues-12:main',
  'git status\ngit push origin issues-12:main',
  'FOO=bar git push origin issues-12:main',
  'FOO=bar BAZ=1 git push origin main',
  'git push origin issues-12 && git push origin main',
  'git push origin issues-12 & git push origin main',
  // global git options
  'git -C /tmp/repo push origin issues-12',
  'git -c core.x=y push origin issues-12',
  'git --git-dir=/x push origin issues-12',
  'git -c alias.p=push p origin issues-12:main',
  '/usr/bin/git push origin main',
  // substitutions / subshells
  'echo $(git push origin issues-12:main)',
  'echo `git push origin main`',
  '(git push origin main)',
  '{ git push origin main; }',
  // quotes do not hide the refspec
  "git push origin 'issues-12:main'",
  'git push origin "issues-12" ":main"',
  'git push origin issues-12\\:main',
  // wrappers and obfuscation: cannot be analysed, so never left to the prefix check
  'env git push origin main',
  'command git push origin main',
  'sudo git push origin main',
  'nohup git push origin main',
  'time git push origin main',
  '! git push origin main',
  'xargs git push origin main',
  'sh -c "git push origin main"',
  "bash -c 'git push origin main'",
  'eval "git push origin main"',
  'if true; then git push origin main; fi',
  'echo "git push origin main"',
  '$X push origin main',
  'gi$X push origin main',
  'git pu${E}sh origin main',
  "echo $'\\'' ; git push origin main ; echo '",
  "echo x # it's\ngit push origin main",
  'diff <(git push origin main) x',
  // env vars that change what git executes or where origin points
  'GIT_SSH_COMMAND=evil git push origin issues-12',
  'GIT_CONFIG_COUNT=1 git push origin issues-12',
  'PATH=/tmp git push origin issues-12',
  // whitespace bash does not split on
  'git push origin issues-12\r',
];

const notApplicable = [
  '',
  'git status',
  'git log --oneline',
  'git -C /tmp status',
  'git pull origin main',
  'ls && pnpm test',
  'FOO=1',
  'git',
  'echo $(date) && git status',
];

describe('evaluateBashGitPush', () => {
  it.each(allowed)('allow: %s', (command) => {
    expect(evaluateBashGitPush(command)).toBe('allow');
  });

  it.each(asked)('ask: %s', (command) => {
    expect(evaluateBashGitPush(command)).toBe('ask');
  });

  it.each(notApplicable)('not-applicable: %j', (command) => {
    expect(evaluateBashGitPush(command)).toBe('not-applicable');
  });
});

describe('isSafeGitPush', () => {
  it('requires remote origin', () => {
    expect(isSafeGitPush({ remote: null, refspecs: ['issues-1'], flags: [] })).toBe(false);
    expect(isSafeGitPush({ remote: 'origin', refspecs: ['issues-1'], flags: [] })).toBe(true);
  });
});

describe('evaluateGitPushPart', () => {
  it('ignores non-git commands and empty parts', () => {
    expect(evaluateGitPushPart([])).toBe('not-applicable');
    expect(evaluateGitPushPart(['ls'])).toBe('not-applicable');
  });
});
