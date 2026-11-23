const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Splits a Bash command on `&&`, `||`, `;`, `|`, `&` and newlines outside quotes.
 * `2>&1`, `>&2` and `&>` are not treated as separators.
 */
export function splitCommandParts(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);

    if (quote) {
      current += ch;
      if (quote === '"' && ch === '\\' && i + 1 < command.length) {
        current += command.charAt(++i);
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '\\' && i + 1 < command.length) {
      current += ch + command.charAt(++i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    // An unquoted `#` at the start of a word is a comment up to the newline. Without this an
    // apostrophe inside a comment would open a "quote" that swallows the following lines.
    if (ch === '#' && /^$|[ \t;|&(]$/.test(current.slice(-1))) {
      while (i + 1 < command.length && command.charAt(i + 1) !== '\n') i++;
      continue;
    }

    let isSeparator = ch === ';' || ch === '|' || ch === '\n';
    if (ch === '&') {
      const prev = command.charAt(i - 1);
      const next = command.charAt(i + 1);
      const isRedirect = (prev === '>' || prev === '<' || next === '>') && next !== '&';
      isSeparator = !isRedirect;
    }

    if (isSeparator) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);

  return parts
    .map((part) => part.replace(/^[ \t]+|[ \t]+$/g, ''))
    .filter((part) => part.length > 0);
}

/** Splits one command part into arguments, honouring quotes and backslash escapes. */
export function tokenizeArgs(part: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < part.length; i++) {
    const ch = part.charAt(i);

    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\' && i + 1 < part.length) {
        const next = part.charAt(++i);
        if (next === '\n') continue;
        current += '"\\$`'.includes(next) ? next : ch + next;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === '\\' && i + 1 < part.length) {
      const next = part.charAt(++i);
      if (next !== '\n') {
        current += next;
        inToken = true;
      }
    } else if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (inToken) tokens.push(current);

  return tokens;
}

/** Drops leading `VAR=value` assignments. */
export function stripEnvAssignments(tokens: string[]): string[] {
  let start = 0;
  while (start < tokens.length && ENV_ASSIGNMENT.test(tokens[start] ?? '')) start++;
  return tokens.slice(start);
}

/**
 * Splits a full Bash command into parts (step 4 of TZ 5.3): each part is
 * an argument list without leading `VAR=value`. Empty parts are omitted.
 */
export function splitBashCommand(command: string): string[][] {
  return splitCommandParts(command)
    .map((part) => stripEnvAssignments(tokenizeArgs(part)))
    .filter((tokens) => tokens.length > 0);
}
