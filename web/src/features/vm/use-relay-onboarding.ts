import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, isApiError } from '@/lib/api'
import {
  errorText,
  isOpen,
  type Draft,
  type OnboardingSession,
  type OnboardingView,
} from './native-relay-onboarding-state'

export const relayKey = ['panel', 'native-relays'] as const
export const onboardingKey = [...relayKey, 'onboarding'] as const
const endpoint = '/api/panel/native-relays/onboarding'

function failureText(error: unknown): string {
  if (isApiError(error) && error.code) return errorText({ code: error.code })
  return error instanceof Error ? error.message : '请求失败'
}

/**
 * 接入流程的读取与操作。服务端未启用时（404）`view` 为 null，入口整体隐藏。
 * 有进行中的流程时 2 秒读一次，其余时间与 Relay 状态同频。
 */
export function useRelayOnboarding(enabled: boolean) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: onboardingKey,
    queryFn: async () => {
      try {
        return await api<OnboardingView>(endpoint)
      } catch (error) {
        if (isApiError(error) && error.status === 404) return null
        throw error
      }
    },
    enabled,
    retry: false,
    meta: { quiet: true },
    refetchInterval: (state) =>
      state.state.data?.sessions.some(isOpen) ? 2000 : 30000,
    refetchIntervalInBackground: true,
  })
  const [dialog, setDialog] = useState<{ seat: string | null } | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: onboardingKey })
  const start = useMutation({
    mutationFn: (draft: Draft) =>
      api<OnboardingSession>(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          operation_id: crypto.randomUUID(),
          name: draft.name,
          egress: draft.egress,
          org: Number(draft.org),
        }),
      }),
    retry: false,
    onSuccess: (session) => {
      qc.setQueryData<OnboardingView | null>(onboardingKey, (view) =>
        view
          ? { ...view, busy: true, sessions: [session, ...view.sessions] }
          : view
      )
      setDialog({ seat: session.seat })
    },
    onError: (error) => toast.error(`未开始接入：${failureText(error)}`),
    onSettled: refresh,
  })
  const change = useMutation({
    mutationFn: ({ seat, verb }: { seat: string; verb: 'retry' | 'abandon' }) =>
      api(`${endpoint}/${encodeURIComponent(seat)}/${verb}`, {
        method: 'POST',
        body: JSON.stringify({ operation_id: crypto.randomUUID() }),
      }),
    retry: false,
    onSuccess: (_data, { verb }) =>
      toast.success(verb === 'retry' ? '已重新开始这一步' : '已开始清理'),
    onError: (error) => toast.error(`操作未完成：${failureText(error)}`),
    onSettled: refresh,
  })
  const view = query.data ?? null
  const sessions = view?.sessions ?? []
  // 新席位上线后立即刷新 Relay 列表，让它的状态卡出现。
  const live = sessions.filter((session) => session.status === 'live').length
  useEffect(() => {
    if (live) void qc.invalidateQueries({ queryKey: relayKey, exact: true })
  }, [live, qc])
  return {
    view,
    sessions,
    current: sessions.find(isOpen) ?? null,
    unreachable: !!query.error && !!view,
    /** 后台执行服务停了：新的请求不会被接手，进度也不会前进。 */
    stalled: view?.runner_alive === false,
    refresh,
    dialog,
    setDialog,
    start,
    change,
  }
}

export type RelayOnboarding = ReturnType<typeof useRelayOnboarding>
