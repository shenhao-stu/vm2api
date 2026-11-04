export const JEV_KEY_MAX: number
export function splitJevKeyLine(line: string): { baseUrl: string; apiKey: string }
export function parseJevKeyInput(input: string | string[]): {
  keys: string[]
  total: number
  duplicates: number[]
  errors: { line: number; message: string }[]
  tooMany: boolean
}
