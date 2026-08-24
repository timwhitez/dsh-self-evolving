import {
  booleanOption,
  parseCliArguments,
  requireNoPositionals,
  stringOption,
  type CliOptionDefinitions,
  type ParsedCliArguments,
} from '@dsh-self-evolving/core'

export type DshSelfEvolvingCommand = 'init' | 'run' | 'resume' | 'status' | 'audit' | 'doctor'

const COMMANDS = new Set<DshSelfEvolvingCommand>([
  'init',
  'run',
  'resume',
  'status',
  'audit',
  'doctor',
])

const INIT_OPTIONS: CliOptionDefinitions = {
  '--run-id': { kind: 'value', required: true },
  '--state-dir': { kind: 'value', required: true, allowLeadingDash: true },
  '--repo-root': { kind: 'value', allowLeadingDash: true },
  '--tb-root': { kind: 'value', allowLeadingDash: true },
  '--budget-usd': { kind: 'value', allowLeadingDash: true },
  '--profile': { kind: 'value' },
}

const STATE_OPTIONS: CliOptionDefinitions = {
  '--state-dir': { kind: 'value', required: true, allowLeadingDash: true },
}

const RUN_OPTIONS: CliOptionDefinitions = {
  ...STATE_OPTIONS,
  '--inject-crash-after-first-candidate': { kind: 'boolean' },
}

function usage(): never {
  throw new Error(
    'usage: dsh-self-evolving <init|run|resume|status|audit|doctor> --state-dir <path>',
  )
}

function definitionsFor(command: DshSelfEvolvingCommand): CliOptionDefinitions {
  if (command === 'init') return INIT_OPTIONS
  if (command === 'run') return RUN_OPTIONS
  return STATE_OPTIONS
}

export interface ParsedDshCliArguments {
  command: DshSelfEvolvingCommand
  parsed: ParsedCliArguments
  value(name: string): string | undefined
  flag(name: string): boolean
}

export function parseDshCliArguments(
  commandValue: string | undefined,
  argv: readonly string[],
): ParsedDshCliArguments {
  if (!COMMANDS.has(commandValue as DshSelfEvolvingCommand)) usage()
  const command = commandValue as DshSelfEvolvingCommand
  const parsed = parseCliArguments(argv, definitionsFor(command))
  requireNoPositionals(parsed.positionals)
  return {
    command,
    parsed,
    value: (name) => stringOption(parsed, name),
    flag: (name) => booleanOption(parsed, name),
  }
}
