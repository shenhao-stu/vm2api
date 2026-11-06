import { describe, expect, it } from 'vitest'
import { controllerPath, controllerUrl, selectedController } from './controller'

describe('isolated controller selection', () => {
  it('is opt-in and ignores unknown or URL-shaped controllers', () => {
    expect(selectedController('?controller=codex', false)).toBe('main')
    expect(selectedController('?controller=https://other.example', true)).toBe(
      'main'
    )
    expect(selectedController('?controller=codex', true)).toBe('codex')
  })
  it('keeps the original login and operator identity on main', () => {
    for (const path of [
      '/api/panel/login',
      '/api/panel/logout',
      '/api/panel/me',
      '/api/panel/me?fresh=1',
      '/api/panel/users/a',
    ]) {
      expect(controllerPath(path, 'codex')).toBe(path)
    }
  })
  it('routes data, streaming and terminal paths to one fixed bridge', () => {
    for (const tail of [
      'vms',
      'request-logs?limit=20',
      'pool/stream',
      'vms/one/terminal',
    ]) {
      expect(controllerPath('/api/panel/' + tail, 'codex')).toBe(
        '/api/panel/codex-controller/' + tail
      )
      expect(controllerPath('/api/panel/' + tail, 'main')).toBe(
        '/api/panel/' + tail
      )
    }
    expect(controllerPath('/v1/responses', 'codex')).toBe('/v1/responses')
  })
  it('switches with a full navigation to discard queries and slot state', () => {
    const url = controllerUrl(
      'https://console.example/console?locale=zh#/vm/old',
      'codex'
    )
    expect(url).toBe(
      'https://console.example/console?locale=zh&controller=codex#/vm'
    )
    expect(controllerUrl(url, 'main')).toBe(
      'https://console.example/console?locale=zh#/vm'
    )
  })
})
