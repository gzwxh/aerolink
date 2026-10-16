import { expect, test } from '@playwright/test'

import { clusterPathPattern } from '../support/cluster-url'
test('admin can open global search and jump to the cluster settings tab', async ({
  page,
}) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()

  await page.getByRole('button', { name: /Search resources/i }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  await dialog.getByPlaceholder('Search resources...').fill('settings cluster')

  const clusterResult = dialog.getByText('Cluster', { exact: true })
  await expect(clusterResult).toBeVisible()

  await clusterResult.click()

  await page.waitForURL((url) => clusterPathPattern('/settings/clusters').test(url.pathname))

  await expect(page.getByRole('button', { name: 'Add Cluster' })).toBeVisible()
})
