import { splitCommandParts, tokenizeArgs } from './bash-split.js';

export interface ParsedGitPush {
  /** First positional argument, `null` if absent. */
  remote: string | null;
  /** Positional arguments after the remote. */
  refspecs: string[];
  /** Every argument starting with `-` (including `--`), as written. */
  flags: string[];
}

/**
 * Result of `evaluateBashGitPush`:
 * - `not-applicable`: no part of the command is a `git push`; use the regular prefix check.
 * - `allow`: every `git push` part is safe (push of one `issues-N` branch to `origin`).
 *   The caller still checks the remaining parts of the command.
 * - `ask`: at least one `git push` part is not safe; go to step 5 (card "Разрешение"),
 *   not `deny`.
 */
export type GitPushDecision = 'allow' | 'ask' | 'not-applicable';

const SAFE_FLAGS = new Set(['-u', '--set-upstream']);
const SAFE_REFSPEC = /^issues-\d+$/;
const SAFE_REFSPEC_PAIR = /^issues-(\d+):issues-\1$/;

/** Parses the arguments that follow `git push`. */
export function parseGitPush(args: string[]): ParsedGitPush {
  const flags: string[] = [];
  const positional: string[] = [];
  let afterDoubleDash = false;

  for (const arg of args) {
    if (!afterDoubleDash && arg === '--') {
      afterDoubleDash = true;
      flags.push(arg);
    } else if (!afterDoubleDash && arg.startsWith('-')) {
      flags.push(arg);
    } else {
      positional.push(arg);
    }
  }

  return { remote: positional[0] ?? null, refspecs: positional.slice(1), flags };
}

/**
 * Auto-allow rule: remote is exactly `origin`, exactly one refspec `issues-N` or
 * `issues-N:issues-N` (same N, no leading `+`), the only flags are `-u` / `--set-upstream`.
 */
export function isSafeGitPush(push: ParsedGitPush): boolean {
  if (push.remote !== 'origin') return false;
  if (!push.flags.every((flag) => SAFE_FLAGS.has(flag))) return false;
  if (push.refspecs.length !== 1) return false;
  const refspec = push.refspecs[0] ?? '';
  return SAFE_REFSPEC.test(refspec) || SAFE_REFSPEC_PAIR.test(refspec);
}

function isGitBinary(token: string | undefined): boolean {
  return token === 'git' || (token?.endsWith('/git') ?? false);
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Variables that change what git or ssh executes / which repository `origin` points to. */
const DANGEROUS_ENV = /^(GIT_|SSH_|LD_|DYLD_|XDG_|PATH=|HOME=)/;

/**
 * True if a part that does not start with `git` still looks like a wrapped or obfuscated push
 * (`env git push`, `sh -c "git push …"`, `then git push`, `$X push`, `gi$X push`). Such parts
 * cannot be analysed reliably, so they go to the card instead of the prefix check.
 */
function looksLikeWrappedPush(tokens: string[]): boolean {
  if (!tokens.some((t) => /\bpush\b/.test(t))) return false;
  return tokens.some((t) => t.includes('git') || /[$`]/.test(t));
}

/** Decision for one tokenized command part (without `VAR=value`). */
export function evaluateGitPushPart(tokens: string[]): GitPushDecision {
  if (!isGitBinary(tokens[0])) return looksLikeWrappedPush(tokens) ? 'ask' : 'not-applicable';

  // `git pu${E}sh`, `git $X origin main`: the subcommand is only known at run time.
  if (/[$`]/.test(tokens[1] ?? '')) return 'ask';

  if (tokens[1] === 'push') {
    return isSafeGitPush(parseGitPush(tokens.slice(2))) ? 'allow' : 'ask';
  }

  // Global git options before the subcommand (`git -C dir push`, `git -c k=v push`)
  // are never auto-allowed, so the parser cannot be bypassed with them.
  if (tokens[1]?.startsWith('-') && tokens.slice(2).some((t) => t.includes('push'))) {
    return 'ask';
  }
  return 'not-applicable';
}

/**
 * Entry point for step 4 of the `canUseTool` policy (TZ 5.3). Splits the command into parts
 * and checks every `git push` part with `isSafeGitPush`. Wiring into `canUseTool` is done in
 * the stage-2 task: on `ask` go to step 5, on `allow` the push parts need no prefix from
 * `autoAllowBashPrefixes` (the other parts are still checked), on `not-applicable` the usual
 * prefix check applies. `git push …` prefixes in the config have no effect.
 */
export function evaluateBashGitPush(command: string): GitPushDecision {
  // A push hidden in a substitution, subshell or ANSI-C quote (`$'…'` has its own escaping
  // rules, so quote tracking is unreliable) cannot be analysed reliably.
  if (/\$\(|`|\$'|[<>]\(|\(\s*git\b|\{\s*git\b/.test(command) && /push/.test(command)) {
    return 'ask';
  }

  let result: GitPushDecision = 'not-applicable';
  for (const part of splitCommandParts(command)) {
    const all = tokenizeArgs(part);
    let start = 0;
    while (start < all.length && ENV_ASSIGNMENT.test(all[start] ?? '')) start++;
    const tokens = all.slice(start);
    if (tokens.length === 0) continue;

    let decision = evaluateGitPushPart(tokens);
    // `GIT_SSH_COMMAND=… git push origin issues-1` executes arbitrary code; other plain
    // `VAR=value` prefixes are dropped as in TZ 5.3 step 4.
    if (decision === 'allow' && all.slice(0, start).some((a) => DANGEROUS_ENV.test(a))) {
      decision = 'ask';
    }
    if (decision === 'ask') return 'ask';
    if (decision === 'allow') result = 'allow';
  }
  return result;
}
