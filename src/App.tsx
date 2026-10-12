import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, ReactNode } from 'react'
import {
  ArrowDownToLine, ArrowRight, Check, ChevronDown, ChevronRight, CircleHelp,
  Columns2, Download, Expand, FileImage, History, LoaderCircle, Plus,
  ScanLine, SlidersHorizontal, Target, Trash2, Upload, X,
} from 'lucide-react'
import { zipSync } from 'fflate'
import { compressImage, formatBytes, outputName } from './lib/compress'
import type { CompressionMode, CompressionResult, CompressionSettings, OutputFormat } from './lib/compress'

type QueueItem = {
  id: string
  file: File
  preview: string
  status: 'ready' | 'working' | 'done' | 'error'
  result?: CompressionResult
  resultUrl?: string
  format?: OutputFormat
  error?: string
  settingsKey?: string
}
type ImageSource = Pick<QueueItem, 'id' | 'file' | 'preview'>

const formats: { value: OutputFormat; label: string }[] = [
  { value: 'image/webp', label: 'WebP (recommended)' },
  { value: 'image/jpeg', label: 'JPEG' },
  { value: 'image/png', label: 'PNG' },
]
const modes: { value: CompressionMode; label: string; icon: typeof Target }[] = [
  { value: 'size', label: 'Target size', icon: Target },
  { value: 'quality', label: 'Quality', icon: SlidersHorizontal },
  { value: 'resize', label: 'Resize', icon: Expand },
]

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40"><path d="M19 8v11H8A11 11 0 0 1 19 8Zm2 0a11 11 0 0 1 11 11H21V8ZM8 21h11v11A11 11 0 0 1 8 21Zm13 0h11a11 11 0 0 1-11 11V21Z" /></svg></span>
}

function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose() }} aria-labelledby="modal-title">
    <div className="modal-heading">
      <h2 id="modal-title">{title}</h2>
      <button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button>
    </div>
    {children}
  </dialog>
}

function ImageComparison({ item, pending, settingsError }: { item: QueueItem; pending: boolean; settingsError?: string }) {
  const [layout, setLayout] = useState<'side' | 'slider'>('side')
  const [split, setSplit] = useState(50)
  const [originalDimensions, setOriginalDimensions] = useState('')
  const outputAvailable = Boolean(item.result && item.resultUrl)
  const outputStatus = settingsError || item.error || 'The compressed image will appear here.'
  const originalFormat = item.file.type.split('/')[1]?.toUpperCase() || 'Image'
  const originalImage = <img src={item.preview} alt={`Original: ${item.file.name}`} onLoad={(event) => setOriginalDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} />
  const outputImage = outputAvailable
    ? <img src={item.resultUrl} alt={`Compressed: ${item.file.name}`} />
    : <div className="preview-placeholder">{pending && !settingsError ? <LoaderCircle size={20} className="spin" /> : <FileImage size={20} />}<p>{outputStatus}</p></div>

  return <div className="image-comparison" aria-busy={pending}>
    <div className="comparison-toolbar">
      <span className="preview-status" role="status">
        {settingsError ? <><CircleHelp size={13} />Check the settings</> : pending ? <><LoaderCircle size={13} className="spin" />Updating…</> : item.error ? <><CircleHelp size={13} />Preview unavailable</> : <><Check size={13} />Preview ready</>}
      </span>
      <div className="segmented" role="group" aria-label="Comparison layout">
        <button className={layout === 'side' ? 'selected' : ''} aria-pressed={layout === 'side'} onClick={() => setLayout('side')}><Columns2 size={13} />Side by side</button>
        <button className={layout === 'slider' ? 'selected' : ''} aria-pressed={layout === 'slider'} disabled={!outputAvailable} onClick={() => setLayout('slider')}><ScanLine size={13} />Slider</button>
      </div>
    </div>
    {layout === 'side' || !outputAvailable
      ? <div className="side-by-side">
        <figure>
          <figcaption><strong>Original</strong><span>{formatBytes(item.file.size)}</span></figcaption>
          <div className="preview-image">{originalImage}</div>
          <div className="preview-image-meta"><span>{originalDimensions || '—'}</span><span>{originalFormat}</span></div>
        </figure>
        <figure>
          <figcaption><strong>Compressed</strong><span>{outputAvailable ? formatBytes(item.result!.blob.size) : '—'}</span></figcaption>
          <div className={`preview-image ${pending && outputAvailable ? 'preview-updating' : ''}`}>
            {outputImage}
            {pending && outputAvailable && <span className="preview-update-label">{settingsError ? 'Previous preview' : 'Updating…'}</span>}
          </div>
          <div className="preview-image-meta"><span>{outputAvailable ? `${item.result!.width} × ${item.result!.height}` : '—'}</span><span>{item.format?.split('/')[1]?.toUpperCase() || '—'}</span></div>
        </figure>
      </div>
      : <div className="comparison-canvas">
        {originalImage}
        <div className="comparison-overlay" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>{outputImage}</div>
        <span className="compare-label after">Compressed · {formatBytes(item.result!.blob.size)}</span>
        <span className="compare-label before">Original · {formatBytes(item.file.size)}</span>
        <div className="comparison-divider" style={{ left: `${split}%` }}><span><ChevronRight size={15} /><ChevronRight size={15} /></span></div>
        <input type="range" min="0" max="100" value={split} onChange={(event) => setSplit(Number(event.target.value))} aria-label="Compare original and compressed image" />
      </div>}
    {item.result && !item.result.targetMet && !pending && <p className="file-warning">This is the smallest possible file for this format.</p>}
  </div>
}

function App() {
  const [sources, setSources] = useState<ImageSource[]>([])
  const [items, setItems] = useState<QueueItem[]>([])
  const [history, setHistory] = useState<QueueItem[]>([])
  const [view, setView] = useState<'compressor' | 'recent'>('compressor')
  const [mode, setMode] = useState<CompressionMode>('size')
  const [target, setTarget] = useState('200')
  const [unit, setUnit] = useState<'KB' | 'MB'>('KB')
  const [quality, setQuality] = useState(80)
  const [dimension, setDimension] = useState('1920')
  const [format, setFormat] = useState<OutputFormat>('image/webp')
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [zipping, setZipping] = useState(false)
  const [notice, setNotice] = useState('')
  const [help, setHelp] = useState(false)
  const [comparisonId, setComparisonId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const objectUrls = useRef(new Set<string>())
  const dragDepth = useRef(0)
  const compressionTask = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    const urls = objectUrls.current
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url))
      urls.clear()
    }
  }, [])

  useEffect(() => {
    const activeUrls = new Set([...sources.map((item) => item.preview), ...[...items, ...history].flatMap((item) => [item.preview, ...(item.resultUrl ? [item.resultUrl] : [])])])
    objectUrls.current.forEach((url) => {
      if (!activeUrls.has(url)) {
        URL.revokeObjectURL(url)
        objectUrls.current.delete(url)
      }
    })
  }, [sources, items, history])

  const targetBytes = Number(target) * (unit === 'KB' ? 1024 : 1024 * 1024)
  const targetKB = targetBytes / 1024
  const settings = useMemo<CompressionSettings>(() => ({ mode, targetBytes, quality: quality / 100, format, maxWidth: Number(dimension), maxHeight: Number(dimension) }), [mode, targetBytes, quality, format, dimension])
  const settingsKey = JSON.stringify(settings)
  const settingsError = mode === 'size' && (!Number.isFinite(targetBytes) || targetBytes < 1024)
    ? 'Choose a target size of 1 KB or more.'
    : mode === 'resize' && (!Number.isInteger(Number(dimension)) || Number(dimension) < 1 || Number(dimension) > 16384)
      ? 'Choose a dimension between 1 and 16,384 pixels.'
      : ''
  const isPending = (item: QueueItem) => Boolean(settingsError) || item.settingsKey !== settingsKey || item.status === 'ready' || item.status === 'working'
  const selectedItem = items.find((item) => item.id === selectedId) || items[0]
  const comparison = items.find((item) => item.id === comparisonId) || history.find((item) => item.id === comparisonId)
  const comparisonActive = Boolean(comparison && items.some((item) => item.id === comparison.id))
  const completed = items.filter((item) => item.status === 'done' && item.result && !isPending(item))
  const previewsPending = busy || items.some(isPending)

  useEffect(() => {
    let cancelled = false
    if (!sources.length || settingsError) {
      setBusy(false)
      return
    }
    setBusy(true)
    setItems((current) => current.map((item) => ({ ...item, status: 'ready', error: undefined })))
    const timer = window.setTimeout(() => {
      compressionTask.current = compressionTask.current.then(async () => {
        if (cancelled) return
        for (const source of sources) {
          if (cancelled) return
          setItems((current) => current.map((item) => item.id === source.id ? { ...item, status: 'working' } : item))
          try {
            const result = await compressImage(source.file, settings)
            if (cancelled) return
            const resultUrl = URL.createObjectURL(result.blob)
            objectUrls.current.add(resultUrl)
            const finished: QueueItem = { ...source, result, resultUrl, status: 'done', format: settings.format, settingsKey }
            setItems((current) => current.map((item) => item.id === source.id ? finished : item))
            setHistory((current) => [finished, ...current.filter((item) => item.id !== source.id)])
          } catch (error) {
            if (cancelled) return
            setItems((current) => current.map((item) => item.id === source.id ? { ...source, status: 'error', settingsKey, error: error instanceof Error ? error.message : 'This image could not be compressed.' } : item))
          }
        }
        if (!cancelled) setBusy(false)
      })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [sources, settings, settingsKey, settingsError])

  const totalSaved = Math.max(0, completed.reduce((sum, item) => sum + item.file.size - (item.result?.blob.size || 0), 0))

  function trackUrl(blob: Blob) {
    const url = URL.createObjectURL(blob)
    objectUrls.current.add(url)
    return url
  }

  function addFiles(files: FileList | File[] | null) {
    if (!files) return
    const accepted: QueueItem[] = []
    const errors: string[] = []
    for (const file of Array.from(files)) {
      if (items.length + accepted.length >= 20) {
        errors.push('You can add up to 20 images at a time.')
        break
      }
      if (!/^image\/(jpeg|png|webp|avif)$/.test(file.type) && !(file.type === '' && /\.(jpe?g|png|webp|avif)$/i.test(file.name))) {
        errors.push(`${file.name}: choose a JPG, PNG, WebP, or AVIF image.`)
        continue
      }
      if (file.size === 0) {
        errors.push(`${file.name}: this file is empty.`)
        continue
      }
      if ([...items, ...accepted].some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) continue
      accepted.push({ id: crypto.randomUUID(), file, preview: trackUrl(file), status: 'ready' })
    }
    if (accepted.length) {
      setSources((current) => [...current, ...accepted.map(({ id, file, preview }) => ({ id, file, preview }))])
      setItems((current) => [...current, ...accepted])
    }
    setNotice(errors.join(' '))
    setView('compressor')
    if (inputRef.current) inputRef.current.value = ''
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    addFiles(event.dataTransfer.files)
  }

  function removeFiles(id?: string) {
    setSources((current) => id ? current.filter((item) => item.id !== id) : [])
    setItems((current) => id ? current.filter((item) => item.id !== id) : [])
    if (!id || comparisonId === id) setComparisonId(null)
  }

  function downloadBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function downloadItem(item: QueueItem) {
    if (item.result && item.format) downloadBlob(item.result.blob, outputName(item.file.name, item.format))
  }

  async function downloadAll(entries = completed) {
    if (!entries.length) return
    if (entries.length === 1) {
      downloadItem(entries[0])
      return
    }
    setZipping(true)
    try {
      const files: Record<string, Uint8Array> = {}
      for (const [index, item] of entries.entries()) {
        if (item.result && item.format) files[`${String(index + 1).padStart(2, '0')}-${outputName(item.file.name, item.format)}`] = new Uint8Array(await item.result.blob.arrayBuffer())
      }
      downloadBlob(new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' }), 'squeeze-images.zip')
    } catch {
      setNotice('The ZIP file could not be created. Download each image separately.')
    } finally {
      setZipping(false)
    }
  }

  function choosePreset(kilobytes: number) {
    setTarget(kilobytes >= 1024 ? String(kilobytes / 1024) : String(kilobytes))
    setUnit(kilobytes >= 1024 ? 'MB' : 'KB')
  }

  function renderFile(item: QueueItem, isHistory = false) {
    const saved = item.result ? Math.round((1 - item.result.blob.size / item.file.size) * 100) : 0
    const pending = !isHistory && isPending(item)
    const selected = !isHistory && selectedItem?.id === item.id
    return <div className={`file-row ${item.status} ${selected ? 'selected-file' : ''}`} key={item.id}>
      <button className="file-thumbnail" onClick={() => isHistory ? setComparisonId(item.id) : setSelectedId(item.id)} aria-label={`Preview ${item.file.name}`} aria-pressed={selected}><img src={item.preview} alt="" /></button>
      <div className="file-information">
        <span className="file-name" title={item.file.name}>{item.file.name}</span>
        <div className="file-meta">
          <span>{formatBytes(item.file.size)}</span>
          {item.result && <><ArrowRight size={11} /><strong>{formatBytes(item.result.blob.size)}</strong></>}
          {!pending && saved > 0 && <span className="saving-badge">−{saved}%</span>}
          {pending && <span className="working-label">Updating…</span>}
        </div>
        {item.error && !pending && <p className="file-error">{item.error}</p>}
        {item.result && !item.result.targetMet && !pending && <p className="file-warning">This is the smallest possible file for this format.</p>}
        {item.result && item.result.targetMet && saved < 0 && !pending && <p className="file-hint">Larger than the original. WebP or a lower quality gives a smaller file.</p>}
      </div>
      <div className="file-actions">
        <button className="icon-button" onClick={() => { setSelectedId(item.id); setComparisonId(item.id) }} aria-label={`Compare ${item.file.name}`}><ScanLine size={16} /></button>
        {item.result && <button className="icon-button" onClick={() => downloadItem(item)} disabled={pending} aria-label={`Download ${item.file.name}`}><ArrowDownToLine size={16} /></button>}
        {!isHistory && <button className="icon-button" onClick={() => removeFiles(item.id)} aria-label={`Remove ${item.file.name}`}><X size={16} /></button>}
      </div>
    </div>
  }

  return <div className="app">
    <header className="topbar">
      <a className="brand" href="./" onClick={(event) => { event.preventDefault(); setView('compressor') }} aria-label="Squeeze home"><BrandMark /><span>squeeze<span className="brand-period">.</span></span></a>
      <nav className="segmented" aria-label="Views">
        <button className={view === 'compressor' ? 'selected' : ''} aria-pressed={view === 'compressor'} onClick={() => setView('compressor')} title="Compress"><FileImage size={14} />Compress</button>
        <button className={view === 'recent' ? 'selected' : ''} aria-pressed={view === 'recent'} onClick={() => setView('recent')} title="Recent files"><History size={14} />Recent{history.length > 0 && <span className="nav-count">{history.length}</span>}</button>
      </nav>
      <button className="icon-button" onClick={() => setHelp(true)} aria-label="How it works"><CircleHelp size={19} /></button>
    </header>

    <main>
      {notice && <div className="notice" role="alert"><span>{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="Dismiss message"><X size={16} /></button></div>}

      {view === 'compressor' ? <div className="workspace">
        <section className="work-column" aria-label="Images">
          <input className="visually-hidden" ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif,.jpg,.jpeg,.png,.webp,.avif" multiple onChange={(event) => addFiles(event.target.files)} aria-label="Choose images" />
          <div className={`dropzone ${dragging ? 'dragging' : ''} ${items.length ? 'has-files' : ''} ${busy ? 'is-busy' : ''}`} onDragEnter={(event) => { event.preventDefault(); dragDepth.current++; setDragging(true) }} onDragLeave={(event) => { event.preventDefault(); dragDepth.current--; if (dragDepth.current === 0) setDragging(false) }} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
            {items.length === 0
              ? <>
                <span className="dropzone-icon"><Upload size={22} /></span>
                <h1>Drop your images here</h1>
                <p>JPG, PNG, WebP, or AVIF. Any size. Nothing leaves your browser.</p>
                <button className="button primary" onClick={() => inputRef.current?.click()}><Plus size={16} />Choose images</button>
              </>
              : <>
                <Upload size={16} />
                <span>Drop more images here or <button className="inline-button" disabled={items.length >= 20} onClick={() => inputRef.current?.click()}>browse files</button></span>
                <button className="icon-button" disabled={items.length >= 20} onClick={() => inputRef.current?.click()} aria-label="Add more images"><Plus size={18} /></button>
              </>}
          </div>

          {selectedItem && <section className="card live-preview" aria-label="Live preview">
            <div className="card-heading">
              <h2>Preview</h2>
              <div className="card-tools">
                {items.length > 1 && <div className="select-wrap"><select id="preview-file" aria-label="Image to compare" value={selectedItem.id} onChange={(event) => setSelectedId(event.target.value)}>{items.map((item) => <option key={item.id} value={item.id}>{item.file.name}</option>)}</select><ChevronDown size={13} /></div>}
                <button className="icon-button" onClick={() => setComparisonId(selectedItem.id)} aria-label="Expand image comparison"><Expand size={16} /></button>
              </div>
            </div>
            <ImageComparison key={selectedItem.id} item={selectedItem} pending={isPending(selectedItem)} settingsError={settingsError} />
          </section>}

          {items.length > 0 && <section className="card" aria-label="Files">
            <div className="card-heading">
              <h2>{items.length} {items.length === 1 ? 'image' : 'images'}</h2>
              <button className="text-button" onClick={() => removeFiles()}><Trash2 size={13} />Clear all</button>
            </div>
            <div className="file-list">{items.map((item) => renderFile(item))}</div>
            {completed.length > 0 && !previewsPending && <div className="results-summary">
              <span>{totalSaved > 0 ? `${formatBytes(totalSaved)} saved` : 'Ready to download'}</span>
              <button className="button primary" onClick={() => void downloadAll()} disabled={zipping}>{zipping ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}{completed.length > 1 ? 'Download all' : 'Download'}</button>
            </div>}
          </section>}
        </section>

        <section className="card settings-card" aria-labelledby="settings-heading">
          <div className="card-heading"><h2 id="settings-heading">Settings</h2></div>
          <div className="segmented mode-tabs" role="tablist" aria-label="Compression method">
            {modes.map(({ value, label, icon: Icon }) => <button type="button" id={`tab-${value}`} aria-selected={mode === value} aria-controls={`panel-${value}`} role="tab" tabIndex={mode === value ? 0 : -1} key={value} className={mode === value ? 'selected' : ''} onClick={() => setMode(value)} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const next = modes[(modes.findIndex((entry) => entry.value === mode) + (event.key === 'ArrowRight' ? 1 : 2)) % modes.length].value; setMode(next); document.getElementById(`tab-${next}`)?.focus() } }}><Icon size={14} />{label}</button>)}
          </div>
          <div className="mode-panel" role="tabpanel" id={`panel-${mode}`} aria-labelledby={`tab-${mode}`}>
            {mode === 'size' && <>
              <label className="control-label" htmlFor="target-size">Target file size</label>
              <div className="size-input-wrap">
                <input id="target-size" type="number" min={unit === 'KB' ? 1 : 0.001} step="any" value={target} onChange={(event) => setTarget(event.target.value)} />
                <div className="select-wrap unit"><select aria-label="File size unit" value={unit} onChange={(event) => { const next = event.target.value as 'KB' | 'MB'; if (Number(target) > 0) setTarget(String(Number((next === 'MB' ? Number(target) / 1024 : Number(target) * 1024).toFixed(3)))); setUnit(next) }}><option>KB</option><option>MB</option></select><ChevronDown size={13} /></div>
              </div>
              <div className="presets">{[100, 200, 500, 1024].map((value) => <button key={value} className={Math.abs(targetKB - value) < 0.01 ? 'selected' : ''} onClick={() => choosePreset(value)}>{value === 1024 ? '1 MB' : `${value} KB`}</button>)}</div>
              <p className="control-description">Quality is lowered first, then the dimensions, until the file fits.</p>
            </>}
            {mode === 'quality' && <>
              <div className="control-row"><label className="control-label" htmlFor="quality-level">Image quality</label><span className="quality-value">{quality}%</span></div>
              <input id="quality-level" className="range-input" type="range" min="10" max="100" value={quality} disabled={format === 'image/png'} style={{ '--range-progress': `${(quality - 10) / 90 * 100}%` } as CSSProperties} onChange={(event) => setQuality(Number(event.target.value))} />
              <div className="presets">{[50, 75, 85, 95].map((value) => <button key={value} className={quality === value ? 'selected' : ''} disabled={format === 'image/png'} onClick={() => setQuality(value)}>{value}%</button>)}</div>
              <p className="control-description">{format === 'image/png' ? 'PNG is lossless. Choose WebP or JPEG to adjust quality.' : 'The dimensions stay the same.'}</p>
            </>}
            {mode === 'resize' && <>
              <label className="control-label" htmlFor="max-dimension">Maximum width or height</label>
              <div className="size-input-wrap">
                <input id="max-dimension" type="number" min="1" max="16384" step="1" value={dimension} onChange={(event) => setDimension(event.target.value)} />
                <span className="pixel-unit">px</span>
              </div>
              <div className="presets">{[640, 1280, 1920, 2560].map((value) => <button key={value} className={Number(dimension) === value ? 'selected' : ''} onClick={() => setDimension(String(value))}>{value}</button>)}</div>
              <p className="control-description">The proportions stay the same. Images are never upscaled.</p>
            </>}
          </div>
          <label className="control-label" htmlFor="output-format">Output format</label>
          <div className="select-wrap full"><select id="output-format" value={format} onChange={(event) => setFormat(event.target.value as OutputFormat)}>{formats.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select><ChevronDown size={14} /></div>
          {settingsError && <p className="settings-error" role="alert">{settingsError}</p>}
        </section>
      </div>
        : <section className="card recent-panel" aria-label="Recent files">
          <div className="card-heading">
            <h2>Recent files</h2>
            {history.length > 0 && <button className="text-button" disabled={zipping} onClick={() => void downloadAll(history)}><Download size={14} />Download all</button>}
          </div>
          {history.length
            ? <><div className="file-list recent-files">{history.map((item) => renderFile(item, true))}</div><p className="control-description">These files stay in this tab. Download them before you close it.</p></>
            : <div className="recent-empty"><p>Compressed images appear here until you close or refresh this tab.</p><button className="button" onClick={() => setView('compressor')}>Compress an image</button></div>}
        </section>}
    </main>

    <footer className="page-footer">Images are processed in your browser and never uploaded.</footer>

    {help && <Modal title="How it works" onClose={() => setHelp(false)}>
      <ol className="guide">
        <li><strong>Add images.</strong> Drop up to 20 JPG, PNG, WebP, or AVIF files. There is no size limit.</li>
        <li><strong>Choose a method.</strong> Set a target file size, a quality level, or a maximum dimension. Pick an output format.</li>
        <li><strong>Compare and download.</strong> The preview updates automatically. Compare side by side, then download one file or a ZIP.</li>
      </ol>
      <p className="control-description">Target size lowers the quality first, then the dimensions, until the file fits. Everything runs locally; nothing is uploaded or stored.</p>
    </Modal>}
    {comparison && <Modal title={comparison.file.name} onClose={() => setComparisonId(null)} wide>
      <ImageComparison key={comparison.id} item={comparison} pending={comparisonActive && isPending(comparison)} settingsError={comparisonActive ? settingsError : undefined} />
      {comparison.result && <div className="comparison-download"><button className="button primary" onClick={() => downloadItem(comparison)} disabled={comparisonActive && isPending(comparison)}><Download size={15} />Download image</button></div>}
    </Modal>}
  </div>
}

export default App
