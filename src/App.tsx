import { useEffect, useRef, useState } from 'react'
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
}
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

function App() {
  const [items, setItems] = useState<QueueItem[]>([])
  const [history, setHistory] = useState<QueueItem[]>([])
  const [view, setView] = useState<'compressor' | 'recent'>('compressor')
  const [mode, setMode] = useState<CompressionMode>('size')
  const [target, setTarget] = useState('200')
  const [unit, setUnit] = useState<'KB' | 'MB'>('KB')
  const [quality, setQuality] = useState(80)
  const [dimension, setDimension] = useState('1920')
  const [format, setFormat] = useState<OutputFormat>('image/webp')
  const [allowResize, setAllowResize] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [zipping, setZipping] = useState(false)
  const [progress, setProgress] = useState(0)
  const [notice, setNotice] = useState('')
  const [info, setInfo] = useState<InfoModal>(null)
  const [comparison, setComparison] = useState<QueueItem | null>(null)
  const [split, setSplit] = useState(50)
  const inputRef = useRef<HTMLInputElement>(null)
  const objectUrls = useRef(new Set<string>())
  const dragDepth = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const urls = objectUrls.current
    return () => {
      mounted.current = false
      urls.forEach((url) => URL.revokeObjectURL(url))
      urls.clear()
    }
  }, [])

  const targetBytes = Number(target) * (unit === 'KB' ? 1024 : 1024 * 1024)
  const targetKB = targetBytes / 1024
  const completed = items.filter((item) => item.status === 'done' && item.result)
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
    if (!files || busy) return
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
      if (file.size > 20 * 1024 * 1024) {
        errors.push(`${file.name}: the maximum file size is 20 MB.`)
        continue
      }
      if (file.size === 0) {
        errors.push(`${file.name}: this file is empty.`)
        continue
      }
      if ([...items, ...accepted].some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) continue
      accepted.push({ id: crypto.randomUUID(), file, preview: trackUrl(file), status: 'ready' })
    }
    setItems((current) => [...current, ...accepted])
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

  async function runCompression() {
    if (busy) return
    if (!items.length) {
      inputRef.current?.click()
      return
    }
    if (mode === 'size' && (!Number.isFinite(targetBytes) || targetBytes < 1024 || targetBytes > 100 * 1024 * 1024)) {
      setNotice('Choose a target size between 1 KB and 100 MB.')
      return
    }
    if (mode === 'resize' && (!Number.isInteger(Number(dimension)) || Number(dimension) < 1 || Number(dimension) > 16384)) {
      setNotice('Choose a dimension between 1 and 16,384 pixels.')
      return
    }
    setNotice('')
    setBusy(true)
    setProgress(0)
    const settings: CompressionSettings = { mode, targetBytes, quality: quality / 100, format, allowResize, maxWidth: Number(dimension), maxHeight: Number(dimension) }
    for (let index = 0; index < items.length; index++) {
      if (!mounted.current) break
      const item = items[index]
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: 'working', error: undefined } : entry))
      try {
        const result = await compressImage(item.file, settings)
        if (!mounted.current) break
        const finished: QueueItem = { ...item, result, resultUrl: trackUrl(result.blob), status: 'done', format, error: undefined }
        setItems((current) => current.map((entry) => entry.id === item.id ? finished : entry))
        setHistory((current) => [finished, ...current.filter((entry) => entry.id !== item.id)])
      } catch (error) {
        if (!mounted.current) break
        setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: 'error', result: undefined, resultUrl: undefined, error: error instanceof Error ? error.message : 'This image could not be compressed.' } : entry))
      }
      setProgress(index + 1)
    }
    if (mounted.current) setBusy(false)
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
    return <div className={`file-row ${item.status}`} key={item.id}>
      <button className="file-thumbnail" disabled={!item.result} onClick={() => { setComparison(item); setSplit(50) }} aria-label={`Preview ${item.file.name}`}><img src={item.preview} alt="" /></button>
      <div className="file-information"><span className="file-name" title={item.file.name}>{item.file.name}</span><div className="file-meta"><span>{formatBytes(item.file.size)}</span>{item.result && <><ArrowRight size={11} /><strong>{formatBytes(item.result.blob.size)}</strong></>}{item.status === 'ready' && <><span className="meta-dot" />Ready to compress</>}{item.status === 'working' && <span className="working-label">Compress...</span>}</div>{item.error && <p className="file-error">{item.error}</p>}{item.result && !item.result.targetMet && <p className="file-warning">Target not reached. Allow resize or increase the target.</p>}{item.result && saved < 0 && <p className="file-warning">This format is larger. Try WebP or a lower quality.</p>}</div>
      {item.status === 'working' ? <LoaderCircle size={18} className="spin" /> : item.result ? <div className="file-actions">{saved > 0 && <span className="saving-badge">−{saved}%</span>}<button className="icon-button preview-button" onClick={() => { setComparison(item); setSplit(50) }} aria-label={`Compare ${item.file.name}`}><ScanLine size={17} /></button><button className="icon-button file-download" onClick={() => downloadItem(item)} aria-label={`Download ${item.file.name}`}><ArrowDownToLine size={17} /></button></div> : <FileImage size={16} className="ready-icon" />}
      {!isHistory && <button className="icon-button remove-file" disabled={busy} onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))} aria-label={`Remove ${item.file.name}`}><X size={15} /></button>}
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
              <div className="section-title"><div><h2 id="images-heading">Your images</h2><span className="count-badge">{items.length}</span></div>{items.length ? <button className="text-button muted" onClick={() => setItems([])} disabled={busy}><Trash2 size={13} />Clear all</button> : <span className="section-hint">A lighter file starts here</span>}</div>
              <input className="visually-hidden" ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif,.jpg,.jpeg,.png,.webp,.avif" multiple onChange={(event) => addFiles(event.target.files)} aria-label="Choose images" disabled={busy} />
              <div className={`dropzone ${dragging ? 'dragging' : ''} ${items.length ? 'has-files' : ''} ${busy ? 'is-busy' : ''}`} onDragEnter={(event) => { event.preventDefault(); dragDepth.current++; setDragging(true) }} onDragLeave={(event) => { event.preventDefault(); dragDepth.current--; if (dragDepth.current === 0) setDragging(false) }} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
                {items.length === 0 ? <><UploadIllustration /><h3>{dragging ? 'A soft landing, right here.' : 'Drop your images here'}</h3><p>Big images welcome. We’ll make them smaller.</p><button className="choose-button" onClick={() => inputRef.current?.click()} disabled={busy}><Plus size={17} />Choose images</button><div className="upload-formats"><span>JPG, PNG, WebP, AVIF</span><span className="meta-dot" /><span>Up to 20 MB each</span></div></> : <><div className="mini-upload-icon"><Upload size={19} /></div><div><h3>{dragging ? 'Drop to add your images' : 'There’s room for a few more'}</h3><p>Drop images here or <button className="inline-button" disabled={busy || items.length >= 20} onClick={() => inputRef.current?.click()}>browse files</button></p></div><button className="icon-button add-files-button" disabled={busy || items.length >= 20} onClick={() => inputRef.current?.click()} aria-label="Add more images"><Plus size={20} /></button></>}
              </div>

              {items.length > 0 ? <div className="queue" aria-live="polite"><div className="queue-heading"><span>{items.length} {items.length === 1 ? 'IMAGE' : 'IMAGES'}<span className="meta-dot" />{formatBytes(items.reduce((sum, item) => sum + item.file.size, 0))} TOTAL</span>{completed.length === items.length && <span className="queue-done"><CheckCheck size={14} />All done</span>}</div><div className="file-list">{items.map((item) => renderFile(item))}</div>{completed.length > 0 && !busy && <div className="results-summary"><div className="summary-icon"><Check size={19} /></div><div><strong>{totalSaved > 0 ? `${formatBytes(totalSaved)} lighter. Nice work.` : 'Your images are ready.'}</strong><span>{completed.length} {completed.length === 1 ? 'image' : 'images'} compressed, without an upload.</span></div><button className="download-all" onClick={() => void downloadAll()} disabled={zipping}>{zipping ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}<span>{completed.length > 1 ? 'Download all' : 'Download'}</span></button></div>}</div> : <div className="benefits"><div><span className="benefit-icon"><Target size={19} /></span><h3>Your size. Your way.</h3><p>Pick a file size, fine-tune<br />the quality, or resize.</p></div><div><span className="benefit-icon"><Zap size={19} /></span><h3>Less wait. More create.</h3><p>Lighten a whole batch<br />in just a few clicks.</p></div><div><span className="benefit-icon"><Sparkles size={19} /></span><h3>Small, not second best.</h3><p>Keep the good details.<br />Lose the extra weight.</p></div></div>}
              <button className="privacy-card" onClick={() => setInfo('privacy')}><span className="privacy-card-icon"><LockKeyhole size={19} /></span><span><strong>Your images are your business.</strong><span>No servers, no uploads. Everything stays in your browser.</span></span><ArrowUpRightIcon /></button>
            </section>

            <section className="settings-card" aria-labelledby="settings-heading"><div className="settings-title"><div className="settings-heading-icon"><SlidersHorizontal size={18} /></div><h2 id="settings-heading">Make it lighter</h2><span className="settings-step">YOUR CONTROLS</span></div><fieldset disabled={busy}>
              <div className="mode-tabs" role="tablist" aria-label="Compression method">{modes.map(({ value, label, icon: Icon }) => <button type="button" id={`tab-${value}`} aria-selected={mode === value} aria-controls={`panel-${value}`} role="tab" tabIndex={mode === value ? 0 : -1} key={value} className={mode === value ? 'selected' : ''} onClick={() => setMode(value)} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const next = modes[(modes.findIndex((entry) => entry.value === mode) + (event.key === 'ArrowRight' ? 1 : 2)) % modes.length].value; setMode(next); document.getElementById(`tab-${next}`)?.focus() } }}><Icon size={14} />{label}</button>)}</div>
              <div className="mode-panel" role="tabpanel" id={`panel-${mode}`} aria-labelledby={`tab-${mode}`}>
                {mode === 'size' && <><div className="control-label"><label htmlFor="target-size">Target file size</label><span className="tiny-help" title="We find the best quality within this maximum file size."><CircleHelp size={14} /></span></div><div className="size-input-wrap"><input id="target-size" type="number" min={unit === 'KB' ? 1 : 0.001} max={unit === 'KB' ? 102400 : 100} step="any" value={target} onChange={(event) => setTarget(event.target.value)} /><div className="unit-select"><select aria-label="File size unit" value={unit} onChange={(event) => { const next = event.target.value as 'KB' | 'MB'; if (Number(target) > 0) setTarget(String(Number((next === 'MB' ? Number(target) / 1024 : Number(target) * 1024).toFixed(3)))); setUnit(next) }}><option>KB</option><option>MB</option></select><ChevronDown size={13} /></div></div><div className="presets size-presets">{[100, 200, 500, 1024].map((value) => <button key={value} className={Math.abs(targetKB - value) < 0.01 ? 'selected' : ''} onClick={() => choosePreset(value)}>{value === 1024 ? '1 MB' : `${value} KB`}</button>)}</div><p className="control-description">A specific size. The best quality we can fit.</p></>}
                {mode === 'quality' && <><div className="control-label"><label htmlFor="quality-level">Image quality</label><span className="quality-value">{quality}<span>%</span></span></div><input id="quality-level" className="range-input" type="range" min="10" max="100" value={quality} disabled={format === 'image/png'} style={{ '--range-progress': `${(quality - 10) / 90 * 100}%` } as CSSProperties} onChange={(event) => setQuality(Number(event.target.value))} /><div className="range-labels"><span>Smaller file</span><span>More detail</span></div><div className="presets">{[50, 75, 85, 95].map((value) => <button key={value} className={quality === value ? 'selected' : ''} disabled={format === 'image/png'} onClick={() => setQuality(value)}>{value}%</button>)}</div><p className="control-description">{format === 'image/png' ? 'PNG is lossless. Choose WebP or JPEG to adjust quality.' : 'Find your balance between file size and detail.'}</p></>}
                {mode === 'resize' && <><div className="control-label"><label htmlFor="max-dimension">Maximum width or height</label><Maximize size={14} /></div><div className="size-input-wrap"><input id="max-dimension" type="number" min="1" max="16384" step="1" value={dimension} onChange={(event) => setDimension(event.target.value)} /><span className="pixel-unit">px</span></div><div className="presets">{[640, 1280, 1920, 2560].map((value) => <button key={value} className={Number(dimension) === value ? 'selected' : ''} onClick={() => setDimension(String(value))}>{value}</button>)}</div><p className="control-description">Same proportions. Just a smaller canvas.</p></>}
              </div>
              <div className="setting-divider" />
              <div className="format-control"><div className="control-label"><label htmlFor="output-format">Output format</label><span className="optional-label">A fresh format, if you like</span></div><div className="format-select"><span className="format-icon"><FileImage size={17} /></span><select id="output-format" value={format} onChange={(event) => setFormat(event.target.value as OutputFormat)}>{formats.map((option) => <option value={option.value} key={option.value}>{option.label}{option.value === 'image/webp' ? '  (recommended)' : ''}</option>)}</select><ChevronDown size={15} /></div><p className="control-description">{selectedFormat.description}</p></div>
              <div className="setting-divider" />
              {mode === 'size' ? <div className="toggle-row"><div><label htmlFor="auto-resize">Auto-resize if needed</label><p>A little resize to reach your target.</p></div><button id="auto-resize" role="switch" aria-checked={allowResize} aria-label="Auto-resize if needed" className={`toggle ${allowResize ? 'on' : ''}`} onClick={() => setAllowResize(!allowResize)}><span /></button></div> : <div className="dimension-note"><span><Check size={15} /></span><div><strong>{mode === 'quality' ? 'Original dimensions, preserved' : 'Always in proportion'}</strong><p>{mode === 'quality' ? 'The same pixels. A lighter file.' : 'No stretching. No cropping. No upscaling.'}</p></div></div>}
              <button className="compress-button" onClick={() => void runCompression()} disabled={busy}>{busy ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={17} />}<span>{busy ? `Compressing ${Math.min(progress + 1, items.length)} of ${items.length}…` : completed.length === items.length && items.length > 0 ? 'Compress again' : 'Compress images'}</span>{!busy && <ArrowRight size={17} />}</button>
            </fieldset><div className="settings-footer"><LockKeyhole size={11} /><span>{busy ? 'Your browser is doing the work.' : items.length === 0 ? 'Add your images. We’ll take it from there.' : 'Private, fast, and entirely on your device.'}</span></div></section>
          </div>
          <section className="bottom-strip"><div className="bottom-tagline"><span className="tiny-brand"><BrandMark small /></span><span>A lighter image makes a difference.</span></div><div className="bottom-benefits"><span><Gauge size={15} />Faster websites</span><span><FolderOpen size={15} />More space</span><span><ArrowDownToLine size={15} />Easier sharing</span></div></section>
        </> : <section className="recent-panel"><div className="section-title"><div><h2>Recent compressions</h2><span className="count-badge">{history.length}</span></div>{history.length > 0 && <button className="text-button" disabled={zipping} onClick={() => void downloadAll(history)}><Download size={15} />Download all</button>}</div>{history.length ? <><div className="recent-files">{history.map((item) => renderFile(item, true))}</div><p className="recent-note"><LockKeyhole size={13} />These files stay in this tab. Download them before you leave.</p></> : <div className="recent-empty"><span><Clock3 size={31} strokeWidth={1.5} /></span><h2>A fresh start.</h2><p>Your compressed images will appear here.<br />They stay available until you close or refresh this tab.</p><button className="choose-button" onClick={() => setView('compressor')}><ArrowLeft size={16} />Compress your first image</button></div>}</section>}
        <footer className="page-footer"><span>Less weight. Same wonderful.</span><button onClick={() => setInfo('privacy')}><ShieldCheck size={12} />Private by design</button></footer>
      </main>
    </div>

    {info && <Modal title={info === 'guide' ? 'Three steps to a lighter image.' : info === 'tips' ? 'A little know-how goes a long way.' : 'Your images never leave your device.'} eyebrow={info === 'privacy' ? 'PRIVATE BY DESIGN' : 'THE SQUEEZE GUIDE'} onClose={() => setInfo(null)}>
      {info === 'guide' && <div className="guide-content"><div><span className="guide-number">01</span><section><h3>Make yourself at home.</h3><p>Add up to 20 JPG, PNG, WebP, or AVIF images. Each file can be up to 20 MB.</p></section></div><div><span className="guide-number">02</span><section><h3>Choose your kind of smaller.</h3><p>Set a maximum file size in KB or MB, adjust the quality, or reduce the image dimensions. Choose an output format.</p></section></div><div><span className="guide-number">03</span><section><h3>Give it a squeeze.</h3><p>Compress your images, compare the results, and download each file or a ZIP. All the work happens in your browser.</p></section></div><button className="compress-button" onClick={() => { setInfo(null); setView('compressor') }}><span>Let’s make it lighter</span><ArrowRight size={17} /></button></div>}
      {info === 'tips' && <div className="tips-content"><section><span><Target size={20} /></span><div><h3>Have a file size limit?</h3><p>Use Target size for forms, email attachments, or portfolio uploads. Enable auto-resize to help reach smaller targets.</p></div></section><section><span><SlidersHorizontal size={20} /></span><div><h3>Start with 80% quality.</h3><p>For most photos, 75–85% offers a good balance. Use the comparison view to inspect the details before you download.</p></div></section><section><span><FileImage size={20} /></span><div><h3>The right format helps.</h3><p>WebP suits websites and supports transparency. JPEG suits photos. PNG keeps lossless detail, but often creates larger files.</p></div></section><section><span><Expand size={20} /></span><div><h3>Only keep the pixels you need.</h3><p>Try a maximum dimension of 1920 pixels for large web images, or 1280 pixels for smaller content areas.</p></div></section><p className="modal-footnote">Compression can remove image metadata. Convert HDR images or color-critical artwork with care.</p></div>}
      {info === 'privacy' && <div className="privacy-content"><div className="privacy-large-icon"><ShieldCheck size={38} strokeWidth={1.5} /></div><p>Squeeze processes each image locally with your browser. Your image files never go to a server.</p><ul><li><Check size={16} />No image uploads or cloud storage.</li><li><Check size={16} />No accounts or sign-ups.</li><li><Check size={16} />Recent files only last for this browser session.</li><li><Check size={16} />You choose which files to download.</li></ul><p className="modal-footnote">Download your results before you close or refresh this tab. Squeeze does not save your images.</p></div>}
    </Modal>}
    {comparison?.result && <Modal title={comparison.file.name} eyebrow="A CLOSER LOOK" onClose={() => setComparison(null)} wide><div className="comparison-canvas"><img src={comparison.preview} alt="Original image" /><div className="comparison-overlay" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}><img src={comparison.resultUrl} alt="Compressed image" /></div><span className="compare-label after">Compressed</span><span className="compare-label before">Original</span><div className="comparison-divider" style={{ left: `${split}%` }}><span><ChevronRight size={15} /><ChevronRight size={15} /></span></div><input type="range" min="0" max="100" value={split} onChange={(event) => setSplit(Number(event.target.value))} aria-label="Compare original and compressed image" /></div><div className="comparison-details"><div><span>Original</span><strong>{formatBytes(comparison.file.size)}</strong></div><ArrowRight size={19} /><div><span>Compressed · {comparison.result.width} × {comparison.result.height}</span><strong>{formatBytes(comparison.result.blob.size)}</strong></div><button className="choose-button" onClick={() => downloadItem(comparison)}><Download size={15} />Download</button></div><p className="modal-footnote">Drag across the image to compare. The compressed image appears on the left.</p></Modal>}
  </div>
}

function ArrowUpRightIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>
}

export default App
