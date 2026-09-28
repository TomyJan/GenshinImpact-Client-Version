const RETRYABLE_STATUS_CODES = new Set([408, 429])

export async function fetchWithRetry(resource, options = {}) {
  const {
    timeout = 10000,
    retries = 2,
    retryDelay = 1000,
    ...fetchOptions
  } = options

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetch(resource, {
        ...fetchOptions,
        signal: controller.signal,
      })
      const shouldRetry =
        RETRYABLE_STATUS_CODES.has(response.status) || response.status >= 500

      if (!shouldRetry || attempt === retries) return response

      await response.body?.cancel()
      console.warn(
        `请求失败 (${response.status})，将在 ${retryDelay * (attempt + 1)}ms 后重试 (${attempt + 1}/${retries})...`,
      )
    } catch (error) {
      if (attempt === retries) throw error

      console.warn(
        `请求异常 (${error.name}: ${error.message})，将在 ${retryDelay * (attempt + 1)}ms 后重试 (${attempt + 1}/${retries})...`,
      )
    } finally {
      clearTimeout(timeoutId)
    }

    await new Promise((resolve) =>
      setTimeout(resolve, retryDelay * (attempt + 1)),
    )
  }
}
