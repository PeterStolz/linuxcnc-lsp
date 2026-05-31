import { tokenizeHal } from './tokenizer';
import { HalToken, HalTokenKind, HalLogicalLine } from './tokens';
import {
  HalFile, HalStatement, HAL_COMMAND_SET, BaseStatement,
  LoadrtStatement, ModParam, NetStatement, NetLink,
} from './ast';

/** Parse a HAL document into an AST. Never throws; malformed lines become
 *  `error` statements so analysis of the rest of the file continues. */
export function parseHal(text: string): HalFile {
  const lines = tokenizeHal(text);
  const statements: HalStatement[] = [];
  for (const line of lines) {
    const stmt = parseLine(line);
    if (stmt) statements.push(stmt);
  }
  return { statements };
}

function span(line: HalLogicalLine, tokens: HalToken[]): { start: number; end: number } {
  if (tokens.length === 0) return { start: line.start, end: line.end };
  return { start: tokens[0].start, end: tokens[tokens.length - 1].end };
}

function isValue(t: HalToken): boolean {
  return (
    t.kind === HalTokenKind.Word ||
    t.kind === HalTokenKind.Number ||
    t.kind === HalTokenKind.String ||
    t.kind === HalTokenKind.IniRef ||
    t.kind === HalTokenKind.EnvVar
  );
}

function parseLine(line: HalLogicalLine): HalStatement | undefined {
  const toks = line.tokens;
  if (toks.length === 0) return undefined; // comment-only or blank line

  const first = toks[0];
  const cmd = first.text.toLowerCase();
  const base = { ...span(line, toks), comment: line.comment };

  if (first.kind !== HalTokenKind.Word || !HAL_COMMAND_SET.has(cmd)) {
    return {
      kind: 'error',
      ...base,
      tokens: toks,
      message: `Expected a HAL command, found '${first.text}'`,
    };
  }

  const rest = toks.slice(1);
  const commandToken = first;

  switch (cmd) {
    case 'loadrt':
      return parseLoadrt(commandToken, rest, base);
    case 'loadusr': {
      const flags = rest.filter((t) => t.kind === HalTokenKind.Word && t.text.startsWith('-'));
      const commandArgs = rest.filter((t) => !(t.kind === HalTokenKind.Word && t.text.startsWith('-')));
      return { kind: 'loadusr', command: cmd, commandToken, ...base, flags, commandArgs };
    }
    case 'net':
      return parseNet(commandToken, rest, base);
    case 'setp':
      return { kind: 'setp', command: cmd, commandToken, ...base, pinToken: rest[0], valueToken: rest[1] };
    case 'sets':
      return { kind: 'sets', command: cmd, commandToken, ...base, signalToken: rest[0], valueToken: rest[1] };
    case 'addf':
    case 'delf':
    case 'initf':
      return {
        kind: cmd as 'addf' | 'delf' | 'initf', command: cmd, commandToken, ...base,
        functionToken: rest[0], threadToken: rest[1], positionToken: rest[2],
      };
    case 'linkps':
      return parseLink(cmd, commandToken, rest, base);
    case 'linksp':
      return parseLink(cmd, commandToken, rest, base);
    case 'linkpp':
      return parseLink(cmd, commandToken, rest, base);
    case 'unlinkp':
      return { kind: 'unlinkp', command: cmd, commandToken, ...base, pinToken: rest[0] };
    case 'newsig':
      return { kind: 'newsig', command: cmd, commandToken, ...base, signalToken: rest[0], typeToken: rest[1] };
    case 'delsig':
    case 'gets':
    case 'getp':
      return { kind: cmd as 'delsig' | 'gets' | 'getp', command: cmd, commandToken, ...base, targetToken: rest[0] };
    case 'alias':
    case 'unalias': {
      const aliasKind =
        rest[0]?.text === 'pin' ? 'pin' : rest[0]?.text === 'param' ? 'param' : undefined;
      if (cmd === 'alias') {
        return {
          kind: 'alias', command: cmd, commandToken, ...base, aliasKind,
          originalToken: rest[1], aliasToken: rest[2],
        };
      }
      return { kind: 'unalias', command: cmd, commandToken, ...base, aliasKind, aliasToken: rest[1] };
    }
    case 'source':
      return { kind: 'source', command: cmd, commandToken, ...base, fileToken: rest[0] };
    case 'unloadrt':
    case 'unloadusr':
    case 'unload':
    case 'waitusr':
      return { kind: cmd, command: cmd, commandToken, ...base, args: rest };
    default:
      // start, stop, show, list, save, status, lock, unlock, help, echo,
      // unecho, print, debug, item
      return { kind: 'generic', command: cmd, commandToken, ...base, args: rest };
  }
}

function parseLoadrt(
  commandToken: HalToken,
  rest: HalToken[],
  base: Pick<BaseStatement, 'start' | 'end' | 'comment'>,
): LoadrtStatement {
  let componentToken: HalToken | undefined;
  const modparams: ModParam[] = [];
  let names: string[] | undefined;
  let namesToken: HalToken | undefined;
  let count: number | undefined;
  let countToken: HalToken | undefined;
  let configToken: HalToken | undefined;

  let i = 0;
  // First non-modparam token is the component (Word or IniRef).
  if (rest[0] && (rest[0].kind === HalTokenKind.Word || rest[0].kind === HalTokenKind.IniRef)) {
    // Only treat as the component if it is NOT immediately a `key=value`.
    if (rest[1]?.kind !== HalTokenKind.Equals) {
      componentToken = rest[0];
      i = 1;
    }
  }

  for (; i < rest.length; i++) {
    const t = rest[i];
    if (t.kind === HalTokenKind.Word && rest[i + 1]?.kind === HalTokenKind.Equals) {
      const nameToken = t;
      const valueToken = rest[i + 2] && isValue(rest[i + 2]) ? rest[i + 2] : undefined;
      modparams.push({ nameToken, valueToken });
      const lname = nameToken.text.toLowerCase();
      if (lname === 'names' && valueToken) {
        namesToken = valueToken;
        names = valueToken.text.split(',').map((s) => s.trim()).filter(Boolean);
      } else if (lname === 'count' && valueToken) {
        countToken = valueToken;
        const n = parseInt(valueToken.text, 10);
        if (!Number.isNaN(n)) count = n;
      } else if (lname === 'config' && valueToken) {
        configToken = valueToken;
      }
      i += 2; // consumed name = value
    }
    // lone words / stray tokens are ignored (tolerant)
  }

  return {
    kind: 'loadrt', command: 'loadrt', commandToken, ...base,
    componentToken, modparams, names, namesToken, count, countToken, configToken,
  };
}

function parseNet(
  commandToken: HalToken,
  rest: HalToken[],
  base: Pick<BaseStatement, 'start' | 'end' | 'comment'>,
): NetStatement {
  const signalToken = rest[0];
  const links: NetLink[] = [];
  let arrow: '<=' | '=>' | undefined;
  for (let i = 1; i < rest.length; i++) {
    const t = rest[i];
    if (t.kind === HalTokenKind.Arrow) {
      arrow = t.text as '<=' | '=>';
      continue;
    }
    if (t.kind === HalTokenKind.Word || t.kind === HalTokenKind.IniRef) {
      links.push({ pinToken: t, arrow });
    }
  }
  return { kind: 'net', command: 'net', commandToken, ...base, signalToken, links };
}

function parseLink(
  cmd: string,
  commandToken: HalToken,
  rest: HalToken[],
  base: Pick<BaseStatement, 'start' | 'end' | 'comment'>,
): HalStatement {
  let firstToken: HalToken | undefined = rest[0];
  let arrow: '<=' | '=>' | undefined;
  let secondToken: HalToken | undefined;
  if (rest[1]?.kind === HalTokenKind.Arrow) {
    arrow = rest[1].text as '<=' | '=>';
    secondToken = rest[2];
  } else {
    secondToken = rest[1];
  }
  return {
    kind: cmd as 'linkps' | 'linksp' | 'linkpp',
    command: cmd, commandToken, ...base, firstToken, secondToken, arrow,
  };
}
