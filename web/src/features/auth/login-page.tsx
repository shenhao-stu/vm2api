import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { GPT_CONSOLE_URL } from '@/config/hosted'
import { DOCS_URL } from '@/config/repo'
import { ArrowUpRight, Eye, EyeOff, LogIn, Layers } from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { loginRequest } from '@/lib/api'
import { apiBase, sameOriginPanel, setApiBase } from '@/lib/session'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ThemeSwitch } from '@/components/theme-switch'
import { onboardingQueryOptions } from '@/features/welcome/queries'
import { panelRedirectHref } from './redirect'

/** Login behavior is shared with the existing panel; this is its hosted workbench shell. */
export function LoginPage() {
  const search = useSearch({ from: '/login' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const signIn = useAuthStore((s) => s.signIn)
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [base, setBase] = useState(apiBase())
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const hideBase = sameOriginPanel()

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setPending(true)
    try {
      if (hideBase) setApiBase('')
      else setApiBase(base)
      const result = await loginRequest({
        username: username.trim(),
        password,
        base: hideBase ? '' : base.trim().replace(/\/$/, '') || apiBase(),
      })
      signIn(result.token, result.user)
      toast.success('登录成功')
      const next = panelRedirectHref(search.redirect)
      if (next) {
        await navigate({ href: next })
        return
      }
      let needsWelcome = false
      try {
        const onboarding = await queryClient.fetchQuery(
          onboardingQueryOptions(true)
        )
        needsWelcome = Boolean(onboarding.needs_welcome)
      } catch {
        needsWelcome = false
      }
      if (needsWelcome) {
        await navigate({ to: '/welcome', search: { setup: true } })
        return
      }
      await navigate({ to: '/overview' })
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className='welcome-theme flex min-h-svh flex-col bg-background text-foreground'>
      <header className='flex h-16 items-center justify-between border-b border-border/60 bg-card px-5 md:px-8'>
        <Link
          to='/welcome'
          className='flex items-center gap-2.5 rounded-md focus-visible:ring-2 focus-visible:ring-ring'
        >
          <span className='workbench-brand'>
            <Layers aria-hidden className='size-[18px]' />
          </span>
          <span className='text-lg font-bold tracking-tight'>Claude</span>
          <span className='text-xs text-muted-foreground'>工作台</span>
        </Link>
        <div className='flex items-center gap-3'>
          <a
            href={GPT_CONSOLE_URL}
            className='inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary'
          >
            GPT 控制台
            <ArrowUpRight aria-hidden className='size-3.5' />
          </a>
          <ThemeSwitch />
        </div>
      </header>
      <main className='flex flex-1 items-center justify-center px-4 py-10 md:px-8'>
        <div className='workbench-login-grid'>
          <aside className='workbench-login-aside hidden min-h-[520px] flex-col justify-between p-10 md:flex'>
            <div>
              <span className='workbench-brand mb-8'>
                <Layers aria-hidden className='size-7' />
              </span>
              <p className='text-xs font-semibold tracking-[0.2em] uppercase opacity-65'>
                CLAUDE WORKSPACE
              </p>
              <h2 className='mt-4 text-3xl leading-tight font-semibold tracking-tight'>
                Claude 与 GPT，
                <br />
                统一托管工作台。
              </h2>
              <p className='mt-5 max-w-sm text-sm leading-7 opacity-75'>
                查看账号健康、请求记录、调度状态与接入配置，按服务管理独立的
                Claude 与 GPT Key。
              </p>
            </div>
            <div className='flex items-center gap-3 border-t border-current/10 pt-5 text-xs opacity-70'>
              <span className='size-2 rounded-full bg-primary' />
              独立登录 · 凭据分开管理
            </div>
          </aside>
          <section className='flex min-h-[520px] flex-col justify-center px-6 py-10 sm:px-10'>
            <div className='mb-8'>
              <p className='mb-2 text-xs font-medium tracking-wide text-primary'>
                欢迎回来
              </p>
              <h1 className='text-2xl font-semibold tracking-tight md:text-[28px]'>
                登录 Claude 工作台
              </h1>
              <p className='mt-2 text-sm text-muted-foreground'>
                使用管理员分配的面板账号继续。
              </p>
            </div>
            <form className='space-y-4' onSubmit={onSubmit}>
              <div className='space-y-2'>
                <Label htmlFor='login-username'>用户名</Label>
                <Input
                  id='login-username'
                  className='h-10 rounded-lg'
                  autoComplete='username'
                  placeholder='输入面板用户名'
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='login-password'>密码</Label>
                <div className='relative'>
                  <Input
                    id='login-password'
                    type={showPassword ? 'text' : 'password'}
                    className='h-10 rounded-lg pe-10'
                    autoComplete='current-password'
                    placeholder='输入密码'
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type='button'
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    onClick={() => setShowPassword((v) => !v)}
                    className='absolute inset-y-0 end-0 flex w-10 items-center justify-center rounded-e-lg text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                  >
                    {showPassword ? (
                      <EyeOff aria-hidden className='size-4' />
                    ) : (
                      <Eye aria-hidden className='size-4' />
                    )}
                  </button>
                </div>
              </div>
              {hideBase ? null : (
                <div className='space-y-2'>
                  <Label htmlFor='login-api-base'>连接地址（可选）</Label>
                  <Input
                    id='login-api-base'
                    placeholder='留空时使用当前服务器'
                    className='h-10 rounded-lg'
                    value={base}
                    onChange={(e) => setBase(e.target.value)}
                  />
                </div>
              )}
              {error ? (
                <p className='text-sm text-destructive' role='alert'>
                  {error}
                </p>
              ) : null}
              <Button
                className='h-10 w-full rounded-lg font-medium'
                type='submit'
                disabled={pending}
              >
                <LogIn aria-hidden className='size-4' />
                {pending ? '登录中…' : '登录'}
              </Button>
            </form>
            <p className='mt-8 text-xs text-muted-foreground'>
              首次使用？
              <Link
                to='/welcome'
                className='font-medium text-primary hover:underline'
              >
                查看使用指南
              </Link>
              <span className='mx-2'>·</span>
              <a
                href={`${DOCS_URL}guide/install`}
                target='_blank'
                rel='noreferrer'
                className='hover:underline'
              >
                部署文档
              </a>
            </p>
          </section>
        </div>
      </main>
    </div>
  )
}
