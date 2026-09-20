import { useEffect } from 'react'
import { useBranding } from '@/contexts/branding-context'

/**
 * 设置浏览器标签标题：`<页面> - <控制台名称>`；传空标题时只显示控制台名称
 * （登录页 / 初始化页用）。控制台名称来自品牌配置，管理员改名后标签也跟着变。
 */
export function usePageTitle(title: string) {
  const { siteName } = useBranding()

  useEffect(() => {
    const previousTitle = document.title

    document.title = title ? `${title} - ${siteName}` : siteName

    return () => {
      document.title = previousTitle
    }
  }, [title, siteName])
}
