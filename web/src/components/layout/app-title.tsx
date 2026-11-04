import { Link } from '@tanstack/react-router'
import { DOCS_URL, REPO_URL } from '@/config/repo'
import { ArrowUpRight, BookOpen, PanelLeftClose } from 'lucide-react'
import { IconGithub } from '@/assets/brand-icons'
import { Logo } from '@/assets/logo'
import { Button } from '@/components/ui/button'
import {
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'

export function AppTitle({ version }: { version?: string }) {
  const { setOpenMobile, toggleSidebar } = useSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem className='px-1 py-2 group-data-[collapsible=icon]:px-0'>
        <div className='flex items-center gap-2'>
          <Link
            to='/overview'
            onClick={() => setOpenMobile(false)}
            aria-label='Claude 工作台总览'
            className='flex min-w-0 flex-1 items-center gap-3 rounded-xl'
          >
            <span className='workbench-brand grid size-10 shrink-0 place-items-center rounded-xl text-white group-data-[collapsible=icon]:size-8'>
              <Logo
                aria-hidden
                className='size-5 group-data-[collapsible=icon]:size-4'
              />
            </span>
            <span className='grid min-w-0 gap-1 leading-tight group-data-[collapsible=icon]:hidden'>
              <span className='text-[17px] font-semibold tracking-tight'>
                Claude
              </span>
              <span className='text-[11px] text-muted-foreground'>
                托管工作台
              </span>
            </span>
          </Link>
          <Button
            variant='ghost'
            size='icon'
            className='size-7 text-muted-foreground group-data-[collapsible=icon]:hidden'
            onClick={toggleSidebar}
            aria-label='切换侧栏'
          >
            <PanelLeftClose className='size-4' />
          </Button>
        </div>
        <div className='mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden'>
          <a
            href={REPO_URL}
            target='_blank'
            rel='noreferrer'
            className='inline-flex items-center gap-1 hover:text-foreground'
          >
            <IconGithub aria-hidden className='size-3.5' />
            GitHub
          </a>
          <a
            href={DOCS_URL}
            target='_blank'
            rel='noreferrer'
            className='inline-flex items-center gap-1 hover:text-foreground'
          >
            <BookOpen aria-hidden className='size-3.5' />
            文档
          </a>
          {version ? (
            <a
              href={`${REPO_URL}/releases/tag/v${version.replace(/^v/i, '')}`}
              target='_blank'
              rel='noreferrer'
              className='ms-auto inline-flex min-w-0 items-center gap-1 font-mono break-all hover:text-foreground'
            >
              v{version.replace(/^v/i, '')}
              <ArrowUpRight aria-hidden className='size-3 shrink-0' />
            </a>
          ) : null}
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
