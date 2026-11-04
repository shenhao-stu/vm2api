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
      className='workbench-topbar h-auto min-h-14 border-b bg-card xl:h-14 [&>div]:flex-wrap xl:[&>div]:flex-nowrap'
    >
      <div className='hidden items-center gap-2 text-xs whitespace-nowrap text-muted-foreground lg:flex'>
        <span>工作台</span>
        <ChevronRight aria-hidden className='size-3' />
        <span className='font-medium text-foreground'>{title}</span>
      </div>
      <Search placeholder='搜索页面…' />
      <div className='ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2 [&>div]:flex-wrap'>
        {actions}
        <ConfigDrawer />
        <ThemeSwitch />
        <ProfileDropdown />
      </div>
    </Header>
  )
}
