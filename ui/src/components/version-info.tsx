import { useVersionInfo } from '@/lib/api'

export function VersionInfo() {
  const { data: versionInfo } = useVersionInfo()

  if (!versionInfo) return null

  const handleCommitClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // GitHub 仓库 URL——可以改成你仓库的地址
    const repoUrl = 'https://github.com/zxh326/kite'
    const commitUrl = `${repoUrl}/commit/${versionInfo.commitId}`
    window.open(commitUrl, '_blank')
  }

  return (
    <div className="text-[10px] text-sidebar-foreground/60 font-mono leading-none">
      v{versionInfo.version.replace(/^v/, '')} •{' '}
      <button
        onClick={handleCommitClick}
        className="hover:text-primary/80 hover:underline transition-colors cursor-pointer"
        title={`View commit ${versionInfo.commitId} on GitHub`}
      >
        {versionInfo.commitId.slice(0, 7)}
      </button>
    </div>
  )
}
