import { afterEach, expect, test, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

test('keeps an isolated deployment on its configured GPT console', async () => {
  vi.stubEnv('VITE_GPT_CONSOLE_URL', 'https://vm2api.getoken.tech/codex/console#/welcome')
  const { GPT_CONSOLE_URL } = await import('./hosted')
  expect(GPT_CONSOLE_URL).toBe('https://vm2api.getoken.tech/codex/console#/welcome')
})

test('preserves the existing hosted console when no override is supplied', async () => {
  vi.stubEnv('VITE_GPT_CONSOLE_URL', '')
  const { GPT_CONSOLE_URL } = await import('./hosted')
  expect(GPT_CONSOLE_URL).toBe('https://storyboardbook.cn/codex')
})
