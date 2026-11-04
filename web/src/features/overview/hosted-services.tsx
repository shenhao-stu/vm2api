import { Link } from '@tanstack/react-router'
import { GPT_CONSOLE_URL } from '@/config/hosted'
import { ArrowUpRight, KeyRound, Server, Sparkles } from 'lucide-react'
import { Logo } from '@/assets/logo'
import { useAuthStore } from '@/stores/auth-store'
import { navGroupsFor } from '@/components/layout/data/sidebar-data'

export function HostedServices() {
  const views = useAuthStore((s) => s.me?.views)
  const paths = new Set(
    navGroupsFor(views).flatMap((group) => group.items.map((item) => item.url))
  )
  return (
    <section aria-label='服务工作台' className='mb-6 grid gap-3 lg:grid-cols-2'>
      <article className='flex min-w-0 flex-col rounded-2xl border border-primary/20 bg-card p-5'>
        <div className='flex items-center gap-3'>
          <span className='grid size-10 place-items-center rounded-xl bg-primary/10 text-primary'>
            <Logo aria-hidden className='size-5' />
          </span>
          <div className='min-w-0 flex-1'>
            <h3 className='text-sm font-semibold'>Claude 托管</h3>
            <p className='mt-1 text-xs text-muted-foreground'>
              账号、线路、用量与风险审核
            </p>
          </div>
          <span className='rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary'>
            当前工作台
          </span>
        </div>
        <p className='mt-4 text-xs leading-6 text-muted-foreground'>
          Claude Key 只访问授权的 Claude 账号池。与 GPT Key
          分别计并发和用量，新建默认并发 1。
        </p>
        <div className='mt-4 flex flex-wrap items-center gap-4 text-xs font-medium'>
          {paths.has('/vm') ? (
            <Link
              to='/vm'
              className='inline-flex items-center gap-1.5 text-primary hover:underline'
            >
              <Server aria-hidden className='size-3.5' />
              管理账号
            </Link>
          ) : null}
          {paths.has('/keys') ? (
            <Link
              to='/keys'
              className='inline-flex items-center gap-1.5 text-primary hover:underline'
            >
              <KeyRound aria-hidden className='size-3.5' />
              管理两池 Key
            </Link>
          ) : null}
        </div>
      </article>
      <article className='flex min-w-0 flex-col rounded-2xl border bg-card p-5'>
        <div className='flex items-center gap-3'>
          <span className='grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground'>
            <Sparkles aria-hidden className='size-5' />
          </span>
          <div>
            <h3 className='text-sm font-semibold'>GPT / Codex 托管</h3>
            <p className='mt-1 text-xs text-muted-foreground'>
              独立的 GPT 源服务控制台
            </p>
          </div>
        </div>
        <p className='mt-4 text-xs leading-6 text-muted-foreground'>
          此工作台签发的 GPT Key 使用统一 API 地址；GPT 源控制台的原生 Key 和
          API 地址单独管理。
        </p>
        <a
          href={GPT_CONSOLE_URL}
          className='mt-4 inline-flex w-fit items-center gap-1.5 text-xs font-medium text-primary hover:underline'
        >
          进入 GPT 控制台
          <ArrowUpRight aria-hidden className='size-3.5' />
        </a>
      </article>
    </section>
  )
}
