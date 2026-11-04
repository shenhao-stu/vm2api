import { GPT_CONSOLE_URL } from '@/config/hosted'
import { ArrowUpRight, Sparkles } from 'lucide-react'
import { Logo } from '@/assets/logo'

export function WorkspaceSwitcher() {
  return (
    <nav
      aria-label='托管工作台'
      className='grid grid-cols-2 gap-1 rounded-xl border border-sidebar-border bg-background p-1 group-data-[collapsible=icon]:hidden'
    >
      <span
        aria-current='page'
        className='flex items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-2 py-2 text-xs font-semibold text-primary'
      >
        <Logo aria-hidden className='size-3.5' />
        Claude
      </span>
      <a
        href={GPT_CONSOLE_URL}
        className='flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
      >
        <Sparkles aria-hidden className='size-3.5' />
        GPT
        <ArrowUpRight aria-hidden className='size-3' />
      </a>
    </nav>
  )
}
