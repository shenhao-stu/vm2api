/**
 * Bounded backpressure-aware write for HTTP responses.
 *
 * `response.write()` is called exactly once. A `true` (or `undefined`, for
 * minimal stubs) return means the chunk was accepted and the promise resolves
 * immediately. A `false` return means the socket buffer is full, so the promise
 * resolves only once the stream emits `drain`, and rejects promptly when the
 * downstream goes away, the caller aborts, or the drain wait times out.
 *
 * Errors are generic on purpose: `error.code` is either `client_cancelled`
 * (close/destroy/abort before the chunk was flushed) or
 * `downstream_write_timeout`. Messages never contain the chunk payload.
 */

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_CHUNK_BYTES = 32 * 1024
const DEFAULT_MAX_DURATION_MS = 5 * 60_000

export const WRITE_CLIENT_CANCELLED = 'client_cancelled'
export const WRITE_DOWNSTREAM_TIMEOUT = 'downstream_write_timeout'

// Node error codes that mean "the other side is already gone".
const GONE_CODES = new Set([
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_ALREADY_FINISHED',
  'ERR_STREAM_PUSH_AFTER_EOF',
  'EPIPE',
  'ECONNRESET',
])

function cancelledError(message, cause) {
  const error = new Error(message)
  error.code = WRITE_CLIENT_CANCELLED
  if (cause !== undefined) error.cause = cause
  return error
}

function timeoutError(timeoutMs) {
  const error = new Error(`Downstream write did not drain within ${timeoutMs}ms`)
  error.code = WRITE_DOWNSTREAM_TIMEOUT
  return error
}

function normalizeFailure(err, fallbackMessage) {
  if (err && GONE_CODES.has(err.code)) return cancelledError(fallbackMessage, err)
  if (err instanceof Error) return err
  // Never stringify unknown values: they may carry payload bytes.
  const error = new Error(fallbackMessage)
  error.cause = err
  return error
}

function streamIsGone(response) {
  if (!response) return true
  if (response.destroyed === true) return true
  if (response.writableEnded === true) return true
  if (response.writableFinished === true) return true
  if (response.writable === false) return true
  return false
}

/**
 * Write one chunk to `response`, waiting for `drain` when backpressure hits.
 *
 * @param {object} response writable stream (real `http.ServerResponse`, or a
 *   stub exposing `write`; `on`/`removeListener` are used when available)
 * @param {string|Buffer|Uint8Array} chunk payload written exactly once
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
 * @returns {Promise<void>} resolves when the chunk is accepted or drained
 */
export async function writeWithBackpressure(response, chunk, options = {}) {
  const opts = options || {}
  const signal = opts.signal || null
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs

  if (response == null || typeof response.write !== 'function') {
    throw new TypeError('writeWithBackpressure requires a writable response')
  }
  if (signal && signal.aborted) {
    throw cancelledError('Write aborted before it was attempted')
  }
  if (streamIsGone(response)) {
    throw cancelledError('Downstream is already closed; chunk was not written')
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null

    const detach = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (typeof response.removeListener === 'function') {
        response.removeListener('drain', onDrain)
        response.removeListener('close', onClose)
        response.removeListener('error', onError)
      }
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
    }

    const settle = (fn, value) => {
      if (settled) return
      settled = true
      detach()
      fn(value)
    }

    // Function declarations so the listener identities exist before detach runs.
    function onDrain() {
      settle(resolve)
    }
    function onClose() {
      settle(reject, cancelledError('Downstream closed before the chunk was flushed'))
    }
    function onError(err) {
      settle(reject, normalizeFailure(err, 'Downstream stream error while awaiting drain'))
    }
    function onAbort() {
      settle(reject, cancelledError('Write aborted while awaiting drain'))
    }

    const canListen = typeof response.on === 'function'

    if (signal) {
      if (signal.aborted) {
        settle(reject, cancelledError('Write aborted before it was attempted'))
        return
      }
      if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    // Attach before write so a synchronous close/error/drain emission cannot be
    // missed between the write call and listener installation.
    if (canListen) {
      response.on('close', onClose)
      response.on('error', onError)
      response.on('drain', onDrain)
    }

    let accepted
    try {
      accepted = response.write(chunk)
    } catch (err) {
      settle(reject, normalizeFailure(err, 'Downstream write threw'))
      return
    }

    // A pathological stream may emit drain synchronously inside write().
    if (settled) return

    if (accepted !== false) {
      // `true` (and `undefined` from simple stubs) means "accepted".
      settle(resolve)
      return
    }

    if (streamIsGone(response)) {
      settle(reject, cancelledError('Downstream closed before the chunk was buffered'))
      return
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        settle(reject, timeoutError(timeoutMs))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
  })
}

function asBytes(chunk) {
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  throw new TypeError('writeChunkedWithBackpressure requires a string or byte array')
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Write a large logical payload in ordered byte chunks.
 *
 * Chunking is a transport detail: callers still pass one SSE event or one
 * response body, and the bytes are written in exactly the same order. Each
 * chunk observes the same close/error/abort handling as writeWithBackpressure.
 * The drain timeout bounds a stalled chunk; a separate total deadline keeps a
 * slow but continually advancing payload bounded without imposing a 30-second
 * deadline on a whole image. UTF-8 boundaries are preserved for string inputs
 * because virtual HTTP responses may decode each write independently.
 *
 * @param {object} response
 * @param {string|Buffer|Uint8Array} chunk
 * @param {{signal?: AbortSignal, timeoutMs?: number, maxDurationMs?: number, chunkBytes?: number}} [options]
 */
export async function writeChunkedWithBackpressure(response, chunk, options = {}) {
  const opts = options || {}
  const bytes = asBytes(chunk)
  const chunkBytes = Math.max(4, positiveInteger(opts.chunkBytes, DEFAULT_CHUNK_BYTES))
  const timeoutMs = positiveInteger(opts.timeoutMs, DEFAULT_TIMEOUT_MS)
  const maxDurationMs = positiveInteger(opts.maxDurationMs, DEFAULT_MAX_DURATION_MS)
  const startedAt = Date.now()
  const isText = typeof chunk === 'string'

  if (bytes.byteLength === 0) return writeWithBackpressure(response, chunk, { signal: opts.signal, timeoutMs })

  for (let offset = 0; offset < bytes.byteLength; ) {
    const remaining = maxDurationMs - (Date.now() - startedAt)
    if (remaining <= 0) throw timeoutError(maxDurationMs)
    let end = Math.min(offset + chunkBytes, bytes.byteLength)
    if (isText) {
      while (end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end--
    }
    const piece = bytes.subarray(offset, end)
    try {
      await writeWithBackpressure(response, isText ? piece.toString('utf8') : piece, {
        signal: opts.signal,
        timeoutMs: Math.min(timeoutMs, remaining),
      })
    } catch (error) {
      if (error.code === WRITE_DOWNSTREAM_TIMEOUT) {
        const queued = Math.max(0, Number(response.writableLength) || 0)
        error.message += ` [write_offset=${offset} write_bytes=${bytes.byteLength} queued=${queued}]`
      }
      throw error
    }
    offset = end
  }
}
