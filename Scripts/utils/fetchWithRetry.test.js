import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import http from 'node:http'

import { fetchWithRetry } from './fetchWithRetry.js'

const servers = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections()
          server.close(resolve)
        }),
    ),
  )
})

async function startServer(handler) {
  const server = http.createServer(handler)
  servers.push(server)

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}

test('retries timed out requests and returns a later successful response', async () => {
  let attempts = 0
  const url = await startServer((request, response) => {
    attempts += 1
    if (attempts < 3) {
      setTimeout(() => response.end('late'), 200)
      return
    }

    response.end('ok')
  })

  const response = await fetchWithRetry(url, {
    timeout: 50,
    retries: 2,
    retryDelay: 1,
  })

  assert.equal(await response.text(), 'ok')
  assert.equal(attempts, 3)
})

test('retries transient HTTP errors', async () => {
  let attempts = 0
  const url = await startServer((request, response) => {
    attempts += 1
    response.statusCode = attempts === 1 ? 503 : 200
    response.end()
  })

  const response = await fetchWithRetry(url, { retries: 2, retryDelay: 1 })

  assert.equal(response.status, 200)
  assert.equal(attempts, 2)
})

test('retries rate-limited requests', async () => {
  let attempts = 0
  const url = await startServer((request, response) => {
    attempts += 1
    response.statusCode = attempts === 1 ? 429 : 200
    response.end()
  })

  const response = await fetchWithRetry(url, { retries: 2, retryDelay: 1 })

  assert.equal(response.status, 200)
  assert.equal(attempts, 2)
})

test('throws after network error retries are exhausted', async () => {
  let attempts = 0
  const url = await startServer((request) => {
    attempts += 1
    request.socket.destroy()
  })

  await assert.rejects(
    fetchWithRetry(url, { retries: 2, retryDelay: 1 }),
    TypeError,
  )
  assert.equal(attempts, 3)
})

test('does not retry non-transient HTTP errors', async () => {
  let attempts = 0
  const url = await startServer((request, response) => {
    attempts += 1
    response.statusCode = 404
    response.end()
  })

  const response = await fetchWithRetry(url, { retries: 2, retryDelay: 1 })

  assert.equal(response.status, 404)
  assert.equal(attempts, 1)
})
