export type Controller = 'main' | 'codex'

export const controllerSwitchEnabled =
  import.meta.env.VITE_CODEX_CONTROLLER === 'true'

export function selectedController(
  search = globalThis.location?.search ?? '',
  enabled = controllerSwitchEnabled
): Controller {
  return enabled && new URLSearchParams(search).get('controller') === 'codex'
    ? 'codex'
    : 'main'
}

// Authentication and operator accounts always belong to the main controller.
export function controllerPath(
  path: string,
  controller: Controller = selectedController()
): string {
  if (
    controller !== 'codex' ||
    !path.startsWith('/api/panel/') ||
    /^\/api\/panel\/(login|logout|me|users)([/?]|$)/.test(path)
  )
    return path
  return path.replace('/api/panel/', '/api/panel/codex-controller/')
}

export function controllerUrl(href: string, controller: Controller): string {
  const url = new URL(href)
  if (controller === 'codex') url.searchParams.set('controller', controller)
  else url.searchParams.delete('controller')
  // Never carry a slot ID or an import in progress into another controller.
  url.hash = '#/vm'
  return url.toString()
}
