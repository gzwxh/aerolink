import { useTranslation } from 'react-i18next'

// 页脚展示的公司与部门信息；变更时只需修改这里。
const COMPANY_NAME = '贵州电子商务云运营有限责任公司'
const DEPARTMENT_NAME = '技术工程事业群 - 运维开发部'

export function Footer() {
  const { t } = useTranslation()
  return (
    <footer className="border-t">
      <div className="container mx-auto px-4 py-6">
        <p className="text-center text-sm text-muted-foreground">
          {t('login.footer', {
            year: new Date().getFullYear(),
            company: COMPANY_NAME,
          })}
        </p>
        <p className="text-center text-xs text-muted-foreground mt-1">
          {DEPARTMENT_NAME}
        </p>
      </div>
    </footer>
  )
}
