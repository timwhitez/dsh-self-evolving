export interface CliValueOption {
  kind: 'value'
  required?: boolean
  /** Permit a separate single-dash value such as `-1`; `--...` is always an option token. */
  allowLeadingDash?: boolean
}

export interface CliBooleanOption {
  kind: 'boolean'
  required?: boolean
}

export type CliOptionDefinition = CliValueOption | CliBooleanOption
export type CliOptionDefinitions = Readonly<Record<string, CliOptionDefinition>>
export type ParsedCliOption = string | true

export interface ParsedCliArguments {
  options: Readonly<Record<string, ParsedCliOption>>
  positionals: string[]
}

function optionName(token: string): string | null {
  if (!token.startsWith('--') || token === '--') return null
  const separator = token.indexOf('=')
  return separator === -1 ? token : token.slice(0, separator)
}

function missingValue(name: string): never {
  throw new Error(`missing required ${name}`)
}

/**
 * Parse a fixed option schema in one pass.
 *
 * Unknown and duplicate options are rejected. Value options support both
 * `--name value` and `--name=value`. A separate `--...` token can never be
 * consumed as a value, which prevents a missing option value from swallowing
 * the next flag. `--` terminates option parsing.
 */
export function parseCliArguments(
  argv: readonly string[],
  definitions: CliOptionDefinitions,
): ParsedCliArguments {
  const options: Record<string, ParsedCliOption> = {}
  const positionals: string[] = []
  let positionalOnly = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (positionalOnly) {
      positionals.push(token)
      continue
    }
    if (token === '--') {
      positionalOnly = true
      continue
    }

    const name = optionName(token)
    if (name === null) {
      if (token.startsWith('-')) throw new Error(`unknown option ${token}`)
      positionals.push(token)
      continue
    }

    const definition = definitions[name]
    if (definition === undefined) throw new Error(`unknown option ${name}`)
    if (Object.prototype.hasOwnProperty.call(options, name)) {
      throw new Error(`duplicate option ${name}`)
    }

    const separator = token.indexOf('=')
    if (definition.kind === 'boolean') {
      if (separator !== -1) throw new Error(`option ${name} does not accept a value`)
      options[name] = true
      continue
    }

    let value: string
    if (separator !== -1) {
      value = token.slice(separator + 1)
      if (value.length === 0) missingValue(name)
    } else {
      const next = argv[index + 1]
      if (next === undefined || next === '--' || next.startsWith('--')) missingValue(name)
      if (next.startsWith('-') && definition.allowLeadingDash !== true) missingValue(name)
      value = next
      index += 1
    }
    options[name] = value
  }

  for (const [name, definition] of Object.entries(definitions)) {
    if (definition.required === true && !Object.prototype.hasOwnProperty.call(options, name)) {
      missingValue(name)
    }
  }

  return { options, positionals }
}

export function requireNoPositionals(positionals: readonly string[]): void {
  if (positionals.length > 0) {
    throw new Error(`unexpected positional argument ${JSON.stringify(positionals[0])}`)
  }
}

export function stringOption(
  parsed: ParsedCliArguments,
  name: string,
): string | undefined {
  const value = parsed.options[name]
  if (value === undefined) return undefined
  if (value === true) throw new Error(`option ${name} is not a value option`)
  return value
}

export function booleanOption(parsed: ParsedCliArguments, name: string): boolean {
  return parsed.options[name] === true
}

export function parseStatusCliArguments(argv: readonly string[]): {
  stateDir: string
  runId: string
} {
  const parsed = parseCliArguments(argv, {
    '--state-dir': { kind: 'value', required: true, allowLeadingDash: true },
    '--run-id': { kind: 'value', required: true },
  })
  requireNoPositionals(parsed.positionals)
  return {
    stateDir: stringOption(parsed, '--state-dir')!,
    runId: stringOption(parsed, '--run-id')!,
  }
}
