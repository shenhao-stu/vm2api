import { useAuthStore } from '@/stores/auth-store'
import {
  controllerSwitchEnabled,
  controllerUrl,
  selectedController,
} from '@/lib/controller'
import type { Controller } from '@/lib/controller'

export function ControllerSwitch() {
  const role = useAuthStore((state) => state.me?.role)
  if (!controllerSwitchEnabled || role !== 'admin') return null
  return (
    <select
      aria-label='服务'
      className='h-9 max-w-48 rounded-md border border-input bg-background px-2 text-sm'
      value={selectedController()}
      onChange={(event) =>
        window.location.assign(
          controllerUrl(window.location.href, event.target.value as Controller)
        )
      }
    >
      <option value='main'>Claude / ReClaude</option>
      <option value='codex'>Codex · AgentNAS</option>
    </select>
  )
}
