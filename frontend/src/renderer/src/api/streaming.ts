export interface SSERequestParams {
  endpoint: string
  body: any
  onMessage: (payload: any) => void
  onClose: () => void
  onError?: (err: any) => void
}

function extractErrorMessage(response: Response, fallback: string): Promise<string> {
  return (async () => {
    try {
      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const data = await response.json()
        const detail = data?.detail
        if (typeof detail === 'string') return detail
        if (detail?.message) return detail.message
        return data?.message || fallback
      }
      const text = await response.text()
      return text || fallback
    } catch {
      return fallback
    }
  })()
}

export function createSSEStreamingRequest(params: SSERequestParams) {
  const { endpoint, body, onMessage, onClose, onError } = params
  const controller = new AbortController()
  const signal = controller.signal
  // 服务端以 error 事件显式上报流中异常（见 backend/app/utils/stream_utils.py）：
  // 此时连接仍会正常收尾，若不拦截，消费方会在跑完错误处理后又跑一遍成功收尾
  // （例如编辑器先提示“续写失败”再提示“续写完成”，并把半截输出留在文档里）。
  // failed 保证 onError 与 onClose 互斥，且各自最多触发一次。
  let failed = false

  const finish = () => {
    if (failed) return
    onClose()
  }

  const fail = (err: any) => {
    if (failed) return
    failed = true
    onError?.(err)
  }

  fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  }).then(async response => {
    if (!response.ok) {
      const message = await extractErrorMessage(response, `请求失败：${response.status}`)
      throw new Error(message)
    }

    if (!response.body) {
      throw new Error('Response body is null')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) {
          finish()
          return
        }

        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() || ''

        for (const evt of events) {
          const lines = evt.split('\n').map(line => line.trim())
          const dataLines = lines
            .filter(line => line.startsWith('data: '))
            .map(line => line.slice(6))
          if (!dataLines.length) continue

          let payload: any
          try {
            payload = JSON.parse(dataLines.join(''))
          } catch {
            continue // ignore malformed chunk
          }
          // error 事件是终结性的：上报后立即中止读取，不再交给 onMessage
          if (typeof payload?.error === 'string' && payload.error.length) {
            fail(new Error(payload.error))
            controller.abort()
            return
          }
          onMessage(payload)
        }

        pump()
      }).catch(error => {
        if (error?.name === 'AbortError') {
          finish()
          return
        }
        fail(error)
      })
    }

    pump()
  }).catch(error => {
    if (error?.name === 'AbortError') {
      finish()
      return
    }
    fail(error)
  })

  return {
    cancel: () => {
      try {
        controller.abort()
      } catch {
        // noop
      }
    },
  }
}
