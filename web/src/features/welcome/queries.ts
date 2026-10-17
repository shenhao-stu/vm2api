import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { api } from '@/lib/api'
import { hasSession } from '@/lib/session'
import type { OnboardingActionInput, OnboardingPayload } from './types'

export const ONBOARDING_KEY = ['panel', 'onboarding'] as const

export function onboardingQueryOptions(enabled = hasSession()) {
  return queryOptions({
    queryKey: ONBOARDING_KEY,
    queryFn: () => api<OnboardingPayload>('/api/panel/onboarding'),
    enabled,
    retry: false,
  })
}

export function useOnboardingAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: OnboardingActionInput) =>
      api<OnboardingPayload>('/api/panel/onboarding', {
        method: 'PUT',
        body: JSON.stringify(
          typeof input === 'string' ? { action: input } : input
        ),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(ONBOARDING_KEY, data)
    },
  })
}
