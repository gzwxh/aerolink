import { useVersionInfo } from '@/lib/api'

export function VersionInfo() {
  const { data: versionInfo } = useVersionInfo()

  if (!versionInfo) return null

  const handleCommitClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // 内部仓库地址（提交链到内部 Gitea）；与 README「关于本仓库」里的地址一致。
    const repoUrl =
      'http://10.10.11.151:20216/teg/support-department/operation_rd_dept/aerolink'
    const commitUrl = `${repoUrl}/commit/${versionInfo.commitId}`
    window.open(commitUrl, '_blank')
  }

  return (
    <div className="text-[10px] text-sidebar-foreground/60 font-mono leading-none">
      v{versionInfo.version.replace(/^v/, '')} •{' '}
      <button
        onClick={handleCommitClick}
        className="hover:text-primary/80 hover:underline transition-colors cursor-pointer"
        title={`查看提交 ${versionInfo.commitId}`}
      >
        {versionInfo.commitId.slice(0, 7)}
      </button>
    </div>
  )
}
