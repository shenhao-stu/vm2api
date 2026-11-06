/** Hold SSE field lines until the blank delimiter so other writers cannot split an event. */
export function createSseFrameBuffer() {
  let pending = []
  return {
    push(line) {
      const frames = []
      const text = String(line)
      const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
      for (const value of lines) {
        const field = value.replace(/\r$/, '')
        if (field) pending.push(field)
        else if (pending.length) {
          frames.push(pending)
          pending = []
        }
      }
      return frames
    },
  }
}
