import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  qualityEndpoint,
  qualityQueryKey,
  qualityPauseReason,
  qualityTime,
  type QualityProbeItem,
  type QualityProbeView,
} from '@/features/settings/quality-probe-data'
import { QualityProbePane } from '@/features/settings/quality-probe-pane'
import { QualityProbeResults } from '@/features/settings/quality-probe-results'

export function CodexQualityCard() {
  const qc = useQueryClient()
  const [settings, setSettings] = useState(false)
  const [resumeTarget, setResumeTarget] = useState<QualityProbeItem | null>(
    null
  )
  const q = useQuery({
    queryKey: qualityQueryKey,
    queryFn: () => api<QualityProbeView>(qualityEndpoint),
    refetchInterval: (query) =>
      query.state.data?.progress.running ? 2000 : 60_000,
  })
  const run = useMutation({
    mutationFn: () =>
      api<QualityProbeView>(qualityEndpoint + '/run', {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: (data) => qc.setQueryData(qualityQueryKey, data),
  })
  const resume = useMutation({
    mutationFn: (item: QualityProbeItem) =>
      api<{ schedulable: boolean }>(
        `/api/panel/vms/${encodeURIComponent(item.vm_id)}/schedulable`,
        {
          method: 'POST',
          body: JSON.stringify({
            schedulable: true,
            expected_reason: qualityPauseReason,
          }),
        }
      ),
    onSuccess: (result) => {
      setResumeTarget(null)
      void qc.invalidateQueries({ queryKey: qualityQueryKey })
      void qc.invalidateQueries({ queryKey: ['panel', 'vms'] })
      toast.success(
        result.schedulable
          ? '已解除质量暂停'
          : '质量暂停已解除，账号仍受其他限制'
      )
    },
  })
  const data = q.data
  const paused = data?.items.filter((item) => item.paused).length || 0
  const recovering =
    data?.items.filter((item) => item.paused && item.recovery_next_at).length ||
    0
  const progress = data?.progress
  const percent = progress?.total
    ? Math.min(100, (100 * progress.completed) / progress.total)
    : 0
  return (
    <section
      className='mb-4 space-y-4 rounded-xl border bg-card p-4'
      aria-label='GPT 答题质量探测'
    >
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <h2 className='text-base font-semibold'>GPT 答题质量探测</h2>
        <div className='flex gap-2'>
          <Button size='sm' variant='outline' onClick={() => setSettings(true)}>
            探测设置
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={
              !data ||
              data.progress.running ||
              run.isPending ||
              !(data.manual_run_allowed ?? data.config.enabled)
            }
            onClick={() => run.mutate()}
          >
            立即探测（使用额度）
          </Button>
        </div>
      </div>
      {data && (
        <>
          <div className='flex flex-wrap items-center gap-3 text-sm text-muted-foreground'>
            <Badge variant='outline'>
              {data.config.enabled ? '定时已开启' : '定时已关闭'}
            </Badge>
            <span>
              {data.config.model} · 每 {data.config.interval_minutes} 分钟 ·
              探测并发 {data.config.concurrency} 个账号
            </span>
            <span>连续答错 {data.config.failure_threshold} 次停调度</span>
            <span>双路检测：答题 + 安全缓冲</span>
            <Badge variant={paused ? 'destructive' : 'secondary'}>
              质量暂停 {paused} 个
            </Badge>
            <Badge variant='outline'>待恢复 {recovering} 个</Badge>
          </div>
          <div className='space-y-2 text-sm'>
            <div className='flex justify-between'>
              <span>
                {progress?.running
                  ? '正在探测'
                  : progress?.finished_at
                    ? '上轮已结束'
                    : '等待下一轮'}
              </span>
              <span className='tabular-nums'>
                {progress?.completed} / {progress?.total}
              </span>
            </div>
            <Progress value={percent} aria-label='探测轮次进度' />
            <p className='text-xs text-muted-foreground'>
              下次探测：
              {data.config.enabled
                ? qualityTime(progress?.next_run_at)
                : '定时已关闭'}
            </p>
          </div>
          <details open>
            <summary className='mb-2 cursor-pointer text-sm font-medium'>
              账号探测结果（{data.items.length}）
            </summary>
            <QualityProbeResults
              items={data.items}
              threshold={data.config.failure_threshold}
              onResume={setResumeTarget}
              busy={resume.isPending}
            />
          </details>
          <p className='text-xs leading-relaxed text-muted-foreground'>
            网络、429、无效答案不计错也不清零。质量暂停后静置24小时；首次答对仍暂停，至少10分钟后再次答对才恢复。非
            Luna 请求明确返回安全缓冲 true
            时暂停，未提供则为未知；配置备用模型不代表实际切换。人工、凭据、额度和出口限制始终有效，暂停不打断在途请求。
          </p>
        </>
      )}
      {(q.error || run.error || resume.error) && (
        <p role='alert' className='text-sm text-destructive'>
          {(q.error || run.error || resume.error)?.message}
        </p>
      )}
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-3xl'>
          <DialogTitle>GPT 探测设置</DialogTitle>
          <QualityProbePane showResults={false} />
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!resumeTarget}
        onOpenChange={(open) => !open && setResumeTarget(null)}
        title='解除这个账号的质量暂停？'
        desc='仅清除质量暂停与连续答错计数，不解除人工停用、凭据、额度或出口限制；此操作不调用模型。'
        confirmText='仅解除质量暂停'
        cancelBtnText='取消'
        isLoading={resume.isPending}
        handleConfirm={() => resumeTarget && resume.mutate(resumeTarget)}
      />
    </section>
  )
}
