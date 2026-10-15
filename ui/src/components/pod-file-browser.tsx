import { useMemo, useState } from 'react'
import {
  IconArrowUp,
  IconDownload,
  IconEye,
  IconFile,
  IconFolder,
  IconHome,
  IconLoader,
  IconRefresh,
  IconUpload,
} from '@tabler/icons-react'
import { Container } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  podDownloadFile,
  podPreviewFile,
  podUploadFile,
  usePodFiles,
} from '@/lib/api'
import { toSimpleContainer } from '@/lib/k8s'
import { translateError } from '@/lib/utils'
import { useCanAnyNamespace } from '@/hooks/use-can'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { ErrorMessage } from './error-message'
import { ContainerSelector } from './selector/container-selector'

interface PodFileBrowserProps {
  namespace: string
  podName: string
  containers?: Container[]
  initContainers?: Container[]
}

export function PodFileBrowser({
  namespace,
  podName,
  containers: _containers = [],
  initContainers = [],
}: PodFileBrowserProps) {
  const containers = useMemo(() => {
    return toSimpleContainer(initContainers, _containers)
  }, [_containers, initContainers])

  const [selectedContainer, setSelectedContainer] = useState<string>(
    containers[0]?.name || ''
  )
  const [currentPath, setCurrentPath] = useState<string>('/')
  const [isUploading, setIsUploading] = useState(false)
  // 容器文件权限：与 exec 分离，可在角色中单独勾选。用 useCanAnyNamespace，
  // 与页面其它权限判定共用一套角色（含权限绑定组下发的角色）。
  const can = useCanAnyNamespace()
  const canViewFiles = can('pods', 'view-file')
  const canDownloadFiles = can('pods', 'download-file')
  const canUploadFiles = can('pods', 'upload-file')
  const { t } = useTranslation()

  const {
    data: files,
    isLoading,
    refetch,
    error,
  } = usePodFiles(namespace, podName, selectedContainer, currentPath)

  const handleNavigate = (path: string) => {
    if (!path.startsWith('/')) {
      path = '/' + path
    }
    setCurrentPath(path)
  }

  const handleEnterDirectory = (dirName: string) => {
    const newPath =
      currentPath === '/' ? `/${dirName}` : `${currentPath}/${dirName}`
    handleNavigate(newPath)
  }

  const handleGoUp = () => {
    if (currentPath === '/') return
    const parts = currentPath.split('/')
    parts.pop()
    const newPath = parts.join('/') || '/'
    handleNavigate(newPath)
  }

  const handleDownload = (fileName: string) => {
    const filePath =
      currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`
    podDownloadFile(namespace, podName, selectedContainer, filePath)
  }

  const handlePreview = (fileName: string) => {
    const filePath =
      currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`
    podPreviewFile(namespace, podName, selectedContainer, filePath)
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canUploadFiles) {
      toast.error(t('podFiles.uploadDenied', '无容器文件上传权限'))
      return
    }
    const file = e.target.files?.[0]
    if (!file) return
    setIsUploading(true)
    try {
      await podUploadFile(
        namespace,
        podName,
        selectedContainer,
        currentPath,
        file
      )
      refetch()
      toast.success(
        t('podFiles.uploadSuccess', {
          name: file.name,
          defaultValue: '已上传 {{name}}',
        })
      )
    } catch (error) {
      toast.error(translateError(error, t))
    } finally {
      setIsUploading(false)
      e.target.value = ''
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <ContainerSelector
          containers={containers}
          selectedContainer={selectedContainer}
          showAllOption={false}
          onContainerChange={(value) => setSelectedContainer(value!)}
        />
        <div className="flex-1 flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label={t('podFiles.goToParent', '返回上级目录')}
            onClick={handleGoUp}
            disabled={currentPath === '/'}
          >
            <IconArrowUp className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label={t('podFiles.goToRoot', '回到根目录')}
            onClick={() => handleNavigate('/')}
            disabled={currentPath === '/'}
          >
            <IconHome className="w-4 h-4" />
          </Button>
          <Input
            value={currentPath}
            aria-label={t('podFiles.currentPath', '当前路径')}
            onChange={(e) => setCurrentPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleNavigate(currentPath)
              }
            }}
            className="font-mono"
          />
          <Button
            aria-label={t('podFiles.refresh', '刷新文件列表')}
            variant="outline"
            size="icon"
            onClick={() => refetch()}
          >
            <IconRefresh className="w-4 h-4" />
          </Button>
        </div>
        <div>
          <Input
            type="file"
            id="file-upload"
            className="hidden"
            onChange={handleUpload}
            disabled={isUploading || !canUploadFiles}
          />
          <Label
            htmlFor="file-upload"
            aria-disabled={!canUploadFiles || isUploading}
            title={
              canUploadFiles
                ? undefined
                : t('podFiles.uploadDenied', '无容器文件上传权限')
            }
            className={`inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 bg-primary text-primary-foreground h-10 px-4 py-2 ${
              canUploadFiles && !isUploading
                ? 'cursor-pointer hover:bg-primary/90'
                : 'pointer-events-none opacity-50'
            }`}
          >
            {isUploading ? (
              <IconLoader className="w-4 h-4 animate-spin mr-2" />
            ) : (
              <IconUpload className="w-4 h-4 mr-2" />
            )}
            {t('podFiles.upload', '上传')}
          </Label>
        </div>
      </div>

      {error ? (
        <ErrorMessage
          resourceName={t('podFiles.title', 'Pod 文件')}
          error={error}
          refetch={refetch}
        />
      ) : (
        <div className="border rounded-md min-w-full max-h-[calc(100dvh-250px)] overflow-y-auto overscroll-y-contain scrollbar-hide">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[50px]"></TableHead>
                <TableHead>{t('podFiles.fields.name', '名称')}</TableHead>
                <TableHead className="w-[100px]">
                  {t('podFiles.fields.uid', 'UID')}
                </TableHead>
                <TableHead className="w-[100px]">
                  {t('podFiles.fields.gid', 'GID')}
                </TableHead>
                <TableHead className="w-[100px]">
                  {t('podFiles.fields.size', '大小')}
                </TableHead>
                <TableHead className="w-[150px]">
                  {t('podFiles.fields.mode', '权限')}
                </TableHead>
                <TableHead className="w-[200px]">
                  {t('podFiles.fields.modified', '修改时间')}
                </TableHead>
                <TableHead className="w-[120px]">
                  {t('common.fields.actions', '操作')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <IconLoader className="animate-spin" />
                      <span>{t('podFiles.loading', '正在加载文件...')}</span>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (files ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center">
                    {t('podFiles.empty', '未找到文件')}
                  </TableCell>
                </TableRow>
              ) : (
                files &&
                files.map((file) => (
                  <TableRow key={file.name}>
                    <TableCell>
                      {file.isDir ? (
                        <IconFolder className="w-4 h-4 text-info" />
                      ) : (
                        <IconFile className="w-4 h-4 text-muted-foreground" />
                      )}
                    </TableCell>
                    <TableCell title={file.name}>
                      {file.isDir ? (
                        <Button
                          variant="link"
                          className="text-foreground font-medium hover:underline text-left p-0 h-auto"
                          onClick={() => handleEnterDirectory(file.name)}
                          aria-label={t('podFiles.enterDirectory', {
                            name: file.name,
                            defaultValue: '进入目录 {{name}}',
                          })}
                        >
                          {file.name}
                        </Button>
                      ) : (
                        <span>{file.name}</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {file.uid}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {file.gid}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {file.size}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {file.mode}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {file.modTime}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {!file.isDir && (
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t('podFiles.preview', '预览文件')}
                            aria-label={t('podFiles.preview', '预览文件')}
                            disabled={!canViewFiles}
                            onClick={() => handlePreview(file.name)}
                          >
                            <IconEye className="w-4 h-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canDownloadFiles}
                          title={
                            file.isDir
                              ? t(
                                  'podFiles.downloadDirectory',
                                  '打包下载目录 (.tar)'
                                )
                              : t('podFiles.download', '下载文件')
                          }
                          aria-label={
                            file.isDir
                              ? t(
                                  'podFiles.downloadDirectory',
                                  '打包下载目录 (.tar)'
                                )
                              : t('podFiles.download', '下载文件')
                          }
                          onClick={() => handleDownload(file.name)}
                        >
                          <IconDownload className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
