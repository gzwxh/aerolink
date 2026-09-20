import { useEffect, useRef, useState } from 'react'
import { IconCheck, IconEdit, IconLoader, IconX } from '@tabler/icons-react'
import * as yaml from 'js-yaml'
import type { editor as monacoEditor } from 'monaco-editor'
import { useTranslation } from 'react-i18next'

import { ResourceType, ResourceTypeMap } from '@/types/api'
import { MonacoEditor } from '@/lib/monaco-loader'
import {
  defineMonacoBackgroundThemes,
  useMonacoBackgroundColor,
} from '@/lib/monaco-theme'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

import { useAppearance } from './appearance-provider'
import { ErrorBoundary } from './error-boundary'

interface YamlEditorProps<T extends ResourceType> {
  /** 要编辑的 YAML 内容 */
  value: string
  /** 编辑器默认是否处于只读模式 */
  readOnly?: boolean
  /** 是否显示编辑控件 */
  showControls?: boolean
  /** 卡片标题 */
  title?: string
  /** 编辑器的最小高度 */
  minHeight?: number
  /** YAML 内容变化时的回调 */
  onChange?: (value: string) => void
  /** 点击保存时的回调 */
  onSave?: (value: ResourceTypeMap[T]) => void
  /** 点击取消时的回调 */
  onCancel?: () => void
  /** 保存操作是否进行中 */
  isSaving?: boolean
  /** 卡片的自定义类名 */
  className?: string
  fillHeight?: boolean
}

export function YamlEditor<T extends ResourceType>({
  value,
  readOnly = false,
  showControls = true,
  title,
  onChange,
  onSave,
  onCancel,
  isSaving = false,
  className,
  fillHeight = false,
}: YamlEditorProps<T>) {
  const { t } = useTranslation()
  const [isEditing, setIsEditing] = useState(false)
  const [editorValue, setEditorValue] = useState(value)
  const [isValidYaml, setIsValidYaml] = useState(true)
  const [validationError, setValidationError] = useState<string>('')
  const { actualTheme, colorTheme } = useAppearance()
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null)
  const validationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const themeMode = actualTheme === 'dark' ? 'dark' : 'light'
  const backgroundColor = useMonacoBackgroundColor(
    '--card',
    themeMode,
    colorTheme
  )

  // 编辑中不要被外部 value 覆盖：详情页会定时刷新并把最新对象重新下发，
  // 直接同步会把用户正在编辑（或刚粘贴）的内容冲掉。
  useEffect(() => {
    if (isEditing) return
    setEditorValue(value)
  }, [value, isEditing])

  // 内容变化时防抖校验 YAML，用于展示错误
  useEffect(() => {
    // 为 isValidYaml 状态做即时校验
    try {
      yaml.load(editorValue)
      setIsValidYaml(true)
      setValidationError('') // Clear error immediately when valid
    } catch (error) {
      setIsValidYaml(false) // Set invalid state immediately

      // 清除先前的定时器
      if (validationTimeoutRef.current) {
        clearTimeout(validationTimeoutRef.current)
      }

      // 延迟显示错误信息
      validationTimeoutRef.current = setTimeout(() => {
        setValidationError(
          error instanceof Error
            ? error.message.split('\n')[0]
            : t('common.messages.invalidYaml', 'Invalid YAML')
        )
      }, 1000) // 1 second delay only for error message display
    }

    // 卸载时清理定时器
    return () => {
      if (validationTimeoutRef.current) {
        clearTimeout(validationTimeoutRef.current)
      }
    }
  }, [editorValue, t])

  const handleEditorChange = (value: string | undefined) => {
    const newValue = value || ''
    setEditorValue(newValue)
    onChange?.(newValue)
  }

  const handleEdit = () => {
    setIsEditing(true)
    // 设置编辑模式后聚焦编辑器
    setTimeout(() => {
      if (editorRef.current) {
        editorRef.current.focus()
      }
    }, 100)
  }

  const handleSave = () => {
    if (isValidYaml) {
      onSave?.(yaml.load(editorValue) as ResourceTypeMap[T])
      if (!readOnly) {
        setIsEditing(false)
      }
    }
  }

  const handleCancel = () => {
    setIsEditing(false)
    onCancel?.()
  }

  const handleEditorDidMount = (editor: monacoEditor.IStandaloneCodeEditor) => {
    editorRef.current = editor
  }

  const effectiveReadOnly = readOnly || !isEditing
  const editorTitle = title ?? t('common.fields.yamlConfiguration')

  return (
    <Card className={cn(fillHeight && 'min-h-0 flex-1', className)}>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <CardTitle>{editorTitle}</CardTitle>
        </div>
        <div className="flex items-center gap-4">
          {showControls && (
            <div className="flex gap-2">
              {isEditing ? (
                <>
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={!isValidYaml || isSaving}
                  >
                    {isSaving ? (
                      <IconLoader className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <IconCheck className="w-4 h-4 mr-2" />
                    )}
                    {t('common.actions.save')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleCancel}
                    disabled={isSaving}
                  >
                    <IconX className="w-4 h-4 mr-2" />
                    {t('common.actions.cancel')}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleEdit}
                  disabled={readOnly}
                >
                  <IconEdit className="w-4 h-4 mr-2" />
                  {t('common.actions.edit')}
                </Button>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className={cn(fillHeight && 'min-h-0 flex-1')}>
        <div
          className={cn(
            'space-y-2',
            fillHeight && 'flex h-full min-h-0 flex-col'
          )}
        >
          {!isValidYaml && validationError && (
            <div className="px-3 py-2 bg-destructive/10 border border-destructive/20 rounded-md">
              <p className="text-sm text-destructive">{validationError}</p>
            </div>
          )}
          <div
            className={cn(
              'overflow-hidden h-[calc(100dvh-300px)]',
              fillHeight && 'h-auto min-h-0 flex-1'
            )}
          >
            <ErrorBoundary>
              <MonacoEditor
                height={fillHeight ? '100%' : undefined}
                key={`yaml-editor-${colorTheme}-${actualTheme}-${backgroundColor}`}
                language="yaml"
                theme={
                  actualTheme === 'dark'
                    ? `custom-dark-${colorTheme}`
                    : `custom-vs-${colorTheme}`
                }
                value={editorValue}
                loading={
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    {t('common.messages.loadingEditor', 'Loading editor...')}
                  </div>
                }
                beforeMount={(monaco) => {
                  defineMonacoBackgroundThemes(monaco, {
                    darkThemeName: `custom-dark-${colorTheme}`,
                    lightThemeName: `custom-vs-${colorTheme}`,
                    backgroundColor,
                  })
                }}
                onChange={handleEditorChange}
                onMount={handleEditorDidMount}
                options={{
                  readOnly: effectiveReadOnly,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  wordWrap: 'on',
                  lineNumbers: 'on',
                  folding: true,
                  renderLineHighlight: effectiveReadOnly ? 'none' : 'line',
                  tabSize: 2,
                  insertSpaces: true,
                  fontSize: 14,
                  fontFamily:
                    "'Maple Mono',Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace",
                  acceptSuggestionOnCommitCharacter: false,
                  acceptSuggestionOnEnter: 'off',
                  quickSuggestions: false,
                  suggestOnTriggerCharacters: false,
                  wordBasedSuggestions: 'off',
                  parameterHints: { enabled: false },
                  hover: { enabled: false },
                  contextmenu: false,
                  smoothScrolling: true,
                  cursorSmoothCaretAnimation: 'on',
                  multiCursorModifier: 'alt',
                  accessibilitySupport: 'off',
                  quickSuggestionsDelay: 500,
                  links: false,
                  colorDecorators: false,
                }}
              />
            </ErrorBoundary>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
