import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { Download, Locator, Page } from '@playwright/test'
import { unzipSync } from 'fflate'

type EncodeCall = {
  width: number
  height: number
  type: string
  quality: number | undefined
  size: number
  state: 'encoding' | 'held' | 'delivered'
}

type EncoderControl = {
  hold: boolean
  calls: EncodeCall[]
  urls: { url: string; size: number; type: string }[]
  releaseNext: () => void
  releaseAll: () => void
}

declare global {
  interface Window {
    previewTestEncoder: EncoderControl
  }
}

const originalWidth = 768
const originalHeight = 512
const previewTimeout = 30_000

function livePreview(page: Page) {
  return page.getByRole('region', { name: 'Live preview', exact: true })
}

async function texturedImage(
  page: Page,
  name = 'texture.png',
  seed = 12345,
  width = originalWidth,
  height = originalHeight,
) {
  const base64 = await page.evaluate(({ seed, width, height }) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is not available.')
    const pixels = context.createImageData(width, height)
    let state = seed >>> 0
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      for (let channel = 0; channel < 3; channel++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        pixels.data[offset + channel] = state >>> 24
      }
      pixels.data[offset + 3] = 255
    }
    context.putImageData(pixels, 0, 0)
    const encoded = canvas.toDataURL('image/png').split(',')[1]
    if (!encoded) throw new Error('The fixture could not be encoded.')
    return encoded
  }, { seed, width, height })
  return { name, mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') }
}

function sizeLabel(bytes: number) {
  const unit = Math.min(2, Math.floor(Math.log2(bytes) / 10))
  const label = ['B', 'KB', 'MB'][unit]
  if (!label) throw new Error('The output size is invalid.')
  return `${Number((bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 2))} ${label}`
}

async function expectLocalImages(page: Page) {
  const sources = await page.locator('img').evaluateAll((images) =>
    images.map((image) => image.getAttribute('src')),
  )
  expect(sources.length).toBeGreaterThan(0)
  for (const source of sources) expect(source).toMatch(/^blob:/)
}

async function imageResult(image: Locator) {
  await expect(image).toBeVisible({ timeout: previewTimeout })
  await expect.poll(() => image.evaluate((node) => {
    const image = node as HTMLImageElement
    return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0
  }), { timeout: previewTimeout }).toBe(true)
  const result = await image.evaluate(async (node) => {
    const image = node as HTMLImageElement
    const url = image.getAttribute('src')
    if (!url?.startsWith('blob:')) throw new Error('The result must use a local Blob URL.')
    const response = await fetch(url)
    if (!response.ok) throw new Error('The result Blob is not available.')
    const blob = await response.blob()
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    return { url, size: blob.size, type: blob.type, width: image.naturalWidth, height: image.naturalHeight, sha256 }
  })
  expect(result.size).toBeGreaterThan(0)
  return result
}

async function resultReady(page: Page, name = 'texture.png', previousUrl?: string) {
  const preview = livePreview(page)
  const image = preview.getByRole('img', { name: `Compressed: ${name}`, exact: true })
  await expect(image).toBeVisible({ timeout: previewTimeout })
  if (previousUrl) await expect(image).not.toHaveAttribute('src', previousUrl, { timeout: previewTimeout })
  await expect(preview.getByRole('status')).toHaveText('Preview ready', { timeout: previewTimeout })
  await expect(preview.locator('.image-comparison')).toHaveAttribute('aria-busy', 'false')
  const mobile = await page.evaluate(() => window.matchMedia('(max-width: 860px)').matches)
  const downloads = page.locator(mobile ? '.mobile-bar' : '.files-card')
  await expect(downloads).toBeVisible({ timeout: previewTimeout })
  await expect(downloads.getByRole('button', { name: `Download ${name}`, exact: true })).toBeEnabled()
  const result = await imageResult(image)
  if (mobile) {
    await expect(preview.locator('.mobile-result-stats > div').nth(1).locator('strong'))
      .toHaveText(sizeLabel(result.size))
    await expect(page.locator('.workspace .file-row, .settings-card')).toHaveCount(0)
  } else {
    await expect(page.locator('.results-summary')).toBeVisible({ timeout: previewTimeout })
    const row = page.locator('.file-row').filter({
      has: page.getByRole('button', { name: `Preview ${name}`, exact: true }),
    })
    await expect(row.locator('.file-meta > strong')).toHaveText(sizeLabel(result.size))
    if (await preview.locator('.side-by-side').count()) {
      await expect(preview.locator('.side-by-side > figure').nth(1).locator('figcaption > span'))
        .toHaveText(sizeLabel(result.size))
    } else {
      await expect(preview.locator('.compare-label.after')).toContainText(sizeLabel(result.size))
    }
  }
  await expectLocalImages(page)
  return result
}

async function sheetResultReady(page: Page, name = 'texture.png', previousUrl?: string) {
  const sheet = page.getByRole('dialog', { name: 'Adjust compression', exact: true })
  const image = sheet.getByRole('img', { name: `Output preview: ${name}`, exact: true })
  if (previousUrl) await expect(image).not.toHaveAttribute('src', previousUrl, { timeout: previewTimeout })
  await expect(sheet.getByText('Live output', { exact: true })).toBeVisible({ timeout: previewTimeout })
  await expect(page.locator('.live-preview .image-comparison')).toHaveAttribute('aria-busy', 'false')
  const result = await imageResult(image)
  await expect(sheet.locator('.sheet-live-result strong')).toHaveText(sizeLabel(result.size))
  await expect(page.locator('.live-preview img').last()).toHaveAttribute('src', result.url)
  await expect(page.locator('.live-preview .mobile-result-stats > div').nth(1).locator('strong'))
    .toHaveText(sizeLabel(result.size))
  await expectLocalImages(page)
  return result
}

async function downloadBytes(download: Download) {
  const stream = await download.createReadStream()
  if (!stream) throw new Error('The download stream is not available.')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  await expect(download.failure()).resolves.toBeNull()
  return Buffer.concat(chunks)
}

async function expectDownload(download: Download, result: Awaited<ReturnType<typeof imageResult>>, filename: string) {
  expect(download.suggestedFilename()).toBe(filename)
  const bytes = await downloadBytes(download)
  expect(bytes.length).toBe(result.size)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.sha256)
}

async function expectSideBySide(scope: Locator, stacked = false) {
  const figures = scope.locator('.side-by-side > figure')
  await expect(figures).toHaveCount(2)
  await expect(figures.nth(0).locator('figcaption > strong')).toHaveText('Original')
  await expect(figures.nth(1).locator('figcaption > strong')).toHaveText('Compressed')
  for (const selector of ['', '.preview-image', 'img']) {
    const panels = selector ? figures.locator(selector) : figures
    await expect(panels.nth(0)).toBeVisible()
    await expect(panels.nth(1)).toBeVisible()
    const [first, second] = await Promise.all([panels.nth(0).boundingBox(), panels.nth(1).boundingBox()])
    if (!first || !second) throw new Error('Both comparison panels must have bounding boxes.')
    expect(first.width).toBeGreaterThan(0)
    expect(second.width).toBeGreaterThan(0)
    expect(first.height).toBeGreaterThan(0)
    expect(second.height).toBeGreaterThan(0)
    if (stacked) {
      expect(first.y + first.height).toBeLessThanOrEqual(second.y + 1)
      expect(Math.abs(first.x - second.x)).toBeLessThanOrEqual(1)
    } else {
      expect(first.x + first.width).toBeLessThanOrEqual(second.x + 1)
      expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(1)
    }
  }
}

async function expectNoOverflow(page: Page, scope?: Locator) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    overflow: Array.from(document.querySelectorAll('body *')).filter((node) => {
      const box = node.getBoundingClientRect()
      return box.width > 0 && box.right > window.innerWidth + 1
    }).map((node) => `${node.tagName}.${node.getAttribute('class') || ''}`),
  }))
  const message = `Horizontal overflow: ${dimensions.overflow.join(', ')}`
  expect.soft(dimensions.document, message).toBeLessThanOrEqual(dimensions.viewport + 1)
  expect.soft(dimensions.body, message).toBeLessThanOrEqual(dimensions.viewport + 1)
  if (scope) {
    const boxes = await scope.locator('.side-by-side > figure, .preview-image, img').evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect()
        return { left: box.left, right: box.right }
      }),
    )
    expect(boxes.length).toBeGreaterThan(0)
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(-1)
      expect(box.right).toBeLessThanOrEqual(dimensions.viewport + 1)
    }
  }
}

async function expectSlider(scope: Locator) {
  await expect(scope.getByRole('button', { name: 'Slider', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(scope.locator('.side-by-side')).toHaveCount(0)
  await expect(scope.locator('.comparison-canvas')).toBeVisible()
  await expect(scope.getByRole('slider', { name: 'Compare original and compressed image', exact: true })).toBeVisible()
}

async function expectInViewport(locator: Locator, page: Page) {
  await expect(locator).toBeInViewport({ ratio: 1 })
  const box = await locator.boundingBox()
  const viewport = page.viewportSize()
  if (!box || !viewport) throw new Error('The element and viewport must have dimensions.')
  expect(box.x).toBeGreaterThanOrEqual(-1)
  expect(box.y).toBeGreaterThanOrEqual(-1)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
  return box
}

async function expectTouchTargets(targets: Locator) {
  const boxes = await targets.evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect()
    return { name: node.getAttribute('aria-label') || node.textContent, width: box.width, height: box.height }
  }))
  expect(boxes.length).toBeGreaterThan(0)
  for (const box of boxes) {
    expect.soft(box.width, `${box.name} width`).toBeGreaterThanOrEqual(44)
    expect.soft(box.height, `${box.name} height`).toBeGreaterThanOrEqual(44)
  }
}

async function expectDockReachable(page: Page, name = 'texture.png') {
  const dock = page.locator('.mobile-bar')
  await expect(dock).toHaveCSS('position', 'fixed')
  const box = await expectInViewport(dock, page)
  expect(Math.abs(box.y + box.height - page.viewportSize()!.height)).toBeLessThanOrEqual(1)
  for (const label of ['Adjust compression', 'Adjust image settings', `Download ${name}`]) {
    const button = dock.getByRole('button', { name: label, exact: true })
    await expectInViewport(button, page)
    expect(await button.evaluate((node) => {
      const box = node.getBoundingClientRect()
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
    }), `${label} must not be covered`).toBe(true)
  }
}

async function openAdjustments(page: Page) {
  await page.getByRole('button', { name: 'Adjust image settings', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Adjust compression', exact: true })
  await expect(sheet).toBeVisible()
  expect(await sheet.evaluate((node) => node instanceof HTMLDialogElement && node.open && node.matches(':modal'))).toBe(true)
  await expect.poll(() => sheet.evaluate((node) => Math.abs(node.getBoundingClientRect().bottom - window.innerHeight))).toBeLessThanOrEqual(1)
  return sheet
}

async function holdEncoder(page: Page) {
  await page.evaluate(() => { window.previewTestEncoder.hold = true })
}

async function heldEncode(page: Page) {
  await expect.poll(() => page.evaluate(() =>
    window.previewTestEncoder.calls.filter((call) => call.state === 'held').length,
  ), { timeout: previewTimeout }).toBe(1)
  const call = await page.evaluate(() =>
    window.previewTestEncoder.calls.find((call) => call.state === 'held'),
  )
  if (!call) throw new Error('The encoder must hold a callback.')
  return call
}

async function releaseEncoder(page: Page) {
  await page.evaluate(() => { window.previewTestEncoder.releaseAll() })
}

async function nextPaint(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.addInitScript(() => {
    const nativeToBlob = HTMLCanvasElement.prototype.toBlob
    const nativeCreateObjectURL = URL.createObjectURL.bind(URL)
    const callbacks: (() => void)[] = []
    const encoder: EncoderControl = {
      hold: false,
      calls: [],
      urls: [],
      releaseNext() {
        const callback = callbacks.shift()
        if (!callback) throw new Error('There is no held callback.')
        callback()
      },
      releaseAll() {
        encoder.hold = false
        for (const callback of callbacks.splice(0)) callback()
      },
    }
    ;window.previewTestEncoder = encoder
    URL.createObjectURL = (object) => {
      const url = nativeCreateObjectURL(object)
      if (object instanceof Blob) encoder.urls.push({ url, size: object.size, type: object.type })
      return url
    }
    HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, callback, type, quality) {
      const call: EncodeCall = {
        width: this.width,
        height: this.height,
        type: type ?? 'image/png',
        quality: typeof quality === 'number' ? quality : undefined,
        size: 0,
        state: 'encoding',
      }
      encoder.calls.push(call)
      nativeToBlob.call(this, (blob) => {
        call.size = blob?.size ?? 0
        const deliver = () => {
          call.state = 'delivered'
          callback(blob)
        }
        if (encoder.hold) {
          call.state = 'held'
          callbacks.push(deliver)
        } else {
          deliver()
        }
      }, type, quality)
    }
  })
  await page.goto('/')
})

test('upload produces a local inline preview without a compression button click', async ({ page }) => {
  const unexpectedRequests: string[] = []
  const origin = new URL(page.url()).origin
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (/^https?:$/.test(url.protocol) && (
      request.method() !== 'GET' || url.origin !== origin || request.resourceType() === 'image'
    )) unexpectedRequests.push(`${request.method()} ${request.url()}`)
  })
  const fixture = await texturedImage(page)
  await page.getByLabel('Choose images', { exact: true }).setInputFiles(fixture)
  const result = await resultReady(page)
  const preview = livePreview(page)
  await expect(preview.getByRole('heading', { name: 'Preview', exact: true })).toBeVisible()
  await expect(preview.getByRole('img', { name: 'Original: texture.png', exact: true })).toBeVisible()
  await expectSideBySide(preview)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.results-summary').getByRole('button', { name: 'Download', exact: true })).toBeEnabled()
  expect(result.type).toBe('image/webp')
  expect(result.size).toBeLessThan(fixture.buffer.length)
  expect(result.size).toBeLessThanOrEqual(200 * 1024)
  expect(unexpectedRequests).toEqual([])
})

test('quality changes update the Blob URL and the displayed output size automatically', async ({ page }) => {
  await page.getByRole('tab', { name: 'Quality', exact: true }).click()
  await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
  const initial = await resultReady(page)
  const quality = page.getByRole('slider', { name: 'Image quality', exact: true })
  await expect(quality).toBeEnabled()
  await quality.focus()
  await quality.press('End')
  await expect(quality).toHaveValue('100')
  const high = await resultReady(page, 'texture.png', initial.url)
  await quality.press('Home')
  await expect(quality).toHaveValue('10')
  const low = await resultReady(page, 'texture.png', high.url)
  expect(high.size).toBeGreaterThan(initial.size)
  expect(low.size).toBeLessThan(high.size)
  expect(sizeLabel(low.size)).not.toBe(sizeLabel(high.size))
  expect([low.width, low.height]).toEqual([originalWidth, originalHeight])
})

test('target size changes always reach the requested size, even for PNG', async ({ page }) => {
  await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
  const initial = await resultReady(page)
  await page.getByLabel('Target file size', { exact: true }).fill('16')
  const small = await resultReady(page, 'texture.png', initial.url)
  expect(small.size).toBeLessThanOrEqual(16 * 1024)
  expect(small.size).toBeLessThan(initial.size)
  await page.getByLabel('Target file size', { exact: true }).fill('2')
  const tiny = await resultReady(page, 'texture.png', small.url)
  expect(tiny.size).toBeLessThanOrEqual(2 * 1024)
  expect(tiny.width).toBeLessThan(originalWidth)
  await expect(page.getByRole('switch')).toHaveCount(0)
  await expect(page.locator('.file-warning')).toHaveCount(0)
  await page.getByLabel('Output format', { exact: true }).selectOption('image/png')
  const lossless = await resultReady(page, 'texture.png', tiny.url)
  expect(lossless.type).toBe('image/png')
  expect(lossless.size).toBeLessThanOrEqual(2 * 1024)
  await expect(page.locator('.file-warning')).toHaveCount(0)
  await page.getByLabel('Output format', { exact: true }).selectOption('image/webp')
  await page.getByRole('button', { name: '100 KB', exact: true }).click()
  const preset = await resultReady(page, 'texture.png', lossless.url)
  expect(preset.size).toBeLessThanOrEqual(100 * 1024)
  await page.getByLabel('File size unit', { exact: true }).selectOption('MB')
  const converted = await resultReady(page, 'texture.png', preset.url)
  const target = Number(await page.getByLabel('Target file size', { exact: true }).inputValue())
  expect(converted.size).toBeLessThanOrEqual(target * 1024 * 1024)
})

test('output format changes regenerate real JPEG, PNG, and WebP Blobs', async ({ page }) => {
  await page.getByRole('tab', { name: 'Quality', exact: true }).click()
  await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
  let previous = await resultReady(page)
  for (const format of ['image/jpeg', 'image/png', 'image/webp']) {
    await page.getByLabel('Output format', { exact: true }).selectOption(format)
    const result = await resultReady(page, 'texture.png', previous.url)
    expect(result.type).toBe(format)
    expect([result.width, result.height]).toEqual([originalWidth, originalHeight])
    await expect(livePreview(page).locator('.side-by-side > figure').nth(1).locator('.preview-image-meta > span').nth(1))
      .toHaveText(format.split('/')[1]!.toUpperCase())
    const quality = page.getByRole('slider', { name: 'Image quality', exact: true })
    if (format === 'image/png') {
      await expect(quality).toBeDisabled()
      await expect(page.getByText('PNG is lossless. Choose WebP or JPEG to adjust quality.', { exact: true })).toBeVisible()
    } else {
      await expect(quality).toBeEnabled()
    }
    previous = result
  }
})

test('resize changes regenerate proportional dimensions without upscaling', async ({ page }) => {
  await page.getByRole('tab', { name: 'Resize', exact: true }).click()
  const dimension = page.getByLabel('Maximum width or height', { exact: true })
  await dimension.fill('384')
  await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
  const first = await resultReady(page)
  expect([first.width, first.height]).toEqual([384, 256])
  await dimension.fill('192')
  const smaller = await resultReady(page, 'texture.png', first.url)
  expect([smaller.width, smaller.height]).toEqual([192, 128])
  expect(smaller.size).toBeLessThan(first.size)
  await dimension.fill('1536')
  const original = await resultReady(page, 'texture.png', smaller.url)
  expect([original.width, original.height]).toEqual([originalWidth, originalHeight])
  await expect(livePreview(page).locator('.side-by-side > figure').nth(0).locator('.preview-image-meta > span').first())
    .toHaveText(`${originalWidth} × ${originalHeight}`)
})

test('the file selector and thumbnails select the second batch result', async ({ page }) => {
  await page.getByRole('tab', { name: 'Quality', exact: true }).click()
  const first = await texturedImage(page, 'first.png')
  const second = await texturedImage(page, 'second.png', 98765, 640, 480)
  await page.getByLabel('Choose images', { exact: true }).setInputFiles([first, second])
  const firstResult = await resultReady(page, 'first.png')
  const selector = page.locator('#preview-file')
  await expect(page.getByLabel('Image to compare', { exact: true })).toHaveCount(1)
  await selector.selectOption({ label: 'second.png' })
  const secondResult = await resultReady(page, 'second.png')
  expect(secondResult.url).not.toBe(firstResult.url)
  expect([secondResult.width, secondResult.height]).toEqual([640, 480])
  await expect(livePreview(page).getByRole('img', { name: 'Original: second.png', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Preview second.png', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Preview first.png', exact: true }).click()
  expect((await resultReady(page, 'first.png')).url).toBe(firstResult.url)
  await expect(selector.locator('option:checked')).toHaveText('first.png')
  await page.getByRole('button', { name: 'Preview second.png', exact: true }).click()
  expect((await resultReady(page, 'second.png')).url).toBe(secondResult.url)
  await expect(selector.locator('option:checked')).toHaveText('second.png')
  await expect(page.getByRole('button', { name: 'Preview first.png', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Expand image comparison', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'second.png', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('img', { name: 'Compressed: second.png', exact: true })).toHaveAttribute('src', secondResult.url)
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

test('inline and expanded comparisons support side-by-side and Slider layouts', async ({ page }) => {
  await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
  const result = await resultReady(page)
  const preview = livePreview(page)
  await expectSideBySide(preview)
  await preview.getByRole('button', { name: 'Slider', exact: true }).click()
  await expect(preview.getByRole('button', { name: 'Slider', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(preview.getByRole('button', { name: 'Side by side', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(preview.locator('.side-by-side')).toHaveCount(0)
  const slider = preview.getByRole('slider', { name: 'Compare original and compressed image', exact: true })
  await slider.focus()
  await slider.press('Home')
  await slider.press('ArrowRight')
  await expect(slider).toHaveValue('1')
  await expect(preview.locator('.comparison-divider')).toHaveAttribute('style', /left: 1%/)
  await expect(preview.locator('.comparison-overlay')).toHaveAttribute('style', /99%/)
  await page.getByRole('button', { name: 'Expand image comparison', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'texture.png', exact: true })
  await expect(dialog).toBeVisible()
  await expectSideBySide(dialog)
  await expect(dialog.getByRole('img', { name: 'Compressed: texture.png', exact: true })).toHaveAttribute('src', result.url)
  await expect(dialog.getByRole('button', { name: 'Download image', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Slider', exact: true }).click()
  const expandedSlider = dialog.getByRole('slider', { name: 'Compare original and compressed image', exact: true })
  await expandedSlider.focus()
  await expandedSlider.press('End')
  await expect(expandedSlider).toHaveValue('100')
  await expect(dialog.locator('.comparison-divider')).toHaveAttribute('style', /left: 100%/)
  await dialog.getByRole('button', { name: 'Side by side', exact: true }).click()
  await expectSideBySide(dialog)
  await expectLocalImages(page)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(preview.getByRole('button', { name: 'Slider', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await preview.getByRole('button', { name: 'Side by side', exact: true }).click()
  await expectSideBySide(preview)
})

test('rapid settings changes discard an old in-flight result and keep inputs enabled', async ({ page }) => {
  await page.getByRole('tab', { name: 'Quality', exact: true }).click()
  await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
  const initial = await resultReady(page)
  const publishedBefore = await page.evaluate(() => window.previewTestEncoder.urls.length)
  await holdEncoder(page)
  await page.getByRole('button', { name: '95%', exact: true }).click()
  const stale = await heldEncode(page)
  expect(stale.quality).toBe(0.95)
  expect(stale.size).toBeGreaterThan(0)
  await expect(page.getByRole('slider', { name: 'Image quality', exact: true })).toBeEnabled()
  await expect(page.getByLabel('Output format', { exact: true })).toBeEnabled()
  await expect(page.getByLabel('Choose images', { exact: true })).toBeEnabled()
  for (const name of ['Target size', 'Quality', 'Resize']) {
    await expect(page.getByRole('tab', { name, exact: true })).toBeEnabled()
  }
  await expect(page.getByRole('button', { name: 'Download texture.png', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '50%', exact: true }).click()
  await page.getByRole('button', { name: '75%', exact: true }).click()
  await page.getByRole('button', { name: '85%', exact: true }).click()
  await page.getByLabel('Output format', { exact: true }).selectOption('image/jpeg')
  await page.getByRole('tab', { name: 'Resize', exact: true }).click()
  const dimension = page.getByLabel('Maximum width or height', { exact: true })
  await expect(dimension).toBeEnabled()
  await dimension.fill('384')
  await dimension.fill('192')
  await page.evaluate(() => { window.previewTestEncoder.releaseNext() })
  const latest = await heldEncode(page)
  expect([latest.width, latest.height, latest.type, latest.quality]).toEqual([192, 128, 'image/jpeg', 0.85])
  await expect(livePreview(page).getByRole('img', { name: 'Compressed: texture.png', exact: true }))
    .toHaveAttribute('src', initial.url)
  await expect(livePreview(page).getByRole('status')).toHaveText('Updating…')
  await expect(page.getByRole('button', { name: 'Download texture.png', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.previewTestEncoder.urls.length)).toBe(publishedBefore)
  await releaseEncoder(page)
  const final = await resultReady(page, 'texture.png', initial.url)
  expect([final.width, final.height, final.type, final.size]).toEqual([192, 128, 'image/jpeg', latest.size])
  await nextPaint(page)
  await expect(livePreview(page).getByRole('img', { name: 'Compressed: texture.png', exact: true }))
    .toHaveAttribute('src', final.url)
})

for (const validation of [
  {
    mode: 'Target size',
    label: 'Target file size',
    invalid: ['', '0', '0.5'],
    valid: '100',
    error: 'Choose a target size of 1 KB or more.',
  },
  {
    mode: 'Resize',
    label: 'Maximum width or height',
    invalid: ['', '0', '1.5', '16385'],
    valid: '384',
    error: 'Choose a dimension between 1 and 16,384 pixels.',
  },
]) {
  test(`${validation.mode} rejects invalid settings and recovers automatically`, async ({ page }) => {
    await page.getByRole('tab', { name: validation.mode, exact: true }).click()
    await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
    const initial = await resultReady(page)
    const input = page.getByLabel(validation.label, { exact: true })
    for (const invalid of validation.invalid) {
      await input.fill(invalid)
      await expect(page.getByRole('alert')).toHaveText(validation.error)
      await expect(input).toBeEnabled()
      await expect(livePreview(page).getByRole('status')).toHaveText('Check the settings')
      await expect(page.getByRole('button', { name: 'Download texture.png', exact: true })).toBeDisabled()
      await expect(page.locator('.results-summary')).toHaveCount(0)
      await expect(livePreview(page).getByRole('img', { name: 'Compressed: texture.png', exact: true }))
        .toHaveAttribute('src', initial.url)
    }
    await page.getByRole('button', { name: 'Expand image comparison', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'texture.png', exact: true })
    await expect(dialog.getByRole('status')).toHaveText('Check the settings')
    await expect(dialog.getByRole('button', { name: 'Download image', exact: true })).toBeDisabled()
    await expect(dialog.getByText('Previous preview', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await input.fill(validation.valid)
    const recovered = await resultReady(page, 'texture.png', initial.url)
    await expect(page.getByRole('alert')).toHaveCount(0)
    if (validation.mode === 'Resize') expect([recovered.width, recovered.height]).toEqual([384, 256])
    else expect(recovered.size).toBeLessThanOrEqual(100 * 1024)
    await page.getByRole('button', { name: 'Expand image comparison', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Download image', exact: true })).toBeEnabled()
    await expect(dialog.getByRole('img', { name: 'Compressed: texture.png', exact: true })).toHaveAttribute('src', recovered.url)
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  })
}

test('removing a file during encoding does not restore it', async ({ page }) => {
  await page.getByRole('tab', { name: 'Quality', exact: true }).click()
  const first = await texturedImage(page, 'removed.png')
  const second = await texturedImage(page, 'remaining.png', 98765, 640, 480)
  await holdEncoder(page)
  await page.getByLabel('Choose images', { exact: true }).setInputFiles([first, second])
  const removed = await heldEncode(page)
  expect([removed.width, removed.height]).toEqual([originalWidth, originalHeight])
  await page.getByRole('button', { name: 'Remove removed.png', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Preview removed.png', exact: true })).toHaveCount(0)
  await expect(livePreview(page).getByRole('img', { name: 'Original: remaining.png', exact: true })).toBeVisible()
  await page.evaluate(() => { window.previewTestEncoder.releaseNext() })
  const remaining = await heldEncode(page)
  expect([remaining.width, remaining.height]).toEqual([640, 480])
  expect(await page.evaluate(() => window.previewTestEncoder.urls.length)).toBe(2)
  await releaseEncoder(page)
  await resultReady(page, 'remaining.png')
  await expect(page.locator('.file-row')).toHaveCount(1)
  await expect(page.locator('#preview-file')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove removed.png', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Preview removed.png', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Preview remaining.png', exact: true })).toBeVisible()
})

test('Clear all restores the empty drop area even when an update is in flight', async ({ page }) => {
  await page.getByRole('tab', { name: 'Quality', exact: true }).click()
  const first = await texturedImage(page, 'first.png')
  const second = await texturedImage(page, 'second.png', 98765, 640, 480)
  await page.getByLabel('Choose images', { exact: true }).setInputFiles([first, second])
  await resultReady(page, 'first.png')
  const publishedBefore = await page.evaluate(() => window.previewTestEncoder.urls.length)
  await holdEncoder(page)
  await page.getByRole('button', { name: '95%', exact: true }).click()
  await heldEncode(page)
  await page.getByRole('button', { name: 'Clear all', exact: true }).click()
  await releaseEncoder(page)
  await nextPaint(page)
  await expect(page.locator('.file-row')).toHaveCount(0)
  await expect(livePreview(page)).toHaveCount(0)
  await expect(page.locator('.queue')).toHaveCount(0)
  await expect(page.locator('#preview-file')).toHaveCount(0)
  await expect(page.locator('.dropzone')).not.toHaveClass(/has-files|is-busy/)
  await expect(page.getByRole('heading', { name: 'Drop your images here', exact: true })).toBeVisible()
  await expect(page.locator('.dropzone').getByRole('button', { name: 'Choose images', exact: true })).toBeEnabled()
  await expect(page.getByLabel('Choose images', { exact: true })).toBeEnabled()
  await expect(page.locator('.results-summary')).toHaveCount(0)
  expect(await page.evaluate(() => window.previewTestEncoder.urls.length)).toBe(publishedBefore)
})

for (const width of [320, 360, 390, 768, 1024, 1440]) {
  test(`responsive comparisons use the correct default and have no overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    await expectNoOverflow(page)
    await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
    const result = await resultReady(page)
    const preview = livePreview(page)
    const mobile = width <= 860
    const panelsLabel = mobile ? 'Stacked' : 'Side by side'
    if (mobile) await expectSlider(preview)
    else await expectSideBySide(preview)
    await expectNoOverflow(page, preview)
    await preview.getByRole('button', { name: panelsLabel, exact: true }).click()
    await expectSideBySide(preview, mobile)
    await expectNoOverflow(page, preview)
    await preview.getByRole('button', { name: 'Slider', exact: true }).click()
    await expectSlider(preview)
    await expectNoOverflow(page, preview)
    await page.getByRole('button', { name: 'Expand image comparison', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'texture.png', exact: true })
    await expect(dialog).toBeVisible()
    if (mobile) await expectSlider(dialog)
    else await expectSideBySide(dialog)
    await expect(dialog.getByRole('img', { name: 'Compressed: texture.png', exact: true })).toHaveAttribute('src', result.url)
    await expectNoOverflow(page, dialog)
    await dialog.getByRole('button', { name: panelsLabel, exact: true }).click()
    await expectSideBySide(dialog, mobile)
    await expectNoOverflow(page, dialog)
    await dialog.getByRole('button', { name: 'Slider', exact: true }).click()
    await expectSlider(dialog)
    await expectNoOverflow(page, dialog)
    const box = await dialog.boundingBox()
    if (!box) throw new Error('The expanded comparison must have a bounding box.')
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await expectSlider(preview)
    await expectNoOverflow(page, preview)
  })
}

test('mobile editor shows the preview and persistent download dock before scroll at 390x844', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.settings-card, .mode-tabs, .mobile-bar')).toHaveCount(0)
  await expect(page.getByLabel('Target file size', { exact: true })).toHaveCount(0)
  await expectInViewport(page.locator('.dropzone').getByRole('button', { name: 'Choose images', exact: true }), page)
  await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
  const result = await resultReady(page)
  const preview = livePreview(page)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  const previewBox = await expectInViewport(preview, page)
  const dockBox = await expectInViewport(page.locator('.mobile-bar'), page)
  expect(previewBox.y + previewBox.height).toBeLessThanOrEqual(dockBox.y)
  await expectDockReachable(page)
  await expect(page.locator('.settings-card, .files-card, .file-row, .mode-tabs')).toHaveCount(0)
  await expect(preview.getByRole('heading', { name: 'texture.png', exact: true })).toBeVisible()
  await expectSlider(preview)
  await expect(preview.getByRole('button', { name: 'Stacked', exact: true })).toHaveAttribute('aria-pressed', 'false')
  const slider = preview.getByRole('slider', { name: 'Compare original and compressed image', exact: true })
  await slider.focus()
  await slider.press('End')
  await slider.press('ArrowLeft')
  await expect(slider).toHaveValue('99')
  await expect(preview.locator('.comparison-divider')).toHaveAttribute('style', /left: 99%/)
  await expect(preview.locator('.comparison-overlay')).toHaveAttribute('style', /1%/)
  await preview.getByRole('button', { name: 'Stacked', exact: true }).click()
  await expectSideBySide(preview, true)
  await expect(preview.getByRole('button', { name: 'Stacked', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await nextPaint(page)
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  await expectDockReachable(page)
  await preview.getByRole('button', { name: 'Slider', exact: true }).click()
  await expectSlider(preview)
  expect((await resultReady(page)).url).toBe(result.url)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download texture.png', exact: true }).click()
  await expectDownload(await download, result, 'texture-compressed.webp')
})

test('mobile Adjust sheet updates its live Blob preview for target, quality, and format changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
  const initial = await resultReady(page)
  const sheet = await openAdjustments(page)
  await expect(page.locator('.settings-card')).toHaveCount(0)
  await expect(sheet.getByLabel('Target file size', { exact: true })).toHaveValue('200')
  expect((await sheetResultReady(page)).url).toBe(initial.url)
  await holdEncoder(page)
  await sheet.getByRole('button', { name: '100 KB', exact: true }).click()
  await heldEncode(page)
  await expect(sheet.getByText('Update in progress', { exact: true })).toBeVisible()
  await expect(sheet.locator('.sheet-live-result strong')).toHaveText('Please wait…')
  await expect(page.locator('.mobile-download')).toBeDisabled()
  await expect(sheet.getByRole('img', { name: 'Output preview: texture.png', exact: true })).toHaveAttribute('src', initial.url)
  await releaseEncoder(page)
  const smaller = await sheetResultReady(page, 'texture.png', initial.url)
  expect(smaller.size).toBeLessThanOrEqual(100 * 1024)
  expect(smaller.size).toBeLessThan(initial.size)
  await expect(sheet.getByLabel('Target file size', { exact: true })).toHaveValue('100')
  await sheet.getByRole('tab', { name: 'Quality', exact: true }).click()
  const quality = await sheetResultReady(page, 'texture.png', smaller.url)
  await expect(sheet.getByRole('slider', { name: 'Image quality', exact: true })).toBeEnabled()
  await sheet.getByRole('button', { name: '95%', exact: true }).click()
  const high = await sheetResultReady(page, 'texture.png', quality.url)
  expect(high.size).toBeGreaterThan(quality.size)
  expect([high.width, high.height]).toEqual([originalWidth, originalHeight])
  await sheet.getByLabel('Output format', { exact: true }).selectOption('image/jpeg')
  const jpeg = await sheetResultReady(page, 'texture.png', high.url)
  expect(jpeg.type).toBe('image/jpeg')
  await sheet.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  expect((await resultReady(page)).url).toBe(jpeg.url)
  await expect(page.getByRole('button', { name: 'Adjust compression', exact: true })).toContainText('95% quality · JPEG')
  await page.getByRole('button', { name: 'Expand image comparison', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'texture.png', exact: true })
  await expectSlider(dialog)
  expect(await imageResult(dialog.getByRole('img', { name: 'Compressed: texture.png', exact: true }))).toEqual(jpeg)
  await expect(dialog.locator('.mobile-result-stats > div').nth(1).locator('strong')).toHaveText(sizeLabel(jpeg.size))
  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download image', exact: true }).click()
  await expectDownload(await download, jpeg, 'texture-compressed.jpg')
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
})

for (const validation of [
  {
    mode: 'Target size',
    label: 'Target file size',
    invalid: ['', '0', '0.5'],
    valid: '100',
    error: 'Choose a target size of 1 KB or more.',
  },
  {
    mode: 'Resize',
    label: 'Maximum width or height',
    invalid: ['', '0', '1.5', '16385'],
    valid: '384',
    error: 'Choose a dimension between 1 and 16,384 pixels.',
  },
]) {
  test(`mobile ${validation.mode} errors persist across sheet closure and recover after correction`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
    const initial = await resultReady(page)
    const sheet = await openAdjustments(page)
    await sheet.getByRole('tab', { name: validation.mode, exact: true }).click()
    const current = await sheetResultReady(page, 'texture.png', validation.mode === 'Resize' ? initial.url : undefined)
    for (const invalid of validation.invalid) {
      const input = sheet.getByLabel(validation.label, { exact: true })
      await input.fill(invalid)
      await expect(sheet.getByRole('alert')).toHaveText(validation.error)
      await expect(input).toBeEnabled()
      await sheet.getByRole('button', { name: 'Done', exact: true }).click()
      await expect(sheet).toHaveCount(0)
      await expect(page.getByLabel(validation.label, { exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Download texture.png', exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Adjust compression', exact: true })).toContainText('Check settings')
      await expect(livePreview(page).getByRole('status')).toHaveText('Check the settings')
      await expect(livePreview(page).getByText('Open Adjust to correct the settings.', { exact: true })).toBeVisible()
      await expect(livePreview(page).getByRole('img', { name: 'Compressed: texture.png', exact: true })).toHaveAttribute('src', current.url)
      await openAdjustments(page)
      await expect(sheet.getByRole('tab', { name: validation.mode, exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(input).toHaveValue(invalid)
      await expect(sheet.getByRole('alert')).toHaveText(validation.error)
    }
    await sheet.getByLabel(validation.label, { exact: true }).fill(validation.valid)
    const recovered = await sheetResultReady(page, 'texture.png', current.url)
    await expect(sheet.getByRole('alert')).toHaveCount(0)
    if (validation.mode === 'Resize') expect([recovered.width, recovered.height]).toEqual([384, 256])
    else expect(recovered.size).toBeLessThanOrEqual(100 * 1024)
    await sheet.getByRole('button', { name: 'Done', exact: true }).click()
    expect((await resultReady(page)).url).toBe(recovered.url)
    await expect(livePreview(page).getByText('Open Adjust to correct the settings.', { exact: true })).toHaveCount(0)
  })
}

test('mobile Adjust sheet restores focus after Done, Escape, and a backdrop click', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
  await resultReady(page)
  const adjust = page.getByRole('button', { name: 'Adjust image settings', exact: true })
  const sheet = await openAdjustments(page)
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden')
  await expect(sheet.getByRole('button', { name: 'Done', exact: true })).toBeFocused()
  await page.locator('.mobile-download').evaluate((node) => (node as HTMLButtonElement).focus())
  await expect(sheet.getByRole('button', { name: 'Done', exact: true })).toBeFocused()
  await sheet.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  await expect(adjust).toBeFocused()
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden')
  const summary = page.getByRole('button', { name: 'Adjust compression', exact: true })
  await summary.click()
  await expect(sheet).toBeVisible()
  await sheet.getByLabel('Target file size', { exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(summary).toBeFocused()
  await openAdjustments(page)
  await sheet.getByRole('heading', { name: 'Adjust compression', exact: true }).click()
  await expect(sheet).toBeVisible()
  const box = await sheet.boundingBox()
  if (!box || box.y < 2) throw new Error('The sheet must leave space for its backdrop.')
  await page.mouse.click(10, box.y / 2)
  await expect(sheet).toHaveCount(0)
  await expect(adjust).toBeFocused()
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden')
  await expectDockReachable(page)
})

test('mobile batch filmstrip preserves page position and Manage downloads, removes, and clears files', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const first = await texturedImage(page, 'first.png')
  const second = await texturedImage(page, 'second.png', 98765, 640, 480)
  await page.getByLabel('Choose images', { exact: true }).setInputFiles([first, second])
  const firstResult = await resultReady(page, 'first.png')
  const tray = page.getByRole('region', { name: 'Your images', exact: true })
  await expect(page.locator('.file-row, #preview-file')).toHaveCount(0)
  const firstButton = tray.getByRole('button', { name: 'Preview first.png', exact: true })
  const secondButton = tray.getByRole('button', { name: 'Preview second.png', exact: true })
  await expectInViewport(secondButton, page)
  const position = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
  const previewBox = await livePreview(page).boundingBox()
  await secondButton.click()
  const secondResult = await resultReady(page, 'second.png')
  await nextPaint(page)
  expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual(position)
  expect(await livePreview(page).boundingBox()).toEqual(previewBox)
  await expect(secondButton).toHaveAttribute('aria-pressed', 'true')
  await expect(firstButton).toHaveAttribute('aria-pressed', 'false')
  await expectSlider(livePreview(page))
  await expect(livePreview(page).getByRole('heading', { name: 'second.png', exact: true })).toBeVisible()
  expect(secondResult.url).not.toBe(firstResult.url)
  await firstButton.click()
  expect((await resultReady(page, 'first.png')).url).toBe(firstResult.url)
  await secondButton.click()
  expect((await resultReady(page, 'second.png')).url).toBe(secondResult.url)
  expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual(position)
  await tray.getByRole('button', { name: 'Manage', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Your images', exact: true })
  await expect(sheet).toBeVisible()
  expect(await sheet.evaluate((node) => node instanceof HTMLDialogElement && node.open && node.matches(':modal'))).toBe(true)
  await expect(sheet.locator('.file-row')).toHaveCount(2)
  await expect(sheet.getByRole('button', { name: 'Preview second.png', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const downloadAll = sheet.getByRole('button', { name: 'Download all as ZIP', exact: true })
  await expect(downloadAll).toBeEnabled({ timeout: previewTimeout })
  const download = page.waitForEvent('download')
  await downloadAll.click()
  const zip = await download
  expect(zip.suggestedFilename()).toBe('squeeze-images.zip')
  const entries = unzipSync(await downloadBytes(zip))
  expect(Object.keys(entries).sort()).toEqual(['01-first-compressed.webp', '02-second-compressed.webp'])
  for (const [name, result] of [['01-first-compressed.webp', firstResult], ['02-second-compressed.webp', secondResult]] as const) {
    const bytes = entries[name]
    expect(bytes.length).toBe(result.size)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.sha256)
  }
  await sheet.getByRole('button', { name: 'Remove second.png', exact: true }).click()
  await expect(sheet.locator('.file-row')).toHaveCount(1)
  await expect(sheet.getByRole('button', { name: 'Preview second.png', exact: true })).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: 'Download all', exact: true })).toBeEnabled({ timeout: previewTimeout })
  await sheet.getByRole('button', { name: 'Done', exact: true }).click()
  await resultReady(page, 'first.png')
  await expect(tray.getByRole('button', { name: 'Preview second.png', exact: true })).toHaveCount(0)
  await expect(firstButton).toHaveAttribute('aria-pressed', 'true')
  await tray.getByRole('button', { name: 'Manage', exact: true }).click()
  await sheet.getByRole('button', { name: 'Clear all', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  await expect(page.locator('.mobile-bar, .mobile-image-tray, .live-preview, .settings-card, .file-row')).toHaveCount(0)
  await expect(page.locator('.dropzone').getByRole('button', { name: 'Choose images', exact: true })).toBeVisible()
  await expect(page.locator('.dropzone')).not.toHaveClass(/has-files|is-busy/)
  await expectNoOverflow(page)
})

for (const width of [320, 360, 390]) {
  test(`mobile controls have touch targets and a reachable dock without overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await expectNoOverflow(page)
    await expectTouchTargets(page.locator('.dropzone .button, .topbar .icon-button, .topbar .segmented button:visible'))
    await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
    await resultReady(page)
    await expectNoOverflow(page, livePreview(page))
    await expectDockReachable(page)
    await expectTouchTargets(page.locator('.mobile-bar button, .live-preview button, .mobile-image-tray button'))
    const sheet = await openAdjustments(page)
    await expectNoOverflow(page, sheet)
    await expectTouchTargets(sheet.locator('button, input, select'))
    await sheet.getByRole('tab', { name: 'Quality', exact: true }).click()
    await expectTouchTargets(sheet.locator('button, input, select'))
    await sheetResultReady(page)
    await sheet.getByRole('button', { name: 'Done', exact: true }).click()
    await page.getByRole('button', { name: 'Manage', exact: true }).click()
    const manage = page.getByRole('dialog', { name: 'Your images', exact: true })
    await expect(manage).toBeVisible()
    await expectNoOverflow(page, manage)
    await expectTouchTargets(manage.locator('button'))
    await manage.getByRole('button', { name: 'Done', exact: true }).click()
    await livePreview(page).getByRole('button', { name: 'Stacked', exact: true }).click()
    await expectSideBySide(livePreview(page), true)
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await nextPaint(page)
    await expectNoOverflow(page, livePreview(page))
    await expectDockReachable(page)
    const result = await resultReady(page)
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download texture.png', exact: true }).click()
    await expectDownload(await download, result, 'texture-compressed.webp')
  })
}

test('mobile Adjust sheet remains scrollable in a short landscape viewport', async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 })
  await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
  const initial = await resultReady(page)
  const sheet = await openAdjustments(page)
  const metrics = await sheet.evaluate((node) => ({ client: node.clientHeight, scroll: node.scrollHeight }))
  expect(metrics.scroll).toBeGreaterThan(metrics.client)
  await expectInViewport(sheet, page)
  await expectNoOverflow(page, sheet)
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden')
  const pageScroll = await page.evaluate(() => window.scrollY)
  await sheet.hover()
  await page.mouse.wheel(0, 500)
  await expect.poll(() => sheet.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll)
  const format = sheet.getByLabel('Output format', { exact: true })
  await format.scrollIntoViewIfNeeded()
  await expectInViewport(format, page)
  await format.selectOption('image/jpeg')
  await sheet.getByRole('button', { name: '100 KB', exact: true }).click()
  const result = await sheetResultReady(page, 'texture.png', initial.url)
  expect(result.type).toBe('image/jpeg')
  expect(result.size).toBeLessThanOrEqual(100 * 1024)
  const done = sheet.getByRole('button', { name: 'Done', exact: true })
  await done.scrollIntoViewIfNeeded()
  await expectInViewport(done, page)
  await done.click()
  await expect(sheet).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Adjust image settings', exact: true })).toBeFocused()
  await expectDockReachable(page)
})

for (const width of [390, 1440]) {
  test(`the header has no Recent view and removed images release their URLs at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await expect(page.getByRole('navigation', { name: 'Views' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Recent/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'How it works' })).toBeVisible()
    await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
    const result = await resultReady(page)
    const originalUrl = await livePreview(page).getByRole('img', { name: 'Original: texture.png', exact: true }).getAttribute('src')
    await page.getByRole('link', { name: 'Squeeze home' }).click()
    expect((await resultReady(page)).url).toBe(result.url)
    if (width <= 860) await page.getByRole('button', { name: 'Manage', exact: true }).click()
    await page.getByRole('button', { name: 'Clear all', exact: true }).click()
    await expect(livePreview(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Recent/ })).toHaveCount(0)
    await expect.poll(() => page.evaluate(async (urls) => Promise.all(urls.map(async (url) => {
      try {
        await fetch(url!)
        return false
      } catch {
        return true
      }
    })), [originalUrl, result.url])).toEqual([true, true])
    await expectNoOverflow(page)
  })
}

test.describe('mobile touchscreen', () => {
  test.use({ hasTouch: true })

  test('actual taps open the upload picker, adjust presets, and download the output', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0)
    const fixture = await texturedImage(page)
    const filechooser = page.waitForEvent('filechooser')
    await page.tap('.dropzone button:text-is("Choose images")')
    await (await filechooser).setFiles(fixture)
    const initial = await resultReady(page)
    await page.tap('button[aria-label="Adjust image settings"]')
    const sheet = page.getByRole('dialog', { name: 'Adjust compression', exact: true })
    await expect(sheet).toBeVisible()
    await page.tap('dialog button:text-is("100 KB")')
    const smaller = await sheetResultReady(page, 'texture.png', initial.url)
    expect(smaller.size).toBeLessThanOrEqual(100 * 1024)
    await page.tap('dialog [role="tab"]:text-is("Quality")')
    const quality = await sheetResultReady(page, 'texture.png', smaller.url)
    await page.tap('dialog button:text-is("50%")')
    const final = await sheetResultReady(page, 'texture.png', quality.url)
    await expect(sheet.getByRole('slider', { name: 'Image quality', exact: true })).toHaveValue('50')
    await page.tap('dialog button:text-is("Done")')
    await expect(sheet).toHaveCount(0)
    expect((await resultReady(page)).url).toBe(final.url)
    const download = page.waitForEvent('download')
    await page.tap('button[aria-label="Download texture.png"]')
    await expectDownload(await download, final, 'texture-compressed.webp')
  })
})
