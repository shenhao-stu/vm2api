import { DOCS_URL, REPO_URL } from '@/config/repo'
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
      <SidebarHeader className='border-b p-0'>
        <AppTitle />
      </SidebarHeader>
      <SidebarContent>
        {groups.map((group) => (
          <NavGroup key={group.title} {...group} />
        ))}
      </SidebarContent>
      <SidebarFooter className='border-t'>
        <WorkspaceSwitcher />
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden'>
          <a
            href={REPO_URL}
            target='_blank'
            rel='noreferrer'
            className='hover:text-primary'
          >
            GitHub
          </a>
          <a
            href={DOCS_URL}
            target='_blank'
            rel='noreferrer'
            className='hover:text-primary'
          >
            文档
          </a>
          {me?.version ? (
            <a
              href={`${REPO_URL}/releases/tag/v${me.version.replace(/^v/i, '')}`}
              target='_blank'
              rel='noreferrer'
              className='min-w-0 font-mono break-all hover:text-primary'
            >
              v{me.version.replace(/^v/i, '')}
            </a>
          ) : null}
        </div>
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
