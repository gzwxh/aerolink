import { expect, test } from '@playwright/test'

import { e2eNodeName } from '../env'

const nodeName = e2eNodeName

test.describe('cluster resources', () => {
  test('shows the cluster node on the nodes page', async ({ page }) => {
    await page.goto('/nodes')

    await expect(page.getByRole('link', { name: nodeName })).toBeVisible()
  })

  test('shows stable namespaces on the namespaces page', async ({ page }) => {
    await page.goto('/namespaces')

    await expect(page.getByRole('link', { name: 'kube-system' })).toBeVisible()
  })
})
