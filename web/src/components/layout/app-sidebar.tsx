import { useAuthStore } from '@/stores/auth-store'
import { useLayout } from '@/context/layout-provider'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar'
import { AppTitle } from './app-title'
import { navGroupsFor, sidebarData } from './data/sidebar-data'
import { NavGroup } from './nav-group'
import { NavUser } from './nav-user'
import { WorkspaceSwitcher } from './workspace-switcher'

export function AppSidebar() {
  const { collapsible, variant } = useLayout()
  const me = useAuthStore((s) => s.me)
  const userName = useAuthStore((s) => s.user) || me?.user || 'admin'
  const groups = navGroupsFor(me?.views)
  return (
    <Sidebar
      collapsible={collapsible}
      variant={variant}
      className='workbench-sidebar'
    >
      <SidebarHeader className='gap-3 px-4 pt-4 pb-3 group-data-[collapsible=icon]:px-2'>
        <AppTitle version={me?.version} />
        <WorkspaceSwitcher />
      </SidebarHeader>
      <SidebarContent className='px-2 group-data-[collapsible=icon]:px-0'>
        {groups.map((group) => (
          <NavGroup key={group.title} {...group} />
        ))}
      </SidebarContent>
      <SidebarFooter>
        <NavUser
          user={{
            name: userName,
            email: me?.role || sidebarData.user.email,
            avatar: '',
          }}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
