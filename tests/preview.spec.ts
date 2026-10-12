import { Buffer } from 'node:buffer'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

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

async function resultReady(page: Page, name = 'texture.png', previousUrl?: string) {
  const preview = livePreview(page)
  const image = preview.getByRole('img', { name: `Compressed: ${name}`, exact: true })
  await expect(image).toBeVisible({ timeout: previewTimeout })
  if (previousUrl) await expect(image).not.toHaveAttribute('src', previousUrl, { timeout: previewTimeout })
  await expect(preview.getByRole('status')).toHaveText('Preview ready', { timeout: previewTimeout })
  await expect(preview.locator('.image-comparison')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.queue-done')).toHaveText('All done', { timeout: previewTimeout })
  await expect(page.getByRole('button', { name: `Download ${name}`, exact: true })).toBeEnabled()
  await expect(page.locator('.settings-card .compress-button')).toBeEnabled()
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
    return { url, size: blob.size, type: blob.type, width: image.naturalWidth, height: image.naturalHeight }
  })
  expect(result.size).toBeGreaterThan(0)
  await expect(preview.locator('.side-by-side > figure').nth(1).locator('figcaption > span'))
    .toHaveText(sizeLabel(result.size))
  const row = page.locator('.file-row').filter({
    has: page.getByRole('button', { name: `Preview ${name}`, exact: true }),
  })
  await expect(row.locator('.file-meta > strong')).toHaveText(sizeLabel(result.size))
  await expectLocalImages(page)
  return result
}

async function expectSideBySide(scope: Locator) {
  const figures = scope.locator('.side-by-side > figure')
  await expect(figures).toHaveCount(2)
  await expect(figures.nth(0).locator('figcaption > strong')).toHaveText('Original')
  await expect(figures.nth(1).locator('figcaption > strong')).toHaveText('Compressed')
  for (const selector of ['', '.preview-image', 'img']) {
    const panels = selector ? figures.locator(selector) : figures
    await expect(panels.nth(0)).toBeVisible()
    await expect(panels.nth(1)).toBeVisible()
    const [left, right] = await Promise.all([panels.nth(0).boundingBox(), panels.nth(1).boundingBox()])
    if (!left || !right) throw new Error('Both comparison panels must have bounding boxes.')
    expect(left.width).toBeGreaterThan(0)
    expect(right.width).toBeGreaterThan(0)
    expect(left.height).toBeGreaterThan(0)
    expect(right.height).toBeGreaterThan(0)
    expect(left.x + left.width).toBeLessThanOrEqual(right.x + 1)
    expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1)
  }
}

async function expectNoOverflow(page: Page, scope?: Locator) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1)
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1)
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
  await expect(preview.getByRole('heading', { name: 'Live preview', exact: true })).toBeVisible()
  await expect(preview.getByRole('img', { name: 'Original: texture.png', exact: true })).toBeVisible()
  await expectSideBySide(preview)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.settings-card .compress-button')).toHaveText('Download image')
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
  await expect(livePreview(page).getByRole('status')).toHaveText('Update in progress')
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
      await expect(page.locator('.settings-card .compress-button')).toBeDisabled()
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

test('removing a file during encoding does not restore it or add it to recent files', async ({ page }) => {
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
  await page.getByTitle('Recent files', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Preview removed.png', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Preview remaining.png', exact: true })).toBeVisible()
  await expect(page.locator('.recent-files .file-row')).toHaveCount(1)
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
  await expect(page.locator('.section-title .count-badge')).toHaveText('0')
  await expect(page.locator('.settings-card .compress-button')).toHaveText('Choose images')
  await expect(page.locator('.settings-card .compress-button')).toBeEnabled()
  await expect(page.getByText('Add images for an automatic preview.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.previewTestEncoder.urls.length)).toBe(publishedBefore)
})

for (const width of [360, 390, 768, 1024, 1440]) {
  test(`the preview has no horizontal overflow and two adjacent panels at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    await expectNoOverflow(page)
    await page.getByLabel('Choose images', { exact: true }).setInputFiles(await texturedImage(page))
    await resultReady(page)
    const preview = livePreview(page)
    await expectSideBySide(preview)
    await expectNoOverflow(page, preview)
    await preview.getByRole('button', { name: 'Slider', exact: true }).click()
    await expect(preview.locator('.comparison-canvas')).toBeVisible()
    await expectNoOverflow(page, preview)
    await page.getByRole('button', { name: 'Expand image comparison', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'texture.png', exact: true })
    await expect(dialog).toBeVisible()
    await expectSideBySide(dialog)
    await expectNoOverflow(page, dialog)
    const box = await dialog.boundingBox()
    if (!box) throw new Error('The expanded comparison must have a bounding box.')
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await expectNoOverflow(page, preview)
  })
}
