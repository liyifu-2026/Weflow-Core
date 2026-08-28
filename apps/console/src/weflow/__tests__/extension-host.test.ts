import assert from 'node:assert/strict'
import test from 'node:test'

import { createPinia, setActivePinia } from 'pinia'
import type { ConsoleExtensionProjection } from '@weflow-leaif/contracts'

import { matchExtension, useExtensionStore } from '../stores/extensions.ts'
import { resolveEntryUrl, resolveMountHandle } from '../extensions/runtime.ts'

function projection(overrides: Partial<ConsoleExtensionProjection>): ConsoleExtensionProjection {
  return {
    solutionId: 'customer-support',
    version: '1.0.0',
    extensionId: 'support-console',
    title: '客服工作台',
    path: '/support',
    entry: '/plugins/customer-support/apps/support-web/dist/support-console.js',
    ...overrides,
  }
}

function fakeContainer() {
  return { innerHTML: '' } as HTMLElement
}

test('matchExtension resolves exact declared path', () => {
  const extensions = [projection({ path: '/support' })]
  assert.equal(matchExtension(extensions, '/support'), extensions[0])
})

test('matchExtension supports :param segments', () => {
  const extensions = [
    projection({ extensionId: 'a', path: '/x/:id/detail' }),
    projection({ extensionId: 'b', path: '/x/list' }),
  ]
  assert.equal(matchExtension(extensions, '/x/42/detail'), extensions[0])
  assert.equal(matchExtension(extensions, '/x/list'), extensions[1])
})

test('matchExtension prefers the deepest matching path', () => {
  const extensions = [
    projection({ extensionId: 'shallow', path: '/support' }),
    projection({ extensionId: 'deep', path: '/support/console' }),
  ]
  assert.equal(matchExtension(extensions, '/support/console'), extensions[1])
  assert.equal(matchExtension(extensions, '/support'), extensions[0])
})

test('matchExtension rejects different segment counts and unknown prefixes', () => {
  const extensions = [projection({ path: '/support' })]
  assert.equal(matchExtension(extensions, '/support/extra'), null)
  assert.equal(matchExtension(extensions, '/other'), null)
  assert.equal(matchExtension([], '/support'), null)
})

test('resolveEntryUrl maps root-relative entries onto the console origin', () => {
  assert.equal(
    resolveEntryUrl('/plugins/acme/apps/web/dist/bundle.js', { base: 'http://localhost:5173' }),
    'http://localhost:5173/plugins/acme/apps/web/dist/bundle.js',
  )
})

test('resolveEntryUrl maps relative entries onto solution-assets prefix', () => {
  assert.equal(
    resolveEntryUrl('apps/support-web/dist/support-console.js', {
      base: 'http://localhost:5173',
      solutionId: 'weflow.customer-support',
    }),
    'http://localhost:5173/plugins/weflow.customer-support/apps/support-web/dist/support-console.js',
  )
})

test('resolveEntryUrl keeps absolute URLs untouched', () => {
  assert.equal(
    resolveEntryUrl('https://assets.example.com/bundle.js', { base: 'http://localhost:5173' }),
    'https://assets.example.com/bundle.js',
  )
})

test('resolveMountHandle adopts async {unmount,navigate} handles', async () => {
  let unmounted = 0
  const navigated: string[] = []
  const handle = await resolveMountHandle({
    mountResult: Promise.resolve({
      unmount: () => {
        unmounted += 1
      },
      navigate: (fullPath: string) => {
        navigated.push(fullPath)
      },
    }),
    mod: null,
    container: fakeContainer(),
    fallbackNavigate: () => {
      throw new Error('fallback should not be used')
    },
  })
  handle.unmount()
  handle.navigate('/foo')
  assert.equal(unmounted, 1)
  assert.deepEqual(navigated, ['/foo'])
})

test('resolveMountHandle falls back to module-level unmount for sync mounts', async () => {
  let moduleUnmounted = 0
  const container = fakeContainer()
  const handle = await resolveMountHandle({
    mountResult: undefined,
    mod: {
      mount: () => undefined,
      unmount: () => {
        moduleUnmounted += 1
      },
    },
    container,
    fallbackNavigate: () => undefined,
  })
  container.innerHTML = '<div></div>'
  handle.unmount()
  assert.equal(moduleUnmounted, 1)
  assert.equal(container.innerHTML, '')
})

test('resolveMountHandle clears the container for bare legacy sync mounts', async () => {
  const container = fakeContainer()
  const handle = await resolveMountHandle({
    mountResult: undefined,
    mod: { mount: () => undefined },
    container,
    fallbackNavigate: () => undefined,
  })
  container.innerHTML = '<div></div>'
  handle.unmount()
  assert.equal(container.innerHTML, '')
})

test('resolveMountHandle uses fallback navigation when the bundle omits it', async () => {
  const fallbackPaths: string[] = []
  const handle = await resolveMountHandle({
    mountResult: { unmount: () => undefined },
    mod: null,
    container: fakeContainer(),
    fallbackNavigate: (fullPath: string) => {
      fallbackPaths.push(fullPath)
    },
  })
  handle.navigate('/next')
  assert.deepEqual(fallbackPaths, ['/next'])
})

test('a load() call issued while another is in flight waits for the same data', async () => {
  setActivePinia(createPinia())
  const fetchCalls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input))
    await new Promise((resolve) => setTimeout(resolve, 50))
    return new Response(
      JSON.stringify({
        solutions: [projection({ path: '/support' })],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  try {
    const store = useExtensionStore()
    const first = store.load()
    const second = store.load()
    await second
    // The late caller must observe the shared result, not an empty store.
    assert.equal(store.solutions.length, 1)
    assert.equal(store.loaded, true)
    await first
    assert.equal(fetchCalls.length, 1, 'exactly one network request')
    assert.equal(store.loadError, '')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('load() surfaces API failures through loadError instead of an empty list', async () => {
  setActivePinia(createPinia())
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'admin_required' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

  try {
    const store = useExtensionStore()
    await store.load()
    assert.equal(store.loaded, true)
    assert.notEqual(store.loadError, '')
  } finally {
    globalThis.fetch = originalFetch
  }
})
