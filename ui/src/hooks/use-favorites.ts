import { useCallback, useEffect, useState } from 'react'

import { SearchResult } from '@/lib/api'
import {
  addToFavorites as addToFavoritesStorage,
  getFavorites as getFavoritesFromStorage,
  isFavorite as isFavoriteStorage,
  removeFromFavorites as removeFromFavoritesStorage,
  toggleFavorite as toggleFavoriteStorage,
} from '@/lib/favorites'

export function useFavorites() {
  const [favorites, setFavorites] = useState<SearchResult[]>([])
  const [refreshKey, setRefreshKey] = useState(0)

  // 挂载时加载收藏
  useEffect(() => {
    setFavorites(getFavoritesFromStorage())
  }, [refreshKey])

  // 刷新收藏列表
  const refreshFavorites = useCallback(() => {
    setRefreshKey((prev) => prev + 1)
  }, [])

  // 加入收藏
  const addToFavorites = useCallback(
    (resource: SearchResult) => {
      addToFavoritesStorage(resource)
      refreshFavorites()
    },
    [refreshFavorites]
  )

  // 从收藏中移除
  const removeFromFavorites = useCallback(
    (resourceId: string) => {
      removeFromFavoritesStorage(resourceId)
      refreshFavorites()
    },
    [refreshFavorites]
  )

  // 检查资源是否已收藏
  const isFavorite = useCallback((resourceId: string) => {
    return isFavoriteStorage(resourceId)
  }, []) // No dependencies needed as we always check current storage state

  // 切换收藏状态
  const toggleFavorite = useCallback(
    (resource: SearchResult) => {
      const isFavorite = toggleFavoriteStorage(resource)
      refreshFavorites()
      return isFavorite
    },
    [refreshFavorites]
  )

  return {
    favorites,
    addToFavorites,
    removeFromFavorites,
    isFavorite,
    toggleFavorite,
    refreshFavorites,
  }
}
