import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, ReactNode } from 'react'
import {
  ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, Check, CheckCheck,
  ChevronDown, ChevronRight, CircleHelp, Clock3, Download, Expand,
  FileImage, FolderOpen, Gauge, History, Image, Layers3, Leaf, LoaderCircle,
  LockKeyhole, Maximize, Plus, ScanLine, ShieldCheck, SlidersHorizontal,
  Sparkles, Target, Trash2, Upload, WandSparkles, X, Zap,
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
type InfoModal = 'guide' | 'tips' | 'privacy' | null

const formats: { value: OutputFormat; label: string; description: string }[] = [
  { value: 'image/webp', label: 'WebP', description: 'Small files. Beautiful detail. Made for the web.' },
  { value: 'image/jpeg', label: 'JPEG', description: 'A familiar format that works almost everywhere.' },
  { value: 'image/png', label: 'PNG', description: 'Lossless detail with support for transparency.' },
]
const modes: { value: CompressionMode; label: string; icon: typeof Target }[] = [
  { value: 'size', label: 'Target size', icon: Target },
  { value: 'quality', label: 'Quality', icon: SlidersHorizontal },
  { value: 'resize', label: 'Resize', icon: Expand },
]

function BrandMark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true"><svg viewBox="0 0 40 40"><path d="M19 8v11H8A11 11 0 0 1 19 8Zm2 0a11 11 0 0 1 11 11H21V8ZM8 21h11v11A11 11 0 0 1 8 21Zm13 0h11a11 11 0 0 1-11 11V21Z" /></svg></span>
}

function UploadIllustration() {
  return <div className="upload-illustration" aria-hidden="true">
    <svg className="picture-card back" viewBox="0 0 100 116"><rect x="1" y="1" width="98" height="114" rx="11" fill="white" stroke="#e7e7df" /><rect x="10" y="10" width="80" height="81" rx="5" fill="#e8eee0" /><circle cx="66" cy="33" r="11" fill="#cbd8b4" /><path d="M10 74 37 45l21 25 14-15 18 24v12H10Z" fill="#aebd98" /><rect x="12" y="100" width="36" height="4" rx="2" fill="#e8e9e1" /></svg>
    <svg className="picture-card front" viewBox="0 0 100 116"><rect x="1" y="1" width="98" height="114" rx="11" fill="white" stroke="#e7e2d8" /><rect x="10" y="10" width="80" height="81" rx="5" fill="#f7e7d4" /><circle cx="65" cy="34" r="12" fill="#efbd88" /><path d="m10 77 23-30 27 28 13-17 17 22v11H10Z" fill="#d4a780" /><path d="m10 87 28-19 24 18 17-13 11 10v8H10Z" fill="#bc8969" /><rect x="12" y="100" width="31" height="4" rx="2" fill="#e9e5dc" /><rect x="67" y="100" width="20" height="4" rx="2" fill="#ecd1b9" /></svg>
    <span className="illustration-spark one">✦</span><span className="illustration-spark two">✧</span>
    <span className="illustration-badge"><ArrowDown size={15} strokeWidth={2.5} /></span>
  </div>
}

function Modal({ title, eyebrow, onClose, children, wide = false }: { title: string; eyebrow?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose() }} aria-labelledby="modal-title">
    <div className="modal-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2 id="modal-title">{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>
    {children}
  </dialog>
}

function ImageComparison({ item, pending, settingsError }: { item: QueueItem; pending: boolean; settingsError?: string }) {
  const [layout, setLayout] = useState<'side' | 'slider'>('side')
  const [split, setSplit] = useState(50)
  const [originalDimensions, setOriginalDimensions] = useState('')
  const outputAvailable = Boolean(item.result && item.resultUrl)
  const outputStatus = settingsError || item.error || (pending ? 'The preview updates automatically.' : 'The output preview will appear here.')
  const originalImage = <img src={item.preview} alt={`Original: ${item.file.name}`} onLoad={(event) => setOriginalDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} />
  const outputImage = outputAvailable ? <img src={item.resultUrl} alt={`Compressed: ${item.file.name}`} /> : <div className="preview-placeholder">{pending && !settingsError ? <LoaderCircle size={22} className="spin" /> : <FileImage size={24} />}<p>{outputStatus}</p></div>

  return <div className="image-comparison" aria-busy={pending}>
    <div className="comparison-toolbar"><span className="preview-status" role="status">{settingsError ? <><CircleHelp size={13} />Check the settings</> : pending ? <><LoaderCircle size={13} className="spin" />Update in progress</> : item.error ? <><CircleHelp size={13} />Preview unavailable</> : <><Check size={13} />Preview ready</>}</span><div className="comparison-layout" role="group" aria-label="Comparison layout"><button className={layout === 'side' ? 'selected' : ''} aria-pressed={layout === 'side'} onClick={() => setLayout('side')}><Layers3 size={13} />Side by side</button><button className={layout === 'slider' ? 'selected' : ''} aria-pressed={layout === 'slider'} disabled={!outputAvailable} onClick={() => setLayout('slider')}><ScanLine size={13} />Slider</button></div></div>
    {layout === 'side' || !outputAvailable ? <div className="side-by-side"><figure><figcaption><strong>Original</strong><span>{formatBytes(item.file.size)}</span></figcaption><div className="preview-image">{originalImage}</div><div className="preview-image-meta"><span>{originalDimensions || 'Original dimensions'}</span><span>{item.file.type.split('/')[1]?.toUpperCase() || 'Image'}</span></div></figure><figure><figcaption><strong>Compressed</strong><span>{outputAvailable ? formatBytes(item.result!.blob.size) : '—'}</span></figcaption><div className={`preview-image ${pending && outputAvailable ? 'preview-updating' : ''}`}>{outputImage}{pending && outputAvailable && <span className="preview-update-label">{settingsError ? 'Previous preview' : 'Update in progress'}</span>}</div><div className="preview-image-meta"><span>{outputAvailable ? `${item.result!.width} × ${item.result!.height}` : 'Output dimensions'}</span><span>{item.format?.split('/')[1]?.toUpperCase() || '—'}</span></div></figure></div> : <><div className="comparison-canvas">{originalImage}<div className="comparison-overlay" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>{outputImage}</div><span className="compare-label after">Compressed · {formatBytes(item.result!.blob.size)}</span><span className="compare-label before">Original · {formatBytes(item.file.size)}</span><div className="comparison-divider" style={{ left: `${split}%` }}><span><ChevronRight size={15} /><ChevronRight size={15} /></span></div><input type="range" min="0" max="100" value={split} onChange={(event) => setSplit(Number(event.target.value))} aria-label="Compare original and compressed image" /></div><p className="comparison-hint">Move the slider to compare. The compressed image appears on the left.</p></>}
    {item.result && !item.result.targetMet && !pending && <p className="file-warning">This is the smallest possible file for this format. Choose a larger target for more detail.</p>}
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
  const [progress, setProgress] = useState(0)
  const [notice, setNotice] = useState('')
  const [info, setInfo] = useState<InfoModal>(null)
  const [comparisonId, setComparisonId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [previewVersion, setPreviewVersion] = useState(0)
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
  const completed = items.filter((item) => item.status === 'done' && item.result && !isPending(item))
  const previewsPending = busy || items.some(isPending)

  useEffect(() => {
    let cancelled = false
    if (!sources.length || settingsError) {
      setBusy(false)
      return
    }
    setBusy(true)
    setProgress(0)
    setItems((current) => current.map((item) => ({ ...item, status: 'ready', error: undefined })))
    const timer = window.setTimeout(() => {
      compressionTask.current = compressionTask.current.then(async () => {
        if (cancelled) return
        for (let index = 0; index < sources.length; index++) {
          if (cancelled) return
          const source = sources[index]
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
          setProgress(index + 1)
        }
        if (!cancelled) setBusy(false)
      })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [sources, settings, settingsKey, settingsError, previewVersion])

  const originalTotal = completed.reduce((sum, item) => sum + item.file.size, 0)
  const compressedTotal = completed.reduce((sum, item) => sum + (item.result?.blob.size || 0), 0)
  const totalSaved = Math.max(0, originalTotal - compressedTotal)
  const selectedFormat = formats.find((option) => option.value === format)!

  function trackUrl(blob: Blob) {
    const url = URL.createObjectURL(blob)
    objectUrls.current.add(url)
    return url
  }

  function addFiles(files: FileList | File[] | null) {
    if (!files) return
    const accepted: QueueItem[] = []
    const errors: string[] = []
    const incoming = Array.from(files)
    for (const file of incoming) {
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
    return <div className={`file-row ${item.status} ${!isHistory && selectedItem?.id === item.id ? 'selected-file' : ''}`} key={item.id}>
      <button className="file-thumbnail" onClick={() => isHistory ? setComparisonId(item.id) : setSelectedId(item.id)} aria-label={`Preview ${item.file.name}`} aria-pressed={!isHistory && selectedItem?.id === item.id}><img src={item.preview} alt="" /></button>
      <div className="file-information"><span className="file-name" title={item.file.name}>{item.file.name}</span><div className="file-meta"><span>{formatBytes(item.file.size)}</span>{item.result && <><ArrowRight size={11} /><strong>{formatBytes(item.result.blob.size)}</strong></>}{pending && <span className="working-label">Update pending</span>}</div>{item.error && !pending && <p className="file-error">{item.error}</p>}{item.result && !item.result.targetMet && !pending && <p className="file-warning">This is the smallest possible file for this format.</p>}{item.result && item.result.targetMet && saved < 0 && !pending && <p className="file-hint">Larger than the original. WebP or a lower quality gives a smaller file.</p>}</div>
      <div className="file-actions">{pending ? <LoaderCircle size={15} className="spin" /> : saved > 0 && <span className="saving-badge">−{saved}%</span>}<button className="icon-button preview-button" onClick={() => { setSelectedId(item.id); setComparisonId(item.id) }} aria-label={`Compare ${item.file.name}`}><ScanLine size={17} /></button>{item.result && <button className="icon-button file-download" onClick={() => downloadItem(item)} disabled={pending} aria-label={`Download ${item.file.name}`}><ArrowDownToLine size={17} /></button>}</div>
      {!isHistory && <button className="icon-button remove-file" onClick={() => removeFiles(item.id)} aria-label={`Remove ${item.file.name}`}><X size={15} /></button>}
    </div>
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="./" onClick={(event) => { event.preventDefault(); setView('compressor') }} aria-label="Squeeze home"><BrandMark /><span>squeeze<span className="brand-period">.</span></span></a>
      <div className="sidebar-section"><span className="nav-label">YOUR WORKSPACE</span><nav aria-label="Workspace"><button className={`nav-item ${view === 'compressor' ? 'active' : ''}`} onClick={() => setView('compressor')} title="Image compressor"><Image size={19} /><span>Image compressor</span><span className="active-dot" /></button><button className={`nav-item ${view === 'recent' ? 'active' : ''}`} onClick={() => setView('recent')} title="Recent files"><History size={19} /><span>Recent files</span>{history.length > 0 && <span className="nav-count">{history.length}</span>}</button></nav></div>
      <div className="sidebar-section resources"><span className="nav-label">A LITTLE GUIDANCE</span><nav aria-label="Resources"><button className="nav-item" onClick={() => setInfo('guide')} title="How it works"><Layers3 size={18} /><span>How it works</span></button><button className="nav-item" onClick={() => setInfo('tips')} title="Compression tips"><WandSparkles size={18} /><span>Compression tips</span></button></nav></div>
      <div className="sidebar-bottom"><div className="sidebar-note"><div className="leaf-art"><Leaf size={29} strokeWidth={1.5} /><span className="leaf-spark">+</span></div><h3>A little lighter.<br />A lot better.</h3><p>Less space. Faster pages.<br />More room for the good stuff.</p><span className="note-line" /></div><button className="local-note" onClick={() => setInfo('privacy')}><span className="green-dot" />Made to stay on your device<ChevronRight size={12} /></button><span className="version">SMALL BY DESIGN. <span>v1.0</span></span></div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><span className="breadcrumb-icon"><Image size={17} /></span><span className="breadcrumb-root">Workspace<ChevronRight size={13} /></span><span>{view === 'compressor' ? 'Image compressor' : 'Recent files'}</span></div><div className="topbar-actions"><button className="privacy-label" onClick={() => setInfo('privacy')}><ShieldCheck size={15} /><span>100% on your device</span></button><span className="topbar-divider" /><button className="icon-button mobile-history" onClick={() => setView(view === 'recent' ? 'compressor' : 'recent')} aria-label="Toggle recent files"><History size={19} /></button><button className="icon-button help-button" onClick={() => setInfo('guide')} aria-label="Help"><CircleHelp size={19} /></button></div></header>
      <main>
        <section className="hero"><div><div className="hero-eyebrow"><span /> A LITTLE LESS, A LOT MORE</div><h1>{view === 'compressor' ? <>Small files.<span> Big possibilities.</span></> : <>Your files.<span> A little lighter.</span></>}</h1><p>{view === 'compressor' ? 'Give your images a lighter footprint. Keep the details that matter.' : 'All your compressed images, right here for this session.'}</p></div><div className="hero-decoration" aria-hidden="true"><span className="deco-file"><FileImage size={25} strokeWidth={1.4} /></span><span className="deco-dashes" /><span className="deco-arrow"><ArrowRight size={18} /></span><span className="deco-file tiny"><FileImage size={18} strokeWidth={1.6} /></span><span className="deco-spark">✦</span><span className="deco-caption">same image, less baggage.</span></div></section>

        {notice && <div className="notice" role="alert"><CircleHelp size={18} /><span>{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="Dismiss message"><X size={17} /></button></div>}

        {view === 'compressor' ? <>
          <div className="workspace-grid">
            <section className="upload-column" aria-labelledby="images-heading">
              <div className="section-title"><div><h2 id="images-heading">Your images</h2><span className="count-badge">{items.length}</span></div>{items.length ? <button className="text-button muted" onClick={() => removeFiles()}><Trash2 size={13} />Clear all</button> : <span className="section-hint">A lighter file starts here</span>}</div>
              <input className="visually-hidden" ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif,.jpg,.jpeg,.png,.webp,.avif" multiple onChange={(event) => addFiles(event.target.files)} aria-label="Choose images" />
              <div className={`dropzone ${dragging ? 'dragging' : ''} ${items.length ? 'has-files' : ''} ${busy ? 'is-busy' : ''}`} onDragEnter={(event) => { event.preventDefault(); dragDepth.current++; setDragging(true) }} onDragLeave={(event) => { event.preventDefault(); dragDepth.current--; if (dragDepth.current === 0) setDragging(false) }} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
                {items.length === 0 ? <><UploadIllustration /><h3>{dragging ? 'A soft landing, right here.' : 'Drop your images here'}</h3><p>Big images welcome. We’ll make them smaller.</p><button className="choose-button" onClick={() => inputRef.current?.click()}><Plus size={17} />Choose images</button><div className="upload-formats"><span>JPG, PNG, WebP, AVIF</span><span className="meta-dot" /><span>No file size limit</span></div></> : <><div className="mini-upload-icon"><Upload size={19} /></div><div><h3>{dragging ? 'Drop to add your images' : 'There’s room for a few more'}</h3><p>Drop images here or <button className="inline-button" disabled={items.length >= 20} onClick={() => inputRef.current?.click()}>browse files</button></p></div><button className="icon-button add-files-button" disabled={items.length >= 20} onClick={() => inputRef.current?.click()} aria-label="Add more images"><Plus size={20} /></button></>}
              </div>

              {selectedItem && <section className="live-preview" aria-labelledby="live-preview-heading"><div className="live-preview-heading"><div><h2 id="live-preview-heading">Live preview</h2><p>The output updates when you change the settings.</p></div><button className="icon-button" onClick={() => setComparisonId(selectedItem.id)} aria-label="Expand image comparison"><Expand size={17} /></button></div>{items.length > 1 && <div className="preview-file-select"><label htmlFor="preview-file">Image to compare</label><select id="preview-file" value={selectedItem.id} onChange={(event) => setSelectedId(event.target.value)}>{items.map((item) => <option key={item.id} value={item.id}>{item.file.name}</option>)}</select></div>}<ImageComparison key={selectedItem.id} item={selectedItem} pending={isPending(selectedItem)} settingsError={settingsError} /></section>}

              {items.length > 0 ? <div className="queue" aria-live="polite"><div className="queue-heading"><span>{items.length} {items.length === 1 ? 'IMAGE' : 'IMAGES'}<span className="meta-dot" />{formatBytes(items.reduce((sum, item) => sum + item.file.size, 0))} TOTAL</span>{completed.length === items.length && <span className="queue-done"><CheckCheck size={14} />All done</span>}</div><div className="file-list">{items.map((item) => renderFile(item))}</div>{completed.length > 0 && !previewsPending && <div className="results-summary"><div className="summary-icon"><Check size={19} /></div><div><strong>{totalSaved > 0 ? `${formatBytes(totalSaved)} lighter. Nice work.` : 'Your images are ready.'}</strong><span>{completed.length} {completed.length === 1 ? 'image' : 'images'} compressed, without an upload.</span></div><button className="download-all" onClick={() => void downloadAll()} disabled={zipping}>{zipping ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}<span>{completed.length > 1 ? 'Download all' : 'Download'}</span></button></div>}</div> : <div className="benefits"><div><span className="benefit-icon"><Target size={19} /></span><h3>Your size. Your way.</h3><p>Pick a file size, fine-tune<br />the quality, or resize.</p></div><div><span className="benefit-icon"><Zap size={19} /></span><h3>Less wait. More create.</h3><p>Lighten a whole batch<br />in just a few clicks.</p></div><div><span className="benefit-icon"><Sparkles size={19} /></span><h3>Small, not second best.</h3><p>Keep the good details.<br />Lose the extra weight.</p></div></div>}
              <button className="privacy-card" onClick={() => setInfo('privacy')}><span className="privacy-card-icon"><LockKeyhole size={19} /></span><span><strong>Your images are your business.</strong><span>No servers, no uploads. Everything stays in your browser.</span></span><ArrowUpRightIcon /></button>
            </section>

            <section className="settings-card" aria-labelledby="settings-heading"><div className="settings-title"><div className="settings-heading-icon"><SlidersHorizontal size={18} /></div><h2 id="settings-heading">Make it lighter</h2><span className="settings-step">YOUR CONTROLS</span></div><fieldset>
              <div className="mode-tabs" role="tablist" aria-label="Compression method">{modes.map(({ value, label, icon: Icon }) => <button type="button" id={`tab-${value}`} aria-selected={mode === value} aria-controls={`panel-${value}`} role="tab" tabIndex={mode === value ? 0 : -1} key={value} className={mode === value ? 'selected' : ''} onClick={() => setMode(value)} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const next = modes[(modes.findIndex((entry) => entry.value === mode) + (event.key === 'ArrowRight' ? 1 : 2)) % modes.length].value; setMode(next); document.getElementById(`tab-${next}`)?.focus() } }}><Icon size={14} />{label}</button>)}</div>
              <div className="mode-panel" role="tabpanel" id={`panel-${mode}`} aria-labelledby={`tab-${mode}`}>
                {mode === 'size' && <><div className="control-label"><label htmlFor="target-size">Target file size</label><span className="tiny-help" title="We find the best quality within this maximum file size."><CircleHelp size={14} /></span></div><div className="size-input-wrap"><input id="target-size" type="number" min={unit === 'KB' ? 1 : 0.001} step="any" value={target} onChange={(event) => setTarget(event.target.value)} /><div className="unit-select"><select aria-label="File size unit" value={unit} onChange={(event) => { const next = event.target.value as 'KB' | 'MB'; if (Number(target) > 0) setTarget(String(Number((next === 'MB' ? Number(target) / 1024 : Number(target) * 1024).toFixed(3)))); setUnit(next) }}><option>KB</option><option>MB</option></select><ChevronDown size={13} /></div></div><div className="presets size-presets">{[100, 200, 500, 1024].map((value) => <button key={value} className={Math.abs(targetKB - value) < 0.01 ? 'selected' : ''} onClick={() => choosePreset(value)}>{value === 1024 ? '1 MB' : `${value} KB`}</button>)}</div><p className="control-description">A specific size. The best quality we can fit.</p></>}
                {mode === 'quality' && <><div className="control-label"><label htmlFor="quality-level">Image quality</label><span className="quality-value">{quality}<span>%</span></span></div><input id="quality-level" className="range-input" type="range" min="10" max="100" value={quality} disabled={format === 'image/png'} style={{ '--range-progress': `${(quality - 10) / 90 * 100}%` } as CSSProperties} onChange={(event) => setQuality(Number(event.target.value))} /><div className="range-labels"><span>Smaller file</span><span>More detail</span></div><div className="presets">{[50, 75, 85, 95].map((value) => <button key={value} className={quality === value ? 'selected' : ''} disabled={format === 'image/png'} onClick={() => setQuality(value)}>{value}%</button>)}</div><p className="control-description">{format === 'image/png' ? 'PNG is lossless. Choose WebP or JPEG to adjust quality.' : 'Find your balance between file size and detail.'}</p></>}
                {mode === 'resize' && <><div className="control-label"><label htmlFor="max-dimension">Maximum width or height</label><Maximize size={14} /></div><div className="size-input-wrap"><input id="max-dimension" type="number" min="1" max="16384" step="1" value={dimension} onChange={(event) => setDimension(event.target.value)} /><span className="pixel-unit">px</span></div><div className="presets">{[640, 1280, 1920, 2560].map((value) => <button key={value} className={Number(dimension) === value ? 'selected' : ''} onClick={() => setDimension(String(value))}>{value}</button>)}</div><p className="control-description">Same proportions. Just a smaller canvas.</p></>}
              </div>
              <div className="setting-divider" />
              <div className="format-control"><div className="control-label"><label htmlFor="output-format">Output format</label><span className="optional-label">A fresh format, if you like</span></div><div className="format-select"><span className="format-icon"><FileImage size={17} /></span><select id="output-format" value={format} onChange={(event) => setFormat(event.target.value as OutputFormat)}>{formats.map((option) => <option value={option.value} key={option.value}>{option.label}{option.value === 'image/webp' ? '  (recommended)' : ''}</option>)}</select><ChevronDown size={15} /></div><p className="control-description">{selectedFormat.description}</p></div>
              <div className="setting-divider" />
              <div className="dimension-note"><span><Check size={15} /></span><div><strong>{mode === 'size' ? 'Always reaches your target' : mode === 'quality' ? 'Original dimensions, preserved' : 'Always in proportion'}</strong><p>{mode === 'size' ? 'Quality first, then a smaller canvas if needed.' : mode === 'quality' ? 'The same pixels. A lighter file.' : 'No stretching. No cropping. No upscaling.'}</p></div></div>
              {settingsError && <p className="settings-error" role="alert">{settingsError}</p>}
              <button className="compress-button" onClick={() => { if (!items.length) inputRef.current?.click(); else if (completed.length) void downloadAll(); else setPreviewVersion((current) => current + 1) }} disabled={zipping || (items.length > 0 && previewsPending)}>{previewsPending && items.length > 0 || zipping ? <LoaderCircle size={18} className="spin" /> : completed.length ? <Download size={17} /> : <Plus size={17} />}<span>{zipping ? 'Create ZIP…' : previewsPending && items.length > 0 ? `Update ${Math.min(progress + 1, items.length)} of ${items.length}…` : !items.length ? 'Choose images' : completed.length ? completed.length > 1 ? 'Download images' : 'Download image' : 'Retry preview'}</span>{!previewsPending && <ArrowRight size={17} />}</button>
            </fieldset><div className="settings-footer"><Zap size={11} /><span>{items.length === 0 ? 'Add images for an automatic preview.' : 'Previews update automatically. No extra clicks.'}</span></div></section>
          </div>
          <section className="bottom-strip"><div className="bottom-tagline"><span className="tiny-brand"><BrandMark small /></span><span>A lighter image makes a difference.</span></div><div className="bottom-benefits"><span><Gauge size={15} />Faster websites</span><span><FolderOpen size={15} />More space</span><span><ArrowDownToLine size={15} />Easier sharing</span></div></section>
        </> : <section className="recent-panel"><div className="section-title"><div><h2>Recent compressions</h2><span className="count-badge">{history.length}</span></div>{history.length > 0 && <button className="text-button" disabled={zipping} onClick={() => void downloadAll(history)}><Download size={15} />Download all</button>}</div>{history.length ? <><div className="recent-files">{history.map((item) => renderFile(item, true))}</div><p className="recent-note"><LockKeyhole size={13} />These files stay in this tab. Download them before you leave.</p></> : <div className="recent-empty"><span><Clock3 size={31} strokeWidth={1.5} /></span><h2>A fresh start.</h2><p>Your compressed images will appear here.<br />They stay available until you close or refresh this tab.</p><button className="choose-button" onClick={() => setView('compressor')}><ArrowLeft size={16} />Compress your first image</button></div>}</section>}
        <footer className="page-footer"><span>Less weight. Same wonderful.</span><button onClick={() => setInfo('privacy')}><ShieldCheck size={12} />Private by design</button></footer>
      </main>
    </div>

    {info && <Modal title={info === 'guide' ? 'Three steps to a lighter image.' : info === 'tips' ? 'A little know-how goes a long way.' : 'Your images never leave your device.'} eyebrow={info === 'privacy' ? 'PRIVATE BY DESIGN' : 'THE SQUEEZE GUIDE'} onClose={() => setInfo(null)}>
      {info === 'guide' && <div className="guide-content"><div><span className="guide-number">01</span><section><h3>Make yourself at home.</h3><p>Add up to 20 JPG, PNG, WebP, or AVIF images. There is no file size limit.</p></section></div><div><span className="guide-number">02</span><section><h3>Choose your kind of smaller.</h3><p>Set a maximum file size in KB or MB, adjust the quality, or reduce the image dimensions. Choose an output format.</p></section></div><div><span className="guide-number">03</span><section><h3>Compare and download.</h3><p>The output preview updates automatically. Compare the images side by side, then download each file or a ZIP.</p></section></div><button className="compress-button" onClick={() => { setInfo(null); setView('compressor') }}><span>Let’s make it lighter</span><ArrowRight size={17} /></button></div>}
      {info === 'tips' && <div className="tips-content"><section><span><Target size={20} /></span><div><h3>Have a file size limit?</h3><p>Use Target size for forms, email attachments, or portfolio uploads. Squeeze lowers the quality first, then the dimensions, until the file fits.</p></div></section><section><span><SlidersHorizontal size={20} /></span><div><h3>Start with 80% quality.</h3><p>For most photos, 75–85% offers a good balance. Use the comparison view to inspect the details before you download.</p></div></section><section><span><FileImage size={20} /></span><div><h3>The right format helps.</h3><p>WebP suits websites and supports transparency. JPEG suits photos. PNG keeps lossless detail, but often creates larger files.</p></div></section><section><span><Expand size={20} /></span><div><h3>Only keep the pixels you need.</h3><p>Try a maximum dimension of 1920 pixels for large web images, or 1280 pixels for smaller content areas.</p></div></section><p className="modal-footnote">Compression can remove image metadata. Convert HDR images or color-critical artwork with care.</p></div>}
      {info === 'privacy' && <div className="privacy-content"><div className="privacy-large-icon"><ShieldCheck size={38} strokeWidth={1.5} /></div><p>Squeeze processes each image locally with your browser. Your image files never go to a server.</p><ul><li><Check size={16} />No image uploads or cloud storage.</li><li><Check size={16} />No accounts or sign-ups.</li><li><Check size={16} />Recent files only last for this browser session.</li><li><Check size={16} />You choose which files to download.</li></ul><p className="modal-footnote">Download your results before you close or refresh this tab. Squeeze does not save your images.</p></div>}
    </Modal>}
    {comparison && <Modal title={comparison.file.name} eyebrow="A CLOSER LOOK" onClose={() => setComparisonId(null)} wide><ImageComparison key={comparison.id} item={comparison} pending={items.some((item) => item.id === comparison.id) && isPending(comparison)} settingsError={items.some((item) => item.id === comparison.id) ? settingsError : undefined} />{comparison.result && <div className="comparison-download"><button className="choose-button" onClick={() => downloadItem(comparison)} disabled={items.some((item) => item.id === comparison.id) && isPending(comparison)}><Download size={15} />Download image</button></div>}</Modal>}
  </div>
}

function ArrowUpRightIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>
}

export default App
