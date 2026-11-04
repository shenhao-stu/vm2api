import { GPT_CONSOLE_URL } from '@/config/hosted'
import { ArrowUpRight } from 'lucide-react'

export function WorkspaceSwitcher() {
  return (
    <nav
      aria-label='托管工作台'
      className='flex flex-wrap items-center gap-2 px-2 py-1 text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden'
    >
      <span aria-current='page'>Claude 工作台</span>
      <span aria-hidden>·</span>
      <a
        href={GPT_CONSOLE_URL}
        className='inline-flex items-center gap-1 hover:text-primary'
      >
        GPT 控制台
        <ArrowUpRight aria-hidden className='size-3' />
      </a>
    </nav>
  )
}
