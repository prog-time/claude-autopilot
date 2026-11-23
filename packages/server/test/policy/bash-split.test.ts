import { describe, expect, it } from 'vitest';
import {
  splitBashCommand,
  splitCommandParts,
  stripEnvAssignments,
  tokenizeArgs,
} from '../../src/policy/index.js';

describe('splitCommandParts', () => {
  it.each([
    ['git status && git push', ['git status', 'git push']],
    ['a || b', ['a', 'b']],
    ['a; b', ['a', 'b']],
    ['a | b', ['a', 'b']],
    ['a\nb', ['a', 'b']],
    ['a & b', ['a', 'b']],
    ['a;;b', ['a', 'b']],
    ['echo "a && b"', ['echo "a && b"']],
    ["echo 'a; b'", ["echo 'a; b'"]],
    ['echo "a \\" ; b"', ['echo "a \\" ; b"']],
    [String.raw`echo a\;b`, [String.raw`echo a\;b`]],
    ['cmd 2>&1', ['cmd 2>&1']],
    ['cmd &> out', ['cmd &> out']],
    ['cmd >&2', ['cmd >&2']],
    ['', []],
  ])('%j', (input, expected) => {
    expect(splitCommandParts(input)).toEqual(expected);
  });
});

describe('tokenizeArgs', () => {
  it.each([
    ['git push origin x', ['git', 'push', 'origin', 'x']],
    ['git push \'origin\' "issues-1"', ['git', 'push', 'origin', 'issues-1']],
    ['echo "a b"  c', ['echo', 'a b', 'c']],
    ["echo 'a\\b'", ['echo', 'a\\b']],
    ['echo "a\\"b" "x\\y"', ['echo', 'a"b', 'x\\y']],
    ['echo a\\ b', ['echo', 'a b']],
    ['echo a\\\nb', ['echo', 'ab']],
    ['echo "a\\\nb"', ['echo', 'ab']],
    ['echo ""', ['echo', '']],
    ['echo "unterminated', ['echo', 'unterminated']],
    ['   ', []],
  ])('%j', (input, expected) => {
    expect(tokenizeArgs(input)).toEqual(expected);
  });
});

describe('stripEnvAssignments', () => {
  it.each([
    [
      ['A=1', 'B=2', 'git', 'push'],
      ['git', 'push'],
    ],
    [
      ['git', 'A=1'],
      ['git', 'A=1'],
    ],
    [['A=1'], []],
    [[], []],
  ])('%j', (input, expected) => {
    expect(stripEnvAssignments(input)).toEqual(expected);
  });
});

describe('splitBashCommand', () => {
  it('splits, strips VAR=value and tokenizes', () => {
    expect(splitBashCommand('FOO=1 git status && BAR="a b" git push origin x; A=1')).toEqual([
      ['git', 'status'],
      ['git', 'push', 'origin', 'x'],
    ]);
  });
});

describe('comments', () => {
  it('drops a comment so an apostrophe in it does not open a quote', () => {
    expect(splitBashCommand("echo x # it's\ngit push origin main")).toEqual([
      ['echo', 'x'],
      ['git', 'push', 'origin', 'main'],
    ]);
  });

  it('keeps # inside a word', () => {
    expect(splitBashCommand('echo a#b ${#x}')).toEqual([['echo', 'a#b', '${#x}']]);
  });
});
