import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasSession } from '@/lib/session'
import { LoginPage } from '@/features/auth/login-page'
import { panelRedirectHref } from '@/features/auth/redirect'

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' && search.redirect
      ? { redirect: search.redirect }
      : {},
  beforeLoad: ({ search }) => {
    if (hasSession())
      throw redirect({ href: panelRedirectHref(search.redirect) || '/' })
  },
  component: LoginPage,
})
