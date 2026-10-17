export type OnboardingStatus = 'pending' | 'completed' | 'dismissed'
export type UsageProfile = 'personal' | 'relay'

export type OnboardingAction = 'complete' | 'dismiss' | 'reset'

export type OnboardingProfileAction = {
  action: 'profile'
  mode: UsageProfile
}

export type OnboardingActionInput = OnboardingAction | OnboardingProfileAction

export type OnboardingStep = {
  id: string
  done: boolean
}

export type OnboardingPayload = {
  user: string
  role: string
  status: OnboardingStatus
  updated_at: string | null
  needs_welcome: boolean
  base_url: string | null
  steps: OnboardingStep[]
  profile: UsageProfile | null
  guide_used: boolean
  done_count: number
  total: number
}
