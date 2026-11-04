import { Link } from '@tanstack/react-router'
import { Layers, PanelLeftClose, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'

export function AppTitle() {
  const { setOpenMobile, toggleSidebar } = useSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem className='flex h-14 items-center gap-2 px-3'>
        <Link
          to='/overview'
          onClick={() => setOpenMobile(false)}
          aria-label='Claude 工作台总览'
          className='flex min-w-0 flex-1 items-center gap-2.5 rounded-md outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring'
        >
          <span className='workbench-brand'>
            <Layers aria-hidden className='size-[18px]' />
          </span>
          <span className='text-lg font-bold tracking-tight group-data-[collapsible=icon]:hidden'>
            Claude
          </span>
          <span className='text-xs whitespace-nowrap text-muted-foreground group-data-[collapsible=icon]:hidden'>
            工作台
          </span>
        </Link>
        <Button
          variant='ghost'
          size='icon'
          className='size-8 shrink-0 group-data-[collapsible=icon]:hidden'
          onClick={toggleSidebar}
          aria-label='收起菜单'
        >
          <X className='md:hidden' />
          <PanelLeftClose className='max-md:hidden' />
        </Button>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
