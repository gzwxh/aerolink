import { SearchResult } from '@/lib/api'
import { getClusterScopedStorageKey } from '@/lib/current-cluster'

const FAVORITES_STORAGE_KEY = 'kite-favorites'

/**
 * 从 localStorage 读取收藏
 */
export const getFavorites = (): SearchResult[] => {
  try {
    const favorites = localStorage.getItem(
      getClusterScopedStorageKey(FAVORITES_STORAGE_KEY)
    )
    return favorites ? JSON.parse(favorites) : []
  } catch {
    return []
  }
}

/**
 * 把收藏保存到 localStorage
 */
export const saveFavorites = (favorites: SearchResult[]) => {
  try {
    localStorage.setItem(
      getClusterScopedStorageKey(FAVORITES_STORAGE_KEY),
      JSON.stringify(favorites)
    )
  } catch (error) {
    console.error('Failed to save favorites:', error)
  }
}

/**
 * 把一个资源加入收藏
 */
export const addToFavorites = (resource: SearchResult) => {
  const favorites = getFavorites()
  const favorite: SearchResult = {
    id: resource.id,
    name: resource.name,
    resourceType: resource.resourceType,
    namespace: resource.namespace,
    createdAt: resource.createdAt,
  }

  // 检查是否已存在
  if (!favorites.some((fav) => fav.id === favorite.id)) {
    favorites.push(favorite)
    saveFavorites(favorites)
  }
}

/**
 * 从一个资源的收藏中移除
 */
export const removeFromFavorites = (resourceId: string) => {
  const favorites = getFavorites()
  const filtered = favorites.filter((fav) => fav.id !== resourceId)
  saveFavorites(filtered)
}

/**
 * 检查某个资源是否在收藏中
 */
export const isFavorite = (resourceId: string): boolean => {
  const favorites = getFavorites()
  return favorites.some((fav) => fav.id === resourceId)
}

/**
 * 切换某个资源的收藏状态
 */
export const toggleFavorite = (resource: SearchResult): boolean => {
  if (isFavorite(resource.id)) {
    removeFromFavorites(resource.id)
    return false
  } else {
    addToFavorites(resource)
    return true
  }
}
