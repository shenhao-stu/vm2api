import { Copy, KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { copyText } from '@/lib/clipboard'
import { Button } from '@/components/ui/button'

export function KeyConnectionGuide({ baseUrl }: { baseUrl: string }) {
  return (
    <section
      aria-label='两池 Key 接入说明'
      className='mb-5 rounded-2xl border bg-card p-5'
    >
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='flex items-center gap-2 text-sm font-semibold'>
          <KeyRound aria-hidden className='size-4 text-primary' />
          统一 API 地址
        </div>
        <div className='flex max-w-full min-w-0 items-center gap-2 rounded-lg border bg-background px-3 py-1'>
          <code className='min-w-0 text-xs break-all select-all'>
            {baseUrl}
          </code>
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='size-7 shrink-0'
            aria-label='复制 API 地址'
            onClick={async () => {
              if (await copyText(baseUrl)) toast.success('API 地址已复制')
              else toast.error('复制失败，请选中地址手动复制')
            }}
          >
            <Copy aria-hidden className='size-3.5' />
          </Button>
        </div>
      </div>
      <div className='mt-4 grid gap-4 border-t pt-4 text-xs sm:grid-cols-2'>
        <div>
          <h3 className='font-semibold'>Claude Key</h3>
          <p className='mt-1.5 leading-6 text-muted-foreground'>
            仅访问授权的 Claude 账号池；并发与额度独立计算。
          </p>
        </div>
        <div>
          <h3 className='font-semibold'>GPT Key</h3>
          <p className='mt-1.5 leading-6 text-muted-foreground'>
            仅访问绑定的 GPT 网关；这里签发的 Key 同样使用上方地址。
          </p>
        </div>
      </div>
      <p className='mt-3 text-[11px] leading-6 text-muted-foreground'>
        Claude Key 默认不额外限制并发，由账号池分配并排队。GPT
        源控制台签发的原生 Key 使用其自身 API 地址，与这里的 Key 分开管理。
      </p>
    </section>
  )
}
