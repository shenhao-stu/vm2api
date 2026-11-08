import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  qualityResultLabels,
  qualityTime,
  safetyLabel,
  type QualityProbeItem,
} from './quality-probe-data'

const phases: Record<string, string> = {
  cooldown: '静置中',
  confirming: '待二次确认',
  probing: '复测中',
  recovered: '已恢复',
}
const events: Record<string, string> = {
  scheduled: '安排复测',
  paused: '质量暂停',
  cooldown: '重新静置',
  probing: '开始复测',
  first_pass: '首次答对',
  confirming: '等待确认',
  recovered: '恢复调度',
  failed: '复测未通过',
  blocked: '条件未满足',
  aborted: '终止恢复',
  manual_reset: '手动恢复',
  config_changed: '题目已变更',
}
export function QualityProbeResults({
  items,
  threshold = 2,
  onResume,
  busy = false,
}: {
  items: QualityProbeItem[]
  threshold?: number
  onResume?: (item: QualityProbeItem) => void
  busy?: boolean
}) {
  if (!items.length)
    return <p className='text-sm text-muted-foreground'>暂无 GPT 账号</p>
  return (
    <div className='overflow-x-auto' aria-label='GPT 质量检测结果'>
      <table className='w-full min-w-[880px] text-left text-sm'>
        <thead className='text-muted-foreground'>
          <tr>
            {[
              '账号 / 槽位',
              '最近结果',
              '缓冲信号',
              '连续答错',
              '回答 / 原因',
              '探测时间',
              '调度',
              '自动恢复',
            ].map((label) => (
              <th key={label} className='p-3 font-medium'>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.vm_id} className='border-t align-top'>
              <td className='p-3'>
                <div className='max-w-56 font-medium break-words'>
                  {item.vm_name || item.vm_id}
                </div>
                {item.vm_name && item.vm_name !== item.vm_id && (
                  <div className='max-w-56 text-xs break-all text-muted-foreground'>
                    {item.vm_id}
                  </div>
                )}
              </td>
              <td className='p-3'>
                <Badge
                  variant={
                    item.last_result === 'wrong' ? 'destructive' : 'secondary'
                  }
                >
                  {qualityResultLabels[item.last_result || ''] ||
                    item.last_result ||
                    '尚未检测'}
                </Badge>
              </td>
              <td className='p-3'>
                <Badge
                  variant={
                    item.safety_buffering === true ? 'destructive' : 'outline'
                  }
                >
                  {safetyLabel(item.safety_buffering)}
                </Badge>
                {item.upstream_model && (
                  <div className='mt-1 text-xs text-muted-foreground'>
                    响应模型：{item.upstream_model}
                  </div>
                )}
                {item.safety_buffering_faster_model && (
                  <div className='mt-1 text-xs text-muted-foreground'>
                    配置备用：{item.safety_buffering_faster_model}
                  </div>
                )}
                {item.signal_test_at && (
                  <div className='mt-1 text-xs text-muted-foreground'>
                    {qualityTime(item.signal_test_at)}
                  </div>
                )}
              </td>
              <td className='p-3 tabular-nums'>
                {item.consecutive_wrong} / {threshold}
              </td>
              <td className='max-w-60 p-3 break-words'>
                {item.last_answer && (
                  <div className='font-mono'>{item.last_answer}</div>
                )}
                {item.last_error && (
                  <div className='text-muted-foreground'>{item.last_error}</div>
                )}
                {!item.last_answer && !item.last_error && '—'}
              </td>
              <td className='p-3 whitespace-nowrap tabular-nums'>
                {qualityTime(item.last_test_at)}
              </td>
              <td className='p-3'>
                <div
                  className={
                    item.paused ? 'text-destructive' : 'text-muted-foreground'
                  }
                >
                  {item.paused ? '质量暂停' : '未因质量暂停'}
                </div>
                {item.paused && onResume && (
                  <Button
                    className='mt-2'
                    size='sm'
                    variant='outline'
                    disabled={busy}
                    onClick={() => onResume(item)}
                  >
                    手动恢复
                  </Button>
                )}
              </td>
              <td className='min-w-48 p-3'>
                {item.recovery_phase && (
                  <Badge variant='outline'>
                    {phases[item.recovery_phase] || item.recovery_phase}
                  </Badge>
                )}
                {item.recovery_next_at && (
                  <div className='mt-1 text-xs text-muted-foreground'>
                    静置后复测：{qualityTime(item.recovery_next_at)}
                  </div>
                )}
                {!!item.recovery_history?.length && (
                  <details className='mt-2 text-xs'>
                    <summary className='cursor-pointer text-muted-foreground'>
                      恢复日志（{item.recovery_history.length}）
                    </summary>
                    <ol className='mt-2 space-y-2'>
                      {[...item.recovery_history].reverse().map((event, i) => (
                        <li key={`${event.at}-${i}`} className='border-l pl-2'>
                          <div>
                            {qualityTime(event.at)} ·{' '}
                            {events[event.event] || event.event}
                          </div>
                          {event.result && (
                            <div>
                              {qualityResultLabels[event.result] ||
                                event.result}
                            </div>
                          )}
                          {event.reason && <div>{event.reason}</div>}
                          {event.next_at && (
                            <div>下次 {qualityTime(event.next_at)}</div>
                          )}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {!item.recovery_phase && !item.recovery_history?.length && '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
