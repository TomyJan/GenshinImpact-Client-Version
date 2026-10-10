import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import * as wwResources from '../utils/wwResources.js'

const indexUrl =
  'https://prod-cn-alicdn-gamestarter.kurogame.com/launcher/game/10003_oLNgHF1CESo51DGHN2odtp40e3oI1HfZ/G152/official/index.json'

async function loadDownloaderResources(level) {
  const requests = []
  let source = fs
    .readFileSync(new URL('down.js', import.meta.url), 'utf8')
    .replace(/^import .+\r?\n/gm, '')
    .replaceAll('import.meta.url', 'moduleUrl')
    .replace(/main\(\)\.catch\([\s\S]*$/, '')
  if (level)
    source = source.replace(
      "const resourceLevel = 'UHD'",
      `const resourceLevel = '${level}'`,
    )
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const files = await new AsyncFunction(
    'path',
    'https',
    'fileURLToPath',
    'dirname',
    'moduleUrl',
    'fetch',
    ...Object.keys(wwResources),
    source + '\nreturn await loadResources()',
  )(
    path,
    https,
    fileURLToPath,
    path.dirname,
    import.meta.url,
    async (url) => {
      requests.push(url)
      if (url === indexUrl) {
        return {
          ok: true,
          json: async () => ({
            cdnList: [{ url: 'https://cdn.example/' }],
            bundles: {
              UHD: { resourcePacks: ['common', 'uhd'] },
              HD: { resourcePacks: ['common', 'hd'] },
              SD: { resourcePacks: ['common', 'sd'] },
            },
            resourcePacks: Object.fromEntries(
              ['common', 'uhd', 'hd', 'sd'].map((name) => [
                name,
                {
                  indexFile: `${name}/index.json`,
                  baseUrl: `${name}/zip/`,
                },
              ]),
            ),
          }),
        }
      }
      const name = new URL(url).pathname.split('/')[1]
      return {
        ok: true,
        json: async () => ({
          resource: [{ dest: `Client/${name}.pak`, size: 1, md5: 'test' }],
        }),
      }
    },
    ...Object.values(wwResources),
  )
  return { files, requests }
}

test('downloader defaults to UHD and uses each pack download base', async () => {
  const { files, requests } = await loadDownloaderResources()
  assert.deepEqual(requests, [
    indexUrl,
    'https://cdn.example/common/index.json',
    'https://cdn.example/uhd/index.json',
  ])
  assert.deepEqual(
    files.map((file) => file.url),
    [
      'https://cdn.example/common/zip/Client/common.pak',
      'https://cdn.example/uhd/zip/Client/uhd.pak',
    ],
  )
})

test('downloader selects HD or SD without loading other quality packs', async () => {
  for (const level of ['HD', 'SD']) {
    const { files } = await loadDownloaderResources(level)
    assert.deepEqual(
      files.map((file) => file.dest),
      ['Client/common.pak', `Client/${level.toLowerCase()}.pak`],
    )
  }
})

test('invalid downloader resource level fails before fetching pack manifests', async () => {
  await assert.rejects(loadDownloaderResources('INVALID'), /资源等级/)
})
