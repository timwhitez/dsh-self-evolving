import { STABLE_DEMO_PROFILE, V011_STABLE_DEMO_PROFILE } from './config.js'

export type InitProfile = typeof STABLE_DEMO_PROFILE | typeof V011_STABLE_DEMO_PROFILE

export function parseInitProfile(value: string | undefined): InitProfile {
  if (value === undefined || value === STABLE_DEMO_PROFILE) return STABLE_DEMO_PROFILE
  if (value === V011_STABLE_DEMO_PROFILE) return V011_STABLE_DEMO_PROFILE
  throw new Error(`init: unsupported profile ${JSON.stringify(value)}`)
}
