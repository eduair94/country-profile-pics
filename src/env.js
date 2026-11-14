import { existsSync } from 'node:fs'
import path from 'node:path'

/** Load `.env` from the working directory, if there is one (Node's built-in parser). */
export function loadEnv(file = path.resolve('.env')) {
  if (!existsSync(file) || typeof process.loadEnvFile !== 'function') return false
  process.loadEnvFile(file)
  return true
}
