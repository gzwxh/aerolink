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

export default i18n
