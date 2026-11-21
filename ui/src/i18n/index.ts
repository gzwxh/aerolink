import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

import en from './locales/en.json'
import zh from './locales/zh.json'

const resources = {
  en: {
    translation: en,
  },
  zh: {
    translation: zh,
  },
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    // 首次访问（本地无语言偏好）时默认显示中文；用户切换语言后会写入
    // localStorage（i18nextLng），之后始终跟随用户的选择。
    fallbackLng: 'zh',
    debug: false,

    interpolation: {
      escapeValue: false,
    },

    detection: {
      order: ['localStorage'],
      caches: ['localStorage'],
    },
  })

// `ui/index.html` 里的 `<html lang="en">` 是写死的，代码之前也从没改过它，
// 于是中文界面下文档语言依旧是 en：读屏软件的发音、字体选择与断行规则都依赖
// 这个属性。跟随实际语言，初始化和切换时都刷一次。
const applyDocumentLanguage = () => {
  document.documentElement.lang = i18n.resolvedLanguage ?? i18n.language ?? 'zh'
}

i18n.on('languageChanged', applyDocumentLanguage)
applyDocumentLanguage()

export default i18n
