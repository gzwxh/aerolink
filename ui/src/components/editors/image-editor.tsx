import { useCallback, useId, useRef, useState } from 'react'
import { Container } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'

import { formatDate } from '@/lib/utils'

import { useImageTags } from '../../lib/api'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

interface ImageEditorProps {
  container: Container
  onUpdate: (updates: Partial<Container>) => void
}

export function ImageEditor({ container, onUpdate }: ImageEditorProps) {
  const { t } = useTranslation()
  const [showTagDropdown, setShowTagDropdown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // 每个实例唯一：同时会有多个容器渲染 ImageEditor。
  const inputId = useId()

  const getImagePrefix = useCallback((image: string) => {
    if (!image) return ''
    const idx = image.lastIndexOf(':')
    if (idx === -1) return image
    return image.slice(0, idx)
  }, [])

  const [imagePrefix, setImagePrefix] = useState(
    getImagePrefix(container.image || '')
  )

  const updateImage = useCallback(
    (image: string) => {
      onUpdate({ image })
      setImagePrefix(getImagePrefix(image))
    },
    [getImagePrefix, onUpdate]
  )

  const { data: tagOptions, isLoading: tagLoading } = useImageTags(
    imagePrefix || '',
    { enabled: !!imagePrefix && showTagDropdown }
  )

  function handleInputFocus() {
    setShowTagDropdown(true)
  }
  function handleTagSelect(tag: string) {
    const prefix = getImagePrefix(container.image || '')
    const newImage = prefix ? `${prefix}:${tag}` : tag
    onUpdate({ image: newImage })
    setShowTagDropdown(false)
    inputRef.current?.focus()
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2 relative">
        <Label htmlFor={inputId}>
          {t('workloadWizard.imageLabel', '容器镜像')}
        </Label>
        <Input
          id={inputId}
          ref={inputRef}
          value={container.image || ''}
          onFocus={handleInputFocus}
          onBlur={() => setShowTagDropdown(false)}
          onChange={(e) => updateImage(e.target.value)}
          placeholder="nginx:latest"
          autoComplete="off"
        />
        {showTagDropdown && (
          <div className="absolute z-10 mt-1 w-full bg-popover border rounded shadow max-h-60 overflow-auto">
            {tagLoading && (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                {t('common.messages.loading', '加载中...')}
              </div>
            )}
            {tagOptions?.map((tag) => (
              <div
                key={tag.name}
                className="px-3 py-2 cursor-pointer hover:bg-accent text-sm flex justify-between"
                onMouseDown={() => handleTagSelect(tag.name)}
              >
                <span>{tag.name}</span>
                {tag.timestamp && (
                  <span className="text-xs text-muted-foreground ml-2">
                    {formatDate(tag.timestamp)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {t(
            'workloadWizard.imageHint',
            'Specify the container image including tag (e.g., nginx:1.21, node:16-alpine)'
          )}
        </p>
      </div>
    </div>
  )
}
