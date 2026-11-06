import {
  createBrowserHistory,
  createHashHistory,
  parseHref,
} from '@tanstack/history'
import { controllerSwitchEnabled } from './controller'

export function createConsoleHistory(
  win: Window = window,
  unified = controllerSwitchEnabled
) {
  if (!unified || !new URLSearchParams(win.location.search).has('controller'))
    return createHashHistory({ window: win })
  // The controller belongs to the document. Route search and anchors live inside the hash.
  return createBrowserHistory({
    window: win,
    parseLocation: () =>
      parseHref(win.location.hash.slice(1) || '/', win.history.state),
    createHref: (href) =>
      win.location.pathname + win.location.search + '#' + href,
  })
}
