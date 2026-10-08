import { type HTMLAttributes, type PointerEvent, useEffect, useRef } from 'react'

import styles from './AsciiEffect.module.css'

export interface AsciiEffectProps extends Omit<HTMLAttributes<HTMLDivElement>, 'color'> {
  imageSrc: string
  alt?: string
  variant?: 'image' | 'flow' | 'glitch'
  chars?: string
  fontSize?: number
  fontFamily?: string
  fontWeight?: number | string
  lineHeight?: number
  characterSpacing?: number
  brightnessBoost?: number
  contrast?: number
  threshold?: number
  posterize?: number
  dither?: 'none' | 'floyd-steinberg' | 'bayer'
  ditherStrength?: number
  flowSpeed?: number
  flowDirection?: number
  flowStrength?: number
  flowFrequency?: number
  mouseRadius?: number
  mouseStrength?: number
  mouseWaveSpeed?: number
  scale?: number
  fit?: 'cover' | 'contain' | 'stretch'
  colors?: string[]
  colorMode?: 'gradient' | 'source'
  backgroundColor?: string
  invert?: boolean
  glitchIntensity?: number
  glitchFrequency?: number
  revealDuration?: number
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))

function resolveColor(element: HTMLElement, color: string): string {
  const match = /^var\((--[^),]+)(?:,[^)]+)?\)$/.exec(color.trim())
  if (!match) return color
  return getComputedStyle(element).getPropertyValue(match[1]).trim() || color
}

function parseHex(color: string): [number, number, number] | null {
  const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(color)
  if (short)
    return short.slice(1).map((part) => Number.parseInt(`${part}${part}`, 16)) as [
      number,
      number,
      number,
    ]
  const full = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color)
  return full
    ? (full.slice(1).map((part) => Number.parseInt(part, 16)) as [number, number, number])
    : null
}

function gradientColor(colors: string[], amount: number): string {
  if (colors.length < 2) return colors[0] ?? '#ffffff'
  const position = clamp(amount) * (colors.length - 1)
  const index = Math.min(Math.floor(position), colors.length - 2)
  const mix = position - index
  const from = parseHex(colors[index])
  const to = parseHex(colors[index + 1])
  if (!from || !to) return colors[Math.round(position)] ?? colors[0]
  return `rgb(${from.map((channel, i) => Math.round(channel + (to[i] - channel) * mix)).join(', ')})`
}

export function AsciiEffect({
  imageSrc,
  alt = 'ASCII rendering',
  variant = 'image',
  chars = ' .:-=+*#%@',
  fontSize = 9,
  fontFamily = 'Arial, Helvetica, sans-serif',
  fontWeight = 400,
  lineHeight = 1,
  characterSpacing = 1,
  brightnessBoost = 2.2,
  contrast = 1.1,
  threshold = 0.06,
  posterize = 32,
  dither = 'floyd-steinberg',
  ditherStrength = 0.8,
  flowSpeed = 0.22,
  flowDirection = 0,
  flowStrength = 12,
  flowFrequency = 0.018,
  mouseRadius = 150,
  mouseStrength = 22,
  mouseWaveSpeed = 1.2,
  scale = 1.15,
  fit = 'cover',
  colors = ['var(--fg-faint)', 'var(--accent)'],
  colorMode = 'gradient',
  backgroundColor = 'transparent',
  invert = false,
  glitchIntensity = 0.65,
  glitchFrequency = 1.4,
  revealDuration = 1400,
  className,
  onPointerMove,
  onPointerLeave,
  ...props
}: AsciiEffectProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pointer = useRef({ x: 0, y: 0, targetX: 0, targetY: 0, active: false })

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas || !chars.length) return
    const context = canvas.getContext('2d')
    const sampleCanvas = document.createElement('canvas')
    const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true })
    if (!context || !sampleContext) return

    const image = new Image()
    image.crossOrigin = 'anonymous'
    let frame = 0
    let width = 0
    let height = 0
    let loaded = false
    let startedAt = 0
    let lastFrameAt = 0
    let nextGlitchAt = 0
    let glitchUntil = 0
    let glitchBands = new Map<number, number>()
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // The image, its luminance and the dithering depend only on the size, so
    // they are sampled once per resize instead of on every frame — reading the
    // pixels back from a canvas stalls the GPU each time.
    type Sample = {
      columns: number
      rows: number
      cellWidth: number
      cellHeight: number
      pixels: Uint8ClampedArray
      luminance: Float32Array
    }
    let sample: Sample | null = null
    // Colors come from theme variables and are resolved about once a second, so
    // a theme switch still reaches the effect without a style lookup per frame.
    const PALETTE_STEPS = 64
    let palette: string[] = []
    let paletteAt = -Infinity

    const buildSample = (): Sample => {
      const cellHeight = Math.max(4, fontSize * Math.max(0.5, lineHeight))
      context.font = `${fontWeight} ${fontSize}px ${fontFamily}`
      const cellWidth = Math.max(
        2,
        context.measureText('M').width * Math.max(0.5, characterSpacing),
      )
      const columns = Math.ceil(width / cellWidth) + 2
      const rows = Math.ceil(height / cellHeight) + 2
      sampleCanvas.width = columns
      sampleCanvas.height = rows

      const imageScale =
        fit === 'stretch'
          ? 1
          : (fit === 'contain'
              ? Math.min(width / image.naturalWidth, height / image.naturalHeight)
              : Math.max(width / image.naturalWidth, height / image.naturalHeight)) *
            Math.max(0.1, scale)
      const drawWidth = fit === 'stretch' ? columns : (image.naturalWidth * imageScale) / cellWidth
      const drawHeight = fit === 'stretch' ? rows : (image.naturalHeight * imageScale) / cellHeight
      sampleContext.clearRect(0, 0, columns, rows)
      sampleContext.drawImage(
        image,
        (columns - drawWidth) / 2,
        (rows - drawHeight) / 2,
        drawWidth,
        drawHeight,
      )

      const pixels = sampleContext.getImageData(0, 0, columns, rows).data
      const luminance = new Float32Array(columns * rows)
      const steps = Math.max(2, Math.round(posterize))
      for (let index = 0; index < luminance.length; index += 1) {
        const pixel = index * 4
        const alpha = pixels[pixel + 3] / 255
        let value =
          (pixels[pixel] * 0.2126 + pixels[pixel + 1] * 0.7152 + pixels[pixel + 2] * 0.0722) / 255
        value = clamp((value - 0.5) * Math.max(0, contrast) + 0.5)
        value = clamp(value * brightnessBoost * alpha)
        luminance[index] =
          value <= threshold ? 0 : (value - threshold) / Math.max(0.001, 1 - threshold)
      }

      if (dither === 'bayer') {
        const matrix = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
        luminance.forEach((value, index) => {
          const row = Math.floor(index / columns)
          const col = index % columns
          luminance[index] = clamp(
            value + ((matrix[(row % 4) * 4 + (col % 4)] / 16 - 0.5) * clamp(ditherStrength)) / 4,
          )
        })
      } else {
        luminance.forEach((value, index) => {
          const quantized = Math.round(clamp(value) * (steps - 1)) / (steps - 1)
          luminance[index] =
            dither === 'floyd-steinberg'
              ? value + (quantized - value) * clamp(ditherStrength)
              : quantized
        })
      }

      return { columns, rows, cellWidth, cellHeight, pixels, luminance }
    }

    const draw = (now: number) => {
      if (!loaded || !width || !height) return
      pointer.current.x += (pointer.current.targetX - pointer.current.x) * 0.08
      pointer.current.y += (pointer.current.targetY - pointer.current.y) * 0.08

      sample ??= buildSample()
      const { columns, rows, cellWidth, cellHeight, pixels, luminance } = sample
      context.font = `${fontWeight} ${fontSize}px ${fontFamily}`

      if (variant === 'glitch' && !reduceMotion && glitchFrequency > 0 && now >= nextGlitchAt) {
        glitchBands = new Map()
        const count = Math.max(1, Math.round(clamp(glitchIntensity) * 4))
        for (let i = 0; i < count; i += 1) {
          const row = Math.floor(Math.random() * rows)
          glitchBands.set(row, (Math.random() - 0.5) * fontSize * 12 * clamp(glitchIntensity))
        }
        glitchUntil = now + 70 + 90 * clamp(glitchIntensity)
        nextGlitchAt = now + 1000 / glitchFrequency
      }
      if (now > glitchUntil) glitchBands.clear()

      if (now - paletteAt > 1000) {
        paletteAt = now
        const resolvedColors = colors.map((color) => resolveColor(container, color))
        palette = Array.from({ length: PALETTE_STEPS }, (_, step) =>
          gradientColor(resolvedColors, step / (PALETTE_STEPS - 1)),
        )
      }
      const resolvedBackground = resolveColor(container, backgroundColor)
      context.clearRect(0, 0, width, height)
      if (resolvedBackground !== 'transparent') {
        context.fillStyle = resolvedBackground
        context.fillRect(0, 0, width, height)
      }
      context.textBaseline = 'top'
      const reveal =
        variant === 'glitch' && !reduceMotion && revealDuration > 0
          ? clamp((now - startedAt) / revealDuration)
          : 1
      const radians = (flowDirection * Math.PI) / 180
      const directionX = Math.cos(radians)
      const directionY = Math.sin(radians)

      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const dx = column / Math.max(1, columns - 1) - 0.5
          const dy = row / Math.max(1, rows - 1) - 0.5
          if (Math.hypot(dx, dy) > reveal * 0.72) continue
          let sourceColumn = column
          let sourceRow = row
          if (variant === 'flow' && !reduceMotion) {
            const x = column * cellWidth
            const y = row * cellHeight
            const phase =
              (x * directionX + y * directionY) * flowFrequency + now * flowSpeed * Math.PI * 0.002
            const drift = Math.sin(phase) * flowStrength
            sourceColumn -= (directionX * drift) / cellWidth
            sourceRow -= (directionY * drift) / cellHeight
            if (pointer.current.active && mouseRadius > 0) {
              const mouseX = x - pointer.current.x
              const mouseY = y - pointer.current.y
              const distance = Math.hypot(mouseX, mouseY)
              const influence = clamp(1 - distance / mouseRadius)
              if (distance > 0 && influence > 0) {
                const ripple = Math.sin(distance * 0.055 - now * mouseWaveSpeed * Math.PI * 0.002)
                sourceColumn -=
                  ((mouseX / distance) * influence ** 2 * mouseStrength * ripple) / cellWidth
                sourceRow -=
                  ((mouseY / distance) * influence ** 2 * mouseStrength * ripple) / cellHeight
              }
            }
          }
          const sampledColumn = Math.round(clamp(sourceColumn, 0, columns - 1))
          const sampledRow = Math.round(clamp(sourceRow, 0, rows - 1))
          const sampleIndex = sampledRow * columns + sampledColumn
          const pixel = sampleIndex * 4
          const value = invert ? 1 - clamp(luminance[sampleIndex]) : clamp(luminance[sampleIndex])
          const character =
            chars[Math.min(chars.length - 1, Math.floor(value * (chars.length - 1)))]
          if (!character?.trim()) continue
          context.fillStyle =
            colorMode === 'source'
              ? `rgb(${pixels[pixel]}, ${pixels[pixel + 1]}, ${pixels[pixel + 2]})`
              : palette[Math.round(value * (PALETTE_STEPS - 1))]
          context.fillText(
            character,
            column * cellWidth - cellWidth + (glitchBands.get(row) ?? 0),
            row * cellHeight - cellHeight,
          )
        }
      }
    }

    const resize = () => {
      sample = null
      const rect = container.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      draw(performance.now())
    }

    const animate = (now: number) => {
      if (now - lastFrameAt >= 1000 / 24) {
        lastFrameAt = now
        draw(now)
      }
      frame = requestAnimationFrame(animate)
    }

    const start = () => {
      if (loaded) return
      loaded = true
      startedAt = performance.now()
      resize()
      if (!reduceMotion && variant !== 'image') frame = requestAnimationFrame(animate)
    }
    image.onload = start
    image.src = imageSrc
    if (image.complete) start()
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      image.onload = null
    }
  }, [
    backgroundColor,
    brightnessBoost,
    characterSpacing,
    chars,
    colorMode,
    colors,
    contrast,
    dither,
    ditherStrength,
    fit,
    flowDirection,
    flowFrequency,
    flowSpeed,
    flowStrength,
    fontFamily,
    fontSize,
    fontWeight,
    glitchFrequency,
    glitchIntensity,
    imageSrc,
    invert,
    lineHeight,
    mouseRadius,
    mouseStrength,
    mouseWaveSpeed,
    posterize,
    revealDuration,
    scale,
    threshold,
    variant,
  ])

  const trackPointer = (event: PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(event)
    if (variant !== 'flow') return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    if (!pointer.current.active) {
      pointer.current.x = x
      pointer.current.y = y
    }
    pointer.current.active = true
    pointer.current.targetX = x
    pointer.current.targetY = y
  }

  const resetPointer = (event: PointerEvent<HTMLDivElement>) => {
    onPointerLeave?.(event)
    pointer.current.active = false
  }

  return (
    <div
      ref={containerRef}
      className={`${styles.root} ${className ?? ''}`}
      onPointerMove={trackPointer}
      onPointerLeave={resetPointer}
      {...props}
    >
      <canvas ref={canvasRef} role="img" aria-label={alt} className={styles.canvas} />
    </div>
  )
}
