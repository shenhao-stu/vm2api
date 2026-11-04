import type { ReactNode } from 'react'
import { useLocation } from '@tanstack/react-router'
import { VIEW_TITLES, type ViewId } from '@/config/nav'
import { ChevronRight } from 'lucide-react'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'

type AppHeaderProps = {
  actions?: ReactNode
}

export function AppHeader({ actions }: AppHeaderProps) {
  const path = useLocation({ select: (location) => location.pathname })
  const title = VIEW_TITLES[path.split('/')[1] as ViewId] || '工作台'
  return (
    <Header
      fixed
      className='h-auto min-h-16 border-b bg-card/90 backdrop-blur-xl xl:h-16 [&>div]:flex-wrap xl:[&>div]:flex-nowrap'
    >
      <div className='hidden shrink-0 items-center gap-2 text-xs text-muted-foreground md:flex'>
        <span>Claude 工作台</span>
        <ChevronRight aria-hidden className='size-3' />
        <span className='font-medium text-foreground'>{title}</span>
      </div>
      <div className='min-w-0 md:ms-3'>
        <Search placeholder='搜索页面…' />
      </div>
      <div className='ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2 [&>div]:flex-wrap'>
        {actions}
        <ConfigDrawer />
        <ThemeSwitch />
        <ProfileDropdown />
      </div>
    </Header>
  )
}
