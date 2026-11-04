import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { GPT_CONSOLE_URL } from '@/config/hosted'
import { DOCS_URL } from '@/config/repo'
import {
  ArrowUpRight,
  Eye,
  EyeOff,
  KeyRound,
  LogIn,
  ShieldCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import { Logo } from '@/assets/logo'
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
    <div className='flex min-h-svh flex-col bg-background text-foreground'>
      <header className='mx-auto flex h-20 w-full max-w-6xl items-center justify-between px-5 sm:px-8'>
        <Link to='/welcome' className='flex items-center gap-2.5 rounded-xl'>
          <span className='workbench-brand grid size-9 place-items-center rounded-xl text-white'>
            <Logo aria-hidden className='size-4' />
          </span>
          <span className='text-sm font-semibold tracking-tight'>
            Claude{' '}
            <span className='font-normal text-muted-foreground'>/ 工作台</span>
          </span>
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
      <main className='flex flex-1 items-center justify-center px-5 pt-6 pb-16 sm:px-8'>
        <div className='grid w-full max-w-[1040px] overflow-hidden rounded-[20px] border bg-card shadow-[0_16px_60px_#17295408] md:grid-cols-2'>
          <aside className='hidden flex-col justify-between bg-accent/70 p-7 md:flex md:p-10 lg:p-12'>
            <div>
              <div className='mb-6 flex items-center gap-2 text-xs font-medium text-primary'>
                <span className='h-px w-6 bg-primary/50' />
                HOSTED WORKSPACE
              </div>
              <h2 className='text-2xl leading-snug font-semibold tracking-tight md:text-3xl'>
                Claude 与 GPT，
                <br />
                统一托管工作台。
              </h2>
              <p className='mt-4 max-w-sm text-sm leading-7 text-muted-foreground'>
                在一个工作台查看 Claude
                账号、出口线路和使用情况，按服务管理独立的 Claude 与 GPT Key。
              </p>
            </div>
            <div className='mt-8 hidden space-y-5 md:block'>
              <div className='flex gap-3'>
                <KeyRound
                  aria-hidden
                  className='mt-0.5 size-4 shrink-0 text-primary'
                />
                <div>
                  <p className='text-sm font-medium'>两池分开，边界清楚</p>
                  <p className='mt-1 text-xs leading-6 text-muted-foreground'>
                    各自授权、各自计并发，新建 Key 默认并发 1。
                  </p>
                </div>
              </div>
              <div className='flex gap-3'>
                <ShieldCheck
                  aria-hidden
                  className='mt-0.5 size-4 shrink-0 text-primary'
                />
                <div>
                  <p className='text-sm font-medium'>
                    运行与可服务状态分开呈现
                  </p>
                  <p className='mt-1 text-xs leading-6 text-muted-foreground'>
                    凭据、线路和风险审核共同决定账号是否可用。
                  </p>
                </div>
              </div>
            </div>
          </aside>
          <div className='p-7 md:p-10 lg:p-12'>
            <h1 className='text-xl font-semibold tracking-tight'>
              登录 Claude 工作台
            </h1>
            <p className='mt-2 text-sm leading-6 text-muted-foreground'>
              使用管理员分配的面板账号继续。
            </p>
            <form className='mt-7 space-y-5' onSubmit={onSubmit}>
              <div className='space-y-2'>
                <Label htmlFor='login-username'>用户名</Label>
                <Input
                  id='login-username'
                  className='h-11 rounded-xl bg-background/50'
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
                    className='h-11 rounded-xl bg-background/50 pe-10'
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
                  <Label htmlFor='login-api-base'>API Base</Label>
                  <Input
                    id='login-api-base'
                    placeholder='http://127.0.0.1:8787'
                    className='h-11 rounded-xl bg-background/50'
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
                className='mt-2 h-11 w-full rounded-xl font-medium'
                type='submit'
                disabled={pending}
              >
                <LogIn aria-hidden className='size-4' />
                {pending ? '登录中…' : '登录'}
              </Button>
            </form>
            <div className='mt-6 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground'>
              <Link to='/welcome' className='hover:text-primary'>
                使用指南
              </Link>
              <a
                href={`${DOCS_URL}guide/install`}
                target='_blank'
                rel='noreferrer'
                className='hover:text-primary'
              >
                部署文档
              </a>
            </div>
          </div>
        </div>
      </main>
      <footer className='px-5 pb-6 text-center text-[11px] text-muted-foreground'>
        Claude 与 GPT 源控制台分别管理登录和凭据。
      </footer>
    </div>
  )
}
