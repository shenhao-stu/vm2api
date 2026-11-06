// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import {
  filtersToApi,
  searchToFilters,
  validateLogsSearch,
} from '@/features/logs/search'
import { createConsoleHistory } from './console-history'

it('preserves the Codex controller, error filter and anchor through native navigation', () => {
  window.history.replaceState(
    {},
    '',
    '/console?controller=codex#/logs?kind=error#row'
  )
  const history = createConsoleHistory(window, true)
  try {
    expect(history.location.pathname).toBe('/logs')
    expect(history.location.hash).toBe('#row')
    expect(history.location.search).toBe('?kind=error')
    const search = validateLogsSearch(
      Object.fromEntries(new URLSearchParams(history.location.search))
    )
    expect(filtersToApi(searchToFilters(search), [])).toMatchObject({
      errorsOnly: true,
    })
    expect(history.createHref('/logs?vmId=example')).toBe(
      '/console?controller=codex#/logs?vmId=example'
    )
  } finally {
    history.destroy()
  }
})
